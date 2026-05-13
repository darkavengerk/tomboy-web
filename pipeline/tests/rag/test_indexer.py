import tempfile
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from desktop.rag.firestore_source import NoteEvent
from desktop.rag.indexer import process_event
from desktop.rag.vector_store import VectorStore

NOTE_BASIC = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
본문 줄</note-content></text>
</note>"""


NOTE_BASIC_V2 = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
변경된 본문</note-content></text>
</note>"""


NOTE_LLM = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>LLM 노트</title>
  <text xml:space="preserve"><note-content version="0.1">llm://qwen2.5:7b
header</note-content></text>
</note>"""


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        yield s
        s.close()


@pytest.fixture
def embedder():
    e = AsyncMock()
    e.embed = AsyncMock(return_value=[0.1] * 1024)
    return e


@pytest.mark.asyncio
async def test_new_note_indexed(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 1
    embedder.embed.assert_called_once()


@pytest.mark.asyncio
async def test_same_hash_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    embedder.embed.reset_mock()
    await process_event(store, embedder, ev)
    embedder.embed.assert_not_called()
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_content_change_reindexed(store, embedder):
    ev1 = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                    server_updated_at="2026-05-13T10:00:00+00:00")
    ev2 = NoteEvent(guid="g1", xml_content=NOTE_BASIC_V2, deleted=False,
                    server_updated_at="2026-05-13T11:00:00+00:00")
    await process_event(store, embedder, ev1)
    embedder.embed.reset_mock()
    await process_event(store, embedder, ev2)
    embedder.embed.assert_called_once()
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_deleted_removes_from_store(store, embedder):
    ev1 = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                    server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev1)
    assert store.count_notes() == 1
    ev2 = NoteEvent(guid="g1", xml_content=None, deleted=True,
                    server_updated_at="2026-05-13T11:00:00+00:00")
    await process_event(store, embedder, ev2)
    assert store.count_notes() == 0


@pytest.mark.asyncio
async def test_special_note_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_LLM, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 0
    embedder.embed.assert_not_called()


@pytest.mark.asyncio
async def test_corrupt_xml_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content="<note>broken", deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 0
    embedder.embed.assert_not_called()
