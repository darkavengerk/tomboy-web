"""Firestore polling source for the RAG indexer.

Polls `users/{uid}/notes WHERE serverUpdatedAt > watermark ORDER BY
serverUpdatedAt LIMIT 100`. Persistent watermark stored as JSON.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

_EPOCH = "1970-01-01T00:00:00+00:00"
_BATCH = 100


@dataclass(frozen=True)
class NoteEvent:
    guid: str
    xml_content: str | None
    deleted: bool
    server_updated_at: str


class WatermarkStore:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def get(self) -> str:
        if not self._path.exists():
            return _EPOCH
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return str(data.get("watermark", _EPOCH))
        except (json.JSONDecodeError, OSError):
            return _EPOCH

    def set(self, watermark: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps({"watermark": watermark}),
            encoding="utf-8",
        )


class FirestoreSource:
    def __init__(
        self,
        client: Any,
        uid: str,
        watermark_store: WatermarkStore,
    ) -> None:
        self._client = client
        self._uid = uid
        self._ws = watermark_store

    def poll_once(self) -> list[NoteEvent]:
        wm = self._ws.get()
        col = (
            self._client.collection("users")
            .document(self._uid)
            .collection("notes")
        )
        query = (
            col.where("serverUpdatedAt", ">", wm)
            .order_by("serverUpdatedAt")
            .limit(_BATCH)
        )
        events: list[NoteEvent] = []
        last_wm = wm
        for snap in query.stream():
            data = snap.to_dict() or {}
            sua_raw = data.get("serverUpdatedAt")
            if hasattr(sua_raw, "isoformat"):
                sua = sua_raw.isoformat()
            elif isinstance(sua_raw, str):
                sua = sua_raw
            else:
                continue
            last_wm = sua
            deleted = bool(data.get("deleted", False))
            xml = data.get("xmlContent")
            if not deleted and (not isinstance(xml, str) or not xml):
                _log.debug("skip doc guid=%s (no xmlContent, not deleted)", snap.id)
                continue
            events.append(
                NoteEvent(
                    guid=snap.id,
                    xml_content=xml if isinstance(xml, str) else None,
                    deleted=deleted,
                    server_updated_at=sua,
                )
            )
        if last_wm != wm:
            self._ws.set(last_wm)
        return events
