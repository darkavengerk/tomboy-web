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

from desktop.lib.raster import find_gap_near, ink_row_mask

from .base import OCRBackend, OCRResult, register_backend


@register_backend("local_vlm")
class LocalVlmBackend(OCRBackend):
    # Tile slicing for scroll-extended rM pages. A standard rM page is
    # 1404×1872; the renderer (`RmsceneRenderer`) now produces a taller PNG
    # when the user has scrolled and kept writing. Sending the whole tall
    # image to Qwen2.5-VL works for ~1× pages but degrades on longer ones
    # — the processor's max_pixels (~1.0 M) downsamples too aggressively,
    # and KV-cache for the larger token budget blows the 10 GB RTX 3080.
    # So we slice into ~one-screen tiles, OCR each, and concatenate.
    #
    # TILE_THRESHOLD: only tile when the image height is at least this tall.
    #   Standard pages (1872) pass through unchanged → no regression.
    # TILE_HEIGHT: target tile height. Mirrors a real rM screen so each tile
    #   looks like a normal page to the model.
    # LINE_GAP_SEARCH: half-width of the window we scan for an ink-free row
    #   near each cut. Cutting on a blank row avoids splitting a character;
    #   if no blank row is found we fall back to the exact target row.
    TILE_THRESHOLD = 2400
    TILE_HEIGHT = 1872
    LINE_GAP_SEARCH = 240

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
        tiles = self._split_to_tiles(image)
        outputs = [self._infer_image(tile, prompt) for tile in tiles]
        return "\n".join(o.strip() for o in outputs if o.strip())

    def _infer_image(self, image: Any, prompt: str) -> str:
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

    def _split_to_tiles(self, image: Any) -> list[Any]:
        """Slice a tall scrolled-rM image into one-screen-ish tiles.

        Returns ``[image]`` unchanged when the image is at or below
        ``TILE_THRESHOLD`` tall — standard non-scrolled pages flow through
        the original single-shot inference path with no behavior change.
        """
        w, h = image.size
        if h <= self.TILE_THRESHOLD:
            return [image]
        ink_rows = ink_row_mask(image)
        tiles: list[Any] = []
        top = 0
        # Each iteration carves off one tile starting at `top`. We pick a
        # cut row near `top + TILE_HEIGHT`, snapping to the longest blank
        # band within ±LINE_GAP_SEARCH to avoid splitting a line of text.
        while top < h:
            target = top + self.TILE_HEIGHT
            if target >= h:
                tiles.append(image.crop((0, top, w, h)))
                break
            cut = find_gap_near(ink_rows, target, self.LINE_GAP_SEARCH)
            # Defensive: never let snapping push the cut backward, that
            # would loop forever.
            if cut <= top:
                cut = target
            tiles.append(image.crop((0, top, w, cut)))
            top = cut
        return tiles

    @staticmethod
    def _ink_row_mask(image: Any) -> list[bool]:
        return ink_row_mask(image)

    @staticmethod
    def _find_gap_near(ink_rows: list[bool], target: int, search: int) -> int:
        return find_gap_near(ink_rows, target, search)

    def ocr(self, image_path: Path) -> OCRResult:
        text = self._run_inference(image_path, self.system_prompt).strip()
        return OCRResult(
            text=text,
            model=self.model_id,
            prompt_hash=self._prompt_hash,
            ts=datetime.now(timezone.utc),
        )
