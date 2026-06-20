from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from desktop.lib.config import (
    Config,
    ConfigError,
    DEFAULT_FOLDER_ROUTES,
    load_config,
    load_config_from_string,
)


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


def test_route_for_default_folders():
    cfg = load_config_from_string(VALID_YAML)
    slip = cfg.tomboy.route_for("Slip-Notes")
    assert slip.notebook == "[0] Slip-Box"
    assert slip.split is True
    assert slip.labels == ("上", "下")

    notes = cfg.tomboy.route_for("Notes")
    assert notes.notebook == "기록"
    assert notes.split is False

    diary = cfg.tomboy.route_for("Diary")
    assert diary.split is False


def test_route_for_unknown_folder_falls_back_to_notes():
    cfg = load_config_from_string(VALID_YAML)
    r = cfg.tomboy.route_for("SomethingElse")
    assert r.split is False
    assert r.notebook == "기록"


def test_folders_override_in_config():
    yaml_text = VALID_YAML.replace(
        '''tomboy:
  diary_notebook_name: "일기"
  title_format: "{date} 리마커블([{page_uuid}])"
''',
        '''tomboy:
  folders:
    Slip-Notes:
      notebook: "내슬립박스"
      title_format: "{datetime} S {label}([{unit_key}])"
      split: true
      labels: ["A", "B"]
''',
    )
    cfg = load_config_from_string(yaml_text)
    slip = cfg.tomboy.route_for("Slip-Notes")
    assert slip.notebook == "내슬립박스"
    assert slip.labels == ("A", "B")
    # Folders not overridden still come from code defaults.
    assert cfg.tomboy.route_for("Notes").notebook == "기록"


def test_dropbox_keys_optional():
    yaml_text = VALID_YAML.replace('dropbox_refresh_token: "dummy-token"\n', "")
    yaml_text = yaml_text.replace('dropbox_app_key: "dummy-key"\n', "")
    cfg = load_config_from_string(yaml_text)  # must not raise
    assert cfg.dropbox_refresh_token == ""
    assert cfg.dropbox_app_key == ""


_BASE_YAML = textwrap.dedent("""\
    firebase_uid: "dbx-x"
    firebase_service_account: "/tmp/sa.json"
    remarkable: { diary_notebook_name: "Diary", ssh_host: "rm", ssh_user: "root" }
    pi: { ssh_host: "pi", ssh_port: 2222, ssh_user: "u", ssh_key: "~/.ssh/k", inbox_path: "~/in" }
    ocr:
      backend: "claude"
      claude: { service_url: "http://x", service_token: "t", effort: "high", system_prompt_path: "config/prompts/diary-ko.txt" }
""")


def _write_pipeline(tmp_path: Path) -> Path:
    (tmp_path / "config").mkdir()
    p = tmp_path / "config" / "pipeline.yaml"
    p.write_text(_BASE_YAML, encoding="utf-8")
    return p


def test_no_folders_overlay_keeps_defaults(tmp_path):
    cfg = load_config(_write_pipeline(tmp_path))
    assert cfg.tomboy.folders["Diary"].notebook == DEFAULT_FOLDER_ROUTES["Diary"].notebook
    assert cfg.tomboy.folders["Diary"].prompt == ""
    assert cfg.tomboy.default_prompt == ""


def test_folders_overlay_partial_override(tmp_path):
    p = _write_pipeline(tmp_path)
    (p.parent / "folders.yaml").write_text(textwrap.dedent("""\
        default_prompt: "기본 프롬프트"
        folders:
          Notes:
            prompt: "노트 전용 프롬프트"
          New-Folder:
            notebook: "새노트북"
            title_format: "{date} 신규([{unit_key}])"
            split: false
            prompt: "신규 프롬프트"
    """), encoding="utf-8")
    cfg = load_config(p)
    assert cfg.tomboy.default_prompt == "기본 프롬프트"
    assert cfg.tomboy.folders["Notes"].prompt == "노트 전용 프롬프트"
    assert cfg.tomboy.folders["Notes"].notebook == DEFAULT_FOLDER_ROUTES["Notes"].notebook
    assert cfg.tomboy.folders["New-Folder"].notebook == "새노트북"
    assert cfg.tomboy.folders["New-Folder"].prompt == "신규 프롬프트"


def test_prompt_for_precedence(tmp_path):
    p = _write_pipeline(tmp_path)
    (p.parent / "folders.yaml").write_text(textwrap.dedent("""\
        default_prompt: "DEF"
        folders:
          Diary: { prompt: "DIARY" }
          Notes: { prompt: "" }
    """), encoding="utf-8")
    cfg = load_config(p)
    assert cfg.tomboy.prompt_for("Diary") == "DIARY"
    assert cfg.tomboy.prompt_for("Notes") == "DEF"
    assert cfg.tomboy.prompt_for("Unknown") == "DEF"


def test_prompt_for_none_when_no_prompts(tmp_path):
    cfg = load_config(_write_pipeline(tmp_path))
    assert cfg.tomboy.prompt_for("Diary") is None


def test_empty_folders_yaml_is_a_noop(tmp_path):
    p = _write_pipeline(tmp_path)
    (p.parent / "folders.yaml").write_text("", encoding="utf-8")
    cfg = load_config(p)
    assert cfg.tomboy.default_prompt == ""
    assert cfg.tomboy.folders["Diary"].prompt == ""
