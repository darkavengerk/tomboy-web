"""Per-line crop tool for fine-tuning data prep. Run on demand, not in pipeline.

The .rm parser is plug-in. The default uses ``rmrl``'s stroke iterator if
available; tests inject a fake by passing a stroke list directly.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class Stroke:
    y_min: float
    y_max: float


def cluster_strokes_by_y(
    strokes: list[Stroke], *, line_threshold: float
) -> list[tuple[float, float]]:
    """Sort strokes by y_min, then greedily merge into bands when the next
    stroke's y_min is within ``line_threshold`` of the current band's y_max."""
    if not strokes:
        return []
    sorted_strokes = sorted(strokes, key=lambda s: s.y_min)
    bands: list[list[float]] = [[sorted_strokes[0].y_min, sorted_strokes[0].y_max]]
    for s in sorted_strokes[1:]:
        cur = bands[-1]
        if s.y_min - cur[1] <= line_threshold:
            cur[1] = max(cur[1], s.y_max)
        else:
            bands.append([s.y_min, s.y_max])
    return [(b[0], b[1]) for b in bands]


def crop_lines(
    page_png: Path, line_bands: list[tuple[float, float]], out_dir: Path
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    page = Image.open(page_png)
    width, _ = page.size
    for i, (y_min, y_max) in enumerate(line_bands, start=1):
        crop = page.crop((0, int(y_min), width, int(y_max)))
        crop.save(out_dir / f"line-{i:02d}.png")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--threshold", type=float, default=20.0)
    args = parser.parse_args(argv)

    from desktop.lib.config import load_config

    cfg = load_config(args.config)
    rm_path = cfg.data_dir / "raw" / args.uuid / f"{args.uuid}.rm"
    page_png = cfg.data_dir / "corrections" / args.uuid / "page.png"
    out_dir = cfg.data_dir / "corrections" / args.uuid / "lines"

    # Stroke extraction is implementation-defined; the implementer wires a
    # real parser here. For now, this CLI requires the user to pre-supply
    # strokes via a fixture or to extend with rmrl's stroke iterator.
    print(f"segment_lines: TODO wire real .rm parser for {rm_path}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
