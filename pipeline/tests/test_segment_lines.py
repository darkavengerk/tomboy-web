from __future__ import annotations

from pathlib import Path

from desktop.tools.segment_lines import Stroke, cluster_strokes_by_y, crop_lines


def test_cluster_groups_close_strokes():
    strokes = [
        Stroke(y_min=10, y_max=30),
        Stroke(y_min=12, y_max=28),
        Stroke(y_min=200, y_max=230),
        Stroke(y_min=205, y_max=232),
    ]
    bands = cluster_strokes_by_y(strokes, line_threshold=50)
    assert len(bands) == 2
    assert bands[0] == (10, 30)
    assert bands[1] == (200, 232)


def test_cluster_handles_overlap():
    strokes = [
        Stroke(y_min=0, y_max=20),
        Stroke(y_min=15, y_max=40),  # overlaps with #1
    ]
    bands = cluster_strokes_by_y(strokes, line_threshold=10)
    assert len(bands) == 1
    assert bands[0] == (0, 40)


def test_crop_lines_writes_per_line_pngs(tmp_path: Path):
    # Create a 100x300 white PNG
    from PIL import Image

    page = tmp_path / "page.png"
    Image.new("RGB", (100, 300), "white").save(page)
    out_dir = tmp_path / "lines"
    bands = [(0, 100), (150, 250)]
    crop_lines(page, bands, out_dir)
    files = sorted(out_dir.glob("line-*.png"))
    assert [f.name for f in files] == ["line-01.png", "line-02.png"]
    img = Image.open(files[0])
    assert img.size[1] == 100
