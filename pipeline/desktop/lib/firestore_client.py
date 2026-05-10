"""Firebase Admin SDK wrapper. One instance per process; idempotent init."""
from __future__ import annotations

from typing import Any

import firebase_admin
from firebase_admin import firestore


_DEFAULT_APP_NAME = "tomboy-pipeline"


class FirestoreClient:
    def __init__(self, uid: str, service_account_path: str) -> None:
        self.uid = uid
        try:
            app = firebase_admin.get_app(_DEFAULT_APP_NAME)
        except ValueError:
            cred = firebase_admin.credentials.Certificate(service_account_path)
            app = firebase_admin.initialize_app(cred, name=_DEFAULT_APP_NAME)
        self._app = app
        self._db = firestore.client(self._app)

    def _doc(self, guid: str):
        return (
            self._db.collection("users")
            .document(self.uid)
            .collection("notes")
            .document(guid)
        )

    def get_note(self, guid: str) -> dict[str, Any] | None:
        snap = self._doc(guid).get()
        if not snap.exists:
            return None
        return snap.to_dict()

    def set_note(self, guid: str, payload: dict[str, Any]) -> None:
        merged = dict(payload)
        merged["serverUpdatedAt"] = firestore.SERVER_TIMESTAMP
        self._doc(guid).set(merged)

    def delete_note(self, guid: str) -> None:
        """Soft-delete: keep the doc, flip ``deleted=True``."""
        self._doc(guid).set({"deleted": True, "serverUpdatedAt": firestore.SERVER_TIMESTAMP})
