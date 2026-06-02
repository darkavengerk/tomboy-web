"""claude-service 경유 OCR 백엔드.

이미지 파일을 base64로 인코딩해 데스크탑 claude-service의 `/chat`에
POST한다. 응답은 SSE 스트림(`data: {"delta": ...}` 등)이며, 누적된
텍스트를 ``OCRResult.text``로 반환한다.

claude-service는 chat-note에서 이미 쓰는 구독 OAuth 기반 Claude Code
CLI 래퍼다. 같은 서비스를 일기 파이프라인이 재사용해 토큰당 과금을
피한다.

실패 처리:
- HTTP 401: 즉시 RuntimeError (같은 토큰으로 retry해도 같음)
- HTTP 503: 5초 대기 후 1회 retry, 그래도 503이면 RuntimeError
- ConnectError / Timeout: RuntimeError (상위 stage가 페이지 단위로 격리)
- SSE {"error": "..."} 프레임: RuntimeError (메시지 그대로 전파)
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .base import OCRBackend, OCRResult, register_backend


_USER_PROMPT = "이 일기 페이지의 손글씨를 한국어로 그대로 추출해. 그림이나 도표는 무시. 읽을 수 없는 글자는 ⌗ 한 글자로 표기."
_TIMEOUT_SECONDS = 120.0
_RETRY_DELAY_SECONDS = 5.0


@register_backend("claude")
class ClaudeBackend(OCRBackend):
    def __init__(
        self,
        *,
        service_url: str,
        service_token: str,
        model: str,
        effort: str,
        system_prompt_path: str,
    ) -> None:
        self._chat_url = service_url.rstrip("/") + "/chat"
        self._token = service_token
        self._model = model
        self._effort = effort
        self._system = Path(system_prompt_path).read_text(encoding="utf-8")
        self._prompt_hash = hashlib.sha256(
            (self._system + "\n---\n" + _USER_PROMPT).encode("utf-8")
        ).hexdigest()[:12]

    def ocr(self, image_path: Path) -> OCRResult:
        b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
        body = {
            "model": self._model,
            "system": self._system,
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
        return OCRResult(
            text=text,
            model=f"claude:{model_label}",
            prompt_hash=self._prompt_hash,
            ts=datetime.now(timezone.utc),
        )

    def _post_with_retry(self, body: dict) -> str:
        try:
            return self._post_once(body)
        except _ServiceUnavailable:
            time.sleep(_RETRY_DELAY_SECONDS)
            try:
                return self._post_once(body)
            except _ServiceUnavailable as e:
                raise RuntimeError(
                    f"claude-service 응답 없음(503) — retry 후에도 실패: {e}"
                ) from e

    def _post_once(self, body: dict) -> str:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        try:
            with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                with client.stream(
                    "POST", self._chat_url, headers=headers, json=body
                ) as resp:
                    if resp.status_code == 401:
                        raise RuntimeError(
                            "claude-service 인증 실패(401): service_token 확인"
                        )
                    if resp.status_code == 503:
                        raise _ServiceUnavailable(getattr(resp, "text", ""))
                    if not resp.is_success:
                        text = getattr(resp, "text", "")
                        raise RuntimeError(
                            f"claude-service HTTP {resp.status_code}: {text[:200]}"
                        )
                    return _parse_sse(resp.iter_lines())
        except httpx.ConnectError as e:
            raise RuntimeError(f"claude-service 연결 실패({self._chat_url}): {e}") from e
        except httpx.TimeoutException as e:
            raise RuntimeError(f"claude-service 타임아웃({_TIMEOUT_SECONDS}s): {e}") from e


class _ServiceUnavailable(Exception):
    """Sentinel for 503 — _post_with_retry catches and retries once."""


def _parse_sse(lines) -> str:
    """`data: {...}` 라인만 처리, 빈 줄과 그 외는 무시.

    delta는 누적, done이면 종료, error 프레임은 즉시 RuntimeError.
    step 이벤트는 일기 OCR엔 필요 없어 무시.
    """
    accumulated: list[str] = []
    for raw in lines:
        line = raw.strip() if isinstance(raw, str) else raw.decode("utf-8").strip()
        if not line or not line.startswith("data:"):
            continue
        json_text = line[len("data:"):].strip()
        if not json_text:
            continue
        try:
            evt = json.loads(json_text)
        except json.JSONDecodeError:
            continue
        if "error" in evt:
            raise RuntimeError(f"claude-service SSE error: {evt['error']}")
        if "delta" in evt and isinstance(evt["delta"], str):
            accumulated.append(evt["delta"])
        if evt.get("done"):
            break
    return "".join(accumulated)
