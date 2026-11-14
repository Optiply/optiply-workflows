package com.optiply.jdbcrunner;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Connections through the app's SSH tunnel (M38 step 4): a fake forwarder stands in for the app's (it checks the hello
 * and pipes to H2's TCP server, the "database"), and `db.internal` resolves only through the tunnel.
 */
class TunnelTest {
  static final String SECRET = "s".repeat(64);
  @TempDir static Path tmp;
  static org.h2.tools.Server h2;
  static ServerSocket forwarder;
  static final List<String> hellos = new CopyOnWriteArrayList<>();
  static Pools pools;
  static int dbPort;
  static Runner runner;

  @BeforeAll
  static void start() throws Exception {
    java.security.Security.setProperty("networkaddress.cache.ttl", "0");
    java.security.Security.setProperty("networkaddress.cache.negative.ttl", "0");
    h2 = org.h2.tools.Server.createTcpServer("-tcpPort", "0", "-ifNotExists").start();
    // The port the URL names (the database's, as seen from the SSH server): free here, so the tunnel can listen on
    // it; the fake forwarder pipes to H2's own port whatever was asked.
    try (var free = new ServerSocket(0)) {
      dbPort = free.getLocalPort();
    }
    forwarder = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
    Thread.ofVirtual().start(TunnelTest::forward);
    var builtIn = new java.util.HashMap<>(Drivers.BUILT_IN);
    builtIn.put("h2", List.of("jdbc:h2:tcp:"));
    pools = new Pools(new Drivers(builtIn, tmp.resolve("drivers")), tmp.resolve("wallets"), 600_000, 50);
    runner = new Runner(pools, 8);
  }

  @AfterAll
  static void stop() throws IOException {
    runner.close();
    pools.close();
    forwarder.close();
    h2.stop();
  }

  /** The app's side: `<id> <secret> <host> <port>`, then OK and the bytes to H2, or ERR. */
  static void forward() {
    while (!forwarder.isClosed()) {
      try {
        var s = forwarder.accept();
        Thread.ofVirtual().start(() -> {
          try (s) {
            var line = new StringBuilder();
            for (int b; (b = s.getInputStream().read()) != '\n' && b != -1; ) line.append((char) b);
            hellos.add(line.toString());
            var parts = line.toString().split(" ");
            if (!parts[1].equals(SECRET) || !parts[2].equals("db.internal")) {
              s.getOutputStream().write("ERR SSH server bastion couldn't open db.internal\n".getBytes(StandardCharsets.UTF_8));
              return;
            }
            try (var db = new Socket(InetAddress.getLoopbackAddress(), h2.getPort())) {
              s.getOutputStream().write("OK\n".getBytes(StandardCharsets.UTF_8));
              var up = Thread.ofVirtual().start(() -> {
                try {
                  s.getInputStream().transferTo(db.getOutputStream());
                } catch (IOException ignored) {
                }
              });
              db.getInputStream().transferTo(s.getOutputStream());
              up.join();
            }
          } catch (Exception ignored) {
          }
        });
      } catch (IOException e) {
        return;
      }
    }
  }

  static Spec.Connection through(String poolKey, String tunnelId, String secret, String route) {
    var url = "jdbc:h2:tcp://db.internal:" + dbPort + "/mem:tunnelled;DB_CLOSE_DELAY=-1";
    var tunnel = new Spec.Tunnel(
        "127.0.0.1:" + forwarder.getLocalPort(), tunnelId, secret, List.of("db.internal:" + dbPort), route);
    return new Spec.Connection(poolKey, "h2", null, null, url, Map.of("user", "sa", "password", ""), null, null, null, false, 2, tunnel);
  }

  static Map<String, Object> run(Spec.Connection c, String sql) throws IOException {
    var lines = new java.util.ArrayList<Map<String, Object>>();
    runner.query(new Spec.Query(java.util.UUID.randomUUID().toString(), c, sql, List.of(), 100L, 20_000L), lines::add);
    return lines.getLast();
  }

  @Test
  void reachesTheDatabaseByItsOwnNameThroughTheTunnel() throws Exception {
    var c = through("tunnel-a", "t1", SECRET, "route-1");
    var answer = run(c, "SELECT 1");
    assertEquals("end", answer.get("type"), answer.toString());
    assertTrue(hellos.contains("t1 " + SECRET + " db.internal " + dbPort), hellos.toString());
    var ip = Tunnels.NAMES.get("route-1").get("db.internal");
    assertTrue(ip.isLoopbackAddress() && !ip.getHostAddress().equals("127.0.0.1"), ip.toString());
    // Only for the pool that tunnels it: anyone else asks the system (which doesn't know the name).
    assertThrows(java.net.UnknownHostException.class, () -> InetAddress.getByName("db.internal"));

    // Another app process's registration on the same route shares it.
    var shared = run(through("tunnel-a2", "t1b", SECRET, "route-1"), "SELECT 2");
    assertEquals("end", shared.get("type"), shared.toString());
    // Another route may name its own db.internal: each pool resolves through its own.
    var other = run(through("tunnel-b", "t2", SECRET, "route-2"), "SELECT 3");
    assertEquals("end", other.get("type"), other.toString());
    assertFalse(Tunnels.NAMES.get("route-2").get("db.internal").equals(ip));

    // A resource without SSH naming the same host never goes through someone's tunnel.
    var direct = new Spec.Connection(
        "direct", "h2", null, null, "jdbc:h2:tcp://db.internal:" + dbPort + "/mem:tunnelled", Map.of("user", "sa", "password", ""),
        null, null, null, false, 2, null);
    var refused = run(direct, "SELECT 1");
    assertEquals("connection", refused.get("kind"), refused.toString());
    assertFalse(String.valueOf(refused.get("message")).contains("SSH"), refused.toString());

    // Gone with the last pool using it: the names and the listener.
    pools.closeKey("tunnel-a");
    assertEquals(ip, Tunnels.NAMES.get("route-1").get("db.internal"));
    pools.closeKey("tunnel-a2");
    assertNull(Tunnels.NAMES.get("route-1"));
    // The listener closes asynchronously: on a slow machine (CI, Cloud Build) a connect right after can still land.
    // Refused within 5 s is what matters.
    var deadline = System.nanoTime() + 5_000_000_000L;
    while (true) {
      try (var probe = new Socket()) {
        probe.connect(new InetSocketAddress(ip, dbPort), 500);
      } catch (IOException closed) {
        break;
      }
      if (System.nanoTime() > deadline) fail("the tunnel's listener still accepts connections 5 s after its last pool closed");
      Thread.sleep(50);
    }
    pools.closeKey("tunnel-b");
    pools.closeKey("direct");
  }

  @Test
  void refusesTheRunnersOwnAddresses() throws Exception {
    for (var url : List.of("jdbc:h2:tcp://localhost:9092/mem:x", "jdbc:h2:tcp://127.10.0.1:8123/mem:x")) {
      var c = new Spec.Connection("own", "h2", null, null, url, Map.of("user", "sa"), null, null, null, false, 1, null);
      var refused = run(c, "SELECT 1");
      assertEquals("invalid_config", refused.get("kind"), refused.toString());
    }
  }

  @Test
  void saysWhatTheAppsSideRefused() throws Exception {
    var refused = run(through("tunnel-c", "t3", "wrong".repeat(10), "route-3"), "SELECT 1");
    assertEquals("connection", refused.get("kind"), refused.toString());
    assertEquals("Could not connect through the SSH tunnel: SSH server bastion couldn't open db.internal", refused.get("message"));
    pools.closeKey("tunnel-c");
    assertNull(Tunnels.NAMES.get("route-3"));
  }

  @Test
  void swapsAnIpLiteralForTheTunnelsAddress() {
    var t = new Spec.Tunnel(
        "127.0.0.1:" + forwarder.getLocalPort(), "t4", SECRET, List.of("10.9.8.7:1521", "10.9.8.8:1521"), "route-4");
    var lease = Tunnels.acquire(t);
    try {
      var open = lease.open();
      var url = open.url("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=10.9.8.7)(PORT=1521))(ADDRESS=(HOST=10.9.8.8)(PORT=1521)))");
      // Each host its own address, so two databases on one port stay apart.
      var first = open.ips.get("10.9.8.7").getHostAddress();
      var second = open.ips.get("10.9.8.8").getHostAddress();
      assertFalse(first.equals(second));
      assertEquals(
          "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=" + first + ")(PORT=1521))(ADDRESS=(HOST=" + second + ")(PORT=1521)))",
          url);
      assertNull(Tunnels.NAMES.get("route-4"));
    } finally {
      Tunnels.release(lease);
    }
  }
}
