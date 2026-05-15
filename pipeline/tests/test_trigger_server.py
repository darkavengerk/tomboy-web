from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from desktop.trigger_server import JobState, PipelineRunner, make_handler


class _FakeRunner:
    """A PipelineRunner stand-in. Each ``run()`` blocks until ``release()``
    is called so tests can poke status while a "run" is in flight."""

    def __init__(self, exit_code: int = 0, stdout: str = "ok", stderr: str = "") -> None:
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self._gate = threading.Event()
        self.runs = 0

    def release(self) -> None:
        self._gate.set()

    def run(self) -> tuple[int, str, str]:
        self.runs += 1
        self._gate.wait(timeout=5)
        return self.exit_code, self.stdout, self.stderr


@pytest.fixture
def server():
    """Start the trigger server on an ephemeral port, yield (port, runner,
    state). Teardown shuts the server cleanly."""
    state = JobState()
    runner = _FakeRunner()
    handler_cls = make_handler(token="t0p-secret", state=state, runner=runner)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield port, runner, state
    finally:
        # Release any pending run so the worker thread can finish before
        # we tear down the server.
        runner.release()
        httpd.shutdown()
        httpd.server_close()


def _http(method: str, url: str, *, token: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url, method=method)
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"_raw": body}


def test_health_is_unauthenticated(server):
    port, _, _ = server
    code, body = _http("GET", f"http://127.0.0.1:{port}/health")
    assert code == 200
    assert body == {"ok": True}


def test_run_without_token_is_401(server):
    port, _, _ = server
    code, body = _http("POST", f"http://127.0.0.1:{port}/run")
    assert code == 401
    assert body["ok"] is False


def test_run_starts_pipeline(server):
    port, runner, state = server
    code, body = _http("POST", f"http://127.0.0.1:{port}/run", token="t0p-secret")
    assert code == 202
    assert body["started"] is True
    assert body["running"] is True
    assert body["jobId"]
    # Job is still in flight (FakeRunner blocks on _gate).
    snap = state.snapshot()
    assert snap["running"] is True
    runner.release()
    # Wait for the worker to record completion.
    deadline = time.time() + 5
    while time.time() < deadline and state.snapshot()["running"]:
        time.sleep(0.02)
    assert runner.runs == 1
    final = state.snapshot()
    assert final["running"] is False
    assert final["exitCode"] == 0


def test_run_returns_409_when_already_running(server):
    port, runner, state = server
    _http("POST", f"http://127.0.0.1:{port}/run", token="t0p-secret")
    code, body = _http("POST", f"http://127.0.0.1:{port}/run", token="t0p-secret")
    assert code == 409
    assert body["alreadyRunning"] is True
    runner.release()


def test_status_requires_auth(server):
    port, _, _ = server
    code, _ = _http("GET", f"http://127.0.0.1:{port}/status")
    assert code == 401


def test_status_returns_snapshot(server):
    port, _, _ = server
    code, body = _http("GET", f"http://127.0.0.1:{port}/status", token="t0p-secret")
    assert code == 200
    assert body["ok"] is True
    assert "running" in body and body["running"] is False


def test_cors_preflight_allows_authorization_header(server):
    port, _, _ = server
    req = urllib.request.Request(f"http://127.0.0.1:{port}/run", method="OPTIONS")
    req.add_header("Origin", "https://my-tomboy.example")
    req.add_header("Access-Control-Request-Method", "POST")
    req.add_header("Access-Control-Request-Headers", "Authorization")
    with urllib.request.urlopen(req, timeout=5) as r:
        assert r.status == 204
        assert r.headers["Access-Control-Allow-Origin"] == "https://my-tomboy.example"
        allowed = r.headers["Access-Control-Allow-Headers"].lower()
        assert "authorization" in allowed
