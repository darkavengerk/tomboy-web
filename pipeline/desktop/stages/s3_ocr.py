"""Stage 3: drive the OCR backend on every prepared page."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from desktop.lib.config import Config, load_config
from desktop.lib.log import StageLogger
from desktop.lib.pipeline_status import fetch_pending_reruns
from desktop.lib.state import StateFile
from desktop.ocr_backends.base import OCRBackend, get_backend


def run_ocr(
    *,
    prepared_state: StateFile,
    ocr_state: StateFile,
    ocr_root: Path,
    log: StageLogger,
    backend: OCRBackend,
    force: Iterable[str] | None = None,
    only_uuids: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    only = set(only_uuids) if only_uuids else None
    for u in force:
        ocr_state.remove(u)

    ocr_root.mkdir(parents=True, exist_ok=True)
    processed: list[str] = []

    for uuid, prep_info in prepared_state.read().items():
        if only is not None and uuid not in only:
            continue
        if ocr_state.contains(uuid):
            continue
        png_path = Path(prep_info["png_path"])
        if not png_path.exists():
            log.error("png_missing", uuid=uuid, png_path=str(png_path))
            continue
        try:
            result = backend.ocr(png_path)
            (ocr_root / f"{uuid}.json").write_text(
                json.dumps(
                    {
                        "uuid": uuid,
                        "text": result.text,
                        "model": result.model,
                        "prompt_hash": result.prompt_hash,
                        "ts": result.ts.isoformat(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            ocr_state.update(
                {
                    uuid: {
                        "ocr_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "model": result.model,
                    }
                }
            )
            log.info("ocr_done", uuid=uuid, chars=len(result.text))
            processed.append(uuid)
        except Exception as e:
            log.error("ocr_failed", uuid=uuid, reason=str(e))
    return processed


def _build_backend(cfg: Config) -> OCRBackend:
    """cfg.ocr.backend 값에 따라 적절한 OCRBackend 인스턴스를 반환한다.

    OcrConfig.from_dict가 이미 backend 별 서브섹션 누락을 검증하므로
    여기서는 cfg.ocr.{local_vlm,claude}가 None이 아님을 가정해도 안전.
    그래도 방어적으로 한 번 더 확인한다 (config validation 변경에 강건).
    """
    name = cfg.ocr.backend
    if name == "local_vlm":
        if cfg.ocr.local_vlm is None:
            raise RuntimeError(
                "ocr.backend='local_vlm' but ocr.local_vlm subsection missing"
            )
        c = cfg.ocr.local_vlm
        return get_backend(
            "local_vlm",
            model_id=c.model_id,
            quantization=c.quantization,
            max_new_tokens=c.max_new_tokens,
            system_prompt_path=c.system_prompt_path,
        )
    if name == "claude":
        if cfg.ocr.claude is None:
            raise RuntimeError(
                "ocr.backend='claude' but ocr.claude subsection missing"
            )
        c = cfg.ocr.claude
        return get_backend(
            "claude",
            service_url=c.service_url,
            service_token=c.service_token,
            model=c.model,
            effort=c.effort,
            system_prompt_path=c.system_prompt_path,
        )
    raise RuntimeError(f"Unsupported OCR backend: {name!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    parser.add_argument(
        "--uuid",
        action="append",
        default=[],
        help="Process only these page UUIDs (repeatable). Per spec I2.",
    )
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    prepared_state = StateFile(cfg.data_dir / "state" / "prepared.json")
    ocr_state = StateFile(cfg.data_dir / "state" / "ocr-done.json")
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("s3_ocr", cfg.data_dir)

    try:
        backend = _build_backend(cfg)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    rerun_uuids = fetch_pending_reruns(cfg, log)
    processed = run_ocr(
        prepared_state=prepared_state,
        ocr_state=ocr_state,
        ocr_root=ocr_root,
        log=log,
        backend=backend,
        force=set(args.force) | set(rerun_uuids),
        only_uuids=args.uuid or None,
    )
    print(f"s3_ocr: {len(processed)} pages OCR'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
