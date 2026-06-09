"""Stage 1: pull new rM pages from the Pi inbox into ``raw/<uuid>/``.

The transport is abstracted so tests can use ``FakeTransport``; production
uses ``SshRsyncTransport`` which shells out to ``rsync`` over SSH.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol

from desktop.lib.config import Config, load_config
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile


class Transport(Protocol):
    def fetch_index(self) -> dict[str, dict[str, Any]]: ...
    def pull(self, page_uuid: str, target_dir: Path) -> None: ...


class FakeTransport:
    """Test fixture: a transport with in-memory index and per-uuid file maps."""

    def __init__(
        self,
        *,
        index: dict[str, dict[str, Any]],
        files: dict[str, dict[str, bytes]],
    ) -> None:
        self._index = index
        self._files = files

    def fetch_index(self) -> dict[str, dict[str, Any]]:
        return dict(self._index)

    def pull(self, page_uuid: str, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        for name, data in self._files[page_uuid].items():
            (target_dir / name).write_bytes(data)


class SshRsyncTransport:
    """Production transport: rsync over SSH using the Pi config."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def _ssh_args(self) -> list[str]:
        return [
            "-p",
            str(self.cfg.pi.ssh_port),
            "-i",
            str(Path(self.cfg.pi.ssh_key).expanduser()),
            "-o",
            "StrictHostKeyChecking=accept-new",
        ]

    def fetch_index(self) -> dict[str, dict[str, Any]]:
        state_path = (
            f"{self.cfg.pi.inbox_path.rstrip('/')}/../state/index.json"
        )
        remote = f"{self.cfg.pi.ssh_user}@{self.cfg.pi.ssh_host}"
        # `ssh ... cat <path>` instead of `scp ... /dev/stdout`: OpenSSH 9+
        # scp defaults to SFTP mode, which refuses /dev/stdout as a
        # destination (ftruncate / lseek on a non-regular file fail). ssh's
        # stdout is plumbed straight through and the remote shell expands
        # `~` / `..` naturally.
        proc = subprocess.run(
            ["ssh"] + self._ssh_args() + [remote, f"cat {state_path}"],
            check=True,
            capture_output=True,
        )
        return json.loads(proc.stdout.decode("utf-8"))

    def pull(self, page_uuid: str, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        ssh_cmd = "ssh " + " ".join(self._ssh_args())
        remote = (
            f"{self.cfg.pi.ssh_user}@{self.cfg.pi.ssh_host}:"
            f"{self.cfg.pi.inbox_path.rstrip('/')}/{page_uuid}.*"
        )
        subprocess.run(
            ["rsync", "-avz", "-e", ssh_cmd, remote, str(target_dir) + "/"],
            check=True,
        )


def fetch(
    *,
    raw_root: Path,
    state: StateFile,
    log: StageLogger,
    transport: Transport,
    force: Iterable[str] | None = None,
    downstream_states: Iterable[StateFile] | None = None,
) -> list[str]:
    force = set(force or [])
    downstream = list(downstream_states or [])
    for u in force:
        state.remove(u)
        for s in downstream:
            s.remove(u)

    index = transport.fetch_index()
    fetched_uuids: list[str] = []

    for uuid, info in index.items():
        if not info.get("present"):
            continue
        if state.contains(uuid):
            # 펜으로 기존 페이지를 가필하면 rM이 같은 .rm을 재rsync 하고
            # Pi watcher가 inbox index의 mtime을 갱신한다. 그 mtime이
            # 우리가 마지막에 본 source_mtime보다 크면 재처리해야 한다.
            # 안 그러면 s1~s4의 UUID-기반 contains() 가드에 막혀 가필이
            # 영원히 묻힌다. 비교가 불가능하면(mtime 없음/source_mtime
            # 없음) 보수적으로 skip — 매 사이클 폭주 방지.
            prev_mtime = state.get(uuid, {}).get("source_mtime")
            new_mtime = info.get("mtime")
            if prev_mtime is None or new_mtime is None or new_mtime <= prev_mtime:
                continue
            log.info("re_fetch_mtime_bump", uuid=uuid, prev=prev_mtime, new=new_mtime)
            state.remove(uuid)
            for s in downstream:
                s.remove(uuid)
        target = raw_root / uuid
        try:
            if target.exists():
                shutil.rmtree(target)
            transport.pull(uuid, target)
            state.update(
                {
                    uuid: {
                        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "source_mtime": info.get("mtime"),
                    }
                }
            )
            log.info("fetched", uuid=uuid)
            fetched_uuids.append(uuid)
        except Exception as e:
            log.error("fetch_failed", uuid=uuid, reason=str(e))
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
    return fetched_uuids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    raw_root = cfg.data_dir / "raw"
    raw_root.mkdir(parents=True, exist_ok=True)
    state_dir = cfg.data_dir / "state"
    state = StateFile(state_dir / "fetched.json")
    # mtime cascade — re_fetch_mtime_bump이 트리거되거나 --force가 들어오면
    # 같은 UUID의 s2/s3/s4 state도 함께 비워야 재처리가 끝까지 흐른다.
    downstream_states = [
        StateFile(state_dir / "prepared.json"),
        StateFile(state_dir / "ocr-done.json"),
        StateFile(state_dir / "written.json"),
    ]
    log = StageLogger("s1_fetch", cfg.data_dir)
    transport = SshRsyncTransport(cfg)

    fetched = fetch(
        raw_root=raw_root,
        state=state,
        log=log,
        transport=transport,
        force=args.force,
        downstream_states=downstream_states,
    )
    print(f"s1_fetch: {len(fetched)} new pages fetched: {fetched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
