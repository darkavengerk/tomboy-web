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


def test_fetch_re_fetches_when_inbox_mtime_newer(tmp_path: Path, stub_log):
    # 펜 가필로 rM이 같은 UUID의 .rm을 다시 rsync → Pi inbox index의 mtime이
    # 데스크탑이 마지막에 본 source_mtime보다 커진다. 그러면 그 페이지는
    # 다시 흘려보내야 한다.
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index={"abc-1": {"received_at": "now", "mtime": 200, "present": True}},
        files={"abc-1": {"abc-1.rm": b"EDITED"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == ["abc-1"]
    assert (raw_root / "abc-1" / "abc-1.rm").read_bytes() == b"EDITED"
    assert state.get("abc-1")["source_mtime"] == 200


def test_fetch_clears_downstream_states_when_mtime_newer(tmp_path: Path, stub_log):
    # Cascade: s1이 재fetch를 결정하면 s2/s3/s4 state에서도 그 UUID 엔트리를
    # 지워야 다음 사이클에 정상 재처리된다. 안 지우면 OCR/Firestore는
    # contains() 가드에 막혀 영원히 스킵된다.
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    prepared = StateFile(tmp_path / "state" / "prepared.json")
    prepared.write({"abc-1": {"prepared_at": "old"}, "other": {"prepared_at": "old"}})
    ocr_done = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_done.write({"abc-1": {"ocr_at": "old"}})
    written = StateFile(tmp_path / "state" / "written.json")
    written.write({"abc-1": {"written_at": "old"}})

    transport = FakeTransport(
        index={"abc-1": {"received_at": "now", "mtime": 200, "present": True}},
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(
        raw_root=raw_root,
        state=state,
        log=stub_log,
        transport=transport,
        downstream_states=[prepared, ocr_done, written],
    )

    assert fetched == ["abc-1"]
    assert not prepared.contains("abc-1")
    assert not ocr_done.contains("abc-1")
    assert not written.contains("abc-1")
    # 다른 UUID는 건드리지 않는다
    assert prepared.contains("other")


def test_fetch_skips_when_inbox_mtime_same_or_older(tmp_path: Path, stub_log):
    # mtime이 같거나 더 오래면(시계 역행 등) 재fetch하지 않는다 — 평소 동작 그대로.
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old", "source_mtime": 100}})

    transport = FakeTransport(
        index={"abc-1": {"received_at": "now", "mtime": 100, "present": True}},
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []
    assert not (raw_root / "abc-1").exists()


def test_fetch_skips_when_source_mtime_missing(tmp_path: Path, stub_log):
    # 레거시 fetched.json: source_mtime 없음. 비교 못 하면 그냥 skip — 매 사이클
    # 재처리하면 비용 폭발하고 동작도 의도와 다르다.
    raw_root = tmp_path / "raw"
    raw_root.mkdir()
    state = StateFile(tmp_path / "state" / "fetched.json")
    state.write({"abc-1": {"fetched_at": "old"}})  # no source_mtime

    transport = FakeTransport(
        index={"abc-1": {"received_at": "now", "mtime": 200, "present": True}},
        files={"abc-1": {"abc-1.rm": b"X"}},
    )

    fetched = fetch(raw_root=raw_root, state=state, log=stub_log, transport=transport)

    assert fetched == []


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


def test_refetch_cascade_clears_composite_keys(tmp_path):
    from desktop.lib.log import StageLogger

    raw_root = tmp_path / "raw"
    state = StateFile(tmp_path / "state" / "fetched.json")
    # Already fetched at mtime 100.
    state.write({"slip": {"fetched_at": "x", "source_mtime": 100}})
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    prepared.write({"slip#0": {"a": 1}, "slip#1": {"b": 2}})
    ocr = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr.write({"slip#0": {"c": 3}, "slip#1": {"d": 4}})
    log = StageLogger("s1_fetch", tmp_path)

    # Pi index reports a NEWER mtime → re-fetch.
    transport = FakeTransport(
        index={"slip": {"present": True, "mtime": 200}},
        files={"slip": {"slip.rm": b"\x00", "slip.metadata": b"{}"}},
    )

    fetch(raw_root=raw_root, state=state, log=log, transport=transport,
          downstream_states=[prepared, ocr])

    # Both composite keys cleared from downstream so s2/s3 reprocess.
    assert prepared.read() == {}
    assert ocr.read() == {}
