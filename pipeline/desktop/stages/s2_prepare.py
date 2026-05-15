"""Stage 2: rasterize each rM page in ``raw/<uuid>/`` to ``png/<uuid>/page.png``."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Protocol

from desktop.lib.config import load_config
from desktop.lib.log import StageLogger
from desktop.lib.pipeline_status import fetch_pending_reruns
from desktop.lib.state import StateFile


class Renderer(Protocol):
    def render(self, raw_dir: Path, output_path: Path) -> None: ...


class FakeRenderer:
    def __init__(self, png_bytes: bytes) -> None:
        self.png_bytes = png_bytes

    def render(self, raw_dir: Path, output_path: Path) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(self.png_bytes)


def _read_png_size(path: Path) -> tuple[int, int] | None:
    """Return (width, height) of a PNG by reading the IHDR chunk.

    Avoids requiring Pillow in stages/tests that use ``FakeRenderer``
    with synthetic tiny PNGs. Returns ``None`` if the file isn't a
    parseable PNG (we want size-recording to fail open — pipeline
    progress trumps a missing metadata field).
    """
    try:
        with open(path, "rb") as f:
            sig = f.read(8)
            if sig != b"\x89PNG\r\n\x1a\n":
                return None
            # IHDR is always the first chunk; bytes 16..24 are width+height
            # big-endian uint32.
            f.read(8)  # length + "IHDR"
            wh = f.read(8)
            if len(wh) != 8:
                return None
            w = int.from_bytes(wh[0:4], "big")
            h = int.from_bytes(wh[4:8], "big")
            return w, h
    except OSError:
        return None


class RmsceneRenderer:
    """Render a single .rm v6 page to PNG via rmscene + Pillow.

    rmrl can't be used here: it's a notebook-level renderer that requires a
    `<doc-uuid>.content` sibling (see `rmrl/sources.py:get_source`). Our
    pipeline keeps each rM page as a flat `<page-uuid>.rm` file in the Pi
    inbox per spec §4.3, so we use rmscene (the v6 reference Python parser)
    and rasterize strokes ourselves.

    The output is intentionally minimal: black/colored polylines on white,
    fixed stroke width. Pressure modulation, pen-specific brushes, and
    template backgrounds are out of scope for v1 — OCR only needs legible
    strokes, and the rendered PNG also functions as the human-visible
    image link in the Tomboy note.
    """

    # rM2 stroke coordinate space: x centered at 0 (range ~[-702, +702]),
    # y top-anchored at 0 (range ~[0, 1872]). PAGE_HEIGHT is the on-device
    # viewport height (one screen), NOT a hard ceiling — the user can
    # scroll the page on the rM and keep writing below 1872. We render to
    # `max(PAGE_HEIGHT, max_stroke_y + BOTTOM_PADDING)` so scrolled pages
    # are captured in full instead of being silently clipped to the first
    # screen. PAGE_WIDTH stays fixed (no horizontal scroll on rM).
    PAGE_WIDTH = 1404
    PAGE_HEIGHT = 1872
    STROKE_WIDTH = 2
    BOTTOM_PADDING = 32

    _COLOR_MAP: dict[int, tuple[int, int, int]] = {
        # PenColor enum values, by .value (avoid import-time enum dependency).
        0: (0, 0, 0),          # BLACK
        1: (128, 128, 128),    # GRAY
        2: (255, 255, 255),    # WHITE — rare; mostly used by eraser modes
        3: (255, 220, 0),      # YELLOW
        4: (0, 150, 0),        # GREEN
        5: (255, 105, 180),    # PINK
        6: (0, 90, 200),       # BLUE
        7: (220, 0, 0),        # RED
        8: (170, 170, 170),    # GRAY_OVERLAP
        9: (255, 250, 100),    # HIGHLIGHT
        10: (0, 200, 100),     # GREEN_2
        11: (0, 200, 220),     # CYAN
        12: (200, 0, 200),     # MAGENTA
        13: (255, 235, 80),    # YELLOW_2
    }

    def render(self, raw_dir: Path, output_path: Path) -> None:
        rms = list(raw_dir.glob("*.rm"))
        if not rms:
            raise FileNotFoundError(f"No .rm file under {raw_dir}")

        # Imported lazily so tests / users without rmscene installed can still
        # import this module and use a different renderer.
        import rmscene
        from rmscene.scene_items import Line
        from PIL import Image, ImageDraw

        with open(rms[0], "rb") as f:
            tree = rmscene.read_tree(f)

        cx = self.PAGE_WIDTH / 2

        # First pass: collect drawable strokes and the max y observed. We
        # need the extent before allocating the canvas so scrolled-down
        # handwriting isn't clipped.
        strokes: list[tuple[tuple[int, int, int], list[tuple[float, float]]]] = []
        max_y: float = 0.0
        for item in tree.walk():
            if not isinstance(item, Line):
                continue
            # Eraser strokes don't draw ink — skip. (Rendering them as white
            # over a white background would be a no-op anyway.)
            if item.tool.name.startswith("ERASER"):
                continue
            if len(item.points) < 2:
                continue
            # Prefer the explicit RGBA from newer firmware; fall back to the
            # PenColor enum lookup.
            if item.color_rgba is not None:
                color = item.color_rgba[:3]
            else:
                color = self._COLOR_MAP.get(int(item.color), (0, 0, 0))
            pts = [(p.x + cx, p.y) for p in item.points]
            strokes.append((color, pts))
            for _, py in pts:
                if py > max_y:
                    max_y = py

        canvas_h = max(self.PAGE_HEIGHT, int(max_y + self.BOTTOM_PADDING))
        img = Image.new("RGB", (self.PAGE_WIDTH, canvas_h), color="white")
        draw = ImageDraw.Draw(img)
        for color, pts in strokes:
            draw.line(pts, fill=color, width=self.STROKE_WIDTH)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(output_path, "PNG")


def prepare(
    *,
    raw_root: Path,
    png_root: Path,
    state: StateFile,
    log: StageLogger,
    renderer: Renderer,
    force: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        state.remove(u)

    prepared: list[str] = []
    for uuid_dir in sorted(p for p in raw_root.iterdir() if p.is_dir()):
        uuid = uuid_dir.name
        if state.contains(uuid):
            continue
        meta_path = uuid_dir / f"{uuid}.metadata"
        if not meta_path.exists():
            log.error("missing_metadata", uuid=uuid)
            continue
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            target = png_root / uuid / "page.png"
            renderer.render(uuid_dir, target)
            record: dict[str, object] = {
                "prepared_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "png_path": str(target.resolve()),
                "metadata": metadata,
            }
            # PNG size lets the admin view flag scroll-extended pages
            # (height > 1872). Missing here just means the admin will
            # show "—" for that field; pipeline keeps moving.
            size = _read_png_size(target)
            if size is not None:
                record["png_width"], record["png_height"] = size
            state.update({uuid: record})
            log.info("prepared", uuid=uuid)
            prepared.append(uuid)
        except Exception as e:
            log.error("prepare_failed", uuid=uuid, reason=str(e))
    return prepared


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    parser.add_argument("--uuid", help="Only process this single uuid")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    raw_root = cfg.data_dir / "raw"
    png_root = cfg.data_dir / "png"
    png_root.mkdir(parents=True, exist_ok=True)
    state = StateFile(cfg.data_dir / "state" / "prepared.json")
    log = StageLogger("s2_prepare", cfg.data_dir)
    renderer = RmsceneRenderer()

    if args.uuid:
        # Drop everything except the requested uuid by faking a single-uuid raw_root view.
        # Simplest: reuse `prepare` with `force={uuid}` and let it process all then early-return.
        # For now, just call with force; the per-uuid skip prevents redundant work.
        pass
    # Fold in any UUIDs the admin page has marked for re-processing.
    rerun_uuids = fetch_pending_reruns(cfg, log)
    force = set(args.force) | set(rerun_uuids)
    if args.uuid:
        force.add(args.uuid)
    prepared = prepare(
        raw_root=raw_root,
        png_root=png_root,
        state=state,
        log=log,
        renderer=renderer,
        force=force,
    )
    print(f"s2_prepare: {len(prepared)} pages prepared")
    return 0


if __name__ == "__main__":
    sys.exit(main())
