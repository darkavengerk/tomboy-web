"""Stage 4: write OCR'd pages to Firestore. Implements the I1 mapping algorithm.

Per spec §3:
  1. mapping miss → new guid
  2. mapping hit + title still has [rm_uuid] + not deleted → overwrite same guid
  3. mapping hit + title marker removed → new guid (user-protected)
  4. mapping hit + doc missing or deleted=True → new guid
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid as uuid_lib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol

from desktop.lib.config import load_config
from desktop.lib.dropbox_uploader import DropboxUploader
from desktop.lib.firestore_client import FirestoreClient
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.lib.tomboy_payload import build_payload


class _Firestore(Protocol):
    def get_note(self, guid: str) -> dict[str, Any] | None: ...
    def set_note(self, guid: str, payload: dict[str, Any]) -> None: ...


class _Dropbox(Protocol):
    def upload(self, local_path: Path, target_path: str) -> Any: ...
    def share_link(self, target_path: str) -> str: ...


def _resolve_target_guid(
    *,
    rm_uuid: str,
    mappings: StateFile,
    firestore: _Firestore,
) -> tuple[str, bool]:
    """Returns (target_guid, is_new). Implements the I1 algorithm."""
    existing = mappings.get(rm_uuid)
    if existing is None:
        return str(uuid_lib.uuid4()), True

    candidate_guid = existing["tomboy_guid"]
    doc = firestore.get_note(candidate_guid)
    if doc is None:
        # Doc missing — treat as protected/deleted; mint new
        return str(uuid_lib.uuid4()), True
    if doc.get("deleted") is True:
        return str(uuid_lib.uuid4()), True
    title = doc.get("title", "")
    if f"[{rm_uuid}]" not in title:
        # User removed the marker — protected; mint new
        return str(uuid_lib.uuid4()), True
    # Still marked, not deleted → overwrite
    return candidate_guid, False


def _ms_to_dt(ms_str: str) -> datetime:
    return datetime.fromtimestamp(int(ms_str) / 1000, tz=timezone.utc)


def write_pending(
    *,
    ocr_root: Path,
    prepared_state: StateFile,
    ocr_state: StateFile,
    written_state: StateFile,
    mappings: StateFile,
    firestore: _Firestore,
    dropbox: _Dropbox,
    log: StageLogger,
    notebook_name: str,
    title_format: str,
    force: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        written_state.remove(u)

    processed: list[str] = []
    prepared_index = prepared_state.read()

    for rm_uuid, _ in ocr_state.read().items():
        if written_state.contains(rm_uuid):
            continue
        ocr_path = ocr_root / f"{rm_uuid}.json"
        prep = prepared_index.get(rm_uuid)
        if not ocr_path.exists() or prep is None:
            log.error("inputs_missing", uuid=rm_uuid)
            continue
        try:
            ocr_data = json.loads(ocr_path.read_text(encoding="utf-8"))
            metadata = prep["metadata"]
            change_dt = _ms_to_dt(metadata["lastModified"])
            existing_mapping = mappings.get(rm_uuid)
            create_dt = (
                datetime.fromisoformat(existing_mapping["first_seen"])
                if existing_mapping and "first_seen" in existing_mapping
                else change_dt
            )

            # 1. Upload image FIRST. If this fails, no Firestore write happens.
            png_path = Path(prep["png_path"])
            target_path = (
                f"/Apps/Tomboy/diary-images/{change_dt:%Y/%m/%d}/{rm_uuid}/page.png"
            )
            dropbox.upload(png_path, target_path)
            image_url = dropbox.share_link(target_path)

            # 2. Resolve target guid via the I1 algorithm.
            target_guid, is_new = _resolve_target_guid(
                rm_uuid=rm_uuid, mappings=mappings, firestore=firestore
            )

            # 3. Build the payload.
            payload = build_payload(
                guid=target_guid,
                page_uuid=rm_uuid,
                ocr_text=ocr_data["text"],
                image_url=image_url,
                notebook_name=notebook_name,
                title_format=title_format,
                create_date=create_dt,
                change_date=change_dt,
            )

            # 4. Write doc.
            firestore.set_note(target_guid, payload)

            # 5. Update mappings + written state.
            mappings.update(
                {
                    rm_uuid: {
                        "tomboy_guid": target_guid,
                        "first_seen": create_dt.isoformat(),
                    }
                }
            )
            written_state.update(
                {
                    rm_uuid: {
                        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "tomboy_guid": target_guid,
                        "image_url": image_url,
                    }
                }
            )
            log.info(
                "wrote_note",
                uuid=rm_uuid,
                guid=target_guid,
                is_new=is_new,
            )
            processed.append(rm_uuid)
        except Exception as e:
            log.error("write_failed", uuid=rm_uuid, reason=str(e))
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    prepared = StateFile(cfg.data_dir / "state" / "prepared.json")
    ocr_state = StateFile(cfg.data_dir / "state" / "ocr-done.json")
    written = StateFile(cfg.data_dir / "state" / "written.json")
    mappings = StateFile(cfg.data_dir / "state" / "mappings.json")
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("s4_write", cfg.data_dir)

    fs = FirestoreClient(cfg.firebase_uid, cfg.firebase_service_account)
    dbx = DropboxUploader(cfg.dropbox_refresh_token, cfg.dropbox_app_key)

    processed = write_pending(
        ocr_root=ocr_root,
        prepared_state=prepared,
        ocr_state=ocr_state,
        written_state=written,
        mappings=mappings,
        firestore=fs,
        dropbox=dbx,
        log=log,
        notebook_name=cfg.tomboy.diary_notebook_name,
        title_format=cfg.tomboy.title_format,
        force=args.force,
    )
    print(f"s4_write: {len(processed)} pages written to Firestore")
    return 0


if __name__ == "__main__":
    sys.exit(main())
