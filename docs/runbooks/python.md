# Runbook: the Python code executor

Python code blocks (and loop code runners) run in the **code executor** (`apps/code-executor`), a separate service:
each execution is a fresh CPython 3.12 interpreter in an [nsjail](https://github.com/google/nsjail) jail with no
network, a read-only view of Python and its packages, and limits on memory, processes, CPU and time. Some jails are
started ahead (the warm pool, below). The design is `docs/architecture.md` §2.14 and §2.26; this page is for running
it.

## How it fits

```
worker / api ──HTTP + bearer token──▶ code-executor ──▶ nsjail ──▶ python3 runner.py (one per execution)
   (internal Docker network `executor`: no database, no internet)
```

- The **workers** (and the API, for sync webhook runs) send `POST /run { code, scope, timeoutMs, stream: true }` and
  get what the code prints line by line as it prints it (NDJSON), then the outcome; the server checks
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
| executor | `PYTHON_WARM_JAILS` | `PYTHON_MAX_CONCURRENT` (Compose: 4) | Jails kept started ahead (the warm pool); 0 for none (every run starts its own, as before M23). |
| executor | `PYTHON_PREIMPORT` | `numpy,pandas` | Modules a warm jail imports while it waits; empty for none. |
| executor | `PYTHON_WARM_MAX_IDLE_SECONDS` | 600 | A warm jail waiting longer is replaced. |
| executor | `PYTHON_WARM_START_PARALLEL` | 1 | Warm jails starting at once. Their imports compete with runs for CPU: 2 refills a busy pool faster but slowed back-to-back small blocks (a Python loop) by ~15% on the Mac. |
| executor container | `mem_limit` (Compose) | 2g | Must hold `PYTHON_MAX_CONCURRENT × PYTHON_MEMORY_MB`, ~45 MB per warm jail (numpy and pandas imported) and the server. |

Fixed limits per execution: the block's timeout (the server's deadline, from the request; the CPU time, rounded up
to whole seconds plus one, set by the runner once the request arrives; nsjail's own limits are a backstop), 32 processes, one CPU, 256 open files, 16 MB per file, a 64 MB `/tmp`, 1 MB of printed output (then cut
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

## Workflows' own packages (the builder)

A workflow can declare pip requirements (its Settings → Python packages, `requirements.txt` in Git; M23,
`docs/architecture.md` §2.26). The **`python-builder`** service installs them; the code executor never touches the
network.

```
worker / api ──/build, /install──▶ python-builder ──pip (wheels; sdists built in a jail)──▶ package indexes
                                        │ writes
                                        ▼
                               volume python-envs: <envId>/site, lock.json, used
                                        │ read-only, one env per run that needs it
                                        ▼
                                  code-executor ──▶ jail (/opt/env first on sys.path)
```

- **Draft runs** resolve the requirements once into a **lock** (every package, version and wheel sha256, for the
  builder's platform), recorded in `python_envs`; later runs with the same requirements install that lock again
  (instant when its env is there). **Publishing, rollback and Git deploys** keep the lock in the release
  (`workflow_releases.python_lock`): live runs install exactly it, even after the env was removed or on another
  instance of the same platform (another platform resolves the same versions again). A failed install refuses the
  publish with pip's reason; in a run, the Python block fails `python_packages` (pip's output in the error's
  details).
- **A first install** starts as the run starts; a Python block still waiting after a second logs so, and its timeout
  applies (the install goes on for the next try). Publishing installs ahead, so live runs rarely wait.
- **Safety:** wheels install without running any package's code; a package with only an sdist is built in a jail
  (below). The package's code then runs only in the executor's jail (no network, no secrets), with the power of the
  block's own code. The builder has no secrets but its token (and an index's password, per request); pip's
  environment doesn't have the token. Each new env is audited (`python.env_built`, the packages, the index, the
  workflow).
- **Its API:** `POST /build {requirements, indexes?}`, `POST /install {lock, indexes?}`, `POST /check-index
  {index}`, `GET /health` (Python, platform, pip). Requirements are names, extras and versions only (no URLs, paths,
  options or markers), at most 30 per workflow.

### Package indexes (M32)

Admins add indexes in **Settings → Python** (`python_indexes`; not in Git): a slug, a name, the simple index's URL
(PEP 503; `https`, or `http` when the builder has `PYTHON_ALLOW_INSECURE_INDEXES=1`), an optional username, the
password as a **secret config var** (its value in the **default environment** is used: an env serves every
environment), and a mode:

- **With the default** (`extra`): searched beside `PYTHON_PACKAGE_INDEX_URL`. pip takes the highest version from
  either, so a public package named like a private one, with a higher version, wins (dependency confusion): pin
  private packages exactly (`name==1.2.3`), or use the other mode.
- **Instead of the default** (`primary`): the only index for workflows that pick it, so it must have everything they
  need: a proxy that also mirrors PyPI (Artifactory, Nexus, CodeArtifact, devpi, GitLab's registry with PyPI
  forwarding).

A workflow picks one under its Settings → Python packages ("From"); it's `settings.python.index`, and in Git the
first line of `requirements.txt`, `# index: <slug>`. Its lock names the index of each package from it, and installs
of that lock (live runs, rollbacks) fetch from that index again (each file pinned by its hash). The password reaches
the builder with each request that needs it and goes to pip through its environment (never its command line); it's
in no lock, env, answer or log. **Test** asks the builder to fetch the index's root signed in (a 404 there fails it: some indexes list nothing at
their root, but GitLab's answers 404 to a wrong sign-in). The builder sends the sign-in only to the index's own host,
and keeps it across a redirect only on that host (never from https to http): files on a CDN or S3 get none. Editing an index
drops the envs resolved from it (they resolve again on their next run); deleting one is refused while a workflow's
draft or live release names it. A run whose index is gone, or whose password var has no value in the default
environment, fails `python_packages` saying which.

### Packages without a wheel: sdists (M32)

When pip finds no wheel for a requirement, the builder looks for its **sdist** on the same indexes (the newest
version the requirement allows), downloads it itself (checking its hash; no package code runs to read metadata),
reads `pyproject.toml`'s `build-system.requires` (setuptools' defaults without one) and downloads those **as
wheels**, then runs `pip wheel --no-index` on it **in nsjail** (`sdist-jail.cfg`): no network at all, no token, no
`/envs`, no `/proc`, a 1 GB tmpfs, `/out` the only thing written; as the builder's own user in a user namespace,
with rlimits (address space `PYTHON_SDIST_MEMORY_MB`, CPU and time `PYTHON_SDIST_TIMEOUT_SECONDS`, processes, file
size) and the container's `mem_limit` (2g). Hence the builder needs the executor's flags (`SYS_ADMIN`, the seccomp
profile, AppArmor unconfined). **On Ubuntu 23.10 and later** (24.04 included) AppArmor also lets unprivileged user
namespaces make no mounts, so every sdist build fails with nsjail's `mount('/', MS_REC|MS_PRIVATE): Permission
denied`: set `kernel.apparmor_restrict_unprivileged_userns=0` on the host (`sysctl -w`, and in `/etc/sysctl.d/` to
keep it; CI does so). Docker Desktop's VM doesn't restrict them. The wheel is kept in `/envs/.wheels/<sdist sha256>/` and reused; resolving then goes
on with it, so the sdist's own dependencies resolve too (up to `PYTHON_MAX_SDISTS` sdists per build). The lock keeps
the sdist's hash with `"source": "sdist"`; an install builds it again if its kept wheel is gone. The image has a C
toolchain (`build-essential`) and Python's headers; a package needing other system libraries fails, and its build's
log (the env's "pip's output" in the editor) says what's missing. A build backend asking for build requirements it
doesn't declare fails saying which (builds are offline). Kept wheels unused for `PYTHON_ENV_KEEP_DAYS` are removed.

| Variable | Where | Default | What |
|---|---|---|---|
| `PYTHON_BUILDER_URL` | app | none (Compose: `http://python-builder:8080`) | Without it (or its token) workflows that declare packages can't run or be published (`python_packages_unavailable`). |
| `PYTHON_BUILDER_TOKEN` | app and builder | none | Bearer token, 16+ characters; the builder refuses to start without it. |
| `PYTHON_PACKAGE_INDEX_URL` | builder | `https://pypi.org/simple` | A PEP 503 index: PyPI, or a proxy/mirror (an `http://` one is trusted as given). Credentials in it are kept out of logs. |
| `PYTHON_ENV_MAX_MB` | builder | 1024 | The largest env. Over it: `too_big`. |
| `PYTHON_ENV_KEEP_DAYS` | builder | 30 | Envs unused this long are removed (hourly); their locks bring them back on the next run. |
| `PYTHON_MAX_BUILDS` | builder | 2 | Builds at once (one per env). |
| `PYTHON_BUILD_TIMEOUT_SECONDS` | builder | 300 | One build or install, from when it gets its slot (waiting for one is up to as long again). An env that's there already answers at once, without a slot. |
| `PYTHON_ALLOW_INSECURE_INDEXES` | builder | off | M32: admin-defined indexes over `http` (a local mirror). |
| `PYTHON_SDIST_MEMORY_MB` | builder | 2048 | M32: an sdist build's address space. |
| `PYTHON_SDIST_TIMEOUT_SECONDS` | builder | 300 | M32: one sdist build (within the build's own time). |
| `PYTHON_MAX_SDISTS` | builder | 10 | M32: sdists built for one set of requirements. |

Cleaning by hand: `docker compose exec python-builder sh -c 'rm -rf /envs/<envId>'` (or all of them, and
`/envs/.wheels` for the wheels built from sdists); the next run or publish installs (and builds) what it needs again. The volume's size: `docker compose exec python-builder du -sh /envs`.

## Adding or upgrading a package in the image

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

## The warm pool

Starting a jail and an interpreter costs ~30 ms and `import pandas` ~210 ms more; the warm pool pays that before the
run. A warm jail is nsjail and the runner started with `OW_WARM`: it imports `PYTHON_PREIMPORT`, says it's ready (one
byte on its result pipe) and waits for its request. A run takes the one that waited longest; **each jail runs one
execution and exits** (nothing carries over: not modules, files in `/tmp`, nor the environment), and a replacement
starts in the background. When none is ready the run starts a cold jail, as before. Syntax checks always start
their own. The runner exits without the interpreter's teardown (`os._exit` after its outcome), which with pandas
loaded took longer than a small block's whole run.

**Per package env (M32):** after a run in a workflow's env, the executor keeps one warm jail for that env too: its
env mounted, `PYTHON_PREIMPORT` and then the env's **roots** imported (the top-level modules of its packages that no
other package in it requires: what the workflow asked for, read from the env's `*.dist-info`; one that fails to
import is skipped). At most `PYTHON_WARM_ENV_JAILS` (4) envs keep one, the least recently run dropped first; an env
not run for `PYTHON_WARM_ENV_IDLE_SECONDS` (600), or removed from the volume, loses it. They start once the base
pool is full, one at a time with its jails, and count towards the container's memory like the base pool's; one
holding more than `PYTHON_WARM_ENV_MAX_MB` (256) once its imports are done isn't kept (torch and the like: that env
runs cold; `/health` says `tooBig`). Pre-imported modules run their import-time code before the block's own, as the
base pool's do. Measured
in the executor's tests: a block importing pandas and an env package, p50 30 ms warm against 272 ms cold.
`PYTHON_WARM_ENV_JAILS=0` turns them off.

`GET /health` shows the pool: `{"size", "ready", "starting", "warm", "cold"}` (the last two count runs since start),
and `envPools`: `{"size", "envs": {<envId>: {"ready", "starting", "warm", "cold"}}}`.
The app's `/metrics` has `ow_python_executions_total{jail="warm"|"cold"}`. Many cold runs mean the pool empties
faster than it refills: raise `PYTHON_WARM_JAILS` (and `mem_limit`), or `PYTHON_WARM_START_PARALLEL`.

Measured on the Mac's Docker Desktop (8 CPUs; M23 step 2b), over HTTP: a block importing pandas p50 **37 ms** warm
(the executor tests: 24 ms) against 359 ms cold; a trivial block 18 ms warm, 48 ms cold; back to back (the pool
empty, refills one at a time) a trivial block 50 ms and a pandas one 49 ms. A warm jail holds ~42 MB (numpy and
pandas); once it's ready its limit is raised by that much (`PYTHON_MEMORY_MB` plus what the imports took), so its
run has the memory a cold jail's run has (`warm_jail_memory` in the log if the jail's cgroup couldn't be found).

## Logs

`docker compose logs code-executor`: one JSON line per event.

- `listening`: started, with its limits and packages.
- `execution`: each `/run` or `/check`: `ms`, `ok`, the error kind (`syntax`, `runtime`, `timeout`, `memory`,
  `serialization`, `cancelled`) and `warm`. No code, data or output is logged.
- `warm_jail_failed`: a warm jail didn't start (nsjail's errors) or wasn't ready within 30 s; the pool retries after
  2, 4, … up to 60 s.
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
| A Python block fails `python_packages: … couldn't be installed: …` | pip's reason is in the message, its whole output in the error's details (`log`): a package or version that doesn't exist, no wheel for this platform (only sdists), the index unreachable (`docker compose logs python-builder`), the env over `PYTHON_ENV_MAX_MB`. |
| A package without a wheel fails to build with `mount('/', MS_REC\|MS_PRIVATE): Permission denied` in its log | The host restricts unprivileged user namespaces (Ubuntu 23.10+): `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (see sdists above). |
| `python_packages_unavailable` | The app has no `PYTHON_BUILDER_URL`/`PYTHON_BUILDER_TOKEN`. (A builder that's down shows as `python_packages: … The package builder isn't reachable`.) |
| An import fails although the package installed (`ImportError` from pandas, say) | A workflow's packages win over the image's: pinning one pandas depends on (pytz, numpy, python-dateutil) to an incompatible version breaks pandas for that workflow. |
| Python blocks slower than usual, `/health`'s `cold` climbing | The pool empties faster than it refills (see The warm pool), or `warm_jail_failed` in the log. |
