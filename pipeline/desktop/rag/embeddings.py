"""Ollama bge-m3 embedding client.

Calls Ollama's /api/embed endpoint and returns a single 1024-dim vector.
"""
from __future__ import annotations

from typing import Literal

import httpx

EmbedErrorKind = Literal["model_not_found", "upstream_error", "network", "unavailable"]


class EmbedError(Exception):
    def __init__(self, kind: EmbedErrorKind, message: str = "") -> None:
        super().__init__(message or kind)
        self.kind = kind


class OllamaEmbedder:
    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "bge-m3-cpu",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    async def embed(self, text: str) -> list[float]:
        url = f"{self.base_url}/api/embed"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    url,
                    json={"model": self.model, "input": text},
                )
        except httpx.ConnectError as e:
            raise EmbedError("unavailable", str(e)) from e
        except httpx.HTTPError as e:
            raise EmbedError("network", str(e)) from e

        if resp.status_code == 404:
            raise EmbedError("model_not_found", f"model {self.model} not pulled")
        if resp.status_code >= 500:
            raise EmbedError("upstream_error", f"ollama {resp.status_code}")
        if not resp.is_success:
            raise EmbedError("upstream_error", f"http {resp.status_code}")

        data = resp.json()
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) == 0:
            raise EmbedError("upstream_error", "no embeddings in response")
        vec = embeddings[0]
        if not isinstance(vec, list) or len(vec) == 0:
            raise EmbedError("upstream_error", "empty embedding vector")
        return [float(x) for x in vec]
