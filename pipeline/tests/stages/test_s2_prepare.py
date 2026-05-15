from __future__ import annotations

import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s2_prepare import FakeRenderer, RmsceneRenderer, prepare


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


# --- RmsceneRenderer ---------------------------------------------------------


def test_rmscene_renderer_raises_when_no_rm_file(tmp_path: Path):
    raw_dir = tmp_path / "empty-page"
    raw_dir.mkdir()
    with pytest.raises(FileNotFoundError):
        RmsceneRenderer().render(raw_dir, tmp_path / "out.png")


def test_rmscene_renderer_draws_lines_to_png(tmp_path: Path):
    # rmscene is lazy-imported inside render(); patch on the module level
    # so the lookup `rmscene.read_tree` returns our fake tree.
    rmscene = pytest.importorskip("rmscene")
    PIL = pytest.importorskip("PIL")
    from rmscene.scene_items import Line, Pen, PenColor, Point

    # rmscene coords on rM2: x centered ~[-702, +702], y top-anchored ~[0, 1872].
    line = Line(
        color=PenColor.BLACK,
        tool=Pen.FINELINER_1,
        points=[
            Point(x=-200, y=400, speed=0, direction=0, width=0, pressure=0),
            Point(x=200, y=600, speed=0, direction=0, width=0, pressure=0),
        ],
        thickness_scale=1.0,
        starting_length=0.0,
    )
    eraser = Line(
        color=PenColor.BLACK,
        tool=Pen.ERASER,
        points=[
            Point(x=0, y=500, speed=0, direction=0, width=0, pressure=0),
            Point(x=10, y=510, speed=0, direction=0, width=0, pressure=0),
        ],
        thickness_scale=1.0,
        starting_length=0.0,
    )

    class FakeTree:
        def walk(self):
            return [line, eraser]

    raw_dir = tmp_path / "page-uuid"
    raw_dir.mkdir()
    (raw_dir / "page-uuid.rm").write_bytes(b"\x00")  # rmscene won't see this — patched out
    out = tmp_path / "page.png"

    with patch("rmscene.read_tree", return_value=FakeTree()):
        RmsceneRenderer().render(raw_dir, out)

    from PIL import Image

    img = Image.open(out)
    assert img.size == (RmsceneRenderer.PAGE_WIDTH, RmsceneRenderer.PAGE_HEIGHT)
    # The single drawn line should leave some non-white pixels; eraser must
    # not draw anything (so a white canvas with eraser-only would still pass
    # by accident — the diagonal line is what guarantees ink).
    assert img.convert("L").getextrema()[0] < 250, "expected drawn strokes, image is blank"


def test_prepare_records_png_dimensions(tmp_path: Path, stub_log):
    """The admin page needs PNG width/height to flag scroll-extended pages.
    s2 reads the IHDR chunk and stamps the state record."""
    PIL = pytest.importorskip("PIL")
    from PIL import Image

    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "abc")

    # Build a 7×11 PNG so we can assert known dimensions are recorded.
    pil_path = tmp_path / "tmp.png"
    Image.new("RGB", (7, 11), "white").save(pil_path, "PNG")
    png_bytes = pil_path.read_bytes()

    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(png_bytes)
    prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    rec = state.get("abc")
    assert rec["png_width"] == 7
    assert rec["png_height"] == 11


def test_rmscene_renderer_extends_canvas_for_scrolled_page(tmp_path: Path):
    """Strokes below the standard 1872-row screen (user scrolled the rM
    page down and kept writing) must NOT be clipped — the canvas grows
    to fit them plus a small bottom padding."""
    rmscene = pytest.importorskip("rmscene")
    PIL = pytest.importorskip("PIL")
    from rmscene.scene_items import Line, Pen, PenColor, Point

    # A stroke that sits well below the first screen — simulates a
    # scrolled page where the user kept writing past y=1872.
    deep_y_top, deep_y_bot = 2400.0, 2800.0
    line = Line(
        color=PenColor.BLACK,
        tool=Pen.FINELINER_1,
        points=[
            Point(x=-100, y=deep_y_top, speed=0, direction=0, width=0, pressure=0),
            Point(x=100, y=deep_y_bot, speed=0, direction=0, width=0, pressure=0),
        ],
        thickness_scale=1.0,
        starting_length=0.0,
    )

    class FakeTree:
        def walk(self):
            return [line]

    raw_dir = tmp_path / "page-uuid"
    raw_dir.mkdir()
    (raw_dir / "page-uuid.rm").write_bytes(b"\x00")
    out = tmp_path / "page.png"

    with patch("rmscene.read_tree", return_value=FakeTree()):
        RmsceneRenderer().render(raw_dir, out)

    from PIL import Image

    img = Image.open(out)
    expected_h = int(deep_y_bot + RmsceneRenderer.BOTTOM_PADDING)
    assert img.size == (RmsceneRenderer.PAGE_WIDTH, expected_h)
    # The stroke must actually have been drawn in the lower half — if we
    # had drawn into a clipped/extended buffer with no shift, the bottom
    # would still be white.
    gray = img.convert("L")
    bottom_band = gray.crop((0, RmsceneRenderer.PAGE_HEIGHT, img.size[0], img.size[1]))
    assert bottom_band.getextrema()[0] < 250, "expected ink in the extended bottom band"


def test_rmscene_renderer_keeps_standard_height_when_strokes_fit(tmp_path: Path):
    """Short pages stay exactly PAGE_HEIGHT — no spurious padding for
    every normal page."""
    rmscene = pytest.importorskip("rmscene")
    PIL = pytest.importorskip("PIL")
    from rmscene.scene_items import Line, Pen, PenColor, Point

    line = Line(
        color=PenColor.BLACK,
        tool=Pen.FINELINER_1,
        points=[
            Point(x=0, y=100, speed=0, direction=0, width=0, pressure=0),
            Point(x=10, y=200, speed=0, direction=0, width=0, pressure=0),
        ],
        thickness_scale=1.0,
        starting_length=0.0,
    )

    class FakeTree:
        def walk(self):
            return [line]

    raw_dir = tmp_path / "page-uuid"
    raw_dir.mkdir()
    (raw_dir / "page-uuid.rm").write_bytes(b"\x00")
    out = tmp_path / "page.png"

    with patch("rmscene.read_tree", return_value=FakeTree()):
        RmsceneRenderer().render(raw_dir, out)

    from PIL import Image

    img = Image.open(out)
    assert img.size == (RmsceneRenderer.PAGE_WIDTH, RmsceneRenderer.PAGE_HEIGHT)
