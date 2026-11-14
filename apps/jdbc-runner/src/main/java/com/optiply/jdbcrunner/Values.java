package com.optiply.jdbcrunner;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Array;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLXML;
import java.sql.Types;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoField;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Values between JSON and JDBC: {@code {{ }}} values bound to a statement, and cells read back as JSON. */
final class Values {
  private Values() {}

  /** 2^53: beyond it, a JSON number (a JavaScript double) loses integers. */
  private static final long SAFE = 9_007_199_254_740_992L;

  private static final DateTimeFormatter WALL_CLOCK =
      new java.time.format.DateTimeFormatterBuilder()
          .appendPattern("yyyy-MM-dd HH:mm:ss")
          .optionalStart()
          .appendFraction(ChronoField.NANO_OF_SECOND, 0, 9, true)
          .optionalEnd()
          .toFormatter();

  private static final DateTimeFormatter TIME =
      new java.time.format.DateTimeFormatterBuilder()
          .appendPattern("HH:mm:ss")
          .optionalStart()
          .appendFraction(ChronoField.NANO_OF_SECOND, 0, 9, true)
          .optionalEnd()
          .toFormatter();

  /**
   * Binds each value to its {@code ?}: null as a NULL, booleans, whole numbers as longs (bigger ones as decimals), other
   * numbers as doubles, strings as strings, the app's dates ({@code {"$timestamp": iso}}) as timestamps and binary
   * ({@code {"$bytes": base64}}) as bytes; anything else as JSON text (the app sends objects as JSON strings).
   */
  static void bind(PreparedStatement ps, List<JsonNode> params) throws SQLException {
    if (params == null) return;
    for (int i = 0; i < params.size(); i++) {
      var node = params.get(i);
      int at = i + 1;
      if (node == null || node.isNull() || node.isMissingNode()) ps.setNull(at, Types.VARCHAR);
      else if (node.isBoolean()) ps.setBoolean(at, node.booleanValue());
      else if (node.isIntegralNumber()) {
        if (node.canConvertToLong()) ps.setLong(at, node.longValue());
        else ps.setBigDecimal(at, new BigDecimal(node.bigIntegerValue()));
      } else if (node.isNumber()) ps.setDouble(at, node.doubleValue());
      else if (node.isTextual()) ps.setString(at, node.textValue());
      else if (node.isObject() && node.has("$timestamp")) {
        // A date from the app: a timestamp (in UTC, the runner's zone), which every driver compares with its dates.
        ps.setTimestamp(at, java.sql.Timestamp.from(java.time.Instant.parse(node.get("$timestamp").asText())));
      } else if (node.isObject() && node.has("$bytes")) {
        ps.setBytes(at, java.util.Base64.getDecoder().decode(node.get("$bytes").asText()));
      } else ps.setString(at, node.toString());
    }
  }

  /** The columns of a result: their names (an unnamed one gets {@code columnN}) and their database types. */
  static List<Map<String, Object>> fields(ResultSetMetaData meta) throws SQLException {
    var out = new ArrayList<Map<String, Object>>();
    for (int i = 1; i <= meta.getColumnCount(); i++) {
      var field = new LinkedHashMap<String, Object>();
      field.put("name", name(meta, i));
      field.put("type", meta.getColumnTypeName(i));
      out.add(field);
    }
    return out;
  }

  static String name(ResultSetMetaData meta, int i) throws SQLException {
    var label = meta.getColumnLabel(i);
    if (label == null || label.isBlank()) label = meta.getColumnName(i);
    return label == null || label.isBlank() ? "column" + i : label;
  }

  /**
   * A cell as JSON: numbers within 2^53 as numbers, others (and decimals a double can't hold exactly) as strings;
   * dates and timestamps without a zone as written ({@code 2026-10-14 09:30:00}), with one as an instant (ISO, UTC);
   * binary as base64; arrays as lists.
   */
  static Object cell(ResultSet rs, int i, int type) throws SQLException {
    Object value;
    switch (type) {
      case Types.BIT, Types.BOOLEAN -> {
        var b = rs.getBoolean(i);
        value = rs.wasNull() ? null : b;
      }
      case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> {
        var n = rs.getLong(i);
        value = rs.wasNull() ? null : n;
      }
      case Types.BIGINT -> value = number(rs.getObject(i));
      case Types.REAL, Types.FLOAT, Types.DOUBLE -> {
        var d = rs.getDouble(i);
        value = rs.wasNull() ? null : Double.isFinite(d) ? d : Double.toString(d);
      }
      case Types.NUMERIC, Types.DECIMAL -> value = decimal(rs.getBigDecimal(i));
      case Types.DATE -> {
        var d = rs.getObject(i, LocalDate.class);
        value = d == null ? null : d.toString();
      }
      case Types.TIME -> {
        var t = rs.getObject(i, LocalTime.class);
        value = t == null ? null : TIME.format(t);
      }
      case Types.TIMESTAMP -> {
        var t = rs.getObject(i, LocalDateTime.class);
        value = t == null ? null : WALL_CLOCK.format(t);
      }
      case Types.TIMESTAMP_WITH_TIMEZONE, Types.TIME_WITH_TIMEZONE -> {
        var t = rs.getObject(i, OffsetDateTime.class);
        value = t == null ? null : t.withOffsetSameInstant(ZoneOffset.UTC).toInstant().toString();
      }
      case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY -> {
        var bytes = rs.getBytes(i);
        value = bytes == null ? null : Base64.getEncoder().encodeToString(bytes);
      }
      case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR, Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR,
          Types.CLOB, Types.NCLOB -> value = rs.getString(i);
      default -> value = json(rs.getObject(i));
    }
    return value;
  }

  /** Whatever a driver hands back for other types (arrays, maps, LOBs, its own objects), as JSON. */
  static Object json(Object v) throws SQLException {
    if (v == null || v instanceof String || v instanceof Boolean) return v;
    if (v instanceof BigDecimal d) return decimal(d);
    if (v instanceof BigInteger || v instanceof Long) return number(v);
    if (v instanceof Number n) return n;
    if (v instanceof byte[] b) return Base64.getEncoder().encodeToString(b);
    if (v instanceof UUID u) return u.toString();
    if (v instanceof Clob c) return c.getSubString(1, (int) Math.min(Integer.MAX_VALUE, c.length()));
    if (v instanceof Blob b) return Base64.getEncoder().encodeToString(b.getBytes(1, (int) Math.min(Integer.MAX_VALUE, b.length())));
    if (v instanceof SQLXML x) return x.getString();
    if (v instanceof Array a) return json(a.getArray());
    if (v instanceof LocalDateTime t) return WALL_CLOCK.format(t);
    if (v instanceof LocalDate d) return d.toString();
    if (v instanceof LocalTime t) return TIME.format(t);
    if (v instanceof OffsetDateTime t) return t.toInstant().toString();
    if (v instanceof java.time.ZonedDateTime t) return t.toInstant().toString();
    if (v instanceof java.time.Instant t) return t.toString();
    if (v instanceof java.sql.Timestamp t) return WALL_CLOCK.format(t.toLocalDateTime());
    if (v instanceof java.sql.Date d) return d.toLocalDate().toString();
    if (v instanceof java.sql.Time t) return TIME.format(t.toLocalTime());
    if (v instanceof Object[] items) {
      var out = new ArrayList<Object>(items.length);
      for (var item : items) out.add(json(item));
      return out;
    }
    if (v.getClass().isArray()) {
      int n = java.lang.reflect.Array.getLength(v);
      var out = new ArrayList<Object>(n);
      for (int k = 0; k < n; k++) out.add(json(java.lang.reflect.Array.get(v, k)));
      return out;
    }
    if (v instanceof Iterable<?> items) {
      var out = new ArrayList<Object>();
      for (var item : items) out.add(json(item));
      return out;
    }
    if (v instanceof Map<?, ?> map) {
      var out = new LinkedHashMap<String, Object>();
      for (var e : map.entrySet()) out.put(String.valueOf(e.getKey()), json(e.getValue()));
      return out;
    }
    return v.toString();
  }

  private static Object number(Object v) {
    if (v == null) return null;
    if (v instanceof Number n && !(v instanceof BigInteger) && !(v instanceof BigDecimal)) {
      long l = n.longValue();
      return Math.abs(l) <= SAFE ? (Object) l : Long.toString(l);
    }
    var big = v instanceof BigInteger b ? b : new BigInteger(v.toString());
    return big.abs().compareTo(BigInteger.valueOf(SAFE)) <= 0 ? (Object) big.longValue() : big.toString();
  }

  /** A decimal as a number when a double holds it exactly (Oracle's NUMBER ids, prices), else as a string. */
  private static Object decimal(BigDecimal d) {
    if (d == null) return null;
    var plain = d.stripTrailingZeros();
    if (plain.scale() <= 0 && plain.precision() - plain.scale() <= 15) return plain.longValueExact();
    double asDouble = d.doubleValue();
    if (Double.isFinite(asDouble) && new BigDecimal(Double.toString(asDouble)).compareTo(d) == 0) return asDouble;
    return d.toPlainString();
  }
}
