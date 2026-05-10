from __future__ import annotations

import json
from pathlib import Path

from pi.inbox_watcher import scan_inbox, update_index


def _make_pair(inbox: Path, page_uuid: str) -> None:
    (inbox / f"{page_uuid}.metadata").write_text(
        json.dumps({"visibleName": "x", "lastModified": "1715337600000"})
    )
    (inbox / f"{page_uuid}.rm").write_bytes(b"\x00" * 16)


def test_scan_finds_metadata_files(tmp_path: Path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_pair(inbox, "abc-1")
    _make_pair(inbox, "abc-2")
    res = scan_inbox(inbox)
    assert "abc-1" in res
    assert "abc-2" in res
    assert "mtime" in res["abc-1"]
    assert "received_at" in res["abc-1"]


def test_scan_ignores_non_metadata_files(tmp_path: Path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "foo.rm").write_bytes(b"")
    (inbox / "bar.txt").write_text("nope")
    assert scan_inbox(inbox) == {}


def test_update_index_preserves_received_at(tmp_path: Path):
    index = tmp_path / "index.json"
    initial = {"abc-1": {"received_at": "2024-05-10T00:00:00Z", "mtime": 100, "present": True}}
    index.write_text(json.dumps(initial))
    new_scan = {"abc-1": {"mtime": 200, "received_at": "2024-05-11T00:00:00Z"}}
    update_index(index, new_scan)
    after = json.loads(index.read_text())
    # Existing received_at preserved; mtime updated; present True
    assert after["abc-1"]["received_at"] == "2024-05-10T00:00:00Z"
    assert after["abc-1"]["mtime"] == 200
    assert after["abc-1"]["present"] is True


def test_update_index_marks_missing_as_not_present(tmp_path: Path):
    index = tmp_path / "index.json"
    initial = {"abc-1": {"received_at": "old", "mtime": 1, "present": True}}
    index.write_text(json.dumps(initial))
    update_index(index, {})  # nothing in inbox now
    after = json.loads(index.read_text())
    assert after["abc-1"]["present"] is False
    # received_at still preserved
    assert after["abc-1"]["received_at"] == "old"


def test_update_index_creates_new_entries(tmp_path: Path):
    index = tmp_path / "index.json"  # does not exist
    new_scan = {"new-1": {"mtime": 1, "received_at": "now"}}
    update_index(index, new_scan)
    after = json.loads(index.read_text())
    assert after["new-1"]["present"] is True
