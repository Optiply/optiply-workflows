import { afterEach, describe, expect, it } from 'vitest'
import { IvmRuntime, type RunOptions, SandboxError } from '../src'

let runtime: IvmRuntime
afterEach(() => runtime?.dispose())

async function expectSandboxError(p: Promise<unknown>, kind: SandboxError['kind']) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SandboxError)
  expect((err as SandboxError).kind).toBe(kind)
  return err as SandboxError
}

describe('IvmRuntime: expressions and code', () => {
  it('evaluates expressions against scope', async () => {
    runtime = new IvmRuntime()
    const scope = { query1: { data: [{ id: 1 }, { id: 2 }] } }
    expect(await runtime.evalExpression('query1.data.length', scope)).toBe(2)
    expect(await runtime.evalExpression('query1.data.map(r => r.id)', scope)).toEqual([1, 2])
    expect(await runtime.evalExpression('{ a: 1 } // trailing comment', {})).toEqual({ a: 1 })
  })

  it('runs async code blocks that return JSON', async () => {
    runtime = new IvmRuntime()
    const result = await runtime.runCode(
      'const x = await Promise.resolve(startTrigger.data.n)\nreturn { doubled: x * 2, at: new Date(0) }',
      { startTrigger: { data: { n: 21 } } },
    )
    expect(result).toEqual({ doubled: 42, at: '1970-01-01T00:00:00.000Z' })
  })

  it('exposes lodash and dayjs (with timezone support)', async () => {
    runtime = new IvmRuntime()
    expect(await runtime.evalExpression('_.sumBy(rows, "v")', { rows: [{ v: 1 }, { v: 2 }] })).toBe(3)
    expect(await runtime.evalExpression('_.chain([3,1,2]).sortBy().value()', {})).toEqual([1, 2, 3])
    expect(
      await runtime.evalExpression(
        'dayjs.utc("2026-03-29T00:30:00Z").tz("Europe/Amsterdam").format("YYYY-MM-DD HH:mm")',
        {},
      ),
    ).toBe('2026-03-29 01:30')
  })

  it("exposes Retool's libraries: moment, numbro, Papa and uuid (M36)", async () => {
    runtime = new IvmRuntime()
    expect(
      await runtime.evalExpression(
        'moment.utc("2026-11-12T10:00:00Z").add(1, "day").format("DD-MM-YYYY HH:mm")',
        {},
      ),
    ).toBe('13-11-2026 10:00')
    expect(await runtime.evalExpression('moment("2026-01-31").isValid()', {})).toBe(true)
    expect(
      await runtime.evalExpression('numbro(1234.5).format({ thousandSeparated: true, mantissa: 2 })', {}),
    ).toBe('1,234.50')
    expect(await runtime.evalExpression('numbro(0.256).format("0.0%")', {})).toBe('25.6%')
    expect(await runtime.evalExpression('Papa.parse("a,b\\n1,2", { header: true }).data', {})).toEqual([
      { a: '1', b: '2' },
    ])
    expect(await runtime.evalExpression('Papa.unparse([{ a: 1, b: "x,y" }])', {})).toBe('a,b\r\n1,"x,y"')
    const ids = (await runtime.runCode('return [uuid.v4(), uuid.v4(), uuid.v7()]', {})) as string[]
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(await runtime.evalExpression('uuid.validate(id)', { id })).toBe(true)
    expect(await runtime.evalExpression('uuid.version(id)', { id: ids[0] })).toBe(4)
    // A fresh context per evaluation: each starts from the snapshot but gets its own random bytes.
    const again = await runtime.evalExpression('uuid.v4()', {})
    expect(ids).not.toContain(again)
  })

  it("gives code crypto's random part from the host", async () => {
    runtime = new IvmRuntime()
    const id = (await runtime.evalExpression('crypto.randomUUID()', {})) as string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const bytes = (await runtime.evalExpression(
      'Array.from(crypto.getRandomValues(new Uint8Array(64)))',
      {},
    )) as number[]
    expect(bytes).toHaveLength(64)
    expect(new Set(bytes).size).toBeGreaterThan(16)
    await expect(runtime.evalExpression('crypto.getRandomValues(new Float64Array(2))', {})).rejects.toThrow(
      'integer typed array',
    )
    await expect(runtime.evalExpression('crypto.getRandomValues(new Uint8Array(65537))', {})).rejects.toThrow(
      'at most 65536',
    )
  })

  it('exposes the sql helpers for sort columns and directions', async () => {
    runtime = new IvmRuntime()
    const column = "sql.column(sort, ['name', 'p.price'], 'id')"
    expect(await runtime.evalExpression(column, { sort: 'p.price' })).toBe('p.price')
    expect(await runtime.evalExpression(column, { sort: null })).toBe('id')
    await expect(runtime.evalExpression(column, { sort: 'name; drop table x' })).rejects.toThrow(
      /expected one of "name", "p.price"/,
    )
    expect(
      await runtime.evalExpression('[sql.direction(true), sql.direction("asc"), sql.direction()]', {}),
    ).toEqual(['DESC', 'ASC', 'ASC'])
    await expect(runtime.evalExpression('sql.direction("sideways")', {})).rejects.toThrow(/sql.direction got/)
  })

  it('forwards console output, including circular values', async () => {
    runtime = new IvmRuntime()
    const logs: [string, unknown[]][] = []
    await runtime.runCode(
      'const a = {n: 1}; a.self = a; console.log("hi", a); console.error(1n)',
      {},
      {
        onLog: (level, args) => logs.push([level, args]),
      },
    )
    expect(logs).toEqual([
      ['log', ['hi', { n: 1, self: '[Circular]' }]],
      ['error', ['1']],
    ])
  })

  it('isolates evaluations from each other', async () => {
    runtime = new IvmRuntime()
    await runtime.runCode('globalThis.leak = 42; _.leaked = true', {})
    expect(await runtime.evalExpression('typeof leak', {})).toBe('undefined')
    expect(await runtime.evalExpression('_.leaked', {})).toBe(undefined)
  })

  it('maps user errors and syntax errors', async () => {
    runtime = new IvmRuntime()
    const err = await expectSandboxError(runtime.runCode('throw new Error("boom")', {}), 'runtime')
    expect(err.message).toContain('boom')
    await expectSandboxError(runtime.runCode('return (', {}), 'syntax')
  })
})

describe('IvmRuntime: security boundary', () => {
  it('exposes no Node APIs', async () => {
    runtime = new IvmRuntime()
    for (const name of ['process', 'require', 'module', 'Buffer', 'setImmediate', '__dirname']) {
      expect(await runtime.evalExpression(`typeof ${name}`, {})).toBe('undefined')
    }
    expect(await runtime.evalExpression('typeof globalThis.process', {})).toBe('undefined')
    // Escaping via the Function constructor still lands in the isolate's own realm.
    expect(await runtime.evalExpression('typeof (function(){ return this })().process', {})).toBe('undefined')
    expect(await runtime.evalExpression("typeof Function('return this')().process", {})).toBe('undefined')
  })
})

describe('IvmRuntime: limits', () => {
  it('kills a synchronous infinite loop at the timeout', async () => {
    runtime = new IvmRuntime()
    const started = Date.now()
    await expectSandboxError(runtime.runCode('while (true) {}', {}, { timeoutMs: 200 }), 'timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
    // The runtime remains usable afterwards.
    expect(await runtime.evalExpression('1 + 1', {})).toBe(2)
  })

  it('kills an infinite loop inside an async continuation', async () => {
    runtime = new IvmRuntime()
    const started = Date.now()
    await expectSandboxError(
      runtime.runCode('await null; while (true) {}', {}, { timeoutMs: 200 }),
      'timeout',
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await runtime.evalExpression('2 + 2', {})).toBe(4)
  })

  it('kills a memory bomb and recovers with a fresh isolate', async () => {
    runtime = new IvmRuntime({ memoryLimitMb: 32 })
    await expectSandboxError(
      runtime.runCode(
        'const a = []; while (true) a.push(new Array(1e5).fill("x".repeat(10)))',
        {},
        { timeoutMs: 15_000 },
      ),
      'memory',
    )
    expect(await runtime.evalExpression('"still alive"', {})).toBe('still alive')
  })
})

describe('IvmRuntime: host calls', () => {
  const fetchEcho: RunOptions['fetch'] = async (req) => ({
    status: 201,
    statusText: 'Created',
    url: req.url,
    redirected: false,
    headers: [
      ['content-type', 'application/json'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ],
    body: JSON.stringify(req),
  })

  it('calls host functions with JSON arguments, concurrently', async () => {
    runtime = new IvmRuntime()
    const calls: unknown[][] = []
    const result = await runtime.runCode(
      'const one = await lookup({ id: 1 }, "x")\nreturn [one, await Promise.all([lookup(2), lookup(3)])]',
      {},
      {
        functions: {
          lookup: async (args) => {
            calls.push(args)
            await new Promise((r) => setTimeout(r, 10))
            return { got: args[0], at: new Date(0) }
          },
        },
      },
    )
    expect(result).toEqual([
      { got: { id: 1 }, at: '1970-01-01T00:00:00.000Z' },
      [
        { got: 2, at: '1970-01-01T00:00:00.000Z' },
        { got: 3, at: '1970-01-01T00:00:00.000Z' },
      ],
    ])
    expect(calls).toEqual([[{ id: 1 }, 'x'], [2], [3]])
  })

  it('rejects inside the sandbox with the host error, which code can catch', async () => {
    runtime = new IvmRuntime()
    const functions = {
      fail: async () => {
        throw new TypeError('no such customer')
      },
    }
    expect(
      await runtime.runCode(
        'try { await fail() } catch (e) { return e.name + ": " + e.message }',
        {},
        { functions },
      ),
    ).toBe('TypeError: no such customer')
    const err = await expectSandboxError(runtime.runCode('return await fail()', {}, { functions }), 'runtime')
    expect(err.message).toContain('no such customer')
  })

  it('only binds the functions given, and keeps them out of other evaluations', async () => {
    runtime = new IvmRuntime()
    const functions = { lookup: async () => 1 }
    expect(await runtime.runCode('return typeof lookup', {}, { functions })).toBe('function')
    expect(await runtime.runCode('return typeof lookup', {})).toBe('undefined')
    // Calling the bridge directly reaches only the functions given.
    const reply = await runtime.runCode(
      'return JSON.parse(await __owHost.apply(undefined, ["function", "other", "[]"], { result: { promise: true } }))',
      {},
      { functions },
    )
    expect(reply).toEqual({ ok: false, name: 'Error', message: "other isn't available here" })
  })

  it('fetches through the host and wraps the response', async () => {
    runtime = new IvmRuntime()
    const result = await runtime.runCode(
      [
        'const res = await fetch("https://api.test/x", { method: "post", headers: { "X-Id": 7 }, body: JSON.stringify({ a: 1 }) })',
        'const echo = await res.json()',
        'let again; try { await res.text() } catch (e) { again = e.message }',
        'return { ok: res.ok, status: res.status, url: res.url, type: res.headers.get("Content-Type"),',
        '  cookies: res.headers.get("set-cookie"), has: res.headers.has("x-nope"), echo, again }',
      ].join('\n'),
      {},
      { fetch: fetchEcho },
    )
    expect(result).toEqual({
      ok: true,
      status: 201,
      url: 'https://api.test/x',
      type: 'application/json',
      cookies: 'a=1, b=2',
      has: false,
      echo: { url: 'https://api.test/x', method: 'POST', headers: [['X-Id', '7']], body: '{"a":1}' },
      again: 'The body has already been read',
    })
  })

  it("accepts header pairs and a response's headers, and refuses non-string bodies", async () => {
    runtime = new IvmRuntime()
    const sent = await runtime.runCode(
      [
        'const first = await fetch("https://a.test", { headers: [["A", "1"]] })',
        'const second = await fetch("https://b.test", { headers: first.headers })',
        'return (await second.json()).headers',
      ].join('\n'),
      {},
      { fetch: fetchEcho },
    )
    expect(sent).toEqual([
      ['content-type', 'application/json'],
      ['set-cookie', 'a=1, b=2'],
    ])
    const err = await expectSandboxError(
      runtime.runCode(
        'return await fetch("https://a.test", { method: "POST", body: { a: 1 } })',
        {},
        { fetch: fetchEcho },
      ),
      'runtime',
    )
    expect(err.message).toContain('use JSON.stringify')
  })

  it("rejects fetch when the host doesn't provide it", async () => {
    runtime = new IvmRuntime()
    const err = await expectSandboxError(
      runtime.runCode('return await fetch("https://a.test")', {}),
      'runtime',
    )
    expect(err.message).toContain("fetch isn't available here")
  })

  it('times out a host call that takes too long', async () => {
    runtime = new IvmRuntime()
    const started = Date.now()
    await expectSandboxError(
      runtime.runCode(
        'return await slow()',
        {},
        {
          timeoutMs: 200,
          functions: { slow: () => new Promise((r) => setTimeout(r, 5_000)) },
        },
      ),
      'timeout',
    )
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
