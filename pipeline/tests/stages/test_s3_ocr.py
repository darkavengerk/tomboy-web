from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.ocr_backends.base import OCRBackend, OCRResult
from desktop.stages.s3_ocr import run_ocr


class StubBackend(OCRBackend):
    def __init__(self, text: str = "stub-text"):
        self.text = text
        self.calls: list[Path] = []

    def ocr(self, image_path: Path) -> OCRResult:
        self.calls.append(image_path)
        return OCRResult(
            text=self.text,
            model="stub-model",
            prompt_hash="stubhash",
            ts=datetime.now(timezone.utc),
        )


class FailingBackend(OCRBackend):
    def ocr(self, image_path: Path) -> OCRResult:
        raise RuntimeError("model exploded")


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s3_ocr", tmp_path)


def _seed_prepared(state: StateFile, png_root: Path, uuid: str) -> None:
    p = png_root / uuid / "page.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"PNGSTUB")
    state.update({uuid: {"prepared_at": "x", "png_path": str(p), "metadata": {}}})


def test_runs_ocr_for_pending_uuids(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "abc-1")

    backend = StubBackend(text="hello")
    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=backend,
    )
    assert processed == ["abc-1"]
    assert (ocr_root / "abc-1.json").exists()
    record = json.loads((ocr_root / "abc-1.json").read_text())
    assert record["text"] == "hello"
    assert record["model"] == "stub-model"
    assert ocr_state.contains("abc-1")


def test_skips_already_done(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "abc-1")
    ocr_state.write({"abc-1": {"ocr_at": "old", "model": "x"}})

    backend = StubBackend()
    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=backend,
    )
    assert processed == []
    assert backend.calls == []


def test_continues_after_backend_error(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "good-1")

    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=FailingBackend(),
    )
    assert processed == []
    assert not ocr_state.contains("good-1")


def test_only_uuids_filters_to_requested_pages(tmp_path: Path, stub_log):
    # Spec invariant I2: stages must be operable on a specific page uuid.
    # `only_uuids` lets the user pre-flight the 14GB model + a single page
    # before committing to the full pending set.
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "abc-1")
    _seed_prepared(prepared, tmp_path / "png", "abc-2")
    _seed_prepared(prepared, tmp_path / "png", "abc-3")

    backend = StubBackend()
    processed = run_ocr(
        prepared_state=prepared,
        ocr_state=ocr_state,
        ocr_root=ocr_root,
        log=stub_log,
        backend=backend,
        only_uuids={"abc-2"},
    )
    assert processed == ["abc-2"]
    assert [p.parent.name for p in backend.calls] == ["abc-2"]
    assert ocr_state.contains("abc-2")
    assert not ocr_state.contains("abc-1")
    assert not ocr_state.contains("abc-3")
