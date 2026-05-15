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
from desktop.lib.pipeline_status import (
    PipelineStatusClient,
    build_status_fields,
    fetch_pending_reruns,
)
from desktop.lib.state import StateFile
from desktop.lib.tomboy_payload import build_payload


class _Firestore(Protocol):
    def get_note(self, guid: str) -> dict[str, Any] | None: ...
    def set_note(self, guid: str, payload: dict[str, Any]) -> None: ...


class _Dropbox(Protocol):
    def upload(self, local_path: Path, target_path: str) -> Any: ...
    def share_link(self, target_path: str) -> str: ...


class _PipelineStatus(Protocol):
    def get(self, page_uuid: str) -> dict[str, Any] | None: ...
    def set(self, page_uuid: str, fields: dict[str, Any]) -> None: ...
    def clear_rerun(self, page_uuid: str) -> None: ...


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


def _ocr_summary(ocr_root: Path, rm_uuid: str) -> tuple[str | None, int | None, str | None]:
    """Best-effort: return (model, char_count, ts) from ``ocr/<uuid>.json``
    so we can backfill status docs even for old pages. Returns triple of
    ``None`` if the file is missing or malformed."""
    p = ocr_root / f"{rm_uuid}.json"
    if not p.exists():
        return None, None, None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, None
    text = data.get("text") if isinstance(data, dict) else None
    chars = len(text) if isinstance(text, str) else None
    return (
        data.get("model") if isinstance(data, dict) else None,
        chars,
        data.get("ts") if isinstance(data, dict) else None,
    )


def _status_for_uuid(
    *,
    rm_uuid: str,
    written_entry: dict[str, Any],
    prep_entry: dict[str, Any] | None,
    ocr_root: Path,
) -> dict[str, Any]:
    """Build the status doc fields for one rM page from local state."""
    image_url = written_entry.get("image_url") or ""
    written_at = written_entry.get("written_at") or ""
    tomboy_guid = written_entry.get("tomboy_guid") or ""
    img_w: int | None = None
    img_h: int | None = None
    prepared_at: str | None = None
    last_modified_ms: int | None = None
    if prep_entry:
        img_w = prep_entry.get("png_width") if isinstance(prep_entry.get("png_width"), int) else None
        img_h = prep_entry.get("png_height") if isinstance(prep_entry.get("png_height"), int) else None
        prepared_at = prep_entry.get("prepared_at")
        meta = prep_entry.get("metadata") or {}
        lm = meta.get("lastModified") if isinstance(meta, dict) else None
        if isinstance(lm, (int, str)):
            try:
                last_modified_ms = int(lm)
            except (ValueError, TypeError):
                last_modified_ms = None
    ocr_model, ocr_chars, ocr_at = _ocr_summary(ocr_root, rm_uuid)
    return build_status_fields(
        page_uuid=rm_uuid,
        tomboy_guid=tomboy_guid,
        image_url=image_url,
        image_width=img_w,
        image_height=img_h,
        ocr_model=ocr_model,
        ocr_char_count=ocr_chars,
        ocr_at=ocr_at,
        prepared_at=prepared_at,
        written_at=written_at,
        last_modified_ms=last_modified_ms,
    )


def backfill_status(
    *,
    written_state: StateFile,
    prepared_state: StateFile,
    ocr_root: Path,
    status: _PipelineStatus | None,
    log: StageLogger,
) -> int:
    """For each entry in ``written.json`` lacking a status doc in
    Firestore, write one. Lets the admin page surface pages that were
    OCR'd before this feature existed (or before the long-page renderer
    fix), so users can re-process them."""
    if status is None:
        return 0
    prep_index = prepared_state.read()
    count = 0
    for rm_uuid, entry in written_state.read().items():
        try:
            if status.get(rm_uuid) is not None:
                continue
            fields = _status_for_uuid(
                rm_uuid=rm_uuid,
                written_entry=entry,
                prep_entry=prep_index.get(rm_uuid),
                ocr_root=ocr_root,
            )
            status.set(rm_uuid, fields)
            count += 1
        except Exception as e:
            log.error("status_backfill_failed", uuid=rm_uuid, reason=str(e))
    if count > 0:
        log.info("status_backfilled", count=count)
    return count


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
    status: _PipelineStatus | None = None,
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
            # `metadata_change_date` is forced to "now" on every write — without
            # this the app-side conflictResolver hits a `metadataChangeDate`
            # tie on re-OCR (rM mtime doesn't change between runs) and falls
            # through to `tie-prefers-local`, pushing the user's stale local
            # short content BACK over our freshly-written long OCR. Bumping
            # metadataChangeDate makes our writes strictly newer so the
            # resolver pulls remote.
            #
            # changeDate stays at rM mtime so the diary date in the title and
            # any changeDate-based sort still reflects when the user actually
            # wrote the page on the tablet.
            payload = build_payload(
                guid=target_guid,
                page_uuid=rm_uuid,
                ocr_text=ocr_data["text"],
                image_url=image_url,
                notebook_name=notebook_name,
                title_format=title_format,
                create_date=create_dt,
                change_date=change_dt,
                metadata_change_date=datetime.now(timezone.utc),
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
            written_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            written_state.update(
                {
                    rm_uuid: {
                        "written_at": written_at,
                        "tomboy_guid": target_guid,
                        "image_url": image_url,
                    }
                }
            )
            # Sync admin-visible status. Best-effort: a Firestore hiccup
            # here must not roll back the note write we just succeeded at.
            if status is not None:
                try:
                    fields = _status_for_uuid(
                        rm_uuid=rm_uuid,
                        written_entry={
                            "written_at": written_at,
                            "tomboy_guid": target_guid,
                            "image_url": image_url,
                        },
                        prep_entry=prep,
                        ocr_root=ocr_root,
                    )
                    status.set(rm_uuid, fields)
                    # Successful write clears any pending re-process flag
                    # regardless of whether this run originated from one.
                    status.clear_rerun(rm_uuid)
                except Exception as e:
                    log.error("status_write_failed", uuid=rm_uuid, reason=str(e))
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
    status: PipelineStatusClient | None
    try:
        status = PipelineStatusClient(
            uid=cfg.firebase_uid,
            service_account_path=cfg.firebase_service_account,
        )
    except Exception as e:
        log.error("pipeline_status_init_failed", reason=str(e))
        status = None

    rerun_uuids = fetch_pending_reruns(cfg, log)

    backfilled = backfill_status(
        written_state=written,
        prepared_state=prepared,
        ocr_root=ocr_root,
        status=status,
        log=log,
    )

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
        force=set(args.force) | set(rerun_uuids),
        status=status,
    )
    print(
        f"s4_write: {len(processed)} pages written to Firestore"
        + (f" (+{backfilled} status docs backfilled)" if backfilled else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
