"""
The Python package builder (M23, docs/architecture.md §2.26): installs a workflow's packages into an env on a volume
the code executor reads, so its Python blocks can import them. It alone has network access; it runs no package's code
(wheels only).

  POST /build    {"requirements": ["polars==1.9.0", ...]}
                 -> {"ok": true, "lock": {...}, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  POST /install  {"lock": {...}}  (a lock /build gave: installs exactly it, without resolving)
                 -> {"ok": true, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  GET  /health   -> {"ok": true, "python": "3.12.x", "platform": "cp312-linux-aarch64", "pip": "..."}

Failures answer 200 with {"ok": false, "error": {"kind", "message"}, "log"}: kind `resolve` (no such package or
version, or no wheel), `install`, `too_big`, `timeout`, `platform` (a lock made elsewhere) or `invalid`. Every request
but /health needs `Authorization: Bearer <PYTHON_BUILDER_TOKEN>`.

A lock is {"platform", "packages": [{"name", "version", "sha256"}]}, sorted by name; its env is `envs/<envId>/site`
(envId: the lock's hash), with `lock.json` beside it and `used` touched whenever a build or install names it. Envs
unused for PYTHON_ENV_KEEP_DAYS are removed: their locks rebuild them.
"""

import hashlib
import hmac
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("PYTHON_BUILDER_TOKEN", "")
PORT = int(os.environ.get("PORT", "8080"))
ENVS = os.environ.get("PYTHON_ENVS_DIR", "/envs")
INDEX_URL = os.environ.get("PYTHON_PACKAGE_INDEX_URL", "https://pypi.org/simple")
MAX_ENV_BYTES = int(float(os.environ.get("PYTHON_ENV_MAX_MB", "1024")) * 1024 * 1024)
MAX_BUILDS = int(os.environ.get("PYTHON_MAX_BUILDS", "2"))
KEEP_DAYS = float(os.environ.get("PYTHON_ENV_KEEP_DAYS", "30"))
BUILD_TIMEOUT_S = float(os.environ.get("PYTHON_BUILD_TIMEOUT_SECONDS", "300"))
MAX_REQUIREMENTS = 30
MAX_LOG_CHARS = 64 * 1024
PLATFORM = f"cp{sys.version_info.major}{sys.version_info.minor}-{sysconfig.get_platform()}"

builds = threading.BoundedSemaphore(MAX_BUILDS)
# One build or install per env at a time: a second request for it waits, then finds it there.
env_locks = {}
env_locks_guard = threading.Lock()

# What @ow/definition's parseRequirement allows, checked again here: a name, extras, version specifiers.
REQUIREMENT = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
    r"(?:\s*\[\s*[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*\s*\])?"
    r"(?:\s*(?:~=|===|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:~=|===|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?$"
)
NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
VERSION = re.compile(r"^[A-Za-z0-9.+!_-]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def log(event, **fields):
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **fields}), flush=True)


class BuildError(Exception):
    def __init__(self, kind, message, output=""):
        super().__init__(message)
        self.kind = kind
        self.output = output


def scrub(text):
    """pip's output without credentials an index URL may carry (user:password@)."""
    return re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1***@", text)[-MAX_LOG_CHARS:]


def pip_args():
    args = [sys.executable, "-m", "pip", "--disable-pip-version-check", "--no-input", "--no-color"]
    index = ["--index-url", INDEX_URL]
    host = urllib.parse.urlsplit(INDEX_URL)
    if host.scheme == "http" and host.hostname:
        index += ["--trusted-host", host.hostname]  # an http index someone configured on purpose (a local mirror)
    return args, index


def pip(args, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BuildError("timeout", f"The build took longer than {BUILD_TIMEOUT_S:.0f} s")
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=remaining, env=pip_env())
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") + (exc.stderr or "")
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        raise BuildError("timeout", f"The build took longer than {BUILD_TIMEOUT_S:.0f} s", output) from None
    return done.returncode, done.stdout + done.stderr


def pip_env():
    # Nothing of the builder's environment but what pip needs: no token.
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/tmp", "PIP_CACHE_DIR": "/tmp/pip-cache", "LANG": "C.UTF-8"}


def resolve(requirements, deadline):
    """The requirements as a lock: every package pip would install, its version and its wheel's hash."""
    base, index = pip_args()
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "report.json")
        code, output = pip(
            base
            + ["install", "--dry-run", "--ignore-installed", "--only-binary", ":all:", "--report", report, "--quiet"]
            + index
            + requirements,  # none starts with "-" (checked): not taken for options
            deadline,
        )
        if code != 0:
            raise BuildError("resolve", first_error(output) or "pip couldn't resolve the packages", output)
        with open(report) as f:
            data = json.load(f)
    packages = []
    for item in data.get("install", []):
        info = item.get("download_info") or {}
        hashes = (info.get("archive_info") or {}).get("hashes") or {}
        sha = hashes.get("sha256")
        if not sha:
            legacy = (info.get("archive_info") or {}).get("hash", "")
            sha = legacy.split("=", 1)[1] if legacy.startswith("sha256=") else None
        if not sha:
            raise BuildError("resolve", f"The index gave no sha256 for {item['metadata']['name']}", output)
        packages.append({"name": item["metadata"]["name"], "version": item["metadata"]["version"], "sha256": sha})
    packages.sort(key=lambda p: normalize(p["name"]))
    return {"platform": PLATFORM, "packages": packages}, output


def first_error(output):
    for line in output.splitlines():
        if line.startswith("ERROR:"):
            return line[len("ERROR:") :].strip()
    return None


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def env_id(lock):
    canonical = json.dumps(lock, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def check_lock(lock):
    """A lock as /build makes them, or a BuildError `invalid`."""
    if not isinstance(lock, dict) or not isinstance(lock.get("platform"), str):
        raise BuildError("invalid", "Expected a lock: {platform, packages}")
    packages = lock.get("packages")
    if not isinstance(packages, list) or len(packages) > 500:
        raise BuildError("invalid", "Expected the lock's packages")
    for p in packages:
        if not (
            isinstance(p, dict)
            and set(p) == {"name", "version", "sha256"}
            and isinstance(p["name"], str)
            and NAME.match(p["name"])
            and isinstance(p["version"], str)
            and VERSION.match(p["version"])
            and isinstance(p["sha256"], str)
            and SHA256.match(p["sha256"])
        ):
            raise BuildError("invalid", "A package in the lock isn't {name, version, sha256}")
    if lock["platform"] != PLATFORM:
        raise BuildError("platform", f"The lock is for {lock['platform']}; this builder installs for {PLATFORM}")
    return {"platform": lock["platform"], "packages": packages}


def env_lock(eid):
    with env_locks_guard:
        return env_locks.setdefault(eid, threading.Lock())


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def touch(path):
    with open(path, "a"):
        pass
    os.utime(path)


def install(lock, deadline):
    """The lock's env on the volume (installed unless it's there): (envId, size, cached, pip's output)."""
    eid = env_id(lock)
    final = os.path.join(ENVS, eid)
    with env_lock(eid):
        if os.path.isfile(os.path.join(final, "lock.json")):
            touch(os.path.join(final, "used"))
            return eid, dir_size(os.path.join(final, "site")), True, ""
        base, index = pip_args()
        tmp = tempfile.mkdtemp(prefix=".tmp-", dir=ENVS)
        try:
            output = ""
            site = os.path.join(tmp, "site")
            if lock["packages"]:
                reqs = os.path.join(tmp, "requirements.txt")
                with open(reqs, "w") as f:
                    for p in lock["packages"]:
                        f.write(f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}\n")
                code, output = pip(
                    base
                    + ["install", "--no-deps", "--require-hashes", "--only-binary", ":all:", "--target", site, "--quiet"]
                    + index
                    + ["-r", reqs],
                    deadline,
                )
                os.unlink(reqs)
                if code != 0:
                    raise BuildError("install", first_error(output) or "pip couldn't install the packages", output)
            else:
                os.makedirs(site)
            size = dir_size(site)
            if size > MAX_ENV_BYTES:
                raise BuildError(
                    "too_big",
                    f"The packages take {size / 1024 / 1024:.0f} MB, over the {MAX_ENV_BYTES / 1024 / 1024:.0f} MB allowed",
                    output,
                )
            with open(os.path.join(tmp, "lock.json"), "w") as f:
                json.dump(lock, f, sort_keys=True, indent=2)
            touch(os.path.join(tmp, "used"))
            # Readable by the jail's user (nobody), never writable.
            for root, dirs, files in os.walk(tmp):
                for d in dirs:
                    os.chmod(os.path.join(root, d), 0o755)
                for name in files:
                    path = os.path.join(root, name)
                    if not os.path.islink(path):
                        os.chmod(path, 0o644 if not os.access(path, os.X_OK) else 0o755)
            os.chmod(tmp, 0o755)
            os.rename(tmp, final)
            return eid, size, False, output
        finally:
            if os.path.exists(tmp):
                shutil.rmtree(tmp, ignore_errors=True)


def clean():
    """Removes envs unused for KEEP_DAYS, and temporary directories a crash left behind."""
    now = time.time()
    for name in os.listdir(ENVS):
        path = os.path.join(ENVS, name)
        try:
            if name.startswith(".tmp-"):
                if now - os.stat(path).st_mtime > BUILD_TIMEOUT_S * 2:
                    shutil.rmtree(path, ignore_errors=True)
                continue
            used = os.path.join(path, "used")
            if os.path.isfile(used) and now - os.stat(used).st_mtime > KEEP_DAYS * 86400:
                with env_lock(name):
                    shutil.rmtree(path, ignore_errors=True)
                log("env_removed", envId=name)
        except OSError:
            pass


def cleaner():
    while True:
        clean()
        time.sleep(3600)


class Handler(BaseHTTPRequestHandler):
    server_version = "ow-python-builder"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def refuse(self, status, message):
        self.close_connection = True  # the body may not have been read
        self.send_json(status, {"error": {"message": message}})

    def authorized(self):
        given = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(given.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):
        if self.path != "/health":
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        self.send_json(HTTPStatus.OK, {"ok": True, "python": PYTHON_VERSION, "platform": PLATFORM, "pip": PIP_VERSION})

    def do_POST(self):
        if self.path not in ("/build", "/install"):
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        if not self.authorized():
            return self.refuse(HTTPStatus.UNAUTHORIZED, "A valid bearer token is required")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if 0 < length <= 1024 * 1024 else None
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.refuse(HTTPStatus.BAD_REQUEST, "Send a JSON object of at most 1 MB")
        if self.path == "/build":
            requirements = body.get("requirements")
            if (
                not isinstance(requirements, list)
                or len(requirements) > MAX_REQUIREMENTS
                or not all(isinstance(r, str) and len(r) <= 200 and REQUIREMENT.match(r.strip()) for r in requirements)
            ):
                return self.refuse(HTTPStatus.BAD_REQUEST, f"Expected requirements: at most {MAX_REQUIREMENTS} names with versions")
        started = time.monotonic()
        deadline = started + BUILD_TIMEOUT_S
        if not builds.acquire(timeout=BUILD_TIMEOUT_S):
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The builder is busy; try again")
        output = ""
        try:
            if self.path == "/build":
                lock, output = resolve([r.strip() for r in body["requirements"]], deadline)
            else:
                lock = check_lock(body.get("lock"))
            eid, size, cached, install_output = install(lock, deadline)
            output += install_output
            answer = {"ok": True, "envId": eid, "sizeBytes": size, "cached": cached, "log": scrub(output)}
            if self.path == "/build":
                answer["lock"] = lock
        except BuildError as exc:
            output += exc.output
            answer = {"ok": False, "error": {"kind": exc.kind, "message": scrub(str(exc))}, "log": scrub(output)}
        except OSError as exc:  # the volume (full, not writable)
            answer = {"ok": False, "error": {"kind": "install", "message": f"The env couldn't be written: {exc}"}, "log": scrub(output)}
        finally:
            builds.release()
        error = answer.get("error")
        log(
            "build" if self.path == "/build" else "install",
            ms=round((time.monotonic() - started) * 1000),
            ok=answer["ok"],
            error=error and error["kind"],
            envId=answer.get("envId"),
            cached=answer.get("cached"),
            packages=[f"{p['name']}=={p['version']}" for p in answer["lock"]["packages"]] if "lock" in answer else None,
        )
        self.send_json(HTTPStatus.OK, answer)


PYTHON_VERSION = sys.version.split()[0]
PIP_VERSION = ""


def main():
    global PIP_VERSION
    if not TOKEN or len(TOKEN) < 16:
        sys.exit("PYTHON_BUILDER_TOKEN must be set (16 characters or more)")
    os.makedirs(ENVS, exist_ok=True)
    try:
        PIP_VERSION = importlib.metadata.version("pip")
    except importlib.metadata.PackageNotFoundError:
        pass
    threading.Thread(target=cleaner, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log("listening", port=PORT, platform=PLATFORM, index=scrub(INDEX_URL), max_builds=MAX_BUILDS, envs=ENVS)
    server.serve_forever()


if __name__ == "__main__":
    main()
