"""Qwen2.5-VL-7B OCR backend.

Loads the model lazily on first call. Real inference requires
``pip install -e .[vlm]`` and a CUDA-capable GPU; tests inject the
``_run_inference`` seam to avoid loading anything.
"""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Reduce CUDA allocator fragmentation. Must be set BEFORE torch is first
# imported anywhere in the process. Module load happens at package import
# time (`desktop.ocr_backends.__init__`), well before `_load_model` pulls
# in torch lazily.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

from .base import OCRBackend, OCRResult, register_backend


@register_backend("local_vlm")
class LocalVlmBackend(OCRBackend):
    def __init__(
        self,
        *,
        model_id: str,
        quantization: str,
        max_new_tokens: int,
        system_prompt_path: Path | str,
    ) -> None:
        self.model_id = model_id
        self.quantization = quantization
        self.max_new_tokens = max_new_tokens
        prompt_path = Path(system_prompt_path)
        if not prompt_path.exists():
            raise FileNotFoundError(f"System prompt file not found: {prompt_path}")
        self.system_prompt = prompt_path.read_text(encoding="utf-8")
        self._prompt_hash = hashlib.sha256(self.system_prompt.encode("utf-8")).hexdigest()
        self._model: Any = None
        self._processor: Any = None

    def _load_model(self) -> None:
        if self._model is not None:
            return
        # `AutoModelForImageTextToText` is the transformers 4.45+ entrypoint
        # for vision-language models — it inspects the model's config.json
        # and picks the right class (Qwen2VL, Qwen2_5_VL, LLaVA, …). Pinning
        # the concrete class here (e.g. Qwen2VLForConditionalGeneration)
        # would break the moment model_id points at a different architecture
        # — including the v2.5 we actually use.
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig

        bnb_kwargs: dict[str, Any] = {}
        if self.quantization == "4bit":
            # nf4 + double-quant + fp16 compute fits Qwen2.5-VL-7B inside a
            # 10 GB RTX 3080 (~4.5 GiB weights vs ~5.8 GiB on the default
            # load_in_4bit=True alone). Without double-quant we OOM during
            # inference KV-cache allocation.
            bnb_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
            )
        self._model = AutoModelForImageTextToText.from_pretrained(
            self.model_id,
            device_map="auto",
            **bnb_kwargs,
        )
        # Qwen2.5-VL's default max_pixels is 1280·28² ≈ 1.0 M, so a 1404×1872
        # rM page (~2.6 M) is already downscaled by the processor — no need
        # to override here. If a future firmware bump pushes page resolution
        # past the default, set max_pixels= explicitly to keep VRAM bounded.
        self._processor = AutoProcessor.from_pretrained(self.model_id)

    def _run_inference(self, image_path: Path, prompt: str) -> str:
        """Real inference. Tests override this method."""
        from PIL import Image

        self._load_model()
        image = Image.open(image_path).convert("RGB")
        messages = [
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": "위 이미지의 손글씨를 추출해 주세요."},
                ],
            },
        ]
        text = self._processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = self._processor(text=[text], images=[image], return_tensors="pt")
        inputs = {k: v.to(self._model.device) for k, v in inputs.items()}
        out_ids = self._model.generate(**inputs, max_new_tokens=self.max_new_tokens)
        # Strip the prompt portion (Qwen returns prompt + generation concatenated)
        gen_ids = out_ids[0][inputs["input_ids"].shape[1] :]
        return self._processor.decode(gen_ids, skip_special_tokens=True)

    def ocr(self, image_path: Path) -> OCRResult:
        text = self._run_inference(image_path, self.system_prompt).strip()
        return OCRResult(
            text=text,
            model=self.model_id,
            prompt_hash=self._prompt_hash,
            ts=datetime.now(timezone.utc),
        )
