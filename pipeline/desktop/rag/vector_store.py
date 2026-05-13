"""Thin sqlite-vec wrapper for the RAG note index.

Schema:
  notes(guid PK, title, body_text, content_hash, indexed_at)
  note_embeddings(guid PK, embedding FLOAT[1024])  -- sqlite-vec virtual table
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import sqlite_vec

EMBEDDING_DIM = 1024


@dataclass(frozen=True)
class SearchHit:
    guid: str
    title: str
    body: str
    score: float  # 1.0 - clamped_distance


class VectorStore:
    def __init__(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                guid           TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                body_text      TEXT NOT NULL,
                content_hash   TEXT NOT NULL,
                indexed_at     TEXT NOT NULL
            )
        """)
        self._conn.execute(f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
                guid TEXT PRIMARY KEY,
                embedding FLOAT[{EMBEDDING_DIM}]
            )
        """)
        self._conn.commit()

    def count_notes(self) -> int:
        cur = self._conn.execute("SELECT COUNT(*) FROM notes")
        return int(cur.fetchone()[0])

    def get_content_hash(self, guid: str) -> str | None:
        cur = self._conn.execute("SELECT content_hash FROM notes WHERE guid = ?", (guid,))
        row = cur.fetchone()
        return row[0] if row else None

    def upsert(
        self,
        guid: str,
        title: str,
        body_text: str,
        content_hash: str,
        embedding: list[float],
    ) -> None:
        if len(embedding) != EMBEDDING_DIM:
            raise ValueError(f"embedding must be {EMBEDDING_DIM}-dim, got {len(embedding)}")
        now = datetime.now(UTC).isoformat()
        self._conn.execute("""
            INSERT INTO notes (guid, title, body_text, content_hash, indexed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guid) DO UPDATE SET
                title = excluded.title,
                body_text = excluded.body_text,
                content_hash = excluded.content_hash,
                indexed_at = excluded.indexed_at
        """, (guid, title, body_text, content_hash, now))
        # vec0 doesn't support ON CONFLICT — delete then insert
        self._conn.execute("DELETE FROM note_embeddings WHERE guid = ?", (guid,))
        self._conn.execute(
            "INSERT INTO note_embeddings (guid, embedding) VALUES (?, ?)",
            (guid, sqlite_vec.serialize_float32(embedding)),
        )
        self._conn.commit()

    def delete(self, guid: str) -> None:
        self._conn.execute("DELETE FROM notes WHERE guid = ?", (guid,))
        self._conn.execute("DELETE FROM note_embeddings WHERE guid = ?", (guid,))
        self._conn.commit()

    def search(self, embedding: list[float], k: int) -> list[SearchHit]:
        if len(embedding) != EMBEDDING_DIM:
            raise ValueError(f"query embedding must be {EMBEDDING_DIM}-dim")
        cur = self._conn.execute("""
            SELECT n.guid, n.title, n.body_text, v.distance
            FROM (
                SELECT guid, distance
                FROM note_embeddings
                WHERE embedding MATCH ?
                LIMIT ?
            ) v
            JOIN notes n ON n.guid = v.guid
            ORDER BY v.distance
        """, (sqlite_vec.serialize_float32(embedding), k))
        results: list[SearchHit] = []
        for row in cur.fetchall():
            guid, title, body, distance = row
            score = max(0.0, 1.0 - min(float(distance), 1.0))
            results.append(SearchHit(guid=guid, title=title, body=body, score=score))
        return results

    def close(self) -> None:
        self._conn.close()
