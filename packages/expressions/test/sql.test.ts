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
      expect(compileSql(sql)).toEqual({ text: sql, params: [] })
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
