# 관전 세션 피커 (empty `spectate:` → 세션 선택 팝업)

- **Date:** 2026-06-26
- **Status:** Approved design (pre-implementation)
- **Area:** 터미널 노트 / 관전(spectator) 모드 (`tomboy-terminal` skill)

## 배경 / 동기

관전 노트는 본문에 `spectate: <session-name>` 을 적어 타겟의 tmux 세션을 폰에서 미러한다. 문제: **세션 이름을 미리 알아야 한다.** Claude Squad 같은 도구는 에이전트마다 `claudesquad_<sanitized-title>` 형식의 생성된 세션을 만들어, 사용자가 이름을 외우거나 `tmux ls` 로 매번 확인해야 한다.

해결: 본문에 값 없는 `spectate:` 만 있으면 그 노트를 **세션 런처**로 취급한다. 버튼을 누르면 브릿지가 타겟의 tmux 세션 목록을 가져와 팝업으로 보여주고, 거기서 골라 바로 관전한다.

## 목표 / 비목표

**목표**
- 값 없는 `spectate:` 라인을 가진 노트를 피커(런처) 모드 관전 노트로 인식.
- 버튼 탭 → 브릿지가 타겟의 **전체** tmux 세션 목록 fetch → 팝업 → 선택 → 그 세션 관전.
- 선택은 **휘발(ephemeral)**: 노트 본문은 빈 `spectate:` 그대로. 열 때마다 다시 고를 수 있는 재사용 런처.
- 관전 중 "세션 변경" 으로 다른 세션으로 갈아타기.

**비목표 (v1 스코프 밖)**
- 선택 영속화(노트 본문 치환). `rewriteSpectateLine` 은 이 기능에서 호출하지 않는다.
- WOL-on-list: 세션 목록 fetch 는 평범한 ssh. 타겟이 자고 있으면 에러 토스트만. (spectate attach 자체의 기존 wake 흐름은 불변.)
- 세션 검색/필터 박스 (전체 목록이라도 수가 적어 불필요).
- claudesquad_ 전용 필터 — 일반 tmux 세션도 다 보여준다.

## 설계

### 1. 파서 — `app/src/lib/editor/terminal/parseTerminalNote.ts`

- `SPECTATE_RE` 의 캡처를 `+` → `*` 로 완화하여 값 없는 `spectate:` 도 매칭:
  `/^spectate:\s*([A-Za-z0-9_\-./@:]*)\s*$/`
- `TerminalNoteSpec` 에 `spectatePicker?: boolean` 추가.
  - 캡처가 빈 문자열 → `spectatePicker = true`, `spectate = undefined`, `pinnedPane = undefined`.
  - 캡처가 비어있지 않음 → 기존 동작(세션명 + 옵셔널 `:N` 핀) 그대로, `spectatePicker` 미설정.
- **중복 거부 유지:** 현재 두 번째 `spectate:` 라인 거부는 `spectate !== undefined` 로 판정하는데, 피커 모드는 `spectate` 가 undefined 라 이 검사를 통과해버린다. 로컬 `sawSpectate` 플래그를 추가해 라인 존재 자체로 중복을 판정한다.
- `target`/`host`/`bridge` 등 나머지 파싱은 불변.

### 2. 렌더 분기 — `app/src/lib/editor/terminal/TerminalView.svelte`

- `isSpectator = $derived(!!spec.spectate || !!spec.spectatePicker)` — 세션 선택 전에도 관전 브랜치로 진입(셸 노트로 오인 방지).
- 런타임 상태 `let selectedSession = $state<string | null>(null)`.
- `const effectiveSession = $derived(spec.spectate ?? selectedSession)` — WS connect 에 쓰는 실제 세션명.
- **WS 오픈 게이트:** 관전 WS 를 여는 시점을 `effectiveSession` 이 non-null 일 때로 게이트. 피커 노트는 세션을 고르기 전엔 WS 를 열지 않는다.
- **미선택 화면:** `spectatePicker && !selectedSession` → xterm 대신 중앙에 "세션 선택" 버튼. 헤더 라벨 "관전 — 세션 미선택".
- **세션 변경 버튼:** 피커 노트(`spec.spectatePicker`)에서만 헤더에 "세션 변경" 노출. 탭 → 피커 재오픈. 재선택 시 기존 WS 구독 teardown 후 새 `selectedSession` 으로 재연결.
- 고정 세션 노트(`spec.spectate` 있음)는 이 UI 가 전혀 나타나지 않는다 — 기존 동작 100% 불변.

### 3. 브릿지 세션 목록 — `bridge/src/sessionList.ts` (신규) + `bridge/src/server.ts`

**HTTP 엔드포인트 `POST /sessions`** (`server.ts`):
- `Authorization: Bearer <token>` 검증(`verifyToken`) + Origin 체크 — `/login` `/health` 와 동일 게이트.
- body: `{ target: { user?: string; host: string; port?: number } }`. 호출 측이 이미 `SSH_RE` 로 검증한 구조화 필드만 전달(raw 문자열 금지 — 셸 인젝션 차단).
- `sessionList.listSessions(target)` 호출 → `{ sessions: SessionInfo[] }` JSON 응답.
- 실패(ssh 도달 불가 등) → `502` + `{ error: 'unreachable' }`. tmux 서버 없음은 실패가 아니라 **빈 목록**.

**`sessionList.ts`:**
- `listSessions(target)`:
  - 로컬 타겟(`!target.user && host ∈ LOCAL_HOSTS|hostname`) → `tmux` 직접 실행. `pty.ts` 의 `isLocal` 로직 미러.
  - 원격 → `ssh [-p port] -o BatchMode=yes -o StrictHostKeyChecking=accept-new user@host -- tmux list-panes -a -F '<FMT>'`. **argv 배열로 spawn(셸 없음).**
  - `FMT = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{window_active}\t#{pane_active}\t#{pane_current_command}'`
  - stdout → `parseSessionList(stdout)`.
  - `no server running` (tmux stderr, exit≠0) → `[]`.
- `parseSessionList(stdout): SessionInfo[]` — **순수 함수** (테스트 대상):
  - 탭 분리 행 파싱. 세션명으로 dedup(첫 등장 순서 유지).
  - `windows`/`attached`/`activity` 는 세션 스코프(어느 행이든 동일).
  - `command` 은 `window_active==1 && pane_active==1` 행에서 추출(없으면 빈 문자열).
  - 필드 수 모자란/깨진 행은 스킵.
- `SessionInfo = { name: string; windows: number; attached: boolean; activity: number; command: string }`.

### 4. 클라 fetch — `app/src/lib/editor/terminal/bridgeSettings.ts`

- `fetchSessions(bridge: string, token: string, target: {user?,host,port?}): Promise<SessionInfo[]>`
  - `POST {bridge}/sessions`, `Authorization: Bearer`, JSON body.
  - 비-200 → throw(호출 측이 한글 에러 토스트). 200 → `sessions` 배열.
- `SessionInfo` 타입은 클라/브릿지 공유 형태(브릿지가 source, 클라가 미러 — 기존 토큰/타입 규약과 동일 패턴).

### 5. 피커 모달 — `TerminalView.svelte`

- 기존 "보내기" 팝업 모달 스타일 재사용(같은 오버레이/패널 CSS 패턴).
- 상태: `picking`(모달 열림), `loadingSessions`, `sessionError`, `sessions: SessionInfo[]`.
- 흐름: "세션 선택"/"세션 변경" 탭 → `picking=true` + `loadingSessions=true` → `fetchSessions` → 성공 시 목록 렌더, 실패 시 한글 에러 + 재시도 버튼.
- 행 표시: `name` · `N창` · `●붙음`/`○` · `command`. 탭 → `selectedSession = name`, 모달 닫고 (필요 시 기존 WS teardown 후) 재연결.
- 빈 목록 → "실행 중인 tmux 세션이 없습니다." 안내.

### 6. 데이터 흐름

```
[빈 spectate: 노트 열기]
  → TerminalView: spectatePicker=true, selectedSession=null
  → WS 안 염. "세션 선택" 버튼만.
[탭]
  → fetchSessions(bridge, token, target)
  → 브릿지 POST /sessions → ssh → tmux list-panes -a -F → parseSessionList
  → SessionInfo[] → 모달 렌더
[세션 행 탭]
  → selectedSession = name → effectiveSession 갱신
  → WS connect{ mode:'spectate', session: effectiveSession, ... } (기존 hub 경로)
[관전 중 "세션 변경" 탭]
  → WS teardown → 모달 재오픈 → 재선택 → 재연결
```

### 7. 에러 처리

- 브릿지 URL/토큰 없음 → 기존 관전 노트와 동일 배너("브릿지 URL 미설정"/"로그인 안 됨"). 피커 버튼은 비활성.
- ssh 도달 불가(타겟 오프/네트워크) → 모달에 "데스크탑에 연결할 수 없습니다 (꺼져 있거나 네트워크 문제)." + 재시도.
- tmux 미실행 → 빈 목록 안내(에러 아님).
- 선택 세션이 직후 사라짐(예: Claude Squad archive) → 기존 spectate attach 의 실패 경로(ssh stderr tail) 그대로 표면화. v1 에서 자동 피커 복귀는 안 함(스코프 밖).

### 8. 보안

- `/sessions` 는 `/login`/`/health` 와 동일하게 **Bearer + Origin** 게이트. 인증 없는 세션 열거 불가.
- tmux 명령은 **고정 문자열**. 가변값은 ssh 타겟의 `user`/`host`/`port` 뿐이고, 모두 `SSH_RE` 통과값 + argv 배열 전달(셸 비경유)이라 인젝션 표면 없음.
- 노출 정보 = 세션명/창수/붙음여부/활동시각/현재 명령어. 관전 자체가 이미 가능한 trust boundary(Bearer + ssh) 안이라 추가 노출 없음.

### 9. 가이드 카드 (CLAUDE.md 불변식)

- 설정 → 가이드 → **notes** 서브탭에 `<details class="guide-card">` 추가.
- 내용: 빈 `spectate:` 런처 사용법, "세션 선택"/"세션 변경" 버튼, 휘발(노트에 안 박힘) 동작, 데스크탑이 켜져 있어야 목록이 뜬다는 제약, 관련 탭(터미널 브릿지 설정) 링크.

## 테스트

**파서 — `app/tests/unit/editor/parseTerminalNote.test.ts` (추가)**
- 빈 `spectate:` → `spectatePicker===true`, `spectate===undefined`, `pinnedPane===undefined`.
- `spectate:` 후행 공백/탭 → 여전히 picker.
- 이중 `spectate:` (둘 다 빈 값 / 하나는 값) → 노트 거부(null).
- 기존 `spectate: name`, `spectate: name:3` 케이스 불변(회귀 가드).

**브릿지 — `bridge/` (`node --test`)**
- `parseSessionList(stdout)` 순수 함수:
  - 단일 세션 / 멀티 세션 / 멀티 윈도우·패널(active 행에서 command 추출) / `no server running`(빈 stdout) / 탭 필드 부족 행 스킵 / attached 0·1 → boolean.
- 엔드포인트 자체는 기존 브릿지 관례(유닛 테스트 없음)대로 로컬 스모크. ssh/tmux 호출부는 순수 파서 분리로 테스트 커버.

## 영향 파일

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/terminal/parseTerminalNote.ts` | `SPECTATE_RE` 완화, `spectatePicker` 필드, `sawSpectate` 중복가드 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | picker 분기, `selectedSession`/`effectiveSession`, WS 게이트, "세션 선택"/"세션 변경" 버튼, 피커 모달 |
| `app/src/lib/editor/terminal/bridgeSettings.ts` | `fetchSessions()`, `SessionInfo` 타입 |
| `bridge/src/sessionList.ts` (신규) | `listSessions`, `parseSessionList`, `SessionInfo` |
| `bridge/src/server.ts` | `POST /sessions` 라우트 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드(notes 탭) |
| `app/tests/unit/editor/parseTerminalNote.test.ts` | 파서 테스트 |
| `bridge/test/*` | `parseSessionList` 테스트 |

## 불변식 (구현 시 지킬 것)

- **피커는 휘발.** 노트 본문은 절대 치환하지 않는다. 고정 세션 노트(`spec.spectate`)는 코드 경로/UI 가 완전히 분리되어 기존 동작 불변.
- **고정 세션 관전 노트 동작은 0 변경.** `spectatePicker` 분기는 빈 `spectate:` 에서만 발화.
- **세션명은 사용자 입력이 아니라 tmux 출력에서만** 온다 — `send-keys`/공격 표면 없음. ssh 타겟만 노트에서 오고 SSH_RE 검증 + argv 전달.
- **`POST /sessions` 인증은 WS connect 와 동일 신뢰 경계** (Bearer + Origin). 약화 금지.
