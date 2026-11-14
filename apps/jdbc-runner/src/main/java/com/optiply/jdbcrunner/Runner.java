package com.optiply.jdbcrunner;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Runs queries and connection tests. A query's answer is a stream of JSON lines: {@code fields}, {@code rows} in
 * batches, then {@code end} (row and change counts) or {@code error}. The timeout and {@code POST /cancel} cancel the
 * statement on the database ({@link Statement#cancel}).
 */
final class Runner {
  /** Where a query's lines go; an {@link IOException} means the app stopped listening (the query is then cancelled). */
  interface Lines {
    void write(Map<String, Object> line) throws IOException;
  }

  static final int BATCH = 500;

  private final Pools pools;
  private final Semaphore slots;
  private final Map<String, Running> running = new ConcurrentHashMap<>();
  private final ScheduledExecutorService timers =
      Executors.newSingleThreadScheduledExecutor(
          r -> {
            var t = new Thread(r, "query-timers");
            t.setDaemon(true);
            return t;
          });

  Runner(Pools pools, int maxConcurrent) {
    this.pools = pools;
    this.slots = new Semaphore(maxConcurrent, true);
  }

  /** One query in flight: its statement once there is one, and why the runner stopped it, if it did. */
  private static final class Running {
    volatile Statement statement;
    volatile String stopped;

    synchronized void stop(String reason) {
      if (stopped != null) return;
      stopped = reason;
      cancel(statement);
    }

    synchronized void attach(Statement st) {
      statement = st;
      if (stopped != null) cancel(st);
    }

    private static void cancel(Statement st) {
      if (st == null) return;
      try {
        st.cancel();
      } catch (SQLException | RuntimeException ignored) {
        // Done already, or the driver can't: the timeout still ends the wait.
      }
    }
  }

  /** Stops a query the app gave up on; false if there's none by that id (finished, or never started). */
  boolean cancel(String queryId) {
    var r = queryId == null ? null : running.get(queryId);
    if (r == null) return false;
    r.stop("aborted");
    return true;
  }

  void query(Spec.Query q, Lines out) throws IOException {
    var r = new Running();
    var id = q.queryId() == null ? java.util.UUID.randomUUID().toString() : q.queryId();
    if (running.putIfAbsent(id, r) != null) {
      out.write(error(new Failure("invalid_config", "A query with this id is already running")));
      return;
    }
    long timeoutMs = q.timeoutMs() == null ? 120_000 : Math.max(1, q.timeoutMs());
    var timer = timers.schedule(() -> r.stop("timeout"), timeoutMs, TimeUnit.MILLISECONDS);
    boolean slot = false;
    try {
      if (q.sql() == null || q.sql().isBlank()) throw new Failure("invalid_config", "The query has no SQL");
      if (q.connection() == null) throw new Failure("invalid_config", "The query has no connection");
      slot = slots.tryAcquire(30, TimeUnit.SECONDS);
      if (!slot) throw new Failure("busy", "The JDBC runner is busy: too many queries at once");
      if (r.stopped != null) throw Failure.of(new SQLException(), r.stopped);
      run(q, r, out);
    } catch (Drivers.UnknownDriver e) {
      throw e;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      out.write(error(new Failure("aborted", "The query was cancelled")));
    } catch (IOException e) {
      r.stop("aborted");
      throw e;
    } catch (Throwable t) {
      out.write(error(Failure.of(t, r.stopped)));
    } finally {
      timer.cancel(false);
      running.remove(id, r);
      if (slot) slots.release();
    }
  }

  private void run(Spec.Query q, Running r, Lines out) throws SQLException, IOException {
    var c = q.connection();
    if (c.readOnly()) ReadOnly.check(q.sql());
    var entry = pools.get(c);
    long maxRows = q.maxRows() == null ? 1_000_000 : Math.max(1, q.maxRows());
    long timeoutMs = q.timeoutMs() == null ? 120_000 : Math.max(1, q.timeoutMs());
    try (Connection conn = connect(entry, entry.pool)) {
      // Lazy drivers (ClickHouse) connect while running the statement: the tunnel's names resolve meanwhile.
      try {
        Tunnels.using(entry.tunnel, () -> {
          runOn(conn, q, c, r, out, maxRows, timeoutMs);
          return null;
        });
      } catch (SQLException | IOException | RuntimeException e) {
        throw e;
      } catch (Exception e) {
        throw new IllegalStateException(e);
      }
    } catch (SQLException | RuntimeException e) {
      var f = viaTunnel(entry, e);
      if (f != null) throw f;
      throw e;
    }
  }

  private void runOn(
      Connection conn, Spec.Query q, Spec.Connection c, Running r, Lines out, long maxRows, long timeoutMs)
      throws SQLException, IOException {
    {
      boolean transaction = false;
      // Only drivers with transactions are asked: ClickHouse's throws, and the pool then drops the connection
      // (ClickHouse's read-only is its server's own `readonly` setting instead, see Pools).
      if (c.readOnly() && supportsTransactions(conn)) {
        try {
          conn.setReadOnly(true);
        } catch (SQLException | RuntimeException ignored) {
          // A hint some drivers don't take; the transaction below is the guard.
        }
        try {
          conn.setAutoCommit(false);
          transaction = true;
        } catch (SQLException | RuntimeException ignored) {
          // Not after all: read-only then rests on the database user.
        }
      }
      long affected = 0;
      try (var ps = conn.prepareStatement(q.sql())) {
        r.attach(ps);
        Values.bind(ps, q.params());
        // The database's own timer too (a second over ours), for drivers whose cancel can't get through.
        try {
          ps.setQueryTimeout((int) Math.min(Integer.MAX_VALUE, timeoutMs / 1000 + 1));
        } catch (SQLException | RuntimeException ignored) {
          // Not supported: our timer still cancels.
        }
        try {
          if (maxRows < Integer.MAX_VALUE) ps.setMaxRows((int) maxRows + 1);
        } catch (SQLException | RuntimeException ignored) {
          // Counted below anyway.
        }
        boolean isResult = ps.execute();
        boolean first = true;
        for (; ; ) {
          if (isResult) {
            try (var rs = ps.getResultSet()) {
              // Several results: the first one is the result.
              if (first && rs != null) stream(rs, maxRows, r, ps, out);
            }
            first = false;
          } else {
            long n = updateCount(ps);
            if (n == -1) break;
            affected += n;
          }
          isResult = ps.getMoreResults();
        }
        if (r.stopped != null) throw Failure.of(new SQLException(), r.stopped);
        if (c.readOnly() && affected > 0) {
          throw new Failure(
              "query",
              transaction
                  ? "This resource is read-only: the query changed " + affected + " row" + (affected == 1 ? "" : "s")
                      + ", and the change was rolled back"
                  : "This resource is read-only, but this database has no transactions to roll back: the query changed "
                      + affected + " row" + (affected == 1 ? "" : "s") + ". Connect as a user that can only read.");
        }
        var end = new LinkedHashMap<String, Object>();
        end.put("type", "end");
        end.put("affectedRows", affected);
        out.write(end);
      } finally {
        if (transaction) {
          try {
            conn.rollback();
            conn.setAutoCommit(true);
          } catch (SQLException ignored) {
            // A connection that can't roll back is broken: Hikari drops it.
          }
        }
      }
    }
  }

  /** A connection; through a tunnel, a failure says what the app's side said (which SSH server, and why). */
  private static Connection connect(Pools.Entry entry, javax.sql.DataSource source) throws SQLException {
    try {
      return source.getConnection();
    } catch (SQLException e) {
      var f = viaTunnel(entry, e);
      if (f != null) throw f;
      throw e;
    }
  }

  /**
   * A connection problem on a tunnelled pool, told as the app's side told it (which SSH server couldn't open what), when
   * it refused lately: drivers that connect lazily (ClickHouse) fail on their first statement, not on connecting.
   */
  static Failure viaTunnel(Pools.Entry entry, Throwable t) {
    if (entry == null || entry.tunnel == null || t instanceof Failure) return null;
    var why = entry.tunnel.open().recentError();
    if (why == null) return null;
    boolean connecting = Failure.of(t, null).kind.equals("connection");
    for (var c = t; !connecting && c != null; c = c.getCause()) connecting = c instanceof java.io.IOException;
    return connecting ? new Failure("connection", "Could not connect through the SSH tunnel: " + why) : null;
  }

  private static boolean supportsTransactions(Connection conn) {
    try {
      return conn.getMetaData().supportsTransactions();
    } catch (SQLException | RuntimeException e) {
      return false;
    }
  }

  private static long updateCount(Statement ps) throws SQLException {
    try {
      return ps.getLargeUpdateCount();
    } catch (UnsupportedOperationException | java.sql.SQLFeatureNotSupportedException e) {
      return ps.getUpdateCount();
    }
  }

  private static void stream(java.sql.ResultSet rs, long maxRows, Running r, Statement ps, Lines out)
      throws SQLException, IOException {
    var meta = rs.getMetaData();
    int columns = meta.getColumnCount();
    var names = new String[columns];
    var types = new int[columns];
    for (int i = 0; i < columns; i++) {
      names[i] = Values.name(meta, i + 1);
      types[i] = meta.getColumnType(i + 1);
    }
    var fields = new LinkedHashMap<String, Object>();
    fields.put("type", "fields");
    fields.put("fields", Values.fields(meta));
    out.write(fields);
    long count = 0;
    List<Map<String, Object>> batch = new ArrayList<>();
    while (rs.next()) {
      if (++count > maxRows) {
        r.stop("too_large");
        throw new Failure(
            "too_large",
            "The query returned more than " + maxRows + " rows. Limit it in the query, or raise the resource's maxRows.");
      }
      // A repeated column name keeps the last value, as in the app's other SQL resources.
      var row = new LinkedHashMap<String, Object>();
      for (int i = 0; i < columns; i++) row.put(names[i], Values.cell(rs, i + 1, types[i]));
      batch.add(row);
      if (batch.size() >= BATCH) {
        out.write(Map.of("type", "rows", "rows", batch));
        batch = new ArrayList<>();
      }
    }
    if (!batch.isEmpty()) out.write(Map.of("type", "rows", "rows", batch));
  }

  /** Connects once, outside the pool (so a wrong password fails now, not after the pool's wait), and asks who it is. */
  Map<String, Object> test(Spec.Test t) {
    var result = new LinkedHashMap<String, Object>();
    try {
      if (t.connection() == null) throw new Failure("invalid_config", "The test has no connection");
      var entry = pools.get(t.connection());
      long timeoutMs = t.timeoutMs() == null ? 30_000 : Math.max(1, t.timeoutMs());
      var exec = Executors.newVirtualThreadPerTaskExecutor();
      try {
        var future =
            exec.submit(
                () -> {
                  try (var conn = connect(entry, entry.source)) {
                    return Tunnels.using(entry.tunnel, () -> describe(conn));
                  }
                });
        result.put("ok", true);
        result.put("message", future.get(timeoutMs, TimeUnit.MILLISECONDS).strip());
      } catch (java.util.concurrent.TimeoutException e) {
        throw new Failure("timeout", "Connecting took longer than " + timeoutMs + " ms");
      } catch (java.util.concurrent.ExecutionException e) {
        var tunnelled = viaTunnel(entry, e.getCause());
        if (tunnelled != null) throw tunnelled;
        // Whatever fails while connecting is a connection problem (Oracle's unknown host is SQL state 22000).
        var f = Failure.of(e.getCause(), null);
        if (!f.kind.equals("query")) throw f;
        throw new Failure("connection", "Could not connect to the database: " + f.getMessage(), f.sqlState, f.vendorCode);
      } finally {
        exec.shutdownNow();
      }
    } catch (Drivers.UnknownDriver e) {
      throw e;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      result.clear();
      result.put("ok", false);
      result.put("error", new Failure("aborted", "The test was cancelled").toJson());
    } catch (Throwable e) {
      result.clear();
      result.put("ok", false);
      result.put("error", Failure.of(e, null).toJson());
    }
    return result;
  }

  /** Who's there: the database's name and version, after checking the connection works. */
  private static String describe(Connection conn) throws SQLException {
    var meta = conn.getMetaData();
    if (!conn.isValid(5)) {
      // Some drivers connect lazily (ClickHouse): a statement says why.
      try (var st = conn.createStatement()) {
        st.execute("SELECT 1");
      }
      throw new Failure("connection", "The connection isn't valid");
    }
    return meta.getDatabaseProductName() + " " + meta.getDatabaseProductVersion();
  }

  static Map<String, Object> error(Failure f) {
    var line = new LinkedHashMap<String, Object>();
    line.put("type", "error");
    line.putAll(f.toJson());
    return line;
  }

  void close() {
    timers.shutdownNow();
  }
}
