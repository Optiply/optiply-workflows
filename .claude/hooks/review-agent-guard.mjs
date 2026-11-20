#!/usr/bin/env node
// PreToolUse guard for the report-only review agents (.claude/agents/security-auditor.md and bug-hunter.md).
// Wired in each agent's frontmatter, so it runs only while one of those agents runs: the main session is unaffected.
//
// It splits a Bash command into the commands it actually runs (pipes, `;`, `&&`, `$(…)`, `bash -c '…'`, `xargs …`)
// and blocks the ones that change things outside the agent's scratch space: git history, GitHub, Google Cloud, Docker,
// databases, HTTP writes, installs, file edits in the repo. It also blocks reading secrets (.env files, keys, the
// Retool exports). Search patterns are not commands, so `grep -rn "gcloud" deploy/` is fine.
//
// A guard against mistakes and against instructions hidden in the code under review, not a sandbox: code run by the
// checks themselves (tests, `node -e`) is not inspected. Exit 2 blocks the call; stderr is the reason the agent sees.
//
// Test: node --test .claude/hooks/review-agent-guard.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------------------------------------------------
// A small shell tokenizer: words with quotes removed, and the operators between commands.

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')']

/** Splits `text` into words and operators; returns { words: [{ text, quoted }], subshells: [string] }. */
function tokenize(text) {
  const tokens = []
  const subshells = []
  let word = ''
  let quoted = false
  let inWord = false
  const push = () => {
    if (inWord) tokens.push({ text: word, quoted })
    word = ''
    quoted = false
    inWord = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      inWord = true
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
      quoted = inWord = true
      continue
    }
    if (c === '"') {
      let j = i + 1
      let inner = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          inner += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const [sub, end] = balanced(text, j + 2)
          subshells.push(sub)
          inner += `$(${sub})`
          j = end + 1
          continue
        }
        if (text[j] === '`') {
          const end = text.indexOf('`', j + 1)
          subshells.push(text.slice(j + 1, end === -1 ? text.length : end))
          j = end === -1 ? text.length : end + 1
          continue
        }
        inner += text[j++]
      }
      word += inner
      i = j
      quoted = inWord = true
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      const [sub, end] = balanced(text, i + 2)
      subshells.push(sub)
      word += `$(${sub})`
      inWord = true
      i = end
      continue
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      subshells.push(text.slice(i + 1, end === -1 ? text.length : end))
      i = end === -1 ? text.length : end
      inWord = true
      continue
    }
    if (c === ' ' || c === '\t') {
      push()
      continue
    }
    // Redirections: [n|&](> >> >| < << <<<)[&n], as a { redir } token; the next word is its target.
    if (c === '>' || c === '<' || (c === '&' && text[i + 1] === '>')) {
      const prefix = inWord && !quoted && /^\d$/.test(word) ? word : ''
      if (prefix) word = ''
      else push()
      inWord = false
      let op = c === '&' ? '&>' : c
      i += op.length
      while (i < text.length && /[<>|]/.test(text[i]) && op.length < 3) op += text[i++]
      let dup = false
      if (text[i] === '&') {
        dup = true
        i++
        while (i < text.length && /[\d-]/.test(text[i])) i++
      }
      tokens.push({ redir: prefix + op, dup })
      i--
      continue
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i))
    if (op) {
      push()
      tokens.push({ op })
      i += op.length - 1
      continue
    }
    word += c
    inWord = true
  }
  push()
  return { tokens, subshells }
}

/** The text up to the `)` that closes a `$(` opened just before `start`, and that `)`'s index. */
function balanced(text, start) {
  let depth = 1
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return [text.slice(start, i), i]
  }
  return [text.slice(start), text.length]
}

/** The simple commands in `text`: arrays of words (redirections kept as words, e.g. `>`, `file`). */
function commands(text) {
  const { tokens, subshells } = tokenize(text)
  const result = []
  let current = []
  for (const t of tokens) {
    if (t.op) {
      if (current.length) result.push(current)
      current = []
    } else current.push(t)
  }
  if (current.length) result.push(current)
  for (const sub of subshells) result.push(...commands(sub))
  return result
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules.

/** Paths an agent may write to or delete: its scratch space only. */
const SCRATCH =
  /^(\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\$TMPDIR|\$\{TMPDIR\}|\/dev\/(null|stdout|stderr)$)/

const SECRET_PATH = [
  [/(^|\/)\.env(\.(?!example$)[\w.-]+)?$/, 'reading .env files (they hold secrets)'],
  [/retool_exports/, 'the Retool exports (sensitive)'],
  [/(^|\/)\.ssh(\/|$)|(^|\/)id_(rsa|ed25519|ecdsa)(\.|$)/, 'SSH keys'],
  [
    /\.config\/gcloud|application_default_credentials|(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.docker\/config\.json$/,
    'credential files',
  ],
]

const BLOCKED_HEADS = new Map([
  ...['gcloud', 'gsutil', 'bq', 'aws', 'terraform', 'kubectl', 'helm', 'az'].map((h) => [
    h,
    'cloud and infrastructure CLIs',
  ]),
  ...['ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat'].map((h) => [h, 'remote shells and copies']),
  ...[
    'psql',
    'pg_dump',
    'pg_restore',
    'mysql',
    'mysqldump',
    'sqlcmd',
    'mongosh',
    'mongo',
    'redis-cli',
    'clickhouse-client',
    'sqlite3',
  ].map((h) => [h, 'database clients']),
  ...['tee', 'truncate', 'chmod', 'chown', 'ln', 'dd', 'install', 'patch'].map((h) => [
    h,
    'commands that write or change files',
  ]),
  ...['kill', 'pkill', 'killall', 'launchctl', 'shutdown', 'reboot', 'osascript'].map((h) => [
    h,
    'stopping processes or services',
  ]),
  ...['sudo', 'su', 'doas'].map((h) => [h, 'running as another user']),
  ...['eval', 'source', '.'].map((h) => [h, 'eval and source (they hide what runs)']),
  ['npx', 'npx (downloads and runs packages)'],
  ['docker-compose', 'docker compose (the local stack on localhost:3000 is shared)'],
  ['printenv', 'printing environment variables (they hold secrets)'],
  ['security', 'the macOS keychain'],
  ['open', 'opening files or URLs outside the terminal'],
])

/** Wrappers whose arguments are another command. */
const WRAPPERS = new Set([
  'command',
  'builtin',
  'exec',
  'nohup',
  'time',
  'nice',
  'timeout',
  'stdbuf',
  'caffeinate',
])

const GIT_WRITES = new Set([
  'push',
  'commit',
  'reset',
  'checkout',
  'switch',
  'restore',
  'stash',
  'clean',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'tag',
  'am',
  'apply',
  'rm',
  'mv',
  'add',
  'worktree',
  'filter-repo',
  'filter-branch',
  'gc',
  'prune',
  'update-ref',
  'config',
  'pull',
  'remote',
  'submodule',
  'notes',
  'replace',
  'init',
  'clone',
])
// `git fetch` is allowed: it only updates remote-tracking refs, and diff mode needs a current origin/main.

const GH_WRITES = {
  pr: /^(create|merge|close|comment|review|edit|ready|reopen|checkout|lock|unlock)$/,
  issue: /^(create|comment|close|edit|reopen|delete|transfer|lock|unlock|pin|unpin)$/,
  release: /^(create|delete|edit|upload)$/,
  workflow: /^(run|enable|disable)$/,
  run: /^(rerun|cancel|delete)$/,
  repo: /^(create|delete|edit|fork|rename|archive|unarchive|sync|clone)$/,
  secret: /./,
  variable: /./,
  label: /^(create|delete|edit|clone)$/,
  gist: /^(create|delete|edit)$/,
  'ssh-key': /./,
  'gpg-key': /./,
  auth: /^(login|logout|refresh|setup-git|switch|token)$/,
  cache: /^delete$/,
}

const PACKAGE_WRITES =
  /^(add|remove|rm|uninstall|update|up|upgrade|install|i|ci|publish|link|unlink|dlx|create|init|patch|patch-commit|prune|rebuild|import|dedupe|store)$/

const PRODUCTION = /104-196-197-26|104\.196\.197\.26|sslip\.io|workflows\.optiply\.nl/

/** Why `words` (one simple command) is blocked, or null. */
function checkCommand(words) {
  // Redirections: output only to the scratch space; input not from a secret. `2>&1`, `>&2`, heredocs are fine.
  const args = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.redir) {
      args.push(w)
      continue
    }
    if (w.dup) continue
    const target = words[i + 1]?.redir ? '' : (words[++i]?.text ?? '')
    if (w.redir.includes('>') && !SCRATCH.test(target)) return 'writing files outside the scratchpad'
    if (/^\d?<$/.test(w.redir)) {
      for (const [pattern, reason] of SECRET_PATH) if (pattern.test(target)) return reason
    }
  }
  const texts = args.map((w) => w.text)

  // Leading VAR=value assignments, then wrappers like `env`, `time`, `xargs`.
  let at = 0
  while (at < texts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(texts[at])) at++
  if (at >= texts.length) return null
  const head = texts[at].split('/').pop()
  const rest = texts.slice(at + 1)

  if (head === 'env') {
    const i = rest.findIndex((t) => !t.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
    if (i === -1) return 'printing environment variables (they hold secrets)'
    return checkCommand(rest.slice(i).map((text) => ({ text, quoted: true })))
  }
  if (WRAPPERS.has(head)) {
    const i = rest.findIndex((t) => !t.startsWith('-') && !/^\d+[smhd]?$/.test(t))
    return i === -1 ? null : checkCommand(rest.slice(i).map((text) => ({ text, quoted: true })))
  }
  if (head === 'xargs') {
    const i = rest.findIndex((t) => !t.startsWith('-'))
    return i === -1 ? null : checkCommand(rest.slice(i).map((text) => ({ text, quoted: true })))
  }
  if (
    head === 'find' &&
    rest.some((t) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(t),
    )
  ) {
    return 'find with -delete or -exec'
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(head)) {
    const c = rest.indexOf('-c')
    if (c !== -1 && rest[c + 1] !== undefined) return check(rest[c + 1])
    if (rest.some((t) => !t.startsWith('-'))) return 'running shell scripts (their contents are not checked)'
    return null
  }

  if (BLOCKED_HEADS.has(head)) return BLOCKED_HEADS.get(head)

  // Secrets: any argument that is a secret path. For grep/rg the first non-flag argument is the search pattern.
  let pathArgs = rest
  if (
    ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'].includes(head) &&
    !rest.some((t) => t === '-e' || t === '-f' || t.startsWith('--regexp'))
  ) {
    const i = rest.findIndex((t) => !t.startsWith('-'))
    if (i !== -1) pathArgs = rest.filter((_, j) => j !== i)
  }
  for (const t of pathArgs) {
    for (const [pattern, reason] of SECRET_PATH) if (pattern.test(t.replace(/^~\//, '/home/'))) return reason
  }

  switch (head) {
    case 'git': {
      let i = 0
      while (i < rest.length && rest[i].startsWith('-'))
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(rest[i]) ? 2 : 1
      const sub = rest[i]
      if (sub === 'config') {
        // Reading one key (`git config user.name`, `--get`, `--list`) is fine; setting or removing one is not.
        const after = rest.slice(i + 1)
        const values = after.filter((t) => !t.startsWith('-'))
        const changes = after.some((t) =>
          /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(t),
        )
        return changes || values.length > 1 ? 'git config (it changes the repository)' : null
      }
      if (GIT_WRITES.has(sub)) return `git ${sub} (it changes the repository)`
      if (
        sub === 'branch' &&
        rest
          .slice(i + 1)
          .some((t) =>
            /^(-[dDmMcCf]+|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description)$/.test(
              t,
            ),
          )
      ) {
        return 'changing git branches'
      }
      if (sub === 'symbolic-ref' && rest.length > i + 2) return 'changing git refs'
      return null
    }
    case 'gh': {
      const [group, action] = rest.filter((t) => !t.startsWith('-'))
      if (group === 'api') {
        for (let i = 0; i < rest.length; i++) {
          const t = rest[i]
          const method = t === '-X' || t === '--method' ? rest[i + 1] : /^(-X|--method=)(.+)$/.exec(t)?.[2]
          if (method && method.toUpperCase() !== 'GET') return 'GitHub API writes'
          if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t))
            return 'GitHub API writes (a request with fields is a POST)'
        }
        return null
      }
      if (GH_WRITES[group]?.test(action ?? '')) return `gh ${group} ${action} (a GitHub write)`
      return null
    }
    case 'docker': {
      const sub = rest.filter((t) => !t.startsWith('-'))
      if (sub[0] === 'compose') return 'docker compose (the local stack on localhost:3000 is shared)'
      const readOnly = new Set([
        'ps',
        'images',
        'info',
        'version',
        'logs',
        'inspect',
        'stats',
        'top',
        'port',
        'diff',
        'history',
        'events',
      ])
      if (
        ['container', 'image', 'volume', 'network', 'system', 'context', 'buildx', 'builder'].includes(sub[0])
      ) {
        return readOnly.has(sub[1]) || sub[1] === 'ls' || sub[1] === 'df'
          ? null
          : `docker ${sub[0]} ${sub[1] ?? ''}`.trim()
      }
      return readOnly.has(sub[0])
        ? null
        : `docker ${sub[0] ?? ''} (it changes containers, images or volumes)`.trim()
    }
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
    case 'xh': {
      if (rest.some((t) => PRODUCTION.test(t))) return 'production'
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]
        const method = ['-X', '--request', '--method'].includes(t)
          ? rest[i + 1]
          : /^(-X|--request=|--method=)(.+)$/.exec(t)?.[2]
        if (method && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD')
          return 'HTTP write requests'
        if (
          /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|--form-string|-T|--upload-file|--post-data|--post-file)(=|$)/.test(
            t,
          )
        ) {
          return 'HTTP requests with a body'
        }
        if (/^-[a-zA-Z]*[dFT][a-zA-Z]*$/.test(t) && head === 'curl') return 'HTTP requests with a body'
        if (
          ['-o', '--output', '-O', '--remote-name', '--output-document'].includes(t) ||
          /^(-o|--output=|--output-document=)/.test(t)
        ) {
          const target = /^(-o|--output=|--output-document=)(.+)$/.exec(t)?.[2] ?? rest[i + 1] ?? ''
          if (t === '-O' || t === '--remote-name' || !SCRATCH.test(target))
            return 'downloading files outside the scratchpad'
        }
      }
      if (head !== 'curl' && head !== 'wget' && rest.some((t) => /^(POST|PUT|PATCH|DELETE)$/i.test(t)))
        return 'HTTP write requests'
      if (
        head === 'wget' &&
        !rest.some((t) => t === '-O' || t.startsWith('--output-document') || t === '-q' || t === '--spider')
      ) {
        return 'downloading files outside the scratchpad'
      }
      return null
    }
    case 'corepack':
    case 'pnpm':
    case 'npm':
    case 'yarn':
    case 'bun': {
      let words2 = rest
      if (head === 'corepack') {
        const i = words2.findIndex((t) => !t.startsWith('-'))
        const tool = words2[i]
        if (
          tool === 'enable' ||
          tool === 'disable' ||
          tool === 'install' ||
          tool === 'prepare' ||
          tool === 'use' ||
          tool === 'up'
        ) {
          const dir =
            words2.find((_, j) => words2[j - 1] === '--install-directory') ??
            /^--install-directory=(.+)$/.exec(
              words2.find((t) => t.startsWith('--install-directory=')) ?? '',
            )?.[1]
          return tool === 'enable' && dir && SCRATCH.test(dir)
            ? null
            : 'changing corepack outside the scratchpad'
        }
        words2 = words2.slice(i + 1)
      }
      const flagsWithValue = new Set(['--filter', '-F', '-C', '--dir', '--workspace', '-w', '--prefix'])
      let i = 0
      while (i < words2.length && words2[i].startsWith('-')) i += flagsWithValue.has(words2[i]) ? 2 : 1
      const sub = words2[i]
      if (PACKAGE_WRITES.test(sub ?? '')) return 'installing, removing or publishing packages'
      if (sub === 'format' || (sub === 'exec' && /^(npm|pnpm|npx)$/.test(words2[i + 1] ?? '')))
        return 'commands that rewrite files'
      if (
        (sub === 'biome' || words2.includes('biome')) &&
        words2.some((t) => /^(--write|--fix|--apply|--apply-unsafe|--unsafe)$/.test(t) || t === 'format')
      ) {
        return 'formatting that rewrites files'
      }
      if (sub === 'run' && words2[i + 1] === 'format') return 'formatting that rewrites files'
      return null
    }
    case 'biome':
      return rest.some((t) => /^(--write|--fix|--apply|--apply-unsafe|--unsafe)$/.test(t) || t === 'format')
        ? 'formatting that rewrites files'
        : null
    case 'sed':
    case 'perl':
      return rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'))
        ? 'in-place file edits'
        : null
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred': {
      const targets = rest.filter((t) => !t.startsWith('-'))
      return targets.length === 0 || targets.some((t) => !SCRATCH.test(t))
        ? 'deleting files outside the scratchpad'
        : null
    }
    case 'mv':
    case 'cp':
    case 'touch':
    case 'mkdir': {
      const targets = rest.filter((t) => !t.startsWith('-'))
      const dest = head === 'touch' || head === 'mkdir' ? targets : targets.slice(-1)
      return dest.length === 0 || dest.some((t) => !SCRATCH.test(t))
        ? 'writing files outside the scratchpad'
        : null
    }
    case 'node':
    case 'tsx':
    case 'python':
    case 'python3':
    case 'ruby': {
      if (rest.some((t) => PRODUCTION.test(t))) return 'production'
      return null
    }
    default:
      return null
  }
}

/** Why a Bash command is blocked, or null. */
export function check(command) {
  if (PRODUCTION.test(command) && /\b(curl|wget|http|xh|ssh|nc|node|python3?|fetch)\b/.test(command))
    return 'production'
  for (const words of commands(command)) {
    const reason = checkCommand(words)
    if (reason) return reason
  }
  return null
}

/** Read, Grep and Glob: no secrets. */
export function checkPath(input) {
  for (const value of [input.file_path, input.path, input.glob, input.pattern]) {
    if (!value) continue
    for (const [pattern, reason] of SECRET_PATH) {
      if (value === input.pattern && pattern !== SECRET_PATH[1][0]) continue // Grep's regex is not a path
      if (pattern.test(value)) return reason
    }
  }
  return null
}

export function decide(event) {
  const input = event.tool_input ?? {}
  if (event.tool_name === 'Bash') return check(String(input.command ?? ''))
  if (['Read', 'Grep', 'Glob'].includes(event.tool_name)) return checkPath(input)
  return null
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.stderr.write('review-agent-guard: could not read the hook input, so the call is blocked.\n')
    process.exit(2)
  }
  const reason = decide(event)
  if (reason) {
    process.stderr.write(
      `Blocked by the review-agent guard: ${reason}. This agent is report-only: describe in your report what you ` +
        'wanted to run and why, and leave it to the user.\n',
    )
    process.exit(2)
  }
  process.exit(0)
}
