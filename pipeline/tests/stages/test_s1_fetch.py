from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from desktop.lib.state import StateFile
from desktop.stages.s1_fetch import FakeTransport, SshRsyncTransport, fetch


@pytest.fixture
def stub_log(tmp_path):
    from desktop.lib.log import StageLogger

    return StageLogger("s1_fetch", tmp_path)


def _make_index(*uuids: str, present: bool = True) -> dict:
    return {u: {"received_at": "now", "mtime": 100, "present": present} for u in uuids}


def test_fetch_pulls_new_uuids(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"\x00\x00", "abc-1.metadata": b"{}"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == ["abc-1"]
    assert (raw_root / "abc-1" / "abc-1.rm").read_bytes() == b"\x00\x00"
    assert state.contains("abc-1")


def test_fetch_skips_already_fetched(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []
    assert not (raw_root / "abc-1").exists()


def test_fetch_skips_uuids_marked_not_present(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    transport = FakeTransport(
        index=_make_index("abc-1", present=False),
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []


def test_fetch_continues_after_per_uuid_error(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")

    class FlakyTransport(FakeTransport):
        def pull(self, page_uuid: str, target_dir: Path) -> None:
            if page_uuid == "bad":
                raise RuntimeError("network glitch")
            return super().pull(page_uuid, target_dir)

    transport = FlakyTransport(
        index=_make_index("bad", "ok"),
        files={"ok": {"ok.rm": b"X"}, "bad": {"bad.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert "ok" in fetched
    assert "bad" not in fetched
    assert state.contains("ok")
    assert not state.contains("bad")


def test_force_re_fetches(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index=_make_index("abc-1"),
        files={"abc-1": {"abc-1.rm": b"NEW"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport, force={"abc-1"})

    assert fetched == ["abc-1"]
    assert (raw_root / "abc-1" / "abc-1.rm").read_bytes() == b"NEW"


# --- SshRsyncTransport argv regression tests ---------------------------------
#
# FakeTransport above stubs out the network entirely, so it can't catch
# argv-construction mistakes (scp's `-P` vs ssh's `-p`, scp's SFTP mode
# refusing /dev/stdout, etc.). These tests pin the argv shape of every
# subprocess SshRsyncTransport spawns.


def _stub_cfg(**pi_overrides) -> SimpleNamespace:
    pi = SimpleNamespace(
        ssh_host="pi.test",
        ssh_port=2222,
        ssh_user="diary-sync",
        ssh_key="~/.ssh/id_ed25519_diary",
        inbox_path="~/diary/inbox",
    )
    for k, v in pi_overrides.items():
        setattr(pi, k, v)
    return SimpleNamespace(pi=pi)


def test_ssh_args_uses_lowercase_p():
    # ssh and rsync (`-e ssh`) want `-p` lowercase. scp wants `-P`. Mixing
    # them broke fetch_index silently — scp parsed `-p 2222` as "preserve
    # mtime" + "2222 as a local source filename".
    args = SshRsyncTransport(_stub_cfg())._ssh_args()
    assert "-p" in args and args[args.index("-p") + 1] == "2222"
    assert "-P" not in args


def test_fetch_index_invokes_ssh_with_remote_cat():
    # OpenSSH 9+ scp defaults to SFTP mode, which refuses /dev/stdout as a
    # destination. The transport must use `ssh ... cat <path>` instead.
    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=b'{"abc-1": {"present": true, "mtime": 100, "received_at": "now"}}',
    )
    with patch(
        "desktop.stages.s1_fetch.subprocess.run", return_value=completed
    ) as run:
        idx = SshRsyncTransport(_stub_cfg()).fetch_index()
    assert idx["abc-1"]["present"] is True
    argv = run.call_args.args[0]
    assert argv[0] == "ssh", f"must call ssh, not scp; got {argv[0]!r}"
    assert argv[-1].startswith("cat "), f"remote command must be cat; got {argv[-1]!r}"
    assert "state/index.json" in argv[-1]


def test_pull_builds_rsync_with_ssh_transport_and_lowercase_p(tmp_path: Path):
    # pull's rsync uses `-e "ssh -p PORT ..."`. The inner ssh invocation
    # must keep -p lowercase. A leaked -P would be a copy-paste from scp.
    completed = subprocess.CompletedProcess(args=[], returncode=0)
    with patch(
        "desktop.stages.s1_fetch.subprocess.run", return_value=completed
    ) as run:
        SshRsyncTransport(_stub_cfg()).pull("abc-123", tmp_path / "raw")
    argv = run.call_args.args[0]
    assert argv[0] == "rsync"
    e_idx = argv.index("-e")
    transport_cmd = argv[e_idx + 1]
    assert transport_cmd.startswith("ssh ")
    assert "-p 2222" in transport_cmd
    assert "-P" not in transport_cmd
    assert any("abc-123.*" in a for a in argv), f"argv missing page-uuid glob: {argv}"
