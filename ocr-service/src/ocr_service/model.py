"""GOT-OCR2 wrapper.

This module owns the model's lifecycle: load on first use, run inference,
unload on idle timer or explicit /unload. The real PyTorch/transformers
work lives behind a small Protocol so tests can substitute a fake.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Protocol


class OcrRunner(Protocol):
    """Strategy interface. The real implementation lives in `model_real.py`
    (added in Task 1) and is wired up by `app.py` at startup."""

    def load(self) -> None: ...
    def unload(self) -> None: ...
    def is_loaded(self) -> bool: ...
    def run(self, image_b64: str) -> str: ...


@dataclass
class OcrEngine:
    """Stateful coordinator wrapping an `OcrRunner` with idle tracking and
    a single-flight lock. Methods are safe to call from FastAPI request
    handlers."""

    runner: OcrRunner
    last_called_at: float = 0.0
    _lock: Lock = field(default_factory=Lock)
    _in_flight: int = 0

    def status(self) -> dict[str, object]:
        return {
            "loaded": self.runner.is_loaded(),
            "last_called_at": self.last_called_at,
            "in_flight": self._in_flight,
        }

    def run(self, image_b64: str) -> str:
        with self._lock:
            self._in_flight += 1
        try:
            if not self.runner.is_loaded():
                self.runner.load()
            text = self.runner.run(image_b64)
            self.last_called_at = time.time()
            return text
        finally:
            with self._lock:
                self._in_flight -= 1

    def unload(self) -> bool:
        """Returns True if unload succeeded, False if a request is in
        flight."""
        with self._lock:
            if self._in_flight > 0:
                return False
            self.runner.unload()
            return True
