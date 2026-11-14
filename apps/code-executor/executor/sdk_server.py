"""
The SDK runner (M37, docs/architecture.md §2.41): calls a company SDK (a Python or JavaScript package) for the
workers, each call in a fresh nsjail jail whose only way out is a proxy that lets the resource's hosts through.

  POST /run    {"language": "python" | "javascript", "envId": "<32 hex>" (the SDK's installed env, optional),
                "mode": "call" | "code" | "describe", "setup": "...", "context": {"token", "baseUrl", "options",
                "secrets"}, "method", "args", "limit", "code", "params", "allowedHosts": ["api.acme.com",
                "*.acme.com", "host:8443"], "allowPrivate": false, "timeoutMs": 30000, "stream": false}
               -> {"ok": true, "result": ..., "logs": [...], "blocked": [...]} or {"ok": false, "error": {...}, ...}
               With "stream": true, NDJSON as the executor's (logs as they're printed, the outcome last).
  GET  /health -> {"ok": true, "python": "3.12.x", "node": "v24…"}

Every request but /health needs `Authorization: Bearer <SDK_RUNNER_TOKEN>`. The token and secrets in a request go to
the jail on stdin only (never its environment or command line) and are never logged here.

The proxy: one per call, on a Unix socket bind-mounted into the jail (the runner's forwarder on the jail's loopback
leads there). It takes CONNECT host:port (HTTPS, end to end: no TLS is opened here) and plain-HTTP requests in
absolute form, lets through only hosts matching `allowedHosts` (exact, or `*.domain` for its subdomains; ports 443
and 80 unless a pattern names another), resolves the name itself and refuses private, loopback and link-local
addresses unless `allowPrivate`, then connects to the address it checked (no second lookup to rebind). Each refusal
is a log line of the call.
"""

import ipaddress
import json
import os
import re
import secrets as random
import shutil
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as base  # noqa: E402  (the Python executor: Jail, Execution, the request handler's helpers)

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.environ.get("SDK_RUNNER_TOKEN", "")
MEMORY_MB = int(os.environ.get("SDK_MEMORY_MB", "512"))
MAX_CONCURRENT = int(os.environ.get("SDK_MAX_CONCURRENT", str(os.cpu_count() or 2)))
JAIL_CONFIG = os.path.join(HERE, "sdk-jail.cfg")
PROXY_ROOT = os.environ.get("SDK_PROXY_DIR", "/run/ow-sdk")
NODE = os.environ.get("NODE", "/usr/local/bin/node")
CONNECT_TIMEOUT_S = 15
HEAD_TIMEOUT_S = 30
MAX_HEAD_BYTES = 16 * 1024
MAX_HOSTS = 50
HOST_PATTERN = re.compile(r"^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$")
# What the proxy refuses unless the resource allows a private network (ipaddress's is_private misses CGNAT).
BLOCKED_NETS = [ipaddress.ip_network(n) for n in ("100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15")]

# The executor's code, with this service's token and memory.
base.TOKEN = TOKEN
base.MEMORY_MB = MEMORY_MB
run_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def blocked_address(ip):
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or any(addr in net for net in BLOCKED_NETS)
    )


def host_allowed(host, port, patterns):
    host = host.lower().rstrip(".")
    for pattern in patterns:
        name, _, pport = pattern.partition(":")
        wanted_ports = (int(pport),) if pport else (443, 80)
        if port not in wanted_ports:
            continue
        if name.startswith("*."):
            if host.endswith(name[1:]) and host != name[2:]:
                return True
        elif host == name:
            return True
    return False


class Proxy:
    """The call's way out: a CONNECT/HTTP proxy on a Unix socket, for the allowed hosts only."""

    def __init__(self, allowed, allow_private):
        self.allowed = allowed
        self.allow_private = allow_private
        self.blocked = []
        self.connections = 0
        self.dir = os.path.join(PROXY_ROOT, random.token_hex(8))
        os.makedirs(self.dir, mode=0o755)
        os.chmod(self.dir, 0o755)
        self.path = os.path.join(self.dir, "proxy.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        os.chmod(self.path, 0o666)  # the jail's user (nobody) connects
        self.server.listen(64)
        self.closed = False
        threading.Thread(target=self._accept, daemon=True).start()

    def close(self):
        self.closed = True
        try:
            # Wakes the accept loop (closing alone doesn't interrupt a blocked accept on Linux).
            self.server.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.server.close()
        finally:
            shutil.rmtree(self.dir, ignore_errors=True)

    def _accept(self):
        # A timeout too, so the thread ends with the call whatever the platform does on shutdown.
        self.server.settimeout(0.5)
        while not self.closed:
            try:
                conn, _ = self.server.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            conn.settimeout(None)
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _refuse(self, conn, host, reason, status=403):
        if len(self.blocked) < 100:
            self.blocked.append({"host": host, "reason": reason})
        try:
            body = f"Blocked by the SDK runner: {reason}\n".encode()
            conn.sendall(
                b"HTTP/1.1 %d Forbidden\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
                % (status, len(body), body)
            )
        except OSError:
            pass
        conn.close()

    def _handle(self, conn):
        conn.settimeout(HEAD_TIMEOUT_S)
        head = b""
        try:
            while b"\r\n\r\n" not in head:
                chunk = conn.recv(4096)
                if not chunk:
                    conn.close()
                    return
                head += chunk
                if len(head) > MAX_HEAD_BYTES:
                    return self._refuse(conn, "?", "the request's head is too long", 400)
        except OSError:
            conn.close()
            return
        end = head.index(b"\r\n\r\n") + 4
        head, rest = head[:end], head[end:]
        first, _, headers = head.partition(b"\r\n")
        parts = first.decode("latin-1").split(" ")
        if len(parts) != 3:
            return self._refuse(conn, "?", "not an HTTP request", 400)
        method, target, version = parts
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            host = host.strip("[]")
            tunnel = True
        else:
            m = re.match(r"^http://([^/:]+|\[[^\]]+\])(?::(\d+))?(/.*)?$", target, re.I)
            if not m:
                return self._refuse(conn, target[:100], "only CONNECT (HTTPS) and plain http:// requests go through", 400)
            host, port, path = m.group(1).strip("[]"), m.group(2) or "80", m.group(3) or "/"
            tunnel = False
            # One request per connection: the upstream closes after answering, so a client's next request (maybe for
            # another host) comes on a new connection and is checked again. Proxy-only headers go.
            kept = [
                line
                for line in headers.split(b"\r\n")
                if line and not re.match(rb"(?i)^(connection|proxy-connection|keep-alive|proxy-authorization):", line)
            ]
            head = b"\r\n".join([f"{method} {path} {version}".encode("latin-1"), *kept, b"Connection: close"]) + b"\r\n\r\n"
        try:
            port = int(port)
        except ValueError:
            return self._refuse(conn, host, "no port", 400)
        if not host_allowed(host, port, self.allowed):
            return self._refuse(conn, f"{host}:{port}", f"{host}:{port} isn't in this resource's allowed hosts")
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            return self._refuse(conn, f"{host}:{port}", f"{host} doesn't resolve ({exc.strerror or exc})", 502)
        addresses = [info[4] for info in infos]
        if not self.allow_private and any(blocked_address(a[0]) for a in addresses):
            return self._refuse(conn, f"{host}:{port}", f"{host} is on a private network (allow it on the resource)")
        upstream = None
        for family, kind, proto, _, address in infos:
            try:
                upstream = socket.socket(family, kind, proto)
                upstream.settimeout(CONNECT_TIMEOUT_S)
                upstream.connect(address)
                upstream.settimeout(None)
                break
            except OSError:
                upstream.close()
                upstream = None
        if upstream is None:
            return self._refuse(conn, f"{host}:{port}", f"{host}:{port} didn't answer", 502)
        self.connections += 1
        conn.settimeout(None)
        try:
            if tunnel:
                conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                if rest:
                    upstream.sendall(rest)
            else:
                upstream.sendall(head + rest)
        except OSError:
            conn.close()
            upstream.close()
            return
        splice(conn, upstream)


def splice(a, b):
    def pump(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            for s, how in ((dst, socket.SHUT_WR), (src, socket.SHUT_RD)):
                try:
                    s.shutdown(how)
                except OSError:
                    pass

    t = threading.Thread(target=pump, args=(b, a), daemon=True)
    t.start()
    pump(a, b)
    t.join(timeout=600)
    a.close()
    b.close()


class SdkJail(base.Jail):
    """A cold jail for one SDK call: sdk-jail.cfg, the language's runner, the env and the proxy's socket mounted."""

    def __init__(self, seconds, language, env_dir, proxy_dir):
        extra = ["--bindmount", f"{proxy_dir}:/run/ow"]
        if env_dir:
            extra += ["--bindmount_ro", f"{env_dir}:/opt/env", "--env", "OW_ENV=/opt/env"]
        if language == "python":
            program = ["/opt/py/bin/python3", "-I", "/opt/runner/runner_sdk.py"]
        else:
            # Node's heap below the jail's memory (V8 would otherwise size it from the machine's); no io_uring (the
            # jail's seccomp refuses it).
            extra += ["--env", "UV_USE_IO_URING=0", "--env", "HOME=/tmp"]
            program = [NODE, f"--max-old-space-size={max(64, MEMORY_MB * 3 // 4)}", "/opt/runner/runner_sdk.mjs"]
        super().__init__(seconds, config=JAIL_CONFIG, extra_args=extra, program=program, memory_mb=MEMORY_MB)


def env_dir_of(language, env_id):
    """The installed env's directory, or None when it isn't there (the builder installs it)."""
    if not env_id:
        return None
    if language == "python":
        root = os.path.join(base.ENVS, env_id)
        return os.path.join(root, "site") if os.path.isfile(os.path.join(root, "lock.json")) else None
    root = os.path.join(base.ENVS, "node", env_id)
    return root if os.path.isdir(os.path.join(root, "node_modules")) else None


def check_request(body):
    """The request's fields checked, or a message saying what's wrong."""
    language = body.get("language")
    if language not in ("python", "javascript"):
        return "language is python or javascript"
    env_id = body.get("envId")
    if env_id is not None and not (isinstance(env_id, str) and base.ENV_ID.match(env_id)):
        return "envId is an env's id (32 hex characters)"
    if body.get("mode") not in ("call", "code", "describe"):
        return "mode is call, code or describe"
    if not isinstance(body.get("setup"), str):
        return "setup is the resource's setup code"
    if not isinstance(body.get("context", {}), dict):
        return "context is an object"
    hosts = body.get("allowedHosts", [])
    if not isinstance(hosts, list) or len(hosts) > MAX_HOSTS or not all(isinstance(h, str) and HOST_PATTERN.match(h.lower()) for h in hosts):
        return f"allowedHosts is a list of at most {MAX_HOSTS} host names (api.acme.com, *.acme.com, host:8443)"
    if not isinstance(body.get("timeoutMs", 30000), int) or not isinstance(body.get("stream", False), bool):
        return "timeoutMs is a number of milliseconds, stream true or false"
    return None


def explain_exit(outcome, language):
    """The executor's words for a runner that ended without an outcome, said for this service: Node's heap running
    out (V8 aborts, exit 133) is the memory limit, and Node isn't Python."""
    error = outcome.get("error") or {}
    if error.get("kind") != "runtime" or not str(error.get("message", "")).startswith("The code ended Python"):
        return
    logs = outcome.get("logs") or []
    if language == "javascript" and (
        "exit code 133" in error["message"] or any("heap out of memory" in line.get("message", "") for line in logs)
    ):
        outcome["error"] = {"kind": "memory", "message": f"The SDK used more than its {MEMORY_MB} MB of memory"}
        # V8's dump of its last collections isn't the SDK's output.
        outcome["logs"] = [line for line in logs if line.get("level") != "error"][:50]
    elif language == "javascript":
        error["message"] = error["message"].replace("ended Python", "ended Node")


class Handler(base.Handler):
    server_version = "ow-sdk-runner"

    def do_GET(self):
        if self.path != "/health":
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        self.send_json(HTTPStatus.OK, {"ok": True, "python": PYTHON_VERSION, "node": NODE_VERSION})

    def do_POST(self):
        if self.path != "/run":
            return self.refuse(HTTPStatus.NOT_FOUND, "Not found")
        if not self.authorized():
            return self.refuse(HTTPStatus.UNAUTHORIZED, "A valid bearer token is required")
        try:
            body = self.body()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.refuse(HTTPStatus.BAD_REQUEST, "Send a JSON object")
        problem = check_request(body)
        if problem:
            return self.refuse(HTTPStatus.BAD_REQUEST, problem)
        language = body["language"]
        timeout_ms = min(max(body.get("timeoutMs", 30000), 100), base.MAX_TIMEOUT_MS)
        stream = body.get("stream", False)
        request = {
            key: body[key]
            for key in ("mode", "setup", "context", "method", "args", "limit", "code", "params")
            if key in body
        }
        if not run_slots.acquire(timeout=base.QUEUE_WAIT_S):
            return self.refuse(HTTPStatus.SERVICE_UNAVAILABLE, "The SDK runner is busy; try again")
        started = time.monotonic()
        proxy = None
        try:
            emit = None
            gone = False
            if stream:
                try:
                    self.start_stream()
                    self.connection.settimeout(base.STREAM_WRITE_TIMEOUT_S)
                except OSError:
                    gone = True

                def emit(lines):
                    self.send_chunk([{"log": line} for line in lines])

            env_dir = env_dir_of(language, body.get("envId"))
            if gone:
                outcome = {"ok": False, "error": {"kind": "cancelled", "message": "Cancelled"}}
            elif body.get("envId") and not env_dir:
                message = f"The SDK's packages aren't installed here (env {body['envId']}): the builder installs them"
                outcome = {"ok": False, "error": {"kind": "sdk_install", "message": message}, "logs": []}
            else:
                proxy = Proxy([h.lower() for h in body.get("allowedHosts", [])], bool(body.get("allowPrivate")))
                seconds = max(1, -(-timeout_ms // 1000))
                jail = SdkJail(seconds + 1, language, env_dir, proxy.dir)
                outcome = base.Execution(request, timeout_ms, emit).run(self.client_gone, jail)
                outcome["blocked"] = proxy.blocked
                outcome["connections"] = proxy.connections
        finally:
            if proxy:
                proxy.close()
            run_slots.release()
        outcome.pop("warm", None)
        explain_exit(outcome, language)
        blocked = outcome.get("blocked") or []
        notes = [{"level": "warn", "message": f"Blocked: {b['reason']}"} for b in blocked]
        error = outcome.get("error")
        base.log(
            "sdk_call",
            ms=round((time.monotonic() - started) * 1000),
            language=language,
            mode=body.get("mode"),
            ok=outcome.get("ok"),
            error=error and error.get("kind"),
            blocked=len(blocked),
            env=body.get("envId"),
        )
        if error and error.get("kind") == "cancelled":
            self.close_connection = True
            return
        if not stream:
            outcome["logs"] = (outcome.get("logs") or []) + notes
            return self.send_json(HTTPStatus.OK, outcome)
        outcome.pop("logs", None)
        try:
            self.connection.settimeout(base.STREAM_OUTCOME_TIMEOUT_S)
            if notes:
                self.send_chunk([{"log": n} for n in notes])
            self.send_chunk([{"outcome": outcome}])
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            self.connection.settimeout(None)
        except OSError:
            self.close_connection = True


PYTHON_VERSION = sys.version.split()[0]
NODE_VERSION = None


def main():
    global NODE_VERSION
    if not TOKEN or len(TOKEN) < 16:
        sys.exit("SDK_RUNNER_TOKEN must be set (16 characters or more)")
    try:
        NODE_VERSION = subprocess.run([NODE, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        NODE_VERSION = None
    os.makedirs(PROXY_ROOT, mode=0o755, exist_ok=True)
    httpd = base.ThreadingHTTPServer(("0.0.0.0", base.PORT), Handler)
    httpd.daemon_threads = True
    base.log("listening", port=base.PORT, max_concurrent=MAX_CONCURRENT, memory_mb=MEMORY_MB, node=NODE_VERSION)
    base.signal.signal(base.signal.SIGTERM, lambda *_: threading.Thread(target=httpd.shutdown, daemon=True).start())
    httpd.serve_forever()


if __name__ == "__main__":
    main()
