from __future__ import annotations

import shutil
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.tools.extract_corrections import extract, parse_corrected_text


_NOTE_CONTENT = (
    '<note-content version="0.1">'
    "2024-05-10 다이어리\n\n"
    "교정된 첫째 줄\n교정된 둘째 줄\n\n"
    "---\n\n"
    "https://dropbox.example/page.png"
    "</note-content>"
)


def test_parse_corrected_text():
    text = parse_corrected_text(_NOTE_CONTENT)
    assert text == "교정된 첫째 줄\n교정된 둘째 줄"


def test_skips_marker_present(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    out_root = tmp_path / "corrections"
    png_root = tmp_path / "png"
    (png_root / "rm-1").mkdir(parents=True)
    (png_root / "rm-1" / "page.png").write_bytes(b"PNG")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    (ocr_root / "rm-1.json").write_text('{"text": "ocr"}')

    fs = MagicMock()
    fs.get_note.return_value = {
        "title": "2024-05-10 리마커블([rm-1])",  # marker present
        "xmlContent": _NOTE_CONTENT,
        "deleted": False,
    }
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    assert out == []
    assert not (out_root / "rm-1").exists()


def test_emits_triple_when_marker_removed(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    out_root = tmp_path / "corrections"
    png_root = tmp_path / "png"
    (png_root / "rm-1").mkdir(parents=True)
    (png_root / "rm-1" / "page.png").write_bytes(b"PNG-bytes")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    (ocr_root / "rm-1.json").write_text('{"text": "원본 ocr"}')

    fs = MagicMock()
    fs.get_note.return_value = {
        "title": "2024-05-10 다이어리",  # marker REMOVED
        "xmlContent": _NOTE_CONTENT,
        "deleted": False,
    }
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    assert "rm-1" in out
    triple = out_root / "rm-1"
    assert (triple / "page.png").read_bytes() == b"PNG-bytes"
    assert (triple / "ocr.txt").read_text() == "원본 ocr"
    assert (triple / "corrected.txt").read_text() == "교정된 첫째 줄\n교정된 둘째 줄"
    assert corrections_state.contains("rm-1")


def test_idempotent(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    corrections_state.write({"rm-1": {"corrected": True}})
    fs = MagicMock()
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=tmp_path / "out", png_root=tmp_path / "png", ocr_root=tmp_path / "ocr",
        firestore=fs, log=log,
    )
    assert out == []
    fs.get_note.assert_not_called()
