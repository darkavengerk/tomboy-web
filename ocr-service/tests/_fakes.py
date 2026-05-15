"""Test doubles shared across test modules.

Lives outside conftest.py so multiple test files can import the class
without relying on pytest's fixture-discovery side effects."""
from __future__ import annotations


class FakeRunner:
    """In-memory stand-in for the real GotOcr2Runner. Records the last
    image_b64 it was passed and returns a deterministic stub."""

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
