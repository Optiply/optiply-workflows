package com.optiply.jdbcrunner;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Base64;
import java.util.Comparator;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipInputStream;

/**
 * Oracle wallets: a wallet zip unpacked into a folder of its own (only its owner can read it), for one pool, and removed
 * with it. Only plain files at the zip's top level (or in one folder, as Oracle Cloud's downloads have them).
 */
final class Wallets {
  static final int MAX_BYTES = 1024 * 1024;
  static final int MAX_FILES = 32;
  private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9._-]{1,100}$");

  private Wallets() {}

  static Path unpack(Path root, String base64) {
    byte[] zip;
    try {
      zip = Base64.getDecoder().decode(base64);
    } catch (IllegalArgumentException e) {
      throw new Failure("invalid_config", "The wallet isn't base64");
    }
    if (zip.length > MAX_BYTES) throw new Failure("invalid_config", "A wallet is at most 1 MB");
    Path dir = null;
    try {
      Files.createDirectories(root);
      dir = Files.createTempDirectory(root, "wallet-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
      int files = 0;
      long total = 0;
      try (var in = new ZipInputStream(new ByteArrayInputStream(zip))) {
        for (var entry = in.getNextEntry(); entry != null; entry = in.getNextEntry()) {
          if (entry.isDirectory()) continue;
          var parts = entry.getName().split("/");
          var name = parts[parts.length - 1];
          if (parts.length > 2 || !NAME.matcher(name).matches() || name.startsWith(".")) {
            throw new Failure("invalid_config", "The wallet has an unexpected file: " + entry.getName());
          }
          if (++files > MAX_FILES) throw new Failure("invalid_config", "The wallet has too many files");
          var bytes = in.readNBytes(MAX_BYTES + 1);
          total += bytes.length;
          if (total > MAX_BYTES) throw new Failure("invalid_config", "The wallet unpacks to more than 1 MB");
          Files.write(dir.resolve(name), bytes);
        }
      }
      if (files == 0) throw new Failure("invalid_config", "The wallet zip is empty");
      return dir;
    } catch (IOException e) {
      remove(dir);
      throw new Failure("invalid_config", "The wallet isn't a zip: " + Failure.message(e));
    } catch (RuntimeException e) {
      remove(dir);
      throw e;
    }
  }

  static void remove(Path dir) {
    if (dir == null) return;
    try (Stream<Path> walk = Files.walk(dir)) {
      walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
    } catch (IOException ignored) {
      // Already gone.
    }
  }
}
