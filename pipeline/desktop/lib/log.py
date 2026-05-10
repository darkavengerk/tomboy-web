"""Stage-scoped logger that writes both JSONL and human-readable lines."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class StageLogger:
    """One logger per stage. Writes to ``<data_dir>/logs/<stage>.{jsonl,log}``."""

    def __init__(self, stage: str, data_dir: Path | str) -> None:
        self.stage = stage
        self.logs_dir = Path(data_dir) / "logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.jsonl_path = self.logs_dir / f"{stage}.jsonl"
        self.log_path = self.logs_dir / f"{stage}.log"

    def _emit(self, level: str, event: str, **kwargs: Any) -> None:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        record = {"ts": ts, "stage": self.stage, "level": level, "event": event, **kwargs}
        with self.jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        kv = " ".join(f"{k}={v}" for k, v in kwargs.items())
        human = f"[{ts}] {self.stage} {level} {event}"
        if kv:
            human += " " + kv
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(human + "\n")

    def info(self, event: str, **kwargs: Any) -> None:
        self._emit("info", event, **kwargs)

    def warning(self, event: str, **kwargs: Any) -> None:
        self._emit("warning", event, **kwargs)

    def error(self, event: str, **kwargs: Any) -> None:
        self._emit("error", event, **kwargs)
