package com.optiply.jdbcrunner;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * JDBC connections through the app's SSH tunnels (M38 step 4). The SSH side is the app's: its forwarders take a
 * connection that opens with {@code <tunnelId> <secret> <host> <port>} and pipe it through a resource's tunnel.
 *
 * <p>Here, tunnels are grouped by their <b>route</b>: the SSH servers they go through (the app's hash of the jump
 * hosts). Every registration on one route reaches the same network, whichever app process (api, workers) or resource
 * made it, so they share its hosts: each host gets a loopback address of its own ({@code 127.x.y.z}; all of 127/8 is
 * loopback on Linux) listening on its port, and its name resolves to it ({@link TunnelResolverProvider}), so URLs stay
 * as written and TLS still checks the real names; the address a connection arrives on says which host it meant. Each
 * connection goes through one of the route's live registrations that allows its host. An IP literal in a URL is
 * swapped for its loopback address instead.
 *
 * <p>A tunnelled name resolves to its loopback address <b>only for the pool that tunnels it</b>: the pool's work runs
 * with its route set ({@link #using}), and the resolver looks names up in that route alone. Every other lookup is the
 * system's: a resource without SSH that names the same host never goes through someone else's tunnel, and two private
 * networks naming their databases alike don't clash.
 */
final class Tunnels {
  /** Each route's names (lower case) and their loopback addresses. */
  static final Map<String, Map<String, InetAddress>> NAMES = new ConcurrentHashMap<>();

  /** The route of the pool the current thread works for, if it's tunnelled. */
  private static final ThreadLocal<String> ROUTE = new ThreadLocal<>();

  /** A tunnelled name, as the pool working on this thread sees it; null for any other. */
  static InetAddress lookup(String host) {
    var route = ROUTE.get();
    if (route == null) return null;
    var names = NAMES.get(route);
    return names == null ? null : names.get(host.toLowerCase(Locale.ROOT));
  }

  /** Runs work for a pool: its tunnel's names resolve while it does (and nobody else's). */
  static <T, E extends Exception> T using(Lease lease, Work<T, E> work) throws E {
    if (lease == null) return work.run();
    var before = ROUTE.get();
    ROUTE.set(lease.open().route);
    try {
      return work.run();
    } finally {
      if (before == null) ROUTE.remove();
      else ROUTE.set(before);
    }
  }

  @FunctionalInterface
  interface Work<T, E extends Exception> {
    T run() throws E;
  }

  /** One app process's registration of a tunnel: where its forwarder is, and the tunnel's id and secret there. */
  record Registration(InetSocketAddress forwarder, String forwarderText, String tunnelId, String secret) {}

  private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
  private static final AtomicInteger NEXT = new AtomicInteger();
  private static final Map<String, Open> OPEN = new HashMap<>();

  private Tunnels() {}

  /** A route in use: its address, its listeners and names, the registrations pools brought, what was last refused. */
  static final class Open {
    final String route;
    /** Each host's loopback address, and back. */
    final Map<String, InetAddress> ips = new HashMap<>();
    final Map<String, String> hostByIp = new ConcurrentHashMap<>();
    final Map<String, ServerSocket> listeners = new HashMap<>();
    final List<String> names = new ArrayList<>();
    final List<String> literals = new ArrayList<>();
    /** Newest first; a registration appears once per pool using it. */
    final List<Registration> registrations = new CopyOnWriteArrayList<>();
    volatile String lastError;
    volatile long lastErrorAt;

    /** Why the app's side last refused a connection on this route, if it did lately. */
    String recentError() {
      var why = lastError;
      return why != null && System.currentTimeMillis() - lastErrorAt < 60_000 ? why : null;
    }

    Open(String route) {
      this.route = route;
    }

    /** The URL as this route's connections use it: IP literals swapped for their loopback addresses. */
    String url(String url) {
      var out = url;
      for (var literal : literals) out = out.replace(literal, ips.get(literal).getHostAddress());
      return out;
    }

    private void shut() {
      for (var s : listeners.values()) {
        try {
          s.close();
        } catch (IOException ignored) {
          // Closing anyway.
        }
      }
      NAMES.remove(route);
    }
  }

  /** What a pool holds: its route, and its registration (released with the pool). */
  record Lease(Open open, Registration registration) {}

  /** The route for a connection, opened on first use, with this connection's registration and hosts added. */
  static synchronized Lease acquire(Spec.Tunnel t) {
    if (t.forwarder() == null || t.tunnelId() == null || t.secret() == null || t.hosts() == null || t.hosts().isEmpty()) {
      throw new Failure("invalid_config", "The SSH tunnel's settings are incomplete");
    }
    var route = t.route() == null || t.route().isBlank() ? t.forwarder() + "/" + t.tunnelId() : t.route();
    var open = OPEN.get(route);
    boolean created = open == null;
    if (created) open = new Open(route);
    try {
      for (var hostPort : t.hosts()) add(open, hostPort);
    } catch (RuntimeException e) {
      if (created) open.shut();
      throw e;
    }
    if (created) OPEN.put(route, open);
    var registration = new Registration(address(t.forwarder()), t.forwarder(), t.tunnelId(), t.secret());
    open.registrations.addFirst(registration);
    return new Lease(open, registration);
  }

  static synchronized void release(Lease lease) {
    if (lease == null) return;
    var open = lease.open();
    open.registrations.remove(lease.registration());
    if (!open.registrations.isEmpty()) return;
    OPEN.remove(open.route, open);
    open.shut();
  }

  /** A host the route reaches: its name mapped (or its IP literal noted) and a listener on its port. */
  private static void add(Open open, String hostPort) {
    var at = hostPort.lastIndexOf(':');
    if (at < 1) throw new Failure("invalid_config", "A tunnel host isn't host:port: " + hostPort);
    var host = hostPort.substring(0, at).strip().toLowerCase(Locale.ROOT);
    var port = Integer.parseInt(hostPort.substring(at + 1).strip());
    var ip = open.ips.computeIfAbsent(host, h -> nextLoopback());
    open.hostByIp.put(ip.getHostAddress(), host);
    if (IPV4.matcher(host).matches()) {
      if (!open.literals.contains(host)) open.literals.add(host);
    } else if (!open.names.contains(host)) {
      NAMES.computeIfAbsent(open.route, r -> new ConcurrentHashMap<>()).put(host, ip);
      open.names.add(host);
    }
    var key = ip.getHostAddress() + ":" + port;
    if (open.listeners.containsKey(key)) return;
    try {
      var listener = new ServerSocket();
      listener.setReuseAddress(true);
      listener.bind(new InetSocketAddress(ip, port), 50);
      open.listeners.put(key, listener);
      Thread.ofVirtual().name("tunnel-" + host + ":" + port).start(() -> accept(listener, open));
    } catch (IOException e) {
      throw new Failure("connection", "Could not open the SSH tunnel's local end on port " + port + ": " + Failure.message(e));
    }
  }

  private static void accept(ServerSocket listener, Open open) {
    while (!listener.isClosed()) {
      Socket client;
      try {
        client = listener.accept();
      } catch (IOException e) {
        return;
      }
      Thread.ofVirtual().start(() -> relay(client, open));
    }
  }

  /**
   * One driver connection: the host it meant (by the address and port it reached), through the route's newest
   * registration whose forwarder agrees, then bytes both ways.
   */
  private static void relay(Socket client, Open open) {
    try (client) {
      int port = client.getLocalPort();
      var host = open.hostByIp.get(client.getLocalAddress().getHostAddress());
      if (host == null) return;
      Socket upstream = null;
      String refused = null;
      for (var r : open.registrations) {
        var s = new Socket();
        try {
          s.connect(r.forwarder(), 10_000);
          s.setTcpNoDelay(true);
          s.getOutputStream().write((r.tunnelId() + " " + r.secret() + " " + host + " " + port + "\n").getBytes(StandardCharsets.UTF_8));
          s.getOutputStream().flush();
          var answer = readLine(s.getInputStream());
          if ("OK".equals(answer)) {
            upstream = s;
            break;
          }
          refused = answer == null ? "the app's forwarder closed the connection" : answer.replaceFirst("^ERR ", "");
        } catch (IOException e) {
          refused = "the app's forwarder isn't reachable at " + r.forwarderText() + ": " + Failure.message(e);
        }
        s.close();
      }
      if (upstream == null) {
        open.lastErrorAt = System.currentTimeMillis();
        open.lastError = refused == null ? "no app process holds this tunnel now" : refused;
        return;
      }
      open.lastError = null;
      try (var up = upstream) {
        client.setTcpNoDelay(true);
        var copy = Thread.ofVirtual().start(() -> {
          try {
            client.getInputStream().transferTo(up.getOutputStream());
            up.shutdownOutput();
          } catch (IOException ignored) {
            // Either side closed.
          }
        });
        try {
          up.getInputStream().transferTo(client.getOutputStream());
          client.shutdownOutput();
        } catch (IOException ignored) {
          // Either side closed.
        }
        copy.join();
      }
    } catch (IOException ignored) {
      // The driver's side went away.
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  /** The forwarder's answer line, read byte by byte so nothing after it is taken from the stream. */
  private static String readLine(InputStream in) throws IOException {
    var line = new StringBuilder();
    for (int b; (b = in.read()) != -1; ) {
      if (b == '\n') return line.toString();
      if (line.length() > 1024) return null;
      line.append((char) b);
    }
    return line.isEmpty() ? null : line.toString();
  }

  private static InetSocketAddress address(String hostPort) {
    var at = hostPort.lastIndexOf(':');
    if (at < 1) throw new Failure("invalid_config", "The SSH tunnel's forwarder isn't host:port");
    return new InetSocketAddress(hostPort.substring(0, at), Integer.parseInt(hostPort.substring(at + 1)));
  }

  private static InetAddress nextLoopback() {
    for (; ; ) {
      int n = NEXT.incrementAndGet();
      int a = 10 + (n >>> 16) % 240;
      int b = (n >>> 8) & 0xff;
      int c = n & 0xff;
      if (c == 0 || c == 255) continue;
      try {
        return InetAddress.getByAddress(new byte[] {127, (byte) a, (byte) b, (byte) c});
      } catch (IOException e) {
        throw new IllegalStateException(e);
      }
    }
  }
}
