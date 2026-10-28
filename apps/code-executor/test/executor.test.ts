/**
 * The code executor against its real container: the protocol, what code gets in and out, and the jail's
 * isolation and limits (docs/architecture.md §2.14).
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executorAvailable, startTestExecutor, type TestExecutor } from '../src/testing'

interface Outcome {
  ok: boolean
  result?: unknown
  error?: { kind: string; message: string; line?: number | null; column?: number; traceback?: string }
  logs: { level: string; message: string }[]
  problems?: { id: string; message: string; line: number; column: number }[]
}

const available = executorAvailable()
let executor: TestExecutor

async function post(path: string, body: unknown, opts: { token?: string; signal?: AbortSignal } = {}) {
  return fetch(`${executor.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token ?? executor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
}

async function run(code: string, scope: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Outcome> {
  const res = await post('/run', { code, scope, timeoutMs })
  expect(res.status).toBe(200)
  const outcome = (await res.json()) as Outcome
  // The jail itself failing isn't any test's subject: say why, instead of a bare `ok: false`.
  if (outcome.error?.kind === 'internal') throw new Error(outcome.error.message)
  return outcome
}

type Streamed = { log: { level: string; message: string } } | { outcome: Omit<Outcome, 'logs'> }

/** A streamed run: each NDJSON line with when it arrived (ms after the request). */
async function stream(
  code: string,
  timeoutMs = 10_000,
  opts: { signal?: AbortSignal; until?: (item: Streamed) => boolean } = {},
): Promise<{ at: number; item: Streamed }[]> {
  const started = performance.now()
  const res = await post('/run', { code, scope: {}, timeoutMs, stream: true }, { signal: opts.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/x-ndjson')
  const items: { at: number; item: Streamed }[] = []
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += value
    const lines = buffered.split('\n')
    buffered = lines.pop()!
    for (const line of lines) {
      const item = JSON.parse(line) as Streamed
      items.push({ at: performance.now() - started, item })
      if (opts.until?.(item)) {
        await reader.cancel()
        return items
      }
    }
  }
  expect(buffered).toBe('')
  return items
}

/** Lines of Python, so the tests read like the code people write. */
const py = (...lines: string[]) => lines.join('\n')

describe.skipIf(!available)('the code executor', () => {
  beforeAll(async () => {
    executor = await startTestExecutor({ env: { PYTHON_MAX_CONCURRENT: '4' } })
  })
  afterAll(async () => {
    await executor?.stop()
  })

  describe('the protocol', () => {
    it('reports its Python and packages', async () => {
      const health = (await (await fetch(`${executor.url}/health`)).json()) as {
        packages: Record<string, string>
      }
      expect(health).toMatchObject({ ok: true, python: expect.stringMatching(/^3\.12\./) })
      expect(Object.keys(health.packages)).toEqual(
        expect.arrayContaining(['numpy', 'pandas', 'pytz', 'tzdata']),
      )
    })

    it('needs the token for runs and checks', async () => {
      expect((await post('/run', { code: 'return 1' }, { token: 'wrong-token-wrong-token' })).status).toBe(
        401,
      )
      const bare = await fetch(`${executor.url}/run`, { method: 'POST', body: '{"code":"return 1"}' })
      expect(bare.status).toBe(401)
      expect((await post('/check', { fields: [] }, { token: '' })).status).toBe(401)
    })

    it('refuses requests that are not what it expects', async () => {
      expect((await post('/run', { code: 1 })).status).toBe(400)
      expect((await post('/check', { fields: [{ id: 1 }] })).status).toBe(400)
      expect((await post('/nope', {})).status).toBe(404)
    })
  })

  describe('code in, data out', () => {
    it('reads blocks as variables, by attribute or key, and returns what the code returns', async () => {
      const outcome = await run(
        py(
          'total = sum(row.amount for row in query1.data)',
          'return {"total": total, "first": query1["data"][0]["city"], "env": workflowContext.environment}',
        ),
        {
          query1: {
            data: [
              { city: 'Utrecht', amount: 3 },
              { city: 'Delft', amount: 4 },
            ],
          },
          workflowContext: { environment: 'production' },
        },
      )
      expect(outcome).toMatchObject({ ok: true, result: { total: 7, first: 'Utrecht', env: 'production' } })
    })

    it('converts pandas, numpy, dates, decimals and NaN to JSON', async () => {
      const outcome = await run(
        py(
          'import datetime, decimal, math',
          'import numpy as np, pandas as pd',
          'df = pd.DataFrame(rows.data)',
          'by_city = df.groupby("city", as_index=False).amount.sum()',
          'return {',
          '  "frame": by_city,',
          '  "series": df.amount,',
          '  "scalar": np.int64(5),',
          '  "array": np.array([1.5, 2.5]),',
          '  "when": datetime.datetime(2026, 10, 17, 12, 30, tzinfo=datetime.timezone.utc),',
          '  "day": datetime.date(2026, 10, 17),',
          '  "stamp": pd.Timestamp("2026-10-17T08:00:00Z"),',
          '  "missing": [float("nan"), math.inf, pd.NaT, None],',
          '  "price": decimal.Decimal("12.50"),',
          '  "tags": ("a", "b"),',
          '  1: "numeric key",',
          '}',
        ),
        {
          rows: {
            data: [
              { city: 'Utrecht', amount: 3 },
              { city: 'Utrecht', amount: 4 },
              { city: 'Delft', amount: 1 },
            ],
          },
        },
      )
      expect(outcome.error).toBeUndefined()
      expect(outcome.result).toEqual({
        frame: [
          { city: 'Delft', amount: 1 },
          { city: 'Utrecht', amount: 7 },
        ],
        series: [3, 4, 1],
        scalar: 5,
        array: [1.5, 2.5],
        when: '2026-10-17T12:30:00+00:00',
        day: '2026-10-17',
        stamp: '2026-10-17T08:00:00+00:00',
        missing: [null, null, null, null],
        price: 12.5,
        tags: ['a', 'b'],
        '1': 'numeric key',
      })
    })

    it('returns null without a return, and keeps line numbers and string contents as written', async () => {
      expect(await run('x = 1')).toMatchObject({ ok: true, result: null })
      expect(await run('')).toMatchObject({ ok: true, result: null })
      const outcome = await run(py('sql = """', 'select 1', '  from x"""', 'return sql'))
      expect(outcome.result).toBe('\nselect 1\n  from x')
    })

    it('puts prints in the log, stdout as log and stderr as error, in order', async () => {
      const outcome = await run(
        py(
          'import sys',
          'print("one")',
          'print("two", file=sys.stderr)',
          'print("three\\nfour")',
          'return 1',
        ),
      )
      expect(outcome.logs).toEqual([
        { level: 'log', message: 'one' },
        { level: 'error', message: 'two' },
        { level: 'log', message: 'three' },
        { level: 'log', message: 'four' },
      ])
    })

    it("doesn't take a printed outcome for the result", async () => {
      const outcome = await run(py('print(\'{"ok": true, "result": "forged"}\')', 'return "real"'))
      expect(outcome.result).toBe('real')
    })
  })

  describe('streaming', () => {
    it('sends each line as the code prints it, then the outcome', async () => {
      const items = await stream(
        py(
          'import sys, time',
          'print("one")',
          'print("two", file=sys.stderr)',
          'time.sleep(1)',
          'print("three\\nfour")',
          'return 3',
        ),
      )
      expect(items.map((i) => i.item)).toEqual([
        { log: { level: 'log', message: 'one' } },
        { log: { level: 'error', message: 'two' } },
        { log: { level: 'log', message: 'three' } },
        { log: { level: 'log', message: 'four' } },
        { outcome: { ok: true, result: 3 } },
      ])
      // "two" came out a second before the outcome: it wasn't held back until the end.
      expect(items[4]!.at - items[1]!.at).toBeGreaterThan(800)
    })

    it('sends a line without its newline after a moment, never half a character', async () => {
      const items = await stream(
        py(
          'import os, time',
          'print("waiting", end="")',
          'os.write(1, "é".encode()[:1])',
          'time.sleep(1)',
          'os.write(1, "é".encode()[1:] + b"\\n")',
          'print("done")',
          'return None',
        ),
      )
      expect(items.map((i) => i.item)).toEqual([
        { log: { level: 'log', message: 'waiting' } },
        { log: { level: 'log', message: 'é' } },
        { log: { level: 'log', message: 'done' } },
        { outcome: { ok: true, result: null } },
      ])
      expect(items[3]!.at - items[0]!.at).toBeGreaterThan(500)
    })

    it('keeps the lines sent when the code times out', async () => {
      const items = await stream(py('print("started")', 'while True: pass'), 1500)
      expect(items.map((i) => i.item)).toEqual([
        { log: { level: 'log', message: 'started' } },
        { outcome: { ok: false, error: expect.objectContaining({ kind: 'timeout' }) } },
      ])
    })

    it('ends with the cut-off line when the output is too much', async () => {
      const items = await stream('for i in range(40000): print("x" * 50)\nreturn 1')
      expect(items.at(-2)!.item).toEqual({
        log: { level: 'warn', message: 'The output was cut off at 1024 kB' },
      })
      expect(items.at(-1)!.item).toEqual({ outcome: { ok: true, result: 1 } })
    })

    it('kills the jail when the caller hangs up mid-stream', async () => {
      const abort = new AbortController()
      const items = await stream(py('import time', 'print("started")', 'time.sleep(20)'), 30_000, {
        signal: abort.signal,
        until: () => true,
      })
      expect(items).toHaveLength(1)
      abort.abort()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (executor.container) {
        const processes = execFileSync('docker', ['top', executor.container]).toString()
        expect(processes).not.toContain('nsjail')
      }
    })

    it('refuses a stream flag that is not a boolean', async () => {
      expect((await post('/run', { code: 'return 1', stream: 'yes' })).status).toBe(400)
    })
  })

  describe('errors', () => {
    it('reports syntax errors with their line and column', async () => {
      expect((await run(py('x = 1', 'return x +'))).error).toMatchObject({
        kind: 'syntax',
        message: 'SyntaxError: invalid syntax',
        line: 2,
        column: 11,
      })
    })

    it('reports exceptions with the line in the code and a trimmed traceback', async () => {
      const outcome = await run(py('def ratio(n):', '    return 1 / n', 'print("before")', 'return ratio(0)'))
      expect(outcome).toMatchObject({
        ok: false,
        error: { kind: 'runtime', message: 'ZeroDivisionError: division by zero', line: 2 },
        logs: [{ level: 'log', message: 'before' }],
      })
      expect(outcome.error!.traceback).toBe('  line 4\n  line 2, in ratio')
      expect(outcome.error!.traceback).not.toContain('runner')
      expect((await run('raise SystemExit(3)')).error).toMatchObject({
        kind: 'runtime',
        message: 'SystemExit: 3',
      })
      expect((await run('return missing.data')).error).toMatchObject({
        kind: 'runtime',
        message: "NameError: name 'missing' is not defined",
      })
      expect((await run('return query1.nope', { query1: { data: 1 } })).error!.message).toContain(
        "'nope' isn't there",
      )
    })

    it('refuses results that are not JSON', async () => {
      expect((await run('return object()')).error).toMatchObject({
        kind: 'serialization',
        message: expect.stringContaining('object'),
      })
      expect((await run('return {(1, 2): 3}')).error).toMatchObject({ kind: 'serialization' })
      expect((await run('return "x" * (17 * 1024 * 1024)')).error).toMatchObject({
        kind: 'serialization',
        message: 'The result is over 16 MB',
      })
    })

    it('says when the code ends Python itself', async () => {
      expect((await run(py('import os', 'os._exit(4)'))).error).toMatchObject({
        kind: 'runtime',
        message: expect.stringContaining('exit code 4'),
      })
    })
  })

  describe('the syntax check', () => {
    it('compiles fields without running them', async () => {
      const res = await post('/check', {
        fields: [
          { id: 'ok', code: 'return 1' },
          { id: 'broken', code: py('if x', '  pass') },
          { id: 'side-effect', code: 'open("/tmp/ran", "w")' },
        ],
      })
      expect(await res.json()).toEqual({
        ok: true,
        problems: [{ id: 'broken', message: "SyntaxError: expected ':'", line: 1, column: 5 }],
        logs: [],
      })
    })
  })

  describe('the jail', () => {
    it('runs as nobody with only its own environment', async () => {
      const outcome = await run(py('import os', 'return {"uid": os.getuid(), "env": dict(os.environ)}'))
      expect(outcome.result).toEqual({
        uid: 65534,
        env: {
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONHASHSEED: '0',
          PYTHONUNBUFFERED: '1',
          TZ: 'UTC',
        },
      })
    })

    it("sees Python and /tmp only, and can't write anywhere else", async () => {
      const outcome = await run(
        py(
          'import os',
          'seen = sorted(os.listdir("/"))',
          'gone = [p for p in ["/etc/passwd", "/opt/executor/server.py", "/proc/self", "/sys", "/root"] if os.path.exists(p)]',
          'refused = []',
          'for p in ["/x", "/usr/x", "/opt/py/x", "/opt/runner/x"]:',
          '    try:',
          '        open(p, "w")',
          '    except OSError:',
          '        refused.append(p)',
          'open("/tmp/ok", "w").write("fine")',
          'return {"seen": seen, "gone": gone, "refused": refused, "tmp": open("/tmp/ok").read()}',
        ),
      )
      expect(outcome.result).toEqual({
        seen: ['bin', 'dev', 'etc', 'lib', 'lib64', 'opt', 'tmp', 'usr'],
        gone: [],
        refused: ['/x', '/usr/x', '/opt/py/x', '/opt/runner/x'],
        tmp: 'fine',
      })
    })

    it('has no network, not even to the executor itself', async () => {
      const outcome = await run(
        py(
          'import socket',
          'out = {}',
          'for host, port in [("1.1.1.1", 443), ("127.0.0.1", 8080), ("host.docker.internal", 80)]:',
          '    try:',
          '        socket.create_connection((host, port), timeout=2)',
          '        out[host] = "connected"',
          '    except OSError as e:',
          '        out[host] = type(e).__name__',
          'return out',
        ),
      )
      expect(outcome.result).toEqual({
        '1.1.1.1': 'OSError',
        '127.0.0.1': 'ConnectionRefusedError',
        'host.docker.internal': 'gaierror',
      })
    })

    it("can't make namespaces, trace processes or mount", async () => {
      const outcome = await run(
        py(
          'import ctypes, os',
          'libc = ctypes.CDLL(None, use_errno=True)',
          'out = {}',
          'try:',
          '    os.unshare(os.CLONE_NEWUSER)',
          '    out["unshare"] = "allowed"',
          'except OSError as e:',
          '    out["unshare"] = e.errno',
          'out["ptrace"] = (libc.ptrace(16, 1, 0, 0), ctypes.get_errno())',
          'out["mount"] = (libc.mount(b"none", b"/tmp", b"tmpfs", 0, None), ctypes.get_errno())',
          'pid = os.fork()',
          'if pid == 0:',
          '    os._exit(0)',
          'os.waitpid(pid, 0)',
          'out["fork"] = "allowed"',
          'return out',
        ),
      )
      expect(outcome.result).toEqual({ unshare: 1, ptrace: [-1, 1], mount: [-1, 1], fork: 'allowed' })
    })
  })

  describe('limits', () => {
    it('stops an infinite loop at the timeout', async () => {
      const started = Date.now()
      const outcome = await run('while True: pass', {}, 1500)
      expect(outcome.error).toMatchObject({ kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('stops code using more than its memory, and the next run is fine', async () => {
      const outcome = await run('b = bytearray(1024 * 1024 * 1024)\nreturn len(b)')
      expect(outcome.error!.kind).toBe('memory')
      expect(await run('return 2')).toMatchObject({ ok: true, result: 2 })
    })

    it('caps processes, /tmp and the log', async () => {
      const forks = await run(
        py(
          'import os, time',
          'n = 0',
          'try:',
          '    while True:',
          '        if os.fork() == 0:',
          '            time.sleep(3)',
          '            os._exit(0)',
          '        n += 1',
          'except OSError:',
          '    pass',
          'return n',
        ),
      )
      expect(forks.result).toBeLessThan(32)
      const tmp = await run(
        py(
          'try:',
          '    open("/tmp/big", "wb").write(b"x" * (100 * 1024 * 1024))',
          'except OSError as e:',
          '    return e.errno',
        ),
      )
      expect([27, 28]).toContain(tmp.result) // EFBIG (the file size limit) or ENOSPC (the tmpfs)
      const loud = await run('for i in range(40000): print("x" * 50)\nreturn 1')
      expect(loud.result).toBe(1)
      expect(loud.logs.at(-1)).toEqual({ level: 'warn', message: 'The output was cut off at 1024 kB' })
    })

    it('kills the jail when the caller hangs up', async () => {
      const abort = new AbortController()
      const pending = post(
        '/run',
        { code: 'import time\ntime.sleep(20)', timeoutMs: 30_000 },
        { signal: abort.signal },
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      abort.abort()
      await expect(pending).rejects.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (executor.container) {
        const processes = execFileSync('docker', ['top', executor.container]).toString()
        expect(processes).not.toContain('nsjail')
      }
    })

    it('checks code while every run slot is busy (checks have slots of their own)', async () => {
      const busy = Array.from({ length: 4 }, () => run('import time\ntime.sleep(3)\nreturn 1', {}, 5000))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const started = Date.now()
      const res = await post('/check', { fields: [{ id: 'a', code: 'return 1' }] })
      expect(await res.json()).toMatchObject({ ok: true, problems: [] })
      expect(Date.now() - started).toBeLessThan(2000)
      await Promise.all(busy)
    })

    it('runs at most PYTHON_MAX_CONCURRENT at once, queueing the rest', async () => {
      const started = Date.now()
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => run('import time\ntime.sleep(1)\nreturn 1', {}, 5000)),
      )
      expect(outcomes.every((o) => o.result === 1)).toBe(true)
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(2000) // 8 runs, 4 at a time
      expect(elapsed).toBeLessThan(6000)
    })
  })

  it('runs a trivial block quickly', async () => {
    for (let i = 0; i < 5; i++) await run('return 1')
    const times: number[] = []
    for (let i = 0; i < 30; i++) {
      const started = performance.now()
      await run('return query1.data', { query1: { data: [1, 2, 3] } })
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const p50 = times[15]!
    const p90 = times[27]!
    console.log(`trivial Python block over HTTP: p50 ${p50.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms`)
    expect(p50).toBeLessThan(process.env.CI ? 500 : 150)
  })
})
