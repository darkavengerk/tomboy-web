from __future__ import annotations

from pathlib import Path

import pytest

from desktop.lib.config import Config, ConfigError, load_config, load_config_from_string


VALID_YAML = """
firebase_uid: "dbx-test-uid"
firebase_service_account: "/tmp/sa.json"
dropbox_refresh_token: "dummy-token"
dropbox_app_key: "dummy-key"

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
  title_format: "{date} 리마커블([{page_uuid}])"

ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
"""


def test_load_valid_yaml_returns_config():
    cfg = load_config_from_string(VALID_YAML)
    assert cfg.firebase_uid == "dbx-test-uid"
    assert cfg.tomboy.diary_notebook_name == "일기"
    assert cfg.ocr.backend == "local_vlm"


def test_data_dir_expands_user():
    cfg = load_config_from_string(VALID_YAML)
    assert "~" not in str(cfg.data_dir)
    assert cfg.data_dir.is_absolute()


def test_missing_required_key_raises():
    bad = VALID_YAML.replace('firebase_uid: "dbx-test-uid"\n', "")
    with pytest.raises(ConfigError) as exc:
        load_config_from_string(bad)
    assert "firebase_uid" in str(exc.value)


def test_missing_nested_key_raises():
    bad = VALID_YAML.replace('  ssh_host: "rm.local"\n', "")
    with pytest.raises(ConfigError) as exc:
        load_config_from_string(bad)
    assert "remarkable.ssh_host" in str(exc.value)


def test_empty_dict_raises():
    with pytest.raises(ConfigError):
        Config.from_dict({})


def test_default_title_format_applied():
    minimal = VALID_YAML.replace(
        '  title_format: "{date} 리마커블([{page_uuid}])"\n', ""
    )
    cfg = load_config_from_string(minimal)
    assert cfg.tomboy.title_format == "{date} 리마커블([{page_uuid}])"


def test_load_config_from_path(tmp_path: Path):
    p = tmp_path / "pipeline.yaml"
    p.write_text(VALID_YAML)
    cfg = load_config(p)
    assert cfg.pi.ssh_port == 2222


def test_example_yaml_is_round_trippable():
    s = Config.example_yaml()
    cfg = load_config_from_string(s)
    assert cfg.tomboy.diary_notebook_name == "일기"


def test_load_with_claude_backend():
    yaml_text = VALID_YAML.replace(
        """ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
""",
        """ocr:
  backend: "claude"
  claude:
    service_url: "http://localhost:7842"
    service_token: "tok"
    model: ""
    effort: "high"
    system_prompt_path: "config/prompts/diary-ko.txt"
""",
    )
    cfg = load_config_from_string(yaml_text)
    assert cfg.ocr.backend == "claude"
    assert cfg.ocr.claude is not None
    assert cfg.ocr.claude.service_url == "http://localhost:7842"
    assert cfg.ocr.claude.service_token == "tok"
    assert cfg.ocr.claude.model == ""
    assert cfg.ocr.claude.effort == "high"
    assert cfg.ocr.claude.system_prompt_path == "config/prompts/diary-ko.txt"
    # local_vlm 서브섹션 없어도 OK
    assert cfg.ocr.local_vlm is None


def test_load_with_claude_backend_missing_subsection_fails():
    yaml_text = VALID_YAML.replace(
        """ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
""",
        """ocr:
  backend: "claude"
""",
    )
    with pytest.raises(ConfigError):
        load_config_from_string(yaml_text)


def test_example_yaml_defaults_to_claude():
    yaml_text = Config.example_yaml()
    assert 'backend: "claude"' in yaml_text
    assert "claude:" in yaml_text
    assert "service_url:" in yaml_text
    assert "local_vlm:" in yaml_text  # 두 섹션 모두 보존
