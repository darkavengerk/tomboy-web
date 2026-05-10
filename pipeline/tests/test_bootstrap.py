from __future__ import annotations

from pathlib import Path

import pytest

from desktop.bootstrap import compute_uid, sanitize_account_id, write_config
from desktop.lib.config import load_config


def test_sanitize_strips_dbid_prefix():
    assert sanitize_account_id("dbid:abc-123_DEF") == "abc-123_DEF"


def test_sanitize_replaces_disallowed_chars():
    assert sanitize_account_id("dbid:user@host.com") == "user-host-com"


def test_compute_uid():
    assert compute_uid("dbid:abc") == "dbx-abc"


def test_write_config_roundtrips(tmp_path: Path):
    target = tmp_path / "pipeline.yaml"
    data = {
        "firebase_uid": "dbx-test",
        "firebase_service_account": "/tmp/sa.json",
        "dropbox_refresh_token": "tok",
        "dropbox_app_key": "key",
        "remarkable": {
            "diary_notebook_name": "Diary",
            "ssh_host": "rm.local",
            "ssh_user": "root",
        },
        "pi": {
            "ssh_host": "pi",
            "ssh_port": 2222,
            "ssh_user": "diary-sync",
            "ssh_key": "~/.ssh/id_ed25519_diary",
            "inbox_path": "~/diary/inbox",
        },
        "desktop": {"data_dir": "~/.local/share/tomboy-pipeline"},
        "tomboy": {
            "diary_notebook_name": "일기",
            "title_format": "{date} 리마커블([{page_uuid}])",
        },
        "ocr": {
            "backend": "local_vlm",
            "local_vlm": {
                "model_id": "Qwen/Qwen2.5-VL-7B-Instruct",
                "quantization": "4bit",
                "max_new_tokens": 2048,
                "system_prompt_path": "config/prompts/diary-ko.txt",
            },
        },
    }
    write_config(target, data)
    cfg = load_config(target)
    assert cfg.firebase_uid == "dbx-test"
    assert cfg.tomboy.diary_notebook_name == "일기"


def test_write_config_creates_parent(tmp_path: Path):
    target = tmp_path / "deep" / "pipeline.yaml"
    minimal = {
        "firebase_uid": "u",
        "firebase_service_account": "/x",
        "dropbox_refresh_token": "t",
        "dropbox_app_key": "k",
        "remarkable": {"diary_notebook_name": "D", "ssh_host": "h", "ssh_user": "u"},
        "pi": {
            "ssh_host": "h", "ssh_port": 22, "ssh_user": "u",
            "ssh_key": "k", "inbox_path": "i",
        },
        "ocr": {"backend": "local_vlm"},
    }
    write_config(target, minimal)
    assert target.exists()
