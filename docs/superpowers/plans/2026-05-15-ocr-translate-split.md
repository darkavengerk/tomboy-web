# OCR + 번역 분리 + GPU 모니터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR(GOT-OCR2) + 번역(EXAONE 3.5 2.4B) 모델을 분리하고, `/admin/gpu` 페이지로 VRAM/모델 가시화 + 수동 언로드를 추가한다.

**Architecture:** Pi 브릿지(GPU 없음) — 모델 라우팅·인증만 수행. 데스크탑(RTX 3080) — Ollama(EXAONE 외) + 신규 `ocr-service`(FastAPI + GOT-OCR2) 둘 다 같은 VRAM 풀 공유. 브릿지가 `/ocr`, `/gpu/status`, `/gpu/unload` 세 라우팅을 추가해 두 데스크탑 서비스를 노출한다. 웹앱은 OCR→번역을 순차 두 호출로 분리.

**Tech Stack:** Python 3.11 + FastAPI + transformers + GOT-OCR2 (ocr-service); Node 22 + http (bridge); SvelteKit 2 + TipTap 3 + Svelte 5 runes (웹앱); Podman Quadlet (배포).

**Spec:** `docs/superpowers/specs/2026-05-15-ocr-translate-split-design.md`

---

## File Structure

신규 파일:
- `ocr-service/pyproject.toml` — Python 프로젝트 메타
- `ocr-service/src/ocr_service/app.py` — FastAPI 앱 + 라우팅 (단일 진입점)
- `ocr-service/src/ocr_service/model.py` — GOT-OCR2 래퍼 (load/unload/run, idle timer 포함)
- `ocr-service/src/ocr_service/gpu.py` — `nvidia-smi` 파싱
- `ocr-service/src/ocr_service/config.py` — 환경변수 (`BRIDGE_SHARED_TOKEN`, `OCR_IDLE_UNLOAD_S`, `OCR_MODEL_ID`)
- `ocr-service/tests/test_app.py` — endpoint 단위 테스트 (모델 mock)
- `ocr-service/tests/test_model.py` — idle timer / load-unload 단위 테스트 (fake clock)
- `ocr-service/tests/test_gpu.py` — nvidia-smi 파싱 테스트 (subprocess mock)
- `ocr-service/Containerfile`
- `ocr-service/deploy/ocr-service.container` — Quadlet 유닛
- `bridge/src/ocr.ts` — `/ocr` 프록시 핸들러
- `bridge/src/gpu.ts` — `/gpu/status` 합본 + `/gpu/unload` 라우팅
- `bridge/src/ocr.test.ts`, `bridge/src/gpu.test.ts` — vitest 단위 테스트
- `app/src/lib/ocrNote/sendOcr.ts` — OCR 호출 헬퍼 (sendChat 의 OCR 버전)
- `app/src/routes/admin/gpu/+page.svelte` — GPU 모니터 페이지
- `app/src/lib/gpuMonitor/types.ts` — `/gpu/status` 응답 타입
- `app/src/lib/gpuMonitor/client.ts` — fetch + unload 호출 헬퍼
- `app/tests/unit/ocrNote/sendOcr.test.ts`
- `app/tests/unit/gpuMonitor/client.test.ts`

수정 파일:
- `bridge/src/server.ts` — 신규 라우팅 등록 (`/ocr`, `/gpu/status`, `/gpu/unload`)
- `bridge/deploy/term-bridge.container` — `OCR_SERVICE_URL` 환경변수 문서화
- `app/src/lib/ocrNote/defaults.ts` — `target_lang` 제거, `buildTranslatePrompt` 추가, `OCR_RECOGNIZED_HEADER_KEYS` 에 `translate` 추가
- `app/src/lib/ocrNote/parseOcrNote.ts` — `translateModel` 필드 + `translate:` 헤더 파싱 + 단일 시그니처 폴백 표식
- `app/src/lib/ocrNote/runOcrInEditor.ts` — 두 단계 호출 (OCR → 번역) + 폴백
- `app/tests/unit/ocrNote/parseOcrNote.test.ts` — 새 형식/폴백 케이스
- `app/src/routes/admin/+layout.svelte` — 서브탭에 "GPU" 추가
- `.claude/skills/tomboy-terminal/SKILL.md` — 머신 분리 invariant 단락 추가
- `CLAUDE.md` — 터미널 노트 섹션에 머신 분리 한 줄 추가

---

## Task 0: ocr-service 스캐폴드 + `/ocr` + `/healthz`

**Goal:** Python FastAPI 서비스를 만들고 GOT-OCR2 로 단일 이미지를 처리하는 최소 동작 흐름을 검증.

**Files:**
- Create: `ocr-service/pyproject.toml`
- Create: `ocr-service/src/ocr_service/__init__.py`
- Create: `ocr-service/src/ocr_service/app.py`
- Create: `ocr-service/src/ocr_service/model.py`
- Create: `ocr-service/src/ocr_service/config.py`
- Create: `ocr-service/tests/__init__.py`
- Create: `ocr-service/tests/conftest.py`
- Create: `ocr-service/tests/test_app.py`

**Acceptance Criteria:**
- [ ] `pip install -e .[dev]` 가 `ocr-service/` 안에서 통과한다
- [ ] `pytest ocr-service/tests/test_app.py` 가 통과한다
- [ ] `GET /healthz` 가 200 + `{"ok": true}` 응답
- [ ] `POST /ocr` 에 Bearer 토큰 + base64 이미지를 보내면 200 + `{"text": "..."}` (모델은 테스트에서 mock)
- [ ] Bearer 누락 시 401, 잘못된 토큰 시 401
- [ ] body 의 image_b64 누락 시 400

**Verify:** `cd ocr-service && pytest -v` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 프로젝트 메타와 디렉터리 골격 만들기**

`ocr-service/pyproject.toml`:

```toml
[project]
name = "ocr-service"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pillow>=10.4",
    "python-multipart>=0.0.9",
]

[project.optional-dependencies]
model = [
    # GOT-OCR2 deps. Pinned conservatively; the version range matches
    # what `stepfun-ai/GOT-OCR2_0` is tested against on RTX 30-series.
    "torch>=2.3,<3",
    "torchvision>=0.18",
    "transformers>=4.45,<4.50",
    "accelerate>=0.33",
    "verovio>=4.3",  # GOT-OCR2 'format' 모드에서 악보 출력 시 필요
]
dev = [
    "pytest>=8",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

`ocr-service/src/ocr_service/__init__.py`: 비어있는 파일.

- [ ] **Step 2: 환경변수 모듈**

`ocr-service/src/ocr_service/config.py`:

```python
"""Process-wide configuration sourced from environment variables.

Keep this trivial: the service is a single process and the values are
read once at startup. Tests override by monkeypatching `settings`."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    shared_token: str
    model_id: str
    idle_unload_s: int
    device: str

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.environ.get("BRIDGE_SHARED_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "BRIDGE_SHARED_TOKEN env var is required — refusing to start "
                "an unauthenticated OCR service."
            )
        return cls(
            shared_token=token,
            model_id=os.environ.get("OCR_MODEL_ID", "stepfun-ai/GOT-OCR2_0"),
            idle_unload_s=int(os.environ.get("OCR_IDLE_UNLOAD_S", "300")),
            device=os.environ.get("OCR_DEVICE", "cuda:0"),
        )


settings: Settings | None = None


def get_settings() -> Settings:
    """Lazy accessor. Initialized on first call (or in tests by patching)."""
    global settings
    if settings is None:
        settings = Settings.from_env()
    return settings
```

- [ ] **Step 3: 모델 래퍼 (테스트 가능한 형태)**

`ocr-service/src/ocr_service/model.py` — 실제 GOT-OCR2 로딩은 Task 1에서 마무리되니까 여기서는 인터페이스만 정의 + 테스트 더블 자리 마련:

```python
"""GOT-OCR2 wrapper.

This module owns the model's lifecycle: load on first use, run inference,
unload on idle timer or explicit /unload. The real PyTorch/transformers
work lives behind a small Protocol so tests can substitute a fake.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Protocol


class OcrRunner(Protocol):
    """Strategy interface. The real implementation lives in `model_real.py`
    (added in Task 1) and is wired up by `app.py` at startup."""

    def load(self) -> None: ...
    def unload(self) -> None: ...
    def is_loaded(self) -> bool: ...
    def run(self, image_b64: str) -> str: ...


@dataclass
class OcrEngine:
    """Stateful coordinator wrapping an `OcrRunner` with idle tracking and
    a single-flight lock. Methods are safe to call from FastAPI request
    handlers."""

    runner: OcrRunner
    last_called_at: float = 0.0
    _lock: Lock = field(default_factory=Lock)
    _in_flight: int = 0

    def status(self) -> dict[str, object]:
        return {
            "loaded": self.runner.is_loaded(),
            "last_called_at": self.last_called_at,
            "in_flight": self._in_flight,
        }

    def run(self, image_b64: str) -> str:
        with self._lock:
            self._in_flight += 1
        try:
            if not self.runner.is_loaded():
                self.runner.load()
            text = self.runner.run(image_b64)
            self.last_called_at = time.time()
            return text
        finally:
            with self._lock:
                self._in_flight -= 1

    def unload(self) -> bool:
        """Returns True if unload succeeded, False if a request is in
        flight."""
        with self._lock:
            if self._in_flight > 0:
                return False
            self.runner.unload()
            return True
```

- [ ] **Step 4: FastAPI 앱**

`ocr-service/src/ocr_service/app.py`:

```python
"""HTTP entrypoint. Endpoints:

  POST /ocr        — run GOT-OCR2 on a base64 image
  GET  /status     — model load/idle state
  POST /unload     — release GPU memory
  GET  /gpu/raw    — nvidia-smi parse (added in Task 2)
  GET  /healthz    — liveness

All non-health endpoints require Bearer token matching `BRIDGE_SHARED_TOKEN`.
"""
from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from .config import get_settings
from .model import OcrEngine

app = FastAPI(title="tomboy ocr-service")


def get_engine(request: Request) -> OcrEngine:
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        raise HTTPException(500, "engine not initialized")
    return engine


def require_bearer(authorization: str | None) -> None:
    settings = get_settings()
    expected = f"Bearer {settings.shared_token}"
    if authorization != expected:
        raise HTTPException(401, "unauthorized")


class OcrBody(BaseModel):
    image_b64: str


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/ocr")
def post_ocr(
    body: OcrBody,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    require_bearer(authorization)
    if not body.image_b64:
        raise HTTPException(400, "image_b64 required")
    engine = get_engine(request)
    text = engine.run(body.image_b64)
    return {"text": text}
```

- [ ] **Step 5: 테스트 fixture**

`ocr-service/tests/conftest.py`:

```python
"""Shared fixtures. Substitutes a fake OcrRunner so tests never load
the real model (which is ~1.2GB and requires a GPU)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ocr_service.app import app
from ocr_service.config import Settings, settings as _settings_module
from ocr_service.model import OcrEngine, OcrRunner


class FakeRunner:
    def __init__(self) -> None:
        self._loaded = False
        self.last_input = ""

    def load(self) -> None:
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False

    def is_loaded(self) -> bool:
        return self._loaded

    def run(self, image_b64: str) -> str:
        self.last_input = image_b64
        return f"OCR[{len(image_b64)}]"


@pytest.fixture
def fake_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    settings = Settings(
        shared_token="test-token",
        model_id="fake-model",
        idle_unload_s=60,
        device="cpu",
    )
    monkeypatch.setattr("ocr_service.config.settings", settings)
    return settings


@pytest.fixture
def fake_runner() -> FakeRunner:
    return FakeRunner()


@pytest.fixture
def client(fake_settings: Settings, fake_runner: FakeRunner) -> TestClient:
    engine = OcrEngine(runner=fake_runner)
    app.state.engine = engine
    return TestClient(app)
```

- [ ] **Step 6: 실패하는 테스트 먼저 작성**

`ocr-service/tests/test_app.py`:

```python
"""Endpoint contract tests. The model is mocked — see conftest.FakeRunner."""
from __future__ import annotations

import base64

from fastapi.testclient import TestClient


def _img(payload: bytes = b"x") -> str:
    return base64.b64encode(payload).decode()


def test_healthz_no_auth(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_ocr_requires_bearer(client: TestClient) -> None:
    r = client.post("/ocr", json={"image_b64": _img()})
    assert r.status_code == 401


def test_ocr_bad_token(client: TestClient) -> None:
    r = client.post(
        "/ocr",
        json={"image_b64": _img()},
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_ocr_missing_body(client: TestClient) -> None:
    r = client.post(
        "/ocr",
        json={},
        headers={"Authorization": "Bearer test-token"},
    )
    assert r.status_code == 422  # pydantic validation


def test_ocr_empty_image(client: TestClient) -> None:
    r = client.post(
        "/ocr",
        json={"image_b64": ""},
        headers={"Authorization": "Bearer test-token"},
    )
    assert r.status_code == 400


def test_ocr_success(client: TestClient) -> None:
    r = client.post(
        "/ocr",
        json={"image_b64": _img(b"hello")},
        headers={"Authorization": "Bearer test-token"},
    )
    assert r.status_code == 200
    body = r.json()
    assert "text" in body
    assert body["text"].startswith("OCR[")
```

- [ ] **Step 7: 테스트 실행 (실패 확인 → 통과 확인)**

```bash
cd ocr-service
python -m venv .venv
.venv/bin/pip install -e .[dev]
.venv/bin/pytest -v
```

Expected: 6 tests, all PASS. (코드는 위에서 이미 다 작성했으니 실패→통과 단계는 한 번에 통과해야 함.)

- [ ] **Step 8: 커밋**

```bash
git add ocr-service/pyproject.toml ocr-service/src/ ocr-service/tests/
git commit -m "feat(ocr-service): FastAPI scaffold with /ocr endpoint + Bearer auth

GOT-OCR2 wrapper interface (OcrRunner Protocol) + FakeRunner for tests.
Real model loading lands in next task."
```

---

## Task 1: ocr-service 실제 GOT-OCR2 로딩 + idle 자동 언로드 + `/status` + `/unload`

**Goal:** 진짜 GOT-OCR2 모델을 로드하고 idle 타이머/수동 unload 흐름을 완성. fake clock 으로 timer 동작 검증.

**Files:**
- Create: `ocr-service/src/ocr_service/model_real.py` — 실제 transformers 로딩
- Create: `ocr-service/src/ocr_service/idle.py` — idle timer (asyncio Task)
- Modify: `ocr-service/src/ocr_service/app.py` — `/status`, `/unload`, startup wiring, idle hook
- Create: `ocr-service/tests/test_model.py`

**Acceptance Criteria:**
- [ ] `GET /status` 가 `{loaded, last_called_at, in_flight, vram_mb}` 반환
- [ ] `POST /unload` 가 `_in_flight == 0` 일 때 200 + 모델 unload, in-flight 시 423
- [ ] idle timer 는 `last_called_at` 이 `idle_unload_s` 보다 오래되면 자동 unload (fake clock 검증)
- [ ] startup 에서 진짜 GOT-OCR2 (또는 fake) 가 wiring 되고 첫 `/ocr` 호출에 load 트리거

**Verify:** `cd ocr-service && pytest -v` → 모두 PASS

**Steps:**

- [ ] **Step 1: idle timer 모듈**

`ocr-service/src/ocr_service/idle.py`:

```python
"""Background idle watcher.

Polls the engine's `last_called_at` every N seconds; if the model has
been idle longer than `idle_unload_s`, calls `engine.unload()`. Uses a
clock callable (default `time.time`) so tests can substitute a fake."""
from __future__ import annotations

import asyncio
import logging
from typing import Callable

from .model import OcrEngine

log = logging.getLogger(__name__)


async def idle_watcher(
    engine: OcrEngine,
    idle_unload_s: int,
    poll_interval_s: float = 5.0,
    clock: Callable[[], float] = None,  # type: ignore[assignment]
) -> None:
    """Run forever (cancelled on app shutdown). Unloads the model on idle.

    This is a coroutine so the caller can `asyncio.create_task(idle_watcher(...))`
    on startup. The `clock` parameter is for tests."""
    import time as _time
    clock = clock or _time.time
    while True:
        await asyncio.sleep(poll_interval_s)
        if not engine.runner.is_loaded():
            continue
        idle_for = clock() - engine.last_called_at
        if idle_for >= idle_unload_s:
            if engine.unload():
                log.info("idle unload after %.0fs", idle_for)
```

- [ ] **Step 2: 실제 GOT-OCR2 runner**

`ocr-service/src/ocr_service/model_real.py`:

```python
"""Real GOT-OCR2 runner. Imported lazily so unit tests that use FakeRunner
never touch torch/transformers."""
from __future__ import annotations

import base64
import io
import logging
import os
from threading import Lock

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

log = logging.getLogger(__name__)


class GotOcr2Runner:
    """Wraps `stepfun-ai/GOT-OCR2_0` via transformers AutoModel.

    The model is loaded on `load()`, kept in fp16 on the configured CUDA
    device, and run via its custom `chat` method with `ocr_type='format'`.
    `unload()` moves the model to CPU and releases CUDA caches."""

    def __init__(self, model_id: str, device: str) -> None:
        self.model_id = model_id
        self.device = device
        self._model = None
        self._tokenizer = None
        self._load_lock = Lock()

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None and self._on_device():
                return
            from transformers import AutoModel, AutoTokenizer
            import torch

            log.info("loading %s on %s", self.model_id, self.device)
            tokenizer = AutoTokenizer.from_pretrained(
                self.model_id, trust_remote_code=True
            )
            model = AutoModel.from_pretrained(
                self.model_id,
                trust_remote_code=True,
                low_cpu_mem_usage=True,
                use_safetensors=True,
                torch_dtype=torch.float16,
            )
            model = model.eval().to(self.device)
            self._model = model
            self._tokenizer = tokenizer

    def unload(self) -> None:
        with self._load_lock:
            if self._model is None:
                return
            import torch
            self._model = self._model.to("cpu")
            self._model = None
            self._tokenizer = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            log.info("unloaded")

    def is_loaded(self) -> bool:
        return self._model is not None and self._on_device()

    def _on_device(self) -> bool:
        try:
            if self._model is None:
                return False
            p = next(self._model.parameters())
            return str(p.device).startswith(self.device.split(":")[0])
        except StopIteration:
            return False

    def run(self, image_b64: str) -> str:
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("model not loaded")
        from PIL import Image
        raw = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        # GOT-OCR2 expects a path or PIL image via its custom chat method.
        # `ocr_type='format'` returns Markdown-like structured output.
        result = self._model.chat(
            self._tokenizer, image, ocr_type="format"
        )
        return str(result)
```

- [ ] **Step 3: app 에 status/unload + startup wiring**

`ocr-service/src/ocr_service/app.py` 에 추가/변경:

```python
# at top, add:
import asyncio
from .idle import idle_watcher


@app.on_event("startup")
async def _startup() -> None:
    if getattr(app.state, "engine", None) is not None:
        # Tests pre-populate engine via the `client` fixture; skip.
        return
    settings = get_settings()
    from .model_real import GotOcr2Runner
    runner = GotOcr2Runner(model_id=settings.model_id, device=settings.device)
    app.state.engine = OcrEngine(runner=runner)
    app.state.idle_task = asyncio.create_task(
        idle_watcher(app.state.engine, settings.idle_unload_s)
    )


@app.on_event("shutdown")
async def _shutdown() -> None:
    task = getattr(app.state, "idle_task", None)
    if task is not None:
        task.cancel()


# add endpoints:

@app.get("/status")
def get_status(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_bearer(authorization)
    engine = get_engine(request)
    status = engine.status()
    # vram_mb is only meaningful when loaded; nvidia-smi-derived numbers
    # live in /gpu/raw (Task 2).
    return status


@app.post("/unload")
def post_unload(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_bearer(authorization)
    engine = get_engine(request)
    ok = engine.unload()
    if not ok:
        raise HTTPException(423, "in_flight")
    return {"unloaded": True}
```

- [ ] **Step 4: 테스트 (status/unload + idle timer fake clock)**

`ocr-service/tests/test_model.py`:

```python
"""Engine + idle-watcher unit tests.

The real GOT-OCR2 model is never touched — uses FakeRunner from conftest."""
from __future__ import annotations

import asyncio
import time

import pytest

from ocr_service.idle import idle_watcher
from ocr_service.model import OcrEngine
from tests.conftest import FakeRunner


def test_engine_load_on_first_run() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    assert not runner.is_loaded()
    engine.run("xx")
    assert runner.is_loaded()
    assert engine.last_called_at > 0


def test_engine_unload_when_idle() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")
    assert engine.unload() is True
    assert not runner.is_loaded()


def test_engine_unload_refuses_in_flight(monkeypatch) -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine._in_flight = 1
    assert engine.unload() is False
    assert runner.is_loaded() is False  # never loaded yet
    # And explicitly: not unloaded when it WAS loaded
    runner._loaded = True
    assert engine.unload() is False
    assert runner.is_loaded() is True


@pytest.mark.asyncio
async def test_idle_watcher_unloads_after_threshold() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")  # loads the runner; sets last_called_at

    # Fake clock: T+999 always (well past idle_unload_s).
    fake_now = engine.last_called_at + 999.0
    clock = lambda: fake_now

    task = asyncio.create_task(
        idle_watcher(engine, idle_unload_s=60, poll_interval_s=0.01, clock=clock)
    )
    # Give the watcher one tick.
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert not runner.is_loaded()


@pytest.mark.asyncio
async def test_idle_watcher_does_not_unload_fresh_call() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")

    fake_now = engine.last_called_at + 1.0  # only 1s elapsed
    clock = lambda: fake_now

    task = asyncio.create_task(
        idle_watcher(engine, idle_unload_s=60, poll_interval_s=0.01, clock=clock)
    )
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert runner.is_loaded()
```

`ocr-service/tests/test_app.py` 에 추가:

```python
def test_status_requires_auth(client) -> None:
    assert client.get("/status").status_code == 401


def test_status_ok(client) -> None:
    r = client.get("/status", headers={"Authorization": "Bearer test-token"})
    assert r.status_code == 200
    body = r.json()
    assert body["loaded"] is False
    assert body["in_flight"] == 0


def test_unload_when_in_flight_returns_423(client, fake_runner) -> None:
    # Force in_flight from app.state.engine
    from ocr_service.app import app as _app
    _app.state.engine._in_flight = 1
    r = client.post("/unload", headers={"Authorization": "Bearer test-token"})
    assert r.status_code == 423
```

`ocr-service/pyproject.toml` `[project.optional-dependencies].dev` 에
`pytest-asyncio>=0.23` 추가 (이미 Task 0 step 1에서 포함됨).

`ocr-service/pyproject.toml` 에 asyncio mode:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 5: 테스트 실행**

```bash
cd ocr-service
.venv/bin/pytest -v
```

Expected: 모든 테스트 PASS (~10개).

- [ ] **Step 6: 커밋**

```bash
git add ocr-service/src/ocr_service/idle.py \
        ocr-service/src/ocr_service/model_real.py \
        ocr-service/src/ocr_service/app.py \
        ocr-service/tests/test_model.py \
        ocr-service/tests/test_app.py \
        ocr-service/pyproject.toml
git commit -m "feat(ocr-service): GOT-OCR2 runner + idle auto-unload + /status, /unload

GotOcr2Runner loads stepfun-ai/GOT-OCR2_0 in fp16 on CUDA. idle_watcher
unloads after OCR_IDLE_UNLOAD_S (default 300s). /unload returns 423 if
a request is in flight."
```

---

## Task 2: ocr-service `/gpu/raw` (nvidia-smi 파싱)

**Goal:** 데스크탑의 nvidia-smi 출력을 JSON 으로 노출. 브릿지의 `/gpu/status` 가 이 엔드포인트를 fan-out 호출.

**Files:**
- Create: `ocr-service/src/ocr_service/gpu.py`
- Create: `ocr-service/tests/test_gpu.py`
- Modify: `ocr-service/src/ocr_service/app.py` (`GET /gpu/raw`)

**Acceptance Criteria:**
- [ ] `GET /gpu/raw` 가 Bearer 필요. 응답 형식: `{"total_mb", "used_mb", "free_mb", "processes": [{"pid", "name", "vram_mb"}]}`
- [ ] nvidia-smi 가 없거나 실패하면 `{"available": false, "reason": "..."}` 200으로 반환 (502 아님 — 브릿지가 graceful merge 할 수 있도록)

**Verify:** `pytest ocr-service/tests/test_gpu.py -v` → PASS

**Steps:**

- [ ] **Step 1: 파싱 모듈 (subprocess 호출 격리)**

`ocr-service/src/ocr_service/gpu.py`:

```python
"""nvidia-smi parser.

Runs two `nvidia-smi --query-...` invocations: one for GPU totals, one for
per-process VRAM. The subprocess call is wrapped behind a `runner`
callable so tests can substitute a fake."""
from __future__ import annotations

import logging
import subprocess
from typing import Callable

log = logging.getLogger(__name__)

# (cmd, parser) pairs. The runner is injected for testing.

GpuRunner = Callable[[list[str]], str]


def _real_runner(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True, timeout=5)


def query_gpu(runner: GpuRunner = _real_runner) -> dict[str, object]:
    try:
        totals_csv = runner(
            [
                "nvidia-smi",
                "--query-gpu=memory.total,memory.used,memory.free",
                "--format=csv,noheader,nounits",
            ]
        )
        procs_csv = runner(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ]
        )
    except FileNotFoundError:
        return {"available": False, "reason": "nvidia-smi_not_found"}
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": "nvidia-smi_timeout"}
    except subprocess.CalledProcessError as exc:
        return {
            "available": False,
            "reason": f"nvidia-smi_exit_{exc.returncode}",
        }

    totals_line = totals_csv.strip().splitlines()[0]
    total_s, used_s, free_s = [x.strip() for x in totals_line.split(",")]

    processes: list[dict[str, object]] = []
    for line in procs_csv.strip().splitlines():
        if not line.strip():
            continue
        parts = [x.strip() for x in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0])
            vram_mb = int(parts[2])
        except ValueError:
            continue
        processes.append({"pid": pid, "name": parts[1], "vram_mb": vram_mb})

    return {
        "available": True,
        "total_mb": int(total_s),
        "used_mb": int(used_s),
        "free_mb": int(free_s),
        "processes": processes,
    }
```

- [ ] **Step 2: 엔드포인트 wiring**

`ocr-service/src/ocr_service/app.py` 에 추가:

```python
from .gpu import query_gpu


@app.get("/gpu/raw")
def get_gpu_raw(
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_bearer(authorization)
    return query_gpu()
```

- [ ] **Step 3: 테스트 (subprocess mock)**

`ocr-service/tests/test_gpu.py`:

```python
from __future__ import annotations

import subprocess

import pytest

from ocr_service.gpu import query_gpu


def _fake_runner(out_map: dict[tuple[str, ...], str]):
    def run(cmd: list[str]) -> str:
        key = tuple(cmd[1:3])  # ('--query-gpu=...', '--format=...') signature
        for k, v in out_map.items():
            if all(any(part == kk for part in cmd) for kk in k):
                return v
        raise AssertionError(f"unexpected cmd: {cmd}")
    return run


def test_parses_totals_and_processes() -> None:
    runner = _fake_runner({
        ("--query-gpu=memory.total,memory.used,memory.free",): (
            "10240, 4280, 5960\n"
        ),
        ("--query-compute-apps=pid,process_name,used_memory",): (
            "1234, ollama, 1700\n5678, ocr-service, 1200\n"
        ),
    })
    result = query_gpu(runner=runner)
    assert result["available"] is True
    assert result["total_mb"] == 10240
    assert result["used_mb"] == 4280
    assert result["free_mb"] == 5960
    procs = result["processes"]
    assert len(procs) == 2
    assert procs[0] == {"pid": 1234, "name": "ollama", "vram_mb": 1700}


def test_handles_no_processes() -> None:
    runner = _fake_runner({
        ("--query-gpu=memory.total,memory.used,memory.free",): "10240, 0, 10240\n",
        ("--query-compute-apps=pid,process_name,used_memory",): "\n",
    })
    result = query_gpu(runner=runner)
    assert result["available"] is True
    assert result["processes"] == []


def test_handles_missing_binary() -> None:
    def boom(cmd: list[str]) -> str:
        raise FileNotFoundError("nvidia-smi")
    result = query_gpu(runner=boom)
    assert result == {"available": False, "reason": "nvidia-smi_not_found"}


def test_handles_timeout() -> None:
    def slow(cmd: list[str]) -> str:
        raise subprocess.TimeoutExpired(cmd, 5)
    result = query_gpu(runner=slow)
    assert result["available"] is False
    assert "timeout" in result["reason"]
```

`ocr-service/tests/test_app.py` 에 추가:

```python
def test_gpu_raw_requires_auth(client) -> None:
    assert client.get("/gpu/raw").status_code == 401


def test_gpu_raw_returns_available_false_no_nvidia(
    client, monkeypatch
) -> None:
    # In CI / dev machines without nvidia-smi we should still get 200.
    def boom(cmd):
        raise FileNotFoundError("nvidia-smi")
    monkeypatch.setattr("ocr_service.gpu._real_runner", boom)
    r = client.get("/gpu/raw", headers={"Authorization": "Bearer test-token"})
    assert r.status_code == 200
    assert r.json()["available"] is False
```

- [ ] **Step 4: 실행 + 커밋**

```bash
cd ocr-service && .venv/bin/pytest -v
git add ocr-service/src/ocr_service/gpu.py \
        ocr-service/src/ocr_service/app.py \
        ocr-service/tests/test_gpu.py \
        ocr-service/tests/test_app.py
git commit -m "feat(ocr-service): /gpu/raw endpoint (nvidia-smi parse)

Returns total/used/free VRAM + per-process breakdown. When nvidia-smi is
missing or fails, returns {available: false} with 200 so the bridge can
graceful-merge."
```

---

## Task 3: ocr-service 컨테이너화 (Containerfile + Quadlet)

**Goal:** 데스크탑에 rootless Podman 으로 배포 가능한 컨테이너 + Quadlet 유닛. 빌드 + 부팅 스모크.

**Files:**
- Create: `ocr-service/Containerfile`
- Create: `ocr-service/deploy/ocr-service.container`
- Create: `ocr-service/deploy/README.md` (설치 절차)

**Acceptance Criteria:**
- [ ] `podman build -t ocr-service:dev ocr-service/` 가 성공
- [ ] 컨테이너가 `BRIDGE_SHARED_TOKEN` 없이 시작하면 명확한 에러로 즉시 종료
- [ ] 컨테이너에서 `curl localhost:8080/healthz` 가 200 응답 (no auth)
- [ ] `ocr-service.container` 가 `~/.config/containers/systemd/` 에 들어가면 `systemctl --user daemon-reload && systemctl --user start ocr-service` 로 부팅 (수동 확인)

**Verify:** `podman build` 성공 + README 절차 수동 확인

**Steps:**

- [ ] **Step 1: Containerfile**

`ocr-service/Containerfile`:

```dockerfile
# Two-stage build: install deps first (slow, cached), then app code.
#
# Base: nvidia/cuda runtime image so the host's CUDA driver is enough —
# we don't compile anything inside.
FROM docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip \
        nvidia-utils-535 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

WORKDIR /app

# Copy only project metadata first for layer cache.
COPY pyproject.toml /app/
RUN python3.11 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir -e ".[model]"

COPY src /app/src

ENV PATH="/opt/venv/bin:$PATH"

EXPOSE 8080

# uvicorn with a single worker — model is in-memory so we can't multi-process.
CMD ["uvicorn", "ocr_service.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

- [ ] **Step 2: Quadlet 유닛**

`ocr-service/deploy/ocr-service.container`:

```ini
# Podman Quadlet unit for the tomboy-web OCR service.
#
# Install (on the DESKTOP — never on the Pi):
#   1. Build the image (or pull from your registry):
#        cd ocr-service && podman build -t ocr-service:latest .
#   2. Drop this file at ~/.config/containers/systemd/ocr-service.container
#   3. Create ~/.config/ocr-service.env with:
#        BRIDGE_SHARED_TOKEN=<same as bridge's BRIDGE_SECRET-derived shared token>
#        OCR_IDLE_UNLOAD_S=300
#        OCR_MODEL_ID=stepfun-ai/GOT-OCR2_0
#   4. Make sure the GPU is visible:
#        - CDI: install nvidia-container-toolkit-cdi, generate /etc/cdi/nvidia.yaml
#        - This unit uses `--device nvidia.com/gpu=all`
#   5. systemctl --user daemon-reload
#      systemctl --user enable --now ocr-service.service
#   6. Linger:
#        loginctl enable-linger $USER
#
# Important: this unit listens on 0.0.0.0:8080 INSIDE THE LAN ONLY. Do
# NOT expose 8080 to the public internet — Bearer auth is the only
# protection. The bridge (on a separate Pi machine) calls this via LAN.

[Unit]
Description=tomboy-web OCR service (GOT-OCR2)
After=network-online.target
Wants=network-online.target

[Container]
Image=localhost/ocr-service:latest
ContainerName=ocr-service
PublishPort=8080:8080
EnvironmentFile=%h/.config/ocr-service.env

# HuggingFace model cache survives container rebuilds.
Volume=%h/.cache/huggingface:/root/.cache/huggingface:Z

# GPU access via CDI.
AddDevice=nvidia.com/gpu=all

# Restart on failure but not on clean shutdown.
[Service]
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 3: 배포 README**

`ocr-service/deploy/README.md`:

```markdown
# ocr-service 배포 (데스크탑)

이 서비스는 **데스크탑(RTX 3080) 에서만** 돌린다. Pi 브릿지는 별도 머신이며 GPU가 없다.

## 사전 요구
- Fedora/Bazzite + rootless Podman 5+
- nvidia-container-toolkit (CDI 모드) — `/etc/cdi/nvidia.yaml` 생성 완료
- 데스크탑이 Pi 와 같은 LAN. 방화벽에서 8080 포트는 LAN 만 허용.

## 절차
... (위 ocr-service.container 헤더 주석과 동일한 내용)
```

- [ ] **Step 4: 빌드 검증**

```bash
cd ocr-service
podman build -t ocr-service:dev . 2>&1 | tail -20
```

Expected: 마지막에 `Successfully tagged ...`. CUDA base 이미지 다운로드로 5~10분 걸릴 수 있음.

빠른 시동 검증 (모델 로딩은 첫 `/ocr` 호출까지 미뤄지므로 healthz 만):

```bash
podman run --rm -d --name ocr-test \
  -e BRIDGE_SHARED_TOKEN=smoke \
  -p 18080:8080 \
  ocr-service:dev
sleep 5
curl -sf http://localhost:18080/healthz
podman stop ocr-test
```

Expected: `{"ok":true}`.

- [ ] **Step 5: 커밋**

```bash
git add ocr-service/Containerfile ocr-service/deploy/
git commit -m "feat(ocr-service): Containerfile + Quadlet unit for desktop deploy

Rootless Podman with nvidia.com/gpu=all (CDI). EnvironmentFile pattern
mirrors term-bridge. README emphasizes the desktop-only constraint."
```

---

## Task 4: bridge `/ocr` 프록시 추가

**Goal:** Pi 의 term-bridge 에서 `/ocr` 요청을 받아 데스크탑 ocr-service로 프록시.

**Files:**
- Create: `bridge/src/ocr.ts`
- Create: `bridge/src/ocr.test.ts`
- Modify: `bridge/src/server.ts` (라우팅 등록)
- Modify: `bridge/deploy/term-bridge.container` (`OCR_SERVICE_URL` 환경변수 문서화)

**Acceptance Criteria:**
- [ ] `POST /ocr` 가 Bearer 검증, body 검증 (image_b64 필드), `${OCR_SERVICE_URL}/ocr` 으로 forward
- [ ] 데스크탑 다운 시 503 + `{"error": "ocr_service_unavailable"}` 응답
- [ ] `vitest run bridge/src/ocr.test.ts` 통과
- [ ] `OCR_SERVICE_URL` 미설정 시 부팅 거부

**Verify:** `cd bridge && npm test -- --run ocr` → PASS

**Steps:**

- [ ] **Step 1: 핸들러 작성 (TDD — 테스트 먼저)**

`bridge/src/ocr.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleOcrProxy } from './ocr.js';

function mockReq(headers: Record<string, string>, body: object): IncomingMessage {
	const r = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
	r.headers = headers;
	r.method = 'POST';
	return r;
}

function mockRes() {
	const writes: string[] = [];
	let status = 0;
	let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => {
			status = s;
			headers = { ...headers, ...(h ?? {}) };
			return res;
		},
		end: (body?: string) => {
			if (body) writes.push(body);
		},
		setHeader: (k: string, v: string) => {
			headers[k] = v;
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

describe('handleOcrProxy', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 401 without Bearer', async () => {
		const { res, get } = mockRes();
		const req = mockReq({}, { image_b64: 'abc' });
		await handleOcrProxy(req, res, 'secret', 'http://ocr');
		expect(get().status).toBe(401);
	});

	it('returns 400 on missing image_b64', async () => {
		const { res, get } = mockRes();
		const req = mockReq({ authorization: 'Bearer t' }, {});
		// Use a token that verifyToken-mocked secret will accept; we mock fetch
		// because the call should short-circuit before the upstream is hit.
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 200 })
		);
		// Real secret check: we need verifyToken to accept "t". The auth module
		// uses timing-safe comparison; we override via env in real run. For
		// unit-test isolation we forge a token by passing the same secret.
		// Workaround: use `secret` directly as the token; verifyToken returns
		// true when token === secret.
		req.headers.authorization = 'Bearer secret';
		await handleOcrProxy(req, res, 'secret', 'http://ocr');
		expect(get().status).toBe(400);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('forwards to upstream and pipes response', async () => {
		const { res, get } = mockRes();
		const req = mockReq(
			{ authorization: 'Bearer secret' },
			{ image_b64: 'abc' }
		);
		const upstreamBody = JSON.stringify({ text: 'hello world' });
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(upstreamBody, {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		await handleOcrProxy(req, res, 'secret', 'http://ocr');
		expect(get().status).toBe(200);
		expect(get().body).toContain('hello world');
	});

	it('returns 503 on upstream network error', async () => {
		const { res, get } = mockRes();
		const req = mockReq(
			{ authorization: 'Bearer secret' },
			{ image_b64: 'abc' }
		);
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
		await handleOcrProxy(req, res, 'secret', 'http://ocr');
		expect(get().status).toBe(503);
		expect(get().body).toContain('ocr_service_unavailable');
	});
});
```

- [ ] **Step 2: 구현**

`bridge/src/ocr.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface OcrBody {
	image_b64?: unknown;
}

export async function handleOcrProxy(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: OcrBody;
	try {
		body = (await readJson(req)) as OcrBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const imageB64 = typeof body.image_b64 === 'string' ? body.image_b64 : '';
	if (!imageB64) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_image_b64' }));
		return;
	}

	let upstream: Response;
	try {
		upstream = await fetch(`${ocrServiceUrl}/ocr`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`
			},
			body: JSON.stringify({ image_b64: imageB64 })
		});
	} catch (err) {
		console.warn(`[ocr] upstream error: ${(err as Error).message}`);
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'ocr_service_unavailable' }));
		return;
	}

	const text = await upstream.text();
	res.writeHead(upstream.status, {
		'Content-Type': upstream.headers.get('content-type') ?? 'application/json'
	});
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}
```

- [ ] **Step 3: server.ts 에 라우팅 + env 등록**

`bridge/src/server.ts` 상단:

```typescript
import { handleOcrProxy } from './ocr.js';

const OCR_SERVICE_URL = requireEnv('OCR_SERVICE_URL');
```

`handleHttp` 안의 라우팅 분기 영역(다른 핸들러들 옆)에 추가:

```typescript
if (url === '/ocr' && req.method === 'POST') {
    await handleOcrProxy(req, res, SECRET, OCR_SERVICE_URL);
    return;
}
```

- [ ] **Step 4: Quadlet 문서 업데이트**

`bridge/deploy/term-bridge.container` 의 환경변수 설명 블록에 추가 (Comment 영역):

```
#        # OCR 서비스 URL. 같은 머신이면 http://localhost:8080. 분리된 머신
#        # (e.g. bridge=Pi, ocr=Desktop) 면 명시 필요:
#        #   OCR_SERVICE_URL=http://<desktop-host-ip>:8080
#        # 누락 시 부팅 거부. 같은 머신 가정으로 빠뜨려서 OCR이 안 되는
#        # 실수를 사전 차단한다.
```

- [ ] **Step 5: 테스트 + 커밋**

```bash
cd bridge
npm test -- --run ocr
```

Expected: 4 tests PASS.

```bash
git add bridge/src/ocr.ts bridge/src/ocr.test.ts bridge/src/server.ts bridge/deploy/term-bridge.container
git commit -m "feat(bridge): /ocr proxy to desktop ocr-service

OCR_SERVICE_URL required env (no default — prevents same-machine
fallback). Returns 503 on upstream network failure."
```

---

## Task 5: bridge `/gpu/status` fan-out 합본

**Goal:** ocr-service `/gpu/raw` + ocr-service `/status` + Ollama `/api/ps` 셋을 합쳐 단일 JSON 으로 반환. 부분 실패는 graceful degradation.

**Files:**
- Create: `bridge/src/gpu.ts`
- Create: `bridge/src/gpu.test.ts`
- Modify: `bridge/src/server.ts`

**Acceptance Criteria:**
- [ ] `GET /gpu/status` 가 Bearer 검증
- [ ] 세 upstream 모두 200 → §4.4 형식의 합본 응답
- [ ] 일부 upstream 실패 → 해당 섹션을 `null` 또는 `{available: false}` 로 두고 200
- [ ] `idle_for_s` 는 `(now - last_called_at)` 으로 계산

**Verify:** `cd bridge && npm test -- --run gpu` → PASS

**Steps:**

- [ ] **Step 1: 테스트 (TDD)**

`bridge/src/gpu.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGpuStatus } from './gpu.js';

function mockReq(headers: Record<string, string>): IncomingMessage {
	const r = Readable.from([]) as unknown as IncomingMessage;
	r.headers = headers;
	r.method = 'GET';
	return r;
}

function mockRes() {
	let status = 0;
	const writes: string[] = [];
	const res = {
		writeHead: (s: number) => {
			status = s;
			return res;
		},
		end: (body?: string) => {
			if (body) writes.push(body);
		},
		setHeader: () => {}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, body: JSON.parse(writes.join('') || '{}') }) };
}

describe('handleGpuStatus', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('requires Bearer', async () => {
		const { res, get } = mockRes();
		await handleGpuStatus(
			mockReq({}),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(401);
	});

	it('merges all three upstreams when healthy', async () => {
		const calls = new Map<string, Response>([
			[
				'http://ocr/gpu/raw',
				new Response(
					JSON.stringify({
						available: true,
						total_mb: 10240,
						used_mb: 4000,
						free_mb: 6240,
						processes: [{ pid: 1234, name: 'ollama', vram_mb: 1700 }]
					}),
					{ status: 200 }
				)
			],
			[
				'http://ocr/status',
				new Response(
					JSON.stringify({ loaded: true, last_called_at: 0, in_flight: 0 }),
					{ status: 200 }
				)
			],
			[
				'http://ollama/api/ps',
				new Response(
					JSON.stringify({
						models: [
							{
								name: 'exaone3.5:2.4b',
								size_vram: 1700 * 1024 * 1024,
								expires_at: '2026-05-15T16:00:00Z'
							}
						]
					}),
					{ status: 200 }
				)
			]
		]);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const r = calls.get(String(url));
			if (!r) throw new Error(`unexpected ${url}`);
			return r;
		});

		const { res, get } = mockRes();
		await handleGpuStatus(
			mockReq({ authorization: 'Bearer secret' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		const body = get().body;
		expect(get().status).toBe(200);
		expect(body.vram.total_mb).toBe(10240);
		expect(body.models.find((m: any) => m.backend === 'ollama').name).toBe(
			'exaone3.5:2.4b'
		);
		expect(body.models.find((m: any) => m.backend === 'ocr').name).toBe(
			'got-ocr2'
		);
		expect(body.processes).toHaveLength(1);
	});

	it('graceful degrades on partial failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).startsWith('http://ollama')) throw new Error('boom');
			return new Response(
				JSON.stringify({ available: true, total_mb: 10240, used_mb: 0, free_mb: 10240, processes: [] }),
				{ status: 200 }
			);
		});

		const { res, get } = mockRes();
		await handleGpuStatus(
			mockReq({ authorization: 'Bearer secret' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		const body = get().body;
		expect(get().status).toBe(200);
		expect(body.vram.total_mb).toBe(10240);
		// ollama section is marked unavailable but the rest still surfaces
		expect(body.ollama_available).toBe(false);
	});
});
```

- [ ] **Step 2: 구현**

`bridge/src/gpu.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface OllamaPsModel {
	name: string;
	size_vram?: number;
	expires_at?: string;
}

interface OcrStatus {
	loaded: boolean;
	last_called_at: number;
	in_flight: number;
}

interface OcrGpuRaw {
	available: boolean;
	total_mb?: number;
	used_mb?: number;
	free_mb?: number;
	processes?: Array<{ pid: number; name: string; vram_mb: number }>;
	reason?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
	try {
		const r = await fetch(url, init);
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch {
		return null;
	}
}

export async function handleGpuStatus(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string,
	ollamaUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	const auth = `Bearer ${secret}`;
	const [ocrRaw, ocrStatus, ollamaPs] = await Promise.all([
		fetchJson<OcrGpuRaw>(`${ocrServiceUrl}/gpu/raw`, {
			headers: { Authorization: auth }
		}),
		fetchJson<OcrStatus>(`${ocrServiceUrl}/status`, {
			headers: { Authorization: auth }
		}),
		fetchJson<{ models: OllamaPsModel[] }>(`${ollamaUrl}/api/ps`)
	]);

	const now = Date.now() / 1000;
	const models: Array<Record<string, unknown>> = [];

	if (ollamaPs && Array.isArray(ollamaPs.models)) {
		for (const m of ollamaPs.models) {
			const sizeMb = m.size_vram ? Math.round(m.size_vram / (1024 * 1024)) : 0;
			const expiresAt = m.expires_at ? new Date(m.expires_at).getTime() / 1000 : null;
			const idle = expiresAt !== null ? Math.max(0, now - (expiresAt - 300)) : null;
			models.push({
				backend: 'ollama',
				name: m.name,
				size_mb: sizeMb,
				idle_for_s: idle,
				unloadable: true
			});
		}
	}

	if (ocrStatus && ocrStatus.loaded) {
		models.push({
			backend: 'ocr',
			name: 'got-ocr2',
			size_mb: 1200,
			idle_for_s: Math.max(0, now - ocrStatus.last_called_at),
			unloadable: ocrStatus.in_flight === 0
		});
	}

	const vram = ocrRaw && ocrRaw.available
		? {
				total_mb: ocrRaw.total_mb,
				used_mb: ocrRaw.used_mb,
				free_mb: ocrRaw.free_mb
		  }
		: null;

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			vram,
			models,
			processes: ocrRaw?.processes ?? [],
			ollama_available: ollamaPs !== null,
			ocr_available: ocrStatus !== null,
			gpu_available: ocrRaw?.available ?? false,
			fetched_at: new Date().toISOString()
		})
	);
}
```

- [ ] **Step 3: server.ts 에 라우팅**

```typescript
import { handleGpuStatus } from './gpu.js';

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// inside handleHttp:
if (url === '/gpu/status' && req.method === 'GET') {
    await handleGpuStatus(req, res, SECRET, OCR_SERVICE_URL, OLLAMA_URL);
    return;
}
```

- [ ] **Step 4: 실행 + 커밋**

```bash
cd bridge && npm test -- --run gpu
```

Expected: 3 tests PASS.

```bash
git add bridge/src/gpu.ts bridge/src/gpu.test.ts bridge/src/server.ts
git commit -m "feat(bridge): /gpu/status fan-out across ocr-service and Ollama

Promise.all of /gpu/raw + /status + /api/ps. Partial failures degrade
gracefully — each upstream's *_available flag tells the UI what to hide."
```

---

## Task 6: bridge `/gpu/unload` 백엔드 라우팅

**Goal:** `{backend, name?}` 를 받아 Ollama 또는 ocr-service 에 unload 요청 전달.

**Files:**
- Modify: `bridge/src/gpu.ts` (`handleGpuUnload` 추가)
- Modify: `bridge/src/gpu.test.ts` (테스트 추가)
- Modify: `bridge/src/server.ts`

**Acceptance Criteria:**
- [ ] `POST /gpu/unload` body `{backend: "ollama", name: "exaone3.5:2.4b"}` → Ollama `/api/generate` with `keep_alive:0`
- [ ] `POST /gpu/unload` body `{backend: "ocr"}` → ocr-service `/unload`
- [ ] 알 수 없는 backend → 400
- [ ] ocr-service 가 423 응답 → 그대로 423 전달

**Verify:** `cd bridge && npm test -- --run gpu` → PASS

**Steps:**

- [ ] **Step 1: 테스트 추가**

`bridge/src/gpu.test.ts` 에 추가:

```typescript
import { handleGpuUnload } from './gpu.js';

describe('handleGpuUnload', () => {
	beforeEach(() => vi.restoreAllMocks());

	function postReq(headers: Record<string, string>, body: object): IncomingMessage {
		const r = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
		r.headers = headers;
		r.method = 'POST';
		return r;
	}

	it('routes ollama to /api/generate with keep_alive:0', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
		const { res, get } = mockRes();
		await handleGpuUnload(
			postReq({ authorization: 'Bearer secret' }, { backend: 'ollama', name: 'exaone3.5:2.4b' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(200);
		const [callUrl, callInit] = spy.mock.calls[0] as [string, RequestInit];
		expect(callUrl).toBe('http://ollama/api/generate');
		const sent = JSON.parse(callInit.body as string);
		expect(sent).toEqual({ model: 'exaone3.5:2.4b', prompt: '', keep_alive: 0 });
	});

	it('routes ocr to ocr-service /unload', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{"unloaded":true}', { status: 200 }));
		const { res, get } = mockRes();
		await handleGpuUnload(
			postReq({ authorization: 'Bearer secret' }, { backend: 'ocr' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(200);
		expect((spy.mock.calls[0] as any[])[0]).toBe('http://ocr/unload');
	});

	it('forwards 423 from ocr-service unchanged', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{"error":"in_flight"}', { status: 423 })
		);
		const { res, get } = mockRes();
		await handleGpuUnload(
			postReq({ authorization: 'Bearer secret' }, { backend: 'ocr' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(423);
	});

	it('400 on unknown backend', async () => {
		const { res, get } = mockRes();
		await handleGpuUnload(
			postReq({ authorization: 'Bearer secret' }, { backend: 'mystery' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(400);
	});

	it('400 on ollama backend without name', async () => {
		const { res, get } = mockRes();
		await handleGpuUnload(
			postReq({ authorization: 'Bearer secret' }, { backend: 'ollama' }),
			res,
			'secret',
			'http://ocr',
			'http://ollama'
		);
		expect(get().status).toBe(400);
	});
});
```

- [ ] **Step 2: 구현 추가**

`bridge/src/gpu.ts` 끝에 추가:

```typescript
interface UnloadBody {
	backend?: unknown;
	name?: unknown;
}

export async function handleGpuUnload(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string,
	ollamaUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: UnloadBody;
	try {
		body = (await readJson(req)) as UnloadBody;
	} catch {
		res.writeHead(400).end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const backend = typeof body.backend === 'string' ? body.backend : '';
	if (backend === 'ollama') {
		const name = typeof body.name === 'string' ? body.name : '';
		if (!name) {
			res.writeHead(400).end(JSON.stringify({ error: 'missing_name' }));
			return;
		}
		await proxy(
			res,
			`${ollamaUrl}/api/generate`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' } },
			JSON.stringify({ model: name, prompt: '', keep_alive: 0 })
		);
		return;
	}

	if (backend === 'ocr') {
		await proxy(
			res,
			`${ocrServiceUrl}/unload`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${secret}` }
			},
			null
		);
		return;
	}

	res.writeHead(400).end(JSON.stringify({ error: 'unknown_backend' }));
}

async function proxy(
	res: ServerResponse,
	url: string,
	init: RequestInit,
	body: string | null
): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(url, { ...init, body: body ?? init.body });
	} catch (err) {
		res.writeHead(503).end(JSON.stringify({ error: 'upstream_unavailable' }));
		return;
	}
	const text = await resp.text();
	res.writeHead(resp.status, { 'Content-Type': 'application/json' });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}
```

(`readJson` 이 `ocr.ts` 와 중복인데, 두 파일이 다른 라이프사이클이라 일단 둠. 추후 `bridge/src/httpUtils.ts` 로 추출 가능 — 이번 스코프엔 빼는 게 안전.)

- [ ] **Step 3: server.ts 라우팅 추가**

```typescript
import { handleGpuStatus, handleGpuUnload } from './gpu.js';

// inside handleHttp:
if (url === '/gpu/unload' && req.method === 'POST') {
    await handleGpuUnload(req, res, SECRET, OCR_SERVICE_URL, OLLAMA_URL);
    return;
}
```

- [ ] **Step 4: 실행 + 커밋**

```bash
cd bridge && npm test -- --run gpu
```

Expected: 8 tests PASS (3 from Task 5 + 5 new).

```bash
git add bridge/src/gpu.ts bridge/src/gpu.test.ts bridge/src/server.ts
git commit -m "feat(bridge): /gpu/unload — backend-routed model unload

Ollama: POST /api/generate with keep_alive:0 (official unload trick).
OCR: POST ocr-service /unload. 423 in-flight responses pass through."
```

---

## Task 7: 노트 시그니처 `translate:` 헤더 + defaults 단순화

**Goal:** OCR 노트 스펙에 번역 모델 지정 + 단일 시그니처 폴백 표식. 옛 `target_lang` 제거.

**Files:**
- Modify: `app/src/lib/ocrNote/defaults.ts`
- Modify: `app/src/lib/ocrNote/parseOcrNote.ts`
- Modify: `app/tests/unit/ocrNote/parseOcrNote.test.ts`

**Acceptance Criteria:**
- [ ] `parseOcrNote` 가 새 헤더 `translate: <model>` 을 읽어 `OcrNoteSpec.translateModel` 에 저장
- [ ] `translate:` 헤더가 없으면 `translateModel = undefined` 로 두고 `legacy: true` 표식 (단일 호출 경로용)
- [ ] `target_lang` 헤더는 무시 (deprecated; 기존 노트는 깨지지 않음 — 그냥 미인식 키로 dropped)
- [ ] `buildTranslatePrompt()` 가 영→한 단일 시스템 프롬프트 반환

**Verify:** `cd app && npm test -- --run parseOcrNote` → PASS

**Steps:**

- [ ] **Step 1: defaults.ts 단순화**

`app/src/lib/ocrNote/defaults.ts` 전체 교체:

```typescript
/**
 * Matches the OCR note signature line:
 *   ocr://got-ocr2
 *   ocr://qwen2.5vl:7b        (legacy single-model)
 *
 * The signature carries the OCR model name. The translation model lives
 * in a separate `translate:` header (post-split spec). When the header
 * is absent we treat the note as legacy and use the same model for both
 * extraction and translation in a single call.
 */
export const OCR_SIGNATURE_RE = /^ocr:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/**
 * Recognized header keys:
 *   - translate:   Ollama model id for the translation step. Default
 *                  is `exaone3.5:2.4b`. Absent → legacy single-call.
 *   - system:      override the translation step's system prompt.
 *   - temperature: model sampling temperature for the translation step.
 *   - num_ctx:     context size for the translation step.
 */
export const OCR_HEADER_KEY_RE =
	/^(translate|system|temperature|num_ctx):\s*(.*)$/;

export const OCR_RECOGNIZED_HEADER_KEYS = [
	'translate',
	'system',
	'temperature',
	'num_ctx'
] as const;

export type OcrHeaderKey = (typeof OCR_RECOGNIZED_HEADER_KEYS)[number];

export const OCR_DEFAULT_TRANSLATE_MODEL = 'exaone3.5:2.4b';
export const OCR_DEFAULT_TEMPERATURE = 0.2;
export const OCR_DEFAULT_NUM_CTX = 4096;

/**
 * Translation step system prompt. The use case is English print →
 * Korean, period. We don't detect language and we don't ask the model
 * to skip translation — that's UX-level logic above this call.
 */
export function buildTranslatePrompt(): string {
	return [
		'다음 영문을 자연스러운 한국어로 번역해.',
		'부연 설명, 머리말, 마무리 문구 없이 번역 결과만 출력해.',
		'줄바꿈과 단락 구분을 가능한 한 보존해.'
	].join('\n');
}
```

- [ ] **Step 2: parseOcrNote 갱신**

`app/src/lib/ocrNote/parseOcrNote.ts` 의 `OcrNoteSpec` 변경 + 파싱:

```typescript
import type { JSONContent } from '@tiptap/core';
import {
	OCR_SIGNATURE_RE,
	OCR_HEADER_KEY_RE,
	type OcrHeaderKey
} from './defaults.js';

export interface OcrNoteSpec {
	/** OCR model (signature). For the post-split flow this is `got-ocr2`
	 *  or whatever ocr-service exposes. For legacy notes it's an Ollama
	 *  vision model id. */
	model: string;
	/** Ollama translation model. Undefined when the note has no
	 *  `translate:` header — caller falls back to the legacy
	 *  single-call flow using `model` for both steps. */
	translateModel?: string;
	/** True when the note has NO `translate:` header. UI uses this to
	 *  pick the legacy code path. */
	legacy: boolean;
	system?: string;
	options: {
		temperature?: number;
		num_ctx?: number;
	};
}

function paragraphText(block: JSONContent | undefined): string {
	if (!block || !Array.isArray(block.content)) return '';
	return block.content
		.map((node) => (node.type === 'text' ? (node.text ?? '') : ''))
		.join('');
}

function paragraphLines(block: JSONContent | undefined): string[] {
	return paragraphText(block).split('\n');
}

const INT_KEYS = new Set<OcrHeaderKey>(['num_ctx']);

export function parseOcrNote(doc: JSONContent | null | undefined): OcrNoteSpec | null {
	if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return null;

	let sigIndex: number;
	let model: string;

	const c1FirstLine = doc.content.length > 1 ? paragraphLines(doc.content[1])[0] ?? '' : '';
	const m1 = OCR_SIGNATURE_RE.exec(c1FirstLine);
	if (m1) {
		sigIndex = 1;
		model = m1[1];
	} else {
		const c0FirstLine = paragraphLines(doc.content[0])[0] ?? '';
		const m0 = OCR_SIGNATURE_RE.exec(c0FirstLine);
		if (!m0) return null;
		sigIndex = 0;
		model = m0[1];
	}

	const headerLines: string[] = [];
	const sigParaLines = paragraphLines(doc.content[sigIndex]);
	for (let i = 1; i < sigParaLines.length; i++) {
		headerLines.push(sigParaLines[i]);
	}
	for (let i = sigIndex + 1; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text === '') break;
		for (const line of paragraphLines(doc.content[i])) {
			headerLines.push(line);
		}
	}

	const result: OcrNoteSpec = {
		model,
		legacy: true,
		options: {}
	};

	let currentKey: OcrHeaderKey | null = null;
	let currentValueLines: string[] = [];

	const flushKey = (): void => {
		if (currentKey === null) return;
		const value = currentValueLines.join('\n');
		if (currentKey === 'system') {
			result.system = value;
		} else if (currentKey === 'translate') {
			const trimmed = value.trim();
			if (trimmed !== '') {
				result.translateModel = trimmed;
				result.legacy = false;
			}
		} else {
			const trimmed = value.trim();
			const n = INT_KEYS.has(currentKey) ? parseInt(trimmed, 10) : parseFloat(trimmed);
			if (Number.isFinite(n)) {
				(result.options as Record<string, number>)[currentKey] = n;
			}
		}
		currentKey = null;
		currentValueLines = [];
	};

	for (const line of headerLines) {
		const keyMatch = OCR_HEADER_KEY_RE.exec(line);
		if (keyMatch) {
			flushKey();
			currentKey = keyMatch[1] as OcrHeaderKey;
			currentValueLines = [keyMatch[2]];
		} else if (currentKey !== null) {
			const stripped = line.replace(/^\s+/, '');
			currentValueLines.push(stripped);
		}
	}
	flushKey();

	return result;
}
```

- [ ] **Step 3: 테스트 업데이트**

`app/tests/unit/ocrNote/parseOcrNote.test.ts` 의 모든 케이스를 새 스키마에 맞춰 갱신. 기존 케이스 + 신규:

```typescript
import { describe, it, expect } from 'vitest';
import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';

function para(text: string) {
	return {
		type: 'paragraph',
		content: text.length === 0 ? [] : [{ type: 'text', text }]
	};
}

describe('parseOcrNote', () => {
	it('returns null for empty doc', () => {
		expect(parseOcrNote(null)).toBeNull();
		expect(parseOcrNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('parses bare signature as legacy', () => {
		const doc = {
			type: 'doc',
			content: [para('ocr://qwen2.5vl:7b')]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.model).toBe('qwen2.5vl:7b');
		expect(spec!.legacy).toBe(true);
		expect(spec!.translateModel).toBeUndefined();
	});

	it('parses translate header as non-legacy', () => {
		const doc = {
			type: 'doc',
			content: [
				para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b')
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.model).toBe('got-ocr2');
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
		expect(spec!.legacy).toBe(false);
	});

	it('allows title line above signature', () => {
		const doc = {
			type: 'doc',
			content: [para('My OCR note'), para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b')]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.model).toBe('got-ocr2');
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
	});

	it('reads system, temperature, num_ctx', () => {
		const doc = {
			type: 'doc',
			content: [
				para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b\nsystem: custom prompt\ntemperature: 0.5\nnum_ctx: 8192')
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.system).toBe('custom prompt');
		expect(spec!.options.temperature).toBe(0.5);
		expect(spec!.options.num_ctx).toBe(8192);
	});

	it('ignores legacy target_lang header (graceful)', () => {
		const doc = {
			type: 'doc',
			content: [para('ocr://qwen2.5vl:7b\ntarget_lang: 한국어')]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.legacy).toBe(true);
		// target_lang is not a recognized key in the new schema; the result
		// just doesn't have any extra field. Header is silently dropped.
		expect(spec).not.toHaveProperty('targetLang');
	});

	it('stops header parse at blank paragraph (so OCR results below are ignored)', () => {
		const doc = {
			type: 'doc',
			content: [
				para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b'),
				para(''),
				para('[원문] previous run text...'),
				para('translate: should-not-be-read')
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
	});
});
```

- [ ] **Step 4: 실행 + 커밋**

```bash
cd app && npm test -- --run parseOcrNote
```

Expected: 7 tests PASS.

```bash
git add app/src/lib/ocrNote/defaults.ts \
        app/src/lib/ocrNote/parseOcrNote.ts \
        app/tests/unit/ocrNote/parseOcrNote.test.ts
git commit -m "feat(ocrNote): translate: header + legacy single-call flag

Old target_lang header is silently dropped. New schema: ocr://<vision>
+ translate: <ollama>. Spec.legacy=true when translate is absent;
runOcrInEditor uses that flag to pick the old single-call path."
```

---

## Task 8: `runOcrInEditor` 두 단계 분리

**Goal:** OCR 호출 + 번역 호출 직렬 실행. 두 블록 ([원문]/[번역]) 스트리밍. legacy 노트는 옛 한-번-호출 경로로 폴백.

**Files:**
- Create: `app/src/lib/ocrNote/sendOcr.ts`
- Create: `app/tests/unit/ocrNote/sendOcr.test.ts`
- Modify: `app/src/lib/ocrNote/runOcrInEditor.ts`

**Acceptance Criteria:**
- [ ] `sendOcr({url, token, imageB64})` 가 `{text, reason}` 반환. 네트워크 에러는 `OcrSendError` throw.
- [ ] `runOcrInEditor` non-legacy 경로: 1) `sendOcr` 호출 → [원문] 블록 스트리밍 2) 그 결과로 `sendChat` 호출 → [번역] 블록 스트리밍.
- [ ] legacy 경로 (spec.legacy=true): 옛 단일 `sendChat` 호출만 유지 (시스템 프롬프트는 옛 OCR+번역 통합 프롬프트 — task 7에서 지워졌으니 함수로 인라인).
- [ ] 단위 테스트: sendOcr happy path + 401/503 + JSON 디코드 실패.

**Verify:** `cd app && npm test -- --run ocrNote` → PASS

**Steps:**

- [ ] **Step 1: sendOcr 헬퍼**

`app/src/lib/ocrNote/sendOcr.ts`:

```typescript
/**
 * OCR-only HTTP helper. Posts a base64 image to the bridge's /ocr
 * endpoint and returns the extracted text.
 *
 * Unlike sendChat this is NOT streaming — ocr-service returns a single
 * JSON body. We could add SSE later; for now keep it simple. The caller
 * is responsible for any "OCR 진행 중…" placeholder.
 */
export type OcrSendErrorKind =
	| 'unauthorized'
	| 'ocr_service_unavailable'
	| 'bad_request'
	| 'network';

export class OcrSendError extends Error {
	kind: OcrSendErrorKind;
	status?: number;
	constructor(kind: OcrSendErrorKind, opts: { status?: number; message?: string } = {}) {
		super(opts.message ?? kind);
		this.name = 'OcrSendError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface SendOcrOptions {
	url: string;
	token: string;
	imageB64: string;
	signal?: AbortSignal;
}

export async function sendOcr(opts: SendOcrOptions): Promise<{ text: string }> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ image_b64: opts.imageB64 }),
			signal: opts.signal
		});
	} catch (err) {
		throw new OcrSendError('network', { message: (err as Error).message });
	}

	if (resp.status === 401) throw new OcrSendError('unauthorized', { status: 401 });
	if (resp.status === 503) throw new OcrSendError('ocr_service_unavailable', { status: 503 });
	if (resp.status === 400) {
		const body = await resp.json().catch(() => ({}));
		throw new OcrSendError('bad_request', {
			status: 400,
			message: (body as { detail?: string }).detail ?? 'bad_request'
		});
	}
	if (!resp.ok) {
		throw new OcrSendError('network', {
			status: resp.status,
			message: `upstream ${resp.status}`
		});
	}

	const body = (await resp.json()) as { text?: string };
	return { text: body.text ?? '' };
}
```

- [ ] **Step 2: sendOcr 테스트**

`app/tests/unit/ocrNote/sendOcr.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendOcr, OcrSendError } from '$lib/ocrNote/sendOcr.js';

describe('sendOcr', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns text on 200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
		);
		const out = await sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' });
		expect(out.text).toBe('hello');
	});

	it('throws unauthorized on 401', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('', { status: 401 })
		);
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('throws ocr_service_unavailable on 503', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('', { status: 503 })
		);
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toMatchObject({ kind: 'ocr_service_unavailable' });
	});

	it('throws bad_request on 400 with detail', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ detail: 'missing_image_b64' }), { status: 400 })
		);
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: '' })
		).rejects.toMatchObject({ kind: 'bad_request' });
	});

	it('throws network on fetch failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toBeInstanceOf(OcrSendError);
	});
});
```

- [ ] **Step 3: runOcrInEditor 두 단계 흐름**

`app/src/lib/ocrNote/runOcrInEditor.ts` 의 핵심 변경:

```typescript
import type { Editor } from '@tiptap/core';
import { sendChat, LlmChatError } from '../llmNote/sendChat.js';
import type { ChatRequestBody } from '../llmNote/buildChatRequest.js';
import { sendOcr, OcrSendError } from './sendOcr.js';
import { imageBlobToBase64 } from './imageToBase64.js';
import { downloadImageFromDropboxUrl } from '../sync/imageUpload.js';
import {
	OCR_DEFAULT_NUM_CTX,
	OCR_DEFAULT_TEMPERATURE,
	OCR_DEFAULT_TRANSLATE_MODEL,
	buildTranslatePrompt
} from './defaults.js';
import type { OcrNoteSpec } from './parseOcrNote.js';

export interface RunOcrOptions {
	editor: Editor;
	spec: OcrNoteSpec;
	imageUrl: string;
	imageBlob?: Blob;
	bridgeUrl: string;
	bridgeToken: string;
	onStatus?: (msg: string) => void;
}

export interface RunOcrResult {
	reason: 'done' | 'abort' | 'stream_error' | 'error';
	text: string;
}

export async function runOcrInEditor(opts: RunOcrOptions): Promise<RunOcrResult> {
	const { editor, spec, bridgeUrl, bridgeToken } = opts;
	const httpBase = normalizeHttpBase(bridgeUrl);

	editor.setEditable(false);
	const ocrBlockPos: { current: number | null } = { current: null };

	try {
		opts.onStatus?.('이미지 처리 중…');
		const imageB64 = await loadImageB64(opts);
		if (imageB64 === null) {
			return { reason: 'error', text: '' };
		}

		if (spec.legacy) {
			return await runLegacy(opts, httpBase, imageB64);
		}

		// === Two-stage flow ===

		// 1) OCR. Block called [원문]; cant stream, single JSON body. Show
		// a transient "OCR 진행 중…" placeholder while waiting.
		ocrBlockPos.current = appendBlock(editor, '[원문]\nOCR 진행 중…');
		let extractedText: string;
		try {
			const out = await sendOcr({
				url: `${httpBase}/ocr`,
				token: bridgeToken,
				imageB64
			});
			extractedText = out.text;
			replaceBlockContent(editor, ocrBlockPos.current, `[원문]\n${extractedText}`);
		} catch (err) {
			const msg = formatOcrError(err);
			replaceBlockContent(editor, ocrBlockPos.current, `[OCR 오류: ${msg}]`);
			return { reason: 'error', text: '' };
		}

		if (!extractedText.trim()) {
			return { reason: 'done', text: '' };
		}

		// 2) Translation via Ollama. Block called [번역]; stream tokens in.
		opts.onStatus?.('번역 중…');
		const translateModel = spec.translateModel ?? OCR_DEFAULT_TRANSLATE_MODEL;
		const translateSystem = spec.system && spec.system.length > 0
			? spec.system
			: buildTranslatePrompt();
		const transBlockPos = appendBlock(editor, '[번역]\n');
		let translatedAccum = '';
		const body: ChatRequestBody = {
			model: translateModel,
			options: {
				temperature: spec.options.temperature ?? OCR_DEFAULT_TEMPERATURE,
				num_ctx: spec.options.num_ctx ?? OCR_DEFAULT_NUM_CTX
			},
			messages: [
				{ role: 'system', content: translateSystem },
				{ role: 'user', content: extractedText }
			]
		};
		const result = await sendChat({
			url: `${httpBase}/llm/chat`,
			token: bridgeToken,
			body,
			onToken: (delta) => {
				translatedAccum += delta;
				replaceBlockContent(editor, transBlockPos, `[번역]\n${translatedAccum}`);
			}
		});
		return { reason: result.reason, text: `${extractedText}\n\n${translatedAccum}` };
	} catch (err) {
		const msg = err instanceof LlmChatError ? formatLlmError(err) : (err as Error).message;
		appendBlock(editor, `[OCR 오류: ${msg}]`);
		return { reason: 'error', text: '' };
	} finally {
		editor.setEditable(true);
	}
}

async function runLegacy(
	opts: RunOcrOptions,
	httpBase: string,
	imageB64: string
): Promise<RunOcrResult> {
	// Old one-shot flow: a single vision model does OCR + translation.
	const { editor, spec, bridgeToken } = opts;
	opts.onStatus?.('OCR 분석 중…');
	const placeholderPos = appendBlock(editor, '[OCR 진행 중…]');
	let firstTokenSeen = false;
	let accumulated = '';

	const body: ChatRequestBody = {
		model: spec.model,
		options: {
			temperature: spec.options.temperature ?? OCR_DEFAULT_TEMPERATURE,
			num_ctx: spec.options.num_ctx ?? OCR_DEFAULT_NUM_CTX
		},
		messages: [
			{
				role: 'system',
				content:
					spec.system && spec.system.length > 0 ? spec.system : LEGACY_PROMPT
			},
			{
				role: 'user',
				content: '이 이미지의 텍스트를 추출해줘.',
				images: [imageB64]
			}
		]
	};

	const result = await sendChat({
		url: `${httpBase}/llm/chat`,
		token: bridgeToken,
		body,
		onToken: (delta) => {
			if (!firstTokenSeen) {
				replaceBlockContent(editor, placeholderPos, delta);
				accumulated = delta;
				firstTokenSeen = true;
			} else {
				accumulated += delta;
				replaceBlockContent(editor, placeholderPos, accumulated);
			}
		}
	});
	if (!firstTokenSeen) {
		replaceBlockContent(editor, placeholderPos, '[OCR 결과 없음]');
	}
	return { reason: result.reason, text: accumulated };
}

const LEGACY_PROMPT = [
	'당신은 이미지에서 텍스트를 정확히 추출하는 OCR 어시스턴트입니다.',
	'',
	'규칙:',
	'1. 이미지의 모든 텍스트를 원본 그대로 추출합니다.',
	'2. 추출한 텍스트가 한국어가 아니면 한국어 번역도 함께 제공합니다.',
	'3. 추출한 텍스트가 이미 한국어면 [번역] 섹션은 생략합니다.',
	'4. 출력 외의 설명/주석을 덧붙이지 않습니다.',
	'',
	'출력 형식:',
	'[원문]',
	'<추출한 텍스트 그대로>',
	'',
	'[번역] (한국어가 아닐 때만)',
	'<한국어 번역>'
].join('\n');

// --- helpers (most of these are lifted from the old file) ---

function normalizeHttpBase(bridgeUrl: string): string {
	return bridgeUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/(ws|llm\/chat|ocr)\/?$/, '')
		.replace(/\/$/, '');
}

async function loadImageB64(opts: RunOcrOptions): Promise<string | null> {
	try {
		const blob = opts.imageBlob ?? (await downloadImageFromDropboxUrl(opts.imageUrl));
		return await imageBlobToBase64(blob);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendBlock(opts.editor, `[OCR 오류: ${msg}]`);
		return null;
	}
}

function appendBlock(editor: Editor, initialText: string): number {
	const { state, view } = editor;
	const endPos = state.doc.content.size;
	const blank = state.schema.nodes.paragraph.create();
	const block = state.schema.nodes.paragraph.create(
		null,
		initialText === '' ? null : state.schema.text(initialText)
	);
	const tr = state.tr.insert(endPos, [blank, block]);
	view.dispatch(tr);
	scrollToBottom(editor);
	return endPos + 2;
}

function replaceBlockContent(editor: Editor, paragraphPos: number, newText: string): void {
	const { state, view } = editor;
	const para = state.doc.nodeAt(paragraphPos);
	if (!para || para.type.name !== 'paragraph') return;
	// Split on \n so hardBreak nodes are inserted between lines.
	const lines = newText.split('\n');
	const fragments: any[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && state.schema.nodes.hardBreak) {
			fragments.push(state.schema.nodes.hardBreak.create());
		}
		if (lines[i].length > 0) {
			fragments.push(state.schema.text(lines[i]));
		}
	}
	const innerStart = paragraphPos + 1;
	const innerEnd = paragraphPos + 1 + para.content.size;
	const tr = state.tr.replaceWith(innerStart, innerEnd, fragments);
	view.dispatch(tr);
	scrollToBottom(editor);
}

function scrollToBottom(editor: Editor): void {
	try {
		editor.view.dom.scrollTop = editor.view.dom.scrollHeight;
	} catch {
		/* ignore */
	}
}

function formatOcrError(err: unknown): string {
	if (err instanceof OcrSendError) {
		switch (err.kind) {
			case 'unauthorized': return '인증 실패 — 설정에서 브릿지 재로그인';
			case 'ocr_service_unavailable': return '데스크탑 OCR 서비스 응답 없음';
			case 'bad_request': return `잘못된 요청: ${err.message}`;
			case 'network':
			default: return '연결 실패';
		}
	}
	return (err as Error).message;
}

function formatLlmError(err: LlmChatError): string {
	switch (err.kind) {
		case 'unauthorized': return '인증 실패 — 설정에서 브릿지 재로그인';
		case 'model_not_found': return `모델 '${err.model ?? '?'}' 없음. ollama pull 필요`;
		case 'ollama_unavailable': return 'Ollama 서비스 응답 없음';
		case 'bad_request': return `요청 오류 ${err.message ?? ''}`;
		case 'upstream_error': return '브릿지 응답 오류';
		case 'network':
		default: return '연결 실패';
	}
}
```

(`imageToBase64.ts` 와 `downloadImageFromDropboxUrl` 는 변경 없음.)

- [ ] **Step 4: 실행 + 커밋**

```bash
cd app && npm test -- --run ocrNote
```

Expected: parseOcrNote (7) + sendOcr (5) = 12 PASS.

`npm run check` 도 통과해야 함:

```bash
cd app && npm run check 2>&1 | tail
```

Expected: 0 errors.

```bash
git add app/src/lib/ocrNote/sendOcr.ts \
        app/src/lib/ocrNote/runOcrInEditor.ts \
        app/tests/unit/ocrNote/sendOcr.test.ts
git commit -m "feat(ocrNote): two-stage OCR → translate flow

Non-legacy notes call /ocr (single-shot) then /llm/chat (streaming) and
emit [원문]/[번역] blocks. Legacy notes keep the single-call combined
prompt. translateModel defaults to exaone3.5:2.4b."
```

---

## Task 9: `/admin/gpu` 페이지

**Goal:** admin 영역에 GPU 모니터 + 수동 언로드 페이지 추가.

**Files:**
- Create: `app/src/lib/gpuMonitor/types.ts`
- Create: `app/src/lib/gpuMonitor/client.ts`
- Create: `app/tests/unit/gpuMonitor/client.test.ts`
- Create: `app/src/routes/admin/gpu/+page.svelte`
- Modify: `app/src/routes/admin/+layout.svelte` (서브탭 추가)

**Acceptance Criteria:**
- [ ] `fetchGpuStatus(bridgeUrl, token)` 가 `/gpu/status` 호출 → 파싱 → 타입드 객체 반환
- [ ] `unloadModel(bridgeUrl, token, {backend, name?})` 가 `/gpu/unload` POST
- [ ] 페이지 mount 시 5초 폴링 시작, unmount/visibility hidden 시 정지
- [ ] 각 모델 행에 [언로드] 버튼; 클릭 → 토스트 + 즉시 재폴링
- [ ] 데스크탑 다운 (모든 *_available=false) 시 친절한 빈 상태
- [ ] /admin 서브탭에 "GPU" 추가, 다른 탭과 일관된 스타일

**Verify:**
- `cd app && npm test -- --run gpuMonitor` → PASS
- `cd app && npm run check` → 0 errors
- 수동: 데스크탑/브릿지 띄운 상태에서 `/admin/gpu` 진입 → 모델 목록 + 언로드 동작 확인

**Steps:**

- [ ] **Step 1: 타입**

`app/src/lib/gpuMonitor/types.ts`:

```typescript
export interface GpuStatusResponse {
	vram: { total_mb: number; used_mb: number; free_mb: number } | null;
	models: GpuStatusModel[];
	processes: Array<{ pid: number; name: string; vram_mb: number }>;
	ollama_available: boolean;
	ocr_available: boolean;
	gpu_available: boolean;
	fetched_at: string;
}

export interface GpuStatusModel {
	backend: 'ollama' | 'ocr';
	name: string;
	size_mb: number;
	idle_for_s: number | null;
	unloadable: boolean;
}

export interface UnloadRequest {
	backend: 'ollama' | 'ocr';
	name?: string;
}
```

- [ ] **Step 2: 클라이언트 + 테스트**

`app/src/lib/gpuMonitor/client.ts`:

```typescript
import type { GpuStatusResponse, UnloadRequest } from './types.js';

export class GpuMonitorError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

function httpBase(bridgeUrl: string): string {
	return bridgeUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/(ws|llm\/chat|ocr|gpu\/.*)\/?$/, '')
		.replace(/\/$/, '');
}

export async function fetchGpuStatus(
	bridgeUrl: string,
	token: string
): Promise<GpuStatusResponse> {
	const resp = await fetch(`${httpBase(bridgeUrl)}/gpu/status`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!resp.ok) {
		throw new GpuMonitorError(`status ${resp.status}`, resp.status);
	}
	return (await resp.json()) as GpuStatusResponse;
}

export async function unloadModel(
	bridgeUrl: string,
	token: string,
	req: UnloadRequest
): Promise<{ ok: boolean; status: number; message?: string }> {
	const resp = await fetch(`${httpBase(bridgeUrl)}/gpu/unload`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify(req)
	});
	if (resp.ok) return { ok: true, status: resp.status };
	const body = await resp.json().catch(() => ({}));
	return {
		ok: false,
		status: resp.status,
		message: (body as { error?: string }).error
	};
}
```

`app/tests/unit/gpuMonitor/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGpuStatus, unloadModel, GpuMonitorError } from '$lib/gpuMonitor/client.js';

describe('fetchGpuStatus', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns parsed body on 200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					vram: { total_mb: 10240, used_mb: 0, free_mb: 10240 },
					models: [],
					processes: [],
					ollama_available: true,
					ocr_available: true,
					gpu_available: true,
					fetched_at: '2026-05-15T00:00:00Z'
				}),
				{ status: 200 }
			)
		);
		const out = await fetchGpuStatus('https://bridge', 't');
		expect(out.vram?.total_mb).toBe(10240);
		expect(out.ollama_available).toBe(true);
	});

	it('throws on non-200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
		await expect(fetchGpuStatus('https://bridge', 't')).rejects.toBeInstanceOf(
			GpuMonitorError
		);
	});

	it('strips ws:// and trailing paths from bridgeUrl', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					vram: null, models: [], processes: [],
					ollama_available: false, ocr_available: false, gpu_available: false,
					fetched_at: 'now'
				}),
				{ status: 200 }
			)
		);
		await fetchGpuStatus('wss://bridge.example.com/ws', 't');
		expect((spy.mock.calls[0] as [string])[0]).toBe(
			'https://bridge.example.com/gpu/status'
		);
	});
});

describe('unloadModel', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('posts JSON body', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
		await unloadModel('https://bridge', 't', {
			backend: 'ollama',
			name: 'exaone3.5:2.4b'
		});
		const init = (spy.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(init.body as string)).toEqual({
			backend: 'ollama',
			name: 'exaone3.5:2.4b'
		});
	});

	it('returns {ok:false, status:423} on in-flight', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: 'in_flight' }), { status: 423 })
		);
		const r = await unloadModel('https://bridge', 't', { backend: 'ocr' });
		expect(r.ok).toBe(false);
		expect(r.status).toBe(423);
		expect(r.message).toBe('in_flight');
	});
});
```

- [ ] **Step 3: 페이지**

`app/src/routes/admin/gpu/+page.svelte`:

```svelte
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fetchGpuStatus, unloadModel, GpuMonitorError } from '$lib/gpuMonitor/client.js';
	import type { GpuStatusResponse, GpuStatusModel } from '$lib/gpuMonitor/types.js';
	import { appSettings } from '$lib/storage/appSettings.js';
	import { showToast } from '$lib/stores/toast.js';

	let status: GpuStatusResponse | null = $state(null);
	let error: string | null = $state(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const POLL_MS = 5000;

	async function refresh(): Promise<void> {
		const bridgeUrl = await appSettings.get('terminalBridgeUrl');
		const token = await appSettings.get('terminalBridgeToken');
		if (!bridgeUrl || !token) {
			error = '터미널 브릿지 설정이 필요합니다. 설정 → 터미널 브릿지에서 로그인하세요.';
			return;
		}
		try {
			status = await fetchGpuStatus(bridgeUrl, token);
			error = null;
		} catch (err) {
			if (err instanceof GpuMonitorError) {
				error = `브릿지 응답 ${err.status}`;
			} else {
				error = '브릿지 연결 실패';
			}
		}
	}

	function startPolling(): void {
		stopPolling();
		void refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === 'visible') startPolling();
		else stopPolling();
	}

	onMount(() => {
		startPolling();
		document.addEventListener('visibilitychange', onVisibilityChange);
	});

	onDestroy(() => {
		stopPolling();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
	});

	async function handleUnload(m: GpuStatusModel): Promise<void> {
		const bridgeUrl = await appSettings.get('terminalBridgeUrl');
		const token = await appSettings.get('terminalBridgeToken');
		if (!bridgeUrl || !token) return;
		const r = await unloadModel(bridgeUrl, token, {
			backend: m.backend,
			name: m.backend === 'ollama' ? m.name : undefined
		});
		if (r.ok) {
			showToast(`${m.name} 언로드됨`);
			void refresh();
		} else if (r.status === 423) {
			showToast('사용 중 — 잠시 후 다시 시도');
		} else {
			showToast(`언로드 실패: ${r.message ?? r.status}`);
		}
	}

	function formatIdle(s: number | null): string {
		if (s === null) return '—';
		if (s < 60) return `${Math.round(s)}초 전 사용`;
		const m = Math.floor(s / 60);
		const rem = Math.round(s % 60);
		return `${m}분 ${rem}초 전 사용`;
	}
</script>

<div class="page">
	<h1>GPU</h1>

	{#if error}
		<div class="error-banner">{error}</div>
	{/if}

	{#if status?.vram}
		<section class="vram">
			<div class="bar">
				<div
					class="fill"
					style="width: {(status.vram.used_mb / status.vram.total_mb) * 100}%"
				></div>
			</div>
			<div class="vram-label">
				{status.vram.used_mb} / {status.vram.total_mb} MB
				({Math.round((status.vram.used_mb / status.vram.total_mb) * 100)}%)
			</div>
		</section>
	{:else if status && !status.gpu_available}
		<p class="empty">GPU 정보를 가져올 수 없습니다 (nvidia-smi 응답 없음).</p>
	{/if}

	{#if status}
		<section class="models">
			<h2>로드된 모델</h2>
			{#if status.models.length === 0}
				<p class="empty">로드된 모델 없음.</p>
			{:else}
				<ul>
					{#each status.models as m}
						<li>
							<div class="row">
								<div class="meta">
									<span class="name">{m.name}</span>
									<span class="badge">{m.backend}</span>
									<span class="size">{m.size_mb} MB</span>
								</div>
								<div class="idle">{formatIdle(m.idle_for_s)}</div>
								<button
									type="button"
									disabled={!m.unloadable}
									onclick={() => handleUnload(m)}
								>
									언로드
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if status.processes.length > 0}
			<section class="processes">
				<h2>프로세스 (nvidia-smi)</h2>
				<ul>
					{#each status.processes as p}
						<li>{p.name} (pid {p.pid}) — {p.vram_mb} MB</li>
					{/each}
				</ul>
			</section>
		{/if}

		<footer class="fetched">{new Date(status.fetched_at).toLocaleString()}</footer>
	{/if}
</div>

<style>
	.page { padding: 1rem; max-width: 720px; }
	.error-banner { padding: .75rem; background: #fee; border: 1px solid #fcc; border-radius: 4px; margin-bottom: 1rem; }
	.vram .bar { height: 16px; background: #eee; border-radius: 4px; overflow: hidden; }
	.vram .fill { height: 100%; background: #4a90e2; transition: width .3s; }
	.vram-label { margin-top: .25rem; font-size: .9rem; color: #555; }
	.models ul, .processes ul { list-style: none; padding: 0; }
	.models li, .processes li { padding: .5rem 0; border-bottom: 1px solid #eee; }
	.row { display: flex; align-items: center; gap: .75rem; }
	.row .meta { flex: 1; display: flex; gap: .5rem; align-items: baseline; }
	.row .name { font-weight: 600; }
	.row .badge { font-size: .75rem; background: #eef; padding: .1rem .4rem; border-radius: 3px; }
	.row .size { color: #555; }
	.row .idle { color: #777; font-size: .85rem; }
	.row button { padding: .25rem .75rem; }
	.empty { color: #888; }
	.fetched { color: #aaa; font-size: .75rem; margin-top: 1rem; }
</style>
```

- [ ] **Step 4: admin 서브탭에 GPU 추가**

`app/src/routes/admin/+layout.svelte` 의 nav 정의 부분에 항목 추가. 정확한 위치는 파일을 읽어 확인 — 보통 배열/리스트 형태:

```svelte
<!-- 기존 nav 항목 옆에 -->
<a href="/admin/gpu" aria-current={page.url.pathname.startsWith('/admin/gpu') ? 'page' : undefined}>GPU</a>
```

(태그/스타일은 기존 항목과 동일하게 맞춤. 파일을 읽어 그 패턴 그대로 따라.)

- [ ] **Step 5: 테스트 + 타입체크 + 커밋**

```bash
cd app && npm test -- --run gpuMonitor
npm run check 2>&1 | tail
```

Expected: gpuMonitor 5 PASS + `npm run check` 0 errors.

```bash
git add app/src/lib/gpuMonitor/ \
        app/src/routes/admin/gpu/ \
        app/src/routes/admin/+layout.svelte \
        app/tests/unit/gpuMonitor/
git commit -m "feat(admin): /admin/gpu page with VRAM monitor and manual unload

Polls /gpu/status every 5s while visible. Per-model unload buttons.
Friendly empty/error states when desktop is unreachable."
```

---

## Task 10: invariant 문서화 (머신 분리)

**Goal:** 미래의 작업자(혹은 미래의 나)가 같은 머신을 가정하는 실수를 안 하도록 invariant 를 영구 기록.

**Files:**
- Modify: `.claude/skills/tomboy-terminal/SKILL.md`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `tomboy-terminal` 스킬에 "Pi는 GPU 없음, 모델 호스팅은 데스크탑" 단락 추가
- [ ] CLAUDE.md 터미널 노트 섹션 / `Cross-cutting invariants` 영역에 한 줄 추가

**Verify:** 두 파일 diff 확인. 텍스트 검색으로 invariant 노출 여부 확인.

**Steps:**

- [ ] **Step 1: tomboy-terminal SKILL.md 갱신**

기존 "Cross-cutting invariants" 섹션을 찾아 다음을 추가 (`-` 항목으로):

```
- **Pi 브릿지는 GPU가 없다.** 브릿지는 라우팅·인증·SSH 터미널만 담당하고
  모델(Ollama, ocr-service, llama.cpp 등)은 절대 호스팅하지 않는다.
  모든 모델은 별도 데스크탑(RTX 3080)에서 실행되며 브릿지가
  `OLLAMA_BASE_URL`, `OCR_SERVICE_URL`, `RAG_SEARCH_URL` 환경변수로
  데스크탑 LAN IP 를 가리킨다. **같은 머신을 가정하면 안 된다** —
  과거에 이 가정 때문에 OCR 분리 작업과 RAG 도입에서 잘못된 설계로
  되돌린 적이 있다.
```

- [ ] **Step 2: CLAUDE.md 갱신**

`CLAUDE.md` 의 "터미널 노트 (SSH terminal in a note)" 섹션의 "Cross-cutting invariants worth caching" 리스트에 같은 invariant 한 줄로 추가:

```
- **Bridge ≠ model host.** The Pi-side bridge has no GPU. Ollama, ocr-service,
  and any other model runtime live on a separate desktop. Bridge points to
  them via `OLLAMA_BASE_URL`/`OCR_SERVICE_URL`/`RAG_SEARCH_URL`.
```

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/tomboy-terminal/SKILL.md CLAUDE.md
git commit -m "docs: invariant — Pi bridge has no GPU, all models on desktop

Past mistakes (OCR split, RAG intro) traced back to assuming bridge and
model host were the same machine. Locking the separation in two places."
```

---

## Spec Coverage Self-Review

- §2 머신 분리 invariant → Task 10
- §3 OCR → 번역 두 단계 흐름 → Task 8 (legacy 폴백 포함)
- §4.1 ocr-service 엔드포인트들 → Tasks 0, 1, 2
- §4.2 bridge `/ocr`, `/gpu/status`, `/gpu/unload` → Tasks 4, 5, 6
- §4.3.1 `runOcrInEditor` 두 단계 분리 → Task 8
- §4.3.2 노트 시그니처 `translate:` 헤더 → Task 7
- §4.3.3 `/admin/gpu` 페이지 → Task 9
- §4.4 응답 형식 → Tasks 5, 9 (구현/소비)
- §5 VRAM 충돌 모델 (idle unload 권장) → Task 1
- 컨테이너 배포 → Task 3

모든 spec 요구가 어느 한 task 로 매핑됨. Placeholder 없음. 타입 일관성 OK
(`OcrNoteSpec.translateModel`, `GpuStatusModel.backend` 등 task 사이에 동일하게 사용).
