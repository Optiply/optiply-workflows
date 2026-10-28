"""
Runs inside the jail: one Python code block (or a syntax check), then exits.

Input is one JSON document on stdin (with "resultFd" and "cpuSeconds", the CPU time it may use from then on):
  {"mode": "run", "code": "...", "scope": {...}}
  {"mode": "check", "fields": [{"id": "...", "code": "..."}]}
With OW_ENV (a workflow's packages, M23) that directory goes first on sys.path, .pth files and all.
In a warm jail (OW_WARM names the result fd) it first imports OW_PREIMPORT's modules, writes one byte (\x06) to the
result fd to say it's ready, and only then waits for its request.
The outcome is one JSON document on its own pipe (the fd in "resultFd"), so nothing printed is mistaken for it:
  {"ok": true, "result": ...}
  {"ok": false, "error": {"kind": "syntax|runtime|serialization|memory", "message": "...", "line": 3, ...}}
  {"ok": true, "problems": [{"id": "...", "message": "...", "line": 1, "column": 5}]}
What the code prints is the run's log: sys.stdout and sys.stderr write tagged frames to fd 1 (\x1e, L or E, the text,
\x1f), so the server keeps their order and levels; anything written to the fds directly arrives untagged.
"""

import ast
import datetime
import decimal
import importlib
import io
import json
import math
import os
import resource
import site
import sys
import traceback

FILENAME = "<code>"


class Channel(io.TextIOBase):
    """sys.stdout or sys.stderr as tagged frames on fd 1 (written at once: PYTHONUNBUFFERED)."""

    def __init__(self, tag):
        super().__init__()
        self.tag = b"\x1e" + tag

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, text):
        if not text:
            return 0
        data = self.tag + text.replace("\x1e", "\ufffd").replace("\x1f", "\ufffd").encode("utf-8", "replace") + b"\x1f"
        view = memoryview(data)
        while view:
            view = view[os.write(1, view):]
        return len(text)


class Obj(dict):
    """A JSON object readable as `query1.data` as well as `query1["data"]` (dict methods win: use [] for those)."""

    __slots__ = ()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"{name!r} isn't there (the keys are {', '.join(map(repr, list(self)[:10]))})") from None


def compile_body(code):
    """The code as the body of a function, so `return` gives the result; line numbers stay the code's own."""
    tree = ast.parse(code, filename=FILENAME, mode="exec")
    fn = ast.FunctionDef(
        name="__ow_main",
        args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
        body=tree.body or [ast.Pass()],
        decorator_list=[],
        type_params=[],
        lineno=1,
        col_offset=0,
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, FILENAME, "exec")


class NotJson(Exception):
    pass


def to_json(value, path="result"):
    """The code's return value as JSON-safe data: pandas, numpy, dates and decimals converted, NaN as null."""
    if value is None or isinstance(value, (bool, str)):
        return value
    pd = sys.modules.get("pandas")
    np = sys.modules.get("numpy")
    # Missing values first: pandas' NaT is a datetime too.
    if pd is not None and (value is pd.NaT or value is pd.NA):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if not isinstance(key, (str, int, float, bool)) and key is not None:
                raise NotJson(f"{path} has a key of type {type(key).__name__}; keys must be strings or numbers")
            out[key if isinstance(key, str) else json.dumps(key)] = to_json(item, f"{path}[{key!r}]")
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json(item, f"{path}[{i}]") for i, item in enumerate(value)]
    if isinstance(value, decimal.Decimal):
        return to_json(float(value), path)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return value.total_seconds()
    # pandas and numpy, only when the code imported them (importing pandas here would cost ~200 ms).
    if pd is not None:
        if isinstance(value, pd.DataFrame):
            return to_json(value.to_dict(orient="records"), path)
        if isinstance(value, (pd.Series, pd.Index)):
            return to_json(value.tolist(), path)
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        if isinstance(value, pd.Timedelta):
            return value.total_seconds()
    if np is not None:
        if isinstance(value, np.ndarray):
            return to_json(value.tolist(), path)
        if isinstance(value, np.datetime64):
            return None if np.isnat(value) else str(value)
        if isinstance(value, np.generic):
            return to_json(value.item(), path)
    raise NotJson(f"{path} is a {type(value).__name__}, which isn't JSON (return dicts, lists, strings, numbers)")


def user_frames(tb):
    """The traceback's frames in the code itself (not the runner's)."""
    return [frame for frame in traceback.extract_tb(tb) if frame.filename == FILENAME]


def runtime_error(exc):
    frames = user_frames(exc.__traceback__)
    lines = [f"  line {f.lineno}" + (f", in {f.name}" if f.name != "__ow_main" else "") for f in frames]
    message = f"{type(exc).__name__}: {exc}"
    return {
        "kind": "memory" if isinstance(exc, MemoryError) else "runtime",
        "message": message,
        "line": frames[-1].lineno if frames else None,
        "traceback": "\n".join(lines),
    }


def syntax_error(exc):
    return {
        "kind": "syntax",
        "message": f"{type(exc).__name__}: {exc.msg}",
        "line": exc.lineno,
        "column": exc.offset,
    }


def run(code, scope):
    try:
        program = compile_body(code)
    except SyntaxError as exc:
        return {"ok": False, "error": syntax_error(exc)}
    namespace = {"__name__": "__ow__", "__builtins__": __builtins__}
    namespace.update(scope)
    try:
        exec(program, namespace)
        result = namespace["__ow_main"]()
    except BaseException as exc:  # SystemExit and KeyboardInterrupt are the code's failures too.
        return {"ok": False, "error": runtime_error(exc)}
    try:
        return {"ok": True, "result": to_json(result)}
    except NotJson as exc:
        return {"ok": False, "error": {"kind": "serialization", "message": str(exc)}}
    except RecursionError:
        return {"ok": False, "error": {"kind": "serialization", "message": "The result is nested too deeply"}}
    except Exception as exc:  # A pandas or numpy conversion that failed.
        return {"ok": False, "error": {"kind": "serialization", "message": f"{type(exc).__name__}: {exc}"}}


def check(fields):
    problems = []
    for field in fields:
        try:
            compile_body(field["code"])
        except SyntaxError as exc:
            problems.append({"id": field["id"], "message": f"{type(exc).__name__}: {exc.msg}", "line": exc.lineno, "column": exc.offset})
    return {"ok": True, "problems": problems}


def warm_up(ready_fd):
    """A warm jail: the usual packages imported ahead (quietly: their output isn't the code's), then ready."""
    names = [name for name in os.environ.pop("OW_PREIMPORT", "").split(",") if name.strip()]
    out, err = sys.stdout, sys.stderr
    with open(os.devnull, "w") as quiet:
        sys.stdout = sys.stderr = quiet
        try:
            for name in names:
                try:
                    importlib.import_module(name.strip())
                except Exception:
                    pass  # a missing package: the code's own import says so
        finally:
            sys.stdout, sys.stderr = out, err
    os.write(ready_fd, b"\x06")


def limit_cpu(seconds):
    """CPU time from now on (a warm jail's nsjail limit allowed for its imports and its wait)."""
    usage = resource.getrusage(resource.RUSAGE_SELF)
    total = math.ceil(usage.ru_utime + usage.ru_stime) + int(seconds)
    _, hard = resource.getrlimit(resource.RLIMIT_CPU)
    if hard != resource.RLIM_INFINITY:
        total = min(total, hard)  # it may only be lowered (a cold jail's is about this already)
    resource.setrlimit(resource.RLIMIT_CPU, (total, total))


def use_env(path):
    """A workflow's packages ahead of the image's: its versions win, the image's stay there for what it lacks."""
    before = list(sys.path)
    site.addsitedir(path)
    added = [entry for entry in sys.path if entry not in before]
    sys.path[:] = added + before


def main():
    env = os.environ.pop("OW_ENV", None)
    if env:
        use_env(env)
    warm = os.environ.pop("OW_WARM", None)
    if warm:
        warm_up(int(warm))
    sys.stdout = Channel(b"L")
    sys.stderr = Channel(b"E")
    request = json.loads(sys.stdin.buffer.read(), object_hook=Obj)
    sys.stdin.close()
    result_fd = int(request.pop("resultFd", 3))
    cpu_seconds = request.pop("cpuSeconds", None)
    if cpu_seconds:
        limit_cpu(cpu_seconds)
    if request.get("mode") == "check":
        outcome = check(request["fields"])
    else:
        outcome = run(request["code"], request.get("scope") or {})
    data = json.dumps(outcome, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    view = memoryview(data)
    while view:
        written = os.write(result_fd, view)
        view = view[written:]


if __name__ == "__main__":
    main()
    # Everything is written (the channels write at once): skip the interpreter's teardown, which with pandas
    # loaded takes longer than a small block's whole run, and which the server would wait for.
    os._exit(0)
