# LLM 노트 — 빠른 도우미 (foundation slice)

**날짜:** 2026-05-12
**상태:** 디자인 검토 대기
**스코프:** 노트 본문 첫 줄이 `llm://<ollama-model-ref>` 시그니처인 노트를 채팅 누적 노트로 인식하고, 우하단 [보내기] / Ctrl+Enter 로 메인 PC 의 Ollama 에 호출, NDJSON 스트림 응답을 노트 본문 끝에 토큰 단위로 흘려 넣는다. 통신은 기존 terminal bridge 컨테이너에 `/llm/chat` endpoint 1 개 추가. 첫 번째 vertical slice 는 "빠른 터미널 도우미" use case (Qwen2.5-Coder-3B 등) 지만, grammar 와 인프라는 향후 RAG/아바타/OCR 재검수 같은 다른 LLM 노트 타입의 foundation 으로 재사용된다.

## 요약

`tomboy-web` 의 LLM 통합을 6 개 하위 프로젝트로 분해한 결과 (런타임 계약, 노트-모델 통합 패턴, RAG 인프라, 빠른 터미널 도우미, 개인 아바타, OCR 재검수 — 의존성 1 → (2,3) → (4,5,6)), 본 spec 은 그중 **#4 빠른 터미널 도우미** 를 vertical slice 로 다루며 #1, #2 의 첫 결정 (런타임 = Ollama, 통합 패턴 = `llm://` 시그니처를 가진 채팅 누적 노트) 을 함께 잠근다. RAG/페르소나 fine-tune/OCR 재검수/모바일 백그라운드 응답 / 다중 디바이스 응답 reconcile 은 의도적 비-목표.

핵심 결정 잠금:

| | |
|---|---|
| UX 모양 | 채팅 누적 노트 (terminal / schedule note 와 같은 특수 노트 family) |
| Q/A 포맷 | `Q: ` / `A: ` 평문 prefix (대소문자 구분), Tomboy desktop 100% 호환 |
| 런타임 | Ollama on 메인 PC |
| 통신 경로 | 기존 `bridge/` 컨테이너에 `/llm/chat` endpoint 확장 |
| 외부 노출 | Caddy + Bearer + TLS (모바일 외부 포함) — terminal note 와 동일 표면 |
| WOL | 첫 spec 제외 (PC 켜져 있다 가정) |
| 컨텍스트 정책 | 노트 전체 messages, `num_ctx` 초과 시 오래된 user turn 부터 silent 제거 |
| 인스턴스 정의 | **노트 1차 소스** — Modelfile 없음, 노트 헤더에 model + system + params |
| 자동화 트리거 | **없음** — 보내기는 명시적 (Ctrl+Enter / 버튼) |
| 응답 도중 노트 떠남 | abort + 그 시점까지 본문 저장 (백그라운드 진행 비-목표) |

추천 모델 lineup (RTX 3080 10GB, 한국어 우선):

| 용도 | 모델 | VRAM (4-bit) |
|---|---|---|
| 빠른 터미널 도우미 | `qwen2.5-coder:3b` | ~2 GB |
| 일반 채팅 / 글쓰기 | `qwen2.5:7b` | ~5.5 GB |
| (기존) diary OCR | `qwen2.5-vl:7b` (transformers 직접) | ~5.5 GB |

---

## 섹션 1 — 노트 grammar / 파서

### 본문 구조

```
셸 도우미                           ← 단락 1 — 사용자 자유 제목 (필수, 빈 단락도 OK)
llm://qwen2.5-coder:3b              ← 단락 2 — 시그니처 (1줄, 필수)
system: 너는 Linux 셸 전문가다.     ← 헤더 영역 (0줄 이상)
        한국어로 짧게.
temperature: 0.2
num_ctx: 4096
                                     ← 빈 단락 = 헤더/turn 경계
Q: tar.zst 압축 풀려면?              ← turn 영역
A: tar -I zstd -xf file.tar.zst

Q: zstd 가 없으면?
A: dnf install zstd

Q: ▌                                 ← 마지막 빈 Q: = 다음 입력 자리
```

**제목 단락이 따로 있는 이유** — Tomboy 의 `extractTitleFromDoc` 가 본문 첫 블록의 plain text 를 노트 제목으로 사용한다. 시그니처를 첫 단락에 두면 노트 제목 = `llm://qwen2.5-coder:3b` 가 되어 (a) 같은 모델 노트 여러 개 만들면 title-unique invariant 가 자동 `(2)` suffix 를 붙이고 (b) 노트 목록 / 그래프 / 검색에서 의미 식별이 어렵다. 첫 단락을 사용자 자유 제목으로 두면 두 문제 모두 자연스럽게 해결.

### 시그니처

본문 **두 번째 단락의 첫 줄** 이 `/^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/` 정규식을 만족해야 LLM 노트. 매치 안 되면 파서는 즉시 `null` 리턴 → 일반 노트 (terminal note 와 같은 graceful 폴백). 사용자가 시그니처 줄을 지우면 LLM 동작이 곧장 꺼지는 것과 동치 — 별도 토글 없음.

**시그니처 위치의 관용 (자동 보완 전 과도기 상태)** — 사용자가 빈 노트에 시그니처만 곧장 적으면 그 시점에 단락은 1 개뿐이라 시그니처가 `doc.content[0]` 에 있다. 파서는 이 케이스도 LLM 노트로 인식 (첫 두 단락 중 하나라도 매치되면 OK), 자동 보완이 곧 빈 제목 단락을 앞에 삽입해 안정 상태 (`doc.content[1]` 에 시그니처) 로 옮긴다. 둘 다 매치되는 비정상 케이스는 두 번째를 우선.

`<model-ref>` 는 Ollama 모델 태그 (예: `qwen2.5-coder:3b`, `qwen2.5:7b`). 파서는 형식만 검사, 모델 존재는 보내기 시 bridge 가 404 로 확인.

### 헤더 영역

시그니처 다음 줄부터 **첫 빈 단락 전까지** 가 헤더. `key: value` 라인 형태. 인식 키:

| 키 | 타입 | 비고 |
|---|---|---|
| `system:` | string, 멀티라인 | 다음 줄이 들여쓰여 있으면 이전 키 값의 연속 |
| `temperature:` | float | |
| `num_ctx:` | int | |
| `top_p:` | float | |
| `seed:` | int | |
| `num_predict:` | int | |

미인식 키는 silent 무시. `temperature: not-a-number` 같이 형식 깨진 값은 그 키만 무시하고 나머지 헤더는 살림 (비-치명적 폴백).

빈 단락이 헤더와 turn 영역의 명확한 경계 — system 의 멀티라인 값이 우연히 `Q:` 줄을 포함하는 케이스를 grammar 가 다루지 않아도 됨.

### Turn 영역

빈 단락 뒤. `Q:` 또는 `A:` (대소문자 구분) 로 시작하는 줄이 새 turn 의 시작. 다음 `Q:` / `A:` 만날 때까지가 본문. Q/A 순서가 깨져도 (예: A 가 먼저, Q 연속) 그대로 messages 에 넣고 Ollama 에 보냄 — chat template 이 alternating 강제하지 않음.

마지막 turn 이 빈 `Q: ` (또는 텍스트가 있는 `Q: ...`) 이고 그 뒤에 `A: ` 가 없으면 `trailingEmptyUserTurn: true` (이 spec 에선 보내기 가능 여부 판단에 사용).

### 파서 시그니처

```ts
// app/src/lib/llmNote/parseLlmNote.ts
export interface LlmNoteSpec {
  model: string;                                  // "qwen2.5-coder:3b"
  system?: string;
  options: {
    temperature?: number;
    num_ctx?: number;
    top_p?: number;
    seed?: number;
    num_predict?: number;
  };
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  trailingEmptyUserTurn: boolean;
}

export function parseLlmNote(doc: JSONContent | null | undefined): LlmNoteSpec | null;
```

입력은 editor JSON (ProseMirror doc) — block 단위 traversal 이 plain-text 추출보다 robust (각 paragraph = 한 줄, 빈 paragraph = 빈 단락). IDB 의 `xmlContent` 를 직접 파싱하지 않음 (TipTap 마크/태그를 다뤄야 해서 부담).

### 비-LLM 노트로 폴백

- 시그니처 라인 없음 / 형식 깨짐 → `null`. terminal note 와 같은 graceful 폴백.

---

## 섹션 2 — 자동 헤더 보완

`llmNotePlugin` (ProseMirror plugin) 이 두 시점에서만 보완 실행:

1. **타이핑으로 시그니처 라인이 막 완성된 transaction** — 직전 doc state 엔 `llm://` 줄이 없었는데 현재 있으면.
2. **노트 mount 시 1 회** — 시그니처는 있는데 인식되는 헤더 키가 **0 개** 인 경우 (sync 로 들어온 미완성 노트 / 사용자가 헤더 전부 지운 노트). autoWeekday 의 rescan 패턴과 동일 — `setMeta(llmNotePluginKey, { rescan: true })`.

이 두 조건 외엔 절대 건드리지 않음 — 사용자가 `temperature` 줄 지우면 그 상태 그대로 유지. 매 transaction 마다 자동 복원하면 annoying.

**"헤더 키 0 개" 정의** — `^(system|temperature|num_ctx|top_p|seed|num_predict):` 정규식에 매치되는 줄의 수가 0. 빈 값의 키 (예: `system:` 만 있고 값 없음) 도 키로 카운트 — 보완 대상 아님. 사용자가 의식적으로 비워둔 상태를 존중.

**시그니처 없는 노트엔 NO-OP** — `llmNotePlugin` 은 매 transaction 마다 `parseLlmNote()` 시그니처만 검사. 시그니처 없으면 즉시 리턴, 일반 노트에는 어떤 영향도 없음. TomboyEditor 에 항상 등록되어도 안전.

### 보완 내용

누락된 키만 추가, 있는 키는 건드리지 않음:

| 키 | 기본값 | 비고 |
|---|---|---|
| `system:` | (빈 값) | 사용자가 페르소나를 명시적으로 정의하라는 신호. 모델 이름으로 자동 추측 ❌ |
| `temperature:` | `0.3` | 한국어 + 기술 답변에 적당한 보수치 |
| `num_ctx:` | `4096` | 3080 10GB 에서 7B-Q4 와 안전하게 공존 |

`top_p`, `seed`, `num_predict` 등은 기본값 추가 안 함 — 사용자가 필요할 때만 명시.

### 제목 단락 + Turn 영역도 보완

자동 보완은 한 transaction 으로 다음을 모두 처리:

1. **제목 단락 보완** — 시그니처가 `doc.content[0]` 에 있으면 (사용자가 빈 노트에 시그니처만 곧장 적은 케이스), 그 앞에 빈 제목 단락을 삽입해서 시그니처를 `doc.content[1]` 로 이동. 사용자가 그 빈 단락에 제목을 적도록 유도. 시그니처가 이미 `doc.content[1]` 이면 제목 단락 건드리지 않음.
2. **헤더 보완** — 누락된 키만 추가 (위 표).
3. **Turn 영역 보완** — 헤더 다음에 빈 단락 + 빈 `Q: ` 한 줄.
4. **커서 위치** — 시그니처가 새로 작성된 transaction 이면 커서를 빈 제목 단락의 시작으로 (사용자가 곧장 제목을 입력하도록). mount 시 rescan 이면 커서 이동 안 함.

```
▌                                   ← 빈 제목 단락, 커서 여기로
llm://qwen2.5-coder:3b
system: 
temperature: 0.3
num_ctx: 4096

Q: 
```

### 구현

`app/src/lib/editor/llmNote/llmNotePlugin.ts`. autoWeekday 패턴 (`appendTransaction` + mount 시 setMeta rescan). `currentGuid` prop 같은 추가 신호 없음 — 파서가 시그니처 보고 자체 판단. 자동 보완은 클라이언트 측 ProseMirror tr 이므로 IDB 저장은 일반 노트 저장 경로 그대로 (debounced `updateNoteFromEditor`). Firebase / Dropbox sync 도 일반 노트와 동일. 다른 디바이스에서 받으면 자동 보완 트리거 안 함 (이미 헤더 있을 테니).

---

## 섹션 3 — 클라이언트 편집 UX

### 라우팅

별도 view 컴포넌트 분기 **없음**. 일반 `<TomboyEditor>` 그대로 + LLM 노트 전용 부가 UI (`<LlmSendBar>`) 만 추가. 이유:
- 사용자가 헤더 / turn 을 자유롭게 편집할 수 있어야 한다.
- 채팅 본문이 곧 노트 텍스트라 별도 view 가 줄 수 있는 이점이 거의 없다.
- terminal note 의 banner→TerminalView 전환 같은 모드가 필요 없음 (LLM 노트는 항상 같은 1 모드).

`<LlmSendBar>` 마운트 위치는 `routes/note/[id]/+page.svelte` 와 `lib/desktop/NoteWindow.svelte` — 컨테이너가 editor doc state 를 watch → `parseLlmNote()` 결과 non-null 일 때만 렌더. terminal note 의 banner 와 같은 패턴 (컨테이너가 노트 종류 판단, editor 는 모름).

### 보내기 트리거

| 디바이스 | 트리거 |
|---|---|
| 데스크탑 | **Ctrl+Enter** (커서가 노트 안 어디든) + 우하단 floating **[보내기]** 버튼 |
| 모바일 | 우하단 floating **[보내기]** 버튼만 (모바일 키보드의 Ctrl 사용 어려움) |

### 보내기 동작

1. 보내기 직전 `parseLlmNote(editorContent)` 재호출 → `LlmNoteSpec` 추출
2. `trailingEmptyUserTurn === false` 거나 마지막 user turn 텍스트가 비어 있으면 toast "보낼 질문이 없습니다" 후 abort
3. 노트 본문 끝에 빈 `A: ` 줄 즉시 추가 (ProseMirror tr) — 시각적 응답 시작 표시
4. `POST /llm/chat` (Bearer auth) 호출, ReadableStream 으로 NDJSON 토큰 수신
5. 토큰마다 `A: ` 자리에 텍스트 append (ProseMirror tr). 본문 끝까지 자동 스크롤
6. 스트림 종료 → 빈 단락 + 빈 `Q: ` 한 줄 추가 → 커서 그 줄 끝으로. debounced IDB save 가 평소처럼 동작

### 진행 인디케이터 / 중단

- 보내기 누르는 순간 [보내기] → **[■ 중지]** 토글. 옆에 토큰 카운트 (`24 tok`) — 응답이 살아있다는 신호
- 중지 클릭 → `AbortController.abort()` → bridge 가 Ollama 연결 끊음 → 그 시점까지의 부분 응답이 노트에 남음 + 빈 `Q: ` 줄 추가 → 정상 상태 복귀

### 응답 도중 사용자 편집 정책

응답이 스트리밍되는 동안 editor 를 `setEditable(false)` 로 일시 lock — 토큰 append 자리와 사용자 입력의 race 를 grammar 수준에서 방지. 헤더/이전 turn 수정도 막힘. 응답 종료 (성공/중지/에러) 시 `setEditable(true)` 로 복귀. 한 노트 안에서 lock 이라 다른 노트 / 설정 페이지 이동은 자유 — 단 이 노트의 editor 가 unmount 되면 다음 항목의 abort 정책 적용.

### 응답 도중 노트 떠남

첫 spec 의 단순화 원칙: editor unmount 시 자동 abort, 그 시점까지의 본문이 저장됨 (debounced save). 다시 열면 미완성 `A: ` 까지 보임. **백그라운드 진행 / 다중 디바이스 응답 reconcile 은 이 spec 의 비-목표**. 필요 시 다음 spec.

### 에러 처리

| 케이스 | 동작 |
|---|---|
| 모델 ref 가 Ollama 에 없음 | bridge 가 404 → 노트에 `A: [오류: 모델 'qwen2.5-coder:3b' 없음. ollama pull qwen2.5-coder:3b 필요]` + toast |
| bridge 401 (토큰 만료) | 노트에 에러 줄 + "원격 브릿지 재인증 필요" toast (설정 페이지 안내) |
| 네트워크 / 5xx | `A: [오류: 연결 실패. 재시도?]` + toast |
| `num_ctx` 초과 | Ollama 가 자체적으로 잘라줌. 클라이언트 추가 처리 없음 |
| 같은 노트 동시 보내기 | UI 가 [중지] 상태일 땐 보내기 disable — race 자체 발생 안 함 |

### 병행 노트 사용

서로 다른 LLM 노트는 동시 사용 가능. Ollama 의 `OLLAMA_MAX_LOADED_MODELS=2` 라 3B + 7B 동시 로드 가능 (≈ 7.5 GB). 더 다른 모델이 호출되면 LRU 로 가장 오래 idle 한 모델 unload.

---

## 섹션 4 — bridge endpoint (`/llm/chat`)

기존 `bridge/` 컨테이너에 endpoint 1 개 추가. 인증·도메인·Caddy·배포는 100% 재사용.

### 요청

```http
POST /llm/chat HTTP/1.1
Authorization: Bearer <BRIDGE_SECRET>
Content-Type: application/json

{
  "model": "qwen2.5-coder:3b",
  "system": "너는 Linux 셸 전문가다.",
  "options": {
    "temperature": 0.3,
    "num_ctx": 4096,
    "top_p": 0.9,
    "seed": 42
  },
  "messages": [
    { "role": "user",      "content": "tar.zst 압축 풀려면?" },
    { "role": "assistant", "content": "tar -I zstd -xf ..." },
    { "role": "user",      "content": "zstd 가 없으면?" }
  ]
}
```

`system`, `options`, `messages` 의 모든 필드는 선택. `model` 만 필수.

### bridge 처리

1. `Authorization: Bearer` 검증 → 실패 시 `401 unauthorized`
2. `model` 이 비어있거나 형식 깨짐 → `400 bad_request`. `messages` 가 빈 배열이거나 `[].length === 0` 이면 `400 empty_messages` (클라이언트의 `trailingEmptyUserTurn` 체크가 이미 막지만 defensive)
3. `system` 있으면 messages 앞에 `{role:'system', content}` prepend
4. Ollama `POST http://localhost:11434/api/chat` 호출, `stream: true` 강제
5. **Ollama 의 NDJSON 응답을 raw 패스스루** — `Content-Type: application/x-ndjson`, `Transfer-Encoding: chunked`. transcode/buffering 없음
6. 클라이언트가 fetch abort 하면 (TCP RST) bridge → Ollama 연결도 끊김 → 생성 중단

### 다른 endpoint 의도적으로 노출 안 함

`/api/pull`, `/api/delete`, `/api/create`, `/api/push`, `/api/copy`, `/api/tags`, `/api/show` 등 Ollama admin 표면이 외부 토큰 보유자에게 절대 도달 안 함. bridge 는 `/llm/chat` 만 라우팅, 나머지는 404.

`/llm/models` 도 첫 spec 에서 제외 — 자동완성 같은 UX 가 없으면 YAGNI. 노트에 모델 이름 잘못 적었으면 첫 보내기 때 404 로 알게 됨.

### 에러 매핑

| Ollama 응답 | bridge HTTP | 클라이언트 본문 |
|---|---|---|
| 404 (model not found) | `404 model_not_found` | `[오류: 모델 'X' 없음. ollama pull X 필요]` |
| connection refused | `503 ollama_unavailable` | `[오류: Ollama 서비스가 응답하지 않음]` |
| 5xx | `502 upstream_error` | `[오류: 업스트림 5xx]` |
| 200 stream 도중 끊김 | (이미 일부 chunk 보냄) | 클라이언트가 stream 종료로 인식, 마지막 token 까지 살림 |

### 구현 파일

```
bridge/
├── src/
│   ├── server.ts                     ← 기존, /llm/* 라우팅 등록 1줄
│   ├── auth.ts                       ← 기존, Bearer 검증 재사용
│   ├── pty.ts                        ← 기존, 변경 없음
│   └── llm.ts                        ← 신규, /llm/chat 핸들러 (~60줄)
├── Containerfile                     ← 변경 없음
└── deploy/term-bridge.container      ← env 1줄 추가: OLLAMA_BASE_URL
```

추가 의존성 0. Node 18+ 의 `fetch` + `ReadableStream` 만으로 NDJSON 패스스루.

### Caddy

기존 reverse_proxy 가 모든 path 를 bridge 로 보내므로 `/llm/*` 도 자동. Caddy 의 reverse_proxy 는 기본 streaming 이라 NDJSON 그대로. 변경 0.

### 로깅

terminal bridge 와 동일 패턴 — 요청 시작 (model, message count, 토큰 길이 추정), 응답 종료 (소요 시간, 생성 토큰 수, 에러), **본문은 로깅 X**. 노트 본문엔 개인정보가 들어갈 수 있고 bridge 호스트를 누가 보든 새지 않아야 한다.

### Rate limit

단일 사용자 환경이라 첫 spec 에선 생략. Ollama 의 `OLLAMA_NUM_PARALLEL=1` 환경변수가 한 모델당 동시 호출 수 제한.

---

## 섹션 5 — 클라이언트 모듈 구조

```
app/src/lib/
├── llmNote/                          ← 신규 (pure 모듈, 단위 테스트 용이)
│   ├── parseLlmNote.ts               ← editor JSON → LlmNoteSpec | null
│   ├── buildChatRequest.ts           ← LlmNoteSpec → /llm/chat body
│   ├── sendChat.ts                   ← fetch + NDJSON 스트림 + AbortController
│   └── defaults.ts                   ← 자동 보완 기본값
└── editor/
    ├── llmNote/                      ← 신규 (ProseMirror & Svelte UI)
    │   ├── llmNotePlugin.ts          ← 시그니처 감지 + 자동 헤더 보완
    │   └── LlmSendBar.svelte         ← 우하단 [보내기] / [중지] / 토큰 카운트
    └── terminal/
        └── bridgeSettings.ts         ← 기존, URL + Bearer 토큰 재사용
```

### 설정 UI 변경

`routes/settings/+page.svelte` 의 "터미널 브릿지" 섹션 라벨을 **"원격 브릿지"** 로 변경. URL / 토큰 의미는 동일, LLM 노트와 terminal 노트가 같은 자격 증명 사용. 새 설정 항목 추가 0.

### 기존 코드 영향

| 파일 | 변경 |
|---|---|
| `routes/note/[id]/+page.svelte` | `<LlmSendBar>` 마운트 추가 (parseLlmNote 결과 watch) |
| `lib/desktop/NoteWindow.svelte` | 동일 |
| `lib/editor/TomboyEditor.svelte` | `llmNotePlugin` 을 다른 plugin (autoWeekday 등) 옆에 등록 |
| `routes/settings/+page.svelte` | "터미널 브릿지" → "원격 브릿지" 라벨 1줄 |
| `bridge/src/server.ts` | `/llm/*` 라우팅 등록 |
| `bridge/src/llm.ts` | 신규 핸들러 |
| `bridge/deploy/term-bridge.container` | `OLLAMA_BASE_URL` env 추가 |
| `pipeline/desktop/deploy/desktop-pipeline.service` | `ExecStartPre` Ollama evict 1줄 (섹션 6) |

`noteManager.ts` / `noteStore.ts` / Firebase sync / Dropbox sync **변경 없음** — LLM 노트는 일반 노트와 같은 저장 / sync 경로. `notifyNoteSaved` 자동 호출 → 다른 디바이스가 채팅 본문을 자동으로 받음 (Firebase 실시간 노트 동기화 패턴 그대로). title 유니크 / 백링크 / 자동링크 / 그래프 시각화 등 기존 인프라도 평소대로 동작.

---

## 섹션 6 — Ollama 운영 / diary VLM 과의 동거

### VRAM 수학

| 모델 | VRAM (4-bit) | 비고 |
|---|---|---|
| Qwen2.5-Coder-3B | ~2 GB | Ollama |
| Qwen2.5-7B | ~5.5 GB | Ollama |
| Qwen2.5-VL-7B | ~5.5 GB | diary 의 transformers 직접 로딩 |

세 모델 합 ≈ 13 GB > 3080 의 10 GB. 동시 메모리 불가 → swap 전략 필요.

### Ollama 설정

`/etc/systemd/system/ollama.service.d/override.conf` (또는 rootless container env):

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"      ← 외부 노출 X, bridge 만 접근
Environment="OLLAMA_KEEP_ALIVE=5m"              ← idle 5분 후 unload
Environment="OLLAMA_MAX_LOADED_MODELS=2"        ← 3B + 7B 동시 가능
Environment="OLLAMA_NUM_PARALLEL=1"             ← 단일 사용자
```

### diary 와의 충돌 방지

diary 의 `s3_ocr` 가 transformers 로 VLM 5.5 GB 잡으려고 할 때, Ollama 가 이미 7B 갖고 있으면 OOM. transformers 는 Ollama 의 VRAM 점유를 모름.

해결 — diary systemd unit 의 `ExecStartPre` 에서 명시적으로 Ollama 모델 evict:

```bash
ExecStartPre=/bin/bash -c '\
  for m in qwen2.5-coder:3b qwen2.5:7b; do \
    curl -sf -X POST http://localhost:11434/api/generate \
      -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null || true; \
  done'
```

`keep_alive: 0` 빈 호출 = "모델 unload". diary 종료 시 추가 조치 없음 — Ollama 가 다음 호출 때 자연스럽게 다시 로드.

### 역방향 (Ollama 호출 중 diary 시작)

`OLLAMA_MAX_LOADED_MODELS=2` 라도 GPU 메모리는 OS 가 관리. transformers 가 5.5 GB 점유한 상태에서 Ollama 가 7B 로딩 시도 → OOM. transformers 의 VRAM 을 Ollama 가 모르기 때문에 자동 회피 없음.

타협: diary 작업은 일반적으로 야간이라 실사용에서 충돌 거의 없음. 충돌 시 클라이언트가 `503 ollama_unavailable` → 사용자가 잠시 후 재시도. 자동 retry 는 spec 비-목표 (소음 가능성).

### Ollama 설치 방식

Fedora Atomic (Bazzite) 에서 공식 `install.sh` 는 직접 안 됨. 추천: **rootless container** (`ghcr.io/ollama/ollama:latest`) — bridge 와 같은 패턴, podman + Quadlet, host network, GPU 통과 (`--device nvidia.com/gpu=all` 또는 CDI). 모델 디렉토리 (`~/.ollama`) 는 named volume 또는 fast 스토리지 마운트.

운영 디테일 (정확한 Quadlet 파일, CDI 설정, GPU passthrough) 는 implementation plan 단계에서.

---

## 섹션 7 — Invariant

| Invariant | 이유 |
|---|---|
| **단락 1 = 사용자 자유 제목, 단락 2 = `llm://<model-ref>` 시그니처 1줄** | `extractTitleFromDoc` 가 첫 블록 plain text 를 제목으로 쓰는 기존 invariant 와 LLM 시그니처의 자연스러운 공존. 시그니처 줄만 지우면 LLM 동작 끄는 것과 동치 |
| **시그니처가 `doc.content[0]` 에 있는 과도기 상태도 LLM 노트로 인식** | 사용자가 빈 노트에 시그니처를 먼저 적은 직후 자동 보완이 도달하기 전의 단일 transaction 동안 — 일관성 위해 파서가 두 위치 모두 허용 |
| **헤더 / turn 경계 = 빈 단락** | system 의 멀티라인 값이 우연히 `Q:` 줄 포함하는 케이스를 grammar 가 다루지 않도록 |
| **자동 헤더 보완은 시그니처 완성 transaction + mount 시 헤더 0개일 때만** | 사용자가 의도적으로 지운 키를 매 transaction 마다 되살리지 않음 |
| **자동 트리거 없음 — 보내기는 명시적 (Ctrl+Enter / 버튼) 만** | LLM 호출은 비용·예기치 못한 응답 누적·외부 호출이라 매직 자동화 ❌ |
| **같은 노트에 응답 도중 재보내기 막힘** | 같은 노트의 두 응답 race + 노트 본문 충돌 방지. UI 의 [중지] 상태일 때 보내기 disable |
| **bridge 가 노출하는 LLM endpoint = `/llm/chat` 단 1 개** | Ollama admin 표면이 외부 토큰 보유자에게 절대 도달 안 함 |
| **Ollama 는 `127.0.0.1:11434` 만 바인딩** | bridge 외 누구도 직접 호출 못 함 — admin endpoint 의 호스트-수준 격리 |
| **Bearer 토큰은 terminal bridge 와 공유** | 같은 bridge, 같은 신뢰 경계. 별도 토큰 관리 표면 0 |
| **bridge 로그에 prompt / 응답 본문 안 남김** | 메시지 카운트·소요 시간·에러만 로깅 |
| **응답은 노트 본문의 일부 — Firebase / Dropbox 일반 sync 경로** | LLM 응답이라고 특수 처리 없음. 다른 디바이스에서 자동 동기화 |
| **노트는 평문 grammar — Tomboy desktop 호환** | `.note` XML 의 `<note-content>` 안에 그냥 텍스트. desktop 에서 열면 일반 노트로 보임 |
| **응답 도중 노트 떠나면 abort** | 첫 spec 의 단순화. 백그라운드 진행 / multi-device 응답 reconcile 비-목표 |
| **모델 access list 없음 — 노트의 모델 ref 그대로 신뢰** | 토큰 보유자는 Ollama 설치된 어떤 모델이든 호출 가능. 단일 사용자 환경 가정 |

**명시적 비-목표** — 노트 본문의 사용자 입력 / 모델 응답을 별도 암호화 / Firestore 외부 저장 안 함. `tomboy-web` 의 기존 데이터 보호 모델 (브라우저 IDB + Dropbox + Firestore, uid-scoped Firestore rules) 을 그대로 따른다.

---

## 섹션 8 — 테스트 / 검증

### 자동 테스트

`app/tests/unit/`:

| 파일 | 검증 |
|---|---|
| `llmNote/parseLlmNote.test.ts` | (a) `llm://qwen2.5-coder:3b` 시그니처 인식 (b) `llm://invalid format!` 폴백 → `null` (c) 시그니처 없음 → `null` (d) 헤더 멀티라인 system (e) `temperature: not-a-number` 시 키 무시 + 나머지 살림 (f) turn 영역 Q/A 추출 (g) 마지막 빈 Q: → `trailingEmptyUserTurn: true` |
| `llmNote/buildChatRequest.test.ts` | (a) system 이 messages 앞 prepend (b) system 없으면 messages 그대로 (c) options 의 undefined 키 omit (d) model 그대로 |
| `editor/llmNotePlugin.test.ts` | (a) 시그니처 타이핑 transaction 직후 헤더 + 빈 Q: 자동 추가 (b) mount 시 헤더 키 0개 → 보완 (c) mount 시 헤더 일부 있으면 → 보완 안 함 (d) 사용자가 `temperature:` 줄 지운 후 transaction → 자동 복원 안 함 |
| `llmNote/sendChat.test.ts` (선택) | mock fetch 로 NDJSON happy path + 401 + AbortController 3 케이스 |

bridge 측 단위 테스트 (`bridge/test/llm.test.ts`) — mock Ollama 로 (a) `/llm/chat` 정상 패스스루 (b) 401 (c) 404 model_not_found (d) Ollama 연결 거부 → 503. 테스트 인프라 없으면 manual smoke 만 — 첫 spec 으로 OK.

### 수동 smoke 시나리오

implementation 직후 본인이 직접 돌릴 체크리스트:

1. PC 에 Ollama 설치 + `ollama pull qwen2.5-coder:3b` + `ollama pull qwen2.5:7b`
2. bridge container 재배포 (`OLLAMA_BASE_URL` env 추가)
3. PWA 에서 새 노트 → 첫 줄 `llm://qwen2.5-coder:3b` → 자동 보완 확인 (빈 제목 단락이 앞에 삽입되어 커서가 거기로, 시그니처가 두 번째 단락, 헤더 보완 + 빈 Q: 줄 추가)
4. 빈 제목 단락에 의미 있는 제목 입력 (예: "셸 도우미") → `system:` 옆에 페르소나 입력 → 첫 Q 작성 → Ctrl+Enter
5. 응답이 토큰 단위로 노트에 스트리밍 + 자동 스크롤
6. 두 번째 Q → 보내기 → follow-up 이 이전 Q/A context 반영
7. 도중 [중지] → 부분 응답 남고 빈 Q: 추가
8. 노트 닫고 다시 열기 → 본문 + 헤더 그대로 (자동 보완 재발생 안 함)
9. 두 번째 LLM 노트 (`llm://qwen2.5:7b`, 다른 system) → 두 노트 동시 사용
10. **모바일 PWA 외부 네트워크**: 단계 1~6 반복 (Caddy + Bearer 경로 검증)
11. Tomboy desktop ref 에서 LLM 노트 열기 → 본문이 그냥 텍스트로 보이고 desktop 이 크래시 X
12. diary 일부러 실행 (테스트 페이지 던지기) → 그 사이 LLM 노트 보내기 → 503 토스트 (또는 evict 후 정상)
13. 토큰 만료 시뮬 (`BRIDGE_SECRET` 회전) → 보내기 → 401 → "원격 브릿지 재인증" 토스트

### 관측 가능성

bridge 로그:
- 요청: `[llm] model=qwen2.5-coder:3b msgs=4 tokens_in≈X`
- 응답: `[llm] done duration=2.4s tokens_out=87` 또는 `[llm] error model_not_found`
- 본문은 절대 로깅 X

### 성능 expectation (RTX 3080 10GB)

- Qwen2.5-Coder-3B: 첫 토큰 ~300 ms (이미 로드), throughput ~80–120 tok/s
- Qwen2.5-7B: 첫 토큰 ~500 ms, throughput ~50–70 tok/s
- 첫 로딩 (LRU evict 후): 추가 2–8 초

이 expectation 보다 크게 느리면 `num_parallel` / GPU layers 등 튜닝 — 이 spec 의 범위 아님.

---

## 섹션 9 — 비-목표 / 다음 spec

본 spec 에서 의도적으로 다루지 않는 항목 (각 항목 향후 별도 spec):

1. **RAG 인프라** — 임베딩 (bge-m3), 벡터 저장소, 노트 인덱싱 파이프라인, retrieval API. 빠른 도우미 노트 자체는 RAG 불필요라 의도적 제외.
2. **개인 아바타 / 페르소나 fine-tune** — LoRA, RAG + 페르소나 시스템 프롬프트의 결합. RAG 인프라 위에서 진행.
3. **OCR 재검수 통합** — diary 파이프라인 s3_ocr 다음에 텍스트 후처리 단계. 본 spec 의 bridge endpoint 와 Ollama 인프라를 재사용하지만 별도 노트 타입 + diary 코드 변경 필요.
4. **자동 트리거 시스템** — 특정 노트에 변경 발생 시 자동 모델 호출 (예: `[0] Inbox` 노트에 새 항목 추가되면 자동 분류). schedule 노트의 "일정 변경 감지" 와 다른 종류의 일반화. 본 spec 은 명시적 보내기만.
5. **응답 도중 노트 떠남 후 백그라운드 진행** — service worker 또는 외부 store 가 응답 버퍼링, 노트 재오픈 시 reconcile. 모바일 PWA visibility change 까지 다루려면 별도 설계 필요.
6. **다중 디바이스 응답 race** — 디바이스 A 와 B 가 같은 노트에 동시 보내기. Firestore conflict resolver 가 last-write-wins 로 결정하지만 사용자에겐 "응답 하나가 사라진" 경험. 별도 conflict UX 필요.
7. **WOL 대응** — terminal note 의 hosts.json + WOL 패턴 재사용. 첫 보내기 30–60초 지연 인정 필요. 본 spec 은 PC 켜져 있다 가정.
8. **Modelfile 기반 인스턴스 / 모델 access list / 다중 사용자** — 노트가 정의 1차 소스라는 결정과 단일 사용자 환경 가정으로 제외.
9. **`/llm/models` endpoint / 모델 자동완성** — 노트 입력 시 모델 이름 자동완성 UX. 사용자가 모델 이름 외우거나 잘못 적은 거 404 로 알게 되는 게 충분.

---

## 참조

- terminal note 디자인: `docs/superpowers/specs/2026-05-08-terminal-note-history-design.md`, `docs/superpowers/specs/2026-05-08-terminal-note-tmux-window-history-design.md`
- diary 파이프라인: `docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`, `.claude/skills/tomboy-diary/SKILL.md`
- 기존 인프라:
  - `bridge/src/{server,auth,pty,hosts,wol}.ts`
  - `bridge/deploy/term-bridge.container`, `bridge/deploy/Caddyfile`
  - `app/src/lib/editor/terminal/bridgeSettings.ts`
  - `app/src/lib/editor/autoWeekday/autoWeekdayPlugin.ts` — 자동 헤더 보완의 패턴 모범
  - `pipeline/desktop/ocr_backends/local_vlm.py` — 기존 VLM 모델 사용 패턴
- Ollama 문서:
  - HTTP API: <https://github.com/ollama/ollama/blob/main/docs/api.md>
  - 모델: <https://ollama.com/library/qwen2.5-coder>, <https://ollama.com/library/qwen2.5>
- Tomboy `.note` XML 호환성: `app/src/lib/core/noteContentArchiver.ts`
