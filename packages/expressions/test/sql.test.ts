import { describe, expect, it } from 'vitest'
import { compileSql, TemplateError } from '../src'

const text = (sql: string) => compileSql(sql).text
const codes = (sql: string) => compileSql(sql).params.map((p) => p.code.trim())

describe('compileSql (postgres)', () => {
  it('replaces each {{ }} with a numbered placeholder', () => {
    const sql = 'select * from orders where customer_id = {{ startTrigger.data.id }} and status = {{status}}'
    const compiled = compileSql(sql)
    expect(compiled.text).toBe('select * from orders where customer_id = $1 and status = $2')
    expect(compiled.params).toEqual([
      { code: ' startTrigger.data.id ', start: 41, end: 67 },
      { code: 'status', start: 81, end: 91 },
    ])
    expect(sql.slice(41, 67)).toBe('{{ startTrigger.data.id }}')
    expect(compiled.offsets).toEqual([41, 57])
    expect(compiled.text.slice(57, 59)).toBe('$2')
  })

  it('handles arrays, casts and repeated expressions', () => {
    expect(text('where id = any({{ ids }}) and n = {{n}}::int and m = {{n}}')).toBe(
      'where id = any($1) and n = $2::int and m = $3',
    )
  })

  it('keeps placeholders separate tokens', () => {
    expect(text('select x{{a}}y')).toBe('select x $1 y')
    expect(text('select {{a}}{{b}}')).toBe('select $1 $2')
  })

  it('handles JS that contains SQL-looking quotes and braces', () => {
    expect(
      compileSql(`where name = {{ "o'brien" }} and tag = {{ {a: '}}'}.a }}`).params.map((p) => p.code),
    ).toEqual([` "o'brien" `, ` {a: '}}'}.a `])
  })

  it.each([
    ["select '{{ not a param }}' -- {{ nor this }}", 'string'],
    ['select 1 /* {{ x }} /* nested */ still {{ y }} */', 'comment'],
    ['select $fn$ {{ x }} $fn$', 'string'],
    ['select "{{col}}" from t', 'identifier'],
  ])('never turns {{ }} in quotes or comments into parameters: %s', (sql, where) => {
    if (where === 'comment') {
      expect(compileSql(sql)).toEqual({ text: sql, params: [], offsets: [] })
    } else {
      expect(() => compileSql(sql)).toThrow(TemplateError)
    }
    expect(compileSql("select 1 -- it's {{ x }}").params).toEqual([])
  })

  it('suggests removing the quotes around a lone expression', () => {
    expect(() => compileSql("where name = '{{ name }}'")).toThrow(
      expect.objectContaining({ hint: expect.stringMatching(/Remove the quotes/) }),
    )
  })

  it('suggests building LIKE patterns in the expression', () => {
    expect(() => compileSql("where name like '%{{ q }}%'")).toThrow(
      expect.objectContaining({ hint: expect.stringMatching(/'%' \+ search/) }),
    )
  })

  it('explains that identifiers cannot be parameters', () => {
    expect(() => compileSql('select * from "{{ table }}"')).toThrow(
      expect.objectContaining({ hint: expect.stringMatching(/Table and column names/) }),
    )
  })

  it('understands escaped quotes and E-strings', () => {
    expect(text("select 'it''s', E'a\\'b', {{x}}")).toBe("select 'it''s', E'a\\'b', $1")
    // Not an E-string: backslash is literal, so the string ends at the second quote.
    expect(text("select 'a\\', {{x}}")).toBe("select 'a\\', $1")
    expect(text('select "we""ird", {{x}}')).toBe('select "we""ird", $1')
  })

  it('rejects hand-written positional parameters but allows $ inside identifiers', () => {
    expect(() => compileSql('where id = $1')).toThrow(/Positional parameter \$1/)
    expect(text('select price$1 from t where a = {{a}}')).toBe('select price$1 from t where a = $1')
  })

  it('reports unterminated literals, dollar quotes and expressions', () => {
    expect(() => compileSql("select 'oops")).toThrow(/Unterminated string literal/)
    expect(() => compileSql('select "oops')).toThrow(/Unterminated quoted identifier/)
    expect(() => compileSql('select $x$ body')).toThrow(/Unterminated dollar-quoted/)
    expect(() => compileSql('select {{ a ')).toThrow(/Unterminated \{\{/)
  })

  // Injection payloads written *inside* the expression stay in the parameter list; the SQL text only ever gets
  // `$n`. (Runtime values never reach compileSql at all; the live-Postgres check is in the connector tests.)
  describe('injection payloads inside expressions never reach the SQL text', () => {
    it.each([
      "'; drop table users; --",
      '1 OR 1=1',
      "' OR '1'='1",
      '$1',
      '*/ select 1 /*',
      "\\'; select pg_sleep(10); --",
      '}} or 1=1 {{',
    ])('%s', (payload) => {
      const sql = `select * from users where email = {{ ${JSON.stringify(payload)} }}`
      const compiled = compileSql(sql)
      expect(compiled.text).toBe('select * from users where email = $1')
      expect(codes(sql)).toEqual([JSON.stringify(payload)])
    })
  })
})

describe('compileSql (mysql)', () => {
  const my = (sql: string) => compileSql(sql, 'mysql')

  it('replaces each {{ }} with ? and records where each one is', () => {
    const compiled = my('select * from orders where id in ({{ ids }}) and status = {{status}}')
    expect(compiled.text).toBe('select * from orders where id in (?) and status = ?')
    expect(compiled.params.map((p) => p.code.trim())).toEqual(['ids', 'status'])
    expect(compiled.offsets.map((o) => compiled.text[o])).toEqual(['?', '?'])
    expect(my('select x{{a}}y').text).toBe('select x ? y')
  })

  it('treats double quotes as strings and backticks as identifiers', () => {
    expect(() => my('select "{{ x }}"')).toThrow(/inside a SQL string literal/)
    expect(() => my('select `{{ col }}` from t')).toThrow(/inside a quoted identifier/)
    expect(my('select "a""b", `we``ird`, {{x}}').text).toBe('select "a""b", `we``ird`, ?')
    expect(() => my('select `oops')).toThrow(/Unterminated quoted identifier/)
    expect(() => my('select "oops')).toThrow(/Unterminated string literal/)
  })

  it('applies backslash escapes in every string', () => {
    expect(my('select \'a\\\'b\', "c\\"d", {{x}}').text).toBe('select \'a\\\'b\', "c\\"d", ?')
    expect(() => my("select 'a\\', {{x}}")).toThrow(/Unterminated string literal/)
  })

  it('knows its comments: #, -- followed by a space, and non-nesting /* */', () => {
    expect(my('select 1 # {{ x }}\n, {{ y }}').params.map((p) => p.code.trim())).toEqual(['y'])
    expect(my('select 1 -- {{ x }}\n, {{ y }}').params.map((p) => p.code.trim())).toEqual(['y'])
    // `--1` is minus minus one, not a comment.
    expect(my('select 5--{{ x }}').text).toBe('select 5--?')
    // Not nested: the comment ends at the first */.
    expect(my('select /* a /* b */ {{ x }} */').params.map((p) => p.code.trim())).toEqual(['x'])
  })

  it('rejects a hand-written ? but allows one in strings and comments', () => {
    expect(() => my('where id = ?')).toThrow(/Positional parameter \?/)
    expect(my("where a = '?' and b = {{b}} # ?").text).toBe("where a = '?' and b = ? # ?")
    expect(my('select $1, price$ from t').text).toBe('select $1, price$ from t')
  })

  describe('injection payloads inside expressions never reach the SQL text', () => {
    it.each(["'; drop table users; -- ", '1 OR 1=1', "\\'; select sleep(10); # ", '?', '`'])(
      '%s',
      (payload) => {
        const compiled = my(`select * from users where email = {{ ${JSON.stringify(payload)} }}`)
        expect(compiled.text).toBe('select * from users where email = ?')
        expect(compiled.params.map((p) => p.code.trim())).toEqual([JSON.stringify(payload)])
      },
    )
  })
})

describe('compileSql (bigquery)', () => {
  const bq = (sql: string) => compileSql(sql, 'bigquery')
  const codes = (sql: string) => bq(sql).params.map((p) => p.code.trim())

  it('replaces each {{ }} with a named @pN parameter', () => {
    const compiled = bq(
      'SELECT * FROM `proj.shop.orders` WHERE id IN UNNEST({{ ids }}) AND status = {{status}}',
    )
    expect(compiled.text).toBe('SELECT * FROM `proj.shop.orders` WHERE id IN UNNEST(@p1) AND status = @p2')
    expect(compiled.offsets.map((o) => compiled.text.slice(o, o + 3))).toEqual(['@p1', '@p2'])
    expect(bq('select x{{a}}y').text).toBe('select x @p1 y')
  })

  it('knows triple-quoted, raw and bytes strings', () => {
    expect(codes("SELECT '''it's {{ a }}''', {{ b }}".replace('{{ a }}', 'a'))).toEqual(['b'])
    expect(() => bq('SELECT """{{ x }}"""')).toThrow(/inside a SQL string literal/)
    expect(() => bq('SELECT """{{ x }}"""')).toThrow(
      expect.objectContaining({ hint: expect.stringMatching(/Remove the quotes/) }),
    )
    expect(bq("SELECT r'\\d+', b'\\x00', rb'''a''', {{ x }}").text).toBe(
      "SELECT r'\\d+', b'\\x00', rb'''a''', @p1",
    )
    expect(bq('SELECT \'a\\\'b\', "c\\"d", {{ x }}').text).toBe('SELECT \'a\\\'b\', "c\\"d", @p1')
    expect(() => bq("SELECT '''never closed")).toThrow(/Unterminated string literal/)
  })

  it('treats backticks as identifiers and knows its comments', () => {
    expect(() => bq('SELECT * FROM `{{ table }}`')).toThrow(/inside a quoted identifier/)
    expect(codes('SELECT 1 # {{ x }}\n, 2 -- {{ y }}\n, {{ z }} /* {{ w }} */')).toEqual(['z'])
  })

  it('rejects hand-written @name and ? parameters but allows @@ system variables', () => {
    expect(() => bq('SELECT * FROM t WHERE id = @id')).toThrow(/Named parameter @id/)
    expect(() => bq('SELECT * FROM t WHERE id = ?')).toThrow(/Positional parameter \?/)
    expect(bq('SELECT @@project_id, {{ x }}').text).toBe('SELECT @@project_id, @p1')
    expect(bq("SELECT '@id', `a@b`, {{ x }} # @c").text).toBe("SELECT '@id', `a@b`, @p1 # @c")
  })

  describe('injection payloads inside expressions never reach the SQL text', () => {
    it.each(["'; DROP TABLE x; --", '@p2', "''' OR 1=1 '''", '`'])('%s', (payload) => {
      const compiled = bq(`SELECT * FROM users WHERE email = {{ ${JSON.stringify(payload)} }}`)
      expect(compiled.text).toBe('SELECT * FROM users WHERE email = @p1')
    })
  })
})
