from __future__ import annotations

from unittest.mock import MagicMock

from desktop.run_pipeline import run_all


def test_runs_stages_in_order():
    calls: list[str] = []
    stages = {
        "s1_fetch": lambda: calls.append("s1") or 0,
        "s2_prepare": lambda: calls.append("s2") or 0,
        "s3_ocr": lambda: calls.append("s3") or 0,
        "s4_write": lambda: calls.append("s4") or 0,
    }
    failed = run_all(stages=stages)
    assert calls == ["s1", "s2", "s3", "s4"]
    assert failed is None


def test_stops_on_first_failure():
    calls: list[str] = []

    def boom():
        calls.append("s2")
        raise RuntimeError("nope")

    stages = {
        "s1_fetch": lambda: calls.append("s1") or 0,
        "s2_prepare": boom,
        "s3_ocr": lambda: calls.append("s3") or 0,
        "s4_write": lambda: calls.append("s4") or 0,
    }
    failed = run_all(stages=stages)
    assert calls == ["s1", "s2"]
    assert failed == "s2_prepare"
