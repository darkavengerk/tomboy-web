"""Pure-Pillow raster helpers for finding ink-free horizontal bands.

Used by both the slip-note split (``s2_prepare``) and the tall-page tile
slicer (``ocr_backends.local_vlm``). Operates on already-open PIL Image
objects, so importing this module pulls in **no** torch/transformers —
keeping s2 light. No numpy dep either.
"""
from __future__ import annotations

from typing import Any

INK_THRESHOLD = 250  # any pixel darker than near-white counts as ink


def ink_row_mask(image: Any) -> list[bool]:
    """For each row, True iff any pixel is darker than near-white."""
    gray = image.convert("L")
    w, h = gray.size
    data = gray.tobytes()
    assert len(data) == w * h, "unexpected PIL row stride"
    rows: list[bool] = [False] * h
    for y in range(h):
        base = y * w
        if min(data[base : base + w]) < INK_THRESHOLD:
            rows[y] = True
    return rows


def find_gap_near(ink_rows: list[bool], target: int, search: int) -> int:
    """Return the midpoint of the longest blank run within
    [target-search, target+search]. Falls back to ``target`` when the
    window has no blank row."""
    n = len(ink_rows)
    lo = max(0, target - search)
    hi = min(n, target + search)
    best_mid = target
    best_len = 0
    run_start: int | None = None
    for i in range(lo, hi):
        if not ink_rows[i]:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                run_len = i - run_start
                if run_len > best_len:
                    best_len = run_len
                    best_mid = (run_start + i) // 2
                run_start = None
    if run_start is not None:
        run_len = hi - run_start
        if run_len > best_len:
            best_len = run_len
            best_mid = (run_start + hi) // 2
    return best_mid


def find_blank_row_near(image: Any, target: int, search: int) -> int:
    """Convenience: scan ``image`` for the blank band nearest ``target``."""
    return find_gap_near(ink_row_mask(image), target, search)
