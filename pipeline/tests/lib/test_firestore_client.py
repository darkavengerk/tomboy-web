from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from desktop.lib.firestore_client import FirestoreClient


@pytest.fixture
def mock_firebase(mocker):
    """Mock firebase_admin + firestore modules."""
    fa = mocker.patch("desktop.lib.firestore_client.firebase_admin")
    fs = mocker.patch("desktop.lib.firestore_client.firestore")
    fa.get_app.side_effect = ValueError  # not yet initialized
    fa.initialize_app.return_value = MagicMock()
    fs.client.return_value = MagicMock()
    fs.SERVER_TIMESTAMP = "<sentinel>"
    return fa, fs


def test_init_calls_initialize_app(mock_firebase):
    fa, _ = mock_firebase
    FirestoreClient("dbx-test", "/tmp/sa.json")
    fa.initialize_app.assert_called_once()


def test_init_skips_when_already_initialized(mocker):
    fa = mocker.patch("desktop.lib.firestore_client.firebase_admin")
    mocker.patch("desktop.lib.firestore_client.firestore")
    fa.get_app.return_value = MagicMock()  # already initialized
    FirestoreClient("dbx-test", "/tmp/sa.json")
    fa.initialize_app.assert_not_called()


def test_get_note_returns_none_when_missing(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    snap = MagicMock()
    snap.exists = False
    db.collection.return_value.document.return_value.collection.return_value.document.return_value.get.return_value = snap

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    assert c.get_note("guid-1") is None


def test_get_note_returns_dict_when_present(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    snap = MagicMock()
    snap.exists = True
    snap.to_dict.return_value = {"guid": "guid-1", "title": "T"}
    db.collection.return_value.document.return_value.collection.return_value.document.return_value.get.return_value = snap

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    result = c.get_note("guid-1")
    assert result == {"guid": "guid-1", "title": "T"}


def test_set_note_adds_server_timestamp(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    doc = db.collection.return_value.document.return_value.collection.return_value.document.return_value

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    c.set_note("guid-1", {"title": "T", "deleted": False})

    args, kwargs = doc.set.call_args
    written = args[0]
    assert written["title"] == "T"
    assert written["serverUpdatedAt"] == "<sentinel>"


def test_delete_note_writes_soft_delete(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    doc = db.collection.return_value.document.return_value.collection.return_value.document.return_value

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    c.delete_note("guid-1")

    args, _ = doc.set.call_args
    written = args[0]
    assert written["deleted"] is True
