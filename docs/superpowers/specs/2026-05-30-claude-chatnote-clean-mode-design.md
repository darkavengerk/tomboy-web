# Claude 채팅 노트 "클린 모드" + 설정 탭 설계

- 날짜: 2026-05-30
- 상태: 설계 승인됨, 구현 계획 대기
- 관련: `채팅 노트 (llm:// + claude://)` (CLAUDE.md)

## 배경 / 문제

`claude://` 채팅 노트의 백엔드(`claude-service`)는 Anthropic Messages API가 아니라 데스크톱에 설치된 **Claude Code CLI(`claude -p`)를 서브프로세스로 spawn**한다. 이는 구독(OAuth) 인증을 재사용하기 위한 의도된 설계다 (`ANTHROPIC_API_KEY=''`로 spawn → 구독 크레덴셜 사용).

그 부작용으로, 번역 같은 단순 작업에도 **Claude Code의 "코딩 에이전트" 하네스가 통째로 적용**된다:

1. 시스템 프롬프트가 코딩 에이전트 기본 프롬프트 **위에 append**됨 (`--append-system-prompt`) → 충실한 번역기가 아니라 코딩 도우미 페르소나로 동작.
2. effort가 **전혀 제어되지 않음** → 데스크톱 CLI의 그때그때 설정(기본 high, 모델 전환 시 리셋 등)에 휘둘려 재현 불가능.
3. cwd/env/git 등 머신별 동적 컨텍스트가 프롬프트에 주입됨.
4. 도구 사용 프레이밍이 끼어듦.

지난 번역 사용 시 품질 오류가 많았던 주원인은 모델(Opus 4.8)의 한계가 아니라 위 **하네스 미스매치**로 판단된다.

## 제약 / 결정 사항

- **별도 API(Messages API) 도입은 하지 않는다.** 구독 과금을 유지하기 위해 기존 Claude Code CLI spawn 방식을 보완한다.
- **톰보이 노트는 코딩용이 아니다.** 어떤 노트도 도구 기반 코딩에 쓰지 않는다 → 코딩 하네스는 항상 순수 오버헤드.
- 따라서 **시스템 프롬프트는 항상 주입(교체)되어야** 한다. 코딩 에이전트 기본 프롬프트는 항상 제거.
- 기본 시스템 프롬프트는 **최소 클린 프롬프트**: `당신은 사용자를 돕는 어시스턴트입니다.`
- **cwd / allowedTools(도구 사용 게이트)는 제거**해서 단순화한다. 도구는 항상 off.
- **effort 기본값은 `high`** (문서상 번역·일반 대화처럼 품질 우선·비에이전트 작업의 sweet spot; `xhigh`/`max`는 장기 에이전트·도구 반복용이라 번역엔 과다사고 위험). 헤더/설정으로 언제든 변경 가능.
- 기본값(시스템 프롬프트/모델/effort)은 **설정의 Claude 탭에서 사용자가 변경**할 수 있어야 한다 → 변경 시 코드 수정 불필요. 자동 헤더는 이 값을 **미리 채워** 넣는다.
- 기본 모델은 `opus` (구독 플랜에 따라 데스크톱 기본이 Sonnet일 수 있어 번역엔 opus 명시가 안전).

### CLI 레버 (검증 완료, `claude --help`)

- `--system-prompt <prompt>` — 기본(코딩) 시스템 프롬프트를 **교체**. (현재 쓰는 `--append-system-prompt`는 *덧붙이기*)
- `--effort <level>` — `low | medium | high | xhigh | max`.
- `--exclude-dynamic-system-prompt-sections` — cwd/env/memory/git 등 머신별 섹션 제거.
- `--disallowedTools '*'` — 도구 전부 비활성.

## 데이터 흐름

```
설정(Claude 탭) ──► appSettings(IDB)
                      ├──► [자동 헤더 작성 시 미리 채움] ──► 노트 헤더
                      └──► [전송 시 헤더 비면 폴백] ──┐
                                                      ▼
노트 헤더(명시값) ──► parseChatNote ──► ChatSendBar(폴백 적용) ──► ClaudeChatBody
   ──► bridge /claude/chat ──► claude-service /chat ──► runner spawn(claude -p)
```

**값 우선순위:** 노트 헤더(명시값) > 설정 기본값 > 런너 하드코드 안전망.

설정만 바꾸면 (a) 새로 만드는 채팅 노트의 자동 헤더와 (b) 헤더가 비어 있는 기존 노트에 즉시 반영된다. 이미 헤더에 명시값이 박힌 기존 노트는 그 값을 유지한다(노트가 source of truth).

## 컴포넌트별 설계

### ① 런너 (`claude-service/src/runner.ts`) — 핵심

`RunRequest`에서 `cwd`, `allowedTools` 제거, `effort?: string` 추가.

인자 구성 변경:

```ts
const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
];
if (req.model) args.push('--model', req.model);
args.push('--system-prompt', req.system || DEFAULT_SYSTEM);   // 항상 교체
args.push('--exclude-dynamic-system-prompt-sections');        // 머신별 잡음 제거
args.push('--disallowedTools', '*');                          // 도구 항상 off
args.push('--effort', normalizeEffort(req.effort));           // 항상 명시, 기본 high
```

- `DEFAULT_SYSTEM` = `당신은 사용자를 돕는 어시스턴트입니다.` (하드코드 안전망. 정상 경로에선 바디에 값이 실려 옴)
- `normalizeEffort(v)` — `low|medium|high|xhigh|max`만 허용, 그 외/없음 → `high`.
- spawn의 `cwd: req.cwd ?? process.env.HOME` → 항상 `process.env.HOME`.
- `ANTHROPIC_API_KEY=''` 유지 (구독 OAuth).
- `--append-system-prompt` 분기 완전 제거.

### ② 서버 (`claude-service/src/server.ts`)

- `cwd` 디렉터리 존재 검증 로직 제거.
- `effort`를 `RunRequest`로 패스스루.
- 이미지 URL → base64 인라인 로직은 그대로 유지.

### ③ 브리지 (`bridge/src/claude.ts`)

- 바디 검증에서 `cwd`/`allowedTools` 참조 제거, `effort`(문자열, 선택) 통과.
- 순수 프록시 동작/토큰 검증/disconnect-abort는 유지.

### ④ 파서 (`app/src/lib/chatNote/parseChatNote.ts`)

- `CLAUDE_HEADER_KEY_RE`: `^(system|model|cwd|allowedTools):` → `^(system|model|effort):`.
- `CLAUDE_RECOGNIZED_HEADER_KEYS`: `cwd`, `allowedTools` 제거, `effort` 추가.
- `ChatNoteSpec.options`: `cwd`, `allowedTools` 제거, `effort?: string` 추가 (effort는 claude 전용; ollama는 무시).
- claude 분기 파싱: `effort` 값 trim 후 유효(`low|medium|high|xhigh|max`)하면 `options.effort`에 저장, 아니면 미설정.
- **하위호환:** 기존 노트의 `cwd:`/`allowedTools:` 줄은 더 이상 헤더 키로 매칭되지 않아 조용히 무시됨(기존 "cross-backend 헤더 무시" 정책과 동일) → 노트가 깨지지 않음.

### ⑤ 기본값 상수 (`app/src/lib/chatNote/defaults.ts`)

```ts
export const CLAUDE_HEADER_DEFAULTS = {
  system: '당신은 사용자를 돕는 어시스턴트입니다.',
  model: 'opus',
  effort: 'high',
} as const;
```

설정값이 로드되기 전이나 미설정 시의 폴백. 자동 헤더/전송 폴백/런너 안전망의 공통 기준.

### ⑥ 백엔드 클라이언트 (`app/src/lib/chatNote/backends/claude.ts`)

`ClaudeChatBody`: `cwd`, `allowedTools` 제거, `effort?: string` 추가.

### ⑦ 전송 (`app/src/lib/editor/chatNote/ChatSendBar.svelte`)

`runClaude`에서 바디 구성 시 설정 기본값으로 폴백:

```ts
const d = await loadClaudeDefaults(); // appSettings에서 1회 로드
const body: ClaudeChatBody = {
  messages,
  model: spec.model || d.model || undefined,
  system: spec.system ?? d.system,
  effort: spec.options.effort ?? d.effort,
};
```

`cwd`/`allowedTools` 전달 제거.

### ⑧ 자동 헤더 플러그인 (`app/src/lib/editor/chatNote/chatNotePlugin.ts`)

- 현재 deprecated `LLM_SIGNATURE_RE` 기반 + Ollama 전용 → **claude 시그니처도 처리**하도록 확장.
- `createChatNotePlugin`에 `autoWeekday` 패턴처럼 클로저 주입:
  `createChatNotePlugin({ claudeDefaults: () => ({ system, model, effort }) })`.
- claude 시그니처 등장 시 누락 헤더 자동 삽입 (값 미리 채움):

  ```
  claude://
  system: <설정 기본 시스템 프롬프트>
  model: <설정 기본 모델>
  effort: <설정 기본 effort>

  Q: 
  ```

- 기존 Ollama 자동 헤더 동작은 유지.

### ⑨ 에디터 통합 (`app/src/lib/editor/TomboyEditor.svelte`)

- onMount에 `getClaudeDefault*` 로드 → 로컬 `$state`.
- `createChatNotePlugin`에 `claudeDefaults: () => (...)` 클로저 전달 (`autoWeekday`의 `enabled: () => ...` 패턴과 동일).

### ⑩ 설정 스토어 (`app/src/lib/storage/appSettings.ts`)

`imageStorageToken` 패턴 그대로 키 3개 추가:

```ts
const CLAUDE_DEFAULT_SYSTEM = 'claudeDefaultSystem';
const CLAUDE_DEFAULT_MODEL  = 'claudeDefaultModel';
const CLAUDE_DEFAULT_EFFORT = 'claudeDefaultEffort';

getClaudeDefaultSystem(): Promise<string>  // 미설정 시 CLAUDE_HEADER_DEFAULTS.system
setClaudeDefaultSystem(v)
getClaudeDefaultModel(): Promise<string>   // 미설정 시 'opus'
setClaudeDefaultModel(v)
getClaudeDefaultEffort(): Promise<string>  // 미설정 시 'high', 유효값만
setClaudeDefaultEffort(v)
```

### ⑪ 설정 UI (`app/src/routes/settings/+page.svelte`)

- 탭 배열에 `{ id: 'claude', label: 'Claude' }` 추가 (`Tab` 유니온 타입에도 `'claude'` 추가).
- `{:else if activeTab === 'claude'}` 블록에 3개 필드 (기존 `imageStorageToken` 마크업 패턴 재사용):
  - 기본 시스템 프롬프트 — `textarea`
  - 기본 모델 — text input (placeholder `opus`)
  - 기본 effort — `select` (low/medium/high/xhigh/max)
- 각 필드: onMount 로드 → 로컬 `$state` 바인딩 → 저장 버튼(저장 시 trim, "저장됨" 1.5s 표시).
- 안내문: 이 값들은 새 채팅 노트의 헤더에 자동 입력되며, 헤더가 비면 전송 시 폴백으로 쓰인다고 명시.

## 에러 처리 / 엣지 케이스

- effort 유효성: 잘못된 값은 파서·런너·설정 게터 모두 `high`로 폴백 (`normalizeEffort` 공유 로직).
- system 빈 문자열: 런너는 항상 `--system-prompt`에 최소 1개 값(설정값→하드코드)을 넣어 코딩 기본 프롬프트로 떨어지지 않게 보장.
- 기존 `cwd:`/`allowedTools:` 헤더가 있는 노트: 무시되어 클린 모드로 동작 (의도된 동작, 노트 보존).
- 자동 헤더는 시그니처가 새로 등장할 때 1회만 동작 (기존 plugin 동작 유지). 이후 설정 변경은 새 노트에만 반영.

## 테스트 계획

- `claude-service` `runner.test.ts`:
  - 항상 `--system-prompt` (값 = 바디 system, 없으면 기본) 포함.
  - 항상 `--exclude-dynamic-system-prompt-sections` 포함.
  - 항상 `--disallowedTools *` 포함 (cwd 분기 테스트 삭제).
  - `--effort`: 바디값 반영, 없으면 `high`, 잘못된 값이면 `high`.
  - `ANTHROPIC_API_KEY=''` 유지 확인.
- `parseChatNote` 단위 테스트: `effort` 파싱, 잘못된 effort 무시, `cwd`/`allowedTools` 줄 무시.
- `chatNotePlugin` 테스트: claude 시그니처 입력 시 system/model/effort + 빈 줄 + `Q:` 자동 삽입, 설정 클로저 값 반영.
- 수동 검증: `npm run dev` → 새 `claude://` 노트 생성 시 헤더 자동 채움 확인, 설정 Claude 탭 변경 후 새 노트에 반영 확인, 실제 번역 품질 A/B(기존 대비).

## 문서

- `CLAUDE.md`의 **채팅 노트 (`llm://` + `claude://`)** 섹션 갱신:
  - claude 헤더 목록: `system` / `model` / `effort` (cwd/allowedTools 삭제).
  - "Tool-enable gate = presence of `cwd:`" 불변식 삭제 → "claude 백엔드는 항상 클린 모드: 시스템 프롬프트 교체 + 도구 off + 머신별 섹션 제거 + effort 명시" 로 교체.
  - 기본값은 설정 Claude 탭에서 변경 가능함을 명시.

## 범위 밖 (YAGNI)

- Messages API 직접 호출 백엔드 (`claude-api://` 등) — 의도적으로 제외.
- 기존 노트의 effort/system 헤더 일괄 마이그레이션 — 불필요(헤더 없으면 설정 폴백).
- 설정 변경을 이미 열려 있는 노트에 실시간 재주입 — 불필요.
