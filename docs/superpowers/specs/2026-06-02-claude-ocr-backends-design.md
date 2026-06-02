# Claude를 OCR 노트 + 일기 파이프라인의 기본 OCR 백엔드로

- 날짜: 2026-06-02
- 상태: 설계 승인됨, 구현 계획 대기
- 관련: `OCR note (ocr://)` (CLAUDE.md), `tomboy-ocr-note` 스킬, `tomboy-diary` 스킬, `Claude 채팅 노트 "클린 모드"` (2026-05-30 설계)

## 배경 / 문제

이미지 → 텍스트가 필요한 두 서브시스템이 각각 다른 로컬 모델을 쓴다:

1. **OCR 노트 (`ocr://`)** — 두 단계 흐름. (a) `ocr-service`의 GOT-OCR2가 이미지에서 마크다운 텍스트 추출, (b) 추출 텍스트를 Ollama exaone 같은 모델로 한국어 번역.
2. **일기 파이프라인** — `pipeline/desktop/ocr_backends/local_vlm.py`의 Qwen2.5-VL-7B (4-bit nf4 양자화, RTX 3080)가 reMarkable 페이지 이미지에서 한국어 손글씨를 추출.

채팅 노트(`claude://`)가 이미 `claude-service` 경유로 Claude Code CLI 구독 OAuth를 재사용하고 있고, `claude-service` 런너의 `AnthropicMessage` 타입이 image content block(URL/base64 양쪽)을 지원한다. 같은 인프라를 OCR 노트와 일기 파이프라인에 확장하면:

- OCR 노트의 두 단계(OCR + 번역)를 Claude 한 번 호출로 합칠 수 있다.
- 일기 파이프라인의 GPU/VRAM/양자화 복잡도(`local_vlm.py`의 타일링·4-bit 트릭)를 거치지 않아도 된다.
- 채팅 노트와 동일한 구독 인증을 그대로 써서 토큰당 과금이 없다.

## 제약 / 결정 사항

- **claude-service는 손대지 않는다.** 이미 image 입력과 URL/base64 양쪽을 지원한다.
- **bridge `/claude/chat` 라우트도 손대지 않는다.** OCR 노트가 이걸 그대로 쓴다.
- **기존 백엔드를 유지한다.** `ocr-service` (GOT-OCR2)와 `local_vlm.py` (Qwen2.5-VL) 모두 코드/설정이 살아있어서 사용자가 언제든 되돌릴 수 있다. 마이그레이션은 없다.
- **OCR 노트는 신규 시그니처 `ocr://claude`를 도입**한다. 기존 `ocr://got-ocr2` 노트는 그대로 작동한다.
- **일기 파이프라인은 YAML `ocr.backend: "claude"`로 기본값을 변경**한다. 사용자가 `local_vlm`으로 한 줄 바꾸면 옛 경로로 복귀.
- **이미지 전송**: OCR 노트는 paste 시점에 이미 Vercel/Dropbox에 업로드돼 있으므로 **URL passthrough** (`tomboyUrlLink` 흐름과 동일). 일기 파이프라인은 로컬 PNG 파일 → **base64**. Dropbox `/scl/...` URL이 Anthropic url-source의 robots.txt 정책에 막히는 문제는 claude-service의 `inlineImageUrls`(server-side fetch → base64 변환)가 이미 처리하므로 OCR 노트에선 별도 fallback 불필요.
- **시스템 프롬프트는 항상 주입(교체)**한다. claude-service 런너가 이미 `--system-prompt`로 코딩 에이전트 기본 프롬프트를 교체하는 클린 모드를 쓰고 있으므로 그 계약을 그대로 따른다.
- **OCR 노트의 `translate:`/`temperature:`/`num_ctx:` 헤더는 Claude 백엔드에선 의미가 없다** — 파싱은 하되 사용하지 않는다(노트 검증·에러 출력은 생략, 헤더는 그저 무시).
- **OCR 노트에 새 헤더 `effort:`를 추가**한다 — Claude 백엔드에서만 의미.
- **일기 파이프라인은 bridge를 거치지 않는다** — 같은 데스크탑이라 `http://localhost:7842`(claude-service 기본값, `CLAUDE_SERVICE_PORT` env로 override 가능)로 직접 호출. 라즈베리파이 bridge 경유는 헛걸음.

## 데이터 흐름

### OCR 노트

```
ocr://claude 노트 본문 ──► parseOcrNote
                            ├──► backend='claude' 분기
                            └──► runOcrInEditor → runClaude
                                  └──► sendClaude (bridge /claude/chat, SSE)
                                       └──► claude-service /chat
                                            └──► runner spawn(claude -p, image url/base64)
```

`runClaude` 출력: `[원문]\n…\n\n[번역]\n…` 단일 단락 블록 (시스템 프롬프트가 형식 강제).

### 일기 파이프라인

```
s3_ocr 스테이지 ──► get_backend("claude", ...) ──► ClaudeBackend.ocr(image_path)
                                                    ├── base64 인코딩
                                                    ├── POST http://localhost:7842/chat (Bearer)
                                                    └── SSE delta 누적 → OCRResult(text=...)
```

기존 `s3_ocr` 흐름(페이지 단위 격리, `state/*.json` UUID 스킵)은 그대로.

## 컴포넌트별 설계

### ① `app/src/lib/ocrNote/defaults.ts` (수정)

- `OCR_SIGNATURE_RE`는 이미 `claude`를 토큰으로 받음(`[A-Za-z0-9._:/-]+`) → 정규식 수정 불필요.
- 시그니처 분류 헬퍼 추가: `isClaudeBackend(model: string): boolean`. 규칙: `model === 'claude'` (정확 매치) 또는 `model.startsWith('claude-')` (예: `claude-opus-4-7`). 그 외는 모두 Ollama 백엔드. `claude/`(슬래시 prefix) 같은 변형은 허용하지 않음 — URL signature이라 단순하게 유지.
- 새 헤더 키 `effort` 추가. `OCR_HEADER_KEY_RE`에 추가하고 `OcrHeaderKey` 유니온도 확장.
- 신규 상수: `OCR_CLAUDE_DEFAULT_EFFORT = 'high'`, `OCR_CLAUDE_SYSTEM_PROMPT` (한국어 OCR+번역 프롬프트, 출력 형식 `[원문]/[번역]` 강제).

### ② `app/src/lib/ocrNote/parseOcrNote.ts` (수정)

`OcrNoteSpec`에 `backend: 'ollama' | 'claude'` 필드 추가, `options.effort?: string` 추가. 시그니처 분류 헬퍼로 `backend` 결정. Claude일 때 `translate:`/`temperature:`/`num_ctx:`는 파싱은 진행하되 결과에 영향 없음(소비자가 무시). `effort:`는 Claude에서만 유효성 검증.

### ③ `app/src/lib/ocrNote/sendClaude.ts` (신규)

얇은 SSE 클라이언트. 시그니처:

```ts
sendClaude(opts: {
  url: string;              // bridge /claude/chat
  token: string;            // bridge bearer
  body: ClaudeChatBody;
  onToken(delta: string): void;
  signal?: AbortSignal;
}): Promise<{ reason: 'done' | 'abort' | 'stream_error' | 'error' }>;
```

`ClaudeChatBody` 모양은 채팅 노트 `backends/claude.ts`와 동일 형태(model/system/effort/messages). SSE 이벤트 중 `{delta}`만 onToken으로 흘리고, `{done}`이면 성공 종료, `{error}`면 reason='error'로 종료, `{step: ...}`는 무시. **채팅 노트 `backends/claude.ts`를 import 하지 않는다** — 둘이 다른 흐름이라 추상화를 강제하면 양쪽이 더러워진다.

### ④ `app/src/lib/ocrNote/runOcrInEditor.ts` (수정)

`runOcrInEditor` 진입부의 분기 순서를 바꾼다:

```
1. spec.backend === 'claude' → runClaude
2. spec.legacy               → runLegacy (기존)
3. else                      → runTwoStage (기존)
```

`runClaude(opts, httpBase, imageUrl)`:
- placeholder 단락 `[원문]\nOCR 진행 중…` 삽입(`appendBlock` 재사용).
- body 구성: `model = spec.model === 'claude' ? undefined : spec.model`(빈 model은 claude-service 기본값에 위임), `system = spec.system || OCR_CLAUDE_SYSTEM_PROMPT`, `effort = spec.options.effort || OCR_CLAUDE_DEFAULT_EFFORT`, messages는 image content block(`source.type='url'`) + text content block.
- `sendClaude` 호출, onToken마다 placeholder 단락을 누적 텍스트로 교체(`replaceBlockContent` 재사용).
- 첫 delta 도착 시 placeholder의 `[원문]\n` 프리픽스는 제거하고 모델 출력 그대로 노출(시스템 프롬프트가 `[원문]/[번역]` 형식을 만들어 줌).
- 에러 시 `formatClaudeError(err)` → `[OCR 오류: <msg>]`로 교체. `editor.setEditable(true)`는 finally로 보장.

이미지 전송은 **URL passthrough 단일 경로**. Anthropic url-source의 robots.txt 차단은 claude-service의 `inlineImageUrls`가 server-side에서 fetch → base64로 인라인해 해결한다(채팅 노트와 동일 경로).

### ⑤ `pipeline/desktop/ocr_backends/claude.py` (신규)

```python
@register_backend("claude")
class ClaudeBackend(OCRBackend):
    def __init__(self, *, service_url, service_token, model, effort, system_prompt_path):
        ...
    def ocr(self, image_path: Path) -> OCRResult:
        # 1. read_bytes() → base64
        # 2. POST service_url/chat with Bearer service_token
        # 3. iter_lines로 SSE 파싱, {delta} 누적
        # 4. {done}이면 OCRResult 반환, {error}/HTTP error면 RuntimeError
```

`OCRResult.model`은 `f"claude:{model or 'default'}"`로 기록 — `state/*.json`이 백엔드 식별 가능. `prompt_hash`는 시스템 프롬프트 SHA256 앞 12자.

HTTP 실패 처리: ConnectionError → 즉시 RuntimeError. 401 → 즉시 RuntimeError(같은 토큰으로 다시 시도해도 같음). 502/503 → 5초 대기 후 1회 retry. Timeout(120s) → RuntimeError. SSE `{error: ...}` → RuntimeError. 상위 `s3_ocr` 스테이지가 페이지 단위 try/except로 격리해 다음 페이지로 진행.

### ⑥ `pipeline/desktop/lib/config.py` (수정)

`OcrConfig`에 `claude: ClaudeConfig | None` 필드 추가. 새 dataclass `ClaudeConfig(service_url, service_token, model, effort, system_prompt_path)`. `from_dict`에서 `backend == "claude"`일 때 `claude` 키 필수.

`_EXAMPLE_YAML` (bootstrap이 생성)을 수정해서 `backend: "claude"`를 기본값으로, `claude:`/`local_vlm:` 두 섹션 모두 포함(주석으로 swap 방법 안내).

### ⑦ 설정 → 가이드 (settings/+page.svelte) (수정)

`guideSubTab='notes'`에 OCR 노트 가이드 카드의 시그니처 예시를 `ocr://claude`로 바꾸고, 기존 `ocr://got-ocr2` 노트는 호환된다는 주석을 추가. `effort:` 헤더 라인 추가. (가이드 카드 추가가 아니라 기존 카드 본문만 손봄.)

## 테스트 전략

### OCR 노트 (vitest)

- `parseOcrNote.test.ts` [수정]: `ocr://claude` → `backend='claude'`, `ocr://claude-opus-4-7` → `backend='claude', model='claude-opus-4-7'`, `ocr://got-ocr2` → `backend='ollama'` (회귀), `effort:` 헤더 유효(`low|medium|high|xhigh|max`)/무효 파싱.
- `sendClaude.test.ts` [신규]: SSE 응답 모킹 → delta/done/error/is_error 프레임 처리, onToken 누적, AbortSignal 종료, 401/503.
- `runOcrInEditor.test.ts` [수정]: spec.backend='claude'이면 `sendClaude`만 호출(`sendOcr`/`sendChat` 호출 안 됨), placeholder 단락 교체, `editor.setEditable` 복구, 빈 응답 → `[OCR 결과 없음]`, 에러 → `[OCR 오류: …]`.

### 일기 파이프라인 (pytest)

- `claude_test.py` [신규]: `ClaudeBackend.ocr` 호출 → 요청 body 검증(base64 image, system prompt 내용, model/effort), SSE delta 누적 → OCRResult, HTTP 401/503/timeout/SSE error 처리, 502/503 시 1회 retry.
- `config.py` 관련 기존 테스트가 있으면 `ClaudeConfig.from_dict` round-trip + example YAML 파싱 케이스 추가.

### 테스트 하지 않는 것

- claude-service 런너 동작 / bridge `/claude/chat` 라우트 — 이미 자기 테스트 있음, 본 변경에서 손대지 않음.
- 모델 품질(Claude가 OCR/번역/손글씨 인식을 잘하는지) — 단위 테스트 영역 아님.

### 수동 검증

PR 머지 전:

- OCR 노트: `ocr://claude` 노트 만들고 한국어 + 영어 이미지 각 1장 붙여넣어 결과 확인.
- OCR 노트: bridge/claude-service 한쪽씩 끈 상태에서 에러 메시지 확인.
- 일기: 로컬 PNG 한 장으로 `python -m desktop.run_pipeline --once` 돌려 Firestore까지 흐름 확인.
- 일기: YAML `backend: "local_vlm"`로 되돌렸을 때 기존 경로 정상 작동.

## 비범위

- 채팅 노트(`llm://`, `claude://`) 백엔드 변경 — 이미 양쪽이 존재하고 사용자가 URL로 명시 선택하므로 이번 작업에서 제외.
- 기존 OCR 노트(`ocr://got-ocr2`) 자동 마이그레이션 — 노트 내용은 사용자가 작성한 것이므로 자동 변경하지 않는다.
- `local_vlm.py` / Qwen 양자화 코드 제거 — 사용자가 yaml 한 줄로 되돌릴 수 있는 경로를 유지한다.
- claude-service에 OCR/일기 전용 엔드포인트 신설 — 같은 `/chat`을 그대로 쓴다.
- Ollama `/api/rag/search` (chatNote `rag:` 헤더) — Claude API에 등가물 없음, 본 작업과 무관.

## 비호환성 / 마이그레이션

- 없음. 기존 노트와 기존 yaml 설정 모두 그대로 작동. 신규 사용자(처음 bootstrap)만 Claude가 기본값.
- `state/*.json`의 `model` 필드는 새 페이지부터 `claude:...`로 기록되지만 옛 값과 공존(UUID 기준 스킵이므로 영향 없음).
