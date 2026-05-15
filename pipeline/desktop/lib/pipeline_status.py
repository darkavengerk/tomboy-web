"""Per-page status documents at ``users/{uid}/diary-pipeline-pages/{pageUuid}``.

Bridges the desktop pipeline's local state files to the web app's
``/admin/remarkable`` page. The app cannot reach the desktop's
filesystem, so we mirror just enough of the per-page state into a small
Firestore collection: page UUID → tomboy GUID, Dropbox image URL, PNG
dimensions, OCR metadata, and a re-process request flag.

Write side
----------
``s4_write`` calls ``write_status`` after a successful Firestore note
write. It also runs ``backfill_from_state`` at the start of every run
so pages processed before this feature existed (or before the
long-page renderer fix) show up in the admin view the next time s4
runs.

Re-process side
---------------
The admin page sets ``rerunRequested: true`` on a page. Each stage's
main() calls ``pending_reruns()`` at startup and folds the returned
UUIDs into its ``force`` set, so the next manual ``s2 → s3 → s4``
sequence re-runs the page end-to-end. ``s4`` calls ``clear_rerun``
on every page it successfully re-writes.
"""
from __future__ import annotations

from typing import Any, Iterable, Protocol


# Collection name lives here so callers don't hardcode it in three places.
COLLECTION = "diary-pipeline-pages"


class _Doc(Protocol):
    def get(self) -> Any: ...
    def set(self, fields: dict[str, Any], merge: bool = ...) -> Any: ...


class _Collection(Protocol):
    def document(self, doc_id: str) -> _Doc: ...
    def stream(self) -> Iterable[Any]: ...
    def where(self, *args: Any, **kwargs: Any) -> Any: ...


class PipelineStatusClient:
    """Thin wrapper over a Firestore collection scoped to one user.

    Constructed with a (uid, service_account_path) for production. Tests
    can subclass and override ``_collection`` to inject a fake.
    """

    def __init__(self, uid: str, service_account_path: str) -> None:
        self.uid = uid
        self.service_account_path = service_account_path
        self._db: Any = None

    def _init_db(self) -> None:
        if self._db is not None:
            return
        # Reuse the same firebase_admin app the FirestoreClient already
        # initialized — calling initialize_app twice with the same name
        # would raise. We try get_app first; if that fails, the
        # FirestoreClient sibling will have initialized when constructed,
        # but if PipelineStatusClient is constructed independently we
        # initialize here.
        import firebase_admin
        from firebase_admin import firestore, credentials

        _APP_NAME = "tomboy-pipeline"
        try:
            app = firebase_admin.get_app(_APP_NAME)
        except ValueError:
            cred = credentials.Certificate(self.service_account_path)
            app = firebase_admin.initialize_app(cred, name=_APP_NAME)
        self._db = firestore.client(app)

    def _collection(self) -> _Collection:
        self._init_db()
        return (
            self._db.collection("users")
            .document(self.uid)
            .collection(COLLECTION)
        )

    def get(self, page_uuid: str) -> dict[str, Any] | None:
        snap = self._collection().document(page_uuid).get()
        if not snap.exists:
            return None
        return snap.to_dict()

    def set(self, page_uuid: str, fields: dict[str, Any]) -> None:
        """Merge-set so callers can update a single field (e.g. clearing
        the rerun flag) without clobbering the rest of the document."""
        self._collection().document(page_uuid).set(fields, merge=True)

    def clear_rerun(self, page_uuid: str) -> None:
        self.set(
            page_uuid,
            {
                "rerunRequested": False,
                "rerunRequestedAt": None,
            },
        )

    def pending_reruns(self) -> list[str]:
        """Return the page UUIDs whose ``rerunRequested == True``.

        Pipeline stages call this at startup; the UUIDs are folded into
        each stage's ``force`` set.
        """
        coll = self._collection()
        # Firestore typed-equality query. The collection is small (one
        # doc per processed rM page) so we don't need an index.
        out: list[str] = []
        for snap in coll.where("rerunRequested", "==", True).stream():
            out.append(snap.id)
        return out


def fetch_pending_reruns(cfg: Any, log: Any | None = None) -> list[str]:
    """Best-effort: pull rerun-requested UUIDs from Firestore.

    Called by every stage's ``main()`` to fold queued UUIDs into the
    ``force`` set. Failures (no network, misconfigured creds, missing
    firebase_admin extra) are logged and treated as "no pending
    reruns" — never block the pipeline because the optional admin
    feature can't reach Firestore.
    """
    try:
        client = PipelineStatusClient(
            uid=cfg.firebase_uid,
            service_account_path=cfg.firebase_service_account,
        )
        uuids = client.pending_reruns()
        if log is not None and uuids:
            log.info("rerun_queue_pulled", count=len(uuids), uuids=",".join(uuids))
        return uuids
    except Exception as e:
        if log is not None:
            log.error("rerun_queue_unavailable", reason=str(e))
        return []


def build_status_fields(
    *,
    page_uuid: str,
    tomboy_guid: str,
    image_url: str,
    image_width: int | None,
    image_height: int | None,
    ocr_model: str | None,
    ocr_char_count: int | None,
    ocr_at: str | None,
    prepared_at: str | None,
    written_at: str,
    last_modified_ms: int | None,
) -> dict[str, Any]:
    """Build the doc body for ``write_status``. Pure function — callers
    can unit-test by inspecting the returned dict."""
    fields: dict[str, Any] = {
        "pageUuid": page_uuid,
        "tomboyGuid": tomboy_guid,
        "imageUrl": image_url,
        "writtenAt": written_at,
        "rerunRequested": False,
        "rerunRequestedAt": None,
    }
    if image_width is not None:
        fields["imageWidth"] = image_width
    if image_height is not None:
        fields["imageHeight"] = image_height
    if ocr_model is not None:
        fields["ocrModel"] = ocr_model
    if ocr_char_count is not None:
        fields["ocrCharCount"] = ocr_char_count
    if ocr_at is not None:
        fields["ocrAt"] = ocr_at
    if prepared_at is not None:
        fields["preparedAt"] = prepared_at
    if last_modified_ms is not None:
        fields["lastModifiedMs"] = last_modified_ms
    return fields
