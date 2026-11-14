package com.optiply.jdbcrunner;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A read-only resource's statements (M38): each must read. Oracle and Snowflake commit DDL on their own (a DROP can't
 * be rolled back) and drivers without transactions can't roll anything back, so the rolled-back transaction alone
 * isn't enough. Strings, quoted names and comments are skipped; each statement's first word is checked. A guard against
 * mistakes, not a security boundary: sign in as a user that can only read.
 */
final class ReadOnly {
  static final Set<String> READING = Set.of("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES");
  private static final Pattern WORD = Pattern.compile("^[\\s(]*([A-Za-z]+)");

  private ReadOnly() {}

  /** The first statement's word that doesn't read, or null when they all do. */
  static String firstWriting(String sql) {
    for (var statement : bare(sql).split(";")) {
      if (statement.isBlank()) continue;
      var m = WORD.matcher(statement);
      var word = m.find() ? m.group(1).toUpperCase(Locale.ROOT) : statement.strip();
      if (!READING.contains(word)) return word.length() > 30 ? word.substring(0, 30) : word;
    }
    return null;
  }

  static void check(String sql) {
    var word = firstWriting(sql);
    if (word != null) {
      throw new Failure(
          "query",
          "This resource is read-only: it runs only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN statements, not " + word);
    }
  }

  /** The SQL with strings, quoted names and comments blanked out (`;` inside them must not split statements). */
  static String bare(String sql) {
    var out = new StringBuilder(sql.length());
    int i = 0;
    while (i < sql.length()) {
      char ch = sql.charAt(i);
      char next = i + 1 < sql.length() ? sql.charAt(i + 1) : 0;
      if ((ch == '-' && next == '-') || (ch == '/' && next == '/')) {
        int nl = sql.indexOf('\n', i);
        i = nl == -1 ? sql.length() : nl;
        out.append(' ');
      } else if (ch == '/' && next == '*') {
        int end = sql.indexOf("*/", i + 2);
        i = end == -1 ? sql.length() : end + 2;
        out.append(' ');
      } else if (ch == '$' && next == '$') {
        int end = sql.indexOf("$$", i + 2);
        i = end == -1 ? sql.length() : end + 2;
        out.append(' ');
      } else if (ch == '\'' || ch == '"' || ch == '`') {
        i++;
        while (i < sql.length()) {
          char c = sql.charAt(i);
          if (c == '\\' && ch == '\'') i += 2;
          else if (c == ch && i + 1 < sql.length() && sql.charAt(i + 1) == ch) i += 2;
          else if (c == ch) {
            i++;
            break;
          } else i++;
        }
        out.append(' ');
      } else {
        out.append(ch);
        i++;
      }
    }
    return out.toString();
  }
}
