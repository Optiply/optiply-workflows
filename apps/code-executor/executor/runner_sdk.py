"""
Runs inside the SDK jail (M37, docs/architecture.md §2.41): one call to a Python SDK, then exits.

Input is one JSON document on stdin (with "resultFd" and "cpuSeconds", as runner.py's):
  {"mode": "call" | "code" | "describe", "setup": "<module code defining client(...)>",
   "context": {"token", "baseUrl", "options", "secrets"},
   "method": "products.list", "args": [...] | {...} | null, "limit": 1000,     (call)
   "code": "<function body>", "params": {...}}                                   (code)
The resource's setup code defines `client(token, base_url, options, secrets)` (any of those parameters), returning the
SDK's client; a call runs `client.<method>(...)`, a snippet runs with `client`, `params` and `token`, describe lists
what the client offers. Coroutines are awaited and (async) iterators collected up to `limit`.

The jail's network namespace has only a loopback: a forwarder on 127.0.0.1:3128 (where HTTPS_PROXY points) hands
each connection to the proxy's Unix socket outside (/run/ow/proxy.sock), which lets only the resource's hosts through.
The outcome goes to its own pipe, as runner.py's; prints are the run's log (runner.py's frames).
"""

import asyncio
import base64
import dataclasses
import datetime
import decimal
import enum
import inspect
import json
import os
import socket
import sys
import threading
import traceback
import uuid

sys.path.insert(0, "/opt/runner")
import runner  # noqa: E402  (the Python executor's runner: channels, env, CPU limit)

PROXY_SOCKET = "/run/ow/proxy.sock"
SETUP_FILE = "<setup>"
CODE_FILE = "<code>"
MAX_DEPTH = 40


def forward(client):
    """One connection from the SDK to the proxy outside, both ways."""
    try:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(PROXY_SOCKET)
    except OSError:
        client.close()
        return

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

    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()


def start_forwarder():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 3128))
    server.listen(64)

    def accept():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            forward(conn)

    threading.Thread(target=accept, daemon=True).start()


class Loop:
    """One event loop for the whole call: the client's async parts stay on it."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()

    def settle(self, value):
        if inspect.isawaitable(value):
            return self.loop.run_until_complete(_await(value))
        return value

    def collect(self, value, limit):
        """A generator or (async) iterator as a list of at most `limit` items (an SDK's pages)."""
        if hasattr(value, "__aiter__"):

            async def take():
                out = []
                async for item in value:
                    out.append(item)
                    if len(out) >= limit:
                        break
                return out

            return self.loop.run_until_complete(take())
        if inspect.isgenerator(value) or (
            hasattr(value, "__next__") and hasattr(value, "__iter__") and not isinstance(value, (str, bytes, dict))
        ):
            out = []
            for item in value:
                out.append(item)
                if len(out) >= limit:
                    break
            return out
        return value


async def _await(value):
    return await value


class MethodError(Exception):
    """A method path that isn't there, or a setup without `client` (not the SDK's own errors)."""


def to_json(value, depth=0, seen=None):
    """An SDK's answer as JSON: models (Pydantic, dataclasses, to_dict), dates, decimals, bytes, enums, objects."""
    if depth > MAX_DEPTH:
        return "…"
    seen = seen if seen is not None else set()
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return value.total_seconds()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, enum.Enum):
        return to_json(value.value, depth + 1, seen)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode()
    if id(value) in seen:
        return "[Circular]"
    seen = seen | {id(value)}
    if isinstance(value, dict):
        return {str(k): to_json(v, depth + 1, seen) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json(v, depth + 1, seen) for v in value]
    for name in ("model_dump", "to_dict", "dict", "_asdict"):
        fn = getattr(value, name, None)
        if callable(fn):
            try:
                if name == "model_dump":
                    return to_json(fn(mode="json"), depth + 1, seen)
                return to_json(fn(), depth + 1, seen)
            except TypeError:
                continue
            except Exception:
                break
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return to_json(dataclasses.asdict(value), depth + 1, seen)
    attrs = getattr(value, "__dict__", None)
    if isinstance(attrs, dict):
        return {k: to_json(v, depth + 1, seen) for k, v in attrs.items() if not k.startswith("_")}
    if hasattr(value, "__iter__"):
        try:
            return [to_json(v, depth + 1, seen) for v in value]
        except TypeError:
            pass
    return str(value)


def status_of(exc):
    """An HTTP status an SDK's error carries, by the usual names."""
    for holder in (exc, getattr(exc, "response", None)):
        if holder is None:
            continue
        for name in ("status", "status_code", "statusCode", "http_status", "code"):
            value = getattr(holder, name, None)
            if isinstance(value, int) and 100 <= value <= 599:
                return value
    return None


def failure(kind, exc, filename):
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == filename]
    error = {
        "kind": kind,
        "message": f"{type(exc).__name__}: {exc}",
        "type": type(exc).__name__,
        "line": frames[-1].lineno if frames else None,
    }
    status = status_of(exc)
    if status is not None:
        error["status"] = status
    return {"ok": False, "error": error}


def make_client(setup, context, loop):
    namespace = {"__name__": "__ow_setup__", "__builtins__": __builtins__}
    exec(compile(setup, SETUP_FILE, "exec"), namespace)
    factory = namespace.get("client")
    if not callable(factory):
        raise MethodError("The setup code must define client(token, base_url, options, secrets)")
    given = {
        "token": context.get("token"),
        "base_url": context.get("baseUrl"),
        "options": context.get("options") or {},
        "secrets": context.get("secrets") or {},
    }
    params = inspect.signature(factory).parameters
    takes_all = any(p.kind == p.VAR_KEYWORD for p in params.values())
    return loop.settle(factory(**{k: v for k, v in given.items() if takes_all or k in params}))


def resolve(client, path):
    target = client
    for part in path.split("."):
        if not part.isidentifier() or part.startswith("_"):
            raise MethodError(f'"{path}" isn\'t a method path (names, dots, no leading underscores)')
        if not hasattr(target, part):
            raise MethodError(f'The client has no "{path}" ("{part}" is missing): see Describe')
        target = getattr(target, part)
    return target


def describe(client, depth=2):
    """What the client offers: its methods with their signatures and first doc line, its sub-objects' too."""
    out = []

    def walk(obj, prefix, level, seen):
        if id(obj) in seen:
            return
        seen = seen | {id(obj)}
        for name in sorted(dir(obj)):
            if name.startswith("_"):
                continue
            try:
                value = getattr(obj, name)
            except Exception:
                continue
            path = f"{prefix}{name}"
            if inspect.isroutine(value):
                try:
                    signature = str(inspect.signature(value))
                except (TypeError, ValueError):
                    signature = "(…)"
                doc = (inspect.getdoc(value) or "").strip().split("\n")[0][:200]
                out.append({"path": path, "kind": "method", "signature": signature, "doc": doc})
            elif inspect.isclass(value) or inspect.ismodule(value):
                continue
            elif isinstance(value, (str, int, float, bool, type(None))):
                out.append({"path": path, "kind": "value", "type": type(value).__name__})
            elif level < depth and not isinstance(value, (dict, list, tuple, set)):
                walk(value, f"{path}.", level + 1, seen)
            if len(out) >= 500:
                return

    walk(client, "", 0, set())
    return {"type": f"{type(client).__module__}.{type(client).__qualname__}", "members": out}


def run(request):
    loop = Loop()
    try:
        client = make_client(request.get("setup") or "", request.get("context") or {}, loop)
    except SyntaxError as exc:
        return {"ok": False, "error": {"kind": "setup", "message": f"SyntaxError in the setup code: {exc.msg}", "line": exc.lineno}}
    except MethodError as exc:
        return {"ok": False, "error": {"kind": "setup", "message": str(exc)}}
    except BaseException as exc:
        return failure("setup", exc, SETUP_FILE)
    mode = request.get("mode")
    limit = max(1, min(int(request.get("limit") or 1000), 100_000))
    try:
        if mode == "describe":
            return {"ok": True, "result": describe(client)}
        if mode == "call":
            target = resolve(client, request.get("method") or "")
            args = request.get("args")
            if not callable(target):
                value = target
            elif isinstance(args, list):
                value = target(*args)
            elif isinstance(args, dict):
                value = target(**args)
            else:
                value = target()
        else:
            program = runner.compile_body(request.get("code") or "")
            namespace = {"__name__": "__ow__", "__builtins__": __builtins__}
            namespace.update({"client": client, "params": request.get("params") or {}, "token": (request.get("context") or {}).get("token")})
            exec(program, namespace)
            value = namespace["__ow_main"]()
        value = loop.collect(loop.settle(value), limit)
    except SyntaxError as exc:
        return {"ok": False, "error": runner.syntax_error(exc)}
    except MethodError as exc:
        return {"ok": False, "error": {"kind": "sdk_method", "message": str(exc)}}
    except BaseException as exc:
        return failure("sdk", exc, CODE_FILE)
    try:
        return {"ok": True, "result": to_json(value)}
    except RecursionError:
        return {"ok": False, "error": {"kind": "serialization", "message": "The result is nested too deeply"}}


def main():
    env = os.environ.pop("OW_ENV", None)
    if env:
        runner.use_env(env)
    sys.stdout = runner.Channel(b"L")
    sys.stderr = runner.Channel(b"E")
    request = json.loads(sys.stdin.buffer.read())
    sys.stdin.close()
    result_fd = int(request.pop("resultFd", 3))
    cpu_seconds = request.pop("cpuSeconds", None)
    if cpu_seconds:
        runner.limit_cpu(cpu_seconds)
    start_forwarder()
    outcome = run(request)
    data = json.dumps(outcome, ensure_ascii=False, allow_nan=False, separators=(",", ":"), default=str).encode()
    view = memoryview(data)
    while view:
        view = view[os.write(result_fd, view):]
    os._exit(0)


if __name__ == "__main__":
    main()
