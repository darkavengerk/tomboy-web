from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from desktop.ocr_backends.base import (
    OCRBackend,
    OCRResult,
    get_backend,
    register_backend,
)


def test_ocr_result_is_frozen():
    r = OCRResult(text="hi", model="m", prompt_hash="h", ts=datetime.now(timezone.utc))
    with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
        r.text = "no"  # type: ignore[misc]


def test_register_and_instantiate_backend():
    @register_backend("test_stub")
    class StubBackend(OCRBackend):
        def ocr(self, image_path: Path) -> OCRResult:
            return OCRResult(
                text="stub", model="stub", prompt_hash="0", ts=datetime.now(timezone.utc)
            )

    backend = get_backend("test_stub")
    assert isinstance(backend, OCRBackend)
    result = backend.ocr(Path("/tmp/fake.png"))
    assert result.text == "stub"


def test_get_backend_missing_raises():
    with pytest.raises(KeyError) as exc:
        get_backend("does_not_exist")
    assert "does_not_exist" in str(exc.value)


def test_register_backend_with_kwargs():
    @register_backend("test_with_args")
    class ArgBackend(OCRBackend):
        def __init__(self, model_id: str) -> None:
            self.model_id = model_id

        def ocr(self, image_path: Path) -> OCRResult:
            return OCRResult(
                text=self.model_id, model=self.model_id, prompt_hash="0",
                ts=datetime.now(timezone.utc),
            )

    backend = get_backend("test_with_args", model_id="my-model")
    result = backend.ocr(Path("/tmp/fake.png"))
    assert result.text == "my-model"


def test_abstract_backend_cannot_instantiate():
    with pytest.raises(TypeError):
        OCRBackend()  # type: ignore[abstract]
