from __future__ import annotations

import json
from pathlib import Path

import pytest

from desktop.lib.state import StateFile
from desktop.stages.s1_fetch import FakeTransport, fetch


@pytest.fixture
def stub_log(tmp_path):
    from desktop.lib.log import StageLogger

    return StageLogger("s1_fetch", tmp_path)


def _make_index(*uuids: str, present: bool = True) -> dict:
    return {u: {"received_at": "now", "mtime": 100, "present": present} for u in uuids}


def test_fetch_pulls_new_uuids(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"\x00\x00", "abc-1.metadata": b"{}"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == ["abc-1"]
    assert (raw_root / "abc-1" / "abc-1.rm").read_bytes() == b"\x00\x00"
    assert state.contains("abc-1")


def test_fetch_skips_already_fetched(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []
    assert not (raw_root / "abc-1").exists()


def test_fetch_skips_uuids_marked_not_present(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    transport = FakeTransport(
        index=_make_index("abc-1", present=False),
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []


def test_fetch_continues_after_per_uuid_error(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    class FlakyTransport(FakeTransport):
        def pull(self, page_uuid: str, target_dir: Path) -> None:
            if page_uuid == "bad":
                raise RuntimeError("network glitch")
            return super().pull(page_uuid, target_dir)

    transport = FlakyTransport(
        index=_make_index("bad", "ok"),
        files={"ok": {"ok.rm": b"X"}, "bad": {"bad.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert "ok" in fetched
    assert "bad" not in fetched
    assert state.contains("ok")
    assert not state.contains("bad")


def test_force_re_fetches(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"NEW"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport, force={"abc-1"})

    assert fetched == ["abc-1"]
    assert (raw_root / "abc-1" / "abc-1.rm").read_bytes() == b"NEW"
