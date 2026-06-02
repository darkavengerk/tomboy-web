"""s3_ocr backend dispatch tests. Verify the controller routes to the
correct backend with the correct kwargs based on cfg.ocr.backend."""
from __future__ import annotations

from dataclasses import replace
from unittest.mock import MagicMock, patch

import pytest

# 본 헬퍼는 Step 3에서 추출됨
from desktop.stages.s3_ocr import _build_backend
from desktop.lib.config import load_config_from_string


# Task 4 test_config.py와 동일한 패턴의 minimal VALID_YAML
_BASE_YAML = """
firebase_uid: "dbx-test-uid"
firebase_service_account: "/tmp/sa.json"
dropbox_refresh_token: "tok"
dropbox_app_key: "key"

remarkable:
  diary_notebook_name: "Diary"
  ssh_host: "rm.local"
  ssh_user: "root"

pi:
  ssh_host: "pi.example.com"
  ssh_port: 2222
  ssh_user: "diary-sync"
  ssh_key: "~/.ssh/id_ed25519_diary"
  inbox_path: "~/diary/inbox"

desktop:
  data_dir: "~/.local/share/tomboy-pipeline"

tomboy:
  diary_notebook_name: "일기"
  title_format: "{date}"
"""


_LOCAL_VLM_OCR = """\
ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
"""


_CLAUDE_OCR = """\
ocr:
  backend: "claude"
  claude:
    service_url: "http://localhost:7842"
    service_token: "tok"
    model: ""
    effort: "high"
    system_prompt_path: "config/prompts/diary-ko.txt"
"""


def test_build_backend_dispatches_to_local_vlm():
    cfg = load_config_from_string(_BASE_YAML + _LOCAL_VLM_OCR)
    captured: dict = {}

    def fake_get_backend(name, **kw):
        captured["name"] = name
        captured["kw"] = kw
        return MagicMock()

    with patch("desktop.stages.s3_ocr.get_backend", fake_get_backend):
        backend = _build_backend(cfg)

    assert captured["name"] == "local_vlm"
    assert captured["kw"] == {
        "model_id": "Qwen/Qwen2.5-VL-7B-Instruct",
        "quantization": "4bit",
        "max_new_tokens": 2048,
        "system_prompt_path": "config/prompts/diary-ko.txt",
    }
    assert backend is not None


def test_build_backend_dispatches_to_claude():
    cfg = load_config_from_string(_BASE_YAML + _CLAUDE_OCR)
    captured: dict = {}

    def fake_get_backend(name, **kw):
        captured["name"] = name
        captured["kw"] = kw
        return MagicMock()

    with patch("desktop.stages.s3_ocr.get_backend", fake_get_backend):
        backend = _build_backend(cfg)

    assert captured["name"] == "claude"
    assert captured["kw"] == {
        "service_url": "http://localhost:7842",
        "service_token": "tok",
        "model": "",
        "effort": "high",
        "system_prompt_path": "config/prompts/diary-ko.txt",
    }
    assert backend is not None


def test_build_backend_unknown_raises():
    """Backend 값이 'claude'도 'local_vlm'도 아니면 RuntimeError."""
    # load_config_from_string은 OcrConfig.from_dict에서 unknown backend 서브섹션 검증을
    # 하지 않으므로, 여기서는 cfg를 dataclasses.replace로 직접 조작해 _build_backend만 테스트.
    cfg = load_config_from_string(_BASE_YAML + _LOCAL_VLM_OCR)
    bad_ocr = replace(cfg.ocr, backend="unknown")
    bad_cfg = replace(cfg, ocr=bad_ocr)
    with pytest.raises(RuntimeError, match="Unsupported OCR backend"):
        _build_backend(bad_cfg)
