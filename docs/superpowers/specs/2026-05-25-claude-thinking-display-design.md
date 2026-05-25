# Claude 채팅 노트 — thinking/도구 진행 상황 transient 표시

**상태**: spec 초안
**브랜치**: `shifu`
**관련 파일**: `app/src/lib/chatNote/`, `app/src/lib/editor/chatNote/`, `claude-service/src/`

## 배경

현재 `claude://` 채팅 노트는 응답 `text_delta`만 받아 `A:` 단락에 누적한다. `claude-service/src/runner.ts:105-115`가 `thinking_delta`, `signature_delta`, `input_json_delta`, 구조 이벤트를 모두 의도적으로 스킵하기 때문이다. 사용자는 모델이 "지금 무엇을 생각/실행하고 있는지" 보고 싶지만, 그 콘텐츠가 노트 본문에 영구 저장되는 것은 원치 않는다. 즉 **transient(일시적) 표시**가 필요하다.

기존 동작과의 차이는 단 하나: thinking·도구 진행 상황이 스트리밍 동안만 보이고, 종료 시 사라진다. Q:/A: 영구 구조와 IDB/XML/Dropbox/Firestore 저장 경로는 zero change.

## 결정사항

| 항목 | 결정 |
|---|---|
| 표시 범위 | extended thinking + 도구 호출(이름/인자) + 도구 결과 발췌 + 메타 진행 상황(예: "응답 작성 중") |
| 갱신 단위 | **step 경계** — 새 thinking 블록 시작 / 새 도구 호출 시작 / 도구 결과 수신 / 응답 시작. 한 step 안에서는 body 누적. step 전환 시 통째로 교체. |
| 종료 시점 | 스트림 종료(done/abort/error) 즉시 사라짐. 최종 상태 = 기존과 동일(Q:/A:만). |
| 시각 배치 | 스트리밍 중인 A: 단락 바로 위에 인라인 blockquote 스타일 DOM. |
| 구현 채널 | ProseMirror **widget decoration**. doc에 절대 쓰지 않음. |
| 백엔드 | `claude://` 전용. Ollama 백엔드는 영향 없음. |

## 아키텍처

```
[claude CLI] --stream-json--> [claude-service/runner.ts]
                                       │
                                       │ SSE: {delta}/{step}/{done}/{error}
                                       ▼
                              [bridge /claude/chat]  (passthrough)
                                       │
                                       ▼
                              [sendClaude in claude.ts]
                                       │ onToken(delta) ────┐ (기존 — A: 누적)
                                       │ onStep(step)   ──┐ │
                                       ▼                  │ │
                              [ChatSendBar.svelte]        │ │
                                       │                  │ │
                ┌──────────────────────┘                  │ │
                ▼                                         ▼ ▼
        plugin.setStep(step)                       editor.appendToLastParagraph(delta)
                │
                ▼
        [thinkingDisplayPlugin]
                │ (PM widget decoration, doc 미오염)
                ▼
        A: 단락 위에 blockquote DOM 렌더
```

**핵심 분리선**: thinking 표시는 PM decoration 채널, A: 응답은 기존 doc 채널. 두 채널은 같은 SSE 스트림에서 갈라지지만 클라이언트 내에서 만나지 않는다. 따라서 thinking은 어떤 영구 저장 경로도 거치지 않는다.

## SSE 프로토콜 확장

`runner.ts`가 신규 이벤트 한 종류만 추가 emit:

```ts
// 기존
data: {"delta":"<text>"}
data: {"done":true,"reason":"success"}
data: {"error":"..."}

// 신규
data: {"step":{"kind":"...","label":"...","body":"..."}}
```

`step.kind` ∈ `'thinking' | 'tool_use' | 'tool_result' | 'response_start'`

**언제 emit하나** (Claude Code stream-json 이벤트 매핑):

| Claude Code 이벤트 | runner 동작 |
|---|---|
| `stream_event` + `content_block_start` (`type:'thinking'`) | 새 step → `{kind:'thinking', label:'생각 중', body:''}` |
| `stream_event` + `content_block_delta` (`thinking_delta`) | 현재 step body에 누적 후 re-emit (`body: 누적 전체`) |
| `stream_event` + `content_block_start` (`type:'tool_use'`) | 새 step → `{kind:'tool_use', label:'<도구명> 실행 중', body:''}` |
| `stream_event` + `content_block_delta` (`input_json_delta`) | tool_use body에 args JSON 누적 |
| `type:'user'` (tool_result 포함) | 새 step → `{kind:'tool_result', label:'<도구명> 결과', body: 결과 발췌(앞 500자)}` |
| `stream_event` + `content_block_start` (`type:'text'`) | 새 step → `{kind:'response_start', label:'응답 작성 중', body:''}` |
| `stream_event` + `content_block_delta` (`text_delta`) | 기존 `{delta}` 그대로 (response_start step body는 더 안 갱신) |

**왜 누적분을 매번 통째로 보내나** — 클라이언트가 "현재 step의 전체 상태"만 들고 있도록 단순화. 증분 합치기 로직 불필요. 한 thinking 블록당 대개 ≤ 8K 토큰이므로 페이로드 부담 미미. 더 압축이 필요하면 후속 PR.

**기존 동작 보존** — `text_delta`의 `{delta}` 처리는 그대로. 기존 클라이언트 코드는 zero change로 동작.

## 클라이언트 — 플러그인 & 와이어링

### 신규 파일: `app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts`

```ts
export interface ThinkingStep {
  kind: 'thinking' | 'tool_use' | 'tool_result' | 'response_start';
  label: string;
  body: string;
}

export const thinkingDisplayKey =
  new PluginKey<{ step: ThinkingStep | null }>('thinkingDisplay');

export function createThinkingDisplayPlugin(): Plugin { /* ... */ }
export function setStep(view: EditorView, step: ThinkingStep | null): void;
export function clearStep(view: EditorView): void;  // setStep(view, null)
```

**책임**:
- `state.step` 유지 (null = 표시 안 함).
- meta transaction (`thinkingDisplayKey`)으로 setStep/clear 수신.
- `decorations(state)`: state.step 있으면 doc 끝 직전(마지막 단락 시작 위치) widget decoration 1개. 없으면 빈 DecorationSet.

**위치 계산**: 마지막 단락의 시작 위치. 매 transaction마다 다시 계산 (`doc.lastChild` 1번 + offset). 다른 단락에 묶으면 사용자 doc 편집 시 위치가 어긋남.

### `backends/claude.ts` 변경

```ts
export interface SendClaudeOpts {
  url: string;
  token: string;
  body: ClaudeChatBody;
  onToken: (delta: string) => void;
  onStep?: (step: ThinkingStep) => void;  // 신규, optional
  signal?: AbortSignal;
}
```

SSE 파싱 루프에 `parsed.step` 분기 한 줄 추가. `onStep` undefined 시 silently 무시 → Ollama 백엔드 zero change.

### `ChatSendBar.svelte` 변경 (runClaude)

```ts
const r = await sendClaude({
  url: `${httpBase}/claude/chat`,
  token: bridgeToken,
  body,
  onToken: (delta) => { appendToLastParagraph(delta); tokenCount++; },
  onStep: (step) => { setStep(editor.view, step); },   // 신규
  signal: ctrl.signal
});
```

그리고 `send` 함수의 기존 `finally` 블록(`editor.setEditable(true)`가 있는 곳)에 `clearStep(editor.view)` 한 줄 추가. done/abort/error 모든 경로를 한 곳에서 정리.

### `TomboyEditor.svelte` 플러그인 등록

기존 `chatNotePlugin` 옆에 같이 등록 (둘 다 chat note 전용이므로 같은 게이트 공유).

## 렌더링

### Widget DOM 구조

```html
<aside class="thinking-display" data-kind="thinking|tool_use|tool_result|response_start">
  <header class="thinking-display-label">생각 중</header>
  <blockquote class="thinking-display-body">사용자가 X를 물어보고 있으니까…</blockquote>
</aside>
```

- `<aside>` — 의미적으로 보조 콘텐츠. PM `contentEditable=false` widget이라 커서 진입 불가.
- 마크다운 `>` 느낌은 실제 `<blockquote>` + 왼쪽 두꺼운 보더로 표현. 본문 폰트는 editor와 같은 sans, 약간 작고 흐릿 (`opacity: 0.78`).
- `data-kind`로 색상 톤만 살짝 구분 (예: `tool_use`=청회색, `tool_result`=옅은 초록). 라벨이 있으니 색은 보조 신호.
- `body`가 빈 문자열이면 `<blockquote>` 생략, 라벨만 렌더. ("도구 X 실행 중" 같은 메타 step)
- `body`는 `white-space: pre-wrap` + `max-height: 12em` + `overflow: hidden` + bottom fade mask. 한 step 안 누적이 길어지면 위쪽이 잘리고 아래쪽 신선한 텍스트가 보임. (스크롤바 X — transient라 인터랙티브 X)

### 전환

- step 교체 시 plugin이 widget DOM을 새로 생성. 깜빡임이 거슬리면 후속 PR에서 stable `key`로 in-place 갱신 튜닝. 1차 구현은 단순 재생성.
- 사라질 때 페이드아웃 없음. 즉시 제거가 사용자 의도("transient")와 일치.

### 다크 모드 / 모바일

- `var(--text-muted)`, `var(--border-color)`, `var(--bg-subtle)` 등 기존 토큰 재사용.
- 폰트 `clamp(0.8rem, 1.5vw, 0.95rem)` — 좁은 뷰포트 대응 (다른 chat note 컴포넌트 패턴 따름).

## 엣지 케이스

1. **Abort 중간**: fetch reject/return → `send`의 `finally`가 `clearStep` → widget 즉시 사라짐. A: 누적 부분은 보존 (기존 동작).
2. **Error 도중**: `sendClaude` throw → `runClaude` catch → 에러 line append → `finally`에서 `clearStep`.
3. **Tool use 중 abort**: 마지막 step이 `tool_use` 상태에서 멈춰있던 채로 clearStep으로 깨끗이 사라짐.
4. **연속 thinking 블록 (도구 사이)**: 두 번째 `content_block_start(thinking)` → 두 번째 step이 첫 번째를 덮어씀. 의도된 동작.
5. **`text_delta`가 thinking 블록 없이 바로 시작 (간단한 응답)**: `response_start` step 한 번만 → 곧바로 done → 거의 안 보임. OK.
6. **Sub-agent / nested tool calls**: stream-json은 평탄화 emit → step이 더 많이 발생. 각각 덮어쓰기 → 자연스럽게 처리.
7. **사용자 editing 중 send → setEditable(false) 됐는데 step 도착**: doc 끝이 흔들리지 않음. OK.
8. **빈 doc** (이론상 거의 없음): 마지막 단락 없으면 position 계산 실패 → plugin은 step 무시 (decoration 비움). 안전.
9. **두 노트 동시 chat (desktop multi-window)**: plugin state는 editor instance마다 독립 → 간섭 없음 (기존 chatNotePlugin도 동일).
10. **`onStep` 안 넘긴 호출자 (Ollama, 기존 코드)**: optional이라 silently skip.

## 테스트

**Unit (vitest, `app/tests/unit/`)**:
- `chatNote/backends/claude.test.ts` — SSE 파서가 `{step}` 이벤트를 받아 `onStep` 호출 (기존 `{delta}` 테스트 옆에 추가).
- `editor/chatNote/thinkingDisplayPlugin.test.ts`:
  - `setStep` → DecorationSet에 widget 1개, position 검증
  - `clearStep` → DecorationSet 비움
  - 연속 step → 이전 step 덮어씀 (DecorationSet 여전히 1개)
  - 빈 doc → step 무시
  - body 빈 step → 라벨만 렌더 (DOM 검증)

**Integration (node:test, `claude-service/tests/`)**:
- runner.ts: 가짜 stream-json 입력 → emit된 SSE 라인 시퀀스 검증
  - thinking 블록 → `{step}` (kind=thinking, body 누적) 다수
  - tool_use → `{step}` (kind=tool_use)
  - tool_result 메시지 → `{step}` (kind=tool_result)
  - text 블록 → `{step}` (kind=response_start) 후 `{delta}` 누적
  - `{step}`과 `{delta}`가 같은 stream에 섞여 나옴
- 기존 `{delta}`-only 시나리오 회귀 없음

**Manual smoke**:
- 데스크탑 claude-service 재시작 → 모바일에서 `claude://` 노트에 "리포트를 작성하면서 도구도 한 번 호출해줘" 같은 도구 유발 질문 → thinking + 도구 + 응답 step이 차례로 blockquote에 표시되는지 눈으로 확인.

## 변경 파일

- `claude-service/src/runner.ts` — `{step}` emit 로직.
- `app/src/lib/chatNote/backends/claude.ts` — `onStep` 옵션, SSE 파서 분기.
- `app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts` — 신규 PM 플러그인.
- `app/src/lib/editor/chatNote/ChatSendBar.svelte` — `onStep`/`clearStep` 와이어링.
- `app/src/lib/editor/TomboyEditor.svelte` — 플러그인 등록.
- 테스트 3종 (위 참조).

## Non-goals (의도적으로 제외)

- thinking 콘텐츠의 영구 저장 (사용자가 명시적으로 transient만 원함).
- thinking blockquote와 사용자 인터랙션 (커서/선택/복사). PM widget contentEditable=false로 충분.
- Ollama 백엔드의 step 표시 (Ollama는 thinking deltas 없음, 후속 작업 시 별도 디자인).
- thinking 콘텐츠의 시간순 히스토리 (모든 이전 step은 다음 step에 덮어쓰임 — 명시적 선택).
- thinking 표시 on/off 토글 (1차 구현은 항상 켜짐. 노이즈가 거슬리면 후속 PR에서 헤더 옵션 추가).
