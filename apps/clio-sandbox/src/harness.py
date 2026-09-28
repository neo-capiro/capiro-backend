# Clio analysis sandbox harness (assistant-parity F4).
#
# Inner hardening layer only — tenant isolation comes from the Fargate
# microVM + no-egress security group + zero-permission task role (see
# docs/adr/0001-clio-analysis-sandbox-isolation.md). This harness:
#   1. sets POSIX rlimits (CPU/memory/processes/file-size/fds),
#   2. pre-imports the explicitly allowed analysis stack,
#   3. installs an audit hook that raises on network, subprocess, and
#      native-code-loading events,
#   4. applies a calm Capiro chart theme and forces the matplotlib Agg backend,
#   5. executes ./code.py in a fresh namespace,
#   6. saves open matplotlib figures to ./out/fig_N.png and, if the script
#      defined a `results` object (dict / list / DataFrame), writes
#      ./out/results.json.
#
# Datasets are pre-written into the working directory by the runner
# (./data/<name>.csv or .json) before this harness starts.

import io
import json
import os
import sys

WORKDIR = os.getcwd()
OUT_DIR = os.path.join(WORKDIR, "out")
MAX_FIGURES = 6

os.makedirs(OUT_DIR, exist_ok=True)

# ── 1. POSIX rlimits (degrade gracefully on non-POSIX dev hosts) ──────────
try:
    import resource

    CPU_SECONDS = int(os.environ.get("SANDBOX_CPU_SECONDS", "30"))
    MEM_BYTES = int(os.environ.get("SANDBOX_MEM_BYTES", str(1024 * 1024 * 1024)))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (MEM_BYTES, MEM_BYTES))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 * 1024, 20 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
except Exception:  # noqa: BLE001 - resource is unavailable on Windows dev hosts
    sys.stderr.write("[harness] rlimits unavailable on this platform\n")


def _linux_task_context():
    """Return aggregate-only task counts; never expose process names or IDs."""
    context = {}
    try:
        resource_module = globals().get("resource")
        if resource_module is None:
            return context
        soft, hard = resource_module.getrlimit(resource_module.RLIMIT_NPROC)
        context["nproc_soft"] = soft
        context["nproc_hard"] = hard
    except Exception:  # noqa: BLE001 - diagnostic only
        pass

    if not sys.platform.startswith("linux"):
        return context

    try:
        getuid = getattr(os, "getuid", None)
        if getuid is None:
            return context
        real_uid = getuid()
        uid_processes = 0
        uid_tasks = 0
        self_threads = None
        with os.scandir("/proc") as entries:
            for entry in entries:
                if not entry.name.isdigit():
                    continue
                try:
                    uid = None
                    threads = None
                    with io.open(
                        os.path.join(entry.path, "status"),
                        "r",
                        encoding="utf-8",
                        errors="replace",
                    ) as status_file:
                        for line in status_file:
                            if line.startswith("Uid:"):
                                uid = int(line.split()[1])
                            elif line.startswith("Threads:"):
                                threads = int(line.split()[1])
                            if uid is not None and threads is not None:
                                break
                    if uid == real_uid and threads is not None:
                        uid_processes += 1
                        uid_tasks += threads
                        if entry.name == str(os.getpid()):
                            self_threads = threads
                except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
                    continue
        context["uid_processes"] = uid_processes
        context["uid_tasks"] = uid_tasks
        if self_threads is not None:
            context["self_threads"] = self_threads
    except Exception:  # noqa: BLE001 - diagnostic must not affect containment
        pass
    return context


def _report_warm_import_failure(stage, module_name, exc):  # noqa: ANN001
    """Emit one bounded, aggregate-only diagnostic for the trusted warm stack."""
    import traceback

    frames = traceback.extract_tb(exc.__traceback__, limit=8)
    diagnostic = {
        "stage": stage,
        "module": module_name,
        "error": type(exc).__name__,
        "message": " ".join(str(exc).split())[:160],
        "frames": [
            f"{os.path.basename(frame.filename)[:80]}:{frame.lineno}:{frame.name[:80]}"
            for frame in frames
        ],
        **_linux_task_context(),
    }
    encoded = json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":"))
    sys.stderr.write(f"[harness] warm-import diagnostic {encoded[:2048]}\n")


# ── 2. Pre-import the allowed analysis stack BEFORE arming the hook ───────
# NumPy/SciPy/statsmodels legitimately load native extensions during import.
# Warm the exact allowed stack first so the audit hook constrains USER code
# without breaking approved numerical routines.
_warm_import_module = "matplotlib"
try:
    import matplotlib

    matplotlib.use("Agg")
    _warm_import_module = "matplotlib.pyplot"
    import matplotlib.pyplot as plt  # noqa: F401

    _warm_import_module = "cycler"
    from cycler import cycler

    _warm_import_module = "matplotlib.rcParams"
    CAPIRO_COLORS = [
        "#A85F42",  # rust
        "#263243",  # graphite
        "#5E738D",  # slate blue
        "#C78F77",  # soft rust
        "#7F8A99",  # neutral slate
        "#B9C0C9",  # light neutral
    ]
    matplotlib.rcParams.update(
        {
            "figure.figsize": (9.0, 5.2),
            "figure.facecolor": "#FFFFFF",
            "savefig.facecolor": "#FFFFFF",
            "axes.facecolor": "#FFFFFF",
            "axes.edgecolor": "#C3CBD7",
            "axes.labelcolor": "#48525F",
            "axes.titlecolor": "#131A24",
            "axes.titleweight": "semibold",
            "axes.titlesize": 14,
            "axes.labelsize": 10,
            "axes.grid": True,
            "axes.axisbelow": True,
            "axes.prop_cycle": cycler(color=CAPIRO_COLORS),
            "grid.color": "#EAEDF1",
            "grid.linewidth": 0.8,
            "grid.alpha": 0.9,
            "xtick.color": "#616B79",
            "ytick.color": "#616B79",
            "text.color": "#263243",
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "legend.frameon": False,
            "legend.fontsize": 9,
            "lines.linewidth": 2.0,
            "patch.edgecolor": "#FFFFFF",
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.18,
        }
    )
except Exception as exc:  # noqa: BLE001 - matplotlib genuinely optional locally
    _report_warm_import_failure("visual", _warm_import_module, exc)

_warm_import_module = "numpy"
try:
    import numpy  # noqa: F401

    _warm_import_module = "pandas"
    import pandas  # noqa: F401

    _warm_import_module = "scipy"
    import scipy  # noqa: F401

    _warm_import_module = "scipy.stats"
    import scipy.stats  # noqa: F401

    _warm_import_module = "statsmodels.api"
    import statsmodels.api  # noqa: F401

    _warm_import_module = "seaborn"
    import seaborn  # noqa: F401

    _warm_import_module = "networkx"
    import networkx  # noqa: F401
except Exception as exc:  # noqa: BLE001 - pure-python analysis can still run
    _report_warm_import_failure("analysis", _warm_import_module, exc)

# ── 3. Audit hook: no network, no subprocesses, no NEW native loading ──────
BLOCKED_PREFIXES = (
    "socket.",
    "subprocess.",
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.fork",
    "ctypes.",
    "webbrowser.",
    "ftplib.",
    "smtplib.",
)
ALLOWED_EXACT = {
    # benign event some libraries touch at runtime
    "socket.gethostname",
}


def _audit(event, args):  # noqa: ANN001
    if event in ALLOWED_EXACT:
        return
    for prefix in BLOCKED_PREFIXES:
        if event.startswith(prefix):
            raise RuntimeError(f"sandbox: blocked operation '{event}'")


sys.addaudithook(_audit)

# ── 4. Run the user code ───────────────────────────────────────────────────
CODE_PATH = os.path.join(WORKDIR, "code.py")
with io.open(CODE_PATH, "r", encoding="utf-8") as fh:
    user_code = fh.read()

namespace = {"__name__": "__main__", "__file__": CODE_PATH}
exit_code = 0
try:
    exec(compile(user_code, "code.py", "exec"), namespace)  # noqa: S102
except SystemExit as exc:  # honor explicit sys.exit codes
    exit_code = int(exc.code or 0)
except Exception:  # noqa: BLE001 - report, don't crash the harness
    import traceback

    traceback.print_exc()
    exit_code = 1

# ── 5. Persist figures + results ───────────────────────────────────────────
try:
    import matplotlib.pyplot as plt

    for index, num in enumerate(plt.get_fignums()[:MAX_FIGURES]):
        figure = plt.figure(num)
        figure.savefig(
            os.path.join(OUT_DIR, f"fig_{index + 1}.png"),
            format="png",
            dpi=140,
            bbox_inches="tight",
            facecolor="#FFFFFF",
        )
        plt.close(figure)
except Exception:  # noqa: BLE001
    pass

try:
    results = namespace.get("results")
    if results is not None:
        try:
            import pandas as pd

            if isinstance(results, pd.DataFrame):
                results = results.head(500).to_dict(orient="records")
        except Exception:  # noqa: BLE001
            pass
        with io.open(os.path.join(OUT_DIR, "results.json"), "w", encoding="utf-8") as fh:
            json.dump(results, fh, default=str, ensure_ascii=False)
except Exception:  # noqa: BLE001
    sys.stderr.write("[harness] could not serialize `results`\n")

sys.exit(exit_code)
