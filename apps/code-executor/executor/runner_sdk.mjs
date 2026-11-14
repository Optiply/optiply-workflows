// Runs inside the SDK jail (M37, docs/architecture.md §2.41): one call to a JavaScript SDK in Node, then exits.
//
// Input is one JSON document on stdin, as runner_sdk.py's ("resultFd"; "mode" call | code | describe; "setup";
// "context" {token, baseUrl, options, secrets}; "method", "args", "limit"; "code", "params"). The resource's setup
// code is an ES module whose default export makes the client from {token, baseUrl, options, secrets}; it imports the
// SDK by name (`import { Client } from 'acme-sdk'`): the env's node_modules (OW_ENV) is linked next to it. A snippet
// is an async function body with `client`, `params` and `token`. Prints are the run's log (runner.py's frames on fd
// 1); the outcome goes to its own fd. The forwarder on 127.0.0.1:3128 hands connections to the proxy's socket.

import fs from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const PROXY_SOCKET = '/run/ow/proxy.sock'
const WORK = '/tmp/ow'
const MAX_DEPTH = 40

/** Writes go to fd 1 as tagged frames, at once (so the order with stderr's is kept). */
function frameWriter(tag) {
  return (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const clean = text
      .replaceAll(String.fromCharCode(0x1e), '\ufffd')
      .replaceAll(String.fromCharCode(0x1f), '\ufffd')
    fs.writeSync(
      1,
      Buffer.concat([Buffer.from([0x1e]), Buffer.from(tag), Buffer.from(clean, 'utf8'), Buffer.from([0x1f])]),
    )
    const cb = typeof encoding === 'function' ? encoding : callback
    if (cb) cb()
    return true
  }
}
process.stdout.write = frameWriter('L')
process.stderr.write = frameWriter('E')

function startForwarder() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(PROXY_SOCKET)
      client.pipe(upstream)
      upstream.pipe(client)
      const end = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', end)
      upstream.on('error', end)
    })
    server.on('error', reject)
    server.listen(3128, '127.0.0.1', () => {
      server.unref()
      resolve()
    })
  })
}

function statusOf(err) {
  for (const holder of [err, err?.response]) {
    if (!holder || typeof holder !== 'object') continue
    for (const name of ['status', 'statusCode', 'status_code', 'httpStatus']) {
      const v = holder[name]
      if (Number.isInteger(v) && v >= 100 && v <= 599) return v
    }
  }
  return null
}

function lineIn(err, file) {
  const m = new RegExp(`${file.replace(/\./g, '\\.')}:(\\d+)`).exec(String(err?.stack ?? ''))
  return m ? Number(m[1]) : null
}

function failure(kind, err, file, offset = 0) {
  const line = lineIn(err, file)
  const status = statusOf(err)
  return {
    ok: false,
    error: {
      kind,
      message: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
      type: err?.constructor?.name ?? typeof err,
      line: line === null ? null : Math.max(1, line - offset),
      ...(status !== null && { status }),
    },
  }
}

/** An SDK's answer as JSON: toJSON, dates, bytes, maps and sets, BigInts, class instances' own fields; cycles cut. */
function toJson(value, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return '…'
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'bigint') return value.toString()
  if (t === 'function' || t === 'symbol') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64')
  if (seen.has(value)) return '[Circular]'
  const next = new Set(seen).add(value)
  if (typeof value.toJSON === 'function') return toJson(value.toJSON(), depth + 1, next)
  if (Array.isArray(value)) return value.map((v) => toJson(v, depth + 1, next) ?? null)
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [String(k), toJson(v, depth + 1, next)]))
  if (value instanceof Set) return [...value].map((v) => toJson(v, depth + 1, next))
  if (value instanceof Error) return { name: value.name, message: value.message }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('_')) continue
    const j = toJson(v, depth + 1, next)
    if (j !== undefined) out[k] = j
  }
  return out
}

/** Pages: an async iterable or an iterator (not an array or string) as at most `limit` items. */
async function collect(value, limit) {
  if (value && typeof value[Symbol.asyncIterator] === 'function' && !Array.isArray(value)) {
    const out = []
    for await (const item of value) {
      out.push(item)
      if (out.length >= limit) break
    }
    return out
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof value.next === 'function' &&
    typeof value[Symbol.iterator] === 'function'
  ) {
    const out = []
    for (const item of value) {
      out.push(item)
      if (out.length >= limit) break
    }
    return out
  }
  return value
}

class MethodError extends Error {}

function resolve(client, path) {
  let parent = null
  let target = client
  for (const part of String(path).split('.')) {
    if (!/^[A-Za-z$][\w$]*$/.test(part))
      throw new MethodError(`"${path}" isn't a method path (names and dots)`)
    if (target === null || target === undefined || !(part in Object(target))) {
      throw new MethodError(`The client has no "${path}" ("${part}" is missing): see Describe`)
    }
    parent = target
    target = target[part]
  }
  return { parent, target }
}

/** Parameter names from a function's source (best effort). */
function paramsOf(fn) {
  const src = Function.prototype.toString.call(fn)
  const m = /^[^(]*\(([^)]*)\)/.exec(src)
  return m ? `(${m[1].replace(/\s+/g, ' ').trim()})` : `(${fn.length} arguments)`
}

function describe(client, depth = 2) {
  const members = []
  const walk = (obj, prefix, level, seen) => {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || seen.has(obj)) return
    seen = new Set(seen).add(obj)
    const names = new Set()
    for (let o = obj; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o))
        if (n !== 'constructor' && !n.startsWith('_') && !n.startsWith('#')) names.add(n)
    }
    for (const name of [...names].sort()) {
      let value
      try {
        value = obj[name]
      } catch {
        continue
      }
      const path = `${prefix}${name}`
      if (typeof value === 'function') members.push({ path, kind: 'method', signature: paramsOf(value) })
      else if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
        members.push({ path, kind: 'value', type: value === null ? 'null' : typeof value })
      else if (level < depth && typeof value === 'object' && !Array.isArray(value))
        walk(value, `${path}.`, level + 1, seen)
      if (members.length >= 500) return
    }
  }
  walk(client, '', 0, new Set())
  return { type: client?.constructor?.name ?? typeof client, members }
}

async function run(request) {
  fs.mkdirSync(WORK, { recursive: true })
  const env = process.env.OW_ENV
  if (env) fs.symlinkSync(`${env}/node_modules`, `${WORK}/node_modules`)
  const context = request.context ?? {}
  let client
  try {
    fs.writeFileSync(`${WORK}/setup.mjs`, request.setup ?? '')
    const mod = await import(pathToFileURL(`${WORK}/setup.mjs`).href)
    const factory = mod.default
    if (typeof factory !== 'function')
      throw new MethodError('The setup code must export default a function making the client')
    client = await factory({
      token: context.token ?? null,
      baseUrl: context.baseUrl ?? null,
      options: context.options ?? {},
      secrets: context.secrets ?? {},
    })
  } catch (err) {
    if (err instanceof MethodError) return { ok: false, error: { kind: 'setup', message: err.message } }
    return failure('setup', err, 'setup.mjs')
  }
  const limit = Math.max(1, Math.min(Number(request.limit) || 1000, 100_000))
  let value
  try {
    if (request.mode === 'describe') return { ok: true, result: describe(client) }
    if (request.mode === 'call') {
      const { parent, target } = resolve(client, request.method ?? '')
      const args = request.args
      value =
        typeof target !== 'function'
          ? target
          : Array.isArray(args)
            ? target.apply(parent, args)
            : args === null || args === undefined
              ? target.call(parent)
              : target.call(parent, args)
    } else {
      fs.writeFileSync(
        `${WORK}/code.mjs`,
        `export default async function ({ client, params, token }) {\n${request.code ?? ''}\n}\n`,
      )
      let mod
      try {
        mod = await import(pathToFileURL(`${WORK}/code.mjs`).href)
      } catch (err) {
        // Loading the snippet failed: its syntax (Node doesn't always put the line in the stack).
        if (err instanceof SyntaxError) return failure('syntax', err, 'code.mjs', 1)
        throw err
      }
      value = mod.default({ client, params: request.params ?? {}, token: context.token ?? null })
    }
    value = await collect(await value, limit)
  } catch (err) {
    if (err instanceof MethodError) return { ok: false, error: { kind: 'sdk_method', message: err.message } }
    return failure('sdk', err, 'code.mjs', 1)
  }
  try {
    return { ok: true, result: toJson(value) ?? null }
  } catch (err) {
    return { ok: false, error: { kind: 'serialization', message: String(err?.message ?? err) } }
  }
}

const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const resultFd = Number(request.resultFd ?? 3)
let outcome
try {
  await startForwarder()
  outcome = await run(request)
} catch (err) {
  outcome = failure('internal', err, 'runner_sdk.mjs')
}
fs.writeSync(resultFd, JSON.stringify(outcome))
process.exit(0)
