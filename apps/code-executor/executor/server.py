"""
The code executor: runs Python code blocks for the workflow workers, each in a fresh nsjail jail.

  POST /run    {"code": "...", "scope": {...}, "timeoutMs": 10000}
               -> {"ok": true, "result": ..., "logs": [...]} or {"ok": false, "error": {...}, "logs": [...]}
  POST /check  {"fields": [{"id": "...", "code": "..."}]} -> {"ok": true, "problems": [...]}
  GET  /health -> {"ok": true, "python": "3.12.x", "packages": {...}}

Every request but /health needs `Authorization: Bearer <PYTHON_EXECUTOR_TOKEN>`. The standard library only: nothing
is installed outside the jail. The server holds no secrets but its token; the jail sees none.
"""

import hmac
import json
import os
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
# How long a request waits for a free slot before it's refused as busy.
QUEUE_WAIT_S = float(os.environ.get("PYTHON_QUEUE_WAIT_SECONDS", "30"))
MAX_REQUEST_BYTES = int(os.environ.get("PYTHON_MAX_REQUEST_MB", "64")) * 1024 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
CHECK_TIMEOUT_MS = 5000
JAIL_CONFIG = os.path.join(HERE, "jail.cfg")
NSJAIL = os.environ.get("NSJAIL", "/usr/local/bin/nsjail")

slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def log(event, **fields):
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **fields}), flush=True)


class Execution:
    """One jail: the request on stdin, the outcome on its own pipe, the code's prints on stdout and stderr."""

    def __init__(self, request, timeout_ms):
        self.request = request
        self.timeout_ms = timeout_ms
        self.logs = []  # [level, bytearray], consecutive output of one level merged
        self.frame = None  # in fd 1's tagged frames: None outside one, "?" before its tag, else the level
        self.log_bytes = 0
        self.logs_truncated = False
        self.result = bytearray()
        self.result_too_big = False
        self.jail_log = bytearray()

    def run(self, cancelled):
        result_r, result_w = os.pipe()
        jail_log_r, jail_log_w = os.pipe()
        seconds = max(1, -(-self.timeout_ms // 1000))  # whole seconds, rounded up
        args = [
            NSJAIL,
            "--config", JAIL_CONFIG,
            "--quiet",
            "--log_fd", str(jail_log_w),
            "--pass_fd", str(result_w),
            "--time_limit", str(seconds + 1),
            "--rlimit_cpu", str(seconds + 1),
            "--cgroup_mem_max", str(MEMORY_MB * 1024 * 1024),
        ]
        started = time.monotonic()
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(result_w, jail_log_w),
            start_new_session=True,
        )
        # The runner writes its outcome to the fd nsjail passes through.
        payload = json.dumps({**self.request, "resultFd": result_w}, separators=(",", ":")).encode()
        os.close(result_w)
        os.close(jail_log_w)
        killed = None
        try:
            threading.Thread(target=self._feed, args=(proc, payload), daemon=True).start()
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ, "log")
            sel.register(proc.stderr, selectors.EVENT_READ, "error")
            sel.register(result_r, selectors.EVENT_READ, "result")
            sel.register(jail_log_r, selectors.EVENT_READ, "jail")
            deadline = started + self.timeout_ms / 1000 + 1.5  # nsjail's own limit comes first
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
            if killed:
                os.killpg(proc.pid, signal.SIGKILL)
            code = proc.wait()
        finally:
            for fd in (result_r, jail_log_r):
                try:
                    os.close(fd)
                except OSError:
                    pass
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        return self._outcome(code, killed, time.monotonic() - started)

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
            self.logs_truncated = True
            return
        data = data[: MAX_LOG_BYTES - self.log_bytes]
        self.log_bytes += len(data)
        # Lines are split when the logs are returned.
        if self.logs and self.logs[-1][0] == level:
            self.logs[-1][1] += data
        else:
            self.logs.append([level, bytearray(data)])

    def _outcome(self, code, killed, elapsed):
        logs = []
        for level, data in self.logs:
            for line in data.decode("utf-8", "replace").splitlines():
                logs.append({"level": level, "message": line})
        if self.logs_truncated:
            logs.append({"level": "warn", "message": f"The output was cut off at {MAX_LOG_BYTES // 1024} kB"})
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
        if jail_errors and not self.logs:
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
        try:
            self.connection.setblocking(False)
            try:
                return self.connection.recv(1, 0x2) == b""  # MSG_PEEK
            finally:
                self.connection.setblocking(True)
        except BlockingIOError:
            return False
        except OSError:
            return True

    def do_GET(self):
        if self.path != "/health":
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        self.send_json(HTTPStatus.OK, {"ok": True, "python": PYTHON_VERSION, "packages": PACKAGES})

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
        if self.path == "/run":
            code, scope, timeout_ms = body.get("code"), body.get("scope", {}), body.get("timeoutMs", 10000)
            if not isinstance(code, str) or not isinstance(scope, dict) or not isinstance(timeout_ms, int):
                return self.refuse(HTTPStatus.BAD_REQUEST, "Expected code (a string), scope (an object), timeoutMs")
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

        if not slots.acquire(timeout=QUEUE_WAIT_S):
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The executor is busy; try again")
        started = time.monotonic()
        try:
            outcome = Execution(request, timeout_ms).run(self.client_gone)
        finally:
            slots.release()
        ms = round((time.monotonic() - started) * 1000)
        error = outcome.get("error")
        log("execution", path=self.path, ms=ms, ok=outcome.get("ok"), error=error and error.get("kind"))
        if error and error.get("kind") == "cancelled":
            self.close_connection = True
            return
        self.send_json(HTTPStatus.OK, outcome)


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
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log("listening", port=PORT, max_concurrent=MAX_CONCURRENT, memory_mb=MEMORY_MB, packages=PACKAGES)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    server.serve_forever()


if __name__ == "__main__":
    main()
