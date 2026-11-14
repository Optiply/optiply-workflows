package com.optiply.jdbcrunner;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;
import javax.sql.DataSource;

/**
 * A connection pool per connection: the same driver, URL, properties and wallet share one, whoever asks. Pools idle for
 * {@code idleMs} close; past {@code maxPools} the one used longest ago closes.
 */
final class Pools implements AutoCloseable {
  static final class Entry {
    final String fingerprint;
    final String poolKey;
    final HikariDataSource pool;
    final TokenDataSource source;
    final Path walletDir;
    /** The SSH tunnel its connections go through, if any (shared with other pools using the same one). */
    final Tunnels.Lease tunnel;
    volatile long lastUsed = System.currentTimeMillis();

    Entry(
        String fingerprint,
        String poolKey,
        HikariDataSource pool,
        TokenDataSource source,
        Path walletDir,
        Tunnels.Lease tunnel) {
      this.fingerprint = fingerprint;
      this.poolKey = poolKey;
      this.pool = pool;
      this.source = source;
      this.walletDir = walletDir;
      this.tunnel = tunnel;
    }
  }

  private static final ObjectMapper CANONICAL =
      new ObjectMapper().configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

  private final Drivers drivers;
  private final Path walletRoot;
  private final long idleMs;
  private final int maxPools;
  private final Map<String, Entry> pools = new ConcurrentHashMap<>();
  private final ScheduledExecutorService sweeper =
      Executors.newSingleThreadScheduledExecutor(
          r -> {
            var t = new Thread(r, "pool-sweeper");
            t.setDaemon(true);
            return t;
          });

  Pools(Drivers drivers, Path walletRoot, long idleMs, int maxPools) {
    this.drivers = drivers;
    this.walletRoot = walletRoot;
    this.idleMs = idleMs;
    this.maxPools = maxPools;
    sweeper.scheduleWithFixedDelay(this::sweep, 30, 30, TimeUnit.SECONDS);
  }

  /** The pool for a connection, made on first use; the token, if any, is the one new connections sign in with. */
  synchronized Entry get(Spec.Connection c) {
    var fp = fingerprint(c);
    var entry = pools.get(fp);
    if (entry == null) {
      if (pools.size() >= maxPools) closeOldest();
      var driver = drivers.forConnection(c);
      entry = open(fp, c, driver);
      pools.put(fp, entry);
    }
    entry.lastUsed = System.currentTimeMillis();
    if (c.tokenProperty() != null) entry.source.token = c.token();
    return entry;
  }

  /** Closes every pool the app made under this name (its settings changed, or its client was dropped). */
  synchronized int closeKey(String poolKey) {
    int closed = 0;
    for (var e : pools.values()) {
      // Its per-person pools too (Snowflake OAuth: `<key>:<token hash>`).
      if (e.poolKey != null && (e.poolKey.equals(poolKey) || e.poolKey.startsWith(poolKey + ":"))) {
        close(e);
        closed++;
      }
    }
    return closed;
  }

  int size() {
    return pools.size();
  }

  /**
   * Which pool a connection uses: everything that changes how it connects (read-only too: ClickHouse's is a setting
   * of its connections), but not the token (it changes while the connections stay good).
   */
  static String fingerprint(Spec.Connection c) {
    var parts = new LinkedHashMap<String, Object>();
    parts.put("poolKey", c.poolKey());
    parts.put("driver", c.driver());
    parts.put("driverSha", c.driverSha());
    parts.put("driverClass", c.driverClass());
    parts.put("url", c.url());
    parts.put("properties", c.properties());
    parts.put("tokenProperty", c.tokenProperty());
    parts.put("wallet", c.wallet());
    parts.put("poolSize", c.poolSize());
    parts.put("readOnly", c.readOnly());
    parts.put("tunnel", c.tunnel());
    try {
      var bytes = CANONICAL.writeValueAsString(parts).getBytes(StandardCharsets.UTF_8);
      return HexFormat.of().formatHex(Drivers.sha256().digest(bytes));
    } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * The runner's own addresses: nothing a resource should reach (the runner's API, other resources' tunnel ends), so a
   * URL naming one is refused, tunnelled or not.
   */
  private static final java.util.regex.Pattern OWN_ADDRESS =
      java.util.regex.Pattern.compile(
          "(?i)(^|[^a-z0-9.-])(localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|0\\.0\\.0\\.0|::1|0:0:0:0:0:0:0:1)([^a-z0-9.-]|$)");

  private Entry open(String fp, Spec.Connection c, Driver driver) {
    if (OWN_ADDRESS.matcher(c.url()).find()) {
      throw new Failure("invalid_config", "The URL names this machine (localhost, 127.x): the runner can't reach a database there");
    }
    var props = new Properties();
    if (c.properties() != null) c.properties().forEach((k, v) -> { if (k != null && v != null) props.setProperty(k, v); });
    // ClickHouse has no transactions to roll back: its server refuses writes and schema changes itself (2 still lets
    // the driver send its own settings).
    if (c.readOnly() && "clickhouse".equals(c.driver())) props.setProperty("clickhouse_setting_readonly", "2");
    Path walletDir = null;
    if (c.wallet() != null && c.wallet().zip() != null && !c.wallet().zip().isBlank()) {
      walletDir = Wallets.unpack(walletRoot, c.wallet().zip());
      var where = walletDir.toAbsolutePath().toString();
      props.setProperty("oracle.net.wallet_location", "(SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=" + where + ")))");
      props.setProperty("oracle.net.tns_admin", where);
      if (c.wallet().password() != null && !c.wallet().password().isEmpty()) {
        props.setProperty("oracle.net.wallet_password", c.wallet().password());
      }
    }
    Tunnels.Lease tunnel;
    try {
      tunnel = c.tunnel() == null ? null : Tunnels.acquire(c.tunnel());
    } catch (RuntimeException e) {
      Wallets.remove(walletDir);
      throw e;
    }
    var url = tunnel == null ? c.url().strip() : tunnel.open().url(c.url().strip());
    var source = new TokenDataSource(driver, url, props, c.tokenProperty(), tunnel);
    source.token = c.token();
    var config = new HikariConfig();
    config.setDataSource(source);
    config.setPoolName("jdbc-" + fp.substring(0, 12));
    config.setMaximumPoolSize(Math.max(1, Math.min(50, c.poolSize() == null ? 5 : c.poolSize())));
    config.setMinimumIdle(0);
    config.setIdleTimeout(60_000);
    config.setMaxLifetime(30 * 60_000);
    // A pool that can't connect fails each query after this, with the driver's own reason.
    config.setConnectionTimeout(15_000);
    config.setValidationTimeout(5_000);
    // Don't connect when the pool is made: the query that asks reports why it can't.
    config.setInitializationFailTimeout(-1);
    config.setRegisterMbeans(false);
    try {
      return new Entry(fp, c.poolKey(), new HikariDataSource(config), source, walletDir, tunnel);
    } catch (RuntimeException e) {
      Wallets.remove(walletDir);
      Tunnels.release(tunnel);
      throw e;
    }
  }

  private void close(Entry e) {
    pools.remove(e.fingerprint, e);
    try {
      e.pool.close();
    } finally {
      Wallets.remove(e.walletDir);
      Tunnels.release(e.tunnel);
    }
  }

  private void closeOldest() {
    pools.values().stream()
        .filter(e -> e.pool.getHikariPoolMXBean() == null || e.pool.getHikariPoolMXBean().getActiveConnections() == 0)
        .min((a, b) -> Long.compare(a.lastUsed, b.lastUsed))
        .ifPresent(this::close);
  }

  /** Synchronized with `get`, which moves `lastUsed` on: a pool just handed out is never swept. */
  private synchronized void sweep() {
    var now = System.currentTimeMillis();
    for (var e : pools.values()) {
      var mx = e.pool.getHikariPoolMXBean();
      boolean busy = mx != null && mx.getActiveConnections() > 0;
      if (!busy && now - e.lastUsed > idleMs) close(e);
    }
  }

  @Override
  public void close() {
    sweeper.shutdownNow();
    for (var e : pools.values()) close(e);
  }

  /** A driver as a data source; each new connection signs in with the token as it is then. */
  static final class TokenDataSource implements DataSource {
    final Driver driver;
    final String url;
    final Properties properties;
    final String tokenProperty;
    /** Its tunnel: connecting resolves the tunnelled names (in whatever thread the pool connects from). */
    final Tunnels.Lease tunnel;
    volatile String token;

    TokenDataSource(Driver driver, String url, Properties properties, String tokenProperty, Tunnels.Lease tunnel) {
      this.driver = driver;
      this.url = url;
      this.properties = properties;
      this.tokenProperty = tokenProperty;
      this.tunnel = tunnel;
    }

    @Override
    public Connection getConnection() throws SQLException {
      var props = new Properties();
      props.putAll(properties);
      if (tokenProperty != null && token != null) props.setProperty(tokenProperty, token);
      var conn = Tunnels.using(tunnel, () -> driver.connect(url, props));
      if (conn == null) throw new SQLException("The driver doesn't accept this URL", "08001");
      return conn;
    }

    @Override
    public Connection getConnection(String user, String password) throws SQLException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public PrintWriter getLogWriter() {
      return null;
    }

    @Override
    public void setLogWriter(PrintWriter out) {}

    @Override
    public void setLoginTimeout(int seconds) {}

    @Override
    public int getLoginTimeout() {
      return 0;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
      throw new SQLException("Not a wrapper");
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) {
      return false;
    }
  }
}
