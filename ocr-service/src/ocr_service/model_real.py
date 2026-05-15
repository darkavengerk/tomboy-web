"""Real GOT-OCR2 runner backed by the transformers-native HF model
(`stepfun-ai/GOT-OCR-2.0-hf`).

Imported lazily by app.py startup so unit tests that use FakeRunner
never need torch/transformers installed. The torch/transformers imports
all live inside method bodies."""
from __future__ import annotations

import base64
import io
import logging
from threading import Lock

log = logging.getLogger(__name__)


class GotOcr2Runner:
    """Wraps `stepfun-ai/GOT-OCR-2.0-hf` via AutoModelForImageTextToText +
    AutoProcessor — the native transformers integration (no
    trust_remote_code, no custom modeling_GOT.py with frozen-era APIs).

    The model is loaded on `load()` in fp16 on the configured CUDA device,
    invoked via the standard `model.generate()` interface with
    `format=True` for markdown-style structured output, and unloaded by
    dropping references + `torch.cuda.empty_cache()`."""

    # GOT-OCR2 emits `<|im_end|>` to signal completion; cap generation
    # length to match the model's max position embeddings ceiling.
    STOP_STRINGS = "<|im_end|>"
    MAX_NEW_TOKENS = 4096

    def __init__(self, model_id: str, device: str) -> None:
        self.model_id = model_id
        self.device = device
        self._model = None
        self._processor = None
        self._load_lock = Lock()

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None and self._on_device_locked():
                return
            import torch
            from transformers import AutoModelForImageTextToText, AutoProcessor

            if self.device.startswith("cuda") and not torch.cuda.is_available():
                raise RuntimeError(
                    f"OCR_DEVICE={self.device!r} but torch.cuda.is_available() is False. "
                    "Check that the container has --device nvidia.com/gpu=all (CDI) "
                    "and the host NVIDIA driver is loaded."
                )
            log.info("loading %s on %s", self.model_id, self.device)
            processor = AutoProcessor.from_pretrained(self.model_id, use_fast=True)
            model = AutoModelForImageTextToText.from_pretrained(
                self.model_id,
                low_cpu_mem_usage=True,
                use_safetensors=True,
                torch_dtype=torch.float16,
            )
            model = model.eval().to(self.device)
            self._model = model
            self._processor = processor

    def unload(self) -> None:
        with self._load_lock:
            if self._model is None:
                return
            import torch

            del self._model
            self._model = None
            self._processor = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            log.info("unloaded")

    def is_loaded(self) -> bool:
        with self._load_lock:
            return self._model is not None and self._on_device_locked()

    def _on_device_locked(self) -> bool:
        """Caller must hold `_load_lock`. Compares model's actual param
        device against `self.device` using torch.device fields so
        `cuda` (any index) doesn't spuriously match `cuda:1`."""
        try:
            if self._model is None:
                return False
            p = next(self._model.parameters())
        except StopIteration:
            return False
        expected_type, _, expected_idx = self.device.partition(":")
        if p.device.type != expected_type:
            return False
        if expected_idx == "":
            return True
        return p.device.index == int(expected_idx)

    def run(self, image_b64: str) -> str:
        # NOTE: callers should ensure load() succeeded first (OcrEngine
        # does this). We re-read references after acquiring the lock to
        # avoid TOCTOU with a concurrent unload().
        with self._load_lock:
            model = self._model
            processor = self._processor
        if model is None or processor is None:
            raise RuntimeError("model not loaded")

        from PIL import Image

        raw = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        # `format=True` selects the markdown-style output mode (was
        # `ocr_type='format'` in the legacy custom-code path).
        inputs = processor(image, return_tensors="pt", format=True).to(model.device)
        generate_ids = model.generate(
            **inputs,
            do_sample=False,
            tokenizer=processor.tokenizer,
            stop_strings=self.STOP_STRINGS,
            max_new_tokens=self.MAX_NEW_TOKENS,
        )
        # Strip the input tokens to get only the generated portion.
        new_tokens = generate_ids[0, inputs["input_ids"].shape[1] :]
        return processor.decode(new_tokens, skip_special_tokens=True)
