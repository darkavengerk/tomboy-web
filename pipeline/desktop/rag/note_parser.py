"""Parse Tomboy .note XML into structured ParsedNote for RAG indexing."""
from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedNote:
    """Structured representation of a note ready for RAG indexing."""

    title: str  # trimmed, exact case
    body_text: str  # all marks/tags stripped, lines preserved
    content_hash: str  # sha256 hex of f"{title}\n{body_text}"
    is_special: bool  # True if body starts with "llm://" or "ssh://"


def _unescape_xml_entities(text: str) -> str:
    """Decode the 5 standard XML named entities."""
    replacements = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
    }
    for entity, char in replacements.items():
        text = text.replace(entity, char)
    return text


def parse_note_xml(xml: str) -> ParsedNote | None:
    """Parse a Tomboy .note XML payload. Returns None on malformed input."""
    # Parse XML structure to extract title
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    # Extract title from <title> element; handle namespace
    title = None
    for el in root:
        local_name = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if local_name == "title":
            title = (el.text or "").strip()
            break

    if not title:
        return None

    # Extract <note-content> body via regex (preserve exact formatting)
    match = re.search(r"<note-content[^>]*>([\s\S]*?)</note-content>", xml)
    if not match:
        return None

    body_inner = match.group(1)

    # Strip all inline tags, then decode entities
    body_text = re.sub(r"<[^>]+>", "", body_inner)
    body_text = _unescape_xml_entities(body_text)
    body_text = body_text.rstrip()

    # Detect special signature (llm:// or ssh://)
    is_special = body_text.lstrip().startswith(("llm://", "ssh://"))

    # Compute content hash
    content_hash = hashlib.sha256(
        f"{title}\n{body_text}".encode()
    ).hexdigest()

    return ParsedNote(
        title=title,
        body_text=body_text,
        content_hash=content_hash,
        is_special=is_special,
    )
