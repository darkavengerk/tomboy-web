"""Atomic JSON state files, one per pipeline stage.

Each stage maintains state at ``<data_dir>/state/<stage>.json`` keyed by
rM page-uuid. Writes go through a temp file + rename so a crash leaves
the previous version intact.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


class StateFile:
    """A small wrapper over a JSON file used to track per-stage progress."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic: write to a sibling temp file in the same directory, then
        # os.replace (which is atomic on POSIX for files on the same fs).
        fd, tmp_path = tempfile.mkstemp(
            prefix=self.path.name + ".",
            suffix=".tmp",
            dir=self.path.parent,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp_path, self.path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            raise

    def update(self, patch: dict[str, Any]) -> None:
        current = self.read()
        current.update(patch)
        self.write(current)

    def contains(self, key: str) -> bool:
        return key in self.read()

    def get(self, key: str, default: Any = None) -> Any:
        return self.read().get(key, default)

    def remove(self, key: str) -> None:
        current = self.read()
        if key in current:
            del current[key]
            self.write(current)
