package com.optiply.jdbcrunner;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * The runner's HTTP API. Every call but {@code GET /health} needs {@code Authorization: Bearer <token>}.
 *
 * <ul>
 *   <li>{@code POST /query}: {@link Spec.Query}; answers JSON lines (see {@link Runner}). 409 when an uploaded driver's
 *       jar isn't here yet: the app uploads it and asks again.
 *   <li>{@code POST /test}: {@link Spec.Test}; {@code {ok, message}} or {@code {ok: false, error}}.
 *   <li>{@code POST /cancel}: {@code {queryId}}.
 *   <li>{@code PUT /drivers/<sha256>}: a driver jar; {@code HEAD} says whether it's here.
 *   <li>{@code DELETE /pools?key=<poolKey>}: closes that resource's pools.
 * </ul>
 */
final class Server implements AutoCloseable {
  static final long MAX_JSON_BYTES = 8L * 1024 * 1024;

  private static final ObjectMapper JSON =
      new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

  private final HttpServer http;
  private final byte[] token;
  private final Drivers drivers;
  private final Pools pools;
  private final Runner runner;

  Server(int port, String token, Drivers drivers, Pools pools, Runner runner) throws IOException {
    this.token = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
    this.drivers = drivers;
    this.pools = pools;
    this.runner = runner;
    this.http = HttpServer.create(new InetSocketAddress(port), 64);
    http.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    http.createContext("/", this::handle);
    http.start();
  }

  int port() {
    return http.getAddress().getPort();
  }

  private void handle(HttpExchange ex) throws IOException {
    try (ex) {
      var method = ex.getRequestMethod();
      var path = ex.getRequestURI().getPath();
      if (method.equals("GET") && path.equals("/health")) {
        send(ex, 200, Map.of("ok", true));
        return;
      }
      var given = ex.getRequestHeaders().getFirst("Authorization");
      if (given == null || !MessageDigest.isEqual(token, given.getBytes(StandardCharsets.UTF_8))) {
        send(ex, 401, Map.of("error", "unauthorized"));
        return;
      }
      try {
        route(ex, method, path);
      } catch (Drivers.UnknownDriver e) {
        send(ex, 409, Map.of("error", "unknown_driver", "sha", e.sha));
      } catch (Failure f) {
        send(ex, 400, Map.of("error", f.getMessage(), "kind", f.kind));
      } catch (com.fasterxml.jackson.core.JacksonException e) {
        send(ex, 400, Map.of("error", "Bad JSON: " + Failure.message(e)));
      } catch (IOException | RuntimeException e) {
        // Said, not dropped: the app shows why (a full or read-only drivers folder, say). Too late once a query's
        // lines have started; then the connection just ends.
        if (ex.getResponseCode() == -1) send(ex, 500, Map.of("error", Failure.message(e)));
      }
    }
  }

  private void route(HttpExchange ex, String method, String path) throws IOException {
    switch (method + " " + path) {
      case "POST /query" -> {
        var q = JSON.readValue(limited(ex.getRequestBody(), MAX_JSON_BYTES), Spec.Query.class);
        // Before the first line: an unknown driver is a 409, not a line.
        if (q.connection() != null && "uploaded".equals(q.connection().driver())
            && !drivers.has(q.connection().driverSha())) {
          throw new Drivers.UnknownDriver(q.connection().driverSha());
        }
        ex.getResponseHeaders().set("Content-Type", "application/x-ndjson");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream out = new BufferedOutputStream(ex.getResponseBody(), 64 * 1024)) {
          runner.query(
              q,
              line -> {
                JSON.writeValue(new NoClose(out), line);
                out.write('\n');
                out.flush();
              });
        }
      }
      case "POST /test" -> {
        var t = JSON.readValue(limited(ex.getRequestBody(), MAX_JSON_BYTES), Spec.Test.class);
        if (t.connection() != null && "uploaded".equals(t.connection().driver())
            && !drivers.has(t.connection().driverSha())) {
          throw new Drivers.UnknownDriver(t.connection().driverSha());
        }
        send(ex, 200, runner.test(t));
      }
      case "POST /cancel" -> {
        var c = JSON.readValue(limited(ex.getRequestBody(), MAX_JSON_BYTES), Spec.Cancel.class);
        send(ex, 200, Map.of("cancelled", runner.cancel(c.queryId())));
      }
      case "DELETE /pools" -> {
        var key = query(ex, "key");
        if (key == null || key.isBlank()) throw new Failure("invalid_config", "Which pools? ?key=");
        send(ex, 200, Map.of("closed", pools.closeKey(key)));
      }
      default -> {
        if (path.startsWith("/drivers/")) {
          var sha = path.substring("/drivers/".length());
          if (method.equals("PUT")) {
            drivers.store(sha, ex.getRequestBody());
            send(ex, 200, Map.of("sha", sha));
            return;
          }
          if (method.equals("HEAD")) {
            ex.sendResponseHeaders(drivers.has(sha) ? 200 : 404, -1);
            return;
          }
        }
        send(ex, 404, Map.of("error", "not found"));
      }
    }
  }

  private static String query(HttpExchange ex, String name) {
    var raw = ex.getRequestURI().getRawQuery();
    if (raw == null) return null;
    for (var part : raw.split("&")) {
      var eq = part.indexOf('=');
      var k = java.net.URLDecoder.decode(eq == -1 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
      if (k.equals(name)) {
        return eq == -1 ? "" : java.net.URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
      }
    }
    return null;
  }

  private static byte[] limited(InputStream in, long max) throws IOException {
    var bytes = in.readNBytes((int) max + 1);
    if (bytes.length > max) throw new Failure("invalid_config", "The request is too large");
    return bytes;
  }

  private static void send(HttpExchange ex, int status, Object body) throws IOException {
    var bytes = JSON.writeValueAsBytes(body);
    ex.getResponseHeaders().set("Content-Type", "application/json");
    ex.sendResponseHeaders(status, bytes.length);
    try (var out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }

  @Override
  public void close() {
    http.stop(0);
  }

  /** Jackson closes the stream it writes to; a query's lines share one. */
  private static final class NoClose extends java.io.FilterOutputStream {
    NoClose(OutputStream out) {
      super(out);
    }

    @Override
    public void write(byte[] b, int off, int len) throws IOException {
      out.write(b, off, len);
    }

    @Override
    public void close() throws IOException {
      flush();
    }
  }
}
