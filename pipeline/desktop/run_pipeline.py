"""Orchestrator: run s1 → s2 → s3 → s4 in order."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable, Mapping


def run_all(stages: Mapping[str, Callable[[], int]]) -> str | None:
    """Returns the name of the first failing stage, or None on full success."""
    for name, fn in stages.items():
        try:
            fn()
        except Exception as e:
            sys.stderr.write(f"[run_pipeline] stage {name} failed: {e}\n")
            return name
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    args = parser.parse_args(argv)

    from desktop.stages import s1_fetch, s2_prepare, s3_ocr, s4_write

    stages = {
        "s1_fetch": lambda: s1_fetch.main(["--config", str(args.config)]),
        "s2_prepare": lambda: s2_prepare.main(["--config", str(args.config)]),
        "s3_ocr": lambda: s3_ocr.main(["--config", str(args.config)]),
        "s4_write": lambda: s4_write.main(["--config", str(args.config)]),
    }
    failed = run_all(stages=stages)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
