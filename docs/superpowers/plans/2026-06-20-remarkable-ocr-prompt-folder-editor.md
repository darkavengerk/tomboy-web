# 앱에서 리마커블 OCR 프롬프트·폴더 편집 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱 설정(리마커블 탭)에서 리마커블 OCR의 폴더별 프롬프트·라우팅을 보고 편집해 데스크탑 trigger 서버 경유로 `folders.yaml`에 저장하고, s3 OCR이 페이지의 source 폴더에 맞는 프롬프트를 사용하게 한다.

**Architecture:** 데스크탑 `pipeline/config/folders.yaml`(앱 관리 오버레이)이 `pipeline.yaml`의 `tomboy` 라우팅 위에 덮인다. `config.py`가 로드 시 오버레이하고, `s3_ocr`이 페이지별 `source_folder`로 프롬프트를 골라 `OCRBackend.ocr(..., system_prompt=)`로 넘긴다. 데스크탑 `trigger_server.py`에 `GET/PUT /config`를 추가하고(기존 Bearer+CORS 재사용), 앱은 기존 `diaryTriggerUrl/Token`으로 그 엔드포인트를 호출한다.

**Tech Stack:** Python(파이프라인 + stdlib HTTP), pytest. SvelteKit 5 runes + vitest(앱).

---

### Task 1: `folders.yaml` 오버레이 + 폴더별 프롬프트 (config.py)

**Goal:** `FolderRoute.prompt` / `TomboyConfig.default_prompt` 필드 추가, `load_config`가 `folders.yaml`을 오버레이, `TomboyConfig.prompt_for(source_folder)` 헬퍼 추가.

**Files:**
- Modify: `pipeline/desktop/lib/config.py`
- Test: `pipeline/tests/lib/test_config.py`
- Modify: `.gitignore`, `pipeline/.gitignore`

**Acceptance Criteria:**
- [ ] `FolderRoute`에 `prompt: str = ""` 추가; `TomboyConfig`에 `default_prompt: str = ""` 추가.
- [ ] `folders.yaml`이 `pipeline.yaml`과 같은 디렉터리에 있으면 폴더별 부분 오버라이드 + `default_prompt` 적용. 우선순위 `folders.yaml > pipeline.yaml tomboy.folders > DEFAULT_FOLDER_ROUTES`.
- [ ] 파일 부재 시 기존 동작 그대로.
- [ ] `prompt_for(folder)` = 폴더 prompt(비어있지 않으면) → default_prompt(비어있지 않으면) → `None`.
- [ ] `pipeline/config/folders.yaml`이 gitignore에 추가됨.

**Verify:** `pipeline/.venv/bin/python -m pytest tests/lib/test_config.py -q` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests** — append to `pipeline/tests/lib/test_config.py`:

```python
import textwrap
from pathlib import Path
from desktop.lib.config import load_config, TomboyConfig, DEFAULT_FOLDER_ROUTES

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
    # Notes: prompt overridden, notebook untouched (from DEFAULT)
    assert cfg.tomboy.folders["Notes"].prompt == "노트 전용 프롬프트"
    assert cfg.tomboy.folders["Notes"].notebook == DEFAULT_FOLDER_ROUTES["Notes"].notebook
    # brand-new folder added by overlay
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
    assert cfg.tomboy.prompt_for("Diary") == "DIARY"   # folder prompt
    assert cfg.tomboy.prompt_for("Notes") == "DEF"      # empty folder → default
    assert cfg.tomboy.prompt_for("Unknown") == "DEF"    # unknown folder → fallback route → default


def test_prompt_for_none_when_no_prompts(tmp_path):
    cfg = load_config(_write_pipeline(tmp_path))
    assert cfg.tomboy.prompt_for("Diary") is None
```

- [ ] **Step 2: Run — expect FAIL** (`prompt` attr / `default_prompt` / overlay missing):

Run: `cd pipeline && .venv/bin/python -m pytest tests/lib/test_config.py -q`
Expected: FAIL (`TypeError`/`AttributeError`).

- [ ] **Step 3: Implement** — in `pipeline/desktop/lib/config.py`:

Add `from dataclasses import dataclass, replace` (extend existing import). Add `prompt` to `FolderRoute`:

```python
@dataclass(frozen=True)
class FolderRoute:
    notebook: str
    title_format: str
    split: bool = False
    labels: tuple[str, ...] = ()
    prompt: str = ""
```

Add `default_prompt` + `prompt_for` to `TomboyConfig` (keep existing `route_for`/`from_dict`):

```python
@dataclass(frozen=True)
class TomboyConfig:
    folders: dict[str, FolderRoute]
    diary_notebook_name: str = "일기"
    title_format: str = "{date} 리마커블([{page_uuid}])"
    default_prompt: str = ""

    def prompt_for(self, source_folder: str | None) -> str | None:
        route = self.route_for(source_folder)
        if route.prompt.strip():
            return route.prompt
        if self.default_prompt.strip():
            return self.default_prompt
        return None
```

Add overlay applier (module-level, after `TomboyConfig`):

```python
def apply_folders_overlay(tomboy: TomboyConfig, overlay: dict) -> TomboyConfig:
    """folders.yaml 오버레이를 기존 TomboyConfig 위에 적용. 폴더별 부분
    오버라이드 — 명시 안 한 키는 하위 계층 값을 유지한다."""
    folders = dict(tomboy.folders)
    default_prompt = tomboy.default_prompt
    dp = overlay.get("default_prompt")
    if isinstance(dp, str):
        default_prompt = dp
    for name, fd in (overlay.get("folders") or {}).items():
        base = folders.get(name)
        folders[name] = FolderRoute(
            notebook=fd.get("notebook", base.notebook if base else "기록"),
            title_format=fd.get(
                "title_format", base.title_format if base else "{date} 리마커블([{unit_key}])"
            ),
            split=bool(fd.get("split", base.split if base else False)),
            labels=tuple(fd.get("labels", base.labels if base else ()) or ()),
            prompt=fd.get("prompt", base.prompt if base else ""),
        )
    return replace(tomboy, folders=folders, default_prompt=default_prompt)
```

Change `load_config` to overlay:

```python
def load_config(path: Path | str) -> Config:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}")
    cfg = load_config_from_string(p.read_text(encoding="utf-8"))
    overlay_path = p.parent / "folders.yaml"
    if overlay_path.exists():
        overlay = yaml.safe_load(overlay_path.read_text(encoding="utf-8")) or {}
        cfg = replace(cfg, tomboy=apply_folders_overlay(cfg.tomboy, overlay))
    return cfg
```

(`replace` is `dataclasses.replace`; `Config` is a frozen dataclass.)

- [ ] **Step 4: Run — expect PASS**

Run: `cd pipeline && .venv/bin/python -m pytest tests/lib/test_config.py -q`
Expected: PASS.

- [ ] **Step 5: gitignore** — add line `pipeline/config/folders.yaml` under the Pipeline block of root `.gitignore` (after `pipeline/config/pipeline.yaml`), and `config/folders.yaml` under the secrets block of `pipeline/.gitignore` (after `config/pipeline.yaml`).

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/lib/config.py pipeline/tests/lib/test_config.py .gitignore pipeline/.gitignore
git commit -m "feat(pipeline): folders.yaml 오버레이 + 폴더별 프롬프트 (config)"
```

---

### Task 2: 백엔드 per-call `system_prompt` 오버라이드

**Goal:** `OCRBackend.ocr`에 선택 인자 `system_prompt: str | None = None` 추가; `claude.py`/`local_vlm.py`가 주어지면 사용하고 `prompt_hash`를 실제 프롬프트로 재계산. 미지정 시 생성자 기본값(하위호환).

**Files:**
- Modify: `pipeline/desktop/ocr_backends/base.py`, `pipeline/desktop/ocr_backends/claude.py`, `pipeline/desktop/ocr_backends/local_vlm.py`
- Test: `pipeline/tests/ocr_backends/test_claude.py`, `pipeline/tests/ocr_backends/test_local_vlm.py`

**Acceptance Criteria:**
- [ ] `ocr(image_path, system_prompt=None)` 시그니처 — 기존 호출(인자 없음)은 동작 동일.
- [ ] `system_prompt` 주어지면 claude는 요청 body의 `system`이 그 값, local_vlm은 `_run_inference`에 그 값 전달.
- [ ] `prompt_hash`가 오버라이드 프롬프트 기준으로 바뀜.

**Verify:** `pipeline/.venv/bin/python -m pytest tests/ocr_backends/ -q` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Append to `pipeline/tests/ocr_backends/test_claude.py`:

```python
def test_claude_ocr_uses_override_system_prompt(tmp_path, monkeypatch):
    from desktop.ocr_backends.claude import ClaudeBackend
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    prompt_file = tmp_path / "sys.txt"
    prompt_file.write_text("DEFAULT SYS", encoding="utf-8")
    b = ClaudeBackend(
        service_url="http://x", service_token="t", model="", effort="high",
        system_prompt_path=str(prompt_file),
    )
    captured = {}
    def fake_post(body):
        captured["system"] = body["system"]
        return "텍스트"
    monkeypatch.setattr(b, "_post_with_retry", fake_post)

    r_default = b.ocr(img)
    assert captured["system"] == "DEFAULT SYS"
    r_override = b.ocr(img, system_prompt="폴더 전용 SYS")
    assert captured["system"] == "폴더 전용 SYS"
    assert r_override.prompt_hash != r_default.prompt_hash
```

Append to `pipeline/tests/ocr_backends/test_local_vlm.py`:

```python
def test_local_vlm_ocr_uses_override_system_prompt(tmp_path, monkeypatch):
    from desktop.ocr_backends.local_vlm import LocalVlmBackend
    img = tmp_path / "p.png"
    img.write_bytes(b"x")
    prompt_file = tmp_path / "sys.txt"
    prompt_file.write_text("DEFAULT", encoding="utf-8")
    b = LocalVlmBackend(
        model_id="m", quantization="none", max_new_tokens=8,
        system_prompt_path=str(prompt_file),
    )
    seen = {}
    monkeypatch.setattr(b, "_run_inference", lambda path, prompt: seen.setdefault("p", prompt) or "out")
    b.ocr(img)
    assert seen["p"] == "DEFAULT"
    seen.clear()
    r = b.ocr(img, system_prompt="OVERRIDE")
    assert seen["p"] == "OVERRIDE"
```

- [ ] **Step 2: Run — expect FAIL** (`ocr() got unexpected keyword 'system_prompt'`):

Run: `cd pipeline && .venv/bin/python -m pytest tests/ocr_backends/ -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

`base.py` — change the abstract signature:

```python
    @abstractmethod
    def ocr(self, image_path: Path, system_prompt: str | None = None) -> OCRResult:
        """Run OCR on a single image. ``system_prompt`` overrides the
        backend's constructor default for this call only (per-folder prompt).
        Implementations may be slow (loads ML models on first call)."""
```

`claude.py` — add module helper + use override. Replace the `__init__` hash line and the `ocr` method:

```python
def _hash_prompt(system: str) -> str:
    return hashlib.sha256(
        (system + "\n---\n" + _USER_PROMPT).encode("utf-8")
    ).hexdigest()[:12]
```

In `__init__` replace the `self._prompt_hash = ...` block with:

```python
        self._prompt_hash = _hash_prompt(self._system)
```

Replace `ocr`:

```python
    def ocr(self, image_path: Path, system_prompt: str | None = None) -> OCRResult:
        system = system_prompt if system_prompt is not None else self._system
        b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
        body = {
            "model": self._model,
            "system": system,
            "effort": self._effort,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": _USER_PROMPT},
                    ],
                }
            ],
        }
        text = self._post_with_retry(body)
        model_label = self._model if self._model else "default"
        prompt_hash = self._prompt_hash if system_prompt is None else _hash_prompt(system)
        return OCRResult(
            text=text,
            model=f"claude:{model_label}",
            prompt_hash=prompt_hash,
            ts=datetime.now(timezone.utc),
        )
```

`local_vlm.py` — replace `ocr`:

```python
    def ocr(self, image_path: Path, system_prompt: str | None = None) -> OCRResult:
        system = system_prompt if system_prompt is not None else self.system_prompt
        text = self._run_inference(image_path, system).strip()
        prompt_hash = (
            self._prompt_hash
            if system_prompt is None
            else hashlib.sha256(system.encode("utf-8")).hexdigest()
        )
        return OCRResult(
            text=text,
            model=self.model_id,
            prompt_hash=prompt_hash,
            ts=datetime.now(timezone.utc),
        )
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd pipeline && .venv/bin/python -m pytest tests/ocr_backends/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/ocr_backends/ pipeline/tests/ocr_backends/
git commit -m "feat(pipeline): OCR 백엔드 per-call system_prompt 오버라이드"
```

---

### Task 3: s3가 폴더별 프롬프트 해석·전달

**Goal:** `s3_ocr.run_ocr`이 페이지의 `source_folder`로 프롬프트를 골라 `backend.ocr(png, system_prompt=...)`로 전달. `main()`이 `cfg.tomboy.prompt_for`를 주입.

**Files:**
- Modify: `pipeline/desktop/stages/s3_ocr.py`
- Test: `pipeline/tests/stages/test_s3_ocr.py`

**Acceptance Criteria:**
- [ ] `run_ocr`에 `prompt_for: Callable[[str | None], str | None] | None = None` 추가.
- [ ] 페이지마다 `prep_info.get("source_folder")`로 프롬프트를 골라 `backend.ocr(png, system_prompt=...)` 호출.
- [ ] `prompt_for` 미지정 시 `system_prompt=None`(기존 동작).
- [ ] `main()`이 `prompt_for=cfg.tomboy.prompt_for` 전달.

**Verify:** `pipeline/.venv/bin/python -m pytest tests/stages/test_s3_ocr.py -q` → all pass

**Steps:**

- [ ] **Step 1: Write failing test** — append to `pipeline/tests/stages/test_s3_ocr.py`:

```python
def test_run_ocr_passes_per_folder_prompt(tmp_path):
    from datetime import datetime, timezone
    from desktop.lib.state import StateFile
    from desktop.lib.log import StageLogger
    from desktop.ocr_backends.base import OCRBackend, OCRResult
    from desktop.stages.s3_ocr import run_ocr

    png_a = tmp_path / "a.png"; png_a.write_bytes(b"a")
    png_b = tmp_path / "b.png"; png_b.write_bytes(b"b")
    prepared = StateFile(tmp_path / "prepared.json")
    prepared.update({
        "ua": {"png_path": str(png_a), "source_folder": "Diary"},
        "ub": {"png_path": str(png_b), "source_folder": "Notes"},
    })
    ocr_state = StateFile(tmp_path / "ocr-done.json")

    calls: dict[str, str | None] = {}

    class FakeBackend(OCRBackend):
        def ocr(self, image_path, system_prompt=None):
            calls[image_path.name] = system_prompt
            return OCRResult(text="t", model="fake", prompt_hash="h", ts=datetime.now(timezone.utc))

    def prompt_for(folder):
        return {"Diary": "DIARY-P", "Notes": "NOTES-P"}.get(folder)

    run_ocr(
        prepared_state=prepared, ocr_state=ocr_state, ocr_root=tmp_path / "ocr",
        log=StageLogger("s3_ocr", tmp_path), backend=FakeBackend(), prompt_for=prompt_for,
    )
    assert calls["a.png"] == "DIARY-P"
    assert calls["b.png"] == "NOTES-P"
```

- [ ] **Step 2: Run — expect FAIL** (`run_ocr() got unexpected keyword 'prompt_for'`):

Run: `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s3_ocr.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `pipeline/desktop/stages/s3_ocr.py`:

Add `Callable` to the typing import: `from typing import Callable, Iterable`.

Change `run_ocr` signature + the backend call. Add the param after `only_uuids`:

```python
def run_ocr(
    *,
    prepared_state: StateFile,
    ocr_state: StateFile,
    ocr_root: Path,
    log: StageLogger,
    backend: OCRBackend,
    force: Iterable[str] | None = None,
    only_uuids: Iterable[str] | None = None,
    prompt_for: Callable[[str | None], str | None] | None = None,
) -> list[str]:
```

In the loop, replace `result = backend.ocr(png_path)` with:

```python
        try:
            system_prompt = (
                prompt_for(prep_info.get("source_folder")) if prompt_for else None
            )
            result = backend.ocr(png_path, system_prompt=system_prompt)
```

(the rest of the `try` body is unchanged).

In `main()`, pass the resolver — change the `run_ocr(...)` call to add:

```python
        prompt_for=cfg.tomboy.prompt_for,
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s3_ocr.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/stages/s3_ocr.py pipeline/tests/stages/test_s3_ocr.py
git commit -m "feat(pipeline): s3가 폴더별 프롬프트 해석·전달"
```

---

### Task 4: trigger 서버 `GET/PUT /config`

**Goal:** `trigger_server.py`에 `ConfigStore`(읽기=effective config, 쓰기=`folders.yaml` 원자적) + Bearer 인증 `GET /config` / `PUT /config` 추가. `pipeline.yaml`은 절대 안 건드림. title_format 플레이스홀더 검증.

**Files:**
- Modify: `pipeline/desktop/trigger_server.py`
- Test: `pipeline/tests/test_trigger_server_config.py` (new)

**Acceptance Criteria:**
- [ ] `ConfigStore.read_effective()` → `{defaultPrompt, folders:[{name,notebook,titleFormat,split,labels,prompt}]}`. `default_prompt` 비면 backend의 `system_prompt_path` 파일 내용으로 폴백.
- [ ] `ConfigStore.validate(payload)` → 타입 + title_format 플레이스홀더(`date/datetime/unit_key/page_uuid/label`만) 검증, 위반 시 에러 문자열.
- [ ] `ConfigStore.write(payload)` → `folders.yaml`을 temp+`os.replace`로 원자적 기록. `pipeline.yaml` 미변경.
- [ ] `GET /config`(Bearer), `PUT /config`(Bearer): 401 무토큰, 400 잘못된 JSON/검증실패, 200 성공. CORS에 PUT 포함.

**Verify:** `pipeline/.venv/bin/python -m pytest tests/test_trigger_server_config.py -q` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests** — create `pipeline/tests/test_trigger_server_config.py`:

```python
import json
import textwrap
from pathlib import Path

import pytest

from desktop.trigger_server import ConfigStore

_BASE_YAML = textwrap.dedent("""\
    firebase_uid: "dbx-x"
    firebase_service_account: "/tmp/sa.json"
    remarkable: { diary_notebook_name: "Diary", ssh_host: "rm", ssh_user: "root" }
    pi: { ssh_host: "pi", ssh_port: 2222, ssh_user: "u", ssh_key: "~/.ssh/k", inbox_path: "~/in" }
    ocr:
      backend: "claude"
      claude: { service_url: "http://x", service_token: "t", effort: "high", system_prompt_path: "config/prompts/diary-ko.txt" }
""")


def _store(tmp_path: Path) -> ConfigStore:
    root = tmp_path
    (root / "config").mkdir()
    (root / "config" / "pipeline.yaml").write_text(_BASE_YAML, encoding="utf-8")
    (root / "config" / "prompts").mkdir()
    (root / "config" / "prompts" / "diary-ko.txt").write_text("파일 기본 프롬프트", encoding="utf-8")
    return ConfigStore(
        pipeline_yaml=root / "config" / "pipeline.yaml",
        folders_yaml=root / "config" / "folders.yaml",
        root=root,
    )


def test_read_effective_falls_back_to_prompt_file(tmp_path):
    store = _store(tmp_path)
    cfg = store.read_effective()
    assert cfg["defaultPrompt"] == "파일 기본 프롬프트"
    names = {f["name"] for f in cfg["folders"]}
    assert {"Diary", "Notes", "Slip-Notes"} <= names


def test_write_then_read_roundtrip_and_pipeline_untouched(tmp_path):
    store = _store(tmp_path)
    before = (tmp_path / "config" / "pipeline.yaml").read_text(encoding="utf-8")
    payload = {
        "defaultPrompt": "새 기본",
        "folders": [
            {"name": "Diary", "notebook": "일기", "titleFormat": "{date} 리마커블([{unit_key}])",
             "split": False, "labels": [], "prompt": "다이어리 프롬프트"},
        ],
    }
    assert store.validate(payload) is None
    store.write(payload)
    assert (tmp_path / "config" / "folders.yaml").exists()
    after = (tmp_path / "config" / "pipeline.yaml").read_text(encoding="utf-8")
    assert before == after  # pipeline.yaml untouched
    cfg = store.read_effective()
    assert cfg["defaultPrompt"] == "새 기본"
    diary = next(f for f in cfg["folders"] if f["name"] == "Diary")
    assert diary["prompt"] == "다이어리 프롬프트"


def test_validate_rejects_bad_placeholder(tmp_path):
    store = _store(tmp_path)
    err = store.validate({"defaultPrompt": "", "folders": [
        {"name": "X", "notebook": "n", "titleFormat": "{date} {bogus}", "split": False, "labels": [], "prompt": ""}
    ]})
    assert err is not None and "bogus" in err


def test_validate_rejects_wrong_types(tmp_path):
    store = _store(tmp_path)
    assert store.validate({"folders": "nope"}) is not None
    assert store.validate({"folders": [{"name": "", "titleFormat": "{date}"}]}) is not None
```

Append an HTTP-level test (handler with injected store) to the same file:

```python
def test_http_get_put_config(tmp_path):
    from io import BytesIO
    from desktop.trigger_server import JobState, PipelineRunner, make_handler

    store = _store(tmp_path)
    handler_cls = make_handler(
        token="tok", state=JobState(),
        runner=PipelineRunner(cwd=tmp_path, python="python"),
        config_store=store,
    )

    class FakeHandler(handler_cls):  # type: ignore[misc, valid-type]
        def __init__(self, method, path, body=b"", token="tok"):
            self.command = method
            self.path = path
            self.headers = {"Authorization": f"Bearer {token}", "Content-Length": str(len(body))}
            self.rfile = BytesIO(body)
            self.wfile = BytesIO()
            self._status = None
            self._headers_sent = {}
        def send_response(self, code, *a): self._status = code
        def send_header(self, k, v): self._headers_sent[k] = v
        def end_headers(self): pass
        def log_message(self, *a, **k): pass

    # GET /config
    h = FakeHandler("GET", "/config")
    h.do_GET()
    assert h._status == 200
    out = json.loads(h.wfile.getvalue().decode("utf-8"))
    assert out["ok"] and "folders" in out

    # PUT /config (valid)
    body = json.dumps({"defaultPrompt": "p", "folders": [
        {"name": "Diary", "notebook": "일기", "titleFormat": "{date}", "split": False, "labels": [], "prompt": ""}
    ]}).encode("utf-8")
    h = FakeHandler("PUT", "/config", body)
    h.do_PUT()
    assert h._status == 200

    # PUT unauthorized
    h = FakeHandler("PUT", "/config", body, token="WRONG")
    h.do_PUT()
    assert h._status == 401
```

- [ ] **Step 2: Run — expect FAIL** (`ImportError: cannot import name 'ConfigStore'`):

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_trigger_server_config.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `pipeline/desktop/trigger_server.py`:

Add imports near the top (with the existing stdlib imports): `import string`. Add config import after the existing imports:

```python
from desktop.lib.config import load_config
```

Add `ConfigStore` + placeholder validator (module-level, before `make_handler`):

```python
_ALLOWED_PLACEHOLDERS = {"date", "datetime", "unit_key", "page_uuid", "label"}


def _validate_title_format(tf: str) -> str | None:
    try:
        fields = [field for _, field, _, _ in string.Formatter().parse(tf)]
    except ValueError as e:
        return f"malformed format: {e}"
    for field in fields:
        if not field:
            continue
        base = field.split(":")[0].split(".")[0].split("[")[0]
        if base and base not in _ALLOWED_PLACEHOLDERS:
            return f"unknown placeholder: {{{field}}}"
    return None


class ConfigStore:
    """Reads the effective tomboy folder config and writes the app-managed
    ``folders.yaml`` overlay. NEVER writes ``pipeline.yaml`` (secrets)."""

    def __init__(self, *, pipeline_yaml: Path, folders_yaml: Path, root: Path) -> None:
        self.pipeline_yaml = pipeline_yaml
        self.folders_yaml = folders_yaml
        self.root = root

    def read_effective(self) -> dict[str, Any]:
        cfg = load_config(self.pipeline_yaml)
        default_prompt = cfg.tomboy.default_prompt
        if not default_prompt.strip():
            default_prompt = self._read_default_prompt_file(cfg)
        folders = [
            {
                "name": name,
                "notebook": route.notebook,
                "titleFormat": route.title_format,
                "split": route.split,
                "labels": list(route.labels),
                "prompt": route.prompt,
            }
            for name, route in cfg.tomboy.folders.items()
        ]
        folders.sort(key=lambda f: f["name"])
        return {"defaultPrompt": default_prompt, "folders": folders}

    def _read_default_prompt_file(self, cfg: Any) -> str:
        sub = cfg.ocr.claude or cfg.ocr.local_vlm
        if sub is None:
            return ""
        p = Path(sub.system_prompt_path)
        if not p.is_absolute():
            p = self.root / p
        try:
            return p.read_text(encoding="utf-8")
        except OSError:
            return ""

    @staticmethod
    def validate(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return "payload must be an object"
        if "defaultPrompt" in payload and not isinstance(payload["defaultPrompt"], str):
            return "defaultPrompt must be a string"
        folders = payload.get("folders")
        if not isinstance(folders, list):
            return "folders must be a list"
        seen: set[str] = set()
        for f in folders:
            if not isinstance(f, dict):
                return "each folder must be an object"
            name = f.get("name")
            if not isinstance(name, str) or not name.strip():
                return "folder.name required"
            if name in seen:
                return f"duplicate folder name: {name}"
            seen.add(name)
            for key in ("notebook", "titleFormat", "prompt"):
                if key in f and not isinstance(f[key], str):
                    return f"{name}.{key} must be a string"
            if "split" in f and not isinstance(f["split"], bool):
                return f"{name}.split must be a boolean"
            labels = f.get("labels", [])
            if not isinstance(labels, list) or not all(isinstance(x, str) for x in labels):
                return f"{name}.labels must be a string array"
            err = _validate_title_format(f.get("titleFormat", ""))
            if err:
                return f"{name}.titleFormat: {err}"
        return None

    def write(self, payload: dict[str, Any]) -> None:
        import yaml

        data = {
            "default_prompt": payload.get("defaultPrompt", ""),
            "folders": {
                f["name"]: {
                    "notebook": f.get("notebook", ""),
                    "title_format": f.get("titleFormat", ""),
                    "split": bool(f.get("split", False)),
                    "labels": list(f.get("labels", [])),
                    "prompt": f.get("prompt", ""),
                }
                for f in payload.get("folders", [])
            },
        }
        self.folders_yaml.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.folders_yaml.with_name(self.folders_yaml.name + ".tmp")
        tmp.write_text(
            yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8"
        )
        os.replace(tmp, self.folders_yaml)
```

Change `make_handler` to accept `config_store` and add the routes. Update the signature:

```python
def make_handler(*, token: str, state: JobState, runner: PipelineRunner, config_store: "ConfigStore | None" = None):
```

In `_Handler.do_GET`, before the final 404, add:

```python
            if self.path == "/config":
                if not self._check_bearer():
                    return
                if config_store is None:
                    _send_json(self, 503, {"ok": False, "error": "config store unavailable"})
                    return
                try:
                    cfg = config_store.read_effective()
                except Exception as e:  # pragma: no cover — defensive
                    _send_json(self, 500, {"ok": False, "error": str(e)})
                    return
                _send_json(self, 200, {"ok": True, **cfg})
                return
```

Add a `_handle_config_write` helper inside `_Handler` and a `do_PUT`, and route POST `/config` to the same helper:

```python
        def _handle_config_write(self) -> None:
            if not self._check_bearer():
                return
            if config_store is None:
                _send_json(self, 503, {"ok": False, "error": "config store unavailable"})
                return
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                _send_json(self, 400, {"ok": False, "error": "invalid JSON"})
                return
            err = config_store.validate(payload)
            if err:
                _send_json(self, 400, {"ok": False, "error": err})
                return
            try:
                config_store.write(payload)
            except Exception as e:  # pragma: no cover — defensive
                _send_json(self, 500, {"ok": False, "error": str(e)})
                return
            _send_json(self, 200, {"ok": True, "saved": True})

        def do_PUT(self) -> None:  # noqa: N802
            if self.path == "/config":
                self._handle_config_write()
                return
            _send_json(self, 404, {"ok": False, "error": "not_found"})
```

In `do_POST`, add `/config` before the existing `/run` handling:

```python
        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/config":
                self._handle_config_write()
                return
            if self.path != "/run":
                _send_json(self, 404, {"ok": False, "error": "not_found"})
                return
            # ... existing /run body unchanged
```

Add PUT to CORS methods — in `_send_cors_headers` change:

```python
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
```

Wire `ConfigStore` in `main()` — after `runner = PipelineRunner(...)`:

```python
    config_store = ConfigStore(
        pipeline_yaml=args.config,
        folders_yaml=args.config.parent / "folders.yaml",
        root=args.config.parent.parent,
    )
    handler_cls = make_handler(token=token, state=state, runner=runner, config_store=config_store)
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd pipeline && .venv/bin/python -m pytest tests/test_trigger_server_config.py -q`
Expected: PASS. Also run the existing trigger tests if any: `cd pipeline && .venv/bin/python -m pytest tests/ -q -k trigger`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/trigger_server.py pipeline/tests/test_trigger_server_config.py
git commit -m "feat(pipeline): trigger 서버 GET/PUT /config (folders.yaml 원자적 쓰기)"
```

---

### Task 5: 앱 trigger 클라이언트 — fetch/save config

**Goal:** `remarkablePipeline.ts`에 `fetchPipelineConfig` / `savePipelineConfig` + 타입 추가. 기존 `normalizeBaseUrl` + Bearer 패턴 재사용. 네버-스로우.

**Files:**
- Modify: `app/src/lib/admin/remarkablePipeline.ts`
- Test: `app/tests/unit/lib/admin/remarkablePipelineConfig.test.ts` (new)

**Acceptance Criteria:**
- [ ] `PipelineFolderConfig` / `PipelineConfig` 타입.
- [ ] `fetchPipelineConfig(url, token)` → `{ok, config?, error?}`; 200 파싱, 401/네트워크 에러 처리.
- [ ] `savePipelineConfig(url, token, config)` → `{ok, error?}`; PUT JSON body, 400 검증에러 메시지 추출.

**Verify:** `cd app && npx vitest run tests/unit/lib/admin/remarkablePipelineConfig.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write failing test** — create `app/tests/unit/lib/admin/remarkablePipelineConfig.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPipelineConfig, savePipelineConfig } from '$lib/admin/remarkablePipeline';

afterEach(() => vi.restoreAllMocks());

describe('fetchPipelineConfig', () => {
	it('parses 200 body into config', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ ok: true, defaultPrompt: 'd', folders: [{ name: 'Diary' }] }),
			{ status: 200 }
		)));
		const r = await fetchPipelineConfig('http://x', 't');
		expect(r.ok).toBe(true);
		expect(r.config?.defaultPrompt).toBe('d');
		expect(r.config?.folders[0].name).toBe('Diary');
	});

	it('reports auth failure on 401', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
		const r = await fetchPipelineConfig('http://x', 't');
		expect(r.ok).toBe(false);
	});

	it('returns not-configured without url/token', async () => {
		const r = await fetchPipelineConfig('', '');
		expect(r.ok).toBe(false);
	});
});

describe('savePipelineConfig', () => {
	it('PUTs JSON body and succeeds on 200', async () => {
		const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
		vi.stubGlobal('fetch', spy);
		const r = await savePipelineConfig('http://x/', 't', { defaultPrompt: 'p', folders: [] });
		expect(r.ok).toBe(true);
		const [url, init] = spy.mock.calls[0];
		expect(url).toBe('http://x/config');
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body).defaultPrompt).toBe('p');
	});

	it('surfaces 400 validation error message', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ ok: false, error: 'X.titleFormat: unknown placeholder' }), { status: 400 }
		)));
		const r = await savePipelineConfig('http://x', 't', { defaultPrompt: '', folders: [] });
		expect(r.ok).toBe(false);
		expect(r.error).toContain('unknown placeholder');
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (functions not exported):

Run: `cd app && npx vitest run tests/unit/lib/admin/remarkablePipelineConfig.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `app/src/lib/admin/remarkablePipeline.ts`:

```ts
export interface PipelineFolderConfig {
	name: string;
	notebook: string;
	titleFormat: string;
	split: boolean;
	labels: string[];
	prompt: string;
}

export interface PipelineConfig {
	defaultPrompt: string;
	folders: PipelineFolderConfig[];
}

export interface PipelineConfigResult {
	ok: boolean;
	config?: PipelineConfig;
	error?: string;
}

/** GET ``<triggerUrl>/config`` — effective folder routing + prompts. */
export async function fetchPipelineConfig(
	triggerUrl: string,
	token: string
): Promise<PipelineConfigResult> {
	const base = normalizeBaseUrl(triggerUrl);
	if (!base || !token) return { ok: false, error: '트리거 URL/토큰이 설정되지 않았습니다' };
	let res: Response;
	try {
		res = await fetch(base + '/config', { headers: { Authorization: 'Bearer ' + token } });
	} catch (e) {
		return { ok: false, error: '네트워크 오류: ' + String(e) };
	}
	if (res.status === 401) return { ok: false, error: '인증 실패 (토큰 확인)' };
	if (res.status !== 200) return { ok: false, error: 'HTTP ' + String(res.status) };
	try {
		const body = (await res.json()) as { defaultPrompt?: string; folders?: PipelineFolderConfig[] };
		return {
			ok: true,
			config: { defaultPrompt: body.defaultPrompt ?? '', folders: body.folders ?? [] }
		};
	} catch {
		return { ok: false, error: 'invalid JSON' };
	}
}

/** PUT ``<triggerUrl>/config`` — persist folders.yaml on the desktop. */
export async function savePipelineConfig(
	triggerUrl: string,
	token: string,
	config: PipelineConfig
): Promise<{ ok: boolean; error?: string }> {
	const base = normalizeBaseUrl(triggerUrl);
	if (!base) return { ok: false, error: '트리거 URL이 설정되지 않았습니다' };
	if (!token) return { ok: false, error: '트리거 토큰이 설정되지 않았습니다' };
	let res: Response;
	try {
		res = await fetch(base + '/config', {
			method: 'PUT',
			headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
			body: JSON.stringify(config)
		});
	} catch (e) {
		return { ok: false, error: '네트워크 오류: ' + String(e) };
	}
	if (res.status === 401) return { ok: false, error: '인증 실패 (토큰 확인)' };
	if (res.status === 400) {
		let msg = '';
		try {
			msg = ((await res.json()) as { error?: string }).error ?? '';
		} catch {
			/* ignore */
		}
		return { ok: false, error: '검증 실패: ' + msg };
	}
	if (res.status !== 200) return { ok: false, error: 'HTTP ' + String(res.status) };
	return { ok: true };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd app && npx vitest run tests/unit/lib/admin/remarkablePipelineConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/admin/remarkablePipeline.ts app/tests/unit/lib/admin/remarkablePipelineConfig.test.ts
git commit -m "feat(app): trigger 클라이언트 fetch/savePipelineConfig"
```

---

### Task 6: 설정 UI — DiaryOcrSettings + 리마커블 탭 + 가이드 카드

**Goal:** 설정 → 리마커블 탭에 "일기 OCR 파이프라인 설정" 섹션(기본 프롬프트 + 폴더 카드 + 폴더 추가 + 저장)을 추가하고, 가이드 카드를 등록한다.

**Files:**
- Create: `app/src/lib/remarkable/DiaryOcrSettings.svelte`
- Modify: `app/src/routes/settings/+page.svelte` (리마커블 탭 + 가이드 카드)
- Test: `app/tests/unit/lib/remarkable/diaryOcrSettings.test.ts` (new — smoke render)

**Acceptance Criteria:**
- [ ] 마운트 시 `getDiaryTriggerUrl/Token` 로드 → 둘 다 있으면 `fetchPipelineConfig` 호출해 폼 채움; 없으면 "트리거 미설정" 안내.
- [ ] 기본 프롬프트 textarea + 폴더당 카드(notebook / title format / split 토글 / labels / prompt textarea).
- [ ] "폴더 추가" → 빈 카드 + 고정 안내문(태블릿 `TARGET_FOLDERS` 수동 추가).
- [ ] "저장" → `savePipelineConfig` → 성공/실패 토스트.
- [ ] 리마커블 탭에서 `RemarkableSendSettings` 아래 렌더; 가이드 `env` 탭에 카드 1개.

**Verify:** `cd app && npx vitest run tests/unit/lib/remarkable/diaryOcrSettings.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: Write failing smoke test** — create `app/tests/unit/lib/remarkable/diaryOcrSettings.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import DiaryOcrSettings from '$lib/remarkable/DiaryOcrSettings.svelte';

vi.mock('$lib/storage/appSettings.js', () => ({
	getDiaryTriggerUrl: vi.fn(async () => ''),
	getDiaryTriggerToken: vi.fn(async () => '')
}));

afterEach(() => vi.restoreAllMocks());

describe('DiaryOcrSettings', () => {
	it('renders the section heading without a configured trigger', async () => {
		const { findByText } = render(DiaryOcrSettings);
		expect(await findByText(/일기 OCR 파이프라인 설정/)).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (component does not exist):

Run: `cd app && npx vitest run tests/unit/lib/remarkable/diaryOcrSettings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement component** — create `app/src/lib/remarkable/DiaryOcrSettings.svelte`:

```svelte
<script lang="ts">
	import { getDiaryTriggerUrl, getDiaryTriggerToken } from '$lib/storage/appSettings.js';
	import {
		fetchPipelineConfig,
		savePipelineConfig,
		type PipelineFolderConfig
	} from '$lib/admin/remarkablePipeline.js';
	import { pushToast } from '$lib/stores/toast.js';

	let url = $state('');
	let token = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let loaded = $state(false);
	let errorText = $state('');
	let defaultPrompt = $state('');
	let folders = $state<PipelineFolderConfig[]>([]);
	let mounted = $state(false);

	$effect(() => {
		if (mounted) return;
		mounted = true;
		void load();
	});

	async function load() {
		url = await getDiaryTriggerUrl();
		token = await getDiaryTriggerToken();
		if (!url || !token) {
			errorText = '트리거 URL/토큰이 설정되지 않았습니다. 아래 "재처리 트리거" 설정(관리자 → 리마커블)에서 먼저 등록하세요.';
			return;
		}
		loading = true;
		errorText = '';
		const r = await fetchPipelineConfig(url, token);
		loading = false;
		if (!r.ok || !r.config) {
			errorText = r.error ?? '설정을 불러오지 못했습니다';
			return;
		}
		defaultPrompt = r.config.defaultPrompt;
		folders = r.config.folders;
		loaded = true;
	}

	function addFolder() {
		folders = [
			...folders,
			{ name: '', notebook: '', titleFormat: '{date} 리마커블([{unit_key}])', split: false, labels: [], prompt: '' }
		];
	}

	function removeFolder(i: number) {
		folders = folders.filter((_, idx) => idx !== i);
	}

	function labelsText(f: PipelineFolderConfig): string {
		return f.labels.join(', ');
	}
	function setLabels(i: number, text: string) {
		folders[i].labels = text.split(',').map((s) => s.trim()).filter(Boolean);
	}

	async function save() {
		if (!url || !token) return;
		saving = true;
		const r = await savePipelineConfig(url, token, { defaultPrompt, folders });
		saving = false;
		if (r.ok) pushToast('OCR 설정 저장됨');
		else pushToast(r.error ?? '저장 실패');
	}
</script>

<section class="diary-ocr">
	<h3>일기 OCR 파이프라인 설정</h3>
	<p class="info-text">
		리마커블 OCR의 폴더별 프롬프트와 라우팅을 편집합니다. 저장하면 데스크탑 trigger
		서버 경유로 <code>folders.yaml</code>에 기록됩니다.
	</p>

	{#if errorText}
		<p class="err">{errorText}</p>
	{/if}

	{#if loading}
		<p class="info-text">불러오는 중…</p>
	{:else if loaded}
		<label class="field">
			<span>기본 프롬프트 (폴더별 미지정 시 사용)</span>
			<textarea rows="4" bind:value={defaultPrompt}></textarea>
		</label>

		{#each folders as f, i (i)}
			<div class="folder-card">
				<div class="row">
					<label class="field grow">
						<span>폴더명 (rM CollectionType)</span>
						<input type="text" bind:value={f.name} placeholder="Diary" />
					</label>
					<button type="button" class="rm" onclick={() => removeFolder(i)}>삭제</button>
				</div>
				<div class="row">
					<label class="field grow">
						<span>노트북</span>
						<input type="text" bind:value={f.notebook} />
					</label>
					<label class="field grow">
						<span>제목 형식</span>
						<input type="text" bind:value={f.titleFormat} />
					</label>
				</div>
				<div class="row">
					<label class="chk">
						<input type="checkbox" bind:checked={f.split} /> 분할(슬립)
					</label>
					<label class="field grow">
						<span>라벨 (쉼표 구분)</span>
						<input type="text" value={labelsText(f)} oninput={(e) => setLabels(i, e.currentTarget.value)} />
					</label>
				</div>
				<label class="field">
					<span>프롬프트 (비우면 기본 프롬프트)</span>
					<textarea rows="3" bind:value={f.prompt}></textarea>
				</label>
			</div>
		{/each}

		<p class="warn">
			⚠️ 새 폴더는 태블릿 <code>diary-push.sh</code>의 <code>TARGET_FOLDERS</code>에도
			추가해야 페이지가 들어옵니다.
		</p>

		<div class="actions">
			<button type="button" onclick={addFolder}>폴더 추가</button>
			<button type="button" class="primary" onclick={save} disabled={saving}>
				{saving ? '저장 중…' : '저장'}
			</button>
		</div>
	{/if}
</section>

<style>
	.diary-ocr { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
	.folder-card { border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.row { display: flex; gap: 0.5rem; align-items: flex-end; }
	.field { display: flex; flex-direction: column; gap: 0.2rem; }
	.field.grow { flex: 1; }
	.field span { font-size: 0.8rem; opacity: 0.75; }
	textarea, input[type='text'] { width: 100%; box-sizing: border-box; }
	.chk { display: flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
	.actions { display: flex; gap: 0.5rem; }
	.primary { font-weight: 600; }
	.rm { align-self: center; }
	.warn { font-size: 0.85rem; opacity: 0.85; }
	.err { color: var(--danger, #c0392b); }
</style>
```

(If `pushToast` is not the correct toast API, match the import already used by `app/src/routes/admin/remarkable/+page.svelte` — it imports `pushToast` from `$lib/stores/toast.js`.)

- [ ] **Step 4: Wire into settings** — in `app/src/routes/settings/+page.svelte`:

Add the import near the other settings imports (next to `RemarkableSendSettings`):

```svelte
	import DiaryOcrSettings from '$lib/remarkable/DiaryOcrSettings.svelte';
```

In the remarkable tab branch, render it below the existing component:

```svelte
		{:else if activeTab === 'remarkable'}
			<!-- ── 리마커블 탭 ───────────────────────────────────────────── -->
			<RemarkableSendSettings />
			<DiaryOcrSettings />
```

- [ ] **Step 5: Guide card** — in the same file, inside the guide `env` sub-tab block, append a card (mirror the existing `<details class="guide-card">` pattern):

```svelte
				<details class="guide-card">
					<summary>리마커블 OCR 프롬프트·폴더 편집</summary>
					<p class="info-text">
						<button type="button" class="link-btn" onclick={() => (activeTab = 'remarkable')}>설정 → 리마커블 탭</button>
						의 "일기 OCR 파이프라인 설정"에서 폴더별 OCR 프롬프트와 라우팅(노트북/제목/분할/라벨)을
						편집합니다. 저장하면 데스크탑 trigger 서버 경유로 <code>folders.yaml</code>에 기록됩니다.
					</p>
					<ul class="guide-list">
						<li>프롬프트는 <strong>폴더별로 각각</strong> — 비우면 공용 "기본 프롬프트" 사용.</li>
						<li>저장 위치는 <strong>데스크탑</strong>(브릿지 아님) — OCR이 거기서 실행됩니다.</li>
						<li>완전히 새 폴더는 태블릿 <code>diary-push.sh</code>의 <code>TARGET_FOLDERS</code>도 수동 추가해야 페이지가 들어옵니다.</li>
						<li>트리거 URL/토큰은 관리자 → 리마커블에서 등록(같은 값 재사용).</li>
					</ul>
				</details>
```

- [ ] **Step 6: Run — expect PASS + typecheck**

Run: `cd app && npx vitest run tests/unit/lib/remarkable/diaryOcrSettings.test.ts`
Expected: PASS.
Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/remarkable/DiaryOcrSettings.svelte app/src/routes/settings/+page.svelte app/tests/unit/lib/remarkable/diaryOcrSettings.test.ts
git commit -m "feat(app): 설정 리마커블 탭에 일기 OCR 프롬프트·폴더 편집 + 가이드"
```

---

### Task 7: 전체 회귀 + 문서 동기화

**Goal:** 파이프라인 + 앱 전체 테스트 회귀, 스킬 문서(tomboy-diary)에 새 동작 한 줄 반영.

**Files:**
- Modify: `.claude/skills/tomboy-diary/SKILL.md` (또는 해당 스킬 본문 위치)

**Acceptance Criteria:**
- [ ] `pipeline/.venv/bin/python -m pytest tests/ -q` 전부 통과.
- [ ] `cd app && npm run test` 통과(또는 영향 범위 한정 실행 후 grep으로 회귀 없음 확인).
- [ ] tomboy-diary 스킬에 "폴더별 프롬프트 + folders.yaml 오버레이 + trigger /config" 한 단락 추가.

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/ -q` → all pass; `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: Pipeline regression**

Run: `cd pipeline && .venv/bin/python -m pytest tests/ -q`
Expected: all pass. Fix any fallout (most likely a test that constructs `TomboyConfig`/`FolderRoute` positionally — new fields are keyword-defaulted, so positional construction is unaffected).

- [ ] **Step 2: App regression**

Run: `cd app && npm run check`
Expected: 0 errors.
Run: `cd app && npx vitest run tests/unit/lib/admin tests/unit/lib/remarkable`
Expected: pass.

- [ ] **Step 3: Doc** — add a short paragraph to the tomboy-diary skill body documenting: `folders.yaml` 오버레이(앱 관리, pipeline.yaml 불변), 폴더별 프롬프트 해석 순서(folder prompt > default_prompt > system_prompt_path 파일), trigger 서버 `GET/PUT /config`, 새 폴더는 태블릿 `TARGET_FOLDERS` 수동 추가.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(tomboy-diary): folders.yaml 오버레이 + 폴더별 프롬프트 + trigger /config"
```

---

## Self-Review

**Spec coverage:**
- 저장 위치 판단(데스크탑) → Task 4 (trigger /config).
- 폴더별 프롬프트 → Task 1 (config) + Task 2 (backend) + Task 3 (s3).
- 폴더 확인·편집·추가(라우팅) → Task 4 GET/PUT + Task 6 UI.
- 자동 저장 → Task 4 (folders.yaml 원자적) + Task 5/6 (앱→PUT).
- 태블릿 푸시 목록 안내(범위 밖이지만 고지) → Task 6 고정 안내문 + 가이드.
- 가이드 문서화 invariant → Task 6 Step 5.
- 하위호환(파일 부재=현재 동작) → Task 1 / Task 2 / Task 3 기본값.

**Placeholder scan:** 없음 — 모든 스텝에 실제 코드/명령.

**Type consistency:** `FolderRoute.prompt`, `TomboyConfig.default_prompt`/`prompt_for`, `ConfigStore.{read_effective,validate,write}`, `OCRBackend.ocr(..., system_prompt=)`, 앱 `PipelineConfig{defaultPrompt,folders}` / `PipelineFolderConfig{name,notebook,titleFormat,split,labels,prompt}` — 태스크 간 일관(서버 camelCase ↔ yaml snake_case 변환은 ConfigStore.write/read에서만 수행).
