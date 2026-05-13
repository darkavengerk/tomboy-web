"""Tests for RAG note parser — .note XML → ParsedNote."""
from __future__ import annotations

import hashlib

from desktop.rag.note_parser import parse_note_xml


def _make_note(title: str, body: str) -> str:
    """Construct a minimal valid .note XML string."""
    ns_link = "http://beatniksoftware.com/tomboy/link"
    ns_size = "http://beatniksoftware.com/tomboy/size"
    ns = "http://beatniksoftware.com/tomboy"
    return (
        f'<?xml version="1.0" encoding="utf-8"?>\n'
        f'<note version="0.3" xmlns:link="{ns_link}" '
        f'xmlns:size="{ns_size}" xmlns="{ns}">\n'
        f"  <title>{title}</title>\n"
        f"  <text xml:space=\"preserve\">"
        f"<note-content>{body}</note-content></text>\n"
        f"  <last-change-date>2026-05-13T12:00:00.000000Z</last-change-date>\n"
        f"  <last-metadata-change-date>2026-05-13T12:00:00.000000Z"
        f"</last-metadata-change-date>\n"
        f"  <create-date>2026-05-13T12:00:00.000000Z</create-date>\n"
        f"  <cursor-position>0</cursor-position>\n"
        f"  <selection-bound-position>-1</selection-bound-position>\n"
        f"  <width>450</width>\n"
        f"  <height>360</height>\n"
        f"  <x>0</x>\n"
        f"  <y>0</y>\n"
        f"  <open-on-startup>False</open-on-startup>\n"
        f"</note>"
    )


def test_parses_plain_note():
    """Parse minimal valid .note XML."""
    xml = _make_note("Hello", "Hello\nworld")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert parsed.title == "Hello"
    assert parsed.body_text == "Hello\nworld"
    assert parsed.is_special is False


def test_strips_inline_marks():
    """Remove all inline XML tags from body."""
    body = (
        "Start <bold>bold</bold> and "
        "<list><list-item>item</list-item></list> end"
    )
    xml = _make_note("Test", body)
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert "<" not in parsed.body_text
    assert ">" not in parsed.body_text
    assert "bold" in parsed.body_text
    assert "item" in parsed.body_text


def test_decodes_entities():
    """Decode XML named entities."""
    xml = _make_note("Entities", "Test &amp; &lt; &gt; &quot; &apos;")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert "&" in parsed.body_text
    assert "<" in parsed.body_text
    assert ">" in parsed.body_text
    assert '"' in parsed.body_text
    assert "'" in parsed.body_text
    assert "&amp;" not in parsed.body_text


def test_detects_llm_signature():
    """Detect llm:// prefix in body."""
    xml = _make_note("LLM Note", "llm://gpt-4\nstuff")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert parsed.is_special is True


def test_detects_ssh_signature():
    """Detect ssh:// prefix in body."""
    xml = _make_note("Terminal", "ssh://user@host\ncommands")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert parsed.is_special is True


def test_special_signature_ignores_leading_whitespace():
    """Detect special signature after leading whitespace."""
    xml = _make_note("Term2", "\n  ssh://host")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert parsed.is_special is True


def test_content_hash_is_sha256_of_title_newline_body():
    """Verify exact content hash format."""
    xml = _make_note("Title", "body text")
    parsed = parse_note_xml(xml)
    assert parsed is not None
    expected_hash = hashlib.sha256(b"Title\nbody text").hexdigest()
    assert parsed.content_hash == expected_hash


def test_hash_changes_when_body_changes():
    """Different body → different hash."""
    xml1 = _make_note("Same", "body1")
    xml2 = _make_note("Same", "body2")
    p1 = parse_note_xml(xml1)
    p2 = parse_note_xml(xml2)
    assert p1 is not None
    assert p2 is not None
    assert p1.content_hash != p2.content_hash


def test_malformed_xml_returns_none():
    """Malformed XML → None."""
    xml = "<not closed"
    parsed = parse_note_xml(xml)
    assert parsed is None


def test_missing_note_content_returns_none():
    """No <note-content> → None."""
    xml = _make_note("Title", "").replace("<note-content>", "").replace("</note-content>", "")
    parsed = parse_note_xml(xml)
    assert parsed is None


def test_empty_title_returns_none():
    """Empty or whitespace-only title → None."""
    xml = _make_note("   ", "body")
    parsed = parse_note_xml(xml)
    assert parsed is None


def test_preserves_line_breaks():
    """Multi-line body preserves newlines."""
    body = "line1\nline2\nline3"
    xml = _make_note("MultiLine", body)
    parsed = parse_note_xml(xml)
    assert parsed is not None
    assert parsed.body_text == body
    assert parsed.body_text.count("\n") == 2
