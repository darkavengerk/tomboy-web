"""Stage 3: drive the OCR backend on every prepared page."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from desktop.lib.config import load_config
from desktop.lib.log import StageLogger
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
) -> list[str]:
    force = set(force or [])
    for u in force:
        ocr_state.remove(u)

    ocr_root.mkdir(parents=True, exist_ok=True)
    processed: list[str] = []

    for uuid, prep_info in prepared_state.read().items():
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    prepared_state = StateFile(cfg.data_dir / "state" / "prepared.json")
    ocr_state = StateFile(cfg.data_dir / "state" / "ocr-done.json")
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("s3_ocr", cfg.data_dir)

    if cfg.ocr.backend != "local_vlm" or cfg.ocr.local_vlm is None:
        print(f"Unsupported OCR backend in config: {cfg.ocr.backend}", file=sys.stderr)
        return 1

    backend = get_backend(
        cfg.ocr.backend,
        model_id=cfg.ocr.local_vlm.model_id,
        quantization=cfg.ocr.local_vlm.quantization,
        max_new_tokens=cfg.ocr.local_vlm.max_new_tokens,
        system_prompt_path=cfg.ocr.local_vlm.system_prompt_path,
    )

    processed = run_ocr(
        prepared_state=prepared_state,
        ocr_state=ocr_state,
        ocr_root=ocr_root,
        log=log,
        backend=backend,
        force=args.force,
    )
    print(f"s3_ocr: {len(processed)} pages OCR'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
