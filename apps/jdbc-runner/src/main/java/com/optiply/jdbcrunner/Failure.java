package com.optiply.jdbcrunner;

import java.sql.SQLException;
import java.sql.SQLInvalidAuthorizationSpecException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A failure as the app reports it: {@code kind} is one of its connector error codes ({@code connection},
 * {@code query}, {@code timeout}, {@code aborted}, {@code too_large}, {@code invalid_config}, {@code busy}), with the
 * SQL state and the database's own error code when there are.
 */
final class Failure extends RuntimeException {
  final String kind;
  final String sqlState;
  final Integer vendorCode;

  Failure(String kind, String message) {
    this(kind, message, null, null);
  }

  Failure(String kind, String message, String sqlState, Integer vendorCode) {
    super(message);
    this.kind = kind;
    this.sqlState = sqlState;
    this.vendorCode = vendorCode;
  }

  Map<String, Object> toJson() {
    var out = new LinkedHashMap<String, Object>();
    out.put("kind", kind);
    out.put("message", getMessage());
    if (sqlState != null) out.put("sqlState", sqlState);
    if (vendorCode != null) out.put("vendorCode", vendorCode);
    return out;
  }

  /**
   * What went wrong, as a failure. {@code stopped} is why the runner stopped the query itself (a timeout or a
   * cancel), which wins over whatever the driver said about it. Connection problems (a pool that couldn't connect, SQL
   * states 08 and 28) are told apart from a query's own errors.
   */
  static Failure of(Throwable t, String stopped) {
    if (t instanceof Failure f) return f;
    if ("timeout".equals(stopped)) return new Failure("timeout", "The query hit the statement timeout");
    if ("aborted".equals(stopped)) return new Failure("aborted", "The query was cancelled");
    // Hikari's "connection is not available" carries the driver's own reason.
    if (t instanceof SQLTransientConnectionException && t.getCause() != null) {
      var cause = t.getCause();
      var sql = cause instanceof SQLException s ? s : null;
      return new Failure(
          "connection",
          "Could not connect to the database: " + message(cause),
          sql != null ? sql.getSQLState() : null,
          sql != null && sql.getErrorCode() != 0 ? sql.getErrorCode() : null);
    }
    if (t instanceof SQLException e) {
      var state = e.getSQLState();
      var code = e.getErrorCode() != 0 ? e.getErrorCode() : null;
      if (e instanceof SQLTimeoutException) return new Failure("timeout", message(e), state, code);
      boolean connecting =
          e instanceof SQLInvalidAuthorizationSpecException
              || e instanceof SQLNonTransientConnectionException
              || e instanceof SQLTransientConnectionException
              || (state != null && (state.startsWith("08") || state.startsWith("28")));
      if (connecting) return new Failure("connection", "Could not connect to the database: " + message(e), state, code);
      return new Failure("query", message(e), state, code);
    }
    return new Failure("query", message(t));
  }

  /** The error's message, and its root cause's when that says more ("Query request failed (… UnknownHost: x)"). */
  static String message(Throwable t) {
    var top = own(t);
    Throwable root = t;
    for (int depth = 0; root.getCause() != null && root.getCause() != root && depth < 20; depth++) root = root.getCause();
    if (root == t) return top;
    var cause = own(root);
    return top.contains(cause) ? top : top + " (" + cause + ")";
  }

  private static String own(Throwable t) {
    var m = t.getMessage();
    return m == null || m.isBlank() ? t.getClass().getSimpleName() : m.strip();
  }
}
