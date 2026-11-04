"""
The Python package builder (M23, docs/architecture.md §2.26): installs a workflow's packages into an env on a volume
the code executor reads, so its Python blocks can import them. It alone has network access; it runs no package's code
(wheels only).

  POST /build    {"requirements": ["polars==1.9.0", ...]}
                 -> {"ok": true, "lock": {...}, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  POST /install  {"lock": {...}}  (a lock /build gave: installs exactly it, without resolving)
                 -> {"ok": true, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  POST /check-index {"index": {...}}  (M32: whether an index answers, and takes its sign-in)
                 -> {"ok": true, "status": 200} or {"ok": false, "status": 401, "message": "..."}
  GET  /health   -> {"ok": true, "python": "3.12.x", "platform": "cp312-linux-aarch64", "pip": "..."}

/build and /install also take `indexes` (M32): [{"name", "url", "username"?, "password"?, "mode"}], an admin's
package indexes, `primary` (instead of PYTHON_PACKAGE_INDEX_URL) or `extra` (searched with it). They're used for that
request only: their credentials reach pip through its environment, never its command line, the lock, an env or a
log. A lock's package from a named index says so (`"index": "<name>"`); /install needs those indexes again.

Failures answer 200 with {"ok": false, "error": {"kind", "message"}, "log"}: kind `resolve` (no such package or
version, or no wheel), `install`, `too_big`, `timeout`, `platform` (a lock made elsewhere) or `invalid`. Every request
but /health needs `Authorization: Bearer <PYTHON_BUILDER_TOKEN>`.

A lock is {"platform", "packages": [{"name", "version", "sha256", "index"?}]}, sorted by name; its env is `envs/<envId>/site`
(envId: the lock's hash), with `lock.json` beside it and `used` touched whenever a build or install names it. Envs
unused for PYTHON_ENV_KEEP_DAYS are removed: their locks rebuild them.
"""

import base64
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
import urllib.error
import urllib.parse
import urllib.request
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
# Indexes over http (a local mirror, the tests' index): only when allowed (M32).
ALLOW_INSECURE = os.environ.get("PYTHON_ALLOW_INSECURE_INDEXES", "").lower() in ("1", "true", "yes")
MAX_INDEXES = 5
# The workflow editor allows 30; a release moved to another platform comes back as its lock, every package pinned.
MAX_REQUIREMENTS = 500
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
INDEX_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,62})$")


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


PIP = [sys.executable, "-m", "pip", "--disable-pip-version-check", "--no-input", "--no-color"]


def check_indexes(raw):
    """A request's `indexes`, checked: [{name, url, username, password, mode}], or a BuildError `invalid`."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_INDEXES:
        raise BuildError("invalid", f"Expected indexes: a list of at most {MAX_INDEXES}")
    indexes = []
    for item in raw:
        if not isinstance(item, dict) or not set(item) <= {"name", "url", "username", "password", "mode"}:
            raise BuildError("invalid", "An index is {name, url, username, password, mode}")
        name, url, mode = item.get("name"), item.get("url"), item.get("mode")
        username, password = item.get("username"), item.get("password")
        if not isinstance(name, str) or not INDEX_NAME.match(name):
            raise BuildError("invalid", "An index's name is lowercase letters, digits, - and _")
        if mode not in ("primary", "extra"):
            raise BuildError("invalid", f"Index {name}: mode is primary or extra")
        for value in (username, password):
            if value is not None and (not isinstance(value, str) or not value or len(value) > 4096):
                raise BuildError("invalid", f"Index {name}: a username or password that isn't text")
        if password is not None and username is None:
            raise BuildError("invalid", f"Index {name}: a password needs a username")
        parts = urllib.parse.urlsplit(url) if isinstance(url, str) and len(url) <= 2048 else None
        if (
            parts is None
            or parts.scheme not in ("https", "http")
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise BuildError("invalid", f"Index {name}: expected an http(s) URL without credentials, query or fragment")
        if parts.scheme == "http" and not ALLOW_INSECURE:
            raise BuildError("invalid", f"Index {name}: http isn't allowed here (PYTHON_ALLOW_INSECURE_INDEXES)")
        indexes.append({"name": name, "url": url.rstrip("/"), "username": username, "password": password, "mode": mode})
    if len({i["name"] for i in indexes}) != len(indexes):
        raise BuildError("invalid", "Two indexes have the same name")
    if sum(1 for i in indexes if i["mode"] == "primary") > 1:
        raise BuildError("invalid", "At most one index replaces the default one (primary)")
    return indexes


def with_auth(index):
    """The index's URL with its credentials in it, for pip's environment only."""
    if index["username"] is None:
        return index["url"]
    parts = urllib.parse.urlsplit(index["url"])
    auth = urllib.parse.quote(index["username"], safe="")
    if index["password"] is not None:
        auth += ":" + urllib.parse.quote(index["password"], safe="")
    return urllib.parse.urlunsplit((parts.scheme, f"{auth}@{parts.netloc}", parts.path, "", ""))


def index_env(main, extras):
    """pip's index settings as environment variables (a process's environment, unlike its command line, isn't
    readable by other users): `main` an index or None for the default, then the extra ones."""
    urls = [INDEX_URL if main is None else main["url"], *(i["url"] for i in extras)]
    env = {"PIP_INDEX_URL": INDEX_URL if main is None else with_auth(main)}
    if extras:
        env["PIP_EXTRA_INDEX_URL"] = " ".join(with_auth(i) for i in extras)
    # An http index someone configured on purpose (a local mirror).
    trusted = sorted({urllib.parse.urlsplit(u).hostname for u in urls if urllib.parse.urlsplit(u).scheme == "http"})
    if trusted:
        env["PIP_TRUSTED_HOST"] = " ".join(h for h in trusted if h)
    return env


def resolve_env(indexes):
    primary = next((i for i in indexes if i["mode"] == "primary"), None)
    return index_env(primary, [i for i in indexes if i["mode"] == "extra"])


def install_env(lock, indexes):
    """The indexes a lock's packages came from (each pinned by its hash, so one pip call may search them all)."""
    by_name = {i["name"]: i for i in indexes}
    named = []
    for p in lock["packages"]:
        if "index" in p:
            if p["index"] not in by_name:
                raise BuildError("invalid", f"The lock needs the package index {p['index']}, which wasn't sent")
            if by_name[p["index"]] not in named:
                named.append(by_name[p["index"]])
    if any("index" not in p for p in lock["packages"]) or not named:
        return index_env(None, named)
    return index_env(named[0], named[1:])


def pip(args, deadline, env=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BuildError("timeout", f"The build took longer than {BUILD_TIMEOUT_S:.0f} s")
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=remaining, env={**pip_env(), **(env or {})})
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") + (exc.stderr or "")
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        raise BuildError("timeout", f"The build took longer than {BUILD_TIMEOUT_S:.0f} s", output) from None
    return done.returncode, done.stdout + done.stderr


def pip_env():
    # Nothing of the builder's environment but what pip needs: no token.
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/tmp", "PIP_CACHE_DIR": "/tmp/pip-cache", "LANG": "C.UTF-8"}


def resolve(requirements, deadline, indexes=()):
    """The requirements as a lock: every package pip would install, its version, its wheel's hash and, for one from
    a named index, that index."""
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "report.json")
        code, output = pip(
            PIP
            + ["install", "--dry-run", "--ignore-installed", "--only-binary", ":all:", "--report", report, "--quiet"]
            + requirements,  # none starts with "-" (checked): not taken for options
            deadline,
            resolve_env(indexes),
        )
        if code != 0:
            raise BuildError("resolve", index_refusal(indexes, deadline) or first_error(output) or "pip couldn't resolve the packages", output)
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
    attribute(packages, indexes, deadline)
    return {"platform": PLATFORM, "packages": packages}, output


def attribute(packages, indexes, deadline):
    """Each package's index, when it's a named one: with a primary index only, all of them; else the named index
    whose page for the package lists its file's hash (the default index's packages have none)."""
    if not indexes:
        return
    primary = next((i for i in indexes if i["mode"] == "primary"), None)
    extras = [i for i in indexes if i["mode"] == "extra"]
    for p in packages:
        found = None
        for index in extras:
            if p["sha256"] in index_page(index, p["name"], deadline):
                found = index
                break
        if found is None:
            found = primary
        if found is not None:
            p["index"] = found["name"]


def index_request(index, url, deadline):
    request = urllib.request.Request(url, headers={"Accept": "text/html", "User-Agent": "ow-python-builder"})
    if index["username"] is not None:
        token = f"{index['username']}:{index['password'] or ''}".encode()
        request.add_header("Authorization", "Basic " + base64.b64encode(token).decode())
    timeout = max(1, min(30, deadline - time.monotonic()))
    return urllib.request.urlopen(request, timeout=timeout)


def index_page(index, name, deadline):
    """The index's simple page for a package (PEP 503), or "" when it has none."""
    try:
        with index_request(index, f"{index['url']}/{normalize(name)}/", deadline) as res:
            return res.read(8 * 1024 * 1024).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return ""


def probe(index, deadline):
    """The index's root page, signed in: (ok, status, message) for Test and for a failed build."""
    try:
        with index_request(index, index["url"] + "/", deadline) as res:
            status = res.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, None, f"Couldn't reach the index: {getattr(exc, 'reason', exc)}"
    if status in (401, 403):
        if index["username"] is None:
            return False, status, "The index wants a sign-in: add a username and password"
        return False, status, "The index refused the sign-in: check the username and password"
    if status >= 400 and status != 404:
        return False, status, f"The index answered {status}"
    # 404: signed in, but its root lists nothing (some private indexes): packages' pages still answer.
    return True, status, None


def index_refusal(indexes, deadline):
    """When a build fails: a named index that refuses its sign-in or can't be reached says so (pip, quiet, often
    only says it found nothing)."""
    for index in indexes:
        ok, _status, message = probe(index, min(deadline, time.monotonic() + 20))
        if not ok:
            return f"Package index {index['name']}: {message[0].lower()}{message[1:]}"
    return None


def hide(text, body):
    """The text without any password a request's indexes carry (pip may echo one, decoded or not)."""
    raw = body.get("indexes") if isinstance(body.get("indexes"), list) else [body.get("index")]
    for index in raw:
        password = index.get("password") if isinstance(index, dict) else None
        if isinstance(password, str) and len(password) >= 3:
            for form in {password, urllib.parse.quote(password, safe="")}:
                text = text.replace(form, "***")
    return text


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
            and {"name", "version", "sha256"} <= set(p) <= {"name", "version", "sha256", "index"}
            and ("index" not in p or (isinstance(p["index"], str) and INDEX_NAME.match(p["index"])))
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


def installed(eid):
    """The env's size when it's on the volume (touched, as it's used), else None. Call under its env lock."""
    final = os.path.join(ENVS, eid)
    if not os.path.isfile(os.path.join(final, "lock.json")):
        return None
    touch(os.path.join(final, "used"))
    try:
        with open(os.path.join(final, "size")) as f:
            return int(f.read())
    except (OSError, ValueError):  # an env from before the size was kept: walked once, then kept
        size = dir_size(os.path.join(final, "site"))
        try:
            with open(os.path.join(final, "size"), "w") as f:
                f.write(str(size))
        except OSError:
            pass
        return size


def cached(lock):
    """(envId, size) when the lock's env is there already: no build slot needed for that."""
    eid = env_id(lock)
    with env_lock(eid):
        size = installed(eid)
    return None if size is None else (eid, size)


def install(lock, deadline, indexes=()):
    """The lock's env on the volume (installed unless it's there): (envId, size, cached, pip's output)."""
    eid = env_id(lock)
    final = os.path.join(ENVS, eid)
    with env_lock(eid):
        size = installed(eid)
        if size is not None:
            return eid, size, True, ""
        env = install_env(lock, indexes)
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
                    PIP
                    + ["install", "--no-deps", "--require-hashes", "--only-binary", ":all:", "--target", site, "--quiet"]
                    + ["-r", reqs],
                    deadline,
                    env,
                )
                os.unlink(reqs)
                if code != 0:
                    raise BuildError("install", index_refusal(indexes, deadline) or first_error(output) or "pip couldn't install the packages", output)
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
            with open(os.path.join(tmp, "size"), "w") as f:
                f.write(str(size))
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


def unused(used, now):
    """Whether an env's `used` file is older than KEEP_DAYS."""
    return os.path.isfile(used) and now - os.stat(used).st_mtime > KEEP_DAYS * 86400


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
            if not unused(used, now):
                continue
            with env_lock(name):
                # Again under the lock: an install may have used it since.
                if not unused(used, now):
                    continue
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

    def answer(self, body):
        """The request's answer; None when no build slot came free. An env that's there needs no slot (most
        installs are a run checking its env); the build's own time counts from its slot."""
        output = ""
        try:
            lock = None
            indexes = check_indexes(body.get("indexes"))
            if self.path == "/install":
                lock = check_lock(body.get("lock"))
                there = cached(lock)
                if there:
                    return {"ok": True, "envId": there[0], "sizeBytes": there[1], "cached": True, "log": ""}
            if not builds.acquire(timeout=BUILD_TIMEOUT_S):
                return None
            try:
                deadline = time.monotonic() + BUILD_TIMEOUT_S
                if self.path == "/build":
                    lock, output = resolve([r.strip() for r in body["requirements"]], deadline, indexes)
                eid, size, was_cached, install_output = install(lock, deadline, indexes)
            finally:
                builds.release()
            output += install_output
            answer = {"ok": True, "envId": eid, "sizeBytes": size, "cached": was_cached, "log": hide(scrub(output), body)}
            if self.path == "/build":
                answer["lock"] = lock
            return answer
        except BuildError as exc:
            output += exc.output
            return {"ok": False, "error": {"kind": exc.kind, "message": hide(scrub(str(exc)), body)}, "log": hide(scrub(output), body)}
        except OSError as exc:  # the volume (full, not writable)
            return {
                "ok": False,
                "error": {"kind": "install", "message": f"The env couldn't be written: {exc}"},
                "log": scrub(output),
            }

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

    def check_index(self, body):
        """POST /check-index: the index's root page, signed in; what its answer means for the Settings page."""
        try:
            index = check_indexes([body.get("index")])[0]
        except BuildError as exc:
            return self.refuse(HTTPStatus.BAD_REQUEST, str(exc))
        ok, status, message = probe(index, time.monotonic() + 20)
        answer = {"ok": ok, "status": status}
        if message:
            answer["message"] = hide(scrub(message), body)
        return self.send_json(HTTPStatus.OK, answer)

    def do_POST(self):
        if self.path not in ("/build", "/install", "/check-index"):
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
        if self.path == "/check-index":
            return self.check_index(body)
        if self.path == "/build":
            requirements = body.get("requirements")
            if (
                not isinstance(requirements, list)
                or len(requirements) > MAX_REQUIREMENTS
                or not all(isinstance(r, str) and len(r) <= 200 and REQUIREMENT.match(r.strip()) for r in requirements)
            ):
                return self.refuse(HTTPStatus.BAD_REQUEST, f"Expected requirements: at most {MAX_REQUIREMENTS} names with versions")
        started = time.monotonic()
        answer = self.answer(body)
        if answer is None:
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The builder is busy; try again")
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
