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


def test_status_requires_auth(client) -> None:
    assert client.get("/status").status_code == 401


def test_status_ok(client) -> None:
    r = client.get("/status", headers={"Authorization": "Bearer test-token"})
    assert r.status_code == 200
    body = r.json()
    assert body["loaded"] is False
    assert body["in_flight"] == 0


def test_unload_when_in_flight_returns_423(client) -> None:
    from ocr_service.app import app as _app

    _app.state.engine._in_flight = 1
    r = client.post("/unload", headers={"Authorization": "Bearer test-token"})
    assert r.status_code == 423
