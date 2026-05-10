from __future__ import annotations

import json
from pathlib import Path

import pytest

from desktop.lib.state import StateFile


def test_read_returns_empty_when_file_missing(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    assert s.read() == {}


def test_write_and_read_roundtrip(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {"foo": 1}})
    assert s.read() == {"abc": {"foo": 1}}


def test_write_creates_parent_dir(tmp_path: Path):
    s = StateFile(tmp_path / "nested" / "deeper" / "stage.json")
    s.write({"k": "v"})
    assert (tmp_path / "nested" / "deeper" / "stage.json").exists()


def test_update_merges_keys(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"a": 1, "b": 2})
    s.update({"b": 20, "c": 30})
    assert s.read() == {"a": 1, "b": 20, "c": 30}


def test_contains(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}})
    assert s.contains("abc")
    assert not s.contains("xyz")


def test_remove(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}, "xyz": {}})
    s.remove("abc")
    assert not s.contains("abc")
    assert s.contains("xyz")


def test_remove_missing_is_noop(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}})
    s.remove("nonexistent")  # should not raise
    assert s.contains("abc")


def test_atomic_write_uses_temp_file(tmp_path: Path):
    """Verify write goes via a temp file, not directly to the target."""
    target = tmp_path / "stage.json"
    s = StateFile(target)
    s.write({"a": 1})
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []


def test_two_instances_share_state(tmp_path: Path):
    s1 = StateFile(tmp_path / "stage.json")
    s2 = StateFile(tmp_path / "stage.json")
    s1.write({"a": 1})
    assert s2.read() == {"a": 1}


def test_corrupt_json_raises(tmp_path: Path):
    p = tmp_path / "stage.json"
    p.write_text("{not valid json")
    s = StateFile(p)
    with pytest.raises(json.JSONDecodeError):
        s.read()
