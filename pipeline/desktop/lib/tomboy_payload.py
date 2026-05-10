"""Build Firestore note documents matching the existing app's expected shape.

The pipeline only PRODUCES documents; it never parses them back. The app's
``parseNote`` / ``parseNoteContent`` (in ``app/src/lib/core/note*.ts``) is
the read side. Cross-checked via golden fixtures in tests.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

MAX_FIRESTORE_NOTE_BYTES = 900_000
NOTE_CONTENT_VERSION = "0.1"


class NotePayloadTooLargeError(ValueError):
    def __init__(self, byte_length: int) -> None:
        super().__init__(
            f"Note payload is {byte_length} bytes, exceeds limit of {MAX_FIRESTORE_NOTE_BYTES}"
        )
        self.byte_length = byte_length


def format_tomboy_date(dt: datetime) -> str:
    """Format a datetime to Tomboy's ``yyyy-MM-ddTHH:mm:ss.fffffffzzz``.

    Python ``datetime`` has microsecond (6-digit) precision; we pad to 7
    fractional digits to match Tomboy's C# ``DateTime`` output.
    """
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    frac = f"{dt.microsecond:06d}0"  # 6 digits → 7 by appending '0'
    offset = dt.strftime("%z")  # e.g. "+0000"
    if offset:
        offset = offset[:3] + ":" + offset[3:]
    else:
        offset = "+00:00"
    return f"{base}.{frac}{offset}"


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def build_note_content_xml(title: str, ocr_text: str, image_url: str) -> str:
    """Produce the ``<note-content>`` block per spec I7."""
    body = (
        f"{_xml_escape(title)}\n\n"
        f"{_xml_escape(ocr_text)}\n\n"
        f"---\n\n"
        f"{_xml_escape(image_url)}"
    )
    return f'<note-content version="{NOTE_CONTENT_VERSION}">{body}</note-content>'


def build_payload(
    *,
    guid: str,
    page_uuid: str,
    ocr_text: str,
    image_url: str,
    notebook_name: str,
    title_format: str,
    create_date: datetime,
    change_date: datetime,
    metadata_change_date: datetime | None = None,
) -> dict[str, Any]:
    """Build the FirestoreNotePayload dict (sans ``serverUpdatedAt``).

    The writer (``firestore_client``) adds ``serverUpdatedAt = SERVER_TIMESTAMP``
    at write time.
    """
    metadata_change_date = metadata_change_date or change_date
    date_str = change_date.strftime("%Y-%m-%d")
    title = title_format.format(date=date_str, page_uuid=page_uuid)
    xml_content = build_note_content_xml(title, ocr_text, image_url)
    payload: dict[str, Any] = {
        "guid": guid,
        "uri": f"note://tomboy/{guid}",
        "title": title,
        "xmlContent": xml_content,
        "createDate": format_tomboy_date(create_date),
        "changeDate": format_tomboy_date(change_date),
        "metadataChangeDate": format_tomboy_date(metadata_change_date),
        "tags": [f"system:notebook:{notebook_name}"],
        "deleted": False,
    }
    size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    if size > MAX_FIRESTORE_NOTE_BYTES:
        raise NotePayloadTooLargeError(size)
    return payload
