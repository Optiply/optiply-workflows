package com.optiply.jdbcrunner;

import java.nio.file.Path;

/**
 * The JDBC runner (M38, docs/architecture.md §2.42): the app's JDBC resources run their queries here, where the drivers
 * are. Settings from the environment:
 *
 * <ul>
 *   <li>{@code JDBC_RUNNER_TOKEN} (required: without it the runner refuses to start)
 *   <li>{@code PORT} (8080), {@code JDBC_DRIVERS_DIR} (/drivers: uploaded jars), {@code JDBC_WALLETS_DIR}
 *       (/tmp/wallets)
 *   <li>{@code JDBC_MAX_CONCURRENT} (32 queries at once), {@code JDBC_MAX_POOLS} (50), {@code JDBC_POOL_IDLE_MS}
 *       (10 minutes)
 * </ul>
 */
public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    // Tunnelled names resolve to a tunnel's loopback address only while it's open: never cache a lookup.
    java.security.Security.setProperty("networkaddress.cache.ttl", "0");
    java.security.Security.setProperty("networkaddress.cache.negative.ttl", "0");
    var token = System.getenv("JDBC_RUNNER_TOKEN");
    if (token == null || token.length() < 16) {
      System.err.println("JDBC_RUNNER_TOKEN is missing or shorter than 16 characters: refusing to start");
      System.exit(1);
    }
    var drivers = new Drivers(Drivers.BUILT_IN, Path.of(env("JDBC_DRIVERS_DIR", "/drivers")));
    var pools =
        new Pools(
            drivers,
            Path.of(env("JDBC_WALLETS_DIR", "/tmp/wallets")),
            Long.parseLong(env("JDBC_POOL_IDLE_MS", "600000")),
            Integer.parseInt(env("JDBC_MAX_POOLS", "50")));
    var runner = new Runner(pools, Integer.parseInt(env("JDBC_MAX_CONCURRENT", "32")));
    var server = new Server(Integer.parseInt(env("PORT", "8080")), token, drivers, pools, runner);
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  server.close();
                  runner.close();
                  pools.close();
                }));
    System.out.println("jdbc-runner listening on " + server.port());
  }

  private static String env(String name, String fallback) {
    var v = System.getenv(name);
    return v == null || v.isBlank() ? fallback : v;
  }
}
