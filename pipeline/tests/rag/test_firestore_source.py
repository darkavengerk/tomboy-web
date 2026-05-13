from unittest.mock import MagicMock

from desktop.rag.firestore_source import (
    FirestoreSource,
    NoteEvent,
    WatermarkStore,
)


def test_watermark_store_default_epoch(tmp_path):
    ws = WatermarkStore(tmp_path / "w.json")
    assert ws.get() == "1970-01-01T00:00:00+00:00"


def test_watermark_store_roundtrip(tmp_path):
    ws = WatermarkStore(tmp_path / "w.json")
    ws.set("2026-05-13T12:00:00+00:00")
    assert ws.get() == "2026-05-13T12:00:00+00:00"
    ws2 = WatermarkStore(tmp_path / "w.json")
    assert ws2.get() == "2026-05-13T12:00:00+00:00"


class _FakeSnap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data
    def to_dict(self):
        return self._data


def _fake_client_query(docs):
    """Mock that mimics .collection().document().collection().where().order_by().limit().stream()"""
    client = MagicMock()
    # The query chain returns the same mock; stream() returns docs
    chain = client.collection.return_value.document.return_value.collection.return_value
    chain.where.return_value = chain
    chain.order_by.return_value = chain
    chain.limit.return_value = chain
    chain.stream.return_value = iter(docs)
    return client


def test_poll_once_yields_events(tmp_path):
    docs = [
        _FakeSnap("guid-1", {
            "xmlContent": "<note>1</note>",
            "deleted": False,
            "serverUpdatedAt": "2026-05-13T10:00:00+00:00",
        }),
        _FakeSnap("guid-2", {
            "deleted": True,
            "serverUpdatedAt": "2026-05-13T11:00:00+00:00",
        }),
    ]
    client = _fake_client_query(docs)
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)

    events = src.poll_once()
    assert len(events) == 2
    assert events[0] == NoteEvent(
        guid="guid-1", xml_content="<note>1</note>", deleted=False,
        server_updated_at="2026-05-13T10:00:00+00:00",
    )
    assert events[1].deleted is True
    assert events[1].xml_content is None
    # Watermark advanced to last event's timestamp
    assert ws.get() == "2026-05-13T11:00:00+00:00"


def test_poll_once_skips_doc_without_xml(tmp_path):
    docs = [
        _FakeSnap("g1", {
            "deleted": False,
            "serverUpdatedAt": "2026-05-13T10:00:00+00:00",
            # no xmlContent
        }),
    ]
    client = _fake_client_query(docs)
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)
    events = src.poll_once()
    assert events == []
    # Watermark still advances (so we don't reprocess on every poll)
    assert ws.get() == "2026-05-13T10:00:00+00:00"


def test_poll_once_no_docs(tmp_path):
    client = _fake_client_query([])
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)
    events = src.poll_once()
    assert events == []
    # Watermark unchanged
    assert ws.get() == "1970-01-01T00:00:00+00:00"
