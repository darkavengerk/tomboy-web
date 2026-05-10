"""Track which rM pages have landed in the Pi inbox.

Runs on a 5-minute systemd timer. Reads ``<inbox>/`` for ``.metadata``
files (one per page) and maintains ``<state>/index.json`` so the desktop
fetcher can see what's available without re-listing the inbox.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def scan_inbox(inbox_dir: Path | str) -> dict[str, dict[str, Any]]:
    inbox = Path(inbox_dir)
    out: dict[str, dict[str, Any]] = {}
    if not inbox.exists():
        return out
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for p in inbox.glob("*.metadata"):
        page_uuid = p.stem
        out[page_uuid] = {"mtime": int(p.stat().st_mtime), "received_at": now}
    return out


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def update_index(index_path: Path | str, scan_result: dict[str, dict[str, Any]]) -> None:
    index_path = Path(index_path)
    current: dict[str, Any] = {}
    if index_path.exists():
        current = json.loads(index_path.read_text(encoding="utf-8"))

    seen = set(scan_result.keys())

    # Update or insert entries for what's currently in the inbox
    for uuid, info in scan_result.items():
        if uuid in current:
            current[uuid]["mtime"] = info["mtime"]
            current[uuid]["present"] = True
            # received_at stays as it was — it's the FIRST-seen time
        else:
            current[uuid] = {
                "received_at": info["received_at"],
                "mtime": info["mtime"],
                "present": True,
            }

    # Mark vanished entries
    for uuid in list(current.keys()):
        if uuid not in seen:
            current[uuid]["present"] = False

    _atomic_write_json(index_path, current)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inbox", required=True, type=Path)
    parser.add_argument("--index", required=True, type=Path)
    args = parser.parse_args(argv)
    scan = scan_inbox(args.inbox)
    update_index(args.index, scan)
    # Bug fix: the original plan had a dead-code expression
    #   `sum(1 for v in json.loads(...)["__values__"]) if False else len(scan)`
    # The `if False` makes the sum branch unreachable and references a
    # non-existent "__values__" key that would crash at runtime if ever
    # reached. Replaced with the clean equivalent.
    present = len(scan)
    print(f"inbox-watcher: {present} pages currently in inbox")
    return 0


if __name__ == "__main__":
    sys.exit(main())
