# Spectator 패널 구독 모델 (Option C: SpectatorHub)

**Date:** 2026-05-25
**Status:** Approved, ready for implementation
**Supersedes runtime semantics of:** `docs/superpowers/specs/2026-05-24-spectator-pin-pane-design.md` (UX 메타데이터는 유지, 런타임 동작 변경)

## 목표

여러 spectator 노트가 같은 tmux 세션의 **서로 다른 패널을 동시에 라이브로** 관전할 수 있게 한다. 현재 핀 기능은 "활성 추적 + 화면 동결"이라 핀된 패널이 데스크탑 비활성이 되면 업데이트가 끊긴다. 사용자 시나리오: 한 노트에서 claude code를 돌려놓고 다른 노트에서 다른 작업을 모니터링하면서 진행 상황을 동시에 보고 싶다.

## 배경

현재 브릿지 구조 (`bridge/src/spectatorSession.ts`):
- WS 1개 = `SpectatorSession` 1개 = ssh 1개 = tmux -CC 클라이언트 1개
- `SpectatorSession.onPaneOutput`에서 `paneId !== activePaneId`면 버림 (line 258-259)
- 데스크탑이 패널 전환 → `%window-pane-changed` → 새 활성으로 추적 전환 + capture-pane 시드

핵심 발견: **tmux -CC는 세션 내 모든 패널의 `%output`을 emit한다.** 현재 코드는 그 중 active만 통과시키고 나머지를 버린다. 라이브 다중-패널 관전을 위해 필요한 것은 새 채널이 아니라 **구독 모델로의 필터 기준 변경**이다.

## 아키텍처

`SpectatorSession` 클래스를 두 컴포넌트로 분리:

### SpectatorHub (`bridge/src/spectatorHub.ts`, 신규)

모듈 레벨 싱글톤 `Map<string, SpectatorHub>`로 관리. Key 형식:
```
"<user>@<host>:<port>|<sessionName>"
```
같은 호스트의 다른 tmux 세션은 별도 hub (격리). user가 빈 문자열일 수 있음 (로컬 ssh 등).

**소유 자원** (hub 1개당)
- 1 ssh ChildProcess
- 1 TmuxControlClient
- 1 ControlMaster socket (`hub.controlPath`)
- 상태 캐시:
  - `sessionId: string | null` — bootstrap에서 채워짐
  - `windowId: string | null` — 현재 활성 윈도우
  - `activePaneId: string | null` — 현재 활성 패널 (follow-active 구독자가 추적)
  - `paneStates: Map<paneId, {cols, rows, altScreen, cursorX, cursorY, windowIndex, windowName}>`
  - `currentWindowPaneOrder: string[]` — 현재 윈도우의 paneId 목록 (ordinal 해석용)
- `subscriptions: Map<subId, SpectatorSubscription>` — 활성 구독자 목록
- `bootPromise: Promise<void>` — bootstrap 완료 신호 (후속 구독자가 await)

**메서드**
- `static subscribe(target, session, cb): SpectatorSubscription` — hub 찾거나 생성 후 구독 추가
- `selectPane(ordinal: number)` — `list-panes` 조회 후 `select-pane -t %<paneId>` 발사 (desktop 공유 작업)
- `tmuxNav(action)` — `select-pane -t <s>:.+` 등 발사
- `sendInput(text)` — `send-keys -H ...` 발사 (활성 패널에)

**라이프사이클**
- 첫 `subscribe()` → hub 신규 생성 → ssh + tmux 부트 → `bootPromise` 해결 시 모든 대기 구독자에게 초기 시드
- 후속 `subscribe()` → 기존 hub 재사용 → `bootPromise` await → 캐시된 상태로 즉시 시드
- `unsubscribe()` → refcount--; 0이 되면 즉시 hub destroy (ssh.kill + tmux.close + socket unlink + Map delete). **유예 타이머 없음.**
- ssh.on('exit') → 모든 구독자에 `exit` 콜백 fan-out, hub destroy

### SpectatorSubscription

가벼운 객체. WS 1개당 1개.

**필드**
- `mode: 'follow-active' | { pinnedOrdinal: number }`
- `subscribedPaneId: string | null` — 현재 실제로 보고 있는 paneId (mode에서 파생)
- `callbacks: SpectatorCallbacks` — 기존 인터페이스 그대로 + `paneUnavailable` 신규
- `pendingOutput: Buffer[]` + `seeding: boolean` — 시드 중 큐잉 (subscription-level)
- `decoder: TextDecoder` — UTF-8 스트리밍 디코더 (paneId 전환 시 reset)

**메서드**
- `pinOrdinal(n)` — mode = `{pinnedOrdinal: n}`; `hub.currentWindowPaneOrder[n-1]`로 해석 → 있으면 시드 요청 + subscribedPaneId 갱신, 없으면 `paneUnavailable` 콜백
- `unpin()` — mode = 'follow-active'; subscribedPaneId = `hub.activePaneId`; 시드 요청
- `close()` — hub.unsubscribe(this)

**이벤트 라우팅** (hub가 emit, subscription이 필터)
- hub의 `%output paneId bytes` 통지 → subscribedPaneId 일치하면 emit, 시드 중이면 큐잉
- hub의 `%window-pane-changed` 통지 → follow-active이면 새 active로 전환 + 시드, pinned이면 무시
- hub의 `%session-window-changed` 통지 → pinned이면 ordinal 재해석 (있으면 paneSwitch+seed, 없으면 paneUnavailable)
- hub의 `%layout-change` 통지 → 같은 윈도우면 ordinal 재해석 (pinned), paneState 갱신 (모두)

## WS 프로토콜

기존 모든 프레임 유지. **2개 신규** + **1개 의미 확장**.

### 신규 (client → bridge)

```ts
{ type: 'subscribe-pane', ordinal: number }
```
- `ordinal >= 1` → 핀 모드, subscription을 그 ordinal에 고정
- `ordinal == 0` → follow-active 모드 (핀 해제). 별도 `unsubscribe-pane` 안 둠.

### 신규 (bridge → client)

```ts
{ type: 'pane-unavailable', pinnedOrdinal: number, paneCount: number }
```
- 핀된 ordinal이 현재 윈도우의 패널 수를 초과할 때 발사
- 클라이언트는 "패널 N번 없음 (현재 윈도우 패널 M개)" 배너 표시
- 패널이 다시 생기거나 윈도우 이동으로 ordinal 유효해지면 `pane-switch` 프레임이 오면서 배너 자동 해제

### 의미 확장 (bridge → client `pane-switch`)

기존: "desktop active pane 변경" 통지.
변경 후: "이 subscription이 보고 있는 paneId가 바뀌었음" 통지.

발사 조건:
- 첫 attach 후 초기 active
- follow-active 모드에서 desktop active 변경
- 핀 모드에서 윈도우 이동으로 ordinal이 재해석되어 다른 paneId가 됨
- 핀 무효 → 유효로 전환

페이로드 (paneId, cols, rows, altScreen, windowIndex, windowName, paneOrdinal, paneCount) 변경 없음. subscription별로 다른 값.

## 클라이언트 사이드 변경

`app/src/lib/editor/terminal/TerminalView.svelte` 및 `wsClient.ts`.

### 제거 (이전 핀 구현의 잔재)

라이브 스트림이 항상 흐르므로 불필요:
- `pinDetached: boolean` 상태
- 빨간 "패널 N번 고정 — 현재 비활성" 배너 + 관련 CSS (`.banner-pin-detached`)
- `reattachIfPinned()` 헬퍼 + 모든 호출 지점 (handlePageClick, term.onData, sendPopupSubmit, sendQuickKey, sendImageFile)
- WS open 시 핀이면 `selectPane` 자동 호출 (마운트+reconnect)
- `onPaneSwitch` 분기에서 `pinDetached = true` 설정 케이스

### 추가

- 새 상태: `pinUnavailable: boolean` ($state) — `pane-unavailable` 수신 시 true, 다음 `pane-switch` 수신 시 false
- 새 배너: "패널 N번 없음 (현재 윈도우 패널 M개)" — 노란/회색 톤으로 기존 빨강과 구분
- WS open 직후 `spec.pinnedPane` 있으면 `subscribePane(N)` 송신 (현재의 `selectPane` 대신)
- 자물쇠 토글 시 `client.subscribePane(N or 0)` 송신 + 노트 본문 갱신 (`persistPinToNote`은 그대로)

### 유지

- `pinnedOrdinal` 상태 (null/숫자)
- 🔒 표시 + 파란 강조 + 핀 중 다른 버튼 disabled
- `onPaneNumClick` 분기 로직 (단순화: detach 관련 가지 제거)
- `persistPinToNote()` + `rewriteSpectateLine()`
- Ctrl+H/L 가드 (핀 중 prev/next-pane 무효)
- "노트 클릭/타이핑하면 핀 패널이 desktop active로" — `selectPane(pinnedOrdinal)` 호출만 남음 (시드 로직 없음, 이미 라이브)

### `wsClient.ts` 추가

```ts
subscribePane(ordinal: number): void
onPaneUnavailable?: (info: { pinnedOrdinal: number; paneCount: number }) => void
```

메시지 핸들러에서 `pane-unavailable` 타입 라우팅.

## 엣지 케이스

### Hub 단위 실패 (ssh 죽음, 데스크탑 재부팅)
- ssh.on('exit') → 모든 sub에 `exit(reason)` fan-out → 같은 세션 노트들 동시 끊김 (A 방식과 다른 점)
- 사용자가 재오픈하면 새 hub 생성

### Bootstrap 중 두 번째 구독
- `bootPromise` await → 부트 성공 시 둘째도 캐시로 즉시 시드
- 부트 실패 → 두 구독 모두 error 콜백, Map에서 제거

### 핀 ordinal이 현재 윈도우 패널 수 초과
- subscription의 `subscribedPaneId = null` + `paneUnavailable` 발사
- desktop 패널 추가 / 윈도우 이동으로 충족 → hub의 `%layout-change` / `%session-window-changed`가 모든 핀 sub 재해석

### 핀된 패널 자체가 닫힘
- ordinal-based이므로 닫힌 후 자동 shift (pane 2 닫힘 → 원래 pane 3이 ordinal 2)
- subscription은 새 paneId로 `pane-switch + seed` 받음
- 사용자에겐 "갑자기 다른 process 보임"이지만 ordinal 기반 동작의 자연 결과

### 한 노트가 selectPane / tmuxNav 호출
- hub 메서드 → desktop tmux 명령 → `%window-pane-changed` 등 → 모든 sub fan-out
- follow-active 따라감, pinned 무시. **의도된 동작** — desktop 상태는 본질적으로 공유.

### imageTransfer ControlMaster 공유
- hub init 시 1개 socket 생성
- `handleImageMessage`에서 subscription → hub.controlPath 조회 → 해당 socket으로 scp
- hub destroy 시 socket unlink (이미 ssh.exit 핸들러에서 처리)

### Subscription seed 중 다른 sub의 같은-pane output
- `seeding` 플래그는 **subscription-level**
- sub A가 paneX 시드 중일 때 paneX output 도착 → A의 pendingOutput에만 큐잉
- sub B(같은 paneX, 시드 완료)는 즉시 콜백 호출

## 마이그레이션

- 기존 `SpectatorSession` 클래스 **삭제** — 호환성 shim 안 둠
- `server.ts handleWs`의 `spectator: SpectatorSession | null` → `subscription: SpectatorSubscription | null` 타입 교체
- 호출 지점 (`spectator.sendInput`, `.selectPane`, `.tmuxNav`, `.close`, `.hasActivePane`) → `subscription.send*` 또는 hub 경유 등가 호출로 교체
- 기존 노트 포맷 (`spectate: main:3`) **변경 없음**
- 순수 함수 (`buildSpectatorSshArgs`, `panePosition`) → 그대로, 새 파일로 이동

### 호환성

자기-호스팅 단일 사용자 환경 가정 — 강한 호환성 보장 불필요.

- 신클라이언트 → 구브릿지: `subscribe-pane` 프레임 무시됨 (현재 unknown msg.type은 silently drop). 핀 동작 안 함, follow-active만.
- 신브릿지 → 구클라이언트: 클라이언트가 `subscribe-pane` 안 보냄 → 항상 follow-active. 핀 UX는 동작 안 함.

## 테스트 전략

### `spectatorHub.test.ts` (신규, node:test)
- `hubKey()` 순수 함수
- `subscribe()` 첫 호출 → 새 hub, ssh.spawn 호출 검증 (mock)
- `subscribe()` 두 번째 같은 key → ssh.spawn 한 번만
- bootstrap 실패 → 모든 대기 구독에 error
- 마지막 `unsubscribe()` → 즉시 ssh.kill + socket unlink
- ssh.on('exit') → 모든 sub에 exit 콜백
- `%output` → 매칭 paneId 구독자만
- `%window-pane-changed` → follow-active만 paneSwitch, pinned 무시
- `%session-window-changed` → currentWindowPaneOrder 재조회 + pinned 재해석
- `selectPane` / `tmuxNav` → tmux 명령 송신 (mock TmuxControlClient)

### `spectatorSubscription.test.ts` (또는 hub 테스트에 포함)
- `pinOrdinal(n)` 유효 → subscribedPaneId 갱신 + 시드 요청
- `pinOrdinal(n)` 무효 → paneUnavailable 콜백
- `unpin()` → follow-active, activePaneId 시드
- seed 중 같은 pane output → pendingOutput 큐잉, 시드 후 flush 순서 보장

### 마이그레이션
- `buildSpectatorSshArgs` / `panePosition` 순수 함수는 그대로 (새 위치)
- 기존 SpectatorSession 통합 시나리오는 hub+subscription 조합으로 재작성

### `server.ts` 통합 (기존 패턴)
- `mode: 'spectate'` connect → subscription 생성
- `subscribe-pane` 프레임 라우팅
- WS close → subscription.close()

### 클라이언트 사이드 (vitest, `app/tests/unit/editor/`)
- `wsClient.subscribePane(n)` → 송신 프레임 검증
- `wsClient`가 `pane-unavailable` 수신 → onPaneUnavailable 호출

### 수동 회귀 시나리오 (8개)
1. 단일 노트, follow-active: 패널 전환 따라감 (기존)
2. 단일 노트, 핀 ordinal 3: desktop 다른 패널 가도 라이브 계속
3. **다중 노트, 다른 ordinal 핀: 각 노트 독립 라이브** (핵심)
4. 다중 노트, 한 노트 종료 → 나머지 영향 없음
5. 모든 노트 종료 → ssh 즉시 cleanup (`ps aux | grep ssh`)
6. 데스크탑 슬립 후 깨어남: ssh stale → 노트들 에러 → 재오픈 정상
7. 핀 ordinal 무효 (윈도우 이동 후 패널 부족) → 배너 → 패널 다시 생기면 자동 복귀
8. 두 노트 동시 image-paste → ControlMaster 공유 socket으로 둘 다 성공

## 비목표 (Out of scope)

- **공유 -CC 클라이언트 외의 자원 최적화** (예: 데스크탑 측 패널 상태 캐싱) — YAGNI
- **다중 사용자 / 멀티 테넌트 보호** — 단일 사용자 가정
- **노트 외 다른 spectator 채널** (예: 관리 UI 라이브 뷰)
- **세션이 아닌 윈도우/패널 단위 hub 키** — sessionName이 가장 자연스러운 격리 단위

## 파일 영향

**브릿지 (Node)**
- 신규: `bridge/src/spectatorHub.ts`
- 신규: `bridge/src/spectatorHub.test.ts`
- 수정 또는 분할: `bridge/src/spectatorSession.ts` (subscription + 순수 함수만 남기거나, 통째로 hub에 흡수)
- 수정: `bridge/src/spectatorSession.test.ts` (정리)
- 수정: `bridge/src/server.ts` (handleWs)
- 영향 점검: `bridge/src/imageTransfer.ts` (hub.controlPath 경유 가능한지)

**클라이언트 (Svelte)**
- 수정: `app/src/lib/editor/terminal/TerminalView.svelte` (pinDetached/reattach 제거, subscribePane 호출 + paneUnavailable 배너)
- 수정: `app/src/lib/editor/terminal/wsClient.ts` (subscribePane 메서드 + pane-unavailable 라우팅)

**문서**
- 수정: `CLAUDE.md` tomboy-terminal 섹션 (spectator 다중-구독 모델 문단 추가, 기존 pin 문단 갱신)
- 폐기: `docs/superpowers/specs/2026-05-24-spectator-pin-pane-design.md`의 런타임 동작 부분 (이 문서가 대체)
