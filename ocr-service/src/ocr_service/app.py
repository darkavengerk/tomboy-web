"""HTTP entrypoint. Endpoints:

  POST /ocr        — run GOT-OCR2 on a base64 image
  GET  /status     — model load/idle state
  POST /unload     — release GPU memory
  GET  /gpu/raw    — nvidia-smi parse (Task 2)
  GET  /healthz    — liveness

All non-health endpoints require Bearer token matching `BRIDGE_SHARED_TOKEN`.
"""
from __future__ import annotations

import asyncio
import secrets

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from .config import get_settings
from .idle import idle_watcher
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
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(401, "unauthorized")


class OcrBody(BaseModel):
    image_b64: str


@app.on_event("startup")
async def _startup() -> None:
    # Tests pre-populate `app.state.engine` via the `client` fixture; skip
    # wiring the real GotOcr2Runner in that case so tests never hit
    # transformers.
    if getattr(app.state, "engine", None) is not None:
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


@app.get("/status")
def get_status(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_bearer(authorization)
    engine = get_engine(request)
    return engine.status()


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
