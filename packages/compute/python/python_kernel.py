import io
import inspect
import json
import os
import platform
import socket
import sys
import tempfile
import threading
import time
import traceback
import types
import contextlib
import importlib.metadata
from collections.abc import Sized
from typing import Optional

from execution_artifacts import capture_metrics, capture_plotly, export_figures, output_files
from kernel_memory import watch_memory

PROTOCOL_STDOUT = sys.stdout
PROTOCOL_LOCK = threading.Lock()


def send_message(message):
    line = json.dumps(message) + "\n"
    with PROTOCOL_LOCK:
        PROTOCOL_STDOUT.write(line)
        PROTOCOL_STDOUT.flush()


class CellStream(io.StringIO):
    def __init__(self, req_id, stream, original):
        super().__init__()
        self.req_id = req_id
        self.stream = stream
        self.original = original

    @property
    def encoding(self):
        return self.original.encoding

    @property
    def errors(self):
        return self.original.errors

    def write(self, value):
        count = super().write(value)
        for offset in range(0, count, 8192):
            send_message({"id": self.req_id, "event": "output", "stream": self.stream,
                          "chunk": value[offset:offset + 8192]})
        return count

WRITE_BLOCKED = "SciDeveloper Sandbox Guard: write/delete blocked outside session output directory"
NETWORK_BLOCKED = "SciDeveloper Sandbox Guard: unauthorized outbound network connection blocked"
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC | os.O_EXCL | getattr(os, "O_TEMPORARY", 0)


def canonical_path(path):
    return os.path.normcase(os.path.realpath(path))


def within(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False  # Windows paths can be on different drives.


SYSTEM_TEMP = canonical_path(tempfile.gettempdir())


def host_key(host):
    if isinstance(host, bytes):
        host = host.decode("ascii", errors="replace")
    return host.lower().rstrip(".") if isinstance(host, str) else ""


def directory_path(dir_fd):
    try:
        return os.readlink(f"/proc/self/fd/{dir_fd}")
    except OSError:
        if sys.platform == "darwin":
            import fcntl

            if hasattr(fcntl, "F_GETPATH"):
                result = fcntl.fcntl(dir_fd, fcntl.F_GETPATH, bytes(1024))
                return os.fsdecode(result.split(b"\0", 1)[0])
        raise


class SandboxGuard:
    def __init__(self, output_dir, working_dir, workspace_dir, allowed_hosts):
        self.output = canonical_path(output_dir)
        self.working = canonical_path(working_dir)
        self.workspace = canonical_path(workspace_dir or working_dir)
        datasets = os.path.join(self.workspace, "datasets")
        self.datasets = {datasets, canonical_path(datasets)}
        self.raw_root = workspace_dir is not None
        self.hosts = {host_key(host) for host in allowed_hosts} - {""}
        self.resolved_hosts = set()

    def check_write(self, target, dir_fd=None, *, recursive=False, follow=True):
        if isinstance(target, int):
            # An audited writable open already authorized this descriptor.
            if not recursive:
                return
            raise PermissionError(WRITE_BLOCKED)
        target = os.fsdecode(target)
        if dir_fd not in (None, -1) and not os.path.isabs(target):
            try:
                target = os.path.join(directory_path(dir_fd), target)
            except OSError:
                raise PermissionError(WRITE_BLOCKED) from None
        lexical = os.path.normcase(os.path.abspath(target))
        resolved = canonical_path(target) if follow else os.path.join(
            canonical_path(os.path.dirname(os.path.abspath(target))), os.path.basename(lexical)
        )
        for candidate in (lexical, resolved):
            if any(within(candidate, root) or (recursive and within(root, candidate)) for root in self.datasets):
                raise PermissionError(WRITE_BLOCKED)
            if recursive and within(self.workspace, candidate):
                raise PermissionError(WRITE_BLOCKED)
            if within(candidate, self.output):
                continue
            if within(candidate, self.workspace) and self.raw_root:
                if self.working != self.workspace and within(self.working, self.workspace) and within(candidate, self.working):
                    continue
                raise PermissionError(WRITE_BLOCKED)
            if not within(candidate, self.working) and not within(candidate, SYSTEM_TEMP):
                raise PermissionError(WRITE_BLOCKED)

    def check_host(self, host, *, resolved=False):
        key = host_key(host)
        if key not in LOOPBACK_HOSTS and key not in self.hosts and not (resolved and key in self.resolved_hosts):
            raise PermissionError(NETWORK_BLOCKED)


ACTIVE_GUARD = None
LAST_GUARD = None
ORIGINAL_GETADDRINFO = socket.getaddrinfo


def guarded_getaddrinfo(host, *args, **kwargs):
    guard = ACTIVE_GUARD
    if guard is not None and host is not None:
        guard.check_host(host)
    addresses = ORIGINAL_GETADDRINFO(host, *args, **kwargs)
    if guard is not None and host_key(host) in guard.hosts - LOOPBACK_HOSTS:
        guard.resolved_hosts.update(host_key(address[4][0]) for address in addresses)
    return addresses


def sandbox_audit(event, args):
    guard = ACTIVE_GUARD
    if guard is None:
        return
    if event == "open":
        target, mode, flags = args
        if (mode and any(char in mode for char in "wax+")) or flags & WRITE_FLAGS:
            guard.check_write(target)
    elif event in {"os.remove", "os.rmdir", "shutil.rmtree"}:
        guard.check_write(args[0], args[1], recursive=True, follow=False)
    elif event in {"os.rename", "os.link"}:
        guard.check_write(args[0], args[2], recursive=True, follow=event == "os.link")
        guard.check_write(args[1], args[3], recursive=True, follow=False)
    elif event == "os.truncate":
        guard.check_write(args[0])
    elif event in {"os.mkdir", "os.chmod", "os.chown"}:
        guard.check_write(args[0], args[-1])
    elif event == "os.utime":
        guard.check_write(args[0], args[-1])
    elif event == "os.symlink":
        guard.check_write(args[1], args[2], follow=False)
    elif event in {"socket.connect", "socket.sendto", "socket.sendmsg"} and args[1] is not None:
        address = args[1]
        guard.check_host(address[0] if isinstance(address, tuple) else None, resolved=True)
    elif event in {"socket.getaddrinfo", "socket.gethostbyname"} and args[0] is not None:
        guard.check_host(args[0])
    elif event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "os.startfile", "os.startfile/2"}:
        raise PermissionError("SciDeveloper Sandbox Guard: child process launch blocked")


sys.addaudithook(sandbox_audit)
socket.getaddrinfo = guarded_getaddrinfo

# Ensure non-interactive plotting backend
os.environ.setdefault("MPLBACKEND", "Agg")
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None

SESSION_GLOBALS = {"__name__": "__scideveloper__"}
TRACKED_PACKAGES = [
    "numpy",
    "pandas",
    "scipy",
    "matplotlib",
    "seaborn",
    "scikit-learn",
    "statsmodels",
    "biopython",
    "rdkit",
    "scanpy",
    "anndata",
]


def capture_env(working_dir: str) -> dict:
    pkgs = {}
    for pkg in TRACKED_PACKAGES:
        try:
            pkgs[pkg] = importlib.metadata.version(pkg)
        except Exception:
            pass
    return {
        "pythonVersion": platform.python_version(),
        "pythonExecutable": sys.executable,
        "executable": sys.executable,
        "platform": platform.platform(),
        "packages": pkgs,
        "workingDirectory": working_dir,
    }


def execute_code(code: str, output_dir: str, working_dir: str, workspace_dir: Optional[str] = None,
                 strict_sandbox: bool = True, allowed_hosts=(), req_id=None, memory_limit_mb=None) -> dict:
    global ACTIVE_GUARD, LAST_GUARD
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(working_dir, exist_ok=True)
    os.chdir(working_dir)

    SESSION_GLOBALS["SCIDEV_OUTPUT_DIR"] = output_dir
    SESSION_GLOBALS["SCIDEV_WORK_DIR"] = working_dir
    SESSION_GLOBALS["SCIDEV_WORKSPACE_DIR"] = workspace_dir or working_dir

    stdout_buf = CellStream(req_id, "stdout", sys.stdout)
    stderr_buf = CellStream(req_id, "stderr", sys.stderr)
    t0 = time.perf_counter()
    exit_code = 0
    before_files = output_files(output_dir)
    LAST_GUARD = SandboxGuard(output_dir, working_dir, workspace_dir, allowed_hosts) if strict_sandbox else None

    def memory_exceeded():
        send_message({"id": req_id, "event": "memory-limit",
                      "error": f"Python sandbox memory limit exceeded ({memory_limit_mb:g} MB RSS)"})

    with contextlib.ExitStack() as stack:
        stack.enter_context(watch_memory(memory_limit_mb, memory_exceeded))
        stack.enter_context(contextlib.redirect_stdout(stdout_buf))
        stack.enter_context(contextlib.redirect_stderr(stderr_buf))
        ACTIVE_GUARD = LAST_GUARD
        try:
            try:
                exec(compile(code, "<scideveloper-cell>", "exec"), SESSION_GLOBALS, SESSION_GLOBALS)
            except (Exception, SystemExit):
                exit_code = 1
                traceback.print_exc()
            exported_metrics = capture_metrics(SESSION_GLOBALS.get("SCIDEV_METRICS"))
            plotly_charts, plotly_failed = capture_plotly(
                output_dir, before_files, SESSION_GLOBALS.pop("SCIDEV_PLOTLY_CHARTS", None)
            )
        finally:
            ACTIVE_GUARD = None

        figure_bundles, figure_failed = export_figures(output_dir, plt)

    created_files = [os.path.join(output_dir, name)
                     for name in sorted(output_files(output_dir).keys() - before_files.keys())]
    result = {
        "exitCode": 1 if plotly_failed or figure_failed else exit_code,
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "durationMs": int((time.perf_counter() - t0) * 1000),
        "figures": [bundle["pngPath"] for bundle in figure_bundles],
        "figureBundles": figure_bundles,
        "createdFiles": created_files,
        "metrics": exported_metrics,
    }
    if plotly_charts:
        result["plotlyCharts"] = plotly_charts
    return result


def list_variables():
    global ACTIVE_GUARD
    variables = []
    dataframe = getattr(sys.modules.get("pandas"), "DataFrame", ())
    ndarray = getattr(sys.modules.get("numpy"), "ndarray", ())
    ACTIVE_GUARD = LAST_GUARD
    try:
        for name, value in SESSION_GLOBALS.copy().items():
            if not isinstance(name, str) or name.startswith(("_", "SCIDEV_")) or (
                isinstance(value, (types.ModuleType, type)) or inspect.isroutine(value)
            ):
                continue
            try:
                info = {"name": name, "typeName": type(value).__name__}
                if isinstance(value, dataframe):
                    rows, cols = value.shape
                    info.update(typeName="DataFrame", shape=f"{rows} × {cols}",
                                sizeBytes=int(value.memory_usage(deep=True).sum()),
                                columns=list(map(str, value.columns[:30])),
                                preview=value.head(3).to_string(max_cols=6)[:300])
                elif isinstance(value, ndarray):
                    info.update(typeName=f"ndarray[{value.dtype}]", shape=" × ".join(map(str, value.shape)),
                                sizeBytes=int(value.nbytes), preview=repr(value)[:240])
                elif hasattr(value, "n_obs") and hasattr(value, "n_vars"):
                    info.update(typeName="AnnData", shape=f"{value.n_obs} cells × {value.n_vars} genes",
                                preview=repr(value)[:240])
                else:
                    info.update(sizeBytes=sys.getsizeof(value), preview=repr(value)[:240])
                    if isinstance(value, Sized):
                        info["shape"] = str(len(value))
                variables.append(info)
            except Exception:
                variables.append({"name": name, "typeName": type(value).__name__, "preview": "<preview unavailable>"})
    finally:
        ACTIVE_GUARD = None
    return variables


def main():
    global LAST_GUARD
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req.get("op")
            if op == "ping":
                resp = {"id": req_id, "ok": True, "result": {"status": "alive"}}
            elif op == "env":
                resp = {
                    "id": req_id,
                    "ok": True,
                    "result": capture_env(req.get("workingDir", os.getcwd())),
                }
            elif op == "exec":
                result = execute_code(
                    req.get("code", ""),
                    req.get("outputDir", os.getcwd()),
                    req.get("workingDir", os.getcwd()),
                    req.get("workspaceDir"),
                    req.get("strictSandbox", True),
                    req.get("allowedHosts", []),
                    req_id,
                    req.get("memoryLimitMb"),
                )
                resp = {"id": req_id, "ok": True, "result": result}
            elif op == "vars":
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    resp = {"id": req_id, "ok": True, "result": list_variables()}
            elif op == "reset":
                LAST_GUARD = None
                SESSION_GLOBALS.clear()
                SESSION_GLOBALS["__name__"] = "__scideveloper__"
                resp = {"id": req_id, "ok": True, "result": {"reset": True}}
            else:
                resp = {"id": req_id, "ok": False, "error": f"Unknown op: {op}"}
        except Exception as exc:
            resp = {"id": req_id, "ok": False, "error": str(exc)}
        send_message(resp)


if __name__ == "__main__":
    main()
