from __future__ import annotations

from desktop.lib.pipeline_status import build_status_fields


def test_build_status_fields_required_only():
    out = build_status_fields(
        page_uuid="rm-1",
        tomboy_guid="g",
        image_url="https://example/page.png",
        image_width=None,
        image_height=None,
        ocr_model=None,
        ocr_char_count=None,
        ocr_at=None,
        prepared_at=None,
        written_at="2024-05-10T12:00:00+00:00",
        last_modified_ms=None,
    )
    # Required four fields always present.
    assert out["pageUuid"] == "rm-1"
    assert out["tomboyGuid"] == "g"
    assert out["imageUrl"] == "https://example/page.png"
    assert out["writtenAt"] == "2024-05-10T12:00:00+00:00"
    # rerun flag is always explicit (so a writes always lands a known value).
    assert out["rerunRequested"] is False
    assert out["rerunRequestedAt"] is None
    # Optional fields are omitted when None — Firestore doesn't need empty keys.
    assert "imageWidth" not in out
    assert "imageHeight" not in out
    assert "ocrModel" not in out
    assert "preparedAt" not in out
    assert "lastModifiedMs" not in out


def test_build_status_fields_all_set():
    out = build_status_fields(
        page_uuid="rm-1",
        tomboy_guid="g",
        image_url="https://example/page.png",
        image_width=1404,
        image_height=2800,
        ocr_model="Qwen/Qwen2.5-VL-7B-Instruct",
        ocr_char_count=512,
        ocr_at="2024-05-10T12:01:00+00:00",
        prepared_at="2024-05-10T12:00:30+00:00",
        written_at="2024-05-10T12:01:30+00:00",
        last_modified_ms=1715337600000,
    )
    assert out["imageWidth"] == 1404
    assert out["imageHeight"] == 2800
    assert out["ocrModel"].startswith("Qwen/")
    assert out["ocrCharCount"] == 512
    assert out["ocrAt"].startswith("2024-")
    assert out["preparedAt"].startswith("2024-")
    assert out["lastModifiedMs"] == 1715337600000


def test_build_status_fields_zero_values_are_kept():
    """0 is a legitimate value (e.g. empty OCR text → 0 chars). Don't
    silently drop it the way ``None`` is dropped."""
    out = build_status_fields(
        page_uuid="rm-1",
        tomboy_guid="g",
        image_url="https://example/page.png",
        image_width=None,
        image_height=None,
        ocr_model=None,
        ocr_char_count=0,
        ocr_at=None,
        prepared_at=None,
        written_at="2024-05-10T12:01:30+00:00",
        last_modified_ms=None,
    )
    assert out["ocrCharCount"] == 0
