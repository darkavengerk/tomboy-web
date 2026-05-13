import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from desktop.rag.embeddings import EmbedError
from desktop.rag.search_server import build_app
from desktop.rag.vector_store import VectorStore


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        # Patch sqlite3.connect to disable thread checking for tests
        original_connect = sqlite3.connect

        def connect_no_thread_check(path, *args, **kwargs):
            kwargs['check_same_thread'] = False
            return original_connect(path, *args, **kwargs)

        with patch('sqlite3.connect', side_effect=connect_no_thread_check):
            with patch(
                'desktop.rag.vector_store.sqlite3.connect',
                side_effect=connect_no_thread_check,
            ):
                s = VectorStore(Path(tmp) / "index.db")
                # Seed 2 notes
                s.upsert("g1", "T1", "body 1", "h1", [0.1] * 1024)
                s.upsert("g2", "T2", "body 2", "h2", [0.2] * 1024)
                yield s
                s.close()


@pytest.fixture
def embedder():
    e = AsyncMock()
    e.embed = AsyncMock(return_value=[0.1] * 1024)
    return e


def _client(store, embedder):
    app = build_app(store=store, embedder=embedder)
    return TestClient(app)


def test_search_success(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "hello", "k": 2})
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 2
    for hit in data:
        assert set(hit.keys()) >= {"guid", "title", "body", "score"}


def test_search_empty_query_400(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "", "k": 5})
    assert resp.status_code == 400


def test_search_missing_query_400(store, embedder):
    resp = _client(store, embedder).post("/search", json={"k": 5})
    assert resp.status_code == 422  # FastAPI validation


def test_search_k_clamped(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "x", "k": 999})
    assert resp.status_code == 200
    # Only 2 items in store, but k=999 should not error
    assert len(resp.json()) <= 2


def test_search_embed_error_503(store):
    bad_embedder = AsyncMock()
    bad_embedder.embed = AsyncMock(side_effect=EmbedError("unavailable", "ollama down"))
    resp = _client(store, bad_embedder).post("/search", json={"query": "x", "k": 5})
    assert resp.status_code == 503
    assert resp.json()["error"] == "embed_failed"
