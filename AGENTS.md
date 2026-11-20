<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Review subagents (report only)

Two read-only subagents live in `.claude/agents/`: `security-auditor` and `bug-hunter`. They report; they never change
code.

- **On demand:** run them when asked ("run the security auditor", "look for bugs in <area>", "full security audit").
- **Before every PR:** before opening a PR (or marking a draft ready), run both in parallel in diff mode on the branch's
  changes against `origin/main`. Show the user both reports and wait. The user decides what gets fixed; open the PR
  only after that.

# PRs or a direct push to `main`

`main` isn't protected on GitHub, but everything that changes what runs goes through a PR. Agreed with the user,
2026-11-20.

- **A PR** (with the review agents above first) for code, config, tests, CI and deploy files (`.github/`, `deploy/`,
  `Dockerfile`), the agents and their guard (`.claude/`), and dependencies. Why: the weekday 18:00 deploy takes the
  newest commit on `main` that passed CI, so a direct push would reach production that evening unreviewed; a PR shows
  CI's result before `main` has the change.
- **Commit and push straight to `main`** for changes only to `docs/` or other `.md` files (the handoff, runbooks,
  `AGENTS.md`), with a detailed commit message. CI skips them, so they're never deployed. A change that mixes docs
  with anything else goes through a PR.
- Don't push a docs-only commit while a deploy by hand is about to start or running: "Run workflow" builds `main`'s
  head, and a deploy tagged with a commit CI never ran on makes the next 18:00 run rebuild the latest green commit
  once (harmless, but a wasted build). Push it after the deploy.
