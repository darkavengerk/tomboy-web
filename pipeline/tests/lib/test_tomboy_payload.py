from __future__ import annotations

import re
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


def test_whole_body_has_no_image_or_hr():
    xml = build_note_content_xml("T", "a\nb")
    assert xml == '<note-content version="0.1">T\n\na\nb</note-content>'
    assert "<link:url>" not in xml
    assert "---" not in xml


def test_whole_body_escapes_special_chars():
    xml = build_note_content_xml("t", 'a < b & c > d "e"')
    assert "&lt;" in xml and "&gt;" in xml and "&amp;" in xml and "&quot;" in xml


def test_slip_skeleton_body_layout():
    title = "2026-06-14 09:30 리마커블 上([abc#0])"
    xml = build_note_content_xml(title, "본문1\n본문2", slip=True)
    inner = xml.replace('<note-content version="0.1">', "").replace("</note-content>", "")
    lines = inner.split("\n")
    assert lines[0] == title
    assert lines[1] == ""
    assert lines[2] == "이전: 없음"
    assert lines[3] == "다음: 없음"
    assert lines[4] == ""
    assert lines[5] == "본문1"
    assert "<link:url>" not in xml


def test_build_payload_whole_page():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc-123", ocr_text="hello",
        notebook_name="일기", title_format="{date} 리마커블([{unit_key}])",
        create_date=dt, change_date=dt,
    )
    assert p["title"] == "2024-05-10 리마커블([abc-123])"
    assert p["tags"] == ["system:notebook:일기"]
    assert p["deleted"] is False
    assert "<link:url>" not in p["xmlContent"]
    inner = p["xmlContent"].replace('<note-content version="0.1">', "").replace("</note-content>", "")
    assert inner.lstrip().splitlines()[0] == p["title"]


def test_build_payload_slip_title_matches_app_regex():
    DATE_TIME_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b")
    dt = datetime(2026, 6, 14, 9, 30, 0, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc", unit_key="abc#0", ocr_text="x",
        notebook_name="[0] Slip-Box",
        title_format="{datetime} 리마커블 {label}([{unit_key}])",
        create_date=dt, change_date=dt, label="上", slip=True,
    )
    assert p["title"] == "2026-06-14 09:30 리마커블 上([abc#0])"
    assert DATE_TIME_PREFIX.match(p["title"])
    assert p["tags"] == ["system:notebook:[0] Slip-Box"]
    assert "이전: 없음" in p["xmlContent"]
    assert "다음: 없음" in p["xmlContent"]


def test_build_payload_marker_uses_unit_key():
    dt = datetime(2026, 6, 14, 9, 30, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc", unit_key="abc#1", ocr_text="x",
        notebook_name="N", title_format="{datetime} 리마커블 {label}([{unit_key}])",
        create_date=dt, change_date=dt, label="下", slip=True,
    )
    assert "[abc#1]" in p["title"]


def test_build_payload_too_large_raises():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(NotePayloadTooLargeError):
        build_payload(
            guid="g", page_uuid="p", ocr_text="x" * 1_000_000,
            notebook_name="일기", title_format="{date}",
            create_date=dt, change_date=dt,
        )
