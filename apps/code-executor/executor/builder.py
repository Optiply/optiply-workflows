"""
The Python package builder (M23, docs/architecture.md §2.26): installs a workflow's packages into an env on a volume
the code executor reads, so its Python blocks can import them. It alone has network access; it runs no package's code
(wheels only).

  POST /build    {"requirements": ["polars==1.9.0", ...]}
                 -> {"ok": true, "lock": {...}, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  POST /install  {"lock": {...}}  (a lock /build gave: installs exactly it, without resolving)
                 -> {"ok": true, "envId": "...", "sizeBytes": n, "cached": bool, "log": "..."}
  POST /check-index {"index": {...}, "package"?: "name"}  (M32: whether an index answers, and takes its sign-in;
                 with a package, its page instead of the root, for indexes that list nothing there)
                 -> {"ok": true, "status": 200} or {"ok": false, "status": 401, "message": "..."}
  POST /build-npm {"dependencies": {"acme-sdk": "^2.1.0"}, "registries": [{"scope": "@acme" | null, "url", "token"?}]}
                 (M37: an SDK resource's JavaScript packages) -> {"ok": true, "envId", "lock": {"node", "dependencies",
                 "packages": {name: version}}, "sizeBytes", "cached", "log"}
  GET  /health   -> {"ok": true, "python": "3.12.x", "platform": "cp312-linux-aarch64", "pip": "...", "node": "v24…"}

/build and /install also take `indexes` (M32): [{"name", "url", "username"?, "password"?, "mode"}], an admin's
package indexes, `primary` (instead of PYTHON_PACKAGE_INDEX_URL) or `extra` (searched with it). They're used for that
request only: their credentials reach pip through its environment, never its command line, the lock, an env or a
log. A lock's package from a named index says so (`"index": "<name>"`); /install needs those indexes again.

Failures answer 200 with {"ok": false, "error": {"kind", "message"}, "log"}: kind `resolve` (no such package or
version, or no wheel), `install`, `too_big`, `timeout`, `platform` (a lock made elsewhere) or `invalid`. Every request
but /health needs `Authorization: Bearer <PYTHON_BUILDER_TOKEN>`.

Packages without a wheel (M32): when pip finds no wheel for a requirement, the builder looks for its sdist on the same
indexes, downloads it itself (no package code runs to read its metadata), downloads its declared build requirements as
wheels, and builds the wheel in nsjail (sdist-jail.cfg: no network, no token, not the envs volume). Built wheels are
kept by the sdist's hash (`envs/.wheels/<sha256>/`); resolving then runs again with them. In the lock such a package
has its sdist's hash and `"source": "sdist"`. Failures of that build are kind `sdist`.

JavaScript envs (M37) are `envs/node/<envId>/node_modules` (envId: the hash of the dependencies, the registries' scopes
and URLs, and Node's major version), installed by npm without install scripts (`--ignore-scripts`: no package code
runs here), with `lock.json` and `used` beside them; the registries' tokens reach npm through a userconfig file
outside the env, removed after. Failures as /build's, kinds `resolve`, `install`, `too_big`, `timeout`, `invalid`.

A lock is {"platform", "packages": [{"name", "version", "sha256", "index"?, "source"?}]}, sorted by name; its env is `envs/<envId>/site`
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
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
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
# sdists (M32): built in nsjail with these limits; at most this many per build.
HERE = os.path.dirname(os.path.abspath(__file__))
NSJAIL = os.environ.get("NSJAIL", "/usr/local/bin/nsjail")
SDIST_JAIL = os.path.join(HERE, "sdist-jail.cfg")
SDIST_MEMORY_MB = int(os.environ.get("PYTHON_SDIST_MEMORY_MB", "2048"))
SDIST_TIMEOUT_S = float(os.environ.get("PYTHON_SDIST_TIMEOUT_SECONDS", "300"))
MAX_SDISTS = int(os.environ.get("PYTHON_MAX_SDISTS", "10"))
MAX_SDIST_BYTES = 256 * 1024 * 1024
WHEELS = os.path.join(ENVS, ".wheels")
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
    """The requirements as a lock: every package pip would install, its version, its wheel's hash (or its sdist's,
    for one built here) and, for one from a named index, that index. A requirement pip finds no wheel for is built
    from its sdist, then resolving runs again with the wheels built so far."""
    built = {}  # canonical name -> the sdist it was built from
    logs = []
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "report.json")
        found = os.path.join(tmp, "built")
        os.mkdir(found)
        while True:
            code, output = pip(
                PIP
                + ["install", "--dry-run", "--ignore-installed", "--only-binary", ":all:", "--report", report, "--quiet"]
                + ["--find-links", found]
                + requirements,  # none starts with "-" (checked): not taken for options
                deadline,
                resolve_env(indexes),
            )
            logs.append(output)
            if code == 0:
                break
            missing = no_wheel(output)
            sdist = None
            if missing is not None and canonical(missing.name) not in built and len(built) < MAX_SDISTS:
                sdist = find_sdist(missing, indexes, deadline)
            if sdist is None:
                message = index_refusal(indexes, deadline) or first_error(output) or "pip couldn't resolve the packages"
                raise BuildError("resolve", message, "".join(logs))
            wheel, build_log = sdist_wheel(sdist, indexes, deadline)
            logs.append(build_log)
            shutil.copy(wheel, found)
            built[canonical(sdist["name"])] = sdist
        with open(report) as f:
            data = json.load(f)
    output = "".join(logs)
    packages = []
    urls = {}  # canonical name -> where pip would download it from
    for item in data.get("install", []):
        name = item["metadata"]["name"]
        sdist = built.get(canonical(name))
        url = (item.get("download_info") or {}).get("url", "")
        urls[canonical(name)] = url
        if sdist and url.startswith("file:"):
            entry = {"name": name, "version": item["metadata"]["version"], "sha256": sdist["sha256"], "source": "sdist"}
            if sdist["index"] is not None:
                entry["index"] = sdist["index"]
            packages.append(entry)
            continue
        info = item.get("download_info") or {}
        hashes = (info.get("archive_info") or {}).get("hashes") or {}
        sha = hashes.get("sha256")
        if not sha:
            legacy = (info.get("archive_info") or {}).get("hash", "")
            sha = legacy.split("=", 1)[1] if legacy.startswith("sha256=") else None
        if not sha:
            raise BuildError("resolve", f"The index gave no sha256 for {name}", output)
        packages.append({"name": name, "version": item["metadata"]["version"], "sha256": sha})
    packages.sort(key=lambda p: normalize(p["name"]))
    attribute(packages, urls, indexes, deadline)
    return {"platform": PLATFORM, "packages": packages}, output


def canonical(name):
    return normalize(name)


def no_wheel(output):
    """The requirement pip found no wheel for (`Could not find a version that satisfies the requirement X`), parsed,
    or None."""
    from pip._vendor.packaging.requirements import InvalidRequirement, Requirement

    match = re.search(r"Could not find a version that satisfies the requirement (\S+)", output)
    if not match:
        return None
    try:
        requirement = Requirement(match.group(1))
    except InvalidRequirement:
        return None
    return None if requirement.url else requirement


def default_index():
    """PYTHON_PACKAGE_INDEX_URL as an index (its credentials, if the URL carries them, taken out)."""
    parts = urllib.parse.urlsplit(INDEX_URL)
    netloc = parts.netloc.rsplit("@", 1)[-1]
    url = urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", "")).rstrip("/")
    username = urllib.parse.unquote(parts.username) if parts.username else None
    password = urllib.parse.unquote(parts.password) if parts.password else None
    return {"name": None, "url": url, "username": username, "password": password, "mode": "primary"}


def sources(indexes):
    """Where pip looks, in its order: the primary index (a named one, or the default), then the extra ones."""
    primary = next((i for i in indexes if i["mode"] == "primary"), None) or default_index()
    return [primary, *(i for i in indexes if i["mode"] == "extra")]


def sdist_links(index, name, deadline):
    """The sdists on an index's page for a package: [{name, version, sha256, url, filename}] (yanked ones left out)."""
    from pip._vendor.packaging.utils import InvalidSdistFilename, parse_sdist_filename

    page, base = index_page(index, name, deadline)
    links = []
    for anchor, text in re.findall(r"<a\s([^>]*)>([^<]*)</a>", page, re.IGNORECASE):
        href = re.search(r'href\s*=\s*"([^"]*)"', anchor)
        if not href or "data-yanked" in anchor:
            continue
        filename = text.strip()
        if not filename.endswith((".tar.gz", ".zip")):
            continue
        sha = re.search(r"#sha256=([0-9a-f]{64})", href.group(1))
        if not sha:
            continue
        try:
            project, version = parse_sdist_filename(filename)
        except (InvalidSdistFilename, ValueError):
            continue
        if canonical(project) != canonical(name):
            continue
        url = urllib.parse.urljoin(base, href.group(1).split("#", 1)[0].replace("&amp;", "&"))
        links.append({"name": name, "version": version, "sha256": sha.group(1), "url": url, "filename": filename})
    return links


def find_sdist(requirement, indexes, deadline):
    """The newest sdist the requirement allows on the indexes pip searched (the first index on a tie), or None."""
    best = None
    for index in sources(indexes):
        for link in sdist_links(index, requirement.name, deadline):
            if not requirement.specifier.contains(link["version"], prereleases=None):
                continue
            if best is None or link["version"] > best["version"]:
                best = {**link, "index": index["name"], "source": index}
    if best:
        best["version"] = str(best["version"])
    return best


def fetch(index, url, sha, dest, deadline):
    """Downloads an sdist, checking its hash; the index's sign-in only goes to the index's own host."""
    digest = hashlib.sha256()
    size = 0
    try:
        with index_request(index, url, deadline) as res, open(dest, "wb") as f:
            while chunk := res.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SDIST_BYTES:
                    raise BuildError("sdist", f"The sdist {os.path.basename(dest)} is over 256 MB")
                digest.update(chunk)
                f.write(chunk)
    except (urllib.error.URLError, OSError) as exc:
        raise BuildError("sdist", f"Couldn't download {os.path.basename(dest)}: {getattr(exc, 'reason', exc)}") from None
    if digest.hexdigest() != sha:
        raise BuildError("sdist", f"{os.path.basename(dest)} doesn't match its sha256 on the index")


def build_requirements(path):
    """The sdist's `build-system.requires` from its pyproject.toml (setuptools' defaults without one), read from the
    archive without unpacking it."""
    import tomllib

    from pip._vendor.packaging.requirements import InvalidRequirement, Requirement

    data = None
    try:
        if path.endswith(".zip"):
            with zipfile.ZipFile(path) as z:
                names = [n for n in z.namelist() if n.count("/") == 1 and n.endswith("/pyproject.toml")]
                data = z.read(names[0]) if names else None
        else:
            with tarfile.open(path, "r:gz") as t:
                member = next((m for m in t.getmembers() if m.isfile() and m.name.count("/") == 1 and m.name.endswith("/pyproject.toml")), None)
                data = t.extractfile(member).read() if member else None
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError) as exc:
        raise BuildError("sdist", f"{os.path.basename(path)} isn't a readable archive: {exc}") from None
    system = None
    if data is not None:
        try:
            system = tomllib.loads(data.decode("utf-8")).get("build-system")
        except (tomllib.TOMLDecodeError, UnicodeDecodeError) as exc:
            raise BuildError("sdist", f"{os.path.basename(path)}'s pyproject.toml can't be read: {exc}") from None
    requires = system.get("requires") if isinstance(system, dict) else None
    if requires is None:
        requires = ["setuptools>=40.8.0", "wheel"]
    if not isinstance(requires, list) or len(requires) > 50 or not all(isinstance(r, str) for r in requires):
        raise BuildError("sdist", f"{os.path.basename(path)}'s build-system.requires isn't a list of requirements")
    for r in requires:
        try:
            if Requirement(r).url:
                raise BuildError("sdist", f"{os.path.basename(path)} needs {r} to build: URLs aren't allowed")
        except InvalidRequirement:
            raise BuildError("sdist", f"{os.path.basename(path)}'s build requirement {r!r} isn't one") from None
    return requires


def cached_wheel(sha):
    """The wheel built from the sdist with this hash, when it's kept (touched, as it's used)."""
    folder = os.path.join(WHEELS, sha)
    try:
        wheels = [n for n in os.listdir(folder) if n.endswith(".whl")]
    except OSError:
        return None
    if len(wheels) != 1:
        return None
    os.utime(folder)
    return os.path.join(folder, wheels[0])


def sdist_wheel(sdist, indexes, deadline):
    """The wheel for an sdist ({name, version, sha256, url, filename, source}): kept, or built now. (path, log)"""
    with env_lock(f"sdist-{sdist['sha256']}"):
        wheel = cached_wheel(sdist["sha256"])
        if wheel:
            return wheel, f"{sdist['name']} {sdist['version']}: built from source before\n"
        with tempfile.TemporaryDirectory(prefix="sdist-") as tmp:
            src, wheelhouse, out = (os.path.join(tmp, d) for d in ("src", "wheelhouse", "out"))
            for d in (src, wheelhouse, out):
                os.mkdir(d)
            path = os.path.join(src, sdist["filename"])
            fetch(sdist["source"], sdist["url"], sdist["sha256"], path, deadline)
            log_text = f"{sdist['name']} {sdist['version']}: no wheel, building {sdist['filename']} from source\n"
            requires = build_requirements(path)
            if requires:
                code, output = pip(
                    PIP + ["download", "--only-binary", ":all:", "--dest", wheelhouse, "--quiet", *requires],
                    deadline,
                    resolve_env(indexes),
                )
                log_text += output
                if code != 0:
                    raise BuildError(
                        "sdist",
                        f"{sdist['name']}'s build requirements ({', '.join(requires)}) couldn't be downloaded as wheels: "
                        + (first_error(output) or "pip found none"),
                        log_text,
                    )
            log_text += jail_build(sdist, path, wheelhouse, out, deadline)
            wheels = [n for n in os.listdir(out) if n.endswith(".whl")]
            if len(wheels) != 1:
                raise BuildError("sdist", f"Building {sdist['filename']} gave no wheel", log_text)
            check_built(sdist, wheels[0], log_text)
            os.makedirs(WHEELS, mode=0o700, exist_ok=True)
            keep = tempfile.mkdtemp(prefix=".tmp-", dir=WHEELS)
            shutil.copy(os.path.join(out, wheels[0]), keep)
            final = os.path.join(WHEELS, sdist["sha256"])
            try:
                os.rename(keep, final)
            except OSError:
                # There already: kept by another build, or broken (a crash, a cleaning half done): replaced then.
                if cached_wheel(sdist["sha256"]) is None:
                    shutil.rmtree(final, ignore_errors=True)
                    try:
                        os.rename(keep, final)
                    except OSError:
                        pass
                shutil.rmtree(keep, ignore_errors=True)
            wheel = cached_wheel(sdist["sha256"])
            if wheel is None:
                raise BuildError("sdist", f"The wheel built from {sdist['filename']} couldn't be kept", log_text)
            return wheel, log_text


def check_built(sdist, filename, log_text):
    """The wheel an sdist built is that project at that version (a build naming another one would shadow it)."""
    from pip._vendor.packaging.utils import InvalidWheelFilename, parse_wheel_filename
    from pip._vendor.packaging.version import Version

    try:
        project, version, _build, _tags = parse_wheel_filename(filename)
    except InvalidWheelFilename:
        raise BuildError("sdist", f"Building {sdist['filename']} gave {filename}, not a wheel's name", log_text) from None
    if canonical(project) != canonical(sdist["name"]) or version != Version(sdist["version"]):
        raise BuildError(
            "sdist",
            f"Building {sdist['filename']} gave a wheel of {project} {version}, not {sdist['name']} {sdist['version']}",
            log_text,
        )


def jail_build(sdist, path, wheelhouse, out, deadline):
    """`pip wheel` on the sdist in nsjail, offline: its build requirements from the wheelhouse only. Its output."""
    seconds = int(max(1, min(SDIST_TIMEOUT_S, deadline - time.monotonic())))
    args = [
        NSJAIL, "--config", SDIST_JAIL, "--quiet",
        "--time_limit", str(seconds),
        "--rlimit_cpu", str(seconds),
        "--rlimit_as", str(SDIST_MEMORY_MB),
        "--bindmount_ro", f"{os.path.dirname(path)}:/src",
        "--bindmount_ro", f"{wheelhouse}:/wheelhouse",
        "--bindmount", f"{out}:/out",
        "--",
        "/usr/local/bin/python3", "-I", "-m", "pip", "wheel", "--no-index", "--find-links", "/wheelhouse",
        "--no-deps", "--wheel-dir", "/out", f"/src/{os.path.basename(path)}",
    ]  # fmt: skip
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=seconds + 10, env={"PATH": "/usr/bin:/bin"})
    except subprocess.TimeoutExpired:
        raise BuildError("timeout", f"Building {sdist['filename']} took longer than {seconds} s") from None
    output = done.stdout + done.stderr
    if done.returncode != 0:
        asked = re.search(r"No matching distribution found for (\S+)", output)
        if asked:
            message = (
                f"{sdist['name']}'s build asked for {asked.group(1)}, which its pyproject.toml's build-system.requires "
                "doesn't declare (builds are offline: only what it declares is there)"
            )
        else:
            message = f"Building {sdist['name']} {sdist['version']} from source failed: " + (
                last_error(output) or f"exit {done.returncode}"
            )
        raise BuildError("sdist", message, output)
    return output


def last_error(output):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith(("ERROR:", "error:")) or "Error" in line:
            return line.removeprefix("ERROR:").strip()[:500]
    return lines[-1][:500] if lines else None


def attribute(packages, urls, indexes, deadline):
    """Each package's index, when it's a named one. Where pip would download it from names it when exactly one of
    the indexes pip searched has that URL's prefix (its URL without `/simple`); else the extra index whose page for
    the package lists its file's hash (a page that can't be read fails the build: a guess would make a lock that
    can't be installed again); else the primary one, if named (the default index's packages have none)."""
    if not indexes:
        return
    primary = next((i for i in indexes if i["mode"] == "primary"), None)
    extras = [i for i in indexes if i["mode"] == "extra"]
    searched = sources(indexes)
    for p in packages:
        if p.get("source") == "sdist":
            continue  # named (or not) by where its sdist came from
        url = urls.get(canonical(p["name"]), "")
        matches = [i for i in searched if url.startswith(index_root(i))]
        if len(matches) == 1:
            found = matches[0]
        else:
            found = None
            for index in extras:
                page, _base = index_page(index, p["name"], deadline, strict=True)
                if p["sha256"] in page:
                    found = index
                    break
            if found is None:
                found = primary
        if found is not None and found["name"] is not None:
            p["index"] = found["name"]


def index_root(index):
    """The URL an index's files are likely under: its own without a final `/simple` (`https://host/api/pypi/x/`)."""
    url = index["url"].rstrip("/")
    return (url[: -len("/simple")] if url.endswith("/simple") else url) + "/"


class SignedRedirects(urllib.request.HTTPRedirectHandler):
    """Redirects keep an index's sign-in only on the index's own host, and never from https to http (the header is
    added unredirected, so urllib's own copying leaves it out)."""

    def __init__(self, auth, host):
        super().__init__()
        self.auth = auth
        self.host = host

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and self.auth:
            target = urllib.parse.urlsplit(new.full_url)
            downgraded = urllib.parse.urlsplit(req.full_url).scheme == "https" and target.scheme == "http"
            if target.netloc == self.host and not downgraded:
                new.add_unredirected_header("Authorization", self.auth)
        return new


def index_request(index, url, deadline):
    """A GET to an index: signed in only when the URL is on the index's own host (and only there after redirects)."""
    request = urllib.request.Request(url, headers={"Accept": "text/html", "User-Agent": "ow-python-builder"})
    host = urllib.parse.urlsplit(index["url"]).netloc
    auth = None
    if index["username"] is not None and urllib.parse.urlsplit(url).netloc == host:
        token = f"{index['username']}:{index['password'] or ''}".encode()
        auth = "Basic " + base64.b64encode(token).decode()
        request.add_unredirected_header("Authorization", auth)
    timeout = max(1, min(30, deadline - time.monotonic()))
    return urllib.request.build_opener(SignedRedirects(auth, host)).open(request, timeout=timeout)


def index_page(index, name, deadline, strict=False):
    """The index's simple page for a package (PEP 503) and the URL it was served from (for its relative links): ""
    when it has none (404). Other failures: "" too, or with `strict` a BuildError."""
    url = f"{index['url']}/{normalize(name)}/"
    try:
        with index_request(index, url, deadline) as res:
            return res.read(8 * 1024 * 1024).decode("utf-8", "replace"), res.geturl()
    except urllib.error.HTTPError as exc:
        if exc.code == 404 or not strict:
            return "", url
        raise BuildError("resolve", f"Package index {index['name']} answered {exc.code} for {name}'s page") from None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        if not strict:
            return "", url
        reason = getattr(exc, "reason", exc)
        raise BuildError("resolve", f"Package index {index['name']}'s page for {name} couldn't be read: {reason}") from None


def probe(index, deadline, package=None):
    """The index's root page, or a package's page on it, signed in: (ok, status, message) for Test and for a failed
    build. A package's page is for indexes that list nothing at their root (Google's Artifact Registry)."""
    url = index["url"] + "/" + (normalize(package) + "/" if package else "")
    try:
        with index_request(index, url, deadline) as res:
            status = res.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, None, f"Couldn't reach the index: {getattr(exc, 'reason', exc)}"
    if status in (401, 403):
        if index["username"] is None:
            return False, status, "The index wants a sign-in: add a username and password"
        return False, status, "The index refused the sign-in: check the username and password"
    if status == 404 and package:
        return False, status, (
            f"The index has no package {package}: check its name and the URL (and the sign-in: some indexes, "
            "GitLab's among them, answer 404 when it's wrong)"
        )
    if status == 404:
        # Some indexes list nothing at their root (Artifact Registry); others (GitLab's) answer 404 to a wrong sign-in.
        return False, status, (
            "The index answered 404 at its root: check the URL (and the sign-in: some indexes, GitLab's among them, "
            "answer 404 when it's wrong). Some indexes, Google's Artifact Registry among them, list nothing at their "
            "root: test with a package you know is on it"
        )
    if status >= 400:
        return False, status, f"The index answered {status}"
    return True, status, None


def index_refusal(indexes, deadline):
    """When a build fails: a named index that refuses its sign-in or can't be reached says so (pip, quiet, often
    only says it found nothing)."""
    for index in indexes:
        ok, status, message = probe(index, min(deadline, time.monotonic() + 20))
        if not ok and status != 404:  # a 404 root isn't sure to be the problem: pip's own words then
            return f"Package index {index['name']}: {message[0].lower()}{message[1:]}"
    return None


def hide(text, body):
    """The text without any password a request's indexes carry (pip may echo one, decoded or not)."""
    raw = body.get("indexes") if isinstance(body.get("indexes"), list) else [body.get("index")]
    # npm registries' tokens too (M37's /build-npm).
    raw = list(raw) + [
        {"password": r.get("token")} for r in (body.get("registries") or []) if isinstance(r, dict)
    ] if isinstance(body.get("registries"), list) else raw
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
            and {"name", "version", "sha256"} <= set(p) <= {"name", "version", "sha256", "index", "source"}
            and ("index" not in p or (isinstance(p["index"], str) and INDEX_NAME.match(p["index"])))
            and p.get("source", "sdist") == "sdist"
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
                lines = []
                for p in lock["packages"]:
                    if p.get("source") == "sdist":
                        wheel, build_log = locked_sdist_wheel(p, indexes, deadline)
                        output += build_log
                        lines.append(f"{wheel} --hash=sha256:{file_sha256(wheel)}")
                    else:
                        lines.append(f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}")
                with open(reqs, "w") as f:
                    f.write("\n".join(lines) + "\n")
                code, pip_output = pip(
                    PIP
                    + ["install", "--no-deps", "--require-hashes", "--only-binary", ":all:", "--target", site, "--quiet"]
                    + ["-r", reqs],
                    deadline,
                    env,
                )
                output += pip_output
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


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def locked_sdist_wheel(package, indexes, deadline):
    """A lock's sdist-built package as a wheel: kept, or its sdist (found by its hash on its index) built again."""
    wheel = cached_wheel(package["sha256"])
    if wheel:
        return wheel, ""
    if "index" in package:
        index = next((i for i in indexes if i["name"] == package["index"]), None)
        if index is None:
            raise BuildError("invalid", f"The lock needs the package index {package['index']}, which wasn't sent")
    else:
        index = default_index()
    link = next((l for l in sdist_links(index, package["name"], deadline) if l["sha256"] == package["sha256"]), None)
    if link is None:
        raise BuildError("sdist", f"The sdist of {package['name']} {package['version']} isn't on its index any more")
    return sdist_wheel({**link, "version": package["version"], "index": index["name"], "source": index}, indexes, deadline)


def unused(used, now):
    """Whether an env's `used` file is older than KEEP_DAYS."""
    return os.path.isfile(used) and now - os.stat(used).st_mtime > KEEP_DAYS * 86400


# SDK resources' JavaScript packages (M37).
NODE_ENVS = os.path.join(ENVS, "node")
NPM_NAME = re.compile(r"^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$")
NPM_RANGE = re.compile(r"^[A-Za-z0-9.^~<>=*|+ -]{1,100}$")
NPM_SCOPE = re.compile(r"^@[a-z0-9-~][a-z0-9-._~]*$")
MAX_NPM_DEPENDENCIES = 20
ALLOW_INSECURE_NPM = os.environ.get("NPM_ALLOW_INSECURE_REGISTRIES", "").lower() in ("1", "true", "yes")
NODE_VERSION = ""


def check_npm(body):
    """The dependencies and registries, checked: names npm takes, ranges or tags (no URLs, git or paths), https
    registries (http only when allowed), tokens without spaces."""
    deps = body.get("dependencies")
    if not isinstance(deps, dict) or not 0 < len(deps) <= MAX_NPM_DEPENDENCIES:
        raise BuildError("invalid", f"Expected dependencies: 1 to {MAX_NPM_DEPENDENCIES} packages with their versions")
    for name, spec in deps.items():
        if not isinstance(name, str) or len(name) > 214 or not NPM_NAME.match(name):
            raise BuildError("invalid", f"{name!r} isn't an npm package name")
        if not isinstance(spec, str) or not NPM_RANGE.match(spec) or ":" in spec or "/" in spec:
            raise BuildError("invalid", f"{name}: {spec!r} isn't a version, range or tag")
    registries = body.get("registries") or []
    if not isinstance(registries, list) or len(registries) > 20:
        raise BuildError("invalid", "Expected registries: at most 20")
    checked = []
    for r in registries:
        if not isinstance(r, dict):
            raise BuildError("invalid", "A registry is {scope, url, token?}")
        scope, url, token = r.get("scope"), r.get("url"), r.get("token")
        if scope is not None and not (isinstance(scope, str) and NPM_SCOPE.match(scope)):
            raise BuildError("invalid", f"{scope!r} isn't an npm scope")
        parsed = urllib.parse.urlparse(url if isinstance(url, str) else "")
        if parsed.scheme not in ("https", "http") or not parsed.netloc or (parsed.scheme == "http" and not ALLOW_INSECURE_NPM):
            raise BuildError("invalid", f"{url!r} isn't an https registry URL")
        if token is not None and (not isinstance(token, str) or re.search(r"\s", token) or not token):
            raise BuildError("invalid", "A registry's token has no spaces or line breaks")
        checked.append({"scope": scope, "url": url if url.endswith("/") else url + "/", "token": token})
    return {k: deps[k] for k in sorted(deps)}, checked


def npm_env_id(deps, registries):
    key = json.dumps(
        {"deps": deps, "registries": [[r["scope"], r["url"]] for r in registries], "node": NODE_VERSION.split(".")[0]},
        sort_keys=True,
    )
    return hashlib.sha256(key.encode()).hexdigest()[:32]


def npmrc(registries):
    lines = []
    for r in registries:
        lines.append(f"{r['scope']}:registry={r['url']}" if r["scope"] else f"registry={r['url']}")
        if r["token"]:
            u = urllib.parse.urlparse(r["url"])
            path = u.path if u.path.endswith("/") else u.path + "/"
            lines.append(f"//{u.netloc}{path}:_authToken={r['token']}")
    return "\n".join(lines) + "\n"


def build_npm(body):
    deps, registries = check_npm(body)
    eid = npm_env_id(deps, registries)
    root = os.path.join(NODE_ENVS, eid)
    os.makedirs(NODE_ENVS, exist_ok=True)
    with env_lock(f"node-{eid}"):
        lock_path = os.path.join(root, "lock.json")
        if os.path.isfile(lock_path) and os.path.isdir(os.path.join(root, "node_modules")):
            touch(os.path.join(root, "used"))
            with open(lock_path) as f:
                return {"ok": True, "envId": eid, "lock": json.load(f), "sizeBytes": dir_size(root), "cached": True, "log": ""}
        if not builds.acquire(timeout=BUILD_TIMEOUT_S):
            return None
        work = home = None
        try:
            work = tempfile.mkdtemp(prefix=".tmp-", dir=NODE_ENVS)
            # The SDK runner's jails read it as nobody (mkdtemp makes it the builder's alone).
            os.chmod(work, 0o755)
            home = tempfile.mkdtemp(prefix="ow-npm-")
            with open(os.path.join(work, "package.json"), "w") as f:
                json.dump({"name": "ow-sdk-env", "private": True, "dependencies": deps}, f)
            userconfig = os.path.join(home, ".npmrc")
            with open(userconfig, "w") as f:
                f.write(npmrc(registries))
            os.chmod(userconfig, 0o600)
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home, "npm_config_cache": os.path.join(home, "cache")}
            try:
                done = subprocess.run(
                    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--no-update-notifier",
                     "--userconfig", userconfig, "--globalconfig", os.path.join(home, "global-npmrc")],
                    cwd=work, env=env, capture_output=True, text=True, timeout=BUILD_TIMEOUT_S,
                )
            except subprocess.TimeoutExpired:
                raise BuildError("timeout", f"npm didn't finish within {int(BUILD_TIMEOUT_S)} s")
            output = (done.stdout + done.stderr)[-MAX_LOG_CHARS:]
            if done.returncode != 0:
                kind = "resolve" if re.search(r"E404|ETARGET|No matching version|not in this registry", output) else "install"
                raise BuildError(kind, first_npm_error(output) or f"npm install failed (exit {done.returncode})", output)
            size = dir_size(work)
            if size > MAX_ENV_BYTES:
                raise BuildError("too_big", f"The packages take {size // (1024 * 1024)} MB, over the {MAX_ENV_BYTES // (1024 * 1024)} MB allowed", output)
            with open(os.path.join(work, "package-lock.json")) as f:
                locked = json.load(f).get("packages", {})
            packages = {
                path[len("node_modules/"):]: info.get("version")
                for path, info in locked.items()
                if path.startswith("node_modules/") and "/node_modules/" not in path[len("node_modules/"):]
            }
            lock = {"node": NODE_VERSION, "dependencies": deps, "packages": dict(sorted(packages.items()))}
            with open(os.path.join(work, "lock.json"), "w") as f:
                json.dump(lock, f)
            touch(os.path.join(work, "used"))
            shutil.rmtree(root, ignore_errors=True)
            os.rename(work, root)
            work = None
            return {"ok": True, "envId": eid, "lock": lock, "sizeBytes": size, "cached": False, "log": output}
        finally:
            builds.release()
            if home:
                shutil.rmtree(home, ignore_errors=True)
            if work:
                shutil.rmtree(work, ignore_errors=True)


def first_npm_error(output):
    for line in output.splitlines():
        if line.startswith("npm error") and not re.search(r"A complete log|^npm error\s*$", line):
            return line[len("npm error"):].strip()[:300]
    return None


def clean():
    """Removes envs unused for KEEP_DAYS, wheels built from sdists unused as long, and temporary directories a crash
    left behind."""
    now = time.time()
    try:
        kept = os.listdir(WHEELS)
    except OSError:
        kept = []
    for name in kept:
        path = os.path.join(WHEELS, name)
        try:
            limit = BUILD_TIMEOUT_S * 2 if name.startswith(".tmp-") else KEEP_DAYS * 86400
            if now - os.stat(path).st_mtime > limit:
                with env_lock(f"sdist-{name}"):
                    shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass
    # SDK resources' JavaScript envs (M37): unused ones, and a crash's temporary directories.
    try:
        node_envs = os.listdir(NODE_ENVS)
    except OSError:
        node_envs = []
    for name in node_envs:
        path = os.path.join(NODE_ENVS, name)
        try:
            if name.startswith(".tmp-"):
                if now - os.stat(path).st_mtime > BUILD_TIMEOUT_S * 2:
                    shutil.rmtree(path, ignore_errors=True)
            elif unused(os.path.join(path, "used"), now):
                with env_lock(f"node-{name}"):
                    if unused(os.path.join(path, "used"), now):
                        shutil.rmtree(path, ignore_errors=True)
                        log("env_removed", envId=name, language="javascript")
        except OSError:
            pass
    for name in os.listdir(ENVS):
        path = os.path.join(ENVS, name)
        if name in (".wheels", "node"):
            continue
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
        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "python": PYTHON_VERSION, "platform": PLATFORM, "pip": PIP_VERSION, "node": NODE_VERSION},
        )

    def check_index(self, body):
        """POST /check-index: the index's root page (or `package`'s page), signed in; what it means for Settings."""
        try:
            index = check_indexes([body.get("index")])[0]
        except BuildError as exc:
            return self.refuse(HTTPStatus.BAD_REQUEST, str(exc))
        package = body.get("package")
        if package is not None and (not isinstance(package, str) or len(package) > 200 or not NAME.match(package)):
            return self.refuse(HTTPStatus.BAD_REQUEST, "A package to test with is a package's name (e.g. requests)")
        ok, status, message = probe(index, time.monotonic() + 20, package)
        answer = {"ok": ok, "status": status}
        if message:
            answer["message"] = hide(scrub(message), body)
        return self.send_json(HTTPStatus.OK, answer)

    def build_npm(self, body):
        """POST /build-npm (M37): an SDK's JavaScript packages, installed (or found) in envs/node."""
        started = time.monotonic()
        try:
            answer = build_npm(body)
        except BuildError as exc:
            answer = {"ok": False, "error": {"kind": exc.kind, "message": hide(scrub(str(exc)), body)}, "log": hide(scrub(exc.output), body)}
        except OSError as exc:
            answer = {"ok": False, "error": {"kind": "install", "message": f"The env couldn't be written: {exc}"}, "log": ""}
        if answer is None:
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The builder is busy; try again")
        if answer.get("ok"):
            answer["log"] = hide(scrub(answer.get("log", "")), body)
        error = answer.get("error")
        log("build_npm", ms=round((time.monotonic() - started) * 1000), ok=answer["ok"], error=error and error["kind"], envId=answer.get("envId"), cached=answer.get("cached"))
        self.send_json(HTTPStatus.OK, answer)

    def do_POST(self):
        if self.path not in ("/build", "/install", "/check-index", "/build-npm"):
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
        if self.path == "/build-npm":
            return self.build_npm(body)
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
    global PIP_VERSION, NODE_VERSION
    if not TOKEN or len(TOKEN) < 16:
        sys.exit("PYTHON_BUILDER_TOKEN must be set (16 characters or more)")
    os.makedirs(ENVS, exist_ok=True)
    try:
        PIP_VERSION = importlib.metadata.version("pip")
    except importlib.metadata.PackageNotFoundError:
        pass
    try:
        NODE_VERSION = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        NODE_VERSION = ""
    threading.Thread(target=cleaner, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log("listening", port=PORT, platform=PLATFORM, index=scrub(INDEX_URL), max_builds=MAX_BUILDS, envs=ENVS)
    server.serve_forever()


if __name__ == "__main__":
    main()
