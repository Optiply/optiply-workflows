# Runbook: the Python code executor

Python code blocks (and loop code runners) run in the **code executor** (`apps/code-executor`), a separate service:
each execution is a fresh CPython 3.12 interpreter in an [nsjail](https://github.com/google/nsjail) jail with no
network, a read-only view of Python and its packages, and limits on memory, processes, CPU and time. The design is
`docs/architecture.md` §2.14; this page is for running it.

## How it fits

```
worker / api ──HTTP + bearer token──▶ code-executor ──▶ nsjail ──▶ python3 runner.py (one per execution)
   (internal Docker network `executor`: no database, no internet)
```

- The **workers** (and the API, for sync webhook runs) send `POST /run { code, scope, timeoutMs }`; the server checks
  Python's syntax with `POST /check` before runs, publishing and Git deploys, and the editor does too.
- The executor holds **no secrets** except its token: no database, no encryption keys. The jail sees nothing of the
  container but Python, the packages and a 64 MB `/tmp`.

## Configuration

| Where | Variable | Default | What |
|---|---|---|---|
| app (api, worker) | `PYTHON_EXECUTOR_URL` | none (Compose: `http://code-executor:8080`) | Where the executor is. Without it, workflows with Python can't run or be published (`python_unavailable`). |
| app and executor | `PYTHON_EXECUTOR_TOKEN` | none | Shared bearer token, 16+ characters. Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Set the same value on both sides; restart both to rotate. Without it Python is off: the app starts (a warning in its log) and Python blocks fail `python_unavailable`; the executor refuses to start. |
| executor | `PYTHON_MEMORY_MB` | 256 | Memory per execution (cgroup, no swap). Over it: a `memory` error. |
| executor | `PYTHON_MAX_CONCURRENT` | CPU count (Compose: 4) | Executions at once; more wait up to `PYTHON_QUEUE_WAIT_SECONDS` (30), then 503 (`unavailable`: the block fails, retries apply). |
| executor | `PYTHON_MAX_CHECKS` | 2 | Syntax checks at once (the editor's, before publishing), in slots apart from runs: checks never hold up runs. |
| executor | `PYTHON_MAX_REQUEST_MB` | 64 | The largest request (code plus the blocks it reads). |
| executor container | `mem_limit` (Compose) | 2g | Must hold `PYTHON_MAX_CONCURRENT × PYTHON_MEMORY_MB` plus the server. |

Fixed limits per execution: the block's timeout (the jail's wall clock and CPU time, rounded up to whole seconds
plus one), 32 processes, one CPU, 256 open files, 16 MB per file, a 64 MB `/tmp`, 1 MB of printed output (then cut
off, said so), a 16 MB result.

## The container's privileges (and why)

nsjail creates namespaces and mounts, so the executor container needs more than an ordinary one, but not
`--privileged`:

- `cap_add: [SYS_ADMIN]`: for the namespaces, mounts and remounting the container's cgroup writable.
- `security_opt: seccomp=apps/code-executor/seccomp.json`: Docker's default seccomp profile (from moby/profiles)
  with `pivot_root` added; Docker's own profile refuses it.
- `security_opt: apparmor=unconfined`: on hosts with AppArmor (Ubuntu), Docker's profile refuses nsjail's mounts.
  The jail has its own seccomp deny list (`executor/jail.cfg`).
- The entrypoint (`executor/entrypoint.sh`) delegates the cgroup v2 memory, PID and CPU controllers so each jail gets
  its own limits.

These were found in M12 step 1's spike (handoff §9f). Running it elsewhere (Kubernetes, another runtime): the pod
needs the same capability, seccomp profile and AppArmor setting, and cgroup v2.

## Adding or upgrading a package

The packages are fixed in the image (`apps/code-executor/executor/requirements.in`, locked with hashes in
`requirements.lock`): numpy, pandas, python-dateutil, pytz, tzdata. Code can't install anything (no network, no pip).

1. Pick a release **at least two weeks old** (check its upload date on PyPI), and only from a well-known project with
   wheels for `manylinux` x86-64 and aarch64 (the image installs `--only-binary`).
2. Add it to `requirements.in`, pinned (`name==version`).
3. Regenerate the lock with hashes for every platform, in a Python 3.12 container:
   ```bash
   cd apps/code-executor/executor
   docker run --rm -v "$PWD:/w" -w /w python:3.12-slim-bookworm sh -c \
     'pip install -q pip-tools==7.4.1 && pip-compile -q --generate-hashes --strip-extras --no-header \
        --output-file requirements.lock requirements.in'
   ```
   Check the lock's new dependencies too (their versions and dates).
4. Run the executor tests (`pnpm --filter @ow/code-executor test`; they rebuild the image), and add a test that
   imports the package if it matters.
5. Deploy: `docker compose up -d --build code-executor`. `GET /health` (and the startup log line) lists the packages.

## Logs

`docker compose logs code-executor`: one JSON line per event.

- `listening`: started, with its limits and packages.
- `execution`: each `/run` or `/check`: `ms`, `ok`, and the error kind (`syntax`, `runtime`, `timeout`, `memory`,
  `serialization`, `cancelled`). No code, data or output is logged.
- `jail_failed`: a jail couldn't start; nsjail's own errors follow. The block fails as `unavailable` with nsjail's
  reason.

What the code printed is in the run's logs in the app, not here.

## When something's wrong

| Symptom | Likely cause |
|---|---|
| Blocks fail `python_unavailable: Python isn't set up on this instance` | The app has no `PYTHON_EXECUTOR_URL`/`PYTHON_EXECUTOR_TOKEN` (a URL without the token logs a warning at start). |
| `unavailable: The Python executor isn't reachable` | The executor is down or unhealthy (`docker compose ps code-executor`, its logs), or the app isn't on the `executor` network. |
| `unavailable: … refused the request (401)` | The token differs between the app and the executor. |
| `unavailable: The Python executor is busy` | All `PYTHON_MAX_CONCURRENT` slots taken for 30 s: long-running Python. Raise the limit (and `mem_limit`) or shorten the code. |
| `unavailable: The executor couldn't start a jail: …` | The container lacks its privileges (the capability, seccomp profile or AppArmor setting), or cgroup v2 isn't available. The message is nsjail's. |
| The executor exits at start: `PYTHON_EXECUTOR_TOKEN must be set` | No token (or under 16 characters) in its environment. |
| `memory` errors for reasonable data | Raise `PYTHON_MEMORY_MB` (and `mem_limit` with it); pandas copies data freely. |
