// node --test .claude/hooks/review-agent-guard.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { check, decide } from './review-agent-guard.mjs'

const SHIM = 'PATH="/private/tmp/claude-501/x/scratchpad/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0'

const ALLOWED = [
  'git diff origin/main...HEAD --stat',
  'git log --oneline -20 origin/main..HEAD',
  'git show HEAD:apps/server/src/config.ts',
  'git -C /Users/optiply/optiply-workflows status --short',
  'git fetch -q origin',
  'git config user.name',
  'git config --get remote.origin.url',
  "git log --format='%an <%ae>' origin/main..HEAD | sort -u",
  'git branch --show-current',
  'git grep -n "git push" -- deploy/',
  'grep -rn "gcloud" deploy/',
  'grep -rn "docker compose" docs/runbooks',
  "grep -rn 'kill' apps/server/src | head -20",
  'grep -rn "\\.env" apps/server/src/config.ts',
  'grep -rln psql packages/connectors/src',
  'rg -n "sslip.io" docs',
  'cat apps/server/.env.example',
  'ls -la .claude/agents',
  'wc -l docs/handoff.md',
  'sed -n 1,40p apps/server/src/auth/sessions.ts',
  `${SHIM} corepack pnpm biome ci .`,
  `${SHIM} corepack pnpm typecheck`,
  `${SHIM} corepack pnpm turbo run test --filter='...[origin/main]' --continue=dependencies-successful`,
  `${SHIM} corepack pnpm test --continue=dependencies-successful 2>&1 | tail -50`,
  `${SHIM} corepack pnpm --filter @ow/engine exec vitest run test/queue.test.ts`,
  'COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm audit --prod',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm why minimatch',
  'corepack enable --install-directory /private/tmp/claude-501/x/scratchpad/bin pnpm',
  'mkdir -p /private/tmp/claude-501/x/scratchpad/bin',
  'node -p "require.resolve(\'turbo/package.json\')"',
  'docker ps --format "{{.Names}}"',
  'docker images | grep ow-',
  'curl -s http://localhost:3000/api/health',
  'curl -sI https://registry.npmjs.org/minimatch',
  'echo done > /dev/null',
  'cat docs/handoff.md > /private/tmp/claude-501/x/scratchpad/h.md',
  'rm -rf /private/tmp/claude-501/x/scratchpad/clone',
  'gh pr view 16 --json files',
  'gh pr diff 16',
  'gh run list --limit 5',
  'gh api repos/Optiply/optiply-workflows/pulls/16',
  'find apps -name "*.test.ts" -newer package.json',
  'echo "$(git rev-parse HEAD)"',
]

const BLOCKED = [
  ['git push origin HEAD', /git push/],
  ['git -C /tmp/x commit -m hi', /git commit/],
  ['git checkout -- apps/server/src/main.ts', /git checkout/],
  ['git stash', /git stash/],
  ['git config user.name x', /git config/],
  ['git config --global --unset user.email', /git config/],
  ['git reset --hard origin/main', /git reset/],
  ['git branch -D feat/x', /branches/],
  ['git status && git add -A', /git add/],
  ['echo ok; git push', /git push/],
  ['echo "$(git push)"', /git push/],
  ['echo `git push`', /git push/],
  ["bash -c 'git push origin main'", /git push/],
  ['sh -c "docker compose down"', /docker compose/],
  ['ls | xargs git rm', /git rm/],
  ['env FOO=1 git push', /git push/],
  ['time git commit -am x', /git commit/],
  ['docker compose ps', /docker compose/],
  ['docker-compose up -d', /docker compose/],
  ['docker rm -f ow-api', /docker rm/],
  ['docker system prune -af', /docker system prune/],
  ['docker exec -it ow-db psql', /docker exec/],
  ['gcloud compute ssh ow-vm-prod', /cloud/],
  ['/opt/homebrew/bin/gcloud auth list', /cloud/],
  ['ssh ow-vm-prod', /remote/],
  ['psql postgres://localhost/ow -c "delete from users"', /database/],
  ['curl -X POST http://localhost:3000/api/runs', /HTTP write/],
  ['curl --request=DELETE http://localhost:3000/api/apps/1', /HTTP write/],
  ['curl -d "{}" http://localhost:3000/api/runs', /body/],
  ['curl -sd "{}" http://localhost:3000/api/runs', /body/],
  ['curl --json "{}" http://localhost:3000/api/runs', /body/],
  ['curl -s https://104-196-197-26.sslip.io/api/health', /production/],
  ['curl -o apps/server/src/main.ts https://example.com/x', /download/],
  ['gh pr create --title x --body y', /gh pr create/],
  ['gh pr merge 16', /gh pr merge/],
  ['gh pr comment 16 --body hi', /gh pr comment/],
  ['gh api -X POST repos/Optiply/optiply-workflows/issues', /GitHub API/],
  ['gh api repos/x/y/labels -f name=bug', /GitHub API/],
  ['gh workflow run deploy.yml', /gh workflow run/],
  ['corepack pnpm add left-pad', /packages/],
  ['pnpm install', /packages/],
  ['npm publish', /packages/],
  ['npx some-tool', /npx/],
  ['corepack pnpm biome check --write .', /rewrite/],
  ['corepack pnpm format', /rewrite/],
  ['corepack enable', /corepack/],
  ["sed -i '' 's/a/b/' apps/server/src/main.ts", /in-place/],
  ['perl -pi -e "s/a/b/" x.ts', /in-place/],
  ['echo hi > apps/server/src/main.ts', /writing files/],
  ['echo hi>>AGENTS.md', /writing files/],
  ['cat x &> notes.txt', /writing files/],
  ['tee AGENTS.md < /dev/null', /write or change/],
  ['rm -rf apps', /deleting/],
  ['rm notes.txt', /deleting/],
  ['mv a.ts b.ts', /writing files/],
  ['cp x.ts apps/server/src/x.ts', /writing files/],
  ['find . -name "*.log" -delete', /find/],
  ['find . -exec rm {} ;', /find/],
  ['cat .env', /\.env/],
  ['cat apps/server/.env.local', /\.env/],
  ['grep -n KEY .env', /\.env/],
  ['head -5 < .env', /\.env/],
  ['ls ~/Desktop/retool_exports', /Retool/],
  ['cat ~/.ssh/id_ed25519', /SSH keys/],
  ['cat ~/.config/gcloud/application_default_credentials.json', /credential/],
  ['printenv', /environment/],
  ['env', /environment/],
  ['env | grep TOKEN', /environment/],
  ['security find-generic-password -s x -w', /keychain/],
  ['sudo ls', /another user/],
  ['eval "git push"', /eval/],
  ['source deploy/deploy.sh', /eval and source/],
  ['bash deploy/deploy.sh', /shell scripts/],
  ['kill -9 1234', /processes/],
]

test('allows read-only inspection and the checks', () => {
  for (const command of ALLOWED) assert.equal(check(command), null, command)
})

test('blocks writes, remote access and secrets', () => {
  for (const [command, reason] of BLOCKED) {
    const got = check(command)
    assert.ok(got, `not blocked: ${command}`)
    assert.match(got, reason, `${command} → ${got}`)
  }
})

test('Read, Grep and Glob: no secrets, but searching for the word .env is fine', () => {
  assert.match(
    decide({ tool_name: 'Read', tool_input: { file_path: '/Users/optiply/optiply-workflows/.env' } }),
    /\.env/,
  )
  assert.match(decide({ tool_name: 'Read', tool_input: { file_path: '/Users/optiply/.ssh/config' } }), /SSH/)
  assert.match(
    decide({
      tool_name: 'Glob',
      tool_input: { pattern: '*', path: '/Users/optiply/Desktop/retool_exports' },
    }),
    /Retool/,
  )
  assert.equal(
    decide({
      tool_name: 'Read',
      tool_input: { file_path: '/Users/optiply/optiply-workflows/apps/server/.env.example' },
    }),
    null,
  )
  assert.equal(
    decide({ tool_name: 'Grep', tool_input: { pattern: '\\.env', path: 'apps/server/src' } }),
    null,
  )
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'apps/server/src/config.ts' } }), null)
})

test('as a hook: exit 2 with a reason, exit 0 when allowed, exit 2 on bad input', () => {
  const script = fileURLToPath(new URL('./review-agent-guard.mjs', import.meta.url))
  const run = (input) => spawnSync(process.execPath, [script], { input, encoding: 'utf8' })
  const blocked = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } }))
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /review-agent guard: git push/)
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } })).status, 0)
  assert.equal(run('not json').status, 2)
})
