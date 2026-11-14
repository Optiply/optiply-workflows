package com.optiply.jdbcrunner;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The runner over HTTP, with H2 (in memory) standing in for a database: as a built-in driver, and uploaded. */
class RunnerTest {
  static final String TOKEN = "test-token-0123456789abcdef";
  static final ObjectMapper JSON = new ObjectMapper();
  static final HttpClient HTTP = HttpClient.newHttpClient();

  @TempDir static Path tmp;
  static Server server;
  static Pools pools;
  static Runner runner;
  static String base;

  @BeforeAll
  static void start() throws Exception {
    var builtIn = new java.util.HashMap<>(Drivers.BUILT_IN);
    builtIn.put("h2", List.of("jdbc:h2:mem:"));
    var drivers = new Drivers(builtIn, tmp.resolve("drivers"));
    pools = new Pools(drivers, tmp.resolve("wallets"), 600_000, 50);
    runner = new Runner(pools, 8);
    server = new Server(0, TOKEN, drivers, pools, runner);
    base = "http://127.0.0.1:" + server.port();
    query(h2("shop"), """
        CREATE TABLE customers (id INT PRIMARY KEY, email VARCHAR(100), profile JSON);
        INSERT INTO customers SELECT x, CONCAT('user', x, '@example.com'), NULL FROM SYSTEM_RANGE(1, 30);
        CREATE TABLE things (id BIGINT, price DECIMAL(10, 2), ratio DOUBLE, flag BOOLEAN, on_day DATE,
          at TIMESTAMP(3), zoned TIMESTAMP WITH TIME ZONE, t TIME, raw VARBINARY(4), tags INT ARRAY);
        INSERT INTO things VALUES (9007199254740993, 12.34, 0.5, TRUE, DATE '2026-10-14',
          TIMESTAMP '2026-10-14 09:30:00.125', TIMESTAMP WITH TIME ZONE '2026-10-14 09:30:00+02:00',
          TIME '09:30:00', X'0102', ARRAY[1, 2]);
        """, List.of(), 1000, 10_000);
  }

  @AfterAll
  static void stop() {
    server.close();
    runner.close();
    pools.close();
  }

  static ObjectNode h2(String db) {
    var c = JSON.createObjectNode();
    c.put("poolKey", "test:" + db);
    c.put("driver", "h2");
    c.put("url", "jdbc:h2:mem:" + db + ";DB_CLOSE_DELAY=-1");
    c.putObject("properties").put("user", "sa").put("password", "");
    return c;
  }

  static HttpResponse<String> post(String path, Object body, String token) throws Exception {
    var req =
        HttpRequest.newBuilder(URI.create(base + path))
            .header("Authorization", "Bearer " + token)
            .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)))
            .build();
    return HTTP.send(req, HttpResponse.BodyHandlers.ofString());
  }

  /** A query's lines, by type: {@code fields}, {@code rows} (all batches), {@code end} or {@code error}. */
  record Answer(int status, JsonNode fields, List<JsonNode> rows, JsonNode end, JsonNode error, String body) {}

  static Answer query(ObjectNode conn, String sql, List<?> params, long maxRows, long timeoutMs) throws Exception {
    return query(conn, sql, params, maxRows, timeoutMs, UUID.randomUUID().toString());
  }

  static Answer query(ObjectNode conn, String sql, List<?> params, long maxRows, long timeoutMs, String id)
      throws Exception {
    var body =
        Map.of(
            "queryId", id, "connection", conn, "sql", sql, "params", params, "maxRows", maxRows, "timeoutMs",
            timeoutMs);
    var res = post("/query", body, TOKEN);
    JsonNode fields = null, end = null, error = null;
    var rows = new ArrayList<JsonNode>();
    if (res.statusCode() == 200) {
      for (var line : res.body().split("\n")) {
        if (line.isBlank()) continue;
        var node = JSON.readTree(line);
        switch (node.get("type").asText()) {
          case "fields" -> fields = node.get("fields");
          case "rows" -> node.get("rows").forEach(rows::add);
          case "end" -> end = node;
          case "error" -> error = node;
          default -> throw new AssertionError(line);
        }
      }
    }
    return new Answer(res.statusCode(), fields, rows, end, error, res.body());
  }

  @Test
  void healthNeedsNoTokenButEverythingElseDoes() throws Exception {
    var health = HTTP.send(HttpRequest.newBuilder(URI.create(base + "/health")).build(), HttpResponse.BodyHandlers.ofString());
    assertEquals(200, health.statusCode());
    assertEquals(401, post("/query", Map.of(), "wrong").statusCode());
    assertEquals(401, post("/test", Map.of(), "").statusCode());
  }

  @Test
  void bindsValuesAndStreamsRows() throws Exception {
    var a = query(h2("shop"), "SELECT id, email FROM customers WHERE id IN (?, ?) OR email = ? ORDER BY id",
        List.of(3, 4, "user9@example.com"), 1000, 10_000);
    assertEquals(null, a.error(), a.body());
    assertEquals("[{\"ID\":3,\"EMAIL\":\"user3@example.com\"},{\"ID\":4,\"EMAIL\":\"user4@example.com\"},{\"ID\":9,\"EMAIL\":\"user9@example.com\"}]",
        JSON.writeValueAsString(a.rows()));
    assertEquals("ID", a.fields().get(0).get("name").asText());
    assertEquals(0, a.end().get("affectedRows").asLong());
    // More rows than a batch, in order.
    var all = query(h2("shop"), "SELECT x FROM SYSTEM_RANGE(1, 1200)", List.of(), 2000, 10_000);
    assertEquals(1200, all.rows().size());
    assertEquals(1200, all.rows().get(1199).get("X").asLong());
  }

  @Test
  void returnsTypesAsJsonFriendlyValues() throws Exception {
    var a = query(h2("shop"), "SELECT id, price, ratio, flag, on_day, at, zoned, t, raw, tags, CAST(42 AS BIGINT) AS small, NULL AS nothing FROM things",
        List.of(), 10, 10_000);
    assertEquals(null, a.error(), a.body());
    var row = a.rows().get(0);
    assertEquals("9007199254740993", row.get("ID").asText());
    assertTrue(row.get("ID").isTextual());
    assertEquals(12.34, row.get("PRICE").asDouble());
    assertTrue(row.get("PRICE").isNumber());
    assertEquals(0.5, row.get("RATIO").asDouble());
    assertTrue(row.get("FLAG").asBoolean());
    assertEquals("2026-10-14", row.get("ON_DAY").asText());
    assertEquals("2026-10-14 09:30:00.125", row.get("AT").asText());
    assertEquals("2026-10-14T07:30:00Z", row.get("ZONED").asText());
    assertEquals("09:30:00", row.get("T").asText());
    assertEquals(Base64.getEncoder().encodeToString(new byte[] {1, 2}), row.get("RAW").asText());
    assertEquals("[1,2]", row.get("TAGS").toString());
    assertEquals(42, row.get("SMALL").asLong());
    assertTrue(row.get("NOTHING").isNull());
  }

  @Test
  void bindsNullsBooleansJsonAndBigNumbers() throws Exception {
    var params = new ArrayList<Object>();
    params.add(null);
    params.add(true);
    params.add(Map.of("a", 1));
    params.add(new java.math.BigInteger("123456789012345678901234"));
    params.add(2.5);
    params.add(Map.of("$timestamp", "2026-10-14T09:30:00.125Z"));
    params.add(Map.of("$bytes", "AQI="));
    var a = query(h2("shop"), "SELECT CAST(? AS VARCHAR) AS n, CAST(? AS BOOLEAN) AS b, CAST(? AS VARCHAR) AS j, CAST(? AS DECIMAL(30,0)) AS big, CAST(? AS DOUBLE) AS d, CAST(? AS TIMESTAMP) AS ts, CAST(? AS VARBINARY) AS raw",
        params, 10, 10_000);
    assertEquals(null, a.error(), a.body());
    var row = a.rows().get(0);
    assertTrue(row.get("N").isNull());
    assertTrue(row.get("B").asBoolean());
    assertEquals("{\"a\":1}", row.get("J").asText());
    assertEquals("123456789012345678901234", row.get("BIG").asText());
    assertEquals(2.5, row.get("D").asDouble());
    assertEquals("2026-10-14 09:30:00.125", row.get("TS").asText());
    assertEquals("AQI=", row.get("RAW").asText());
  }

  @Test
  void reportsWritesAndSqlErrors() throws Exception {
    query(h2("writes"), "CREATE TABLE t (id INT)", List.of(), 10, 10_000);
    var insert = query(h2("writes"), "INSERT INTO t VALUES (1), (2), (3)", List.of(), 10, 10_000);
    assertEquals(3, insert.end().get("affectedRows").asLong(), insert.body());
    assertEquals(null, insert.fields());
    var bad = query(h2("writes"), "SELECT * FROM nope", List.of(), 10, 10_000);
    assertEquals("query", bad.error().get("kind").asText());
    assertEquals("42S02", bad.error().get("sqlState").asText());
    assertTrue(bad.error().get("vendorCode").asInt() > 0);
  }

  @Test
  void readOnlyRollsBackAndFailsQueriesThatChangedRows() throws Exception {
    query(h2("ro"), "CREATE TABLE t (id INT); INSERT INTO t VALUES (1)", List.of(), 10, 10_000);
    var ro = h2("ro");
    ro.put("readOnly", true);
    assertEquals(1, query(ro, "SELECT COUNT(*) AS n FROM t", List.of(), 10, 10_000).rows().get(0).get("N").asInt());
    var write = query(ro, "INSERT INTO t VALUES (2)", List.of(), 10, 10_000);
    assertEquals("query", write.error().get("kind").asText(), write.body());
    assertTrue(write.error().get("message").asText().contains("read-only"), write.body());
    assertEquals(1, query(h2("ro"), "SELECT COUNT(*) AS n FROM t", List.of(), 10, 10_000).rows().get(0).get("N").asInt());
    // Statements that don't read are refused before running: DDL commits on its own in Oracle and Snowflake.
    for (var sql : List.of("DROP TABLE t", "/* x */ create table u (id int)", "SELECT 1; DELETE FROM t", "TRUNCATE TABLE t")) {
      var refused = query(ro, sql, List.of(), 10, 10_000);
      assertTrue(refused.error().get("message").asText().contains("read-only"), sql + " " + refused.body());
    }
    assertEquals(1, query(h2("ro"), "SELECT COUNT(*) AS n FROM t", List.of(), 10, 10_000).rows().get(0).get("N").asInt());
    var reads = query(ro, "-- DELETE\nWITH x AS (SELECT 'a;DROP' AS s) SELECT s FROM x", List.of(), 10, 10_000);
    assertEquals(null, reads.error(), reads.body());
  }

  @Test
  void readOnlyKnowsWhatReads() {
    assertEquals(null, ReadOnly.firstWriting("select 1; (SELECT 2); show tables; explain select 1"));
    assertEquals(null, ReadOnly.firstWriting("SELECT 'it''s; DROP', \"x;y\", `a;b`, $$; DELETE$$ /* ; DROP */ // ; drop"));
    assertEquals("INSERT", ReadOnly.firstWriting("SELECT 1; insert into t values (1)"));
    assertEquals("BEGIN", ReadOnly.firstWriting("BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;"));
    assertEquals("MERGE", ReadOnly.firstWriting("MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN DELETE"));
  }

  @Test
  void failsResultsPastMaxRows() throws Exception {
    var a = query(h2("shop"), "SELECT id FROM customers", List.of(), 10, 10_000);
    assertEquals("too_large", a.error().get("kind").asText(), a.body());
    assertEquals(10, query(h2("shop"), "SELECT id FROM customers LIMIT 10", List.of(), 10, 10_000).rows().size());
  }

  @Test
  void timesOutAndCancelsOnTheDatabase() throws Exception {
    var slow = "SELECT SUM(x * 2) FROM SYSTEM_RANGE(1, 50000000000)";
    long started = System.currentTimeMillis();
    var a = query(h2("slow"), slow, List.of(), 10, 300);
    assertEquals("timeout", a.error().get("kind").asText(), a.body());
    assertTrue(System.currentTimeMillis() - started < 5_000);

    var id = UUID.randomUUID().toString();
    var cancelled = new java.util.concurrent.CompletableFuture<Answer>();
    Thread.ofVirtual().start(() -> {
      try {
        cancelled.complete(query(h2("slow"), slow, List.of(), 10, 60_000, id));
      } catch (Exception e) {
        cancelled.completeExceptionally(e);
      }
    });
    Thread.sleep(500);
    assertEquals("{\"cancelled\":true}", post("/cancel", Map.of("queryId", id), TOKEN).body());
    var answer = cancelled.get(10, java.util.concurrent.TimeUnit.SECONDS);
    assertEquals("aborted", answer.error().get("kind").asText(), answer.body());
    // The pool still works.
    assertEquals(1, query(h2("slow"), "SELECT 1 AS one", List.of(), 10, 10_000).rows().size());
  }

  @Test
  void builtInDriversOnlyTakeTheirOwnUrls() throws Exception {
    var c = h2("shop");
    c.put("driver", "oracle");
    var a = query(c, "SELECT 1", List.of(), 10, 10_000);
    assertEquals("invalid_config", a.error().get("kind").asText());
    assertTrue(a.error().get("message").asText().contains("jdbc:oracle:thin:"), a.body());
    c.put("driver", "nope");
    assertEquals("invalid_config", query(c, "SELECT 1", List.of(), 10, 10_000).error().get("kind").asText());
  }

  @Test
  void testsAConnectionOutsideThePool() throws Exception {
    var ok = JSON.readTree(post("/test", Map.of("connection", h2("shop")), TOKEN).body());
    assertTrue(ok.get("ok").asBoolean(), ok.toString());
    assertTrue(ok.get("message").asText().startsWith("H2 "), ok.toString());

    // A database with a password, and the wrong one.
    var secured = h2("secured");
    secured.withObject("properties").put("password", "right-pw");
    query(secured, "SELECT 1", List.of(), 10, 10_000);
    var wrong = h2("secured");
    wrong.withObject("properties").put("password", "wrong-pw");
    var failed = JSON.readTree(post("/test", Map.of("connection", wrong), TOKEN).body());
    assertFalse(failed.get("ok").asBoolean());
    assertEquals("connection", failed.get("error").get("kind").asText(), failed.toString());
    assertFalse(failed.toString().contains("wrong-pw"));
  }

  @Test
  void uploadedDriversAreCheckedAndLoadedOnTheirOwn() throws Exception {
    var jar = Path.of(org.h2.Driver.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    var bytes = Files.readAllBytes(jar);
    var sha = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));

    var c = h2("uploaded");
    c.put("driver", "uploaded");
    c.put("driverSha", sha);
    c.put("driverClass", "org.h2.Driver");
    var before = query(c, "SELECT 1", List.of(), 10, 10_000);
    assertEquals(409, before.status(), before.body());
    assertTrue(before.body().contains("unknown_driver"));

    var head = HttpRequest.newBuilder(URI.create(base + "/drivers/" + sha)).header("Authorization", "Bearer " + TOKEN)
        .method("HEAD", HttpRequest.BodyPublishers.noBody()).build();
    assertEquals(404, HTTP.send(head, HttpResponse.BodyHandlers.discarding()).statusCode());

    var wrongSha = "0".repeat(64);
    var mismatch = HTTP.send(HttpRequest.newBuilder(URI.create(base + "/drivers/" + wrongSha))
        .header("Authorization", "Bearer " + TOKEN).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),
        HttpResponse.BodyHandlers.ofString());
    assertEquals(400, mismatch.statusCode(), mismatch.body());

    var put = HTTP.send(HttpRequest.newBuilder(URI.create(base + "/drivers/" + sha))
        .header("Authorization", "Bearer " + TOKEN).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),
        HttpResponse.BodyHandlers.ofString());
    assertEquals(200, put.statusCode(), put.body());
    assertEquals(200, HTTP.send(head, HttpResponse.BodyHandlers.discarding()).statusCode());

    var after = query(c, "SELECT 41 + 1 AS answer", List.of(), 10, 10_000);
    assertEquals(42, after.rows().get(0).get("ANSWER").asInt(), after.body());

    c.put("driverClass", "org.h2.Nope");
    assertEquals("invalid_config", query(c, "SELECT 1", List.of(), 10, 10_000).error().get("kind").asText());
  }

  @Test
  void closesAResourcesPools() throws Exception {
    var c = h2("closing");
    c.put("poolKey", "resource-to-close");
    query(c, "SELECT 1", List.of(), 10, 10_000);
    var del = HttpRequest.newBuilder(URI.create(base + "/pools?key=resource-to-close"))
        .header("Authorization", "Bearer " + TOKEN).DELETE().build();
    assertEquals("{\"closed\":1}", HTTP.send(del, HttpResponse.BodyHandlers.ofString()).body());
  }

  @Test
  void unpacksWalletsSafelyAndRemovesThem() throws Exception {
    var good = zip(Map.of("Wallet_DB/cwallet.sso", "sso", "Wallet_DB/tnsnames.ora", "db_high = (DESCRIPTION=...)"));
    var dir = Wallets.unpack(tmp.resolve("w"), good);
    assertEquals("sso", Files.readString(dir.resolve("cwallet.sso")));
    assertNotNull(Files.getPosixFilePermissions(dir));
    assertEquals("rwx------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(dir)));
    Wallets.remove(dir);
    assertFalse(Files.exists(dir));

    assertThrows(Failure.class, () -> Wallets.unpack(tmp.resolve("w"), zip(Map.of("../../etc/passwd", "x"))));
    assertThrows(Failure.class, () -> Wallets.unpack(tmp.resolve("w"), zip(Map.of("a/b/c.sso", "x"))));
    assertThrows(Failure.class, () -> Wallets.unpack(tmp.resolve("w"), "not base64!"));
    try (var left = Files.list(tmp.resolve("w"))) {
      assertEquals(0, left.count());
    }
  }

  @Test
  void poolsAreSharedByConnectionNotByToken() {
    var a = new Spec.Connection("k", "h2", null, null, "jdbc:h2:mem:x", Map.of("user", "sa"), "token", "one", null, false, 5, null);
    var b = new Spec.Connection("k", "h2", null, null, "jdbc:h2:mem:x", Map.of("user", "sa"), "token", "two", null, false, 5, null);
    var readOnly = new Spec.Connection("k", "h2", null, null, "jdbc:h2:mem:x", Map.of("user", "sa"), "token", "one", null, true, 5, null);
    assertFalse(Pools.fingerprint(a).equals(Pools.fingerprint(readOnly)));
    var c = new Spec.Connection("k", "h2", null, null, "jdbc:h2:mem:x", Map.of("user", "other"), "token", "one", null, false, 5, null);
    assertEquals(Pools.fingerprint(a), Pools.fingerprint(b));
    assertFalse(Pools.fingerprint(a).equals(Pools.fingerprint(c)));
  }

  static String zip(Map<String, String> files) throws Exception {
    var bytes = new ByteArrayOutputStream();
    try (var z = new ZipOutputStream(bytes)) {
      for (var e : files.entrySet()) {
        z.putNextEntry(new ZipEntry(e.getKey()));
        z.write(e.getValue().getBytes());
        z.closeEntry();
      }
    }
    return Base64.getEncoder().encodeToString(bytes.toByteArray());
  }
}
