"""Shared fixtures. Substitutes a fake OcrRunner so tests never load
the real model (which is ~1.2GB and requires a GPU)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ocr_service.app import app
from ocr_service.config import Settings
from ocr_service.model import OcrEngine


class FakeRunner:
    def __init__(self) -> None:
        self._loaded = False
        self.last_input = ""

    def load(self) -> None:
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False

    def is_loaded(self) -> bool:
        return self._loaded

    def run(self, image_b64: str) -> str:
        self.last_input = image_b64
        return f"OCR[{len(image_b64)}]"


@pytest.fixture
def fake_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    settings = Settings(
        shared_token="test-token",
        model_id="fake-model",
        idle_unload_s=60,
        device="cpu",
    )
    monkeypatch.setattr("ocr_service.config.settings", settings)
    return settings


@pytest.fixture
def fake_runner() -> FakeRunner:
    return FakeRunner()


@pytest.fixture
def client(fake_settings: Settings, fake_runner: FakeRunner) -> TestClient:
    engine = OcrEngine(runner=fake_runner)
    app.state.engine = engine
    return TestClient(app)
