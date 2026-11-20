#!/usr/bin/env node
// PreToolUse guard for the report-only review agents (.claude/agents/security-auditor.md and bug-hunter.md).
// Wired in each agent's frontmatter, so it runs only while one of those agents runs: the main session is unaffected.
//
// An ALLOW-list: it splits a Bash command into the commands it actually runs (pipes, `;`, `&&`, loops and `if`,
// `$(…)`, backticks, `bash -c '…'`, `xargs …`) and lets a command through only if it is on the list of read-only
// commands below, used in a read-only way (`git diff` yes, `git push` no; `corepack pnpm test` yes, `pnpm db:migrate`
// no). Anything not on the list is blocked, so a missed command fails closed. Writes are allowed only to the scratch
// space (/tmp, /private/tmp, /private/var/folders, $TMPDIR). Secrets (.env files, keys, the Retool exports) can't be
// read. Read, Grep and Glob are checked for the same secrets.
//
// A guard against mistakes and against instructions hidden in the code under review, not a sandbox: code an agent is
// allowed to run (tests, `node --test`, a script in its scratchpad) is not inspected, and could do anything the user
// can. Exit 2 blocks the call; stderr is the reason the agent sees.
//
// Test: node --test .claude/hooks/review-agent-guard.test.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------------------------------------------------
// A small shell tokenizer: words with quotes removed, redirections, and the operators between commands.

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')']

const ANSI_C = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
}

/** Splits `text` into tokens ({ text, quoted } words, { op }, { redir, dup }) and the `$(…)`/backtick bodies. */
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
    if (c === '\\' && text[i + 1] === '\n') {
      i++ // a line continuation: the two lines are one command
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      inWord = true
      continue
    }
    if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: $'git\x20push'
      let j = i + 2
      while (j < text.length && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < text.length) {
          const e = text[j + 1]
          const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(j + 1))
          if (hex) {
            word += String.fromCharCode(Number.parseInt(hex[1], 16))
            j += 1 + hex[0].length
          } else {
            word += ANSI_C[e] ?? e
            j += 2
          }
          continue
        }
        word += text[j++]
      }
      i = j
      quoted = inWord = true
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
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          if (text[j + 1] !== '\n') word += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const [sub, end] = balanced(text, j + 2)
          subshells.push(sub)
          word += `$(${sub})`
          j = end + 1
          continue
        }
        if (text[j] === '`') {
          const end = text.indexOf('`', j + 1)
          subshells.push(text.slice(j + 1, end === -1 ? text.length : end))
          word += '$()'
          j = end === -1 ? text.length : end + 1
          continue
        }
        word += text[j++]
      }
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
      word += '$()'
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

/** The simple commands in `text`: arrays of tokens. A heredoc's body is skipped. */
function commands(text) {
  const body = stripHeredocs(text)
  const { tokens, subshells } = tokenize(body)
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

/** Removes heredoc bodies (`<<EOF … EOF`, `<<'EOF'`, `<<-EOF`): they are data, not commands. */
function stripHeredocs(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const delims = [...lines[i].matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2])
    for (const d of delims) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== d) i++
      i++ // the delimiter line
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths.

const HOME = homedir()

/** True when `p` is in the scratch space (after resolving `~`, `$TMPDIR` and `..`), or a harmless device. */
export function isScratch(p) {
  if (p === '-' || /^\/dev\/(null|stdout|stderr)$/.test(p)) return true
  let path = p.replace(/^\$\{?TMPDIR\}?/, '/private/var/folders/tmpdir/').replace(/^~(?=\/|$)/, HOME)
  if (path.includes('$')) return false
  if (!path.startsWith('/')) return false
  path = posix.normalize(path)
  return /^\/(private\/)?(tmp|var\/folders)\//.test(path)
}

const SECRET_PATH = [
  [/(^|\/)\.env(\.(?!example$)[\w.-]+)?$/, 'reading .env files (they hold secrets)'],
  [/\.env[^/]*[*?[]|(^|\/)\.([^./][^/]*)?[*?[]/, 'globs over hidden files (they can include .env)'],
  [/retool_exports/, 'the Retool exports (sensitive)'],
  [/(^|\/)\.ssh(\/|$)|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, 'SSH keys'],
  [
    /\.config\/gcloud|application_default_credentials|(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.docker\/config\.json$|(^|\/)\.claude\.json$|(^|\/)\.git-credentials$|(^|\/)hosts\.yml$/,
    'credential files',
  ],
]

/** Why reading `arg` would expose a secret, or null. */
function secret(arg) {
  const path = arg.replace(/^~(?=\/|$)/, HOME)
  for (const [pattern, reason] of SECRET_PATH) if (pattern.test(path)) return reason
  return null
}

/** The directory relative paths resolve against: the session's cwd from the hook input. */
let CWD = process.cwd()

/** True when `dir` (or a folder under it, outside node_modules/.git/dist) holds a .env file other than .env.example. */
function holdsEnvFile(dir) {
  const start = posix.resolve(CWD, dir.replace(/^~(?=\/|$)/, HOME))
  try {
    if (!statSync(start).isDirectory()) return false
  } catch {
    return false
  }
  const queue = [start]
  let seen = 0
  while (queue.length && seen < 20000) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      seen++
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.turbo', 'coverage', 'target'].includes(e.name))
          queue.push(`${current}/${e.name}`)
      } else if (/^\.env(\.(?!example$).+)?$/.test(e.name)) return true
    }
  }
  return seen >= 20000 // too big to tell: treat as holding one
}

const PRODUCTION = /104-196-197-26|104\.196\.197\.26|sslip\.io|workflows\.optiply\.nl/

// ---------------------------------------------------------------------------------------------------------------------
// The allow-list.

/** Read-only commands whose path arguments are only checked for secrets. */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  '[[',
  ']]',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'uniq',
  'cut',
  'tr',
  'column',
  'jq',
  'diff',
  'cmp',
  'comm',
  'nl',
  'rev',
  'fold',
  'expand',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'sha256sum',
  'shasum',
  'md5',
  'date',
  'whoami',
  'id',
  'uname',
  'which',
  'type',
  'hostname',
  'sleep',
  'seq',
  'expr',
  'bc',
  'cd',
  'pushd',
  'popd',
  'paste',
  'join',
  'look',
  'iconv',
  'base64',
  'less',
  'more',
  'lsof',
  'ps',
  'pgrep',
  'uptime',
  'sw_vers',
  'arch',
  'nproc',
  'getconf',
  'mdls',
  'unset',
  'shift',
  'exit',
  'return',
  'break',
  'continue',
  'wait',
  'read',
  'local',
  'pmset',
])

/** Shell keywords that start or end a compound command: skipped, the command after them is checked. */
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  '!',
  '{',
  '}',
  'esac',
])

/** Wrappers whose arguments are another command, and how many leading words they take. */
const WRAPPERS = {
  nohup: () => 0,
  nice: (r) => (r[0] === '-n' ? 2 : r[0]?.startsWith('-') ? 1 : 0),
  timeout: (r) => {
    let i = 0
    while (r[i]?.startsWith('-')) i += r[i] === '-s' || r[i] === '-k' ? 2 : 1
    return i + 1 // the duration
  },
  time: (r) => (r[0] === '-p' ? 1 : 0),
  caffeinate: (r) => {
    let i = 0
    while (r[i]?.startsWith('-')) i += r[i] === '-t' || r[i] === '-w' ? 2 : 1
    return i
  },
  stdbuf: (r) => {
    let i = 0
    while (r[i]?.startsWith('-')) i += /^-[ioe]$/.test(r[i]) ? 2 : 1
    return i
  },
}

const blocked = (what) => `${what} is not on the review agents' list of read-only commands`

/** Why `tokens` (one simple command) is blocked, or null. */
function checkCommand(tokens) {
  // Redirections: output only to the scratch space; input not from a secret. `2>&1`, `>&2` and heredocs are fine.
  const args = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.redir) {
      args.push(t.text)
      continue
    }
    if (t.dup) continue
    const target = tokens[i + 1]?.redir ? '' : (tokens[++i]?.text ?? '')
    if (/^\d?<<-?$|^\d?<<<$/.test(t.redir)) continue
    if (t.redir.includes('>') && !isScratch(target)) return 'writing files outside the scratchpad'
    if (t.redir.includes('<')) {
      const s = secret(target)
      if (s) return s
    }
  }
  return checkWords(args)
}

/** Why the command `words` (no redirections) is blocked, or null. */
function checkWords(words) {
  let at = 0
  while (
    at < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(words[at]) || KEYWORDS.has(words[at]))
  )
    at++
  if (at >= words.length) return null
  const raw = words[at]
  const rest = words.slice(at + 1)

  // Loop headers and the like: `for x in a b`, `select`, `case`, functions.
  if (raw === 'for' || raw === 'select' || raw === 'in') return null
  if (raw === 'case' || raw === 'function' || raw.endsWith('()'))
    return 'case statements and function definitions'

  if (raw.includes('$')) return 'a command name taken from a variable or a substitution'
  let head = raw
  if (raw.includes('/')) {
    const dir = posix.dirname(raw)
    if (!['/bin', '/usr/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'].includes(dir)) {
      return 'running a script or program by path'
    }
    head = posix.basename(raw)
  }

  // Wrappers.
  if (head in WRAPPERS) {
    const skip = WRAPPERS[head](rest)
    return skip >= rest.length ? null : checkWords(rest.slice(skip))
  }
  if (head === 'command' || head === 'builtin') {
    if (rest[0] === '-v' || rest[0] === '-V') return null
    return checkWords(rest[0] === '-p' ? rest.slice(1) : rest)
  }
  if (head === 'env') {
    let i = 0
    while (i < rest.length && (rest[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]))) {
      i += rest[i] === '-u' || rest[i] === '-C' || rest[i] === '-S' ? 2 : 1
    }
    if (i >= rest.length) return 'printing environment variables (they hold secrets)'
    return checkWords(rest.slice(i))
  }
  if (head === 'xargs') {
    const withValue = new Set([
      '-I',
      '-i',
      '-n',
      '-P',
      '-L',
      '-l',
      '-s',
      '-E',
      '-e',
      '-d',
      '-a',
      '-J',
      '-R',
      '-S',
    ])
    let i = 0
    while (i < rest.length && rest[i].startsWith('-')) i += withValue.has(rest[i]) ? 2 : 1
    return i >= rest.length ? null : checkWords(rest.slice(i))
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(head)) {
    const c = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t))
    if (c !== -1 && rest[c + 1] !== undefined) return check(rest[c + 1])
    return 'running a shell script or a shell reading commands from input'
  }

  // Secrets in any path-like argument, except a search pattern (grep's first non-flag argument).
  const patternFirst = ['grep', 'egrep', 'fgrep', 'rg', 'awk', 'sed'].includes(head)
  const firstPlain = rest.findIndex((t) => !t.startsWith('-'))
  for (let i = 0; i < rest.length; i++) {
    if (patternFirst && i === firstPlain && !rest.includes('-e') && !rest.includes('-f')) continue
    if (/^--exclude(-dir)?=/.test(rest[i])) continue // a file it leaves out is not read
    const value = /^--?[\w-]+=(.+)$/.exec(rest[i])?.[1] ?? rest[i]
    const s = secret(value)
    if (s) return s
  }
  if (rest.some((t) => PRODUCTION.test(t)) && head !== 'grep' && head !== 'rg' && head !== 'git')
    return 'production'

  if (READERS.has(head)) return null

  switch (head) {
    case 'export':
    case 'set':
    case 'declare':
    case 'typeset':
    case 'alias':
      return rest.length === 0 || rest.some((t) => t === '-p')
        ? 'printing environment variables (they hold secrets)'
        : null
    case 'sort':
      for (let i = 0; i < rest.length; i++) {
        const out = rest[i] === '-o' ? rest[i + 1] : /^(-o|--output=)(.+)$/.exec(rest[i])?.[2]
        if (out !== undefined && !isScratch(out)) return 'writing files outside the scratchpad'
      }
      return null
    case 'tee':
      return rest.filter((t) => !t.startsWith('-')).every(isScratch)
        ? null
        : 'writing files outside the scratchpad'
    case 'grep':
    case 'egrep':
    case 'fgrep': {
      const recursive = rest.some(
        (t) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t) || t === '--recursive' || t === '--dereference-recursive',
      )
      if (!recursive || rest.some((t) => /^--exclude=['"]?\.env/.test(t))) return null
      const plain = rest.filter((t) => !t.startsWith('-'))
      const targets = rest.includes('-e') || rest.includes('-f') ? plain : plain.slice(1)
      return (targets.length ? targets : ['.']).some(holdsEnvFile)
        ? "a recursive grep over a folder with a .env file (add --exclude='.env*', or use rg, which skips it)"
        : null
    }
    case 'rg':
      return rest.some((t) => /^(-u+|--hidden|--no-ignore.*|-\w*u\w*|--unrestricted)$/.test(t) || t === '-.')
        ? 'rg over hidden or ignored files (they include .env)'
        : null
    case 'find':
      return rest.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(t))
        ? 'find with -delete or -exec'
        : null
    case 'sed':
      if (rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place') || t === '-f'))
        return 'in-place file edits'
      if (rest.some((t) => /(^|[^A-Za-z])[wWrRe]\s+[^\s;]/.test(t) || /^[\d,$]*[wWrRe]\s/.test(t))) {
        return 'sed scripts that read or write files or run commands'
      }
      return null
    case 'awk':
    case 'gawk':
      return rest.some((t) => /system|getline|>|\||^-f$/.test(t))
        ? 'awk programs that write files or run commands'
        : null
    case 'git':
      return checkGit(rest)
    case 'gh':
      return checkGh(rest)
    case 'docker':
      return checkDocker(rest)
    case 'curl':
      return checkCurl(rest)
    case 'corepack':
      return checkCorepack(rest)
    case 'pnpm':
    case 'npm':
      return checkPnpm(rest)
    case 'node':
    case 'tsx':
    case 'python':
    case 'python3':
      return checkRuntime(head, rest)
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'mv':
    case 'touch':
    case 'mkdir': {
      const targets = rest.filter((t) => !t.startsWith('-'))
      return targets.length && targets.every(isScratch) ? null : 'changing files outside the scratchpad'
    }
    case 'cp': {
      const targets = rest.filter((t) => !t.startsWith('-'))
      return targets.length >= 2 && isScratch(targets.at(-1)) ? null : 'writing files outside the scratchpad'
    }
    default:
      return blocked(head)
  }
}

const GIT_READS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'grep',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'merge-base',
  'describe',
  'shortlog',
  'rev-list',
  'for-each-ref',
  'name-rev',
  'check-ignore',
  'count-objects',
  'whatchanged',
  'show-ref',
  'help',
  'version',
  'range-diff',
  'cherry',
  'diff-tree',
  'diff-index',
  'diff-files',
  'verify-commit',
])

function checkGit(rest) {
  let i = 0
  while (i < rest.length && rest[i].startsWith('-')) {
    if (rest[i] === '-c' || rest[i].startsWith('--config-env') || rest[i] === '--exec-path')
      return 'git -c (it can define aliases that write)'
    i += ['-C', '--git-dir', '--work-tree', '--namespace'].includes(rest[i]) ? 2 : 1
  }
  const sub = rest[i]
  const after = rest.slice(i + 1)
  if (sub === undefined || sub === '--version') return null
  if (after.some((t) => /^--output(=|$)|^-o$/.test(t)) && sub !== 'grep')
    return 'git writing its output to a file'
  if (GIT_READS.has(sub)) return null
  switch (sub) {
    case 'branch': {
      const writes =
        /^(-[dDmMcCfu]+|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/
      if (after.some((t) => writes.test(t))) return 'changing git branches'
      const listing = after.some((t) =>
        /^(-[arlv]+|--list|--all|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at|--show-current)/.test(
          t,
        ),
      )
      return !listing && after.some((t) => !t.startsWith('-')) ? 'creating a git branch' : null
    }
    case 'config': {
      const values = after.filter((t) => !t.startsWith('-'))
      const changes = after.some((t) =>
        /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(t),
      )
      return changes || values.length > 1 ? 'git config (it changes the repository)' : null
    }
    case 'fetch':
      return after.some((t) => t.includes(':') && !/^[a-z+]+:\/\//.test(t) && !t.startsWith('git@')) ||
        after.includes('--upload-pack')
        ? 'git fetch into a local branch'
        : null
    case 'remote':
      return after.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(after[0])
        ? null
        : 'git remote (it changes remotes)'
    case 'stash':
    case 'worktree':
      return ['list', 'show'].includes(after[0]) ? null : `git ${sub} (it changes the working tree)`
    case 'reflog':
      return ['expire', 'delete'].includes(after[0]) ? 'git reflog (it changes the reflog)' : null
    default:
      return `git ${sub} (it changes the repository)`
  }
}

const GH_READS = {
  pr: ['view', 'diff', 'list', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  run: ['view', 'list', 'watch'],
  workflow: ['view', 'list'],
  repo: ['view'],
  release: ['view', 'list'],
  search: null,
  auth: ['status'],
  label: ['list'],
  cache: ['list'],
}

function checkGh(rest) {
  const plain = rest.filter((t) => !t.startsWith('-'))
  const [group, action] = plain
  if (rest[0] === '--version' || group === 'version') return null
  if (group === 'api') {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]
      const method = t === '-X' || t === '--method' ? rest[i + 1] : /^(-X|--method=)(.+)$/.exec(t)?.[2]
      if (method && method.toUpperCase() !== 'GET') return 'GitHub API writes'
      if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t) || /^-[a-zA-Z]*[fF]$/.test(t)) {
        return 'GitHub API writes (a request with fields is a POST)'
      }
      if (/^graphql$/.test(t)) return 'the GitHub GraphQL API (it can write)'
    }
    return null
  }
  if (!(group in GH_READS))
    return `gh ${group ?? ''} (only reading PRs, issues, runs and the API is allowed)`.trim()
  const reads = GH_READS[group]
  return reads === null || reads.includes(action)
    ? null
    : `gh ${group} ${action ?? ''} (a GitHub write)`.trim()
}

function checkDocker(rest) {
  const plain = rest.filter((t) => !t.startsWith('-'))
  const reads = ['ps', 'images', 'info', 'version', 'logs', 'inspect', 'stats', 'top', 'port', 'history']
  if (rest[0] === '--version' || reads.includes(plain[0])) return null
  const groups = {
    image: ['ls', 'inspect', 'history'],
    container: ['ls', 'inspect', 'logs', 'top', 'port'],
    volume: ['ls', 'inspect'],
    network: ['ls', 'inspect'],
    system: ['df', 'info'],
    buildx: ['ls'],
  }
  if (plain[0] in groups && groups[plain[0]].includes(plain[1])) return null
  if (plain[0] === 'compose') return 'docker compose (the local stack on localhost:3000 is shared)'
  return `docker ${plain.slice(0, 2).join(' ')} (it changes containers, images or volumes)`
}

function checkCurl(rest) {
  // Every option must be a read-only one; short options may be combined (-sSL, -sm 5, -sX PUT).
  const noValue = new Set('sSLIifvkgG#q'.split(''))
  const withValue = new Set('HmwoAeXr'.split(''))
  const longNoValue =
    /^--(silent|show-error|location|head|include|fail|fail-with-body|verbose|insecure|compressed|globoff|get|no-progress-meter|http1\.1|http2|ipv4|ipv6|no-buffer|raw|path-as-is)$/
  const longWithValue =
    /^--(header|max-time|connect-timeout|write-out|output|user-agent|referer|request|retry|retry-delay|range|max-filesize|limit-rate|resolve|proto|url)$/
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (!t.startsWith('-') || t === '-') continue
    let opt
    let value
    if (t.startsWith('--')) {
      const [name, inline] = t.split(/=(.*)/s)
      if (longNoValue.test(name)) continue
      if (!longWithValue.test(name)) return `curl ${name} (only read-only curl options are allowed)`
      opt = name
      value = inline ?? rest[++i]
    } else {
      const letters = t.slice(1)
      let j = 0
      while (j < letters.length && noValue.has(letters[j])) j++
      if (j === letters.length) continue
      if (!withValue.has(letters[j])) return `curl -${letters[j]} (only read-only curl options are allowed)`
      opt = `-${letters[j]}`
      value = letters.slice(j + 1) || rest[++i]
    }
    if ((opt === '-X' || opt === '--request') && !/^(GET|HEAD)$/i.test(value ?? ''))
      return 'HTTP write requests'
    if ((opt === '-o' || opt === '--output') && !isScratch(value ?? ''))
      return 'downloading files outside the scratchpad'
  }
  return null
}

function checkCorepack(rest) {
  const plain = rest.filter((t) => !t.startsWith('-'))
  if (rest[0] === '--version' || rest[0] === '-v') return null
  if (plain[0] === 'enable') {
    const i = rest.indexOf('--install-directory')
    const dir =
      i === -1
        ? /^--install-directory=(.+)$/.exec(rest.find((t) => t.startsWith('--install-directory=')) ?? '')?.[1]
        : rest[i + 1]
    return dir && isScratch(`${dir.replace(/\/?$/, '/')}`) ? null : 'corepack enable outside the scratchpad'
  }
  if (plain[0] === 'pnpm' || plain[0] === 'npm') return checkPnpm(rest.slice(rest.indexOf(plain[0]) + 1))
  return `corepack ${plain[0] ?? '(no command)'} (only \`corepack pnpm …\` and a scratchpad shim are allowed)`
}

/** Scripts the agents may run: the checks, and builds (they write only dist/ and .turbo/). */
const SCRIPTS = new Set(['typecheck', 'test', 'lint', 'build', 'bench', 'bench:webhooks', 'e2e'])
const TURBO_TASKS = new Set(['test', 'typecheck', 'build', 'lint'])

function checkPnpm(rest) {
  const withValue = new Set([
    '--filter',
    '-F',
    '-C',
    '--dir',
    '--workspace',
    '--prefix',
    '--reporter',
    '--loglevel',
  ])
  let i = 0
  while (i < rest.length && rest[i].startsWith('-')) {
    if (rest[i] === '-v' || rest[i] === '--version') return null
    i += withValue.has(rest[i]) ? 2 : 1
  }
  let sub = rest[i]
  let args = rest.slice(i + 1)
  if (sub === 'run' || sub === 'run-script') {
    sub = args[0]
    args = args.slice(1)
  }
  if (sub === undefined) return null
  if (SCRIPTS.has(sub)) return null
  switch (sub) {
    case 'biome':
      return checkBiome(args)
    case 'turbo':
      return checkTurbo(args)
    case 'exec':
      return checkExec(args)
    case 'audit':
      return args.some((t) => /^--fix/.test(t)) ? 'pnpm audit --fix (it changes package.json)' : null
    case 'why':
    case 'ls':
    case 'list':
    case 'll':
    case 'outdated':
    case 'licenses':
    case 'view':
    case 'info':
    case 'explain':
    case 'root':
    case 'bin':
      return null
    default:
      return `pnpm ${sub} (only the checks, builds, audit and why are allowed)`
  }
}

function checkBiome(args) {
  if (args.some((t) => /^--(write|fix|apply|apply-unsafe|unsafe|staged|changed)$/.test(t)))
    return 'formatting that rewrites files'
  const sub = args.find((t) => !t.startsWith('-'))
  return sub === undefined || ['ci', 'check', 'lint', 'format', 'version', 'explain', 'rage'].includes(sub)
    ? null
    : `biome ${sub} (only ci, check, lint and format without --write are allowed)`
}

function checkTurbo(args) {
  const plain = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (
        /^--(filter|concurrency|output-logs|log-order|cache|cache-dir|graph|summarize|env-mode|ui|log-prefix|affected)$/.test(
          args[i],
        ) &&
        !args[i].includes('=')
      ) {
        if (
          /^--(filter|concurrency|output-logs|log-order|cache|cache-dir|env-mode|ui|log-prefix)$/.test(
            args[i],
          )
        )
          i++
      }
      if (/^--graph/.test(args[i])) return 'turbo --graph (it writes a file)'
      continue
    }
    plain.push(args[i])
  }
  const tasks = plain[0] === 'run' ? plain.slice(1) : plain
  if (tasks.length === 0) return 'turbo without a task'
  const bad = tasks.find((t) => !TURBO_TASKS.has(t))
  return bad ? `turbo ${bad} (only test, typecheck, build and lint are allowed)` : null
}

function checkExec(args) {
  const tool = args.find((t) => !t.startsWith('-'))
  const rest = args.slice(args.indexOf(tool) + 1)
  switch (tool) {
    case 'vitest':
    case 'tsc':
      return rest.some((t) => /^(-u|--update|--outFile|--outDir|-b|--build)$/.test(t))
        ? `${tool} with options that write files`
        : null
    case 'biome':
      return checkBiome(rest)
    case 'turbo':
      return checkTurbo(rest)
    case 'playwright':
      return rest[0] === 'test' && !rest.some((t) => /^--update-snapshots|^-u$/.test(t))
        ? null
        : 'playwright other than `test`'
    default:
      return `pnpm exec ${tool ?? ''} (only vitest, tsc, biome, turbo and playwright test are allowed)`.trim()
  }
}

function checkRuntime(head, rest) {
  if (rest.length === 0) return `${head} reading code from its input`
  if (rest.some((t) => /^(-v|--version|-V)$/.test(t))) return null
  if (head === 'node' && rest[0] === '--test') return null
  // Code given inline or a script in the scratchpad: allowed (not inspected; see the header).
  const flag = rest.find((t) => t.startsWith('-'))
  if (['-e', '-p', '--eval', '--print', '-c'].includes(flag)) return null
  const script = rest.find((t) => !t.startsWith('-'))
  return script && isScratch(script) ? null : `${head} running a file outside the scratchpad`
}

// ---------------------------------------------------------------------------------------------------------------------

/** Why a Bash command is blocked, or null. */
export function check(command) {
  for (const tokens of commands(command)) {
    const reason = checkCommand(tokens)
    if (reason) return reason
  }
  return null
}

/** Read, Grep and Glob: no secrets. */
export function checkPath(tool, input) {
  const values =
    tool === 'Read' ? [input.file_path] : [input.path, tool === 'Glob' ? input.pattern : input.glob]
  for (const value of values) {
    if (!value) continue
    if (tool === 'Read') {
      const s = secret(value)
      if (s) return s
      continue
    }
    if (/retool_exports/.test(value)) return 'the Retool exports (sensitive)'
    if (/(^|\/)\.ssh(\/|$)|\.config\/gcloud/.test(value.replace(/^~(?=\/|$)/, HOME)))
      return 'credential files'
  }
  return null
}

export function decide(event) {
  const input = event.tool_input ?? {}
  if (typeof event.cwd === 'string' && event.cwd.startsWith('/')) CWD = event.cwd
  if (event.tool_name === 'Bash') return check(String(input.command ?? ''))
  if (['Read', 'Grep', 'Glob'].includes(event.tool_name)) return checkPath(event.tool_name, input)
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
  let reason
  try {
    reason = decide(event)
  } catch (error) {
    reason = `the guard failed (${error.message}), so the call is blocked`
  }
  if (reason) {
    process.stderr.write(
      `Blocked by the review-agent guard: ${reason}. This agent is report-only: describe in your report what you ` +
        'wanted to run and why, and leave it to the user.\n',
    )
    process.exit(2)
  }
  process.exit(0)
}
