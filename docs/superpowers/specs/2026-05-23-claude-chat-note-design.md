# Claude 채팅 노트 설계 (`claude://`)

작성일: 2026-05-23
워크트리/브랜치: `tigress`

## 1. 배경과 동기

현재 노트 앱에는 Ollama 채팅용 `llm://<model>` 시그니처 노트가 있다
(`app/src/lib/llmNote/`, `app/src/lib/editor/llmNote/`). 시그니처 + 헤더 +
`Q:`/`A:` 턴 + 보내기 버튼 + 스트리밍 응답까지 안정적으로 동작한다. RAG,
abort, 에러 분류 등 부수 기능도 갖춰져 있다.

이 위에 **Claude Code 구독**으로 클로드와 대화할 수 있는 노트를 추가한다.

- **왜 별도 노트인가**: Ollama 백엔드와는 동작 모델(다중 모달, 도구, 세션 모델,
  레이트 한도)이 충분히 다르다. 사용자 의도도 다르다.
- **왜 CLI subprocess 경로인가**: Claude API 키 직사용은 토큰 종량제다.
  Pro/Max 구독을 활용하려면 `claude` CLI (`@anthropic-ai/claude-code`)를
  spawn해 구독 OAuth 자격증명을 통과시켜야 한다.
- **왜 지금**: 모바일에서 클로드와 대화하는 사용 흐름 자체를 검증하기
  위한 "테스트" 단계. 향후 GitHub 이슈 자동화 파이프라인(별도 설계)에서
  데스크탑 클로드를 호출하는 메커니즘과 인프라(브릿지 + 데스크탑 서비스)를
  공유한다.

## 2. 운영 환경 — 전제

```
┌──────────────┐  HTTPS+Bearer   ┌────────────────────┐  HTTP (LAN)   ┌──────────────────────────┐
│ Web app      │ ───────────────►│ Raspberry Pi       │ ─────────────►│ Desktop                  │
│ (TipTap +    │                 │ - term-bridge      │               │ - Ollama (기존)            │
│  chatNote)   │                 │ - Caddy reverse    │               │ - ocr-service (기존)       │
│              │                 │   proxy            │               │ - claude-service (신규)    │
│              │                 │ - rootless Podman  │               │   (Node, claude CLI 호출)  │
│              │                 │ + Quadlet          │               │                          │
└──────────────┘                 │                    │               └──────────────────────────┘
                                 │ NO GPU.            │
                                 │ NO model hosting.  │
                                 └────────────────────┘
```

핵심 invariant (기존 OCR/Ollama 설계와 동일):

- **브릿지(Pi)는 GPU/모델 호스팅 없음**. Pi의 역할은 HTTPS 종단, Bearer 인증,
  데스크탑 서비스로의 라우팅뿐.
- **`claude` CLI 와 OAuth 자격증명은 데스크탑에만 있음.** Pi에 클로드 설치/
  로그인하지 않는다.
- **데스크탑 → Anthropic API 호출은 사용자 구독 OAuth 경로로만**.
  `ANTHROPIC_API_KEY` 환경변수를 명시적으로 비워 종량제 fallback을 차단.
- **데스크탑이 꺼져 있을 수 있음** → 브릿지는 `/claude/chat` 호출에 짧은
  타임아웃 + 명확한 에러(`claude_service_unavailable`)를 반환.

## 3. 모듈 구성 — `llmNote/` 일반화

`llmNote/` 를 `chatNote/` 로 일반화한다. 단일 파싱/UI 인프라가 두 백엔드
(`ollama` | `claude`)를 모두 다룬다.

**이동 (리네임):**

```
app/src/lib/llmNote/                  →  app/src/lib/chatNote/
  parseLlmNote.ts                     →    parseChatNote.ts
  sendChat.ts                         →    backends/ollama.ts
  buildChatRequest.ts                 →    backends/ollama.ts (병합)
  searchRag.ts                        →    backends/ollama.ts (RAG는 ollama 전용)
  defaults.ts                         →    defaults.ts (백엔드별 분리)

app/src/lib/editor/llmNote/           →  app/src/lib/editor/chatNote/
  LlmSendBar.svelte                   →    ChatSendBar.svelte
  llmNotePlugin.ts                    →    chatNotePlugin.ts
```

**신규:**

```
app/src/lib/chatNote/
  backends/claude.ts          — sendClaude, ClaudeChatError, SSE 파서
  buildClaudeMessages.ts      — Q:/A: 턴 → Anthropic messages 직렬화

bridge/src/
  claude.ts                   — POST /claude/chat 프록시 (ocr.ts 패턴)
  claude.test.ts

claude-service/               — 신규 데스크탑 서비스 (ocr-service 패턴)
  src/
    server.ts                 — Fastify/express POST /chat
    runner.ts                 — claude CLI subprocess + stream-json 변환
    auth.ts                   — Bearer 검증
  Containerfile               — Node 22 + @anthropic-ai/claude-code
  deploy/claude-service.container  — Quadlet unit
  tests/runner.test.ts        — FakeClaudeRunner로 단위 테스트
  tests/server.test.ts
  package.json, tsconfig.json
```

**기존 `llm://` 노트 호환**: `parseChatNote` 가 `llm://` 와 `claude://`
둘 다 인식한다. 데이터 마이그레이션 0건.

## 4. 노트 포맷 (parse spec)

### 4.1 시그니처 (두 번째 줄, `doc.content[1]`)

```
llm://<model>             — 기존 (Ollama)
claude://[<model>]        — 신규 (Claude). 모델 생략 가능 → CLI 디폴트
```

정규식:

```ts
CHAT_SIGNATURE_RE = /^(llm|claude):\/\/([\w\-.\/:]+)?\s*$/;
// [1] = 백엔드 'llm' | 'claude'
// [2] = 모델 (claude는 옵션)
```

`llm://` 는 모델 필수 (기존 동작 유지). `claude://` 는 모델이 옵션이며 생략
시 `claude` CLI의 기본 모델을 따른다.

### 4.2 헤더 (시그니처 다음 줄부터 첫 빈 줄까지)

```ts
CHAT_HEADER_KEY_RE = /^([a-zA-Z_][\w-]*):\s*(.*)$/;
```

**공통:** `system:`, `model:` (생략 가능 — 시그니처와 중복 시 헤더 우선).

**Ollama 전용 (기존 그대로):**
`temperature:`, `num_ctx:`, `top_p:`, `seed:`, `num_predict:`, `rag:`.

**Claude 전용 (신규):**
- `cwd:` — 데스크탑 절대 경로. **존재하면 도구 활성화**, 없으면
  `--disallowedTools '*'`.
- `allowedTools:` — 콤마 구분. `cwd:` 있을 때만 의미. 생략 시 CLI 디폴트.

**알 수 없는 키 = 조용히 무시.** Ollama 헤더가 `claude://` 노트에 있어도
무시되고 그 반대도 마찬가지.

### 4.3 Q:/A: 턴 (변경 없음)

기존 `parseLlmNote` 의 턴 파싱 그대로:

- 헤더 종료 빈 줄 이후가 turn 영역
- `Q: ` / `A: ` 프리픽스로 turn 시작
- 같은 role의 후속 단락은 같은 turn에 누적 (멀티라인)
- `Q:` 만 있고 내용 없으면 `trailingEmptyUserTurn: true` (보내기 활성화 게이트)

### 4.4 `ChatNoteSpec` 타입

```ts
type ChatBackend = 'ollama' | 'claude';

interface ChatNoteSpec {
  backend: ChatBackend;
  model: string;                       // claude는 빈 문자열 가능 → CLI 디폴트
  system?: string;
  messages: ChatMessage[];             // 기존 llmNote 구조 그대로
  trailingEmptyUserTurn: boolean;
  options: {
    // Ollama
    temperature?: number;
    num_ctx?: number;
    top_p?: number;
    seed?: number;
    num_predict?: number;
    rag?: number;
    // Claude
    cwd?: string;
    allowedTools?: string[];
  };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;                     // 멀티라인 텍스트. inline 노드는
                                       // 직렬화 단계에서 다시 파싱.
}
```

### 4.5 예시

**최소 (chat-only):**

```
클로드한테 물어보기

claude://

Q: SvelteKit static adapter 쓰면 SSR 어떻게 되는지 설명해줘
```

**모델 + 시스템:**

```
코드 리뷰 어시스턴트

claude://opus
system: 너는 시니어 TypeScript 리뷰어야. 간결하게 답해.

Q: 이 코드의 race condition 짚어줘
```

**도구 활성 (cwd):**

```
Tomboy 리포 작업

claude://
cwd: /home/jh/workspace/tomboy-web
system: 한국어로 답해.

Q: app/src/lib/chatNote/ 안의 파일 구조 요약해줘
```

## 5. 전송 흐름 & 스트리밍

### 5.1 `ChatSendBar` (보내기 버튼) 분기

```ts
async function send(): Promise<void> {
  const spec = parseChatNote(editor.getJSON());
  if (!spec || sendDisabled) return;

  appendParagraph('A: ');                  // 응답 자리표시자
  editor.setEditable(false);

  try {
    if (spec.backend === 'ollama') {
      await runOllama(spec, editor, opts); // 기존 코드 그대로
    } else {
      await runClaude(spec, editor, opts); // 신규
    }
  } finally {
    editor.setEditable(true);
    appendParagraph('');
    appendParagraph('Q: ');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  }
}
```

### 5.2 Claude messages 직렬화 (`buildClaudeMessages.ts`)

Q:/A: 턴을 Anthropic API 호환 `messages` 배열로 변환한다.
**페이로드는 텍스트 + URL 문자열만**. 이미지 바이트는 보내지 않는다.

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

function buildClaudeMessages(spec: ChatNoteSpec, doc: JSONContent): AnthropicMessage[] {
  // spec.messages 는 텍스트만 — 이미지 정보를 살리려면 doc 에서 turn별
  // inline 노드를 재추출해야 한다. 헤더 종료 빈 줄 이후 단락들을 turn
  // 단위로 묶고, 각 turn의 inline 노드를 content[] 로 매핑.
  // 자세한 알고리즘:
  //   1. doc.content 에서 헤더 영역 skip (parseChatNote 의 turnStartIndex 재사용)
  //   2. Q:/A: 프리픽스로 turn 분할
  //   3. 각 turn 내부의 inline 노드 순회:
  //      - text 노드 → text 누적
  //      - tomboyUrlLink 마크 + 이미지 확장자 → 누적 text flush, image block 추가
  //      - 그 외 마크 → text 누적 (rich → plain)
  //      - hardBreak → '\n' 누적
}
```

**이미지 식별 휴리스틱**: `tomboyUrlLink` 마크가 있고 href 가
`.png|.jpg|.jpeg|.gif|.webp|.svg`(쿼리 무시) 로 끝남. 향후
`imagePreviewPlugin` 의 판정 함수를 노출해 공유하는 게 더 정확하지만
MVP는 확장자 휴리스틱으로 충분.

**왜 URL만 보내는가**: Tomboy 이미지는 `uploadImageToDropbox` 후 Dropbox
공유 링크(`?raw=1`)로 노트에 들어간다. 비밀번호/만료 없음. Anthropic API
가 이미지 source로 URL을 지원하므로 base64로 변환할 필요 없음. 페이로드는
KB 단위로 유지.

### 5.3 앱 측 `sendClaude` (`backends/claude.ts`)

```ts
interface ClaudeChatBody {
  messages: AnthropicMessage[];
  model?: string;        // spec.model 이 빈 문자열이면 생략 → CLI 디폴트
  system?: string;
  cwd?: string;          // 존재 → 도구 활성
  allowedTools?: string[];
}

export async function sendClaude(opts: {
  url: string;           // {bridgeBase}/claude/chat
  token: string;         // 앱이 갖고 있는 TERMINAL_BRIDGE_TOKEN
  body: ClaudeChatBody;
  onToken: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<{ reason: 'done' | 'abort' | 'stream_error' }> {
  // fetch SSE → 한 줄씩 파싱 → 'data: {"delta":"..."}' → onToken
  // 'done' → 정상 종료
  // 'error' → throw ClaudeChatError(kind, detail)
}
```

### 5.4 브릿지 `POST /claude/chat`

`bridge/src/claude.ts` 신규. `ocr.ts` 패턴 미러:

```ts
export async function handleClaudeChat(req, res) {
  authBearer(req, BRIDGE_SECRET);

  if (!CLAUDE_SERVICE_URL) {
    return jsonError(res, 503, 'claude_service_not_configured');
  }

  const upstream = await fetch(`${CLAUDE_SERVICE_URL}/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BRIDGE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
    signal: req.signal,
  });

  if (!upstream.ok) {
    return jsonError(res, upstream.status, await upstream.text());
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  upstream.body.pipe(res);

  req.on('close', () => upstream.body.destroy());
}
```

새 환경변수:
- `CLAUDE_SERVICE_URL` — 데스크탑 claude-service 의 LAN URL. 기본값
  없음(미설정 시 503). `OCR_SERVICE_URL` 패턴과 동일.

### 5.5 `claude-service` (데스크탑)

`claude-service/` 디렉토리, ocr-service 패턴 미러.

**`runner.ts`** — claude CLI subprocess:

```ts
import { spawn } from 'node:child_process';

export function runClaude(req: RunRequest, abort: AbortSignal): Readable {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',                        // stream-json 출력은 --verbose 필요
  ];
  if (req.model) args.push('--model', req.model);
  if (req.system) args.push('--append-system-prompt', req.system);

  if (!req.cwd) {
    args.push('--disallowedTools', '*');   // chat-only
  } else if (req.allowedTools?.length) {
    args.push('--allowedTools', req.allowedTools.join(','));
  }

  const child = spawn('claude', args, {
    cwd: req.cwd ?? process.env.HOME,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',              // 구독 강제, API키 fallback 차단
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 입력 JSONL — Anthropic 메시지 포맷
  for (const msg of req.messages) {
    child.stdin.write(JSON.stringify({ type: 'user', message: msg }) + '\n');
  }
  child.stdin.end();

  abort.addEventListener('abort', () => child.kill('SIGTERM'));

  return adaptStdoutToSse(child.stdout, child.stderr);
}
```

**`adaptStdoutToSse`** — stream-json → SSE 변환:

- `child.stdout` 를 line-by-line 파싱 (partial line 누적 버퍼)
- 각 줄은 JSON 메시지 이벤트:
  - `type === 'assistant'` 의 `content[].type === 'text'` 의 `text` 만
    추출 → `data: {"delta":"..."}\n\n`
  - `type === 'result'` (subtype) → `data: {"done":true,"reason":<subtype>}\n\n` 후 종료
  - 도구 이벤트 (`tool_use`, `tool_result`) → **MVP 무시** (stderr 로깅만)
- `child.exit(code !== 0)` 또는 파싱 실패 → `data: {"error":"..."}\n\n`

> **구현 시 검증 필요**: `--input-format stream-json` / `--output-format
> stream-json` 의 정확한 이벤트 스키마는 현재 `claude --help` 와 실측으로
> 확인. 메시지의 `type` 키와 content block 구조가 위 가정과 다르면 조정.

**`server.ts`**:

```ts
app.post('/chat', async (req, res) => {
  if (!authBearer(req)) return res.status(401).send('unauthorized');
  if (jsonSizeOf(req.body) > CLAUDE_MAX_REQUEST_BYTES) {
    return res.status(413).send('payload_too_large');
  }
  const { messages, model, system, cwd, allowedTools } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).send('messages required');
  }
  if (cwd && !(await fs.stat(cwd).catch(() => null))?.isDirectory()) {
    return res.status(400).send('cwd not a directory');
  }

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  runClaude({ messages, model, system, cwd, allowedTools }, ctrl.signal).pipe(res);
});
```

환경변수:
- `BRIDGE_SHARED_TOKEN` — 브릿지 → claude-service 인증용 (BRIDGE_SECRET 과 동일)
- `CLAUDE_SERVICE_PORT` — 기본 7842
- `CLAUDE_HOME` — OAuth 자격증명 경로 (`~/.claude`); 컨테이너 사용 시 volume mount
- `CLAUDE_MAX_REQUEST_BYTES` — 페이로드 한도 (default 2 MB)

### 5.6 배포 (Quadlet)

`claude-service/deploy/claude-service.container`:

```ini
[Container]
Image=localhost/claude-service:latest
PublishPort=127.0.0.1:7842:7842
Environment=BRIDGE_SHARED_TOKEN=…    # /etc/sysconfig/claude-service 에서 주입
Environment=CLAUDE_SERVICE_PORT=7842
Volume=%h/.claude:/root/.claude:Z    # OAuth 자격증명 mount

[Install]
WantedBy=default.target
```

**대안**: 컨테이너 대신 `systemd --user` 유닛 — claude CLI를 사용자 홈에
설치하고 user-mode 서비스로 띄움. OAuth 경로 관리가 더 단순함. MVP는
컨테이너 경로로 통일(ocr-service와 운영 패턴 일치) 권장하되, 첫 셋업에서
OAuth 영속화 문제가 있으면 user-mode로 후퇴.

### 5.7 인증 흐름 요약

```
앱 → [Bearer: TERMINAL_BRIDGE_TOKEN] → 브릿지
     브릿지 → [Bearer: BRIDGE_SECRET] → claude-service
     claude-service → [OAuth ~/.claude/credentials] → Anthropic (구독)
```

`claude login` 은 데스크탑에서 1회 수동 실행 → `~/.claude/credentials.json`
생성 → 컨테이너에 volume mount.

## 6. 에러 처리 & Abort

### 6.1 에러 분류 (`ClaudeChatError`)

```ts
export type ClaudeChatErrorKind =
  | 'unauthorized'          // 401
  | 'service_unavailable'   // 503 — CLAUDE_SERVICE_URL 미설정 또는 다운
  | 'rate_limited'          // 429 — Anthropic 구독 한도
  | 'cli_failed'            // claude exit != 0
  | 'bad_request'           // 400
  | 'payload_too_large'     // 413
  | 'upstream_error'        // 5xx
  | 'stream_error'          // SSE 중간 끊김
  | 'network';              // fetch 실패

export class ClaudeChatError extends Error {
  constructor(public kind: ClaudeChatErrorKind, public detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}
```

### 6.2 사용자 표시 (한국어, LlmChatError와 톤 통일)

| kind | 표시 |
|---|---|
| `unauthorized` | `[오류: 인증 실패 — 설정에서 브릿지 재로그인]` |
| `service_unavailable` | `[오류: 데스크탑 Claude 서비스 응답 없음]` |
| `rate_limited` | `[오류: Claude 사용량 한도 도달. 잠시 후 재시도]` |
| `cli_failed` | `[오류: claude 실행 실패 — <stderr 요약 최대 200자>]` |
| `bad_request` | `[오류: 요청 형식 오류 — <detail>]` |
| `payload_too_large` | `[오류: 노트가 너무 큼]` |
| `network` / `upstream_error` / `stream_error` | `[오류: 연결 실패. 재시도?]` |

### 6.3 Abort 전파

```
[ChatSendBar.stop()] → AbortController.abort()
   ↓ fetch signal
[브릿지 /claude/chat] → req.on('close') → upstream fetch abort
   ↓ HTTP 끊김
[claude-service /chat] → req.on('close') → ctrl.abort()
   ↓ AbortSignal
[runner.ts spawn] → child.kill('SIGTERM')
```

stop 후 노트 상태: 이미 스트림된 텍스트는 보존. `finally` 가 빈 줄 +
`Q: ` 추가.

### 6.4 부분 응답

`stream-json` 에서 `type: 'result'` 못 받고 stdout EOF → 받은 텍스트 keep,
`stream_error` 분류, 토스트로 알림 (노트 본문에 끊김 마커 안 붙임).

### 6.5 타임아웃

- claude-service: 요청당 5분(기본). 도구 모드의 장시간 작업은 V2 에서 헤더로 조정.
- 브릿지: SSE idle 10분.
- 앱: 명시적 stop / 페이지 이탈만으로 abort.

### 6.6 `cwd` 검증

claude-service가 spawn 직전 `fs.stat(cwd).isDirectory()` 만 검증. 화이트
리스트는 MVP 비범위. 신뢰 모델: "이 데스크탑은 사용자만 쓴다."

## 7. 테스트 & 검증

### 7.1 자동 테스트

**`parseChatNote`** (`app/tests/unit/chatNote/parseChatNote.test.ts`):
- 시그니처: `llm://qwen2.5`, `claude://`, `claude://opus`, 미스매치
- 헤더: 백엔드별 키, 알 수 없는 키 무시, system 다중 라인
- Q:/A: 턴: 단일, 다중, `trailingEmptyUserTurn`
- 기존 `llm://` 노트 회귀 없음

**`buildClaudeMessages`** (`app/tests/unit/chatNote/buildClaudeMessages.test.ts`):
- 텍스트만 → text block 1개
- 텍스트 + 이미지 URL 섞임 → text/image block 순서 보존
- 연속 이미지 사이 빈 text block 안 끼움
- 코드블록, 마크 → 텍스트 그대로 (rich → plain)
- `Q: ` / `A: ` 프리픽스가 content 에 미포함 (role로 표현)

**`sendClaude`** (`app/tests/unit/chatNote/sendClaude.test.ts`):
- 정상 delta stream → onToken 누적
- `done` 이벤트 → reason 'done'
- HTTP 401/503/429/413 → 해당 kind
- 중간 끊김 → stream_error
- AbortSignal → fetch abort + reason 'abort'

**`ChatSendBar`** (`app/tests/unit/editor/chatNote/ChatSendBar.test.ts`):
- 백엔드 분기: spec.backend === 'claude' → sendClaude
- 보내기 disabled gate
- 응답 스트림 → 노트 반영
- 에러 시 `[오류: ...]` + 새 `Q: `

**브릿지 `/claude/chat`** (`bridge/src/claude.test.ts`, `node:test`):
- 401 (Bearer 누락/오류)
- 503 (`CLAUDE_SERVICE_URL` 미설정)
- 200 pass-through
- 클라이언트 close → 업스트림 abort
- 페이로드 size limit

**claude-service runner** (`claude-service/tests/runner.test.ts`, vitest):
- **`FakeClaudeRunner`** — 실제 CLI 호출 없이 stream-json 시뮬레이션
  (ocr-service `FakeRunner` 패턴). CI에서 claude/구독 없이 통과.
- 정상 케이스, abort, partial line 버퍼, exit != 0
- `--disallowedTools '*'` 가 cwd 없을 때 args 에 포함
- `ANTHROPIC_API_KEY=''` env 적용

**claude-service server** (`claude-service/tests/server.test.ts`):
- POST /chat 정상 SSE
- 401, 400, 413
- AbortSignal 전파

**의도적 비범위** (자동 테스트 안 함):
- 실제 `claude` CLI spawn — 구독/네트워크 의존, CI에서 비결정적
- 실제 Anthropic API 호출 — 동일 이유

### 7.2 수동 검증

PR 머지 전:

1. **chat-only**: 새 노트 `claude://`, `Q: 간단한 질문` → `A: ...` 스트림
2. **모델 지정**: `claude://opus` → 의도된 모델로 응답
3. **도구 모드**: `cwd: /home/jh/workspace/tomboy-web` → 응답에 실제 디렉토리 정보
4. **이미지 입력**: Dropbox 이미지 URL 포함 Q → 이미지 이해한 응답
5. **Abort**: 스트림 중 중지 → 즉시 중단, 노트 형태 정상
6. **에러**: claude-service 죽인 상태 → "응답 없음" 토스트
7. **기존 `llm://` 회귀 없음**: 기존 Ollama 노트 정상 작동
8. **구독 경로 검증**: claude-service 로그에 API 키 호출 없음, OAuth 자격
   증명만 사용 확인

## 8. 보안/운영 invariants

- **`ANTHROPIC_API_KEY` 명시 clear**: subprocess가 실수로 API 키 경로로 빠지는 것 방지.
- **`cwd` 검증은 `isDirectory()` 만**: MVP는 화이트리스트 없음. 신뢰 모델은 단일 사용자 데스크탑.
- **요청당 1 subprocess**: 동시성 한도 없음 (MVP). 동시성 cap 은 V2.
- **OAuth 영속화**: `claude login` 1회 → volume mount. 자격증명 회전 시 재로그인.
- **Bearer 토큰 3단**: 앱→브릿지 / 브릿지→claude-service / OAuth (Anthropic).
- **컨테이너 vs user systemd**: ocr-service와 동일하게 컨테이너 권장. OAuth 영속화 문제 시 user systemd 로 후퇴 옵션.

## 9. 비-범위 (YAGNI)

명시적으로 **안 하는** 것:

- **세션 resume (`--resume <id>`)**: 노트가 single source of truth. 매 전송마다 transcript 재전송 (stateless).
- **도구 호출 이벤트 노트 표시**: stream-json 의 `tool_use` / `tool_result` 무시. V2 에서 인라인 marker 검토.
- **동시성 cap / 큐**: 요청당 1 subprocess, 한도 없음.
- **이미지 base64 fallback**: URL이 fetch 안 되는 케이스에 대한 base64 변환. 향후 필요시.
- **자동 모델 선택**: 시그니처/헤더 미지정 → CLI 디폴트 그대로.
- **GitHub 자동화 통합**: 별도 설계 문서.
- **사용량 추적/표시**: 토큰 카운트는 llmNote 와 동일 수준만 (응답 토큰 단순 count).
- **`cwd` 화이트리스트**: 신뢰 모델 단순화.

## 10. 후속 작업 candidates

별도 PR 또는 V2 로:

1. **도구 호출 이벤트 노트 표시**: stream-json 의 `tool_use` 를 `> 🔧 Read app/...` 같은 marker 로.
2. **동시성 cap**: claude-service 에 동시 subprocess 한도, 초과시 큐 또는 429.
3. **자동 cwd 휴리스틱**: 노트가 특정 프로젝트 노트북에 있으면 자동 cwd 적용.
4. **GitHub 자동화 진입점**: claude-service 가 외부에서 호출되는 다른 진입점(예: `/dispatch`) 추가.
5. **이미지 base64 fallback**: 비공개 URL 또는 Dropbox 외 호스팅 이미지 지원.
6. **요청 로깅/감사**: claude-service 가 요청/응답 메타 로깅 (개인정보 주의).
7. **백엔드 추가**: `openai://`, `gemini://` 등.

## 11. 영향 받는 파일/모듈 (요약)

**리네임 (이동):**
- `app/src/lib/llmNote/` → `app/src/lib/chatNote/`
- `app/src/lib/editor/llmNote/` → `app/src/lib/editor/chatNote/`
- 모든 import 경로 업데이트 (TomboyEditor.svelte, +page.svelte, NoteWindow.svelte 등)

**신규:**
- `app/src/lib/chatNote/backends/claude.ts`
- `app/src/lib/chatNote/buildClaudeMessages.ts`
- `bridge/src/claude.ts`, `bridge/src/claude.test.ts`
- `claude-service/` (디렉토리 전체)

**수정:**
- `app/src/lib/chatNote/parseChatNote.ts` — `claude://` 시그니처 + 백엔드별 헤더
- `app/src/lib/chatNote/defaults.ts` — 백엔드별 키 분리
- `app/src/lib/editor/chatNote/ChatSendBar.svelte` — 백엔드 분기
- `bridge/src/server.ts` — `/claude/chat` 라우트 등록
- `bridge/src/env.ts` (있다면) — `CLAUDE_SERVICE_URL` 추가
- `CLAUDE.md` 의 LLM 노트 섹션 — Claude 백엔드 언급 추가

**호환성:**
- 기존 `llm://` 노트: 데이터 변경 없음, 동작 변경 없음
- IDB 스키마: 변경 없음
- `.note` XML round-trip: 변경 없음 (시그니처는 평문 텍스트)
