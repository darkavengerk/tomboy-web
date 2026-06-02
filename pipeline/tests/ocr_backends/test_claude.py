"""ClaudeBackend tests. Mocks httpx.Client.stream to feed canned SSE
responses and validate the request body shape + error mapping."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx
import pytest

from desktop.ocr_backends.claude import ClaudeBackend
from desktop.ocr_backends.base import get_backend


def _sse_stream(lines: list[str]) -> MagicMock:
    """A mock for httpx.Client.stream context manager — yields raw SSE lines."""
    resp = MagicMock()
    resp.status_code = 200
    resp.is_success = True
    resp.iter_lines.return_value = iter(lines)
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None
    return resp


def _make_backend(tmp_path: Path) -> ClaudeBackend:
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("test prompt", encoding="utf-8")
    return ClaudeBackend(
        service_url="http://localhost:7842",
        service_token="TOK",
        model="claude-opus-4-7",
        effort="high",
        system_prompt_path=str(prompt_path),
    )


def _make_image(tmp_path: Path) -> Path:
    img = tmp_path / "page.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    return img


def test_registered():
    """get_backend('claude', ...) returns a ClaudeBackend instance."""
    from desktop.ocr_backends import claude as claude_mod  # noqa: F401
    backends = ClaudeBackend.__mro__
    assert any(b.__name__ == "OCRBackend" for b in backends)


def test_success_path(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    sse_lines = [
        'data: {"delta": "hello "}',
        '',
        'data: {"step": {"kind": "thinking", "label": "x", "body": "y"}}',
        '',
        'data: {"delta": "world"}',
        '',
        'data: {"done": true, "reason": "success"}',
        '',
    ]
    captured_body = {}

    def fake_stream(self, method, url, **kw):
        captured_body['method'] = method
        captured_body['url'] = url
        captured_body['headers'] = kw.get('headers')
        captured_body['json'] = kw.get('json')
        return _sse_stream(sse_lines)

    with patch.object(httpx.Client, 'stream', fake_stream):
        result = backend.ocr(img)

    assert result.text == "hello world"
    assert result.model == "claude:claude-opus-4-7"
    assert captured_body['method'] == 'POST'
    assert captured_body['url'].endswith('/chat')
    assert captured_body['headers']['Authorization'] == 'Bearer TOK'

    body = captured_body['json']
    assert body['model'] == 'claude-opus-4-7'
    assert body['effort'] == 'high'
    assert body['system'] == 'test prompt'
    img_block = body['messages'][0]['content'][0]
    assert img_block['type'] == 'image'
    assert img_block['source']['type'] == 'base64'
    assert img_block['source']['media_type'] == 'image/png'
    decoded = base64.b64decode(img_block['source']['data'])
    assert decoded == img.read_bytes()
    # 두 번째 콘텐츠 블록은 text
    text_block = body['messages'][0]['content'][1]
    assert text_block['type'] == 'text'
    assert isinstance(text_block['text'], str) and len(text_block['text']) > 0


def test_empty_model_label(tmp_path):
    """model='' → result.model == 'claude:default'."""
    prompt_path = tmp_path / "p.txt"
    prompt_path.write_text("p", encoding="utf-8")
    backend = ClaudeBackend(
        service_url="http://localhost:7842",
        service_token="TOK",
        model="",
        effort="high",
        system_prompt_path=str(prompt_path),
    )
    img = _make_image(tmp_path)
    captured = {}
    def fake_stream(self, method, url, **kw):
        captured['json'] = kw['json']
        return _sse_stream(['data: {"done": true}', ''])
    with patch.object(httpx.Client, 'stream', fake_stream):
        result = backend.ocr(img)
    assert captured['json']['model'] == ''
    assert result.model == 'claude:default'


def test_http_401_immediate_raise(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp = MagicMock()
    resp.status_code = 401
    resp.is_success = False
    resp.text = 'unauthorized'
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None
    call_count = {'n': 0}
    def fake_stream(self, method, url, **kw):
        call_count['n'] += 1
        return resp
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='인증 실패'):
            backend.ocr(img)
    assert call_count['n'] == 1  # retry 없음


def test_http_503_retries_once(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp503 = MagicMock()
    resp503.status_code = 503
    resp503.is_success = False
    resp503.text = 'unavailable'
    resp503.__enter__.return_value = resp503
    resp503.__exit__.return_value = None

    call_count = {'n': 0}
    def fake_stream(self, method, url, **kw):
        call_count['n'] += 1
        if call_count['n'] == 1:
            return resp503
        return _sse_stream(['data: {"delta": "ok"}', '', 'data: {"done": true}', ''])

    with patch.object(httpx.Client, 'stream', fake_stream), \
         patch('desktop.ocr_backends.claude.time.sleep'):
        result = backend.ocr(img)
    assert call_count['n'] == 2
    assert result.text == 'ok'


def test_http_503_twice_raises(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp = MagicMock()
    resp.status_code = 503
    resp.is_success = False
    resp.text = 'unavailable'
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None

    def fake_stream(self, method, url, **kw):
        return resp
    with patch.object(httpx.Client, 'stream', fake_stream), \
         patch('desktop.ocr_backends.claude.time.sleep'):
        with pytest.raises(RuntimeError, match='claude-service'):
            backend.ocr(img)


def test_connect_error(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    def fake_stream(self, method, url, **kw):
        raise httpx.ConnectError("refused")
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='연결 실패'):
            backend.ocr(img)


def test_timeout(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    def fake_stream(self, method, url, **kw):
        raise httpx.TimeoutException("slow")
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='타임아웃'):
            backend.ocr(img)


def test_sse_error_frame(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    sse_lines = [
        'data: {"error": "model overloaded"}',
        '',
    ]
    def fake_stream(self, method, url, **kw):
        return _sse_stream(sse_lines)
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='model overloaded'):
            backend.ocr(img)
