from __future__ import annotations

import json
from pathlib import Path

from desktop.lib.log import StageLogger


def test_info_writes_jsonl_line(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("fetched", uuid="abc-123", bytes=100)
    jsonl = (tmp_path / "logs" / "s1_fetch.jsonl").read_text().strip()
    record = json.loads(jsonl)
    assert record["stage"] == "s1_fetch"
    assert record["level"] == "info"
    assert record["event"] == "fetched"
    assert record["uuid"] == "abc-123"
    assert record["bytes"] == 100
    assert "ts" in record


def test_info_writes_human_readable_line(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("fetched", uuid="abc-123")
    line = (tmp_path / "logs" / "s1_fetch.log").read_text().strip()
    assert "s1_fetch" in line
    assert "info" in line
    assert "fetched" in line
    assert "uuid=abc-123" in line


def test_error_level(tmp_path: Path):
    log = StageLogger("s2_prepare", tmp_path)
    log.error("convert_failed", uuid="abc", reason="rmrl crashed")
    jsonl = (tmp_path / "logs" / "s2_prepare.jsonl").read_text().strip()
    record = json.loads(jsonl)
    assert record["level"] == "error"
    assert record["reason"] == "rmrl crashed"


def test_multiple_calls_append(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("a", uuid="1")
    log.info("b", uuid="2")
    lines = (tmp_path / "logs" / "s1_fetch.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["event"] == "a"
    assert json.loads(lines[1])["event"] == "b"


def test_creates_parent_dir(tmp_path: Path):
    nested = tmp_path / "deep" / "nested"
    log = StageLogger("s1", nested)
    log.info("ok")
    assert (nested / "logs" / "s1.jsonl").exists()
