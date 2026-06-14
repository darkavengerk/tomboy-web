from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.config import FolderRoute
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s4_write import backfill_status, write_pending


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s4_write", tmp_path)


def _route_for(source_folder):
    if source_folder == "Slip-Notes":
        return FolderRoute("[0] Slip-Box", "{datetime} 리마커블 {label}([{unit_key}])",
                           split=True, labels=("上", "下"))
    if source_folder == "Notes":
        return FolderRoute("기록", "{date} 리마커블([{unit_key}])")
    return FolderRoute("일기", "{date} 리마커블([{unit_key}])")  # Diary / None default


def _seed_unit(*, tmp_path, prepared, ocr_state, ocr_root, key, source_folder=None,
               text="ocr text", last_modified_ms="1715337600000"):
    png = tmp_path / "png" / key.replace("#", "_") / "page.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    png.write_bytes(b"\x89PNG fake")
    rec = {"prepared_at": "x", "png_path": str(png),
           "metadata": {"lastModified": last_modified_ms}, "source_folder": source_folder}
    prepared.update({key: rec})
    ocr_root.mkdir(parents=True, exist_ok=True)
    (ocr_root / f"{key}.json").write_text(
        json.dumps({"text": text, "model": "m", "prompt_hash": "h", "ts": "t", "uuid": key})
    )
    ocr_state.update({key: {"ocr_at": "now", "model": "m"}})


def _states(tmp_path):
    return (
        StateFile(tmp_path / "state" / "prepared.json"),
        StateFile(tmp_path / "state" / "ocr-done.json"),
        StateFile(tmp_path / "state" / "written.json"),
        StateFile(tmp_path / "state" / "mappings.json"),
        tmp_path / "ocr",
    )


def test_whole_page_diary_note(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Diary")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert out == ["rm-1"]
    payload = fs.set_note.call_args.args[1]
    assert payload["tags"] == ["system:notebook:일기"]
    assert "[rm-1]" in payload["title"]
    assert "<link:url>" not in payload["xmlContent"]
    assert written.contains("rm-1")


def test_slip_halves_two_notes(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    for key in ("p#0", "p#1"):
        _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
                   ocr_root=ocr_root, key=key, source_folder="Slip-Notes")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert sorted(out) == ["p#0", "p#1"]
    titles = [c.args[1]["title"] for c in fs.set_note.call_args_list]
    assert any("上([p#0])" in t for t in titles)
    assert any("下([p#1])" in t for t in titles)
    for c in fs.set_note.call_args_list:
        p = c.args[1]
        assert p["tags"] == ["system:notebook:[0] Slip-Box"]
        assert "이전: 없음" in p["xmlContent"]


def test_empty_ocr_unit_skipped(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#0", source_folder="Slip-Notes", text="실제 글자")
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#1", source_folder="Slip-Notes", text="   \n  ")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert out == ["p#0"]
    assert not written.contains("p#1")
    assert fs.set_note.call_count == 1


def test_marker_uses_unit_key_for_overwrite(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#0", source_folder="Slip-Notes")
    mappings.write({"p#0": {"tomboy_guid": "existing", "first_seen": "2024-05-10T12:00:00+00:00"}})
    fs = MagicMock()
    fs.get_note.return_value = {"guid": "existing",
                                "title": "2024-05-10 12:00 리마커블 上([p#0])", "deleted": False}

    write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                  written_state=written, mappings=mappings, firestore=fs,
                  log=stub_log, route_for=_route_for)

    assert fs.set_note.call_args.args[0] == "existing"  # overwrote same guid


def test_new_unit_mints_guid(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Notes")
    fs = MagicMock(); fs.get_note.return_value = None

    write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                  written_state=written, mappings=mappings, firestore=fs,
                  log=stub_log, route_for=_route_for)
    new_guid = fs.set_note.call_args.args[0]
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid
    assert fs.set_note.call_args.args[1]["tags"] == ["system:notebook:기록"]


def test_skips_already_written(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Notes")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": ""}})
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)
    assert out == []
    fs.set_note.assert_not_called()


def test_backfill_skips_when_status_unavailable(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    written = StateFile(tmp_path / "state" / "written.json")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": ""}})
    n = backfill_status(written_state=written, prepared_state=prepared,
                        ocr_root=tmp_path / "ocr", status=None, log=stub_log)
    assert n == 0
