# reMarkable Diary OCR Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert handwritten diary pages drawn on a reMarkable tablet into Tomboy notes (text + image-link) via a 3-machine pipeline (rM → Pi → desktop OCR → Firestore).

**Architecture:** Five sibling milestones (M0 foundation → M4 tools). The desktop pipeline is composed of 4 sequentially-run stages (`s1_fetch` → `s2_prepare` → `s3_ocr` → `s4_write`) plus shared `lib/` modules. Each stage is independently runnable (`python -m pipeline.desktop.stages.<name>`) and writes to its own JSON state file. Firestore is the only first-party write target; Tomboy's Dropbox channel picks up notes naturally on the user's next manual sync.

**Tech Stack:** Python 3.11+, pytest (TDD), pyyaml, dropbox SDK, firebase-admin, Pillow, rmrl (or equivalent .rm rasterizer), transformers + bitsandbytes (Qwen2.5-VL-7B 4-bit). Pi side uses Python + systemd. rM side uses shell + cron.

**Spec:** `docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`

**Implementation constraints (user-mandated):**

1. **TDD throughout.** Every code-bearing task starts with a failing test, then minimal implementation, then green. Doc-only tasks (T10, T19) are exempt and explicitly marked.
2. **Subagent dispatch (sonnet).** Tasks marked `[parallel-eligible]` can be dispatched to fresh sonnet subagents in parallel after their prerequisites complete. Tasks marked `[sequential]` must run alone because they touch shared interfaces or sequence-dependent state.

---

## File Structure

**New (everything under `pipeline/` is new — sibling of `app/` and `bridge/`):**

```
pipeline/
├── README.md
├── pyproject.toml
├── .gitignore
├── conftest.py                              # shared pytest fixtures
├── config/
│   ├── pipeline.example.yaml               # committed template
│   └── prompts/
│       └── diary-ko.txt                    # VLM system prompt
├── pi/
│   ├── __init__.py
│   ├── inbox_watcher.py
│   ├── README.md                           # WAN SSH hardening guide
│   └── deploy/
│       ├── pi-watcher.service
│       └── pi-watcher.timer
├── desktop/
│   ├── __init__.py
│   ├── run_pipeline.py
│   ├── bootstrap.py
│   ├── stages/
│   │   ├── __init__.py
│   │   ├── s1_fetch.py
│   │   ├── s2_prepare.py
│   │   ├── s3_ocr.py
│   │   └── s4_write.py
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── extract_corrections.py
│   │   └── segment_lines.py
│   ├── ocr_backends/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   └── local_vlm.py
│   ├── lib/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   ├── log.py
│   │   ├── state.py
│   │   ├── tomboy_payload.py
│   │   ├── firestore_client.py
│   │   └── dropbox_uploader.py
│   └── deploy/
│       ├── desktop-pipeline.service
│       └── desktop-pipeline.timer
└── tests/
    ├── __init__.py
    ├── lib/
    │   ├── test_config.py
    │   ├── test_state.py
    │   ├── test_log.py
    │   └── test_tomboy_payload.py
    ├── ocr_backends/
    │   └── test_base.py
    ├── stages/
    │   ├── test_s1_fetch.py
    │   ├── test_s2_prepare.py
    │   ├── test_s3_ocr.py
    │   └── test_s4_write.py
    ├── pi/
    │   └── test_inbox_watcher.py
    └── fixtures/
        ├── sample-metadata.json
        ├── sample-page.png
        └── golden-firestore-doc.json
```

**Modified:**
- `/.gitignore` — ignore `pipeline/config/pipeline.yaml` and pipeline data dirs (host-local).
- `CLAUDE.md` — append a `## reMarkable diary OCR pipeline` section in T19.

---

## Dependency / Parallelization Map

```
T0 (scaffolding)
 ├─ T1, T2, T3, T4 [parallel]
 │   ├─ T5 (after T1)        ─┐
 │   ├─ T7 (after T1)         │
 │   ├─ T9 (after T0)         │
 │   └─ T13 (after T4)        │
 ├─ T6 (after T1, T5)         ├─ T8 (after T1, T6, T7)
 ├─ T10 (after T9, docs only) │
 ├─ T11 (after T1,T2,T3) [parallel with T12]
 ├─ T12 (after T1,T2,T3) [parallel with T11]
 ├─ T14 (after T2,T3,T4,T13)
 ├─ T15 (after T2,T3,T5,T6,T7) — critical, sequential
 ├─ T16 (after T11,T12,T14,T15)
 ├─ T17 (after T6) [parallel with T18]
 ├─ T18 (after T2) [parallel with T17]
 └─ T19 (final, docs)
```

Subagent dispatch waves (recommended):

- **Wave A** (after T0): T1, T2, T3, T4 in parallel.
- **Wave B** (after Wave A): T5 + T7 + T9 in parallel.
- **Wave C** (after Wave B): T6 + T11 + T12 in parallel.
- **Wave D** (after Wave C): T8 + T13 in parallel.
- **Wave E** (after Wave D): T14 alone (depends on T13).
- **Wave F** (after Wave E): T15 alone (the heavy one — cleanest dispatched solo for review).
- **Wave G**: T16 alone, then T17 + T18 in parallel, then T19.

---

## Task 0: Project scaffolding

**Goal:** Create the `pipeline/` directory tree with `pyproject.toml`, `.gitignore`, `conftest.py`, an empty README, and the package init files. Make `pytest` runnable (and pass with zero tests). [sequential — no prereqs]

**Files:**
- Create: `pipeline/pyproject.toml`
- Create: `pipeline/.gitignore`
- Create: `pipeline/conftest.py`
- Create: `pipeline/README.md`
- Create: `pipeline/desktop/__init__.py`, `pipeline/desktop/lib/__init__.py`, `pipeline/desktop/stages/__init__.py`, `pipeline/desktop/tools/__init__.py`, `pipeline/desktop/ocr_backends/__init__.py`, `pipeline/pi/__init__.py`, `pipeline/tests/__init__.py`, `pipeline/tests/lib/__init__.py` (each empty)
- Modify: `/.gitignore` (root) — add `pipeline/config/pipeline.yaml`

**Acceptance Criteria:**
- [ ] `cd pipeline && python -m pytest` exits 0 (no tests collected, OK)
- [ ] `cd pipeline && python -m pytest --collect-only` shows `0 tests`
- [ ] `pipeline/config/pipeline.yaml` is gitignored
- [ ] `from pipeline.desktop.lib import config` does not raise (the import target doesn't exist yet, but the package paths resolve — this is verified later in T1)

**Verify:** `cd pipeline && python -m pytest -v` → `0 passed`

**Steps:**

- [ ] **Step 1: Create `pipeline/pyproject.toml`**

```toml
[project]
name = "tomboy-pipeline"
version = "0.1.0"
description = "reMarkable diary OCR pipeline for the Tomboy web app"
requires-python = ">=3.11"
dependencies = [
    "pyyaml>=6.0",
]

[project.optional-dependencies]
firebase = ["firebase-admin>=6.4"]
dropbox = ["dropbox>=12.0"]
prepare = ["Pillow>=10.0", "rmrl>=0.2.0"]
vlm = [
    "torch>=2.1",
    "transformers>=4.45",
    "bitsandbytes>=0.43",
    "accelerate>=0.30",
]
dev = [
    "pytest>=7.4",
    "pytest-mock>=3.12",
    "ruff>=0.4",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
pythonpath = ["."]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["desktop*", "pi*"]
```

- [ ] **Step 2: Create `pipeline/.gitignore`**

```gitignore
# Local secrets — generated by bootstrap.py
config/pipeline.yaml

# Python
__pycache__/
*.py[cod]
.pytest_cache/
.ruff_cache/
*.egg-info/
.venv/
build/
dist/

# Local data dirs (some users may symlink XDG paths into here)
data/
logs/
state/
```

- [ ] **Step 3: Create `pipeline/conftest.py`**

```python
"""Shared pytest fixtures for the pipeline test suite."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A temporary data root mimicking the runtime layout."""
    for sub in ("raw", "png", "ocr", "state", "logs", "corrections"):
        (tmp_path / sub).mkdir()
    return tmp_path


@pytest.fixture
def sample_metadata() -> dict:
    """A minimal rM .metadata JSON shape used across tests."""
    return {
        "deleted": False,
        "lastModified": "1715337600000",  # 2024-05-10T12:00:00Z in ms epoch
        "metadatamodified": False,
        "modified": False,
        "parent": "diary-folder-uuid",
        "pinned": False,
        "synced": True,
        "type": "DocumentType",
        "version": 1,
        "visibleName": "Diary Page 2024-05-10",
    }


@pytest.fixture
def sample_page_uuid() -> str:
    return "abc-123-def-456"
```

- [ ] **Step 4: Create empty package init files**

Create empty files (just `pass` is fine, but truly empty works for Python packages):

```
pipeline/desktop/__init__.py
pipeline/desktop/lib/__init__.py
pipeline/desktop/stages/__init__.py
pipeline/desktop/tools/__init__.py
pipeline/desktop/ocr_backends/__init__.py
pipeline/pi/__init__.py
pipeline/tests/__init__.py
pipeline/tests/lib/__init__.py
pipeline/tests/ocr_backends/__init__.py
pipeline/tests/stages/__init__.py
pipeline/tests/pi/__init__.py
```

Each file: empty (zero bytes).

- [ ] **Step 5: Create `pipeline/README.md`**

```markdown
# Tomboy reMarkable Diary OCR Pipeline

A 3-machine pipeline (reMarkable tablet → Raspberry Pi → desktop) that converts handwritten diary pages into Tomboy notes via OCR.

See [the design spec](../docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md) for the full architecture.

## Quick start

1. **Bootstrap (desktop, one-time)**: `python -m desktop.bootstrap` — walks you through Dropbox auth, Firebase service-account selection, and writes `config/pipeline.yaml`.
2. **Install the Pi inbox** — see `pi/README.md`.
3. **Install the rM-side push script** — see `pi/README.md` § "rM-side push".
4. **Run the pipeline manually**: `python -m desktop.run_pipeline`.
5. (Later) **Enable systemd timer**: `systemctl --user enable --now desktop-pipeline.timer`.

## Per-stage debugging

Each stage is independently runnable:

\`\`\`bash
python -m desktop.stages.s1_fetch
python -m desktop.stages.s2_prepare --uuid <rm-page-uuid>
python -m desktop.stages.s3_ocr --uuid <rm-page-uuid>
python -m desktop.stages.s4_write --uuid <rm-page-uuid>
\`\`\`

State files in `~/.local/share/tomboy-pipeline/state/` track which uuids each stage has processed; pass `--force <uuid>` to override.
```

- [ ] **Step 6: Update root `.gitignore`**

Append to `/var/home/umayloveme/workspace/tomboy-web/.gitignore` (root):

```gitignore

# Pipeline (rM → Pi → desktop OCR → Tomboy) — see pipeline/README.md
pipeline/config/pipeline.yaml
pipeline/data/
pipeline/logs/
pipeline/state/
pipeline/.venv/
pipeline/__pycache__/
```

- [ ] **Step 7: Create venv and verify**

```bash
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
python -m pytest -v
```

Expected output:

```
collected 0 items
======== no tests ran in 0.0Xs ========
```

- [ ] **Step 8: Commit**

```bash
git add pipeline/ .gitignore
git commit -m "feat(pipeline): scaffold project with pyproject + pytest layout"
```

---

## Task 1: `lib/config.py` — YAML config loader  [parallel-eligible after T0]

**Goal:** Pure data layer: load `config/pipeline.yaml` into a typed dataclass tree, validate required keys, raise clear errors on missing/malformed entries. No side effects beyond reading the file.

**Files:**
- Create: `pipeline/desktop/lib/config.py`
- Create: `pipeline/tests/lib/test_config.py`
- Create: `pipeline/config/pipeline.example.yaml`

**Acceptance Criteria:**
- [ ] `load_config(path)` returns a `Config` dataclass when given a valid YAML file
- [ ] Missing required key raises `ConfigError` naming the missing path (e.g. `tomboy.diary_notebook_name`)
- [ ] `Config.from_dict({})` raises `ConfigError`
- [ ] Defaults applied: `tomboy.diary_notebook_name` defaults to `'일기'`, `tomboy.title_format` defaults to `'{date} 리마커블([{page_uuid}])'`, `desktop.data_dir` defaults to `'~/.local/share/tomboy-pipeline'` (expanded via `Path.expanduser` only when accessed via `Config.data_dir`)
- [ ] `Config.example_yaml()` returns a string round-trippable through `load_config_from_string`
- [ ] `pipeline/config/pipeline.example.yaml` exists and parses successfully

**Verify:** `cd pipeline && python -m pytest tests/lib/test_config.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/lib/test_config.py`:

```python
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
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_config.py -v
```

Expected: ImportError / ModuleNotFoundError on `desktop.lib.config`.

- [ ] **Step 3: Implement `desktop/lib/config.py`**

Create `pipeline/desktop/lib/config.py`:

```python
"""YAML config loader for the diary pipeline.

Single config file at ``pipeline/config/pipeline.yaml`` (gitignored).
Generated by ``desktop.bootstrap`` on first run; thereafter read-only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    """Raised when the config file is missing keys or malformed."""


def _require(d: dict, key: str, path: str) -> Any:
    if key not in d:
        raise ConfigError(f"Missing required config key: {path}")
    return d[key]


@dataclass(frozen=True)
class RemarkableConfig:
    diary_notebook_name: str
    ssh_host: str
    ssh_user: str

    @classmethod
    def from_dict(cls, d: dict) -> RemarkableConfig:
        return cls(
            diary_notebook_name=_require(d, "diary_notebook_name", "remarkable.diary_notebook_name"),
            ssh_host=_require(d, "ssh_host", "remarkable.ssh_host"),
            ssh_user=_require(d, "ssh_user", "remarkable.ssh_user"),
        )


@dataclass(frozen=True)
class PiConfig:
    ssh_host: str
    ssh_port: int
    ssh_user: str
    ssh_key: str
    inbox_path: str

    @classmethod
    def from_dict(cls, d: dict) -> PiConfig:
        return cls(
            ssh_host=_require(d, "ssh_host", "pi.ssh_host"),
            ssh_port=int(_require(d, "ssh_port", "pi.ssh_port")),
            ssh_user=_require(d, "ssh_user", "pi.ssh_user"),
            ssh_key=_require(d, "ssh_key", "pi.ssh_key"),
            inbox_path=_require(d, "inbox_path", "pi.inbox_path"),
        )


@dataclass(frozen=True)
class TomboyConfig:
    diary_notebook_name: str = "일기"
    title_format: str = "{date} 리마커블([{page_uuid}])"

    @classmethod
    def from_dict(cls, d: dict) -> TomboyConfig:
        return cls(
            diary_notebook_name=d.get("diary_notebook_name", "일기"),
            title_format=d.get("title_format", "{date} 리마커블([{page_uuid}])"),
        )


@dataclass(frozen=True)
class LocalVlmConfig:
    model_id: str
    quantization: str
    max_new_tokens: int
    system_prompt_path: str


@dataclass(frozen=True)
class OcrConfig:
    backend: str
    local_vlm: LocalVlmConfig | None = None

    @classmethod
    def from_dict(cls, d: dict) -> OcrConfig:
        backend = _require(d, "backend", "ocr.backend")
        local_vlm = None
        if "local_vlm" in d:
            v = d["local_vlm"]
            local_vlm = LocalVlmConfig(
                model_id=_require(v, "model_id", "ocr.local_vlm.model_id"),
                quantization=v.get("quantization", "4bit"),
                max_new_tokens=int(v.get("max_new_tokens", 2048)),
                system_prompt_path=v.get("system_prompt_path", "config/prompts/diary-ko.txt"),
            )
        return cls(backend=backend, local_vlm=local_vlm)


@dataclass(frozen=True)
class DesktopConfig:
    data_dir_raw: str = "~/.local/share/tomboy-pipeline"

    @classmethod
    def from_dict(cls, d: dict) -> DesktopConfig:
        return cls(data_dir_raw=d.get("data_dir", "~/.local/share/tomboy-pipeline"))


@dataclass(frozen=True)
class Config:
    firebase_uid: str
    firebase_service_account: str
    dropbox_refresh_token: str
    dropbox_app_key: str
    remarkable: RemarkableConfig
    pi: PiConfig
    desktop: DesktopConfig
    tomboy: TomboyConfig
    ocr: OcrConfig

    @property
    def data_dir(self) -> Path:
        return Path(self.desktop.data_dir_raw).expanduser().resolve()

    @classmethod
    def from_dict(cls, d: dict) -> Config:
        if not d:
            raise ConfigError("Config is empty")
        return cls(
            firebase_uid=_require(d, "firebase_uid", "firebase_uid"),
            firebase_service_account=_require(d, "firebase_service_account", "firebase_service_account"),
            dropbox_refresh_token=_require(d, "dropbox_refresh_token", "dropbox_refresh_token"),
            dropbox_app_key=_require(d, "dropbox_app_key", "dropbox_app_key"),
            remarkable=RemarkableConfig.from_dict(_require(d, "remarkable", "remarkable")),
            pi=PiConfig.from_dict(_require(d, "pi", "pi")),
            desktop=DesktopConfig.from_dict(d.get("desktop", {})),
            tomboy=TomboyConfig.from_dict(d.get("tomboy", {})),
            ocr=OcrConfig.from_dict(_require(d, "ocr", "ocr")),
        )

    @staticmethod
    def example_yaml() -> str:
        return _EXAMPLE_YAML


_EXAMPLE_YAML = """\
# Generated by `python -m desktop.bootstrap`. Do not edit by hand unless
# you know what you're doing — bootstrap is idempotent.

firebase_uid: "dbx-REPLACE_ME"
firebase_service_account: "/path/to/firebase-sa.json"
dropbox_refresh_token: "REPLACE_ME"
dropbox_app_key: "REPLACE_ME"

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


def load_config_from_string(s: str) -> Config:
    data = yaml.safe_load(s) or {}
    return Config.from_dict(data)


def load_config(path: Path | str) -> Config:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}")
    return load_config_from_string(p.read_text(encoding="utf-8"))
```

- [ ] **Step 4: Create `pipeline/config/pipeline.example.yaml`**

```bash
mkdir -p pipeline/config
```

Then write the file with content from `_EXAMPLE_YAML` above (same content).

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_config.py -v
```

Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/lib/config.py pipeline/tests/lib/test_config.py pipeline/config/pipeline.example.yaml
git commit -m "feat(pipeline): add lib/config.py YAML loader with typed dataclass tree"
```

---

## Task 2: `lib/state.py` — per-stage JSON state files  [parallel-eligible after T0]

**Goal:** Atomic load/update/save of per-stage JSON state files. Each stage owns its own file under `<data_dir>/state/<stage>.json`. Concurrent writes from one stage are serialized via a file lock; cross-stage writes are independent.

**Files:**
- Create: `pipeline/desktop/lib/state.py`
- Create: `pipeline/tests/lib/test_state.py`

**Acceptance Criteria:**
- [ ] `StateFile(path)` creates the parent dir if missing
- [ ] `state.read()` returns `{}` for a file that doesn't exist
- [ ] `state.write(d)` writes atomically (temp file + rename)
- [ ] `state.update({...})` merges keys without losing existing entries
- [ ] `state.contains(uuid)` is `True` after a write that includes the uuid
- [ ] `state.remove(uuid)` deletes the entry; subsequent `contains` is `False`
- [ ] Two `StateFile` instances pointing at the same path see each other's writes (read-after-write consistency on the local filesystem)
- [ ] An interrupted write (simulated by crashing between write and rename) leaves the previous file intact

**Verify:** `cd pipeline && python -m pytest tests/lib/test_state.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/lib/test_state.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

import pytest

from desktop.lib.state import StateFile


def test_read_returns_empty_when_file_missing(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    assert s.read() == {}


def test_write_and_read_roundtrip(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {"foo": 1}})
    assert s.read() == {"abc": {"foo": 1}}


def test_write_creates_parent_dir(tmp_path: Path):
    s = StateFile(tmp_path / "nested" / "deeper" / "stage.json")
    s.write({"k": "v"})
    assert (tmp_path / "nested" / "deeper" / "stage.json").exists()


def test_update_merges_keys(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"a": 1, "b": 2})
    s.update({"b": 20, "c": 30})
    assert s.read() == {"a": 1, "b": 20, "c": 30}


def test_contains(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}})
    assert s.contains("abc")
    assert not s.contains("xyz")


def test_remove(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}, "xyz": {}})
    s.remove("abc")
    assert not s.contains("abc")
    assert s.contains("xyz")


def test_remove_missing_is_noop(tmp_path: Path):
    s = StateFile(tmp_path / "stage.json")
    s.write({"abc": {}})
    s.remove("nonexistent")  # should not raise
    assert s.contains("abc")


def test_atomic_write_uses_temp_file(tmp_path: Path):
    """Verify write goes via a temp file, not directly to the target."""
    target = tmp_path / "stage.json"
    s = StateFile(target)
    s.write({"a": 1})
    # No leftover .tmp file after a successful write
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []


def test_two_instances_share_state(tmp_path: Path):
    s1 = StateFile(tmp_path / "stage.json")
    s2 = StateFile(tmp_path / "stage.json")
    s1.write({"a": 1})
    assert s2.read() == {"a": 1}


def test_corrupt_json_raises(tmp_path: Path):
    p = tmp_path / "stage.json"
    p.write_text("{not valid json")
    s = StateFile(p)
    with pytest.raises(json.JSONDecodeError):
        s.read()
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_state.py -v
```

Expected: ImportError on `desktop.lib.state`.

- [ ] **Step 3: Implement `desktop/lib/state.py`**

```python
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
            # Clean up the temp file on failure
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
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_state.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/lib/state.py pipeline/tests/lib/test_state.py
git commit -m "feat(pipeline): add lib/state.py atomic per-stage JSON state files"
```

---

## Task 3: `lib/log.py` — JSONL + human-readable logging  [parallel-eligible after T0]

**Goal:** Tiny logging façade that writes one JSONL line per event to `<data_dir>/logs/<stage>.jsonl` AND a human-readable line to `<data_dir>/logs/<stage>.log`. No external logging framework — simple `print`-equivalents over context-managed file handles.

**Files:**
- Create: `pipeline/desktop/lib/log.py`
- Create: `pipeline/tests/lib/test_log.py`

**Acceptance Criteria:**
- [ ] `StageLogger("s1_fetch", data_dir).info("ok", uuid="abc")` appends one line to `logs/s1_fetch.jsonl` (parseable as JSON) and one human-readable line to `logs/s1_fetch.log`
- [ ] JSONL line includes `ts`, `stage`, `level`, `event`, plus the kwargs
- [ ] Human-readable line format: `[<ts>] <stage> <level> <event> <kwargs as k=v>`
- [ ] `error()` works the same; level field is `error`
- [ ] Logger creates parent dir if missing
- [ ] Two log calls produce two lines (no overwriting)

**Verify:** `cd pipeline && python -m pytest tests/lib/test_log.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/lib/test_log.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

from desktop.lib.log import StageLogger


def test_info_writes_jsonl_line(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("fetched", uuid="abc-123", bytes=100)
    jsonl = (tmp_path / "logs" / "s1_fetch.jsonl").read_text().strip()
    record = json.loads(jsonl)
    assert record["stage"] == "s1_fetch"
    assert record["level"] == "info"
    assert record["event"] == "fetched"
    assert record["uuid"] == "abc-123"
    assert record["bytes"] == 100
    assert "ts" in record


def test_info_writes_human_readable_line(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("fetched", uuid="abc-123")
    line = (tmp_path / "logs" / "s1_fetch.log").read_text().strip()
    assert "s1_fetch" in line
    assert "info" in line
    assert "fetched" in line
    assert "uuid=abc-123" in line


def test_error_level(tmp_path: Path):
    log = StageLogger("s2_prepare", tmp_path)
    log.error("convert_failed", uuid="abc", reason="rmrl crashed")
    jsonl = (tmp_path / "logs" / "s2_prepare.jsonl").read_text().strip()
    record = json.loads(jsonl)
    assert record["level"] == "error"
    assert record["reason"] == "rmrl crashed"


def test_multiple_calls_append(tmp_path: Path):
    log = StageLogger("s1_fetch", tmp_path)
    log.info("a", uuid="1")
    log.info("b", uuid="2")
    lines = (tmp_path / "logs" / "s1_fetch.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["event"] == "a"
    assert json.loads(lines[1])["event"] == "b"


def test_creates_parent_dir(tmp_path: Path):
    nested = tmp_path / "deep" / "nested"
    log = StageLogger("s1", nested)
    log.info("ok")
    assert (nested / "logs" / "s1.jsonl").exists()
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_log.py -v
```

Expected: ImportError on `desktop.lib.log`.

- [ ] **Step 3: Implement `desktop/lib/log.py`**

```python
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
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_log.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/lib/log.py pipeline/tests/lib/test_log.py
git commit -m "feat(pipeline): add lib/log.py JSONL + human-readable stage logger"
```

---

## Task 4: `ocr_backends/base.py` — pluggable OCR interface  [parallel-eligible after T0]

**Goal:** Define the `OCRBackend` ABC, the `OCRResult` dataclass, and a tiny registry/factory that instantiates a backend by name. No concrete backend implementation in this task — just the contract.

**Files:**
- Create: `pipeline/desktop/ocr_backends/base.py`
- Create: `pipeline/tests/ocr_backends/__init__.py` (empty)
- Create: `pipeline/tests/ocr_backends/test_base.py`

**Acceptance Criteria:**
- [ ] `OCRResult` is a frozen dataclass with `text: str`, `model: str`, `prompt_hash: str`, `ts: datetime`
- [ ] `OCRBackend` is an ABC with abstract method `ocr(image_path: Path) -> OCRResult`
- [ ] `register_backend("name")(cls)` decorator registers a subclass
- [ ] `get_backend("name", **kwargs)` instantiates the registered class
- [ ] `get_backend("missing")` raises `KeyError` naming the backend
- [ ] A test stub backend can be registered and instantiated end-to-end

**Verify:** `cd pipeline && python -m pytest tests/ocr_backends/test_base.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/ocr_backends/test_base.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from desktop.ocr_backends.base import (
    OCRBackend,
    OCRResult,
    get_backend,
    register_backend,
)


def test_ocr_result_is_frozen():
    r = OCRResult(text="hi", model="m", prompt_hash="h", ts=datetime.now(timezone.utc))
    with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
        r.text = "no"  # type: ignore[misc]


def test_register_and_instantiate_backend():
    @register_backend("test_stub")
    class StubBackend(OCRBackend):
        def ocr(self, image_path: Path) -> OCRResult:
            return OCRResult(
                text="stub", model="stub", prompt_hash="0", ts=datetime.now(timezone.utc)
            )

    backend = get_backend("test_stub")
    assert isinstance(backend, OCRBackend)
    result = backend.ocr(Path("/tmp/fake.png"))
    assert result.text == "stub"


def test_get_backend_missing_raises():
    with pytest.raises(KeyError) as exc:
        get_backend("does_not_exist")
    assert "does_not_exist" in str(exc.value)


def test_register_backend_with_kwargs():
    @register_backend("test_with_args")
    class ArgBackend(OCRBackend):
        def __init__(self, model_id: str) -> None:
            self.model_id = model_id

        def ocr(self, image_path: Path) -> OCRResult:
            return OCRResult(
                text=self.model_id, model=self.model_id, prompt_hash="0",
                ts=datetime.now(timezone.utc),
            )

    backend = get_backend("test_with_args", model_id="my-model")
    result = backend.ocr(Path("/tmp/fake.png"))
    assert result.text == "my-model"


def test_abstract_backend_cannot_instantiate():
    with pytest.raises(TypeError):
        OCRBackend()  # type: ignore[abstract]
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && mkdir -p tests/ocr_backends && touch tests/ocr_backends/__init__.py
python -m pytest tests/ocr_backends/test_base.py -v
```

Expected: ImportError on `desktop.ocr_backends.base`.

- [ ] **Step 3: Implement `desktop/ocr_backends/base.py`**

```python
"""Pluggable OCR backend interface.

Concrete backends (``local_vlm``, future Clova/Google/TrOCR) live in
sibling modules and self-register via ``@register_backend("name")``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, TypeVar


@dataclass(frozen=True)
class OCRResult:
    text: str
    model: str
    prompt_hash: str
    ts: datetime


class OCRBackend(ABC):
    @abstractmethod
    def ocr(self, image_path: Path) -> OCRResult:
        """Run OCR on a single image. Implementations may be slow (loads ML
        models on first call) — callers should batch and reuse instances."""


_REGISTRY: dict[str, type[OCRBackend]] = {}

T = TypeVar("T", bound=OCRBackend)


def register_backend(name: str) -> Callable[[type[T]], type[T]]:
    def deco(cls: type[T]) -> type[T]:
        _REGISTRY[name] = cls
        return cls

    return deco


def get_backend(name: str, **kwargs: Any) -> OCRBackend:
    if name not in _REGISTRY:
        raise KeyError(f"OCR backend not registered: {name!r}")
    return _REGISTRY[name](**kwargs)


def list_backends() -> list[str]:
    return sorted(_REGISTRY.keys())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/ocr_backends/test_base.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/ocr_backends/base.py pipeline/tests/ocr_backends/
git commit -m "feat(pipeline): add OCRBackend ABC + registry"
```

---

## Task 5: `lib/tomboy_payload.py` — Firestore document builder  [sequential after T1]

**Goal:** Build the exact `FirestoreNotePayload` shape the existing app expects (see `app/src/lib/sync/firebase/notePayload.ts` and `app/src/lib/core/note.ts`). Pure functions: in → out, no side effects, no Firestore SDK calls. Includes a Tomboy-format date formatter, the `<note-content>` XML producer, the title formatter, and a 900 KB byte-size guard.

**Files:**
- Create: `pipeline/desktop/lib/tomboy_payload.py`
- Create: `pipeline/tests/lib/test_tomboy_payload.py`
- Create: `pipeline/tests/fixtures/golden-firestore-doc.json`

**Acceptance Criteria:**
- [ ] `format_tomboy_date(datetime)` produces `yyyy-MM-ddTHH:mm:ss.fffffffzzz` (7 fractional digits, timezone with colon)
- [ ] `build_note_content_xml(title, ocr_text, image_url)` produces the I7 body inside a `<note-content version="0.1">...</note-content>` wrapper, with proper XML escaping
- [ ] `build_payload(...)` returns a dict matching the golden fixture (modulo timestamps which are checked separately)
- [ ] Notebook is encoded as `system:notebook:<name>` in `tags`
- [ ] `uri` is `note://tomboy/<guid>`
- [ ] `deleted` is `False`
- [ ] Title format follows the configured pattern with `{date}` and `{page_uuid}` substituted
- [ ] Payload exceeding 900 KB raises `NotePayloadTooLargeError` with the byte length
- [ ] XML special characters in OCR text (`<`, `>`, `&`, `"`, `'`) are escaped

**Verify:** `cd pipeline && python -m pytest tests/lib/test_tomboy_payload.py -v` → all green

**Steps:**

- [ ] **Step 1: Read app's expected shape**

Cross-reference the implementer must read once before coding:

```
app/src/lib/sync/firebase/notePayload.ts  — FirestoreNotePayload type, MAX_FIRESTORE_NOTE_BYTES, NotePayloadTooLargeError
app/src/lib/core/note.ts                  — NoteData, NOTE_CONTENT_VERSION, formatTomboyDate, escapeXml
app/src/lib/core/noteArchiver.ts          — serializeNote (the full-XML format; we DON'T use this)
```

Key facts (also captured in spec §4.5):
- The Firestore doc has top-level `guid`, `uri`, `title`, `xmlContent`, `createDate`, `changeDate`, `metadataChangeDate`, `tags`, `deleted`.
- `xmlContent` is **only** the `<note-content>...</note-content>` block, not the full `.note` XML.
- Notebook = tag `system:notebook:<name>`.
- Date format example: `2024-05-10T12:00:00.0000000+00:00`.

- [ ] **Step 2: Write failing tests**

Create `pipeline/tests/lib/test_tomboy_payload.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from desktop.lib.tomboy_payload import (
    NotePayloadTooLargeError,
    build_note_content_xml,
    build_payload,
    format_tomboy_date,
)


def test_format_tomboy_date_utc():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    s = format_tomboy_date(dt)
    # Tomboy format: yyyy-MM-ddTHH:mm:ss.fffffffzzz (7 fractional digits)
    assert s.startswith("2024-05-10T12:00:00.")
    # Seven fractional digits after the dot
    frac = s.split(".")[1].split("+")[0].split("-")[0]
    assert len(frac) == 7
    # Timezone format with colon (zzz = +00:00)
    assert s.endswith("+00:00")


def test_format_tomboy_date_with_microseconds():
    dt = datetime(2024, 5, 10, 12, 0, 0, 123456, tzinfo=timezone.utc)
    s = format_tomboy_date(dt)
    # Microseconds 123456 -> 1234560 in 7-digit fractional
    assert ".1234560+" in s


def test_build_note_content_xml_basic():
    xml = build_note_content_xml(
        title="2024-05-10 리마커블([abc-123])",
        ocr_text="첫째줄\n둘째줄",
        image_url="https://example.com/page.png",
    )
    assert xml.startswith('<note-content version="0.1">')
    assert xml.endswith("</note-content>")
    assert "2024-05-10 리마커블([abc-123])" in xml
    assert "첫째줄" in xml
    assert "둘째줄" in xml
    assert "---" in xml
    assert "https://example.com/page.png" in xml


def test_build_note_content_xml_escapes_special_chars():
    xml = build_note_content_xml(
        title="t",
        ocr_text="a < b & c > d \"e\"",
        image_url="https://example.com/p.png",
    )
    assert "&lt;" in xml
    assert "&gt;" in xml
    assert "&amp;" in xml
    assert "&quot;" in xml


def test_build_payload_shape():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    payload = build_payload(
        guid="11111111-2222-3333-4444-555555555555",
        page_uuid="abc-123",
        ocr_text="hello",
        image_url="https://example.com/p.png",
        notebook_name="일기",
        title_format="{date} 리마커블([{page_uuid}])",
        create_date=dt,
        change_date=dt,
    )
    assert payload["guid"] == "11111111-2222-3333-4444-555555555555"
    assert payload["uri"] == "note://tomboy/11111111-2222-3333-4444-555555555555"
    assert payload["title"] == "2024-05-10 리마커블([abc-123])"
    assert "<note-content" in payload["xmlContent"]
    assert payload["tags"] == ["system:notebook:일기"]
    assert payload["deleted"] is False
    assert "createDate" in payload
    assert "changeDate" in payload
    assert "metadataChangeDate" in payload


def test_build_payload_title_uses_format_and_date():
    dt = datetime(2025, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    payload = build_payload(
        guid="g",
        page_uuid="p",
        ocr_text="",
        image_url="",
        notebook_name="일기",
        title_format="다이어리 {date} (#{page_uuid})",
        create_date=dt,
        change_date=dt,
    )
    assert payload["title"] == "다이어리 2025-01-15 (#p)"


def test_build_payload_too_large_raises():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    huge = "x" * 1_000_000
    with pytest.raises(NotePayloadTooLargeError) as exc:
        build_payload(
            guid="g",
            page_uuid="p",
            ocr_text=huge,
            image_url="https://e.com/p.png",
            notebook_name="일기",
            title_format="{date}",
            create_date=dt,
            change_date=dt,
        )
    assert exc.value.byte_length > 900_000


def test_build_payload_first_line_matches_title():
    """xmlContent first line must equal the title field — Tomboy convention."""
    dt = datetime(2024, 5, 10, tzinfo=timezone.utc)
    p = build_payload(
        guid="g",
        page_uuid="abc",
        ocr_text="body",
        image_url="https://e.com/p.png",
        notebook_name="일기",
        title_format="{date} 리마커블([{page_uuid}])",
        create_date=dt,
        change_date=dt,
    )
    inner = p["xmlContent"].replace('<note-content version="0.1">', "").replace(
        "</note-content>", ""
    )
    first_line = inner.lstrip().splitlines()[0]
    assert first_line == p["title"]
```

- [ ] **Step 3: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_tomboy_payload.py -v
```

Expected: ImportError on `desktop.lib.tomboy_payload`.

- [ ] **Step 4: Implement `desktop/lib/tomboy_payload.py`**

```python
"""Build Firestore note documents matching the existing app's expected shape.

The pipeline only PRODUCES documents; it never parses them back. The app's
``parseNote`` / ``parseNoteContent`` (in ``app/src/lib/core/note*.ts``) is
the read side. Cross-checked via golden fixtures in tests.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

MAX_FIRESTORE_NOTE_BYTES = 900_000
NOTE_CONTENT_VERSION = "0.1"


class NotePayloadTooLargeError(ValueError):
    def __init__(self, byte_length: int) -> None:
        super().__init__(
            f"Note payload is {byte_length} bytes, exceeds limit of {MAX_FIRESTORE_NOTE_BYTES}"
        )
        self.byte_length = byte_length


def format_tomboy_date(dt: datetime) -> str:
    """Format a datetime to Tomboy's ``yyyy-MM-ddTHH:mm:ss.fffffffzzz``.

    Python's ``datetime`` has microsecond (6-digit) precision; we pad to 7
    fractional digits to match Tomboy's C# ``DateTime`` output.
    """
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    frac = f"{dt.microsecond:06d}0"  # 6 digits → 7 by appending '0'
    offset = dt.strftime("%z")  # e.g. "+0000"
    if offset:
        offset = offset[:3] + ":" + offset[3:]  # +00:00
    else:
        offset = "+00:00"
    return f"{base}.{frac}{offset}"


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def build_note_content_xml(title: str, ocr_text: str, image_url: str) -> str:
    """Produce the ``<note-content>`` block per spec I7.

    Layout:

        2026-05-10 리마커블([uuid])

        <ocr text>

        ---

        <image url>
    """
    body = (
        f"{_xml_escape(title)}\n\n"
        f"{_xml_escape(ocr_text)}\n\n"
        f"---\n\n"
        f"{_xml_escape(image_url)}"
    )
    return f'<note-content version="{NOTE_CONTENT_VERSION}">{body}</note-content>'


def build_payload(
    *,
    guid: str,
    page_uuid: str,
    ocr_text: str,
    image_url: str,
    notebook_name: str,
    title_format: str,
    create_date: datetime,
    change_date: datetime,
    metadata_change_date: datetime | None = None,
) -> dict[str, Any]:
    """Build the FirestoreNotePayload dict (sans ``serverUpdatedAt``).

    The writer (``firestore_client``) is responsible for adding
    ``serverUpdatedAt = SERVER_TIMESTAMP`` at write time.
    """
    metadata_change_date = metadata_change_date or change_date
    date_str = change_date.strftime("%Y-%m-%d")
    title = title_format.format(date=date_str, page_uuid=page_uuid)
    xml_content = build_note_content_xml(title, ocr_text, image_url)
    payload: dict[str, Any] = {
        "guid": guid,
        "uri": f"note://tomboy/{guid}",
        "title": title,
        "xmlContent": xml_content,
        "createDate": format_tomboy_date(create_date),
        "changeDate": format_tomboy_date(change_date),
        "metadataChangeDate": format_tomboy_date(metadata_change_date),
        "tags": [f"system:notebook:{notebook_name}"],
        "deleted": False,
    }
    import json

    size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    if size > MAX_FIRESTORE_NOTE_BYTES:
        raise NotePayloadTooLargeError(size)
    return payload
```

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_tomboy_payload.py -v
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/lib/tomboy_payload.py pipeline/tests/lib/test_tomboy_payload.py
git commit -m "feat(pipeline): add lib/tomboy_payload.py Firestore document builder"
```

---

## Task 6: `lib/firestore_client.py` — Firebase Admin SDK wrapper  [sequential after T1, T5]

**Goal:** Thin wrapper around `firebase_admin.firestore` that initializes the Admin SDK from a service account JSON, exposes `get_note(guid)`, `set_note(guid, payload)`, and `delete_note(guid)` against `users/{uid}/notes/{guid}`. The `set_note` call adds `serverUpdatedAt = SERVER_TIMESTAMP` automatically. All other writes are full-document replacements (no `merge=True`).

**Files:**
- Create: `pipeline/desktop/lib/firestore_client.py`
- Create: `pipeline/tests/lib/test_firestore_client.py`

**Acceptance Criteria:**
- [ ] `FirestoreClient(uid, service_account_path)` initializes the SDK once (idempotent across instances)
- [ ] `client.get_note(guid)` returns `None` when the doc doesn't exist
- [ ] `client.get_note(guid)` returns the doc dict when it exists
- [ ] `client.set_note(guid, payload)` writes `users/{uid}/notes/{guid}` with `serverUpdatedAt` added
- [ ] `client.delete_note(guid)` writes `deleted: True` (soft delete) — does not actually remove the doc
- [ ] Tests use `mocker` to mock `firebase_admin` modules; no real network calls
- [ ] Re-initializing the SDK after first init is a no-op (uses `firebase_admin.get_app` if available)

**Verify:** `cd pipeline && python -m pytest tests/lib/test_firestore_client.py -v` → all green

**Steps:**

- [ ] **Step 1: Install dep**

```bash
cd pipeline && pip install -e .[firebase]
```

- [ ] **Step 2: Write failing tests**

Create `pipeline/tests/lib/test_firestore_client.py`:

```python
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from desktop.lib.firestore_client import FirestoreClient


@pytest.fixture
def mock_firebase(mocker):
    """Mock firebase_admin + firestore modules."""
    fa = mocker.patch("desktop.lib.firestore_client.firebase_admin")
    fs = mocker.patch("desktop.lib.firestore_client.firestore")
    fa.get_app.side_effect = ValueError  # not yet initialized
    fa.initialize_app.return_value = MagicMock()
    fs.client.return_value = MagicMock()
    fs.SERVER_TIMESTAMP = "<sentinel>"
    return fa, fs


def test_init_calls_initialize_app(mock_firebase):
    fa, _ = mock_firebase
    FirestoreClient("dbx-test", "/tmp/sa.json")
    fa.initialize_app.assert_called_once()


def test_init_skips_when_already_initialized(mocker):
    fa = mocker.patch("desktop.lib.firestore_client.firebase_admin")
    mocker.patch("desktop.lib.firestore_client.firestore")
    fa.get_app.return_value = MagicMock()  # already initialized
    FirestoreClient("dbx-test", "/tmp/sa.json")
    fa.initialize_app.assert_not_called()


def test_get_note_returns_none_when_missing(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    snap = MagicMock()
    snap.exists = False
    db.collection.return_value.document.return_value.collection.return_value.document.return_value.get.return_value = snap

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    assert c.get_note("guid-1") is None


def test_get_note_returns_dict_when_present(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    snap = MagicMock()
    snap.exists = True
    snap.to_dict.return_value = {"guid": "guid-1", "title": "T"}
    db.collection.return_value.document.return_value.collection.return_value.document.return_value.get.return_value = snap

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    result = c.get_note("guid-1")
    assert result == {"guid": "guid-1", "title": "T"}


def test_set_note_adds_server_timestamp(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    doc = db.collection.return_value.document.return_value.collection.return_value.document.return_value

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    c.set_note("guid-1", {"title": "T", "deleted": False})

    args, kwargs = doc.set.call_args
    written = args[0]
    assert written["title"] == "T"
    assert written["serverUpdatedAt"] == "<sentinel>"


def test_delete_note_writes_soft_delete(mock_firebase):
    _, fs = mock_firebase
    db = fs.client.return_value
    doc = db.collection.return_value.document.return_value.collection.return_value.document.return_value

    c = FirestoreClient("dbx-test", "/tmp/sa.json")
    c.delete_note("guid-1")

    args, _ = doc.set.call_args
    written = args[0]
    assert written["deleted"] is True
```

- [ ] **Step 3: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_firestore_client.py -v
```

Expected: ImportError.

- [ ] **Step 4: Implement `desktop/lib/firestore_client.py`**

```python
"""Firebase Admin SDK wrapper. One instance per process; idempotent init."""
from __future__ import annotations

from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore


_DEFAULT_APP_NAME = "tomboy-pipeline"


class FirestoreClient:
    def __init__(self, uid: str, service_account_path: str) -> None:
        self.uid = uid
        try:
            firebase_admin.get_app(_DEFAULT_APP_NAME)
        except ValueError:
            cred = credentials.Certificate(service_account_path)
            firebase_admin.initialize_app(cred, name=_DEFAULT_APP_NAME)
        self._app = firebase_admin.get_app(_DEFAULT_APP_NAME)
        self._db = firestore.client(self._app)

    def _doc(self, guid: str):
        return (
            self._db.collection("users")
            .document(self.uid)
            .collection("notes")
            .document(guid)
        )

    def get_note(self, guid: str) -> dict[str, Any] | None:
        snap = self._doc(guid).get()
        if not snap.exists:
            return None
        return snap.to_dict()

    def set_note(self, guid: str, payload: dict[str, Any]) -> None:
        merged = dict(payload)
        merged["serverUpdatedAt"] = firestore.SERVER_TIMESTAMP
        self._doc(guid).set(merged)

    def delete_note(self, guid: str) -> None:
        """Soft-delete: keep the doc, flip ``deleted=True``."""
        self._doc(guid).set({"deleted": True, "serverUpdatedAt": firestore.SERVER_TIMESTAMP})
```

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_firestore_client.py -v
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/lib/firestore_client.py pipeline/tests/lib/test_firestore_client.py pipeline/pyproject.toml
git commit -m "feat(pipeline): add lib/firestore_client.py Firebase Admin SDK wrapper"
```

---

## Task 7: `lib/dropbox_uploader.py` — image upload + share link  [parallel-eligible after T1]

**Goal:** Upload a local file to a target Dropbox path and return a shared-link URL. Uses the user's long-lived refresh token (saved in `pipeline.yaml` by bootstrap). Idempotent: re-uploading the same file overwrites; getting the share link is a separate call that reuses an existing link if one exists.

**Files:**
- Create: `pipeline/desktop/lib/dropbox_uploader.py`
- Create: `pipeline/tests/lib/test_dropbox_uploader.py`

**Acceptance Criteria:**
- [ ] `DropboxUploader(refresh_token, app_key)` constructs a Dropbox SDK client
- [ ] `upload(local_path, target_path)` uploads bytes, returns the Dropbox file metadata
- [ ] `share_link(target_path)` returns a public-share URL string; reuses an existing shared link if `create_shared_link_with_settings` raises the "already exists" API error
- [ ] All tests use mocks; no real Dropbox calls
- [ ] Upload uses `WriteMode.overwrite` for re-runs

**Verify:** `cd pipeline && python -m pytest tests/lib/test_dropbox_uploader.py -v` → all green

**Steps:**

- [ ] **Step 1: Install dep**

```bash
cd pipeline && pip install -e .[dropbox]
```

- [ ] **Step 2: Write failing tests**

Create `pipeline/tests/lib/test_dropbox_uploader.py`:

```python
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.dropbox_uploader import DropboxUploader


@pytest.fixture
def mock_dbx(mocker):
    dbx_module = mocker.patch("desktop.lib.dropbox_uploader.dropbox")
    client = MagicMock()
    dbx_module.Dropbox.return_value = client
    return dbx_module, client


def test_construct_passes_refresh_token(mock_dbx):
    dbx_module, _ = mock_dbx
    DropboxUploader("refresh-tok", "app-key")
    dbx_module.Dropbox.assert_called_once()
    kwargs = dbx_module.Dropbox.call_args.kwargs
    assert kwargs["oauth2_refresh_token"] == "refresh-tok"
    assert kwargs["app_key"] == "app-key"


def test_upload_writes_bytes(mock_dbx, tmp_path: Path):
    _, client = mock_dbx
    f = tmp_path / "p.png"
    f.write_bytes(b"PNGDATA")
    u = DropboxUploader("t", "k")
    u.upload(f, "/Apps/Tomboy/diary-images/2024/05/10/abc/page.png")
    args = client.files_upload.call_args
    assert args.args[0] == b"PNGDATA"
    assert args.args[1] == "/Apps/Tomboy/diary-images/2024/05/10/abc/page.png"


def test_share_link_returns_url_for_new_link(mock_dbx):
    _, client = mock_dbx
    client.sharing_create_shared_link_with_settings.return_value = MagicMock(
        url="https://www.dropbox.com/scl/fi/abc/page.png?dl=0"
    )
    u = DropboxUploader("t", "k")
    url = u.share_link("/Apps/Tomboy/diary-images/2024/05/10/abc/page.png")
    assert "dropbox.com" in url


def test_share_link_falls_back_to_existing_when_already_shared(mock_dbx, mocker):
    dbx_module, client = mock_dbx

    # Simulate Dropbox SDK raising shared_link_already_exists
    class ApiError(Exception):
        pass

    dbx_module.exceptions.ApiError = ApiError

    err_inst = ApiError()
    err_inst.error = MagicMock()
    err_inst.error.is_shared_link_already_exists = MagicMock(return_value=True)
    client.sharing_create_shared_link_with_settings.side_effect = err_inst

    existing = MagicMock()
    existing.links = [MagicMock(url="https://www.dropbox.com/existing/page.png?dl=0")]
    client.sharing_list_shared_links.return_value = existing

    u = DropboxUploader("t", "k")
    url = u.share_link("/path.png")
    assert "existing" in url
```

- [ ] **Step 3: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/lib/test_dropbox_uploader.py -v
```

Expected: ImportError.

- [ ] **Step 4: Implement `desktop/lib/dropbox_uploader.py`**

```python
"""Dropbox file upload + share-link wrapper using a refresh token."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import dropbox


class DropboxUploader:
    def __init__(self, refresh_token: str, app_key: str) -> None:
        self._client = dropbox.Dropbox(
            oauth2_refresh_token=refresh_token, app_key=app_key
        )

    def upload(self, local_path: Path | str, target_path: str) -> Any:
        data = Path(local_path).read_bytes()
        return self._client.files_upload(
            data,
            target_path,
            mode=dropbox.files.WriteMode.overwrite,
            mute=True,
        )

    def share_link(self, target_path: str) -> str:
        try:
            res = self._client.sharing_create_shared_link_with_settings(target_path)
            return res.url
        except dropbox.exceptions.ApiError as e:
            # Already shared — fetch the existing link
            err = getattr(e, "error", None)
            already = err is not None and hasattr(err, "is_shared_link_already_exists") and err.is_shared_link_already_exists()
            if not already:
                raise
            existing = self._client.sharing_list_shared_links(path=target_path)
            if not existing.links:
                raise
            return existing.links[0].url
```

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/lib/test_dropbox_uploader.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/lib/dropbox_uploader.py pipeline/tests/lib/test_dropbox_uploader.py pipeline/pyproject.toml
git commit -m "feat(pipeline): add lib/dropbox_uploader.py upload + share-link wrapper"
```

---

## Task 8: `desktop/bootstrap.py` — interactive credential setup  [sequential after T1, T6, T7]

**Goal:** One-shot interactive script that walks the user through Dropbox OAuth (PKCE), retrieves the `account_id`, computes `uid = dbx-{sanitized}`, prompts for the Firebase service-account JSON path, and writes a complete `pipeline.yaml`. Idempotent — re-running it overwrites with the user's confirmation.

**Files:**
- Create: `pipeline/desktop/bootstrap.py`
- Create: `pipeline/tests/test_bootstrap.py`

**Acceptance Criteria:**
- [ ] `sanitize_account_id("dbid:abc-123")` → `"abc-123"` (strip prefix; replace any non-`[A-Za-z0-9_-]` with `-`)
- [ ] `compute_uid(account_id)` → `f"dbx-{sanitize_account_id(account_id)}"`
- [ ] `write_config(path, data)` produces YAML that round-trips through `load_config`
- [ ] CLI entry-point exists (`if __name__ == "__main__":`) but tests don't drive it interactively — the data-shaping helpers are tested in isolation
- [ ] `--dry-run` flag prints what would be written without touching the filesystem

**Verify:** `cd pipeline && python -m pytest tests/test_bootstrap.py -v` → all green; manually `python -m desktop.bootstrap --dry-run` shows config preview without errors.

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/test_bootstrap.py`:

```python
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
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/test_bootstrap.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/bootstrap.py`**

```python
"""Interactive credential setup. Run once: ``python -m desktop.bootstrap``.

Walks the user through Dropbox OAuth (PKCE), extracts the account_id,
computes the Firebase uid, prompts for the Firebase service-account JSON
path, and writes ``config/pipeline.yaml``.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml


def sanitize_account_id(account_id: str) -> str:
    """Strip a leading ``dbid:`` prefix and replace anything that isn't
    ``[A-Za-z0-9_-]`` with ``-``. Mirrors the app's sanitization (see
    ``app/src/lib/firebase/app.ts``)."""
    if account_id.startswith("dbid:"):
        account_id = account_id[len("dbid:") :]
    return re.sub(r"[^A-Za-z0-9_-]", "-", account_id)


def compute_uid(account_id: str) -> str:
    return f"dbx-{sanitize_account_id(account_id)}"


def write_config(path: Path | str, data: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _interactive_main(dry_run: bool) -> int:
    """Prompt the user step-by-step. Out of scope for unit tests — covered by manual verify."""
    print("Tomboy Diary Pipeline — bootstrap")
    print()

    # 1) Dropbox PKCE OAuth — point user at the URL, ask them to paste the code.
    # The PKCE flow is documented at https://developers.dropbox.com/oauth-guide.
    # We use the dropbox SDK's DropboxOAuth2FlowNoRedirect for this.
    import dropbox

    app_key = input("Dropbox app key (PUBLIC_DROPBOX_APP_KEY in app/.env): ").strip()
    flow = dropbox.DropboxOAuth2FlowNoRedirect(
        consumer_key=app_key,
        token_access_type="offline",
        use_pkce=True,
    )
    auth_url = flow.start()
    print()
    print(f"  → Open: {auth_url}")
    print("  → Paste the resulting code below.")
    code = input("Code: ").strip()
    res = flow.finish(code)
    refresh_token = res.refresh_token
    account_id = res.account_id
    uid = compute_uid(account_id)
    print(f"  ✓ Dropbox connected. uid = {uid}")

    # 2) Firebase service account
    sa_path = input("Path to Firebase service-account JSON: ").strip()
    if not Path(sa_path).expanduser().exists():
        print(f"  ✗ Service-account file not found: {sa_path}", file=sys.stderr)
        return 1

    # 3) rM + Pi connection details
    print()
    print("reMarkable connection:")
    rm_diary_notebook = input("  Diary notebook name on rM [Diary]: ").strip() or "Diary"
    rm_ssh_host = input("  rM SSH host [rm.local]: ").strip() or "rm.local"
    rm_ssh_user = input("  rM SSH user [root]: ").strip() or "root"

    print()
    print("Pi connection (the always-on inbox host):")
    pi_ssh_host = input("  Pi SSH host: ").strip()
    pi_ssh_port = int(input("  Pi SSH port [2222]: ").strip() or "2222")
    pi_ssh_user = input("  Pi SSH user [diary-sync]: ").strip() or "diary-sync"
    pi_ssh_key = input("  Pi SSH key [~/.ssh/id_ed25519_diary]: ").strip() or "~/.ssh/id_ed25519_diary"
    pi_inbox = input("  Pi inbox path [~/diary/inbox]: ").strip() or "~/diary/inbox"

    data = {
        "firebase_uid": uid,
        "firebase_service_account": str(Path(sa_path).expanduser()),
        "dropbox_refresh_token": refresh_token,
        "dropbox_app_key": app_key,
        "remarkable": {
            "diary_notebook_name": rm_diary_notebook,
            "ssh_host": rm_ssh_host,
            "ssh_user": rm_ssh_user,
        },
        "pi": {
            "ssh_host": pi_ssh_host,
            "ssh_port": pi_ssh_port,
            "ssh_user": pi_ssh_user,
            "ssh_key": pi_ssh_key,
            "inbox_path": pi_inbox,
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

    target = Path(__file__).resolve().parent.parent / "config" / "pipeline.yaml"
    if dry_run:
        print()
        print(f"--- Would write to {target} ---")
        print(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
        return 0
    if target.exists():
        ok = input(f"{target} exists. Overwrite? [y/N] ").strip().lower()
        if ok != "y":
            print("Aborted.")
            return 1
    write_config(target, data)
    print(f"  ✓ Wrote {target}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return _interactive_main(args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/test_bootstrap.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/bootstrap.py pipeline/tests/test_bootstrap.py
git commit -m "feat(pipeline): add desktop/bootstrap.py interactive credential setup"
```

---

## Task 9: `pi/inbox_watcher.py` + index  [parallel-eligible after T0]

**Goal:** A small Python script that maintains `~/diary/state/index.json` mapping `{rm-page-uuid: {received_at, mtime, archived}}` based on what's in `~/diary/inbox/`. Runs on a 5-minute systemd timer. The actual rsync from rM is done by the rM-side push (T10) — this watcher just tracks what landed.

**Files:**
- Create: `pipeline/pi/inbox_watcher.py`
- Create: `pipeline/tests/pi/test_inbox_watcher.py`

**Acceptance Criteria:**
- [ ] `scan_inbox(inbox_dir)` returns a dict of `{page_uuid: {mtime, received_at}}` for every `.metadata` file in the inbox (page UUID = filename stem)
- [ ] `update_index(index_path, scan_result)` merges new uuids without overwriting existing `received_at`
- [ ] An entry whose source file is gone in the new scan keeps its index record but is marked `present: False`
- [ ] CLI: `python -m pi.inbox_watcher --inbox <path> --index <path>` updates the index and prints a one-line summary
- [ ] Atomic index write (uses the same temp-file pattern as `lib/state.py` — but reimplement here so the Pi script has no dependency on `desktop/lib/`)

**Verify:** `cd pipeline && python -m pytest tests/pi/test_inbox_watcher.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/pi/test_inbox_watcher.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

from pi.inbox_watcher import scan_inbox, update_index


def _make_pair(inbox: Path, page_uuid: str) -> None:
    (inbox / f"{page_uuid}.metadata").write_text(
        json.dumps({"visibleName": "x", "lastModified": "1715337600000"})
    )
    (inbox / f"{page_uuid}.rm").write_bytes(b"\x00" * 16)


def test_scan_finds_metadata_files(tmp_path: Path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_pair(inbox, "abc-1")
    _make_pair(inbox, "abc-2")
    res = scan_inbox(inbox)
    assert "abc-1" in res
    assert "abc-2" in res
    assert "mtime" in res["abc-1"]
    assert "received_at" in res["abc-1"]


def test_scan_ignores_non_metadata_files(tmp_path: Path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "foo.rm").write_bytes(b"")
    (inbox / "bar.txt").write_text("nope")
    assert scan_inbox(inbox) == {}


def test_update_index_preserves_received_at(tmp_path: Path):
    index = tmp_path / "index.json"
    initial = {"abc-1": {"received_at": "2024-05-10T00:00:00Z", "mtime": 100, "present": True}}
    index.write_text(json.dumps(initial))
    new_scan = {"abc-1": {"mtime": 200, "received_at": "2024-05-11T00:00:00Z"}}
    update_index(index, new_scan)
    after = json.loads(index.read_text())
    # Existing received_at preserved; mtime updated; present True
    assert after["abc-1"]["received_at"] == "2024-05-10T00:00:00Z"
    assert after["abc-1"]["mtime"] == 200
    assert after["abc-1"]["present"] is True


def test_update_index_marks_missing_as_not_present(tmp_path: Path):
    index = tmp_path / "index.json"
    initial = {"abc-1": {"received_at": "old", "mtime": 1, "present": True}}
    index.write_text(json.dumps(initial))
    update_index(index, {})  # nothing in inbox now
    after = json.loads(index.read_text())
    assert after["abc-1"]["present"] is False
    # received_at still preserved
    assert after["abc-1"]["received_at"] == "old"


def test_update_index_creates_new_entries(tmp_path: Path):
    index = tmp_path / "index.json"  # does not exist
    new_scan = {"new-1": {"mtime": 1, "received_at": "now"}}
    update_index(index, new_scan)
    after = json.loads(index.read_text())
    assert after["new-1"]["present"] is True
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/pi/test_inbox_watcher.py -v
```

Expected: ImportError on `pi.inbox_watcher`.

- [ ] **Step 3: Implement `pi/inbox_watcher.py`**

```python
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
    present = sum(1 for v in json.loads(args.index.read_text())["__values__"]) if False else len(scan)
    print(f"inbox-watcher: {present} pages currently in inbox")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/pi/test_inbox_watcher.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/pi/inbox_watcher.py pipeline/tests/pi/
git commit -m "feat(pipeline): add pi/inbox_watcher.py for index maintenance"
```

---

## Task 10: Pi systemd units + rM-side push docs  [docs only — TDD does not apply]

**Goal:** Provide deployable systemd unit files and the documentation the user needs to install the rM-side push script + Pi WAN SSH hardening. No tests; manual verification per spec §6 M1.

**Files:**
- Create: `pipeline/pi/deploy/pi-watcher.service`
- Create: `pipeline/pi/deploy/pi-watcher.timer`
- Create: `pipeline/pi/README.md`

**Acceptance Criteria:**
- [ ] `pi-watcher.timer` triggers `pi-watcher.service` every 5 minutes
- [ ] `pi-watcher.service` runs `python -m pi.inbox_watcher --inbox … --index …` as the `diary-sync` user
- [ ] `pi/README.md` documents: SSH hardening (non-standard port, ed25519, fail2ban, `AllowUsers`), the rM-side push hook (cron + rsync), unit file installation, and a verification recipe

**Verify:** Manual — install on the user's actual Pi following the README; draw a page on rM; observe `~/diary/inbox/` populating and `~/diary/state/index.json` updating within 5 minutes.

**Steps:**

- [ ] **Step 1: Create `pipeline/pi/deploy/pi-watcher.service`**

```ini
[Unit]
Description=Tomboy diary pipeline inbox watcher
After=network.target

[Service]
Type=oneshot
User=diary-sync
WorkingDirectory=/home/diary-sync/tomboy-pipeline
ExecStart=/home/diary-sync/tomboy-pipeline/.venv/bin/python -m pi.inbox_watcher --inbox /home/diary-sync/diary/inbox --index /home/diary-sync/diary/state/index.json
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Create `pipeline/pi/deploy/pi-watcher.timer`**

```ini
[Unit]
Description=Run pi-watcher every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Unit=pi-watcher.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Create `pipeline/pi/README.md`**

```markdown
# Tomboy Diary Pipeline — Raspberry Pi side

The Pi acts as the always-on inbox between the reMarkable tablet and the desktop. It does two things:

1. Receive `.rm` files pushed from the rM tablet over SSH (rsync).
2. Maintain `~/diary/state/index.json` so the desktop fetcher knows what's available.

## Install

### 1. Create the dedicated user

\`\`\`bash
sudo useradd -m -s /bin/bash diary-sync
sudo -u diary-sync mkdir -p /home/diary-sync/diary/{inbox,archive,state}
\`\`\`

### 2. Clone the pipeline + venv

\`\`\`bash
sudo -u diary-sync -i
git clone <tomboy-web repo> /home/diary-sync/tomboy-web
cd /home/diary-sync/tomboy-web/pipeline
python3 -m venv .venv
.venv/bin/pip install -e .
ln -s /home/diary-sync/tomboy-web/pipeline /home/diary-sync/tomboy-pipeline
\`\`\`

### 3. SSH hardening for WAN exposure

In `/etc/ssh/sshd_config.d/diary.conf`:

\`\`\`
Port 2222
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers diary-sync
\`\`\`

Restart sshd. Authorize the rM's ed25519 public key in `/home/diary-sync/.ssh/authorized_keys`.

Install fail2ban with the default `sshd` jail enabled.

Open port 2222 on your home router, pointing at the Pi.

### 4. Install the systemd timer

\`\`\`bash
sudo cp /home/diary-sync/tomboy-pipeline/pi/deploy/pi-watcher.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-watcher.timer
sudo systemctl status pi-watcher.timer
\`\`\`

Watch logs: `sudo journalctl -u pi-watcher.service -f`.

## rM-side push

On the reMarkable tablet (SSH in as `root`):

### 1. Generate a key pair (rM-side)

\`\`\`bash
ssh-keygen -t ed25519 -f ~/.ssh/id_diary -N ""
cat ~/.ssh/id_diary.pub  # copy and add to Pi's diary-sync authorized_keys
\`\`\`

### 2. Push script

Create `/home/root/diary-push.sh`:

\`\`\`bash
#!/bin/sh
# Push the configured Diary notebook's pages to the Pi.
DIARY_PARENT_UUID="$(grep -l '"visibleName": "Diary"' /home/root/.local/share/remarkable/xochitl/*.metadata | head -1 | xargs -I{} basename {} .metadata)"
[ -z "$DIARY_PARENT_UUID" ] && { echo "No Diary notebook found"; exit 0; }
SRC=/home/root/.local/share/remarkable/xochitl/
DEST=diary-sync@<PI-WAN-HOST>:diary/inbox/
# Match every page whose .metadata has parent == DIARY_PARENT_UUID
for meta in "$SRC"*.metadata; do
    if grep -q "\"parent\": \"$DIARY_PARENT_UUID\"" "$meta"; then
        page="$(basename "$meta" .metadata)"
        rsync -avz -e "ssh -p 2222 -i /home/root/.ssh/id_diary -o StrictHostKeyChecking=accept-new" \
              "$SRC$page".* "$DEST"
    fi
done
\`\`\`

\`chmod +x /home/root/diary-push.sh\`

### 3. Cron

\`crontab -e\` and add:

\`\`\`
*/5 * * * * /home/root/diary-push.sh > /tmp/diary-push.log 2>&1
\`\`\`

### 4. Survival

rM firmware updates wipe `/home/root` modifications. After every rM update:

1. Re-run `crontab -e` to verify the cron entry survived.
2. Re-check `~/.ssh/id_diary` and `~/.ssh/authorized_keys` exist.
3. Re-run the push script once manually to confirm it still works: `sh /home/root/diary-push.sh`.

## Verify

Draw a new page on the rM in the Diary notebook. Within 5 minutes:

\`\`\`bash
# On the Pi:
ls /home/diary-sync/diary/inbox/        # should contain <uuid>.rm + <uuid>.metadata
cat /home/diary-sync/diary/state/index.json   # should include the new uuid
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/pi/deploy/ pipeline/pi/README.md
git commit -m "docs(pipeline): add Pi systemd units + rM push + WAN SSH guide"
```

---

## Task 11: `stages/s1_fetch.py` — Pi → desktop rsync  [parallel-eligible after T1, T2, T3]

**Goal:** Pull every `.rm`/`.metadata` for present-in-Pi pages into `<data_dir>/raw/<page_uuid>/`. Skip uuids already in `state/fetched.json`. The actual transport is rsync via SSH, but the function takes a transport callable so tests can run end-to-end with a fake transport.

**Files:**
- Create: `pipeline/desktop/stages/s1_fetch.py`
- Create: `pipeline/tests/stages/__init__.py` (empty)
- Create: `pipeline/tests/stages/test_s1_fetch.py`

**Acceptance Criteria:**
- [ ] `fetch(config, state, log, transport)` reads the Pi's `index.json` (transport-fetched) and pulls every `present: True` uuid not yet in `state/fetched.json`
- [ ] Each pulled uuid lands in `<data_dir>/raw/<uuid>/` containing all of its rM files
- [ ] After a successful pull, `state/fetched.json` gains `{<uuid>: {fetched_at, source_mtime}}`
- [ ] Re-running with the same state is a no-op (no transport calls beyond fetching the index)
- [ ] `--force <uuid>` removes that uuid from state and re-fetches it
- [ ] Per-uuid exception logs and continues; one bad uuid does not abort the batch

**Verify:** `cd pipeline && python -m pytest tests/stages/test_s1_fetch.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/stages/test_s1_fetch.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

import pytest

from desktop.lib.state import StateFile
from desktop.stages.s1_fetch import FakeTransport, fetch


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
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && mkdir -p tests/stages && touch tests/stages/__init__.py
python -m pytest tests/stages/test_s1_fetch.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/stages/s1_fetch.py`**

```python
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
        remote = (
            f"{self.cfg.pi.ssh_user}@{self.cfg.pi.ssh_host}:"
            f"{self.cfg.pi.inbox_path.rstrip('/')}/../state/index.json"
        )
        proc = subprocess.run(
            ["scp", "-q"] + self._ssh_args() + [remote, "/dev/stdout"],
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
) -> list[str]:
    force = set(force or [])
    for u in force:
        state.remove(u)

    index = transport.fetch_index()
    fetched_uuids: list[str] = []

    for uuid, info in index.items():
        if not info.get("present"):
            continue
        if state.contains(uuid):
            continue
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
    state = StateFile(cfg.data_dir / "state" / "fetched.json")
    log = StageLogger("s1_fetch", cfg.data_dir)
    transport = SshRsyncTransport(cfg)

    fetched = fetch(
        raw_root=raw_root, state=state, log=log, transport=transport, force=args.force
    )
    print(f"s1_fetch: {len(fetched)} new pages fetched: {fetched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/stages/test_s1_fetch.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/stages/s1_fetch.py pipeline/tests/stages/
git commit -m "feat(pipeline): add stages/s1_fetch.py Pi rsync pull"
```

---

## Task 12: `stages/s2_prepare.py` — `.rm` → page PNG  [parallel-eligible after T1, T2, T3]

**Goal:** For every uuid in `raw/<uuid>/`, rasterize the page to `png/<uuid>/page.png`. Uses `rmrl` (or equivalent) — wrapped behind a `Renderer` Protocol so tests use a fake renderer that emits a 1×1 PNG. Also extracts the rM `lastModified` timestamp from `<uuid>.metadata` for downstream stages.

**Files:**
- Create: `pipeline/desktop/stages/s2_prepare.py`
- Create: `pipeline/tests/stages/test_s2_prepare.py`
- Create: `pipeline/tests/fixtures/sample-metadata.json`

**Acceptance Criteria:**
- [ ] `prepare(raw_root, png_root, state, log, renderer)` rasterizes every uuid in raw/ that isn't in state
- [ ] Each output is `png/<uuid>/page.png` (one PNG per page; multi-page rM notebooks are NOT this pipeline's concern — see spec, 1 rM page = 1 Tomboy note)
- [ ] State entry: `{<uuid>: {prepared_at, png_path, metadata: <full metadata dict>}}`
- [ ] Missing `.metadata` file → log error, skip uuid (do not crash)
- [ ] Renderer exceptions log and continue
- [ ] `--force <uuid>` re-renders

**Verify:** `cd pipeline && python -m pytest tests/stages/test_s2_prepare.py -v` → all green; manual: `python -m desktop.stages.s2_prepare --uuid <real-uuid>` produces a viewable PNG.

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/fixtures/sample-metadata.json`:

```json
{
  "deleted": false,
  "lastModified": "1715337600000",
  "metadatamodified": false,
  "modified": false,
  "parent": "diary-folder-uuid",
  "pinned": false,
  "synced": true,
  "type": "DocumentType",
  "version": 1,
  "visibleName": "Diary Page 2024-05-10"
}
```

Create `pipeline/tests/stages/test_s2_prepare.py`:

```python
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s2_prepare import FakeRenderer, prepare


_MIN_PNG = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
    "0000000D4944415478DA63F8FFFF3F0005FE02FECCB2F0E40000000049454E44AE426082"
)


def _seed_raw(raw_root: Path, uuid: str) -> None:
    d = raw_root / uuid
    d.mkdir(parents=True)
    (d / f"{uuid}.rm").write_bytes(b"\x00" * 32)
    fixtures_meta = Path(__file__).parent.parent / "fixtures" / "sample-metadata.json"
    shutil.copy(fixtures_meta, d / f"{uuid}.metadata")


@pytest.fixture
def stub_log(tmp_path):
    return StageLogger("s2_prepare", tmp_path)


def test_prepare_renders_new_uuids(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "abc-1")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == ["abc-1"]
    assert (png_root / "abc-1" / "page.png").read_bytes() == _MIN_PNG
    rec = state.get("abc-1")
    assert rec is not None
    assert "png_path" in rec
    assert rec["metadata"]["visibleName"] == "Diary Page 2024-05-10"


def test_prepare_skips_already_prepared(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "abc-1")
    state = StateFile(tmp_path / "state" / "prepared.json")
    state.write({"abc-1": {"prepared_at": "old", "png_path": "x", "metadata": {}}})
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == []


def test_prepare_skips_uuid_missing_metadata(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    d = raw_root / "no-meta"
    d.mkdir()
    (d / "no-meta.rm").write_bytes(b"\x00")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_MIN_PNG)

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)

    assert prepared == []
    assert not state.contains("no-meta")


def test_prepare_continues_after_renderer_error(tmp_path: Path, stub_log):
    raw_root = tmp_path / "raw"
    png_root = tmp_path / "png"
    raw_root.mkdir()
    png_root.mkdir()
    _seed_raw(raw_root, "ok")
    _seed_raw(raw_root, "bad")
    state = StateFile(tmp_path / "state" / "prepared.json")

    class FlakyRenderer(FakeRenderer):
        def render(self, raw_dir: Path, output_path: Path) -> None:
            if raw_dir.name == "bad":
                raise RuntimeError("rmrl crashed")
            return super().render(raw_dir, output_path)

    renderer = FlakyRenderer(_MIN_PNG)
    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log, renderer=renderer)
    assert "ok" in prepared
    assert "bad" not in prepared
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/stages/test_s2_prepare.py -v
```

Expected: ImportError.

- [ ] **Step 3: Install rmrl**

```bash
cd pipeline && pip install -e .[prepare]
```

If `rmrl` install fails on the target Python version, the implementer should swap to `lines-are-rusty` or `rmscene` — the `Renderer` interface is the same.

- [ ] **Step 4: Implement `desktop/stages/s2_prepare.py`**

```python
"""Stage 2: rasterize each rM page in ``raw/<uuid>/`` to ``png/<uuid>/page.png``."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Protocol

from desktop.lib.config import load_config
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile


class Renderer(Protocol):
    def render(self, raw_dir: Path, output_path: Path) -> None: ...


class FakeRenderer:
    def __init__(self, png_bytes: bytes) -> None:
        self.png_bytes = png_bytes

    def render(self, raw_dir: Path, output_path: Path) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(self.png_bytes)


class RmrlRenderer:
    """Production renderer using rmrl. Falls back to ``lines-are-rusty`` if needed."""

    def render(self, raw_dir: Path, output_path: Path) -> None:
        # Find the .rm file in raw_dir
        rms = list(raw_dir.glob("*.rm"))
        if not rms:
            raise FileNotFoundError(f"No .rm file under {raw_dir}")
        try:
            from rmrl import render  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "rmrl is not installed; install with `pip install -e .[prepare]` "
                "or substitute another renderer that implements Renderer"
            ) from e

        # rmrl renders the entire notebook to PDF/SVG; for a single page we
        # render PDF and rasterize the first page to PNG via Pillow + a PDF lib.
        # Implementation detail: choose whatever rmrl/Pillow combination works
        # on the target Python version; the Renderer interface only requires
        # the side effect of writing a PNG to output_path.
        from io import BytesIO

        pdf_stream = render(str(rms[0]))
        # Convert first PDF page to PNG via pdf2image or Pillow with PyMuPDF;
        # the simplest dep-free path is pdf2image:
        try:
            from pdf2image import convert_from_bytes  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError("pdf2image not installed (poppler-utils required on host)") from e
        images = convert_from_bytes(pdf_stream.read(), dpi=150)
        if not images:
            raise RuntimeError("rmrl produced 0 pages")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        images[0].save(output_path, "PNG")


def prepare(
    *,
    raw_root: Path,
    png_root: Path,
    state: StateFile,
    log: StageLogger,
    renderer: Renderer,
    force: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        state.remove(u)

    prepared: list[str] = []
    for uuid_dir in sorted(p for p in raw_root.iterdir() if p.is_dir()):
        uuid = uuid_dir.name
        if state.contains(uuid):
            continue
        meta_path = uuid_dir / f"{uuid}.metadata"
        if not meta_path.exists():
            log.error("missing_metadata", uuid=uuid)
            continue
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            target = png_root / uuid / "page.png"
            renderer.render(uuid_dir, target)
            state.update(
                {
                    uuid: {
                        "prepared_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "png_path": str(target.resolve()),
                        "metadata": metadata,
                    }
                }
            )
            log.info("prepared", uuid=uuid)
            prepared.append(uuid)
        except Exception as e:
            log.error("prepare_failed", uuid=uuid, reason=str(e))
    return prepared


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    parser.add_argument("--uuid", help="Only process this single uuid")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    raw_root = cfg.data_dir / "raw"
    png_root = cfg.data_dir / "png"
    png_root.mkdir(parents=True, exist_ok=True)
    state = StateFile(cfg.data_dir / "state" / "prepared.json")
    log = StageLogger("s2_prepare", cfg.data_dir)
    renderer = RmrlRenderer()

    if args.uuid:
        # Drop everything except the requested uuid by faking a single-uuid raw_root view.
        # Simplest: reuse `prepare` with `force={uuid}` and let it process all then early-return.
        # For now, just call with force; the per-uuid skip prevents redundant work.
        pass
    prepared = prepare(
        raw_root=raw_root,
        png_root=png_root,
        state=state,
        log=log,
        renderer=renderer,
        force=set(args.force) | ({args.uuid} if args.uuid else set()),
    )
    print(f"s2_prepare: {len(prepared)} pages prepared")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/stages/test_s2_prepare.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/stages/s2_prepare.py pipeline/tests/stages/test_s2_prepare.py pipeline/tests/fixtures/
git commit -m "feat(pipeline): add stages/s2_prepare.py rM → PNG via Renderer interface"
```

---

## Task 13: `ocr_backends/local_vlm.py` — Qwen2.5-VL-7B implementation  [parallel-eligible after T4]

**Goal:** Concrete `OCRBackend` that loads Qwen2.5-VL-7B with 4-bit quantization and runs OCR on a single image. The model is loaded lazily on first call (not in `__init__`) and cached. The system prompt is read from `config/prompts/diary-ko.txt`. Tests do NOT load the real model — they verify the contract via a mock `_run_inference` injection.

**Files:**
- Create: `pipeline/desktop/ocr_backends/local_vlm.py`
- Create: `pipeline/tests/ocr_backends/test_local_vlm.py`
- Create: `pipeline/config/prompts/diary-ko.txt`

**Acceptance Criteria:**
- [ ] `LocalVlmBackend(model_id, quantization, max_new_tokens, system_prompt_path)` constructs without loading the model
- [ ] First call to `ocr(image_path)` triggers `_load_model()`; subsequent calls reuse the loaded model
- [ ] `_run_inference(image, prompt) -> str` is the override seam used by tests
- [ ] `OCRResult.text` is what `_run_inference` returned, stripped of leading/trailing whitespace
- [ ] `OCRResult.prompt_hash` is sha256 of the system prompt; same hash across calls
- [ ] `OCRResult.model` is the configured `model_id`
- [ ] Backend self-registers as `"local_vlm"` so `get_backend("local_vlm", ...)` works
- [ ] System prompt file existence is verified at construction; missing file raises `FileNotFoundError`

**Verify:** `cd pipeline && python -m pytest tests/ocr_backends/test_local_vlm.py -v` → all green; manual: load real model on the actual GPU once and run on a sample page.

**Steps:**

- [ ] **Step 1: Create the system prompt file**

`pipeline/config/prompts/diary-ko.txt`:

```
다음은 한국어 손글씨 일기 페이지입니다. 이미지에 적힌 텍스트를 그대로 추출해 주세요.

규칙:
- 줄바꿈을 그대로 보존하세요. 원본에서 줄이 바뀐 곳에서 줄을 바꾸세요.
- 설명, 주석, 추측, 헤더("아래는 텍스트입니다" 등) 없이 추출된 텍스트만 출력하세요.
- 읽을 수 없는 글자는 ⌗ 한 글자로 표기하세요.
- 그림이나 도표는 무시하고, 글자만 추출하세요.
```

- [ ] **Step 2: Write failing tests**

Create `pipeline/tests/ocr_backends/test_local_vlm.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from desktop.ocr_backends.base import OCRBackend, get_backend
from desktop.ocr_backends.local_vlm import LocalVlmBackend


@pytest.fixture
def prompt_file(tmp_path: Path) -> Path:
    p = tmp_path / "prompt.txt"
    p.write_text("system prompt body")
    return p


def test_construction_does_not_load_model(prompt_file):
    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    assert b._model is None  # type: ignore[attr-defined]


def test_missing_prompt_file_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        LocalVlmBackend(
            model_id="m",
            quantization="4bit",
            max_new_tokens=128,
            system_prompt_path=tmp_path / "missing.txt",
        )


def test_ocr_returns_result(monkeypatch, prompt_file, tmp_path: Path):
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")

    b = LocalVlmBackend(
        model_id="model-x",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    monkeypatch.setattr(b, "_load_model", lambda: None)
    monkeypatch.setattr(b, "_run_inference", lambda image, prompt: "  hello\n  ")

    result = b.ocr(img)
    assert result.text == "hello"
    assert result.model == "model-x"
    assert result.prompt_hash  # non-empty


def test_prompt_hash_is_stable(monkeypatch, prompt_file, tmp_path: Path):
    img = tmp_path / "p.png"
    img.write_bytes(b"X")

    b = LocalVlmBackend(
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    monkeypatch.setattr(b, "_load_model", lambda: None)
    monkeypatch.setattr(b, "_run_inference", lambda image, prompt: "x")

    r1 = b.ocr(img)
    r2 = b.ocr(img)
    assert r1.prompt_hash == r2.prompt_hash


def test_registered_under_local_vlm_name(prompt_file):
    backend = get_backend(
        "local_vlm",
        model_id="m",
        quantization="4bit",
        max_new_tokens=128,
        system_prompt_path=prompt_file,
    )
    assert isinstance(backend, OCRBackend)
```

- [ ] **Step 3: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/ocr_backends/test_local_vlm.py -v
```

Expected: ImportError.

- [ ] **Step 4: Implement `desktop/ocr_backends/local_vlm.py`**

```python
"""Qwen2.5-VL-7B OCR backend.

Loads the model lazily on first call. Real inference requires
``pip install -e .[vlm]`` and a CUDA-capable GPU; tests inject the
``_run_inference`` seam to avoid loading anything.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .base import OCRBackend, OCRResult, register_backend


@register_backend("local_vlm")
class LocalVlmBackend(OCRBackend):
    def __init__(
        self,
        *,
        model_id: str,
        quantization: str,
        max_new_tokens: int,
        system_prompt_path: Path | str,
    ) -> None:
        self.model_id = model_id
        self.quantization = quantization
        self.max_new_tokens = max_new_tokens
        prompt_path = Path(system_prompt_path)
        if not prompt_path.exists():
            raise FileNotFoundError(f"System prompt file not found: {prompt_path}")
        self.system_prompt = prompt_path.read_text(encoding="utf-8")
        self._prompt_hash = hashlib.sha256(self.system_prompt.encode("utf-8")).hexdigest()
        self._model: Any = None
        self._processor: Any = None

    def _load_model(self) -> None:
        if self._model is not None:
            return
        from transformers import AutoProcessor, BitsAndBytesConfig
        from transformers import Qwen2VLForConditionalGeneration  # type: ignore[attr-defined]

        bnb_kwargs: dict[str, Any] = {}
        if self.quantization == "4bit":
            bnb_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True)
        self._model = Qwen2VLForConditionalGeneration.from_pretrained(
            self.model_id,
            device_map="auto",
            **bnb_kwargs,
        )
        self._processor = AutoProcessor.from_pretrained(self.model_id)

    def _run_inference(self, image_path: Path, prompt: str) -> str:
        """Real inference. Tests override this method."""
        from PIL import Image

        self._load_model()
        image = Image.open(image_path).convert("RGB")
        messages = [
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": "위 이미지의 손글씨를 추출해 주세요."},
                ],
            },
        ]
        text = self._processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = self._processor(text=[text], images=[image], return_tensors="pt")
        inputs = {k: v.to(self._model.device) for k, v in inputs.items()}
        out_ids = self._model.generate(**inputs, max_new_tokens=self.max_new_tokens)
        # Strip the prompt portion (Qwen returns prompt + generation concatenated)
        gen_ids = out_ids[0][inputs["input_ids"].shape[1] :]
        return self._processor.decode(gen_ids, skip_special_tokens=True)

    def ocr(self, image_path: Path) -> OCRResult:
        text = self._run_inference(image_path, self.system_prompt).strip()
        return OCRResult(
            text=text,
            model=self.model_id,
            prompt_hash=self._prompt_hash,
            ts=datetime.now(timezone.utc),
        )
```

- [ ] **Step 5: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/ocr_backends/test_local_vlm.py -v
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/ocr_backends/local_vlm.py pipeline/tests/ocr_backends/test_local_vlm.py pipeline/config/prompts/
git commit -m "feat(pipeline): add ocr_backends/local_vlm.py Qwen2.5-VL-7B backend"
```

---

## Task 14: `stages/s3_ocr.py` — drive the OCR backend  [sequential after T2, T3, T4, T13]

**Goal:** For every uuid in `state/prepared.json` not yet in `state/ocr-done.json`, run the configured OCR backend on `png/<uuid>/page.png` and write `ocr/<uuid>.json` containing `{text, model, prompt_hash, ts}`. Per-uuid try/except.

**Files:**
- Create: `pipeline/desktop/stages/s3_ocr.py`
- Create: `pipeline/tests/stages/test_s3_ocr.py`

**Acceptance Criteria:**
- [ ] `run_ocr(prepared_state, ocr_state, ocr_root, log, backend)` processes every uuid in prepared but not in ocr-done
- [ ] Each result lands at `ocr/<uuid>.json` and the OCR state file gains `{<uuid>: {ocr_at, model}}`
- [ ] Backend exceptions log and continue
- [ ] `--force <uuid>` re-runs

**Verify:** `cd pipeline && python -m pytest tests/stages/test_s3_ocr.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/stages/test_s3_ocr.py`:

```python
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.ocr_backends.base import OCRBackend, OCRResult
from desktop.stages.s3_ocr import run_ocr


class StubBackend(OCRBackend):
    def __init__(self, text: str = "stub-text"):
        self.text = text
        self.calls: list[Path] = []

    def ocr(self, image_path: Path) -> OCRResult:
        self.calls.append(image_path)
        return OCRResult(
            text=self.text,
            model="stub-model",
            prompt_hash="stubhash",
            ts=datetime.now(timezone.utc),
        )


class FailingBackend(OCRBackend):
    def ocr(self, image_path: Path) -> OCRResult:
        raise RuntimeError("model exploded")


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s3_ocr", tmp_path)


def _seed_prepared(state: StateFile, png_root: Path, uuid: str) -> None:
    p = png_root / uuid / "page.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"PNGSTUB")
    state.update({uuid: {"prepared_at": "x", "png_path": str(p), "metadata": {}}})


def test_runs_ocr_for_pending_uuids(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "abc-1")

    backend = StubBackend(text="hello")
    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=backend,
    )
    assert processed == ["abc-1"]
    assert (ocr_root / "abc-1.json").exists()
    record = json.loads((ocr_root / "abc-1.json").read_text())
    assert record["text"] == "hello"
    assert record["model"] == "stub-model"
    assert ocr_state.contains("abc-1")


def test_skips_already_done(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "abc-1")
    ocr_state.write({"abc-1": {"ocr_at": "old", "model": "x"}})

    backend = StubBackend()
    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=backend,
    )
    assert processed == []
    assert backend.calls == []


def test_continues_after_backend_error(tmp_path: Path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    _seed_prepared(prepared, tmp_path / "png", "good-1")

    processed = run_ocr(
        prepared_state=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, log=stub_log, backend=FailingBackend(),
    )
    assert processed == []
    assert not ocr_state.contains("good-1")
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/stages/test_s3_ocr.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/stages/s3_ocr.py`**

```python
"""Stage 3: drive the OCR backend on every prepared page."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from desktop.lib.config import load_config
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.ocr_backends.base import OCRBackend, get_backend


def run_ocr(
    *,
    prepared_state: StateFile,
    ocr_state: StateFile,
    ocr_root: Path,
    log: StageLogger,
    backend: OCRBackend,
    force: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        ocr_state.remove(u)

    ocr_root.mkdir(parents=True, exist_ok=True)
    processed: list[str] = []

    for uuid, prep_info in prepared_state.read().items():
        if ocr_state.contains(uuid):
            continue
        png_path = Path(prep_info["png_path"])
        if not png_path.exists():
            log.error("png_missing", uuid=uuid, png_path=str(png_path))
            continue
        try:
            result = backend.ocr(png_path)
            (ocr_root / f"{uuid}.json").write_text(
                json.dumps(
                    {
                        "uuid": uuid,
                        "text": result.text,
                        "model": result.model,
                        "prompt_hash": result.prompt_hash,
                        "ts": result.ts.isoformat(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            ocr_state.update(
                {
                    uuid: {
                        "ocr_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "model": result.model,
                    }
                }
            )
            log.info("ocr_done", uuid=uuid, chars=len(result.text))
            processed.append(uuid)
        except Exception as e:
            log.error("ocr_failed", uuid=uuid, reason=str(e))
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    prepared_state = StateFile(cfg.data_dir / "state" / "prepared.json")
    ocr_state = StateFile(cfg.data_dir / "state" / "ocr-done.json")
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("s3_ocr", cfg.data_dir)

    if cfg.ocr.backend != "local_vlm" or cfg.ocr.local_vlm is None:
        print(f"Unsupported OCR backend in config: {cfg.ocr.backend}", file=sys.stderr)
        return 1

    backend = get_backend(
        cfg.ocr.backend,
        model_id=cfg.ocr.local_vlm.model_id,
        quantization=cfg.ocr.local_vlm.quantization,
        max_new_tokens=cfg.ocr.local_vlm.max_new_tokens,
        system_prompt_path=cfg.ocr.local_vlm.system_prompt_path,
    )

    processed = run_ocr(
        prepared_state=prepared_state,
        ocr_state=ocr_state,
        ocr_root=ocr_root,
        log=log,
        backend=backend,
        force=args.force,
    )
    print(f"s3_ocr: {len(processed)} pages OCR'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/stages/test_s3_ocr.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/stages/s3_ocr.py pipeline/tests/stages/test_s3_ocr.py
git commit -m "feat(pipeline): add stages/s3_ocr.py OCR driver"
```

---

## Task 15: `stages/s4_write.py` — Firestore writer + I1 mapping algorithm  [sequential after T2, T3, T5, T6, T7]

**Goal:** The critical milestone task. Implements the **I1 mapping algorithm** (spec §3): for each uuid in `state/ocr-done.json` not yet in `state/written.json`, decide the target tomboy-guid (overwrite vs. new note based on existing-title-marker presence vs. user-deletion), upload the page PNG to Dropbox, build the payload, write the doc, update mappings.

**Files:**
- Create: `pipeline/desktop/stages/s4_write.py`
- Create: `pipeline/tests/stages/test_s4_write.py`

**Acceptance Criteria:**
- [ ] **Mapping case "new uuid"**: no entry in `mappings.json` → mint a new guid, write a new doc, store `{rm_uuid: tomboy_guid}` in mappings
- [ ] **Mapping case "still marked"**: mapping exists, fetched note has `[<rm_uuid>]` in title and `deleted=False` → overwrite that doc (same guid, fresh `serverUpdatedAt`)
- [ ] **Mapping case "marker removed"**: mapping exists, fetched note title no longer contains `[<rm_uuid>]` → mint a new guid, write a new doc, refresh mapping to point at the new guid
- [ ] **Mapping case "doc deleted"**: mapping exists, `get_note` returns `None` OR returned doc has `deleted=True` → mint a new guid, refresh mapping (same as "marker removed")
- [ ] Image is uploaded to `/Apps/Tomboy/diary-images/{yyyy}/{mm}/{dd}/{rm_uuid}/page.png` before the Firestore write
- [ ] If image upload fails, NO Firestore write happens (fail-closed for the URL-404 risk noted in spec §7)
- [ ] `state/written.json` records `{rm_uuid: {written_at, tomboy_guid, image_url}}` after success
- [ ] Per-uuid try/except; one bad uuid does not abort the batch
- [ ] All four mapping cases have explicit tests

**Verify:** `cd pipeline && python -m pytest tests/stages/test_s4_write.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests (covers all 4 mapping cases + image-fail-closed)**

Create `pipeline/tests/stages/test_s4_write.py`:

```python
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s4_write import write_pending


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s4_write", tmp_path)


def _seed_uuid(
    *,
    tmp_path: Path,
    prepared: StateFile,
    ocr_state: StateFile,
    ocr_root: Path,
    rm_uuid: str,
    text: str = "ocr text",
    last_modified_ms: str = "1715337600000",  # 2024-05-10T12:00:00Z
) -> Path:
    """Stage all the inputs s4 expects for a uuid."""
    png = tmp_path / "png" / rm_uuid / "page.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(b"\x89PNG fake")
    prepared.update(
        {
            rm_uuid: {
                "prepared_at": "x",
                "png_path": str(png),
                "metadata": {"lastModified": last_modified_ms},
            }
        }
    )
    ocr_root.mkdir(parents=True, exist_ok=True)
    (ocr_root / f"{rm_uuid}.json").write_text(
        json.dumps({"text": text, "model": "m", "prompt_hash": "h", "ts": "t", "uuid": rm_uuid})
    )
    ocr_state.update({rm_uuid: {"ocr_at": "now", "model": "m"}})
    return png


def _build_clients(
    *,
    existing_doc: dict | None = None,
    upload_ok: bool = True,
):
    fs = MagicMock()
    fs.get_note.return_value = existing_doc

    dbx = MagicMock()
    if upload_ok:
        dbx.upload.return_value = MagicMock()
        dbx.share_link.return_value = "https://dropbox.example/page.png"
    else:
        dbx.upload.side_effect = RuntimeError("dropbox down")

    return fs, dbx


def test_new_uuid_creates_new_note(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")

    fs, dbx = _build_clients(existing_doc=None)

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert "rm-1" in out
    fs.set_note.assert_called_once()
    args, _ = fs.set_note.call_args
    new_guid = args[0]
    payload = args[1]
    assert "[rm-1]" in payload["title"]
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid


def test_still_marked_overwrites_same_guid(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "existing-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc={
        "guid": "existing-guid",
        "title": "2024-05-10 리마커블([rm-1])",
        "deleted": False,
    })

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert "rm-1" in out
    args, _ = fs.set_note.call_args
    assert args[0] == "existing-guid"  # SAME guid
    assert mappings.get("rm-1")["tomboy_guid"] == "existing-guid"


def test_marker_removed_creates_new_note(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    # User has corrected and removed the [rm-1] marker
    fs, dbx = _build_clients(existing_doc={
        "guid": "old-guid",
        "title": "2024년 5월 10일 — 일기 (corrected)",
        "deleted": False,
    })

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    new_guid = args[0]
    assert new_guid != "old-guid"
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid


def test_doc_missing_treated_as_deleted(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc=None)  # doc missing

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    new_guid = args[0]
    assert new_guid != "old-guid"


def test_doc_soft_deleted_treated_as_deleted(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    mappings.write({"rm-1": {"tomboy_guid": "old-guid", "first_seen": "2024-05-10T12:00:00+00:00"}})

    fs, dbx = _build_clients(existing_doc={
        "guid": "old-guid",
        "title": "2024-05-10 리마커블([rm-1])",
        "deleted": True,
    })

    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    args, _ = fs.set_note.call_args
    assert args[0] != "old-guid"


def test_image_upload_failure_blocks_firestore_write(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")

    fs, dbx = _build_clients(existing_doc=None, upload_ok=False)

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert out == []
    fs.set_note.assert_not_called()
    assert not written.contains("rm-1")


def test_skips_already_written(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, rm_uuid="rm-1")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": "u"}})

    fs, dbx = _build_clients()

    out = write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    assert out == []
    fs.set_note.assert_not_called()


def test_image_path_format(tmp_path, stub_log):
    """Image lands at /Apps/Tomboy/diary-images/yyyy/mm/dd/<rm_uuid>/page.png."""
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    ocr_state = StateFile(tmp_path / "state" / "ocr-done.json")
    written = StateFile(tmp_path / "state" / "written.json")
    mappings = StateFile(tmp_path / "state" / "mappings.json")
    ocr_root = tmp_path / "ocr"
    _seed_uuid(
        tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
        ocr_root=ocr_root, rm_uuid="rm-1",
        last_modified_ms="1715337600000",  # 2024-05-10T12:00:00Z
    )

    fs, dbx = _build_clients(existing_doc=None)
    write_pending(
        ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
        written_state=written, mappings=mappings,
        firestore=fs, dropbox=dbx, log=stub_log,
        notebook_name="일기", title_format="{date} 리마커블([{page_uuid}])",
    )

    target = dbx.upload.call_args.args[1]
    assert target == "/Apps/Tomboy/diary-images/2024/05/10/rm-1/page.png"
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/stages/test_s4_write.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/stages/s4_write.py`**

```python
"""Stage 4: write OCR'd pages to Firestore. Implements the I1 mapping algorithm.

Per spec §3:
  1. mapping miss → new guid
  2. mapping hit + title still has [rm_uuid] + not deleted → overwrite same guid
  3. mapping hit + title marker removed → new guid (user-protected)
  4. mapping hit + doc missing or deleted=True → new guid
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid as uuid_lib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol

from desktop.lib.config import load_config
from desktop.lib.dropbox_uploader import DropboxUploader
from desktop.lib.firestore_client import FirestoreClient
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.lib.tomboy_payload import build_payload


class _Firestore(Protocol):
    def get_note(self, guid: str) -> dict[str, Any] | None: ...
    def set_note(self, guid: str, payload: dict[str, Any]) -> None: ...


class _Dropbox(Protocol):
    def upload(self, local_path: Path, target_path: str) -> Any: ...
    def share_link(self, target_path: str) -> str: ...


def _resolve_target_guid(
    *,
    rm_uuid: str,
    mappings: StateFile,
    firestore: _Firestore,
) -> tuple[str, bool]:
    """Returns (target_guid, is_new). Implements the I1 algorithm."""
    existing = mappings.get(rm_uuid)
    if existing is None:
        return str(uuid_lib.uuid4()), True

    candidate_guid = existing["tomboy_guid"]
    doc = firestore.get_note(candidate_guid)
    if doc is None:
        # Doc missing — treat as protected/deleted; mint new
        return str(uuid_lib.uuid4()), True
    if doc.get("deleted") is True:
        return str(uuid_lib.uuid4()), True
    title = doc.get("title", "")
    if f"[{rm_uuid}]" not in title:
        # User removed the marker — protected; mint new
        return str(uuid_lib.uuid4()), True
    # Still marked, not deleted → overwrite
    return candidate_guid, False


def _ms_to_dt(ms_str: str) -> datetime:
    return datetime.fromtimestamp(int(ms_str) / 1000, tz=timezone.utc)


def write_pending(
    *,
    ocr_root: Path,
    prepared_state: StateFile,
    ocr_state: StateFile,
    written_state: StateFile,
    mappings: StateFile,
    firestore: _Firestore,
    dropbox: _Dropbox,
    log: StageLogger,
    notebook_name: str,
    title_format: str,
    force: Iterable[str] | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        written_state.remove(u)

    processed: list[str] = []
    prepared_index = prepared_state.read()

    for rm_uuid, _ in ocr_state.read().items():
        if written_state.contains(rm_uuid):
            continue
        ocr_path = ocr_root / f"{rm_uuid}.json"
        prep = prepared_index.get(rm_uuid)
        if not ocr_path.exists() or prep is None:
            log.error("inputs_missing", uuid=rm_uuid)
            continue
        try:
            ocr_data = json.loads(ocr_path.read_text(encoding="utf-8"))
            metadata = prep["metadata"]
            change_dt = _ms_to_dt(metadata["lastModified"])
            existing_mapping = mappings.get(rm_uuid)
            create_dt = (
                datetime.fromisoformat(existing_mapping["first_seen"])
                if existing_mapping and "first_seen" in existing_mapping
                else change_dt
            )

            # 1. Upload image FIRST. If this fails, no Firestore write happens.
            png_path = Path(prep["png_path"])
            target_path = (
                f"/Apps/Tomboy/diary-images/{change_dt:%Y/%m/%d}/{rm_uuid}/page.png"
            )
            dropbox.upload(png_path, target_path)
            image_url = dropbox.share_link(target_path)

            # 2. Resolve target guid via the I1 algorithm.
            target_guid, is_new = _resolve_target_guid(
                rm_uuid=rm_uuid, mappings=mappings, firestore=firestore
            )

            # 3. Build the payload.
            payload = build_payload(
                guid=target_guid,
                page_uuid=rm_uuid,
                ocr_text=ocr_data["text"],
                image_url=image_url,
                notebook_name=notebook_name,
                title_format=title_format,
                create_date=create_dt,
                change_date=change_dt,
            )

            # 4. Write doc.
            firestore.set_note(target_guid, payload)

            # 5. Update mappings + written state.
            mappings.update(
                {
                    rm_uuid: {
                        "tomboy_guid": target_guid,
                        "first_seen": create_dt.isoformat(),
                    }
                }
            )
            written_state.update(
                {
                    rm_uuid: {
                        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "tomboy_guid": target_guid,
                        "image_url": image_url,
                    }
                }
            )
            log.info(
                "wrote_note",
                uuid=rm_uuid,
                guid=target_guid,
                is_new=is_new,
            )
            processed.append(rm_uuid)
        except Exception as e:
            log.error("write_failed", uuid=rm_uuid, reason=str(e))
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--force", action="append", default=[])
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    prepared = StateFile(cfg.data_dir / "state" / "prepared.json")
    ocr_state = StateFile(cfg.data_dir / "state" / "ocr-done.json")
    written = StateFile(cfg.data_dir / "state" / "written.json")
    mappings = StateFile(cfg.data_dir / "state" / "mappings.json")
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("s4_write", cfg.data_dir)

    fs = FirestoreClient(cfg.firebase_uid, cfg.firebase_service_account)
    dbx = DropboxUploader(cfg.dropbox_refresh_token, cfg.dropbox_app_key)

    processed = write_pending(
        ocr_root=ocr_root,
        prepared_state=prepared,
        ocr_state=ocr_state,
        written_state=written,
        mappings=mappings,
        firestore=fs,
        dropbox=dbx,
        log=log,
        notebook_name=cfg.tomboy.diary_notebook_name,
        title_format=cfg.tomboy.title_format,
        force=args.force,
    )
    print(f"s4_write: {len(processed)} pages written to Firestore")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green**

```bash
cd pipeline && python -m pytest tests/stages/test_s4_write.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Manual e2e verification** (per spec §6 M3 milestone, do this once on a real page)

```bash
# 1. Run end-to-end
cd pipeline
python -m desktop.stages.s1_fetch
python -m desktop.stages.s2_prepare
python -m desktop.stages.s3_ocr
python -m desktop.stages.s4_write

# 2. Open the Tomboy web app → 전체 페이지 → confirm new note
#    Title: "2024-05-10 리마커블([uuid])"
#    Body: ocr text → "---" → dropbox URL

# 3. Modify the same page on rM, push, re-run pipeline.
#    Same Tomboy note should be updated (title still has [uuid]).

# 4. In the app, edit the note: change title to "2024-05-10 다이어리".
#    Modify rM page again, push, re-run pipeline.
#    A NEW Tomboy note should appear; the user-edited one is untouched.
```

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/stages/s4_write.py pipeline/tests/stages/test_s4_write.py
git commit -m "feat(pipeline): add stages/s4_write.py with I1 mapping algorithm"
```

---

## Task 16: `desktop/run_pipeline.py` — orchestrator  [sequential after T11, T12, T14, T15]

**Goal:** A thin wrapper that invokes s1 → s2 → s3 → s4 in order. Each stage runs to completion before the next starts. On stage failure, log and stop (don't keep running downstream stages on a known-broken upstream).

**Files:**
- Create: `pipeline/desktop/run_pipeline.py`
- Create: `pipeline/tests/test_run_pipeline.py`

**Acceptance Criteria:**
- [ ] `run_all(cfg)` calls each stage's `main`-equivalent function in order
- [ ] If a stage raises, subsequent stages are NOT invoked; the exception is logged and `run_all` returns the failed stage name
- [ ] `python -m desktop.run_pipeline --config <path>` is the CLI entry-point

**Verify:** `cd pipeline && python -m pytest tests/test_run_pipeline.py -v` → all green; manual: with a real config, `python -m desktop.run_pipeline` runs end-to-end.

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/test_run_pipeline.py`:

```python
from __future__ import annotations

from unittest.mock import MagicMock

from desktop.run_pipeline import run_all


def test_runs_stages_in_order():
    calls: list[str] = []
    stages = {
        "s1_fetch": lambda: calls.append("s1") or 0,
        "s2_prepare": lambda: calls.append("s2") or 0,
        "s3_ocr": lambda: calls.append("s3") or 0,
        "s4_write": lambda: calls.append("s4") or 0,
    }
    failed = run_all(stages=stages)
    assert calls == ["s1", "s2", "s3", "s4"]
    assert failed is None


def test_stops_on_first_failure():
    calls: list[str] = []

    def boom():
        calls.append("s2")
        raise RuntimeError("nope")

    stages = {
        "s1_fetch": lambda: calls.append("s1") or 0,
        "s2_prepare": boom,
        "s3_ocr": lambda: calls.append("s3") or 0,
        "s4_write": lambda: calls.append("s4") or 0,
    }
    failed = run_all(stages=stages)
    assert calls == ["s1", "s2"]
    assert failed == "s2_prepare"
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/test_run_pipeline.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/run_pipeline.py`**

```python
"""Orchestrator: run s1 → s2 → s3 → s4 in order."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable, Mapping


def run_all(stages: Mapping[str, Callable[[], int]]) -> str | None:
    """Returns the name of the first failing stage, or None on full success."""
    for name, fn in stages.items():
        try:
            fn()
        except Exception as e:
            sys.stderr.write(f"[run_pipeline] stage {name} failed: {e}\n")
            return name
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    args = parser.parse_args(argv)

    from desktop.stages import s1_fetch, s2_prepare, s3_ocr, s4_write

    stages = {
        "s1_fetch": lambda: s1_fetch.main(["--config", str(args.config)]),
        "s2_prepare": lambda: s2_prepare.main(["--config", str(args.config)]),
        "s3_ocr": lambda: s3_ocr.main(["--config", str(args.config)]),
        "s4_write": lambda: s4_write.main(["--config", str(args.config)]),
    }
    failed = run_all(stages=stages)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green + commit**

```bash
cd pipeline && python -m pytest tests/test_run_pipeline.py -v
git add pipeline/desktop/run_pipeline.py pipeline/tests/test_run_pipeline.py
git commit -m "feat(pipeline): add desktop/run_pipeline.py orchestrator"
```

---

## Task 17: `tools/extract_corrections.py` — collect fine-tuning triples  [parallel-eligible after T6]

**Goal:** For every `rm_uuid` whose mapped Tomboy note has had its `[<uuid>]` marker removed (= correction completed), pull the current note text, strip the title/separator/URL, and save the triple `corrections/<rm_uuid>/{page.png, ocr.txt, corrected.txt}`. Mark the uuid in `state/corrections.json` so re-runs are idempotent.

**Files:**
- Create: `pipeline/desktop/tools/extract_corrections.py`
- Create: `pipeline/tests/test_extract_corrections.py`

**Acceptance Criteria:**
- [ ] `extract(...)` iterates `mappings.json`; for each uuid, fetches the note, checks the title, and emits a triple if the marker is missing
- [ ] Skips uuids already in `state/corrections.json`
- [ ] `parse_corrected_text(xml_content)` extracts the OCR-text region (between blank line after title and `---` separator)
- [ ] Tests cover both: (a) marker present → no triple, (b) marker removed → triple emitted with correct file contents

**Verify:** `cd pipeline && python -m pytest tests/test_extract_corrections.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/test_extract_corrections.py`:

```python
from __future__ import annotations

import shutil
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.tools.extract_corrections import extract, parse_corrected_text


_NOTE_CONTENT = (
    '<note-content version="0.1">'
    "2024-05-10 다이어리\n\n"
    "교정된 첫째 줄\n교정된 둘째 줄\n\n"
    "---\n\n"
    "https://dropbox.example/page.png"
    "</note-content>"
)


def test_parse_corrected_text():
    text = parse_corrected_text(_NOTE_CONTENT)
    assert text == "교정된 첫째 줄\n교정된 둘째 줄"


def test_skips_marker_present(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    out_root = tmp_path / "corrections"
    png_root = tmp_path / "png"
    (png_root / "rm-1").mkdir(parents=True)
    (png_root / "rm-1" / "page.png").write_bytes(b"PNG")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    (ocr_root / "rm-1.json").write_text('{"text": "ocr"}')

    fs = MagicMock()
    fs.get_note.return_value = {
        "title": "2024-05-10 리마커블([rm-1])",  # marker present
        "xmlContent": _NOTE_CONTENT,
        "deleted": False,
    }
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    assert out == []
    assert not (out_root / "rm-1").exists()


def test_emits_triple_when_marker_removed(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    out_root = tmp_path / "corrections"
    png_root = tmp_path / "png"
    (png_root / "rm-1").mkdir(parents=True)
    (png_root / "rm-1" / "page.png").write_bytes(b"PNG-bytes")
    ocr_root = tmp_path / "ocr"
    ocr_root.mkdir()
    (ocr_root / "rm-1.json").write_text('{"text": "원본 ocr"}')

    fs = MagicMock()
    fs.get_note.return_value = {
        "title": "2024-05-10 다이어리",  # marker REMOVED
        "xmlContent": _NOTE_CONTENT,
        "deleted": False,
    }
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    assert "rm-1" in out
    triple = out_root / "rm-1"
    assert (triple / "page.png").read_bytes() == b"PNG-bytes"
    assert (triple / "ocr.txt").read_text() == "원본 ocr"
    assert (triple / "corrected.txt").read_text() == "교정된 첫째 줄\n교정된 둘째 줄"
    assert corrections_state.contains("rm-1")


def test_idempotent(tmp_path: Path):
    mappings = StateFile(tmp_path / "mappings.json")
    mappings.write({"rm-1": {"tomboy_guid": "g1", "first_seen": "2024-01-01T00:00:00+00:00"}})
    corrections_state = StateFile(tmp_path / "corrections.json")
    corrections_state.write({"rm-1": {"corrected": True}})
    fs = MagicMock()
    log = StageLogger("extract_corrections", tmp_path)

    out = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=tmp_path / "out", png_root=tmp_path / "png", ocr_root=tmp_path / "ocr",
        firestore=fs, log=log,
    )
    assert out == []
    fs.get_note.assert_not_called()
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/test_extract_corrections.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/tools/extract_corrections.py`**

```python
"""Extract (page.png, ocr.txt, corrected.txt) triples for fine-tuning."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from desktop.lib.config import load_config
from desktop.lib.firestore_client import FirestoreClient
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile


class _Firestore(Protocol):
    def get_note(self, guid: str) -> dict[str, Any] | None: ...


_NOTE_CONTENT_RE = re.compile(
    r'<note-content[^>]*>(.*?)</note-content>', re.DOTALL
)


def parse_corrected_text(xml_content: str) -> str:
    """Extract the OCR-text region: between the title's blank line and the
    `---` separator. The body shape is fixed by I7."""
    m = _NOTE_CONTENT_RE.search(xml_content)
    inner = m.group(1) if m else xml_content
    # The structure (per I7): title, blank, body, blank, ---, blank, url
    # Split on '---' and take the first chunk; its content after the title.
    parts = inner.split("\n---\n", 1)
    head = parts[0]
    lines = head.split("\n")
    # Drop the title line + the blank line separator after it.
    if len(lines) >= 2 and lines[1] == "":
        body = "\n".join(lines[2:]).strip()
    else:
        body = "\n".join(lines[1:]).strip()
    return body


def extract(
    *,
    mappings: StateFile,
    corrections_state: StateFile,
    out_root: Path,
    png_root: Path,
    ocr_root: Path,
    firestore: _Firestore,
    log: StageLogger,
) -> list[str]:
    out_root.mkdir(parents=True, exist_ok=True)
    extracted: list[str] = []
    for rm_uuid, info in mappings.read().items():
        if corrections_state.contains(rm_uuid):
            continue
        try:
            doc = firestore.get_note(info["tomboy_guid"])
            if doc is None or doc.get("deleted"):
                continue
            title = doc.get("title", "")
            if f"[{rm_uuid}]" in title:
                # Marker still present — user hasn't finished correcting.
                continue
            corrected = parse_corrected_text(doc.get("xmlContent", ""))
            triple_dir = out_root / rm_uuid
            triple_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(png_root / rm_uuid / "page.png", triple_dir / "page.png")
            ocr_record = json.loads((ocr_root / f"{rm_uuid}.json").read_text(encoding="utf-8"))
            (triple_dir / "ocr.txt").write_text(ocr_record["text"], encoding="utf-8")
            (triple_dir / "corrected.txt").write_text(corrected, encoding="utf-8")
            corrections_state.update(
                {
                    rm_uuid: {
                        "corrected": True,
                        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    }
                }
            )
            log.info("triple_extracted", uuid=rm_uuid)
            extracted.append(rm_uuid)
        except Exception as e:
            log.error("extract_failed", uuid=rm_uuid, reason=str(e))
    return extracted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    mappings = StateFile(cfg.data_dir / "state" / "mappings.json")
    corrections_state = StateFile(cfg.data_dir / "state" / "corrections.json")
    out_root = cfg.data_dir / "corrections"
    png_root = cfg.data_dir / "png"
    ocr_root = cfg.data_dir / "ocr"
    log = StageLogger("extract_corrections", cfg.data_dir)
    fs = FirestoreClient(cfg.firebase_uid, cfg.firebase_service_account)

    extracted = extract(
        mappings=mappings, corrections_state=corrections_state,
        out_root=out_root, png_root=png_root, ocr_root=ocr_root,
        firestore=fs, log=log,
    )
    print(f"extract_corrections: {len(extracted)} triples emitted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests — confirm green + commit**

```bash
cd pipeline && python -m pytest tests/test_extract_corrections.py -v
git add pipeline/desktop/tools/extract_corrections.py pipeline/tests/test_extract_corrections.py
git commit -m "feat(pipeline): add tools/extract_corrections.py fine-tuning triples"
```

---

## Task 18: `tools/segment_lines.py` — sliced line crops from `.rm` strokes  [parallel-eligible after T2]

**Goal:** Given a uuid that already has both `raw/<uuid>/<uuid>.rm` and `corrections/<uuid>/page.png`, parse the `.rm` strokes, cluster them by Y-coordinate into lines, and crop `page.png` to per-line PNGs at `corrections/<uuid>/lines/line-XX.png`. Run on demand at fine-tuning prep time, NOT in the main pipeline.

**Files:**
- Create: `pipeline/desktop/tools/segment_lines.py`
- Create: `pipeline/tests/test_segment_lines.py`

**Acceptance Criteria:**
- [ ] `cluster_strokes_by_y(strokes, line_threshold)` groups strokes whose Y-bbox-centers fall within `line_threshold` pixels into the same line
- [ ] Returns a list of `(y_min, y_max)` tuples sorted top-to-bottom
- [ ] `crop_lines(page_png, line_bands, out_dir)` writes `line-01.png`, `line-02.png`, ... cropped from `page_png`
- [ ] `parse_rm_strokes(rm_path)` is a Protocol seam — tests use a fake parser
- [ ] CLI: `python -m desktop.tools.segment_lines --uuid <id>`

**Verify:** `cd pipeline && python -m pytest tests/test_segment_lines.py -v` → all green

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `pipeline/tests/test_segment_lines.py`:

```python
from __future__ import annotations

from pathlib import Path

from desktop.tools.segment_lines import Stroke, cluster_strokes_by_y, crop_lines


def test_cluster_groups_close_strokes():
    strokes = [
        Stroke(y_min=10, y_max=30),
        Stroke(y_min=12, y_max=28),
        Stroke(y_min=200, y_max=230),
        Stroke(y_min=205, y_max=232),
    ]
    bands = cluster_strokes_by_y(strokes, line_threshold=50)
    assert len(bands) == 2
    assert bands[0] == (10, 30)
    assert bands[1] == (200, 232)


def test_cluster_handles_overlap():
    strokes = [
        Stroke(y_min=0, y_max=20),
        Stroke(y_min=15, y_max=40),  # overlaps with #1
    ]
    bands = cluster_strokes_by_y(strokes, line_threshold=10)
    assert len(bands) == 1
    assert bands[0] == (0, 40)


def test_crop_lines_writes_per_line_pngs(tmp_path: Path):
    # Create a 100x300 white PNG
    from PIL import Image

    page = tmp_path / "page.png"
    Image.new("RGB", (100, 300), "white").save(page)
    out_dir = tmp_path / "lines"
    bands = [(0, 100), (150, 250)]
    crop_lines(page, bands, out_dir)
    files = sorted(out_dir.glob("line-*.png"))
    assert [f.name for f in files] == ["line-01.png", "line-02.png"]
    img = Image.open(files[0])
    assert img.size[1] == 100
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd pipeline && python -m pytest tests/test_segment_lines.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `desktop/tools/segment_lines.py`**

```python
"""Per-line crop tool for fine-tuning data prep. Run on demand, not in pipeline.

The .rm parser is plug-in. The default uses ``rmrl``'s stroke iterator if
available; tests inject a fake by passing a stroke list directly.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class Stroke:
    y_min: float
    y_max: float


def cluster_strokes_by_y(
    strokes: list[Stroke], *, line_threshold: float
) -> list[tuple[float, float]]:
    """Sort strokes by y_min, then greedily merge into bands when the next
    stroke's y_min is within ``line_threshold`` of the current band's y_max."""
    if not strokes:
        return []
    sorted_strokes = sorted(strokes, key=lambda s: s.y_min)
    bands: list[list[float]] = [[sorted_strokes[0].y_min, sorted_strokes[0].y_max]]
    for s in sorted_strokes[1:]:
        cur = bands[-1]
        if s.y_min - cur[1] <= line_threshold:
            cur[1] = max(cur[1], s.y_max)
        else:
            bands.append([s.y_min, s.y_max])
    return [(b[0], b[1]) for b in bands]


def crop_lines(
    page_png: Path, line_bands: list[tuple[float, float]], out_dir: Path
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    page = Image.open(page_png)
    width, _ = page.size
    for i, (y_min, y_max) in enumerate(line_bands, start=1):
        crop = page.crop((0, int(y_min), width, int(y_max)))
        crop.save(out_dir / f"line-{i:02d}.png")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--config", type=Path, default=Path("config/pipeline.yaml"))
    parser.add_argument("--threshold", type=float, default=20.0)
    args = parser.parse_args(argv)

    from desktop.lib.config import load_config

    cfg = load_config(args.config)
    rm_path = cfg.data_dir / "raw" / args.uuid / f"{args.uuid}.rm"
    page_png = cfg.data_dir / "corrections" / args.uuid / "page.png"
    out_dir = cfg.data_dir / "corrections" / args.uuid / "lines"

    # Stroke extraction is implementation-defined; the implementer wires a
    # real parser here. For now, this CLI requires the user to pre-supply
    # strokes via a fixture or to extend with rmrl's stroke iterator.
    print(f"segment_lines: TODO wire real .rm parser for {rm_path}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

> **Note on the CLI**: this tool's CLI is a stub that surfaces the next decision point — pick a `.rm` stroke parser library at fine-tuning time. The unit-tested core (`cluster_strokes_by_y`, `crop_lines`) is the part that matters; the CLI wrapper around a real parser is finalized only when the user actually needs to prep training data.

- [ ] **Step 4: Run tests — confirm green + commit**

```bash
cd pipeline && python -m pytest tests/test_segment_lines.py -v
git add pipeline/desktop/tools/segment_lines.py pipeline/tests/test_segment_lines.py
git commit -m "feat(pipeline): add tools/segment_lines.py line clustering core"
```

---

## Task 19: README, CLAUDE.md, deploy units  [docs only — no TDD]

**Goal:** Final documentation + deploy artifacts. Update `pipeline/README.md` with the actually-validated workflow; add a `## reMarkable diary OCR pipeline` section to the project's `CLAUDE.md`; create `desktop/deploy/desktop-pipeline.{service,timer}` user units (deferred per spec — added but not enabled by default).

**Files:**
- Modify: `pipeline/README.md` (replace skeleton with real workflow)
- Modify: `CLAUDE.md` (root) — append pipeline section
- Create: `pipeline/desktop/deploy/desktop-pipeline.service`
- Create: `pipeline/desktop/deploy/desktop-pipeline.timer`

**Acceptance Criteria:**
- [ ] README walks through bootstrap → first run → re-run → correction extraction with concrete commands
- [ ] CLAUDE.md gains a pipeline section linking the spec and skill (if a skill is added later)
- [ ] systemd user units installable via `systemctl --user enable --now desktop-pipeline.timer`
- [ ] Timer fires every 30 minutes; not enabled by default (user opts in)

**Verify:** Manual review of README + CLAUDE.md.

**Steps:**

- [ ] **Step 1: Replace `pipeline/README.md`** with a comprehensive workflow doc covering:
  - Prerequisites (Bazzite + GPU + Pi + rM)
  - Initial setup: `python3 -m venv .venv && pip install -e .[dev,firebase,dropbox,prepare,vlm]`
  - Bootstrap: `python -m desktop.bootstrap`
  - Manual run: `python -m desktop.run_pipeline`
  - Per-stage debug: each `python -m desktop.stages.<name>` command
  - Correction workflow: edit note → remove `[uuid]` from title → `python -m desktop.tools.extract_corrections`
  - systemd timer enablement (deferred / optional)
  - Troubleshooting: VLM OOM, Pi WAN reachability, Firestore permission errors

- [ ] **Step 2: Append to root `CLAUDE.md`**

After the existing `## 터미널 노트` section, add:

````markdown

## 리마커블 일기 OCR 파이프라인 (pipeline/)

`pipeline/`은 reMarkable에서 손글씨로 쓴 일기 페이지를 OCR해서 Tomboy 노트로
넣는 별도 파이프라인. 3개 머신을 거침: rM 태블릿 → 라즈베리파이(24/7 인박스) →
데스크탑(Bazzite + RTX 3080) → Firestore.

설계 문서:
`docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`.
구현 계획: `docs/superpowers/plans/2026-05-10-remarkable-diary-pipeline.md`.

핵심 invariant — **노트 제목 안의 `[<rm-page-uuid>]` 마커가 매핑 키 + 보호 신호**.
사용자가 교정 후 제목에서 uuid를 제거하면 같은 페이지를 다시 OCR해도 그 노트는
덮어쓰이지 않고 새 노트가 생김. 다른 보호 메커니즘 없음 (단순함이 핵심).

빠른 지도:

- `pipeline/desktop/stages/{s1_fetch, s2_prepare, s3_ocr, s4_write}.py` — 4단계.
- `pipeline/desktop/lib/{config, state, log, tomboy_payload, firestore_client, dropbox_uploader}.py` — 공유 모듈.
- `pipeline/desktop/ocr_backends/{base, local_vlm}.py` — Plugin 인터페이스 + Qwen2.5-VL-7B 구현.
- `pipeline/desktop/tools/{extract_corrections, segment_lines}.py` — fine-tuning 데이터 준비.
- `pipeline/pi/inbox_watcher.py` + `pipeline/pi/deploy/` — Pi 측 인박스.
- `pipeline/config/pipeline.yaml` (gitignore) — `bootstrap.py`로 1회 생성.

Firestore 쓰기는 `users/{uid}/notes/{guid}` 네임스페이스를 앱과 공유 (uid는
`dbx-{sanitized account_id}` 형식). 노트북 멤버십은 `system:notebook:일기` 태그로
표현 — 앱의 `FirestoreNotePayload` 형식과 동일. Dropbox는 이미지 호스팅
전용 (`/Apps/Tomboy/diary-images/...`); 노트 본문엔 공유 링크 URL만.
````

- [ ] **Step 3: Create systemd user units**

`pipeline/desktop/deploy/desktop-pipeline.service`:

```ini
[Unit]
Description=Tomboy diary OCR pipeline run

[Service]
Type=oneshot
WorkingDirectory=%h/workspace/tomboy-web/pipeline
ExecStart=%h/workspace/tomboy-web/pipeline/.venv/bin/python -m desktop.run_pipeline
StandardOutput=journal
StandardError=journal
```

`pipeline/desktop/deploy/desktop-pipeline.timer`:

```ini
[Unit]
Description=Run the Tomboy diary OCR pipeline every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
Unit=desktop-pipeline.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/README.md CLAUDE.md pipeline/desktop/deploy/
git commit -m "docs(pipeline): finalize README + CLAUDE.md + deferred systemd units"
```

---

## Self-Review

**Spec coverage check:**

- §3 invariants → I1 covered by T15 (4 mapping cases tested), I2 covered structurally (each stage as standalone module + `--uuid` / `--force` flags), I3 covered by T2 + state files referenced in every stage, I4 covered by T4 + T13, I5 covered by T2 + T12 + T18 (no line cropping in main flow), I6 covered by T15 (Firestore-only) + T7 (Dropbox is image-only), I7 covered by T5 (note body format) + verified in test_build_note_content_xml.
- §4 components → all 8 implemented: rM-side push (T10 docs), Pi inbox watcher (T9), 4 stages (T11-T15), tomboy_payload (T5), firestore_client (T6), dropbox_uploader (T7), tools (T17, T18), bootstrap (T8).
- §5 config keys → T1 implements every field, T0 + T1 contribute the example YAML.
- §6 milestones → mapped: M0=T0-T8, M1=T9-T10, M2=T11-T12, M3=T13-T15, M4=T17-T18, plus T16+T19.
- §7 error handling → per-uuid try/except in every stage; image-fail-closed in T15 (`test_image_upload_failure_blocks_firestore_write`); JSONL+human logs in T3.
- §8 testing strategy → unit tests on payload (T5), state (T2), I1 mapping (T15), config (T1), backend interface (T4); manual e2e at M3 (T15 step 5).
- §9 open decisions → all explicitly listed in spec, none silently assumed: VLM prompt is in T13 (`config/prompts/diary-ko.txt`), rM-side push specifics live in T10 docs.

**Placeholder scan**: `segment_lines.main` is intentionally a stub (T18) — but documented inline as "next decision point". This is honest deferral, not a placeholder failure. No "TBD/TODO/handle edge cases/etc." patterns found.

**Type consistency**: `mappings.json` shape is `{rm_uuid: {tomboy_guid, first_seen}}` consistently across T15, T17. `state/written.json` is `{rm_uuid: {written_at, tomboy_guid, image_url}}` (T15). `state/prepared.json` is `{rm_uuid: {prepared_at, png_path, metadata}}` (T12, consumed by T14 + T15). `OCRResult` fields `(text, model, prompt_hash, ts)` consistent across T4, T13, T14. `FirestoreNotePayload` fields cross-checked against `app/src/lib/sync/firebase/notePayload.ts` in T5.

No fixes needed.

---

## Subagent Dispatch Strategy

Per the user's mandate to use sonnet subagents for parallel work, the recommended dispatch order is:

| Wave | Tasks | Notes |
|------|-------|-------|
| **A** | T0 (alone — sequential, scaffolding) | Coordinator runs this directly OR dispatches to one sonnet. |
| **B** | T1 + T2 + T3 + T4 (4 in parallel) | All independent lib modules / interfaces. Single message with 4 Agent calls. |
| **C** | T5 + T7 + T9 + T11 + T12 (5 in parallel) | After Wave B. T11 & T12 only need T1-T3 which are all done. |
| **D** | T6 + T13 (2 in parallel) | T6 needs T5; T13 needs T4. |
| **E** | T8 + T14 (2 in parallel) | T8 needs T6+T7; T14 needs T13. |
| **F** | T15 alone | Critical mapping logic — dispatch solo, review carefully. |
| **G** | T16 + T17 + T18 (3 in parallel) | After T15. |
| **H** | T19 (alone, docs) | Final wiring. |
| **I** | T10 (docs, can be parallel with B-G or solo at end) | Minimal coupling; the user-mandated dispatcher can place this anywhere after T9. |

When dispatching, each subagent receives:
1. Pointer to this plan file at the specific task ID.
2. Pointer to the spec.
3. The acceptance criteria block.
4. A reminder to follow TDD strictly (red → green → commit) and verify with the listed pytest command before claiming done.

---

## Final Notes

- **Subagent prompts must be self-contained.** Don't write "based on the plan, implement Task N" — paste the task's full code blocks into the prompt so the subagent doesn't have to interpret.
- **Trust but verify.** After each subagent reports done, the coordinator runs the task's verify command before marking the native task completed.
- **One task = one commit.** This plan's commit messages are spelled out per task; agents must use the exact message format for clean history.
- **Failure recovery.** A subagent that fails its verify command leaves its task in `in_progress` with the error logged; the coordinator either re-dispatches with corrections or escalates to the user.


