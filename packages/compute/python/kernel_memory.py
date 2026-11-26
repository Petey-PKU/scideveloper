"""Per-cell memory sampling and best-effort Unix address-space limits."""

import contextlib
import os
import sys
import threading


def memory_reader():
    if sys.platform.startswith("linux"):
        page_size = os.sysconf("SC_PAGE_SIZE")

        def linux_memory():
            with open("/proc/self/statm", "rb") as stream:
                virtual, rss, *_ = stream.read().split()
            return int(virtual) * page_size, int(rss) * page_size

        return linux_memory
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                    "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage",
                )
            ]

        get_process = ctypes.WinDLL("kernel32").GetCurrentProcess
        get_process.restype = wintypes.HANDLE
        process = get_process()
        get_info = ctypes.WinDLL("psapi").GetProcessMemoryInfo
        get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        get_info.restype = wintypes.BOOL

        def windows_memory():
            info = Counters()
            info.cb = ctypes.sizeof(info)
            if not get_info(process, ctypes.byref(info), info.cb):
                raise OSError("GetProcessMemoryInfo failed")
            return None, info.WorkingSetSize

        return windows_memory
    if sys.platform == "darwin":
        import ctypes

        proc_pidinfo = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        proc_pidinfo.restype = ctypes.c_int
        pid = os.getpid()

        def mac_memory():
            info = (ctypes.c_uint64 * 16)()
            if proc_pidinfo(pid, 4, 0, info, ctypes.sizeof(info)) < 16:  # PROC_PIDTASKINFO
                raise OSError("proc_pidinfo failed")
            return info[0], info[1]

        return mac_memory
    return None


@contextlib.contextmanager
def address_space_limit(limit, virtual):
    previous = None
    if sys.platform.startswith("linux") or sys.platform == "darwin":
        try:
            import resource

            soft, hard = resource.getrlimit(resource.RLIMIT_AS)
            # Native libraries may already map more address space than the RSS budget.
            if virtual is not None and virtual < limit and (soft == resource.RLIM_INFINITY or limit < soft):
                resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
                previous = (soft, hard)
        except (ImportError, OSError, ValueError, OverflowError, AttributeError):
            pass
    try:
        yield
    finally:
        if previous is not None:
            resource.setrlimit(resource.RLIMIT_AS, previous)


@contextlib.contextmanager
def watch_memory(limit_mb, exceeded):
    if not limit_mb or limit_mb <= 0:
        yield
        return
    try:
        read = memory_reader()
        virtual, _ = read() if read else (None, None)
    except (ImportError, OSError, ValueError, AttributeError):
        read, virtual = None, None
    bytes_per_mb = 1024 * 1024
    limit = int(min(limit_mb, sys.maxsize // bytes_per_mb) * bytes_per_mb)

    def check():
        if read is None:
            return
        try:
            _, rss = read()
        except (OSError, ValueError):
            return
        if rss > limit:
            try:
                exceeded()
            finally:
                os._exit(137)

    stopped = threading.Event()

    def poll():
        while not stopped.wait(0.05):
            check()

    with address_space_limit(limit, virtual):
        check()
        monitor = threading.Thread(target=poll, daemon=True) if read is not None else None
        if monitor is not None:
            try:
                monitor.start()
            except RuntimeError:
                monitor = None
        try:
            yield
            check()
        finally:
            stopped.set()
            if monitor is not None:
                monitor.join()
