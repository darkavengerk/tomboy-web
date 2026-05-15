from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s4_write import backfill_status, write_pending


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s4_write", tmp_path)


def _seed_uuid(
    *,
    tmp_path: Path,
    prepared: StateFile,
    ocr_state: StateFile,
    ocr_root: Path,
    rm_uuid: str,
    text: str = "ocr text",
    last_modified_ms: str = "1715337600000",  # 2024-05-10T12:00:00Z
) -> Path:
    """Stage all the inputs s4 expects for a uuid."""
    png = tmp_path / "png" / rm_uuid / "page.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(b"\x89PNG fake")
    prepared.update(
        {
            rm_uuid: {
                "prepared_at": "x",
                "png_path": str(png),
                "metadata": {"lastModified": last_modified_ms},
            }
        }
    )
    ocr_root.mkdir(parents=True, exist_ok=True)
    (ocr_root / f"{rm_uuid}.json").write_text(
        json.dumps({"text": text, "model": "m", "prompt_hash": "h", "ts": "t", "uuid": rm_uuid})
    )
    ocr_state.update({rm_uuid: {"ocr_at": "now", "model": "m"}})
    return png


def _build_clients(
    *,
    existing_doc: dict | None = None,
    upload_ok: bool = True,
):
    fs = MagicMock()
    fs.get_note.return_value = existing_doc

    dbx = MagicMock()
    if upload_ok:
        dbx.upload.return_value = MagicMock()
        dbx.share_link.return_value = "https://dropbox.example/page.png"
    else:
        dbx.upload.side_effect = RuntimeError("dropbox down")

    return fs, dbx


def test_new_uuid_creates_new_note(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")

    fs, dbx = _build_clients(existing_doc=None)

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert "rm-1" in out
    fs.set_note.assert_called_once()
    args, _ = fs.set_note.call_args
    new_guid = args[0]
    payload = args[1]
    assert "[rm-1]" in payload["title"]
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid


def test_still_marked_overwrites_same_guid(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "existing-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc={
        "guid": "existing-guid",
        "title": "2024-05-10 리마커블([rm-1])",
        "deleted": False,
    })

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert "rm-1" in out
    args, _ = fs.set_note.call_args
    assert args[0] == "existing-guid"  # SAME guid
    assert mappings.get("rm-1")["tomboy_guid"] == "existing-guid"


def test_marker_removed_creates_new_note(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    # User has corrected and removed the [rm-1] marker
    fs, dbx = _build_clients(existing_doc={
        "guid": "old-guid",
        "title": "2024년 5월 10일 — 일기 (corrected)",
        "deleted": False,
    })

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    new_guid = args[0]
    assert new_guid != "old-guid"
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid


def test_doc_missing_treated_as_deleted(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc=None)  # doc missing

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    new_guid = args[0]
    assert new_guid != "old-guid"


def test_doc_soft_deleted_treated_as_deleted(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc={
        "guid": "old-guid",
        "title": "2024-05-10 리마커블([rm-1])",
        "deleted": True,
    })

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    assert args[0] != "old-guid"


def test_image_upload_failure_blocks_firestore_write(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")

    fs, dbx = _build_clients(existing_doc=None, upload_ok=False)

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert out == []
    fs.set_note.assert_not_called()
    assert not written.contains("rm-1")


def test_skips_already_written(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": "u"}})

    fs, dbx = _build_clients()

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert out == []
    fs.set_note.assert_not_called()


def test_image_path_format(tmp_path, stub_log):
    """Image lands at /Apps/Tomboy/diary-images/yyyy/mm/dd/<rm_uuid>/page.png."""
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(
        tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, rm_uuid="rm-1",
        last_modified_ms="1715337600000",  # 2024-05-10T12:00:00Z
    )

    fs, dbx = _build_clients(existing_doc=None)
    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    target = dbx.upload.call_args.args[1]
    assert target == "/Apps/Tomboy/diary-images/2024/05/10/rm-1/page.png"


# --- pipeline status integration ---------------------------------------------


class _FakeStatus:
    """In-memory _PipelineStatus stub. Tracks set/clear_rerun calls."""

    def __init__(self, seed: dict | None = None):
        self.docs: dict[str, dict] = dict(seed or {})
        self.set_calls: list[tuple[str, dict]] = []
        self.clear_calls: list[str] = []

    def get(self, page_uuid: str):
        return self.docs.get(page_uuid)

    def set(self, page_uuid: str, fields: dict):
        self.set_calls.append((page_uuid, fields))
        # Mimic Firestore merge.
        current = self.docs.get(page_uuid, {})
        merged = {**current, **fields}
        self.docs[page_uuid] = merged

    def clear_rerun(self, page_uuid: str):
        self.clear_calls.append(page_uuid)
        self.set(page_uuid, {"rerunRequested": False, "rerunRequestedAt": None})


def test_write_pending_records_status_and_clears_rerun(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(
        tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, rm_uuid="rm-1",
    )
    # Stamp the prepared record with image dims as s2 now does.
    rec = prepared.get("rm-1")
    rec.update({"png_width": 1404, "png_height": 2800})
    prepared.update({"rm-1": rec})

    status = _FakeStatus(seed={"rm-1": {"rerunRequested": True, "rerunRequestedAt": "x"}})
    fs, dbx = _build_clients(existing_doc=None)

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
        status=status,
    )

    # A status doc was written, and the rerun flag was explicitly cleared.
    set_uuids = [c[0] for c in status.set_calls]
    assert "rm-1" in set_uuids
    assert "rm-1" in status.clear_calls

    # The status doc carries the dims we recorded in prepared.
    rec = status.docs["rm-1"]
    assert rec["imageWidth"] == 1404
    assert rec["imageHeight"] == 2800
    assert rec["pageUuid"] == "rm-1"
    assert rec["tomboyGuid"]  # non-empty
    assert rec["imageUrl"] == "https://dropbox.example/page.png"
    assert rec["rerunRequested"] is False


def test_backfill_writes_only_for_missing_docs(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(
        tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, rm_uuid="rm-already",
    )
    _seed_uuid(
        tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, rm_uuid="rm-missing",
    )
    written.write({
        "rm-already": {"written_at": "x", "tomboy_guid": "g1", "image_url": "u1"},
        "rm-missing": {"written_at": "y", "tomboy_guid": "g2", "image_url": "u2"},
    })

    status = _FakeStatus(seed={"rm-already": {"pageUuid": "rm-already"}})
    n = backfill_status(
        written_state=written, prepared_state=prepared,
        ocr_root=ocr_root, status=status, log=stub_log,
    )
    assert n == 1
    # Only rm-missing got a fresh write; rm-already was untouched.
    backfilled = [c[0] for c in status.set_calls]
    assert backfilled == ["rm-missing"]


def test_backfill_skips_when_status_unavailable(tmp_path, stub_log):
    """Pipeline must keep working if Firestore status is misconfigured."""
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    written = StateFile(tmp_path / "state" / "written.json")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": "u"}})

    n = backfill_status(
        written_state=written, prepared_state=prepared,
        ocr_root=tmp_path / "ocr", status=None, log=stub_log,
    )
    assert n == 0
