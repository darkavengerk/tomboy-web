from __future__ import annotations

from datetime import datetime, timezone

import pytest

from desktop.lib.tomboy_payload import (
    NotePayloadTooLargeError,
    build_note_content_xml,
    build_payload,
    format_tomboy_date,
)


def test_format_tomboy_date_utc():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    s = format_tomboy_date(dt)
    assert s.startswith("2024-05-10T12:00:00.")
    frac = s.split(".")[1].split("+")[0].split("-")[0]
    assert len(frac) == 7
    assert s.endswith("+00:00")


def test_format_tomboy_date_with_microseconds():
    dt = datetime(2024, 5, 10, 12, 0, 0, 123456, tzinfo=timezone.utc)
    s = format_tomboy_date(dt)
    assert ".1234560+" in s


def test_build_note_content_xml_basic():
    xml = build_note_content_xml(
        title="2024-05-10 리마커블([abc-123])",
        ocr_text="첫째줄\n둘째줄",
        image_url="https://example.com/page.png",
    )
    assert xml.startswith('<note-content version="0.1">')
    assert xml.endswith("</note-content>")
    assert "2024-05-10 리마커블([abc-123])" in xml
    assert "첫째줄" in xml
    assert "둘째줄" in xml
    assert "---" in xml
    assert "https://example.com/page.png" in xml


def test_build_note_content_xml_escapes_special_chars():
    xml = build_note_content_xml(
        title="t",
        ocr_text="a < b & c > d \"e\"",
        image_url="https://example.com/p.png",
    )
    assert "&lt;" in xml
    assert "&gt;" in xml
    assert "&amp;" in xml
    assert "&quot;" in xml


def test_build_payload_shape():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    payload = build_payload(
        guid="11111111-2222-3333-4444-555555555555",
        page_uuid="abc-123",
        ocr_text="hello",
        image_url="https://example.com/p.png",
        notebook_name="일기",
        title_format="{date} 리마커블([{page_uuid}])",
        create_date=dt,
        change_date=dt,
    )
    assert payload["guid"] == "11111111-2222-3333-4444-555555555555"
    assert payload["uri"] == "note://tomboy/11111111-2222-3333-4444-555555555555"
    assert payload["title"] == "2024-05-10 리마커블([abc-123])"
    assert "<note-content" in payload["xmlContent"]
    assert payload["tags"] == ["system:notebook:일기"]
    assert payload["deleted"] is False
    assert "createDate" in payload
    assert "changeDate" in payload
    assert "metadataChangeDate" in payload


def test_build_payload_title_uses_format_and_date():
    dt = datetime(2025, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    payload = build_payload(
        guid="g",
        page_uuid="p",
        ocr_text="",
        image_url="",
        notebook_name="일기",
        title_format="다이어리 {date} (#{page_uuid})",
        create_date=dt,
        change_date=dt,
    )
    assert payload["title"] == "다이어리 2025-01-15 (#p)"


def test_build_payload_too_large_raises():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    huge = "x" * 1_000_000
    with pytest.raises(NotePayloadTooLargeError) as exc:
        build_payload(
            guid="g",
            page_uuid="p",
            ocr_text=huge,
            image_url="https://e.com/p.png",
            notebook_name="일기",
            title_format="{date}",
            create_date=dt,
            change_date=dt,
        )
    assert exc.value.byte_length > 900_000


def test_build_payload_first_line_matches_title():
    dt = datetime(2024, 5, 10, tzinfo=timezone.utc)
    p = build_payload(
        guid="g",
        page_uuid="abc",
        ocr_text="body",
        image_url="https://e.com/p.png",
        notebook_name="일기",
        title_format="{date} 리마커블([{page_uuid}])",
        create_date=dt,
        change_date=dt,
    )
    inner = p["xmlContent"].replace('<note-content version="0.1">', "").replace(
        "</note-content>", ""
    )
    first_line = inner.lstrip().splitlines()[0]
    assert first_line == p["title"]
