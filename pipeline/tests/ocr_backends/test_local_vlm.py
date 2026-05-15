from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

from desktop.ocr_backends.base import OCRBackend, get_backend
from desktop.ocr_backends.local_vlm import LocalVlmBackend


def test_package_import_registers_local_vlm_backend():
    """Regression: with an empty `desktop/ocr_backends/__init__.py`, the
    @register_backend decorator on LocalVlmBackend never fires unless
    someone imports the local_vlm submodule directly — so `s3_ocr.py`
    (which only imports from `desktop.ocr_backends.base`) crashed at
    runtime with `KeyError: 'local_vlm' not registered`.

    Importing the package alone must be enough.
    """
    # Drop cached modules to simulate a cold start.
    for mod in list(sys.modules):
        if mod.startswith("desktop.ocr_backends"):
            del sys.modules[mod]

    pkg = importlib.import_module("desktop.ocr_backends")
    assert "local_vlm" in pkg.list_backends()


@pytest.fixture
def prompt_file(tmp_path: Path) -> Path:
    p = tmp_path / "prompt.txt"
    p.write_text("system prompt body")
    return p


def test_construction_does_not_load_model(prompt_file):
    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    assert b._model is None  # type: ignore[attr-defined]


def test_missing_prompt_file_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        LocalVlmBackend(
            model_id="m",
            quantization="4bit",
            max_new_tokens=128,
            system_prompt_path=tmp_path / "missing.txt",
        )


def test_ocr_returns_result(monkeypatch, prompt_file, tmp_path: Path):
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")

    b = LocalVlmBackend(
        model_id="model-x",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    monkeypatch.setattr(b, "_load_model", lambda: None)
    monkeypatch.setattr(b, "_run_inference", lambda image, prompt: "  hello\n  ")

    result = b.ocr(img)
    assert result.text == "hello"
    assert result.model == "model-x"
    assert result.prompt_hash  # non-empty


def test_prompt_hash_is_stable(monkeypatch, prompt_file, tmp_path: Path):
    img = tmp_path / "p.png"
    img.write_bytes(b"X")

    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    monkeypatch.setattr(b, "_load_model", lambda: None)
    monkeypatch.setattr(b, "_run_inference", lambda image, prompt: "x")

    r1 = b.ocr(img)
    r2 = b.ocr(img)
    assert r1.prompt_hash == r2.prompt_hash


def test_registered_under_local_vlm_name(prompt_file):
    backend = get_backend(
        "local_vlm",
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    assert isinstance(backend, OCRBackend)


def test_split_to_tiles_passes_through_short_image(prompt_file):
    PIL = pytest.importorskip("PIL")
    from PIL import Image

    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    img = Image.new("RGB", (1404, 1872), "white")
    tiles = b._split_to_tiles(img)
    assert len(tiles) == 1
    assert tiles[0].size == (1404, 1872)


def test_split_to_tiles_slices_tall_image_into_screens(prompt_file):
    PIL = pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    # Simulate a 3-screen scrolled page: ink in two narrow bands separated
    # by wide blank gaps near each target cut row. The cut should snap
    # into those gaps (i.e., not land inside an ink band).
    img = Image.new("RGB", (1404, 5000), "white")
    draw = ImageDraw.Draw(img)
    # Three ink bands at y=200, y=2000, y=3800 — well clear of the
    # nominal cut rows at 1872 and 3744.
    for y in (200, 2000, 3800):
        draw.line([(50, y), (1350, y)], fill="black", width=4)

    tiles = b._split_to_tiles(img)
    assert len(tiles) >= 2, "expected at least one cut for a 5000-row image"
    # Tiles must seam exactly — no gap, no overlap — and together cover
    # the full height.
    cumulative = sum(t.size[1] for t in tiles)
    assert cumulative == 5000
    # Each non-final tile's cut should land in a blank band (no ink on
    # the boundary row).
    y = 0
    for t in tiles[:-1]:
        y += t.size[1]
        boundary_row = img.crop((0, y - 1, 1404, y)).convert("L")
        assert boundary_row.getextrema()[0] >= 250, (
            f"cut at y={y} landed on an ink row; tiling would split text"
        )


def test_find_gap_near_snaps_to_blank_band():
    # Mostly inky, with a blank band [490, 510). Target at 500 should snap
    # into the band's midpoint (499).
    rows = [True] * 1000
    for i in range(490, 510):
        rows[i] = False
    cut = LocalVlmBackend._find_gap_near(rows, target=500, search=50)
    assert 490 <= cut < 510


def test_find_gap_near_falls_back_to_target_when_no_gap():
    rows = [True] * 1000
    cut = LocalVlmBackend._find_gap_near(rows, target=500, search=50)
    assert cut == 500


def test_run_inference_concatenates_tile_outputs(monkeypatch, prompt_file, tmp_path: Path):
    """A tall image is sliced; per-tile inference outputs are joined with
    newlines and stripped of whitespace per tile."""
    PIL = pytest.importorskip("PIL")
    from PIL import Image

    img_path = tmp_path / "tall.png"
    Image.new("RGB", (1404, 5000), "white").save(img_path, "PNG")

    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    monkeypatch.setattr(b, "_load_model", lambda: None)
    monkeypatch.setattr(
        b,
        "_split_to_tiles",
        lambda image: [Image.new("RGB", (1404, 1872), "white") for _ in range(3)],
    )
    calls: list[str] = []

    def fake_infer(tile, prompt):
        idx = len(calls)
        calls.append(prompt)
        return ["  tile-0  ", "tile-1", "  "][idx]

    monkeypatch.setattr(b, "_infer_image", fake_infer)

    out = b._run_inference(img_path, "system prompt")
    # Empty/whitespace-only tile drops out; non-empty are stripped and joined.
    assert out == "tile-0\ntile-1"
    assert calls == ["system prompt"] * 3
