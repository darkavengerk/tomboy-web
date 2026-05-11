"""OCR backends. Importing this package side-effect-registers every
built-in backend (via the ``@register_backend`` decorator in each
submodule) so callers can resolve them by name through ``get_backend``.

The heavy ML imports (``torch``, ``transformers``) live inside
per-method lazy imports in the concrete backends — importing this
package is cheap and does not pull in any GPU stack.
"""
from __future__ import annotations

from . import local_vlm  # noqa: F401  registers "local_vlm"
from .base import OCRBackend, OCRResult, get_backend, list_backends, register_backend

__all__ = [
    "OCRBackend",
    "OCRResult",
    "get_backend",
    "list_backends",
    "register_backend",
]
