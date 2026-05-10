"""Pluggable OCR backend interface.

Concrete backends (``local_vlm``, future Clova/Google/TrOCR) live in
sibling modules and self-register via ``@register_backend("name")``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, TypeVar


@dataclass(frozen=True)
class OCRResult:
    text: str
    model: str
    prompt_hash: str
    ts: datetime


class OCRBackend(ABC):
    @abstractmethod
    def ocr(self, image_path: Path) -> OCRResult:
        """Run OCR on a single image. Implementations may be slow (loads ML
        models on first call) — callers should batch and reuse instances."""


_REGISTRY: dict[str, type[OCRBackend]] = {}

T = TypeVar("T", bound=OCRBackend)


def register_backend(name: str) -> Callable[[type[T]], type[T]]:
    def deco(cls: type[T]) -> type[T]:
        _REGISTRY[name] = cls
        return cls

    return deco


def get_backend(name: str, **kwargs: Any) -> OCRBackend:
    if name not in _REGISTRY:
        raise KeyError(f"OCR backend not registered: {name!r}")
    return _REGISTRY[name](**kwargs)


def list_backends() -> list[str]:
    return sorted(_REGISTRY.keys())
