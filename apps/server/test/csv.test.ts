import { describe, expect, it } from 'vitest'
import {
  CsvError,
  CsvParser,
  columnNames,
  detectDelimiter,
  fromDecimalComma,
  guessCsv,
  MAX_FIELDS,
  parseCsv,
} from '../src/services/csv'

const fields = (text: string, delimiter: ',' | ';' | '\t' = ',') =>
  parseCsv(text, delimiter).map((r) => r.fields)

describe('the CSV parser', () => {
  it('reads plain, quoted and escaped fields', () => {
    expect(fields('a,b,c\n1,"two, too","say ""hi"""\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, too', 'say "hi"'],
    ])
  })

  it('keeps line breaks inside quotes, and numbers records by the line they start on', () => {
    const records = parseCsv('name,note\r\nAda,"line one\r\nline two"\r\nBob,x\r\n')
    expect(records.map((r) => [r.line, r.fields])).toEqual([
      [1, ['name', 'note']],
      [2, ['Ada', 'line one\r\nline two']],
      [4, ['Bob', 'x']],
    ])
  })

  it('ends records on LF, CRLF and CR, skips blank lines, and reads a last line without a break', () => {
    expect(fields('a\r\rb\r\n\r\nc\n\nd')).toEqual([['a'], ['b'], ['c'], ['d']])
  })

  it('drops a byte-order mark, keeps empty fields, and reads "" as an empty field', () => {
    expect(fields('﻿a,b\n,\n"",x\n')).toEqual([
      ['a', 'b'],
      ['', ''],
      ['', 'x'],
    ])
  })

  it('reads quotes inside unquoted fields as characters, like spreadsheets', () => {
    expect(fields('size\n12" pipe\n"quoted"tail\n')).toEqual([['size'], ['12" pipe'], ['quotedtail']])
  })

  it('reports a quote that never closes, with the line it opened on', () => {
    expect(() => parseCsv('a\n"open\nstill open')).toThrow(new CsvError('a quoted field is never closed', 2))
  })

  it('refuses records with too many fields', () => {
    expect(() => parseCsv(','.repeat(MAX_FIELDS + 1))).toThrow(/more than 1000 fields/)
  })

  it('gives the same records however the text is split into chunks', () => {
    const text = '﻿id;name;note\r\n1;"Ada; ""the first""";"multi\r\nline"\r\n2;Bob;\r\n3;"";x'
    const whole = parseCsv(text, ';')
    for (let size = 1; size <= text.length; size++) {
      const parser = new CsvParser(';')
      const got = []
      for (let i = 0; i < text.length; i += size) got.push(...parser.push(text.slice(i, i + size)))
      got.push(...parser.end())
      expect(got, `chunks of ${size}`).toEqual(whole)
    }
  })

  it('uses the delimiter it is given', () => {
    expect(fields('a\tb,c\n', '\t')).toEqual([['a', 'b,c']])
  })
})

describe('guessing', () => {
  it('finds the delimiter on the first line, outside quotes', () => {
    expect(detectDelimiter('a;b;c\n1,5;2;3')).toBe(';')
    expect(detectDelimiter('"x;y;z",b\n')).toBe(',')
    expect(detectDelimiter('a\tb\n')).toBe('\t')
    expect(detectDelimiter('single\n')).toBe(',')
  })

  it('turns headers into unique snake_case column names', () => {
    expect(
      columnNames(['Customer Name', 'E-mail', 'Prijs (€)', '', '2nd', 'pg_x', 'name', 'Name', 'Café']),
    ).toEqual(['customer_name', 'e_mail', 'prijs', 'column_4', '_2nd', 'col_pg_x', 'name', 'name_2', 'cafe'])
  })

  it('guesses each type from every non-empty value', () => {
    const guess = guessCsv(
      [
        'id,big,price,ok,day,at,ref,data,note,empty',
        '1,9007199254740993,1.5,yes,2026-01-31,2026-01-31T10:00:00Z,0b9c3c1e-4d1f-4c6b-9e7a-3f5d2a1b0c9d,{"a":1},hi,',
        '2,3,2,no,2026-02-01,2026-02-01 11:30,0b9c3c1e-4d1f-4c6b-9e7a-3f5d2a1b0c9e,[1],2,',
        ',,,,,,,,,',
      ].join('\n'),
      { complete: true },
    )
    expect(guess).toMatchObject({
      delimiter: ',',
      names: ['id', 'big', 'price', 'ok', 'day', 'at', 'ref', 'data', 'note', 'empty'],
      types: ['integer', 'bigint', 'decimal', 'boolean', 'date', 'datetime', 'uuid', 'json', 'text', 'text'],
    })
    expect(guess.rows).toHaveLength(3)
  })

  it('reads day-month-year unless a value says month-day-year', () => {
    expect(guessCsv('d\n03/04/2026\n25/04/2026\n', { complete: true })).toMatchObject({
      dateOrder: 'DMY',
      types: ['date'],
    })
    expect(guessCsv('d\n03/04/2026\n04/25/2026\n', { complete: true }).dateOrder).toBe('MDY')
  })

  it('spots decimal commas in semicolon files, and leaves comma files alone', () => {
    const nl = guessCsv('naam;prijs;aantal\nA;1.234,50;3\nB;2,5;4\n', { complete: true })
    expect(nl).toMatchObject({ delimiter: ';', decimalComma: true, types: ['text', 'decimal', 'integer'] })
    expect(guessCsv('a;b\nx;1.5\n', { complete: true }).decimalComma).toBe(false)
    expect(fromDecimalComma('1.234,50')).toBe('1234.50')
    expect(fromDecimalComma('-2,5')).toBe('-2.5')
  })

  it('keeps codes with leading zeros, and numbers past bigint, as text', () => {
    const guess = guessCsv(
      'ean,postcode,big,zero,day\n0012345678905,0123,123456789012345678901,0,01-02-2026\n8712345678906,1234,5,1,02-02-2026\n',
      {
        complete: true,
      },
    )
    expect(guess.types).toEqual(['text', 'text', 'text', 'integer', 'date'])
  })

  it('reads the first record as data when told there is no header', () => {
    const guess = guessCsv('qty,price\n3,1.5\n', { complete: true, header: false })
    expect(guess).toMatchObject({
      header: ['column_1', 'column_2'],
      names: ['column_1', 'column_2'],
      types: ['text', 'text'],
      rows: [
        ['qty', 'price'],
        ['3', '1.5'],
      ],
    })
  })

  it('drops a record cut off at the end of a sample', () => {
    const guess = guessCsv('a,b\n1,2\n3,"unfinish')
    expect(guess.rows).toEqual([['1', '2']])
  })

  it('needs at least a header', () => {
    expect(() => guessCsv('', { complete: true })).toThrow(/no rows/)
  })
})
