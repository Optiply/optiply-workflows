package com.optiply.jdbcrunner;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;

/** What the app sends: a resource's connection, and the query to run on it. */
final class Spec {
  private Spec() {}

  /**
   * One JDBC resource's connection, as the app built it from the resource's settings and secrets. Everything but
   * {@code token} and {@code readOnly} picks the pool (see {@link Pools#fingerprint}).
   */
  @JsonIgnoreProperties(ignoreUnknown = true)
  record Connection(
      /** The app's name for the pool (resource config, version, and the person for per-person OAuth). */
      String poolKey,
      /** {@code oracle}, {@code snowflake}, {@code clickhouse} or {@code uploaded}. */
      String driver,
      /** An uploaded driver's jar, by its SHA-256 (hex). */
      String driverSha,
      /** An uploaded driver's class ({@code com.example.jdbc.Driver}). */
      String driverClass,
      String url,
      /** Connection properties: user, password and the driver's own, secrets included. */
      Map<String, String> properties,
      /** A property that carries a token that changes (Snowflake OAuth's {@code token}): not part of the pool. */
      String tokenProperty,
      String token,
      /** An Oracle wallet: the zip, base64, and the password of an {@code ewallet.p12} in it. */
      Wallet wallet,
      boolean readOnly,
      Integer poolSize,
      /** Hosts reached through the app's SSH tunnel (step 4); null when connecting directly. */
      Tunnel tunnel) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  record Wallet(String zip, String password) {}

  /**
   * A tunnel registration: the app process's forwarder, the tunnel's id and secret there, the hosts it reaches, and its
   * route (a hash of the SSH servers it goes through: registrations on one route share the hosts' addresses).
   */
  @JsonIgnoreProperties(ignoreUnknown = true)
  record Tunnel(String forwarder, String tunnelId, String secret, List<String> hosts, String route) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  record Query(
      /** The app's id for this run, for {@code POST /cancel}. */
      String queryId,
      Connection connection,
      String sql,
      /** One value per {@code ?}, in order (arrays already expanded by the app). */
      List<JsonNode> params,
      Long maxRows,
      Long timeoutMs) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  record Test(Connection connection, Long timeoutMs) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  record Cancel(String queryId) {}
}
