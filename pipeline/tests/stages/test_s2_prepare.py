from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s2_prepare import FakeRenderer, prepare


_MIN_PNG = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
    "0000000D4944415478DA63F8FFFF3F0005FE02FECCB2F0E40000000049454E44AE426082"
)


def _seed_raw(raw_root: Path, uuid: str) -> None:
    d = raw_root / uuid
    d.mkdir(parents=True)
    (d / f"{uuid}.rm").write_bytes(b"\x00" * 32)
    fixtures_meta = Path(__file__).parent.parent / "fixtures" / "sample-metadata.json"
    shutil.copy(fixtures_meta, d / f"{uuid}.metadata")


@pytest.fixture
def stub_log(tmp_path):
    return StageLogger("s2_prepare", tmp_path)


def test_prepare_renders_new_uuids(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "abc-1")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == ["abc-1"]
    assert (png_root / "abc-1" / "page.png").read_bytes() == _MIN_PNG
    rec = state.get("abc-1")
    assert rec is not None
    assert "png_path" in rec
    assert rec["metadata"]["visibleName"] == "Diary Page 2024-05-10"


def test_prepare_skips_already_prepared(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "abc-1")
    state = StateFile(tmp_path / "state" / "prepared.json")
    state.write({"abc-1": {"prepared_at": "old", "png_path": "x", "metadata": {}}})
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == []


def test_prepare_skips_uuid_missing_metadata(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    d = raw_root / "no-meta"
    d.mkdir()
    (d / "no-meta.rm").write_bytes(b"\x00")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == []
    assert not state.contains("no-meta")


def test_prepare_continues_after_renderer_error(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "ok")
    _seed_raw(raw_root, "bad")
    state = StateFile(tmp_path / "state" / "prepared.json")

    class FlakyRenderer(FakeRenderer):
        def render(self, raw_dir: Path, output_path: Path) -> None:
            if raw_dir.name == "bad":
                raise RuntimeError("rmrl crashed")
            return super().render(raw_dir, output_path)

    renderer = FlakyRenderer(_MIN_PNG)
    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)
    assert "ok" in prepared
    assert "bad" not in prepared
