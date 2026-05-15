"""Small HTTP trigger so ``/admin/remarkable`` can run the pipeline on demand.

When the user clicks "재처리 요청" in the web admin, the page sets the
``rerunRequested`` flag in Firestore and (if a trigger URL is configured)
POSTs to this service. The service spawns ``python -m
desktop.run_pipeline`` in the background — each stage drains the rerun
queue, so by the time s4 finishes the freshly-flagged page has been
re-processed end-to-end.

Endpoints
---------
``GET  /health``  Returns 200 with ``{ok: true}``. No auth — used to
    let the admin page verify the URL/host is reachable.
``GET  /status``  Returns current job state. Bearer-authed.
``POST /run``     Starts a pipeline run in the background (returns
    immediately with ``{started, jobId, startedAt}``). If a run is
    already in progress, returns 409 with ``{alreadyRunning: true}``.
    Bearer-authed.

CORS
----
The admin page is served from a different origin (the deployed Tomboy
PWA) and posts here. The browser will fire a preflight OPTIONS request
with ``Authorization`` in ``Access-Control-Request-Headers``. We respond
to OPTIONS with permissive CORS headers and echo the requesting origin
so cookies-with-credentials don't even enter the picture — auth is
purely header-based (Bearer).

Run
---
``python -m desktop.trigger_server --host 0.0.0.0 --port 8765``

Auth token comes from the ``DIARY_TRIGGER_TOKEN`` env var (preferred)
or, if absent, the ``trigger.token`` key in ``pipeline.yaml``. We DON'T
read the token from CLI args — long-lived secrets in argv would show up
in ``ps`` for every user on the box.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import subprocess
import sys
import threading
import time
import uuid as uuid_lib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


# Path to the pipeline checkout, derived from this file's location. Used
# as cwd for the spawned subprocess so it picks up ``config/pipeline.yaml``
# from the repo root.
_PIPELINE_ROOT = Path(__file__).resolve().parent.parent


class JobState:
    """In-memory state of the most recent / current pipeline run.

    The lock protects against two concurrent ``POST /run`` calls
    spawning two pipelines (they'd fight over GPU memory and state
    files). Each call into ``start`` returns ``False`` if a run is
    already underway.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running = False
        self._job_id: str | None = None
        self._started_at: str | None = None
        self._finished_at: str | None = None
        self._exit_code: int | None = None
        self._stderr_tail: str = ""
        self._stdout_tail: str = ""

    def start(self, runner: "PipelineRunner") -> tuple[bool, dict[str, Any]]:
        with self._lock:
            if self._running:
                return False, self.snapshot_unlocked()
            self._running = True
            self._job_id = uuid_lib.uuid4().hex[:12]
            self._started_at = _now_iso()
            self._finished_at = None
            self._exit_code = None
            self._stderr_tail = ""
            self._stdout_tail = ""
        # Spawn AFTER releasing the lock so the lock contention window
        # is just the state mutation, not the entire subprocess lifetime.
        threading.Thread(
            target=self._run_in_thread, args=(runner,), name="diary-trigger", daemon=True
        ).start()
        return True, self.snapshot()

    def _run_in_thread(self, runner: "PipelineRunner") -> None:
        try:
            code, out_tail, err_tail = runner.run()
        except Exception as e:  # pragma: no cover — defensive
            code, out_tail, err_tail = 1, "", f"trigger server exception: {e}"
        with self._lock:
            self._running = False
            self._finished_at = _now_iso()
            self._exit_code = code
            self._stdout_tail = out_tail
            self._stderr_tail = err_tail

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self.snapshot_unlocked()

    def snapshot_unlocked(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "jobId": self._job_id,
            "startedAt": self._started_at,
            "finishedAt": self._finished_at,
            "exitCode": self._exit_code,
            "stderrTail": self._stderr_tail,
            "stdoutTail": self._stdout_tail,
        }


class PipelineRunner:
    """Spawns ``python -m desktop.run_pipeline`` and captures its tail
    output. Injectable so tests can swap in a fake."""

    def __init__(self, cwd: Path, python: str, tail_bytes: int = 4096) -> None:
        self.cwd = cwd
        self.python = python
        self.tail_bytes = tail_bytes

    def run(self) -> tuple[int, str, str]:
        proc = subprocess.run(
            [self.python, "-m", "desktop.run_pipeline"],
            cwd=str(self.cwd),
            capture_output=True,
            text=True,
        )
        return proc.returncode, _tail(proc.stdout, self.tail_bytes), _tail(proc.stderr, self.tail_bytes)


def _tail(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return "…" + s[-n:]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _send_json(handler: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    _send_cors_headers(handler)
    handler.end_headers()
    handler.wfile.write(payload)


def _send_cors_headers(handler: BaseHTTPRequestHandler) -> None:
    """Echo the request's Origin (or ``*`` if missing). Combined with the
    Bearer-token check on real requests, this is fine — even with
    ``Access-Control-Allow-Origin: *`` an attacker page can't read the
    response without the token, and any "trigger" they could fire still
    requires the token they don't have."""
    origin = handler.headers.get("Origin", "*")
    handler.send_header("Access-Control-Allow-Origin", origin)
    handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    handler.send_header("Access-Control-Max-Age", "600")


def make_handler(*, token: str, state: JobState, runner: PipelineRunner):
    class _Handler(BaseHTTPRequestHandler):
        # Reduce default stdlib chatter; we log significant events ourselves.
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            sys.stderr.write("[diary-trigger] " + (fmt % args) + "\n")

        def _check_bearer(self) -> bool:
            auth = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(auth, expected):
                _send_json(self, 401, {"ok": False, "error": "unauthorized"})
                return False
            return True

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            _send_cors_headers(self)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                _send_json(self, 200, {"ok": True})
                return
            if self.path == "/status":
                if not self._check_bearer():
                    return
                _send_json(self, 200, {"ok": True, **state.snapshot()})
                return
            _send_json(self, 404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/run":
                _send_json(self, 404, {"ok": False, "error": "not_found"})
                return
            if not self._check_bearer():
                return
            started, snap = state.start(runner)
            if not started:
                _send_json(self, 409, {"ok": False, "alreadyRunning": True, **snap})
                return
            _send_json(self, 202, {"ok": True, "started": True, **snap})

    return _Handler


def _load_token_from_config(config_path: Path) -> str | None:
    """Optional fallback to ``trigger.token`` in pipeline.yaml. Returns
    ``None`` if the config can't be loaded — caller decides whether that's
    fatal."""
    try:
        import yaml

        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        section = data.get("trigger") or {}
        token = section.get("token")
        if isinstance(token, str) and token.strip():
            return token.strip()
    except Exception:
        return None
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--config", type=Path, default=_PIPELINE_ROOT / "config" / "pipeline.yaml")
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python interpreter to invoke for the pipeline subprocess.",
    )
    args = parser.parse_args(argv)

    token = os.environ.get("DIARY_TRIGGER_TOKEN") or _load_token_from_config(args.config)
    if not token:
        sys.stderr.write(
            "[diary-trigger] No token configured. Set DIARY_TRIGGER_TOKEN "
            "or add trigger.token to pipeline.yaml.\n"
        )
        return 2

    state = JobState()
    runner = PipelineRunner(cwd=_PIPELINE_ROOT, python=args.python)
    handler_cls = make_handler(token=token, state=state, runner=runner)
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    sys.stderr.write(
        f"[diary-trigger] listening on http://{args.host}:{args.port} "
        f"(cwd={_PIPELINE_ROOT})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
