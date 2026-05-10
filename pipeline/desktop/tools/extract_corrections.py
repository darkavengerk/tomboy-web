"""Extract (page.png, ocr.txt, corrected.txt) triples for fine-tuning."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from desktop.lib.config import load_config
from desktop.lib.firestore_client import FirestoreClient
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile


class _Firestore(Protocol):
    def get_note(self, guid: str) -> dict[str, Any] | None: ...


_NOTE_CONTENT_RE = re.compile(
    r'<note-content[^>]*>(.*?)</note-content>', re.DOTALL
)


def parse_corrected_text(xml_content: str) -> str:
    """Extract the OCR-text region: between the title's blank line and the
    `---` separator. The body shape is fixed by I7."""
    m = _NOTE_CONTENT_RE.search(xml_content)
    inner = m.group(1) if m else xml_content
    # The structure (per I7): title, blank, body, blank, ---, blank, url
    # Split on '---' and take the first chunk; its content after the title.
    parts = inner.split("\n---\n", 1)
    head = parts[0]
    lines = head.split("\n")
    # Drop the title line + the blank line separator after it.
    if len(lines) >= 2 and lines[1] == "":
        body = "\n".join(lines[2:]).strip()
    else:
        body = "\n".join(lines[1:]).strip()
    return body


def extract(
    *,
    mappings: StateFile,
    corrections_state: StateFile,
    out_root: Path,
    png_root: Path,
    ocr_root: Path,
    firestore: _Firestore,
    log: StageLogger,
) -> list[str]:
    out_root.mkdir(parents=True, exist_ok=True)
    extracted: list[str] = []
    for rm_uuid, info in mappings.read().items():
        if corrections_state.contains(rm_uuid):
            continue
        try:
            doc = firestore.get_note(info["tomboy_guid"])
            if doc is None or doc.get("deleted"):
                continue
            title = doc.get("title", "")
            if f"[{rm_uuid}]" in title:
                # Marker still present — user hasn't finished correcting.
                continue
            corrected = parse_corrected_text(doc.get("xmlContent", ""))
            triple_dir = out_root / rm_uuid
            triple_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(png_root / rm_uuid / "page.png", triple_dir / "page.png")
            ocr_record = json.loads((ocr_root / f"{rm_uuid}.json").read_text(encoding="utf-8"))
            (triple_dir / "ocr.txt").write_text(ocr_record["text"], encoding="utf-8")
            (triple_dir / "corrected.txt").write_text(corrected, encoding="utf-8")
            corrections_state.update(
                {
                    rm_uuid: {
                        "corrected": True,
                        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    }
                }
            )
            log.info("triple_extracted", uuid=rm_uuid)
            extracted.append(rm_uuid)
        except Exception as e:
            log.error("extract_failed", uuid=rm_uuid, reason=str(e))
    return extracted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    mappings = StateFile(cfg.data_dir / "state" / "mappings.json")
    corrections_state = StateFile(cfg.data_dir / "state" / "corrections.json")
    out_root = cfg.data_dir / "corrections"
    png_root = cfg.data_dir / "png"
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("extract_corrections", cfg.data_dir)
    fs = FirestoreClient(cfg.firebase_uid, cfg.firebase_service_account)

    extracted = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    print(f"extract_corrections: {len(extracted)} triples emitted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
