"""One-shot bulk index from a Tomboy backup zip.

Called by the indexer on startup ONLY when the vector store is empty.
Format: the zip downloaded from /admin/tools "로컬 백업" — entries are
`notes/{guid}.note`, plus auxiliary files (meta.txt, local-manifest.json,
tombstones.txt) which we ignore.
"""

from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path

from .embeddings import EmbedError, OllamaEmbedder
from .note_parser import parse_note_xml
from .vector_store import VectorStore

_log = logging.getLogger(__name__)

# Match `notes/<guid>.note` entries at the zip root. guid = 36-char UUID.
_NOTE_ENTRY_RE = re.compile(
    r"^notes/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.note$"
)


def _find_latest_zip(inbox: Path) -> Path | None:
    if not inbox.exists():
        return None
    zips = sorted(inbox.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    return zips[0] if zips else None


async def bootstrap_from_zip(
    inbox: Path,
    store: VectorStore,
    embedder: OllamaEmbedder,
) -> int:
    """Index every `notes/{guid}.note` in the latest zip. Returns the
    number of notes successfully indexed."""
    zip_path = _find_latest_zip(inbox)
    if zip_path is None:
        _log.info("bootstrap: no zip in %s — skipping", inbox)
        return 0

    _log.info("bootstrap: opening %s", zip_path.name)
    indexed = 0
    skipped = 0
    try:
        with zipfile.ZipFile(zip_path) as z:
            for info in z.infolist():
                m = _NOTE_ENTRY_RE.match(info.filename)
                if not m:
                    continue
                guid = m.group(1)
                try:
                    xml = z.read(info).decode("utf-8")
                except Exception as e:
                    _log.warning("bootstrap: read fail guid=%s err=%s", guid, e)
                    skipped += 1
                    continue
                parsed = parse_note_xml(xml)
                if parsed is None:
                    _log.warning("bootstrap: parse fail guid=%s", guid)
                    skipped += 1
                    continue
                if parsed.is_special:
                    _log.debug("bootstrap: skip special guid=%s title=%r", guid, parsed.title)
                    skipped += 1
                    continue
                try:
                    embedding = await embedder.embed(
                        parsed.title + "\n" + parsed.body_text
                    )
                except EmbedError as e:
                    _log.error("bootstrap: embed fail guid=%s kind=%s", guid, e.kind)
                    skipped += 1
                    continue
                store.upsert(
                    guid,
                    parsed.title,
                    parsed.body_text,
                    parsed.content_hash,
                    embedding,
                )
                indexed += 1
    except zipfile.BadZipFile as e:
        _log.error("bootstrap: bad zip %s err=%s", zip_path, e)
        return 0

    _log.info("bootstrap: done indexed=%d skipped=%d", indexed, skipped)
    return indexed
