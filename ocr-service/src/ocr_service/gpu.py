"""nvidia-smi parser.

Runs two `nvidia-smi --query-...` invocations: one for GPU totals, one for
per-process VRAM. The subprocess call is wrapped behind a `runner`
callable so tests can substitute a fake."""
from __future__ import annotations

import logging
import subprocess
from typing import Callable

log = logging.getLogger(__name__)

GpuRunner = Callable[[list[str]], str]


def _real_runner(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True, timeout=5)


def query_gpu(runner: GpuRunner | None = None) -> dict[str, object]:
    # Resolve via module lookup (not default-arg binding) so tests can
    # monkeypatch `ocr_service.gpu._real_runner` and have it take effect.
    if runner is None:
        runner = _real_runner
    try:
        totals_csv = runner(
            [
                "nvidia-smi",
                "--query-gpu=memory.total,memory.used,memory.free",
                "--format=csv,noheader,nounits",
            ]
        )
        procs_csv = runner(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ]
        )
    except FileNotFoundError:
        return {"available": False, "reason": "nvidia-smi_not_found"}
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": "nvidia-smi_timeout"}
    except subprocess.CalledProcessError as exc:
        return {
            "available": False,
            "reason": f"nvidia-smi_exit_{exc.returncode}",
        }

    # Multi-GPU note: nvidia-smi prints one row per GPU. We assume a
    # single-GPU host (RTX 3080 desktop) and take the first row. If
    # multi-GPU support is ever needed, the response shape needs a list.
    try:
        totals_line = totals_csv.strip().splitlines()[0]
        total_s, used_s, free_s = [x.strip() for x in totals_line.split(",")[:3]]
        total_mb, used_mb, free_mb = int(total_s), int(used_s), int(free_s)
    except (IndexError, ValueError) as exc:
        log.warning("nvidia-smi totals parse failed: %r (raw=%r)", exc, totals_csv)
        return {"available": False, "reason": "nvidia-smi_parse_error"}

    processes: list[dict[str, object]] = []
    for line in procs_csv.strip().splitlines():
        if not line.strip():
            continue
        parts = [x.strip() for x in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0])
            vram_mb = int(parts[2])
        except ValueError:
            continue
        processes.append({"pid": pid, "name": parts[1], "vram_mb": vram_mb})

    return {
        "available": True,
        "total_mb": total_mb,
        "used_mb": used_mb,
        "free_mb": free_mb,
        "processes": processes,
    }
