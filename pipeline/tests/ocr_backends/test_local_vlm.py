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
