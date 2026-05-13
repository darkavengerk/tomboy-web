"""Top-level RAG indexer: bootstrap + Firestore polling loop.

Run:  python -m desktop.rag.indexer
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from firebase_admin import credentials, firestore, get_app, initialize_app

from desktop.lib.config import load_config

from .embeddings import EmbedError, OllamaEmbedder
from .firestore_source import FirestoreSource, NoteEvent, WatermarkStore
from .note_parser import parse_note_xml
from .vector_store import VectorStore
from .zip_bootstrap import bootstrap_from_zip

_log = logging.getLogger(__name__)

_DATA_DIR = Path("~/.local/share/tomboy-rag").expanduser()
_POLL_INTERVAL_S = 30
_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
_EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "bge-m3")

_PIPELINE_CONFIG_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "pipeline.yaml"
)


async def process_event(
    store: VectorStore,
    embedder: OllamaEmbedder,
    event: NoteEvent,
) -> None:
    """Apply a single Firestore event to the index. Idempotent."""
    if event.deleted:
        store.delete(event.guid)
        _log.info("deleted guid=%s", event.guid)
        return

    if not event.xml_content:
        _log.debug("no xml content, skipping guid=%s", event.guid)
        return

    parsed = parse_note_xml(event.xml_content)
    if parsed is None:
        _log.warning("parse fail guid=%s", event.guid)
        return
    if parsed.is_special:
        _log.debug("special note, skipping guid=%s title=%r", event.guid, parsed.title)
        # If a note flipped from regular → special (e.g. user edited a note
        # to become an LLM note), drop it from the index.
        store.delete(event.guid)
        return

    existing_hash = store.get_content_hash(event.guid)
    if existing_hash == parsed.content_hash:
        _log.debug("hash unchanged, skipping guid=%s", event.guid)
        return

    try:
        embedding = await embedder.embed(parsed.title + "\n" + parsed.body_text)
    except EmbedError as e:
        _log.error("embed fail guid=%s kind=%s — will retry next tick", event.guid, e.kind)
        return

    store.upsert(
        event.guid,
        parsed.title,
        parsed.body_text,
        parsed.content_hash,
        embedding,
    )
    _log.info("indexed guid=%s title=%r", event.guid, parsed.title[:60])


def _get_firestore_client(service_account_path: str):
    try:
        app = get_app("rag-indexer")
    except ValueError:
        cred = credentials.Certificate(service_account_path)
        app = initialize_app(cred, name="rag-indexer")
    return firestore.client(app)


async def _main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    cfg = load_config(_PIPELINE_CONFIG_PATH)
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    inbox_dir = _DATA_DIR / "inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)

    store = VectorStore(_DATA_DIR / "index.db")
    embedder = OllamaEmbedder(base_url=_OLLAMA_BASE_URL, model=_EMBED_MODEL)
    fs_client = _get_firestore_client(cfg.firebase_service_account)
    ws = WatermarkStore(_DATA_DIR / "firestore_watermark.json")
    source = FirestoreSource(client=fs_client, uid=cfg.firebase_uid, watermark_store=ws)

    _log.info("RAG indexer starting — uid=%s data=%s", cfg.firebase_uid, _DATA_DIR)

    # Bootstrap if empty
    if store.count_notes() == 0:
        _log.info("index empty, attempting zip bootstrap from %s", inbox_dir)
        n = await bootstrap_from_zip(inbox_dir, store, embedder)
        _log.info("bootstrap done: indexed %d notes", n)
    else:
        _log.info("index has %d notes — skipping bootstrap", store.count_notes())

    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    _log.info("entering Firestore polling loop (interval=%ds)", _POLL_INTERVAL_S)
    while not stop.is_set():
        try:
            events = await asyncio.to_thread(source.poll_once)
        except Exception as e:
            _log.error("poll_once error: %s", e)
            await _interruptible_sleep(_POLL_INTERVAL_S, stop)
            continue
        for ev in events:
            if stop.is_set():
                break
            await process_event(store, embedder, ev)
        if events:
            _log.info("processed %d events", len(events))
        await _interruptible_sleep(_POLL_INTERVAL_S, stop)

    _log.info("shutdown — closing store")
    store.close()
    return 0


async def _interruptible_sleep(seconds: float, stop: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except TimeoutError:
        return


def main() -> int:
    return asyncio.run(_main())


if __name__ == "__main__":
    sys.exit(main())
