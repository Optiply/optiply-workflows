"""
The code executor: runs Python code blocks for the workflow workers, each in a fresh nsjail jail.

  POST /run    {"code": "...", "scope": {...}, "timeoutMs": 10000, "envId": "..." (a workflow's packages, optional)}
               -> {"ok": true, "result": ..., "logs": [...]} or {"ok": false, "error": {...}, "logs": [...]}
               With "stream": true, NDJSON (chunked) instead: {"log": {"level", "message"}} per line as the code
               prints it, then {"outcome": {"ok", "result" | "error"}} as the last line.
  POST /check  {"fields": [{"id": "...", "code": "..."}]} -> {"ok": true, "problems": [...]}
  GET  /health -> {"ok": true, "python": "3.12.x", "packages": {...}, "pool": {"ready", "starting", ...}}
Runs say whether they ran in a warm jail ("warm"): one started ahead, its packages imported, used once.

Every request but /health needs `Authorization: Bearer <PYTHON_EXECUTOR_TOKEN>`. The standard library only: nothing
is installed outside the jail. The server holds no secrets but its token; the jail sees none.
"""

import collections
import hmac
import json
import os
import re
import select
import selectors
import signal
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.environ.get("PYTHON_EXECUTOR_TOKEN", "")
PORT = int(os.environ.get("PORT", "8080"))
MEMORY_MB = int(os.environ.get("PYTHON_MEMORY_MB", "256"))
MAX_CONCURRENT = int(os.environ.get("PYTHON_MAX_CONCURRENT", str(os.cpu_count() or 2)))
# Syntax checks (the editor's, before publishing) have slots of their own: they never hold up runs.
MAX_CHECKS = int(os.environ.get("PYTHON_MAX_CHECKS", "2"))
# How long a request waits for a free slot before it's refused as busy.
QUEUE_WAIT_S = float(os.environ.get("PYTHON_QUEUE_WAIT_SECONDS", "30"))
MAX_REQUEST_BYTES = int(os.environ.get("PYTHON_MAX_REQUEST_MB", "64")) * 1024 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
# When streaming, a line printed without its newline yet goes out after this long.
PARTIAL_LINE_S = 0.25
# A stream's reader that takes longer than this to take a chunk counts as gone (the jail is killed): writing waits
# for it, and the run's deadline is only checked between writes.
STREAM_WRITE_TIMEOUT_S = 10
MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
CHECK_TIMEOUT_MS = 5000
JAIL_CONFIG = os.path.join(HERE, "jail.cfg")
NSJAIL = os.environ.get("NSJAIL", "/usr/local/bin/nsjail")
# The warm pool: jails started ahead with these modules imported, each for one run.
WARM_JAILS = int(os.environ.get("PYTHON_WARM_JAILS", str(MAX_CONCURRENT)))
PREIMPORT = os.environ.get("PYTHON_PREIMPORT", "numpy,pandas")
WARM_MAX_IDLE_S = float(os.environ.get("PYTHON_WARM_MAX_IDLE_SECONDS", "600"))
# How long a warm jail may take to get ready, and how many start at once (their imports compete with runs).
WARM_START_S = 30
WARM_START_PARALLEL = int(os.environ.get("PYTHON_WARM_START_PARALLEL", "1"))
# A warm jail's nsjail limits: its time in the pool plus the longest run (the server's deadline comes first).
WARM_LIMIT_S = int(WARM_MAX_IDLE_S + WARM_START_S + MAX_TIMEOUT_MS // 1000 + 1)
READY = b"\x06"
CGROUP_ROOT = "/sys/fs/cgroup"
# Workflows' packages (M23): envs the builder installed (`<envId>/site`), mounted read-only into the jail.
ENVS = os.environ.get("PYTHON_ENVS_DIR", "/envs")
ENV_ID = re.compile(r"^[0-9a-f]{32}$")

run_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
check_slots = threading.BoundedSemaphore(MAX_CHECKS)


def log(event, **fields):
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **fields}), flush=True)


def utf8_complete(data):
    """How much of `data` ends on a whole UTF-8 character (a line cut before its newline may end mid-character)."""
    for k in range(1, min(4, len(data)) + 1):
        byte = data[-k]
        if byte & 0xC0 != 0x80:  # not a continuation byte: ASCII or a character's first byte
            size = 1 if byte < 0x80 else 2 if byte >> 5 == 0b110 else 3 if byte >> 4 == 0b1110 else 4
            return len(data) - k if size > k else len(data)
    return len(data)


class Jail:
    """An nsjail process with the runner in it, not yet given its request.

    A warm one (`warm=True`) imports PREIMPORT first, then says it's ready with one byte on the result pipe; its
    limits allow for the time it may wait in the pool (the runner lowers its CPU limit once the request arrives,
    and the server keeps the request's deadline)."""

    def __init__(self, seconds, warm=False, env_site=None):
        self.warm = warm
        self.born = time.monotonic()
        self.result_r, result_w = os.pipe()
        self.jail_log_r, jail_log_w = os.pipe()
        self.result_fd = result_w  # its number inside the jail too
        args = [
            NSJAIL,
            "--config", JAIL_CONFIG,
            "--quiet",
            "--log_fd", str(jail_log_w),
            "--pass_fd", str(result_w),
            "--time_limit", str(seconds),
            "--rlimit_cpu", str(seconds),
            "--cgroup_mem_max", str(MEMORY_MB * 1024 * 1024),
        ]
        if warm:
            args += ["--env", f"OW_WARM={result_w}", "--env", f"OW_PREIMPORT={PREIMPORT}"]
        if env_site:
            # The workflow's packages, ahead of the image's on sys.path (the runner puts them there).
            args += ["--bindmount_ro", f"{env_site}:/opt/env", "--env", "OW_ENV=/opt/env"]
        try:
            self.proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(result_w, jail_log_w),
                start_new_session=True,
            )
        except BaseException:
            for fd in (self.result_r, self.jail_log_r):
                os.close(fd)
            raise
        finally:
            os.close(result_w)
            os.close(jail_log_w)

    def wait_ready(self, timeout):
        """Whether a warm jail said it's ready within `timeout` seconds."""
        ready, _, _ = select.select([self.result_r], [], [], timeout)
        return bool(ready) and os.read(self.result_r, 1) == READY

    def alive(self):
        return self.proc.poll() is None

    def credit_imports(self):
        """A warm jail's memory limit raised by what its imports took, so its run gets the memory a cold one gets
        (the code would have paid for the imports itself there). False when its cgroup can't be found."""
        cgroup = self._cgroup()
        if not cgroup:
            return False
        try:
            with open(os.path.join(cgroup, "memory.current")) as f:
                used = int(f.read())
            with open(os.path.join(cgroup, "memory.max"), "w") as f:
                f.write(str(MEMORY_MB * 1024 * 1024 + used))
            return True
        except (OSError, ValueError):
            return False

    def _cgroup(self):
        """nsjail's cgroup for this jail: `NSJAIL.<pid>`, named after the jailed process (nsjail's child)."""
        try:
            names = os.listdir(CGROUP_ROOT)
        except OSError:
            return None
        for name in names:
            if not name.startswith("NSJAIL."):
                continue
            try:
                with open(f"/proc/{name.split('.', 1)[1]}/stat") as f:
                    parent = int(f.read().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                continue
            if parent == self.proc.pid:
                return os.path.join(CGROUP_ROOT, name)
        return None

    def jail_errors(self):
        """nsjail's own errors, once the jail has ended (it couldn't start, or it was killed)."""
        data = bytearray()
        while len(data) < 65536:
            ready, _, _ = select.select([self.jail_log_r], [], [], 0)
            chunk = os.read(self.jail_log_r, 65536) if ready else b""
            if not chunk:
                break
            data += chunk
        return [line for line in data.decode("utf-8", "replace").splitlines() if line.startswith(("[E]", "[F]"))]

    def kill(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()

    def close(self):
        """Kills the jail if it still runs and closes its pipes."""
        self.kill()
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                f.close()
            except OSError:
                pass
        for fd in (self.result_r, self.jail_log_r):
            try:
                os.close(fd)
            except OSError:
                pass


class Pool:
    """Warm jails, started ahead so a run skips the jail's and the interpreter's start and PREIMPORT's imports.

    Each serves one request and is never reused: nothing carries over between executions. A taken jail is replaced
    in the background; one idle for WARM_MAX_IDLE_S is replaced too. Jails that fail to start back off."""

    def __init__(self, size):
        self.size = size
        self.ready = collections.deque()
        self.starting = 0
        self.served = {"warm": 0, "cold": 0}
        self.failures = 0
        self.retry_at = 0.0
        self.cond = threading.Condition()

    def start(self):
        if self.size > 0:
            threading.Thread(target=self._maintain, daemon=True).start()

    def take(self):
        """A ready jail (the longest waiting), or None: the run starts a cold one."""
        stale = []
        with self.cond:
            jail = None
            while self.ready and jail is None:
                candidate = self.ready.popleft()
                if candidate.alive():
                    jail = candidate
                else:
                    stale.append(candidate)
            self.served["warm" if jail else "cold"] += 1
            self.cond.notify()
        for old in stale:
            old.close()
        return jail

    def stats(self):
        with self.cond:
            return {"size": self.size, "ready": len(self.ready), "starting": self.starting, **self.served}

    def _maintain(self):
        while True:
            with self.cond:
                now = time.monotonic()
                stale = [j for j in self.ready if now - j.born > WARM_MAX_IDLE_S or not j.alive()]
                for jail in stale:
                    self.ready.remove(jail)
                wanted = self.size - len(self.ready) - self.starting
                start = 0 if now < self.retry_at else max(0, min(wanted, WARM_START_PARALLEL - self.starting))
                self.starting += start
            for jail in stale:
                jail.close()
            for _ in range(start):
                threading.Thread(target=self._start_one, daemon=True).start()
            with self.cond:
                self.cond.wait(timeout=1)

    def _start_one(self):
        jail = None
        try:
            jail = Jail(WARM_LIMIT_S, warm=True)
            ok = jail.wait_ready(WARM_START_S)
            if ok and not jail.credit_imports():
                log("warm_jail_memory", message="Couldn't raise a warm jail's memory limit by its imports")
        except OSError:
            ok = False
        errors = []
        if not ok and jail is not None:
            jail.kill()
            errors = jail.jail_errors()
            jail.close()
        with self.cond:
            self.starting -= 1
            if ok:
                self.ready.append(jail)
                self.failures = 0
            else:
                self.failures += 1
                self.retry_at = time.monotonic() + min(60, 2**self.failures)
            self.cond.notify()
        if not ok:
            log("warm_jail_failed", message="\n".join(errors)[-2000:] or "not ready in time")


pool = Pool(WARM_JAILS)


class Execution:
    """One jail: the request on stdin, the outcome on its own pipe, the code's prints on stdout and stderr.

    `emit`, when given, gets the log lines as they're printed (a list per read; the server streams them)."""

    def __init__(self, request, timeout_ms, emit=None, env_site=None):
        self.request = request
        self.env_site = env_site
        self.timeout_ms = timeout_ms
        self.emit = emit
        self.lines = []  # the log lines so far, {"level", "message"}
        self.unsent = 0  # how many of them `emit` hasn't had
        self.partial = None  # [level, bytearray, since]: output of one level not ended by a newline yet
        self.frame = None  # in fd 1's tagged frames: None outside one, "?" before its tag, else the level
        self.log_bytes = 0
        self.logs_truncated = False
        self.result = bytearray()
        self.result_too_big = False
        self.jail_log = bytearray()

    def run(self, cancelled, jail=None):
        """Runs the request in `jail` (a warm one from the pool) or in a cold one started here."""
        seconds = max(1, -(-self.timeout_ms // 1000))  # whole seconds, rounded up
        started = time.monotonic()
        if jail is None:
            jail = Jail(seconds + 1, env_site=self.env_site)
        proc = jail.proc
        # The runner writes its outcome to the fd nsjail passes through, and limits its own CPU time from now (a
        # warm jail's nsjail limits had to allow for its time in the pool).
        payload = json.dumps(
            {**self.request, "resultFd": jail.result_fd, "cpuSeconds": seconds + 1}, separators=(",", ":")
        ).encode()
        killed = None
        try:
            threading.Thread(target=self._feed, args=(proc, payload), daemon=True).start()
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ, "log")
            sel.register(proc.stderr, selectors.EVENT_READ, "error")
            sel.register(jail.result_r, selectors.EVENT_READ, "result")
            sel.register(jail.jail_log_r, selectors.EVENT_READ, "jail")
            # The timeout, exactly (nsjail's limits, in whole seconds and a second later, are the backstop): the
            # answer then carries what the code printed.
            deadline = started + self.timeout_ms / 1000
            while sel.get_map():
                if cancelled():
                    killed = "cancelled"
                    break
                if time.monotonic() > deadline:
                    killed = "timeout"
                    break
                for key, _ in sel.select(timeout=0.1):
                    fd = key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno()
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        sel.unregister(key.fileobj)
                        continue
                    self._take(key.data, chunk)
                if self.emit:
                    if self.partial and time.monotonic() - self.partial[2] >= PARTIAL_LINE_S:
                        self._end_partial(whole=False)
                    if not self._send():
                        killed = "cancelled"
                        break
            if killed:
                os.killpg(proc.pid, signal.SIGKILL)
            code = proc.wait()
        finally:
            jail.close()
        outcome = self._outcome(code, killed, time.monotonic() - started)
        outcome["warm"] = jail.warm
        return outcome

    def _feed(self, proc, payload):
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def _take(self, kind, chunk):
        if kind == "result":
            if len(self.result) + len(chunk) > MAX_RESULT_BYTES:
                self.result_too_big = True
            else:
                self.result += chunk
        elif kind == "jail":
            self.jail_log += chunk[: max(0, 65536 - len(self.jail_log))]
        elif kind == "error":
            self._append("error", chunk)  # written to fd 2 directly (C code, a crash)
        else:
            self._stdout(chunk)

    def _stdout(self, chunk):
        """fd 1: sys.stdout and sys.stderr as frames (\x1e, L or E, text, \x1f); bytes outside frames are logs."""
        i = 0
        while i < len(chunk):
            if self.frame is None:
                j = chunk.find(b"\x1e", i)
                end = len(chunk) if j < 0 else j
                if end > i:
                    self._append("log", chunk[i:end])
                if j < 0:
                    return
                self.frame, i = "?", j + 1
            elif self.frame == "?":
                self.frame, i = ("error" if chunk[i] == ord("E") else "log"), i + 1
            else:
                j = chunk.find(b"\x1f", i)
                end = len(chunk) if j < 0 else j
                if end > i:
                    self._append(self.frame, chunk[i:end])
                if j < 0:
                    return
                self.frame, i = None, j + 1

    def _append(self, level, data):
        if self.log_bytes >= MAX_LOG_BYTES:
            if not self.logs_truncated:
                self.logs_truncated = True
                self._end_partial()
                self.lines.append({"level": "warn", "message": f"The output was cut off at {MAX_LOG_BYTES // 1024} kB"})
            return
        data = data[: MAX_LOG_BYTES - self.log_bytes]
        self.log_bytes += len(data)
        # Output of another level ends the line so far (consecutive output of one level is one text).
        if self.partial and self.partial[0] != level:
            self._end_partial()
        if not self.partial:
            self.partial = [level, bytearray(), time.monotonic()]
        buf = self.partial[1]
        buf += data
        end = buf.rfind(b"\n")
        if end >= 0:
            for piece in bytes(buf[:end]).split(b"\n"):
                self._add_lines(level, piece)
            del buf[: end + 1]
            if buf:
                self.partial[2] = time.monotonic()
            else:
                self.partial = None

    def _add_lines(self, level, data):
        # splitlines, as for the whole text: "\r" and the other line breaks split too; an empty line stays one.
        for line in data.decode("utf-8", "replace").splitlines() or [""]:
            self.lines.append({"level": level, "message": line})

    def _end_partial(self, whole=True):
        """The output not ended by a newline as lines; `whole=False` keeps a character cut in two for later."""
        if not self.partial:
            return
        level, buf, _ = self.partial
        cut = len(buf) if whole else utf8_complete(buf)
        if cut:
            self._add_lines(level, bytes(buf[:cut]))
            del buf[:cut]
        if buf:
            self.partial[2] = time.monotonic()
        else:
            self.partial = None

    def _send(self):
        """Hands `emit` the lines it hasn't had; False when the caller is gone."""
        if self.unsent < len(self.lines):
            lines, self.unsent = self.lines[self.unsent :], len(self.lines)
            try:
                self.emit(lines)
            except OSError:
                return False
        return True

    def _outcome(self, code, killed, elapsed):
        self._end_partial()
        if self.emit and killed != "cancelled":
            self._send()  # what came in after the last read, before the outcome
        logs = self.lines
        if killed == "cancelled":
            return {"ok": False, "error": {"kind": "cancelled", "message": "Cancelled"}, "logs": logs}
        if self.result_too_big:
            message = f"The result is over {MAX_RESULT_BYTES // (1024 * 1024)} MB"
            return {"ok": False, "error": {"kind": "serialization", "message": message}, "logs": logs}
        if self.result:
            try:
                outcome = json.loads(self.result)
                if isinstance(outcome, dict) and "ok" in outcome:
                    outcome["logs"] = logs
                    return outcome
            except ValueError:
                pass
        # No outcome: the jail never started, the jail killed it, or the code ended the interpreter itself.
        jail_errors = [
            line for line in self.jail_log.decode("utf-8", "replace").splitlines() if line.startswith(("[E]", "[F]"))
        ]
        if jail_errors and not self.log_bytes:
            log("jail_failed", message="\n".join(jail_errors)[-2000:])
            reason = jail_errors[0].split("] ", 2)[-1] if "] " in jail_errors[0] else jail_errors[0]
            error = {"kind": "internal", "message": f"The executor couldn't start a jail: {reason}"}
            return {"ok": False, "error": error, "logs": logs}
        if killed == "timeout" or elapsed * 1000 >= self.timeout_ms or code in (128 + signal.SIGXCPU, -signal.SIGXCPU):
            error = {"kind": "timeout", "message": f"The code didn't finish within {self.timeout_ms} ms"}
        elif code in (137, -signal.SIGKILL):
            error = {"kind": "memory", "message": f"The code used more than its {MEMORY_MB} MB of memory"}
        else:
            error = {"kind": "runtime", "message": f"The code ended Python without returning (exit code {code})"}
        if self.jail_log:
            log("jail_log", message=self.jail_log.decode("utf-8", "replace")[-2000:])
        return {"ok": False, "error": error, "logs": logs}


class Handler(BaseHTTPRequestHandler):
    server_version = "ow-code-executor"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # Our own structured log instead.
        pass

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.wfile.flush()

    def send_chunk(self, items):
        """NDJSON lines as one HTTP chunk (an OSError when the caller is gone)."""
        data = b"".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for item in items)
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    def refuse(self, status, message):
        # The body may not have been read: it would be taken for the next request on this connection.
        self.close_connection = True
        self.send_json(status, {"error": {"message": message}})

    def authorized(self):
        given = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(given.encode(), f"Bearer {TOKEN}".encode())

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            return None
        return json.loads(self.rfile.read(length))

    def client_gone(self):
        """Whether the worker hung up (it cancelled or timed out): then the jail goes too."""
        timeout = self.connection.gettimeout()  # a stream's write timeout stays as it was
        try:
            self.connection.setblocking(False)
            try:
                return self.connection.recv(1, 0x2) == b""  # MSG_PEEK
            finally:
                self.connection.settimeout(timeout)
        except BlockingIOError:
            return False
        except OSError:
            return True

    def do_GET(self):
        if self.path != "/health":
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        self.send_json(
            HTTPStatus.OK, {"ok": True, "python": PYTHON_VERSION, "packages": PACKAGES, "pool": pool.stats()}
        )

    def do_POST(self):
        if self.path not in ("/run", "/check"):
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        if not self.authorized():
            return self.refuse(HTTPStatus.UNAUTHORIZED, "A valid bearer token is required")
        try:
            body = self.body()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.refuse(HTTPStatus.BAD_REQUEST, f"Send a JSON object of at most {MAX_REQUEST_BYTES // (1024 * 1024)} MB")
        stream = False
        env_id = None
        if self.path == "/run":
            code, scope, timeout_ms = body.get("code"), body.get("scope", {}), body.get("timeoutMs", 10000)
            stream = body.get("stream", False)
            env_id = body.get("envId")
            if (
                not isinstance(code, str)
                or not isinstance(scope, dict)
                or not isinstance(timeout_ms, int)
                or not isinstance(stream, bool)
                or not (env_id is None or (isinstance(env_id, str) and ENV_ID.match(env_id)))
            ):
                return self.refuse(
                    HTTPStatus.BAD_REQUEST, "Expected code (a string), scope (an object), timeoutMs, envId (an env's id)"
                )
            timeout_ms = min(max(timeout_ms, 100), MAX_TIMEOUT_MS)
            request = {"mode": "run", "code": code, "scope": scope}
        else:
            fields = body.get("fields")
            if not isinstance(fields, list) or not all(
                isinstance(f, dict) and isinstance(f.get("id"), str) and isinstance(f.get("code"), str) for f in fields
            ):
                return self.refuse(HTTPStatus.BAD_REQUEST, "Expected fields: [{id, code}]")
            timeout_ms = CHECK_TIMEOUT_MS
            request = {"mode": "check", "fields": fields}

        slots = run_slots if self.path == "/run" else check_slots
        if not slots.acquire(timeout=QUEUE_WAIT_S):
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The executor is busy; try again")
        started = time.monotonic()
        try:
            emit = None
            gone = False
            if stream:
                try:
                    self.start_stream()
                    self.connection.settimeout(STREAM_WRITE_TIMEOUT_S)
                except OSError:  # the caller hung up before its stream started
                    gone = True

                def emit(lines):
                    self.send_chunk([{"log": line} for line in lines])

            env_site = os.path.join(ENVS, env_id, "site") if env_id else None
            if gone:
                outcome = {"ok": False, "error": {"kind": "cancelled", "message": "Cancelled"}}
            elif env_id and not os.path.isfile(os.path.join(ENVS, env_id, "lock.json")):
                message = f"The workflow's Python packages aren't installed here (env {env_id}): the builder installs them"
                outcome = {"ok": False, "error": {"kind": "python_packages", "message": message}, "logs": []}
            else:
                # Runs take a warm jail when one is ready (a warm jail's mounts are fixed: never for packages);
                # checks start their own (they have their own limits).
                jail = pool.take() if self.path == "/run" and not env_id else None
                outcome = Execution(request, timeout_ms, emit, env_site).run(self.client_gone, jail)
        finally:
            slots.release()
        ms = round((time.monotonic() - started) * 1000)
        error = outcome.get("error")
        warm = outcome.pop("warm", False)
        if self.path == "/run":
            outcome["warm"] = warm
        log(
            "execution",
            path=self.path,
            ms=ms,
            ok=outcome.get("ok"),
            error=error and error.get("kind"),
            warm=warm,
            env=env_id,
        )
        if error and error.get("kind") == "cancelled":
            self.close_connection = True
            return
        if not stream:
            return self.send_json(HTTPStatus.OK, outcome)
        outcome.pop("logs", None)
        try:
            self.send_chunk([{"outcome": outcome}])
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            self.connection.settimeout(None)  # a kept-alive connection waits for its next request as long as it likes
        except OSError:
            self.close_connection = True


def packages():
    """The curated packages in the jail's virtualenv, with their versions."""
    found = {}
    try:
        out = subprocess.run(
            ["/opt/py/bin/python3", "-I", "-c", "import json, importlib.metadata as m; print(json.dumps({d.metadata['Name'].lower(): d.version for d in m.distributions()}))"],
            capture_output=True, text=True, timeout=30, check=True,
        )
        found = json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return {name: version for name, version in sorted(found.items()) if name not in ("pip", "setuptools", "wheel")}


PYTHON_VERSION = sys.version.split()[0]
PACKAGES = {}


def main():
    global PACKAGES
    if not TOKEN or len(TOKEN) < 16:
        sys.exit("PYTHON_EXECUTOR_TOKEN must be set (16 characters or more)")
    PACKAGES = packages()
    pool.start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log(
        "listening",
        port=PORT,
        max_concurrent=MAX_CONCURRENT,
        memory_mb=MEMORY_MB,
        warm_jails=WARM_JAILS,
        preimport=PREIMPORT,
        packages=PACKAGES,
    )
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    server.serve_forever()


if __name__ == "__main__":
    main()
