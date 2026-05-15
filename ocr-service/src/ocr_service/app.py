"""HTTP entrypoint. Endpoints:

  POST /ocr        — run GOT-OCR2 on a base64 image
  GET  /status     — model load/idle state (Task 1)
  POST /unload     — release GPU memory (Task 1)
  GET  /gpu/raw    — nvidia-smi parse (Task 2)
  GET  /healthz    — liveness

All non-health endpoints require Bearer token matching `BRIDGE_SHARED_TOKEN`.
"""
from __future__ import annotations

import secrets

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
    if authorization is None or not secrets.compare_digest(authorization, expected):
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
