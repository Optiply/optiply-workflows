package com.optiply.jdbcrunner;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * The drivers a connection can use: the built-in ones (found by URL, and only for their own URLs), or a jar an admin
 * uploaded (by its SHA-256, in its own class loader that sees only the JDK).
 */
final class Drivers {
  /** Each built-in driver's URLs. Oracle's thin driver only: the OCI one would load native code. */
  static final Map<String, List<String>> BUILT_IN =
      Map.of(
          "oracle", List.of("jdbc:oracle:thin:"),
          "snowflake", List.of("jdbc:snowflake:"),
          "clickhouse", List.of("jdbc:clickhouse:", "jdbc:ch:"));

  private static final Map<String, String> LABELS =
      Map.of("oracle", "An Oracle", "snowflake", "A Snowflake", "clickhouse", "A ClickHouse");

  static final long MAX_JAR_BYTES = 100L * 1024 * 1024;
  private static final Pattern SHA = Pattern.compile("^[0-9a-f]{64}$");

  private final Map<String, List<String>> builtIn;
  private final Path dir;
  private final Map<String, Driver> uploaded = new ConcurrentHashMap<>();

  Drivers(Map<String, List<String>> builtIn, Path dir) throws IOException {
    this.builtIn = builtIn;
    this.dir = Files.createDirectories(dir);
  }

  /** The driver for a connection; a {@link Failure} says why there's none. */
  Driver forConnection(Spec.Connection c) {
    var url = c.url() == null ? "" : c.url().strip();
    if (url.isEmpty()) throw new Failure("invalid_config", "The JDBC URL is missing");
    if ("uploaded".equals(c.driver())) return uploaded(c.driverSha(), c.driverClass(), url);
    var prefixes = builtIn.get(c.driver() == null ? "" : c.driver());
    if (prefixes == null) throw new Failure("invalid_config", "Unknown driver: " + c.driver());
    if (prefixes.stream().noneMatch(url::startsWith)) {
      throw new Failure(
          "invalid_config",
          LABELS.getOrDefault(c.driver(), "This driver's") + " URL starts with " + String.join(" or ", prefixes) + ", not " + preview(url));
    }
    try {
      return DriverManager.getDriver(url);
    } catch (SQLException e) {
      throw new Failure("invalid_config", "No built-in driver accepts " + preview(url));
    }
  }

  boolean has(String sha) {
    return sha != null && SHA.matcher(sha).matches() && Files.isRegularFile(jar(sha));
  }

  /**
   * Keeps an uploaded jar, if its bytes are what its name says. Written to a temporary file first, so a half-written jar
   * is never used.
   */
  void store(String sha, InputStream body) throws IOException {
    if (!SHA.matcher(sha).matches()) throw new Failure("invalid_config", "A driver is named by its SHA-256 (hex)");
    var tmp = Files.createTempFile(dir, "upload-", ".part");
    try {
      var digest = sha256();
      long size = 0;
      try (var out = Files.newOutputStream(tmp)) {
        var buf = new byte[64 * 1024];
        for (int n; (n = body.read(buf)) != -1; ) {
          size += n;
          if (size > MAX_JAR_BYTES) throw new Failure("invalid_config", "A driver jar is at most 100 MB");
          digest.update(buf, 0, n);
          out.write(buf, 0, n);
        }
      }
      var actual = HexFormat.of().formatHex(digest.digest());
      if (!actual.equals(sha)) throw new Failure("invalid_config", "The jar's SHA-256 is " + actual + ", not " + sha);
      Files.move(tmp, jar(sha), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } finally {
      Files.deleteIfExists(tmp);
    }
  }

  private Driver uploaded(String sha, String className, String url) {
    if (!has(sha)) throw new UnknownDriver(sha);
    if (className == null || className.isBlank()) {
      throw new Failure("invalid_config", "An uploaded driver needs its driver class");
    }
    var driver =
        uploaded.computeIfAbsent(
            sha + ":" + className.strip(),
            key -> {
              try {
                // The JDK only (java.sql included), not this runner's own libraries.
                var loader =
                    new URLClassLoader(new URL[] {jar(sha).toUri().toURL()}, ClassLoader.getPlatformClassLoader());
                var type = Class.forName(className.strip(), true, loader);
                return (Driver) type.getDeclaredConstructor().newInstance();
              } catch (ClassNotFoundException e) {
                throw new Failure("invalid_config", "The jar has no class " + className.strip());
              } catch (ClassCastException e) {
                throw new Failure("invalid_config", className.strip() + " isn't a java.sql.Driver");
              } catch (ReflectiveOperationException | IOException | LinkageError e) {
                throw new Failure("invalid_config", "Could not load " + className.strip() + ": " + Failure.message(e));
              }
            });
    try {
      if (!driver.acceptsURL(url)) {
        throw new Failure("invalid_config", className.strip() + " doesn't accept " + preview(url));
      }
    } catch (SQLException e) {
      throw new Failure("invalid_config", Failure.message(e));
    }
    return driver;
  }

  private Path jar(String sha) {
    return dir.resolve(sha + ".jar");
  }

  /** The URL's scheme and host part, never its query string (which may carry a password). */
  static String preview(String url) {
    var cut = url.indexOf('?');
    var shown = cut == -1 ? url : url.substring(0, cut);
    return shown.length() > 80 ? shown.substring(0, 80) + "…" : shown;
  }

  static MessageDigest sha256() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  /** The app has to upload this jar first ({@code PUT /drivers/<sha>}), then ask again. */
  static final class UnknownDriver extends RuntimeException {
    final String sha;

    UnknownDriver(String sha) {
      super("Unknown driver " + sha);
      this.sha = sha;
    }
  }
}
