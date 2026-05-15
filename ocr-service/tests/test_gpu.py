"""nvidia-smi parser tests. Subprocess invocation is mocked — the real
binary is never called."""
from __future__ import annotations

import subprocess

from ocr_service.gpu import query_gpu


def _fake_runner(out_map: dict[str, str]):
    """Build a runner that picks an output based on the discriminator
    flag in the cmd args. out_map keys are unique substrings to match."""
    def run(cmd: list[str]) -> str:
        for key, out in out_map.items():
            if any(key in part for part in cmd):
                return out
        raise AssertionError(f"unexpected cmd: {cmd}")
    return run


def test_parses_totals_and_processes() -> None:
    runner = _fake_runner({
        "--query-gpu": "10240, 4280, 5960\n",
        "--query-compute-apps": "1234, ollama, 1700\n5678, ocr-service, 1200\n",
    })
    result = query_gpu(runner=runner)
    assert result["available"] is True
    assert result["total_mb"] == 10240
    assert result["used_mb"] == 4280
    assert result["free_mb"] == 5960
    procs = result["processes"]
    assert len(procs) == 2
    assert procs[0] == {"pid": 1234, "name": "ollama", "vram_mb": 1700}


def test_handles_no_processes() -> None:
    runner = _fake_runner({
        "--query-gpu": "10240, 0, 10240\n",
        "--query-compute-apps": "\n",
    })
    result = query_gpu(runner=runner)
    assert result["available"] is True
    assert result["processes"] == []


def test_handles_missing_binary() -> None:
    def boom(cmd: list[str]) -> str:
        raise FileNotFoundError("nvidia-smi")
    result = query_gpu(runner=boom)
    assert result == {"available": False, "reason": "nvidia-smi_not_found"}


def test_handles_timeout() -> None:
    def slow(cmd: list[str]) -> str:
        raise subprocess.TimeoutExpired(cmd, 5)
    result = query_gpu(runner=slow)
    assert result["available"] is False
    assert "timeout" in result["reason"]


def test_handles_unparseable_totals() -> None:
    # If nvidia-smi runs but returns garbage for the totals query (driver
    # in a weird state, version drift, etc.), the contract is still 200
    # with available:false — NOT a 500 from the endpoint.
    runner = _fake_runner({
        "--query-gpu": "garbage no commas\n",
        "--query-compute-apps": "\n",
    })
    result = query_gpu(runner=runner)
    assert result["available"] is False
    assert "parse" in result["reason"]


def test_handles_empty_totals() -> None:
    runner = _fake_runner({
        "--query-gpu": "\n",
        "--query-compute-apps": "\n",
    })
    result = query_gpu(runner=runner)
    assert result["available"] is False
    assert "parse" in result["reason"]
