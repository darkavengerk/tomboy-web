"""Real GOT-OCR2 runner. Imported lazily by app.py startup so unit tests
that use FakeRunner never touch torch/transformers."""
from __future__ import annotations

import base64
import io
import logging
import os
from threading import Lock

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

log = logging.getLogger(__name__)


class GotOcr2Runner:
    """Wraps `stepfun-ai/GOT-OCR2_0` via transformers AutoModel.

    The model is loaded on `load()`, kept in fp16 on the configured CUDA
    device, and run via its custom `chat` method with `ocr_type='format'`.
    `unload()` moves the model to CPU and releases CUDA caches."""

    def __init__(self, model_id: str, device: str) -> None:
        self.model_id = model_id
        self.device = device
        self._model = None
        self._tokenizer = None
        self._load_lock = Lock()

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None and self._on_device():
                return
            from transformers import AutoModel, AutoTokenizer
            import torch

            log.info("loading %s on %s", self.model_id, self.device)
            tokenizer = AutoTokenizer.from_pretrained(
                self.model_id, trust_remote_code=True
            )
            model = AutoModel.from_pretrained(
                self.model_id,
                trust_remote_code=True,
                low_cpu_mem_usage=True,
                use_safetensors=True,
                torch_dtype=torch.float16,
            )
            model = model.eval().to(self.device)
            self._model = model
            self._tokenizer = tokenizer

    def unload(self) -> None:
        with self._load_lock:
            if self._model is None:
                return
            import torch
            self._model = self._model.to("cpu")
            self._model = None
            self._tokenizer = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            log.info("unloaded")

    def is_loaded(self) -> bool:
        return self._model is not None and self._on_device()

    def _on_device(self) -> bool:
        try:
            if self._model is None:
                return False
            p = next(self._model.parameters())
            return str(p.device).startswith(self.device.split(":")[0])
        except StopIteration:
            return False

    def run(self, image_b64: str) -> str:
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("model not loaded")
        from PIL import Image
        raw = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        # GOT-OCR2's custom chat method. ocr_type='format' returns Markdown-like
        # structured output suited for general documents.
        result = self._model.chat(self._tokenizer, image, ocr_type="format")
        return str(result)
