"""FastAPI search server for the RAG index.

POST /search  { query: str, k: int = 5 }  →  [{guid, title, body, score}]
Bind 0.0.0.0:8743. No auth (firewall protects).
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .embeddings import EmbedError, OllamaEmbedder
from .vector_store import VectorStore

_log = logging.getLogger(__name__)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=0)  # We do our own empty check for clearer 400
    k: int = 5


class SearchResponseItem(BaseModel):
    guid: str
    title: str
    body: str
    score: float


def build_app(store: VectorStore, embedder: OllamaEmbedder) -> FastAPI:
    app = FastAPI(title="tomboy-rag-search")

    @app.post("/search", response_model=list[SearchResponseItem])
    async def search(req: SearchRequest):
        if not req.query.strip():
            return JSONResponse(
                status_code=400,
                content={"error": "empty_query"},
            )
        k = max(1, min(req.k, 20))
        try:
            embedding = await embedder.embed(req.query)
        except EmbedError as e:
            _log.error("embed fail: kind=%s", e.kind)
            return JSONResponse(
                status_code=503,
                content={"error": "embed_failed", "kind": e.kind},
            )
        hits = store.search(embedding, k=k)
        return [
            SearchResponseItem(guid=h.guid, title=h.title, body=h.body, score=h.score)
            for h in hits
        ]

    return app


# Module-level app for uvicorn (`uvicorn desktop.rag.search_server:app`)
_DATA_DIR = Path("~/.local/share/tomboy-rag").expanduser()
_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
_EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "bge-m3")


def _make_default_app() -> FastAPI:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    store = VectorStore(_DATA_DIR / "index.db")
    embedder = OllamaEmbedder(base_url=_OLLAMA_BASE_URL, model=_EMBED_MODEL)
    return build_app(store=store, embedder=embedder)


app = _make_default_app()
