import tempfile
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from desktop.rag.vector_store import VectorStore
from desktop.rag.zip_bootstrap import bootstrap_from_zip

# Real UUID-format GUIDs for test entries
GUID_BASIC = "11111111-1111-4111-8111-111111111111"
GUID_BASIC_2 = "22222222-2222-4222-8222-222222222222"
GUID_LLM = "33333333-3333-4333-8333-333333333333"
GUID_OLD = "44444444-4444-4444-8444-444444444444"
GUID_NEW = "55555555-5555-4555-8555-555555555555"
GUID_CORRUPT = "66666666-6666-4666-8666-666666666666"

NOTE_BASIC = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
본문 줄</note-content></text>
</note>"""


NOTE_LLM = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>LLM 노트</title>
  <text xml:space="preserve"><note-content version="0.1">llm://qwen2.5:7b
LLM 노트 본문</note-content></text>
</note>"""


def _make_zip(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)


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
async def test_no_zip_returns_zero(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 0
    assert store.count_notes() == 0


@pytest.mark.asyncio
async def test_basic_zip(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "tomboy-local-backup-2026-05-13.zip",
        {
            f"notes/{GUID_BASIC}.note": NOTE_BASIC,
            f"notes/{GUID_BASIC_2}.note": NOTE_BASIC.replace("일반 노트", "다른 노트"),
            "meta.txt": "ignored",
            "local-manifest.json": "{}",
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 2
    assert store.count_notes() == 2


@pytest.mark.asyncio
async def test_skips_special_notes(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "backup.zip",
        {
            f"notes/{GUID_BASIC}.note": NOTE_BASIC,
            f"notes/{GUID_LLM}.note": NOTE_LLM,
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1  # only the basic one indexed
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_corrupt_note_skipped(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "backup.zip",
        {
            f"notes/{GUID_BASIC}.note": NOTE_BASIC,
            f"notes/{GUID_CORRUPT}.note": "<note>broken",
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_picks_most_recent_zip(tmp_path, store, embedder):
    import os
    import time

    inbox = tmp_path / "inbox"
    inbox.mkdir()
    old = inbox / "old.zip"
    new = inbox / "new.zip"
    _make_zip(old, {f"notes/{GUID_OLD}.note": NOTE_BASIC})
    _make_zip(
        new,
        {f"notes/{GUID_NEW}.note": NOTE_BASIC.replace("일반 노트", "최신 노트")},
    )
    # Force new to have later mtime
    now = time.time()
    os.utime(old, (now - 100, now - 100))
    os.utime(new, (now, now))
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1
    assert store.get_content_hash(GUID_NEW) is not None
    assert store.get_content_hash(GUID_OLD) is None
