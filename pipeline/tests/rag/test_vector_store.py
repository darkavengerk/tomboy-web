import tempfile
from pathlib import Path

import pytest

from desktop.rag.vector_store import VectorStore


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        yield s
        s.close()


def _vec(seed: int) -> list[float]:
    # Deterministic 1024-dim vector for tests
    return [(seed + i) / 10000.0 for i in range(1024)]


def test_empty_count(store):
    assert store.count_notes() == 0


def test_upsert_and_count(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    assert store.count_notes() == 1
    store.upsert("g2", "T2", "body2", "hash2", _vec(2))
    assert store.count_notes() == 2


def test_upsert_replace_same_guid(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    store.upsert("g1", "T1-new", "body1-new", "hash1-new", _vec(11))
    assert store.count_notes() == 1
    assert store.get_content_hash("g1") == "hash1-new"


def test_delete(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    store.delete("g1")
    assert store.count_notes() == 0
    assert store.get_content_hash("g1") is None


def test_get_content_hash_missing(store):
    assert store.get_content_hash("nonexistent") is None


def test_search_returns_top_k_in_order(store):
    # Insert 3 notes with increasing distance from query vector
    store.upsert("g_near", "near", "n", "h_near", _vec(0))
    store.upsert("g_mid", "mid", "m", "h_mid", _vec(50))
    store.upsert("g_far", "far", "f", "h_far", _vec(500))

    query = _vec(0)
    hits = store.search(query, k=2)
    assert len(hits) == 2
    assert hits[0].guid == "g_near"
    assert hits[1].guid == "g_mid"
    # Distance ascending → score descending
    assert hits[0].score >= hits[1].score


def test_search_limit(store):
    for i in range(5):
        store.upsert(f"g{i}", f"t{i}", f"b{i}", f"h{i}", _vec(i))
    hits = store.search(_vec(0), k=3)
    assert len(hits) == 3


def test_search_empty_store(store):
    hits = store.search(_vec(0), k=5)
    assert hits == []
