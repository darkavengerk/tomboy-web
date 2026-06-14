from __future__ import annotations

import pytest


def test_find_blank_row_snaps_to_central_gap():
    PIL = pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    from desktop.lib.raster import find_blank_row_near

    # 400px tall, ink only at y=50 and y=350 → window around 200 is blank.
    img = Image.new("RGB", (60, 400), "white")
    d = ImageDraw.Draw(img)
    d.line([(5, 50), (55, 50)], fill="black", width=3)
    d.line([(5, 350), (55, 350)], fill="black", width=3)

    cut = find_blank_row_near(img, target=200, search=120)
    # The whole [80, 320] window is blank → midpoint 200.
    assert 180 <= cut <= 220


def test_find_blank_row_falls_back_to_target_when_all_ink():
    PIL = pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    from desktop.lib.raster import find_blank_row_near

    img = Image.new("RGB", (60, 400), "white")
    d = ImageDraw.Draw(img)
    # Fill every row in the search window with ink.
    for y in range(80, 321):
        d.line([(0, y), (59, y)], fill="black", width=1)

    cut = find_blank_row_near(img, target=200, search=120)
    assert cut == 200
