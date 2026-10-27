import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { trpcMutate, trpcQuery } from './helpers'

/** Definitions and files as untyped JSON. */
// biome-ignore lint/suspicious/noExplicitAny: the specs reach into definitions freely
export type Json = any

/** Git as someone else working on the repo: no config of the machine's, their own name. */
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Someone else',
  GIT_AUTHOR_EMAIL: 'else@optiply.nl',
  GIT_COMMITTER_NAME: 'Someone else',
  GIT_COMMITTER_EMAIL: 'else@optiply.nl',
}

/** The e2e repo: as the instance reaches it, and its directory here. */
export function e2eRepo() {
  const url = process.env.E2E_GIT_REPO_URL!
  return {
    url,
    dir: process.env.E2E_GIT_REPO_DIR ?? new URL(url).pathname,
    github: process.env.E2E_FAKE_GITHUB!,
  }
}

/** Points Git sync at the e2e repo (other specs may have changed it). */
export async function useE2eRepo(page: Page) {
  await trpcMutate(page, 'git.saveSettings', { repoUrl: e2eRepo().url, token: E2E_GITHUB_TOKEN })
}

/** git on the bare repo. */
export const git = (repoDir: string, ...args: string[]) =>
  execFileSync('git', ['--git-dir', repoDir, ...args], { env: gitEnv })
    .toString()
    .trim()

/** A file on a branch of the repo. */
export const readRepoFile = (repoDir: string, branch: string, path: string) =>
  git(repoDir, 'show', `refs/heads/${branch}:${path}`)

/** Someone else commits files onto a branch with git itself (null deletes a file). */
export function pushFiles(repoDir: string, branch: string, files: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e-dev-'))
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv }).toString().trim()
    run('clone', '--quiet', '--branch', branch, repoDir, '.')
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, path), { force: true })
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), content)
      }
    }
    run('add', '-A')
    run('commit', '--quiet', '-m', 'Someone else')
    run('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
    return run('rev-parse', 'HEAD')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Makes `branch` with just `ow.json` when the repo doesn't have it yet (a spec run on its own, on a fresh repo). */
export function ensureBranch(repoDir: string, branch: string) {
  try {
    git(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
    return
  } catch {
    // Not there yet.
  }
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e-dev-'))
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv }).toString().trim()
    run('init', '--quiet', '--initial-branch', branch)
    writeFileSync(join(dir, 'ow.json'), '{\n  "format": 1\n}\n')
    run('add', '-A')
    run('commit', '--quiet', '-m', 'Start')
    run('push', '--quiet', repoDir, `HEAD:refs/heads/${branch}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Someone else changes a JSON file on a branch. */
export function editRepoJson(repoDir: string, branch: string, path: string, edit: (json: Json) => void) {
  const json = JSON.parse(readRepoFile(repoDir, branch, path))
  edit(json)
  return pushFiles(repoDir, branch, { [path]: `${JSON.stringify(json, null, 2)}\n` })
}

/** Merges the open pull requests (on the fake GitHub), like the merge button. */
export async function mergeOpenPulls(github: string, head?: string) {
  const pulls = (await (await fetch(`${github}/_test/pulls`)).json()) as {
    number: number
    state: string
    head: string
  }[]
  for (const pull of pulls.filter((p) => p.state === 'open' && (!head || p.head === head))) {
    expect((await fetch(`${github}/_test/pulls/${pull.number}/merge`, { method: 'POST' })).ok).toBe(true)
  }
}

/** A branch draft's definition, through the API. */
export const draftDefinition = async (page: Page, id: string) =>
  (await trpcQuery<{ definition: Json }>(page, 'branchDrafts.get', { id })).definition

/** Saves a branch draft through the API (another person's save, or setting up uncommitted changes). */
export async function saveDraft(page: Page, id: string, edit: (definition: Json) => Json) {
  const { revision, definition } = await trpcQuery<{ revision: number; definition: unknown }>(
    page,
    'branchDrafts.get',
    { id },
  )
  return trpcMutate<{ revision: number }>(page, 'branchDrafts.save', {
    id,
    revision,
    definition: edit(structuredClone(definition)),
  })
}

/** Saves and commits a branch draft through the API. */
export async function commitDraft(page: Page, id: string, edit: (definition: Json) => Json, message: string) {
  const { revision } = await saveDraft(page, id, edit)
  return trpcMutate<{ commit: string }>(page, 'branchDrafts.commit', { id, revision, message })
}
