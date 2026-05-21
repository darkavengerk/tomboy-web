# 관전 모드 스크롤백 시드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관전 모드 시드에 데스크탑 tmux 페인의 스크롤백 최근 1000줄을 포함시켜, 모바일 관전 화면에서 과거 출력을 스크롤해 볼 수 있게 한다.

**Architecture:** 브릿지 `SpectatorSession.activateAndSeed`가 발행하는 `capture-pane` 명령에 `-S -1000` 옵션을 추가한다. 시드는 부트스트랩·페인 전환·재연결 시 모두 이 한 경로(`activateAndSeed`)를 타므로 자동으로 적용된다. WS 프로토콜·클라이언트 렌더 경로는 변경하지 않는다.

**Tech Stack:** TypeScript, Node.js, tmux control mode (`tmux -CC`), WebSocket.

선행 설계 문서: `docs/superpowers/specs/2026-05-21-spectator-scrollback-seed-design.md`

---

## File Structure

- **Modify:** `bridge/src/spectatorSession.ts` — 모듈 상수 `SCROLLBACK_SEED_LINES` 추가, `activateAndSeed` 안의 `capture-pane` 명령에 `-S -${SCROLLBACK_SEED_LINES}` 추가.

다른 파일은 변경하지 않는다(클라이언트 xterm `scrollback`은 기존 5000 유지 — 캡처 한도 1000 ≤ 5000 조건 충족).

---

### Task 1: 시드 `capture-pane` 에 스크롤백 범위 추가

**Goal:** `SpectatorSession.activateAndSeed`의 `capture-pane` 명령이 스크롤백 최근 1000줄을 함께 캡처하도록 `-S` 옵션을 추가한다.

**Files:**
- Modify: `bridge/src/spectatorSession.ts` (상수 추가 — `SWITCH_DEBOUNCE_MS` 블록 근처 line 53 이후; `capture-pane` 명령 — `activateAndSeed` 안 line 319)

**Acceptance Criteria:**
- [ ] `SCROLLBACK_SEED_LINES = 1000` 모듈 상수가 추가됨
- [ ] `activateAndSeed`의 `capture-pane` 명령이 `capture-pane -epJ -S -1000 -t <pane>` 형태로 발행됨
- [ ] `npm run build` (`tsc -p .`) 성공 — 타입 에러 없음
- [ ] `npm run test` 기존 테스트(`gpu.test.ts`, `ocr.test.ts`, `tmuxControlClient.test.ts`) 전부 통과 — 회귀 없음
- [ ] 수동 스모크: 관전 노트 접속 시 모바일에서 데스크탑 페인의 과거 출력(최대 ~1000줄)을 터치 스크롤로 열람 가능
- [ ] 수동 스모크: 데스크탑 페인 전환 / 모바일 재연결 시 새 페인·최신 스크롤백이 다시 시드됨
- [ ] 수동 스모크: alt-screen 앱(claude code, vim 등) 페인 / 커서 위치 / `transform: scale` 폭맞춤 — 회귀 없음

**Verify:** `cd bridge && npm run build && npm run test` → tsc 성공 + 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 현재 코드 확인**

`bridge/src/spectatorSession.ts`의 두 지점을 읽는다.

상수 영역 (line 49-55):

```ts
/**
 * Debounce window for pane-focus changes. If the user rapidly cycles through
 * panes A→B→C, we only seed the final one — avoids screen flicker.
 */
const SWITCH_DEBOUNCE_MS = 100;

const SAFE_SESSION_RE = /^[A-Za-z0-9_\-./@:]+$/;
```

`activateAndSeed` 안의 capture (line 318-323):

```ts
		try {
			const captured = await this.tmux.command(`capture-pane -epJ -t ${paneId}`);
			seed += captured.join('\r\n');
		} catch (err) {
			this.cb.error(`capture-pane: ${(err as Error).message}`);
		}
```

- [ ] **Step 2: `SCROLLBACK_SEED_LINES` 상수 추가**

`SWITCH_DEBOUNCE_MS` 선언 바로 다음, `SAFE_SESSION_RE` 앞에 상수를 추가한다.

`old_string`:

```ts
const SWITCH_DEBOUNCE_MS = 100;

const SAFE_SESSION_RE = /^[A-Za-z0-9_\-./@:]+$/;
```

`new_string`:

```ts
const SWITCH_DEBOUNCE_MS = 100;

/**
 * Scrollback lines to include in the pane seed. `capture-pane -S -<N>` is a
 * read-only query — it never alters the desktop pane's history buffer, and
 * tmux clamps to whatever history it actually holds. Keep ≤ the client
 * xterm's `scrollback` option (currently 5000) so the seed isn't truncated
 * on arrival.
 */
const SCROLLBACK_SEED_LINES = 1000;

const SAFE_SESSION_RE = /^[A-Za-z0-9_\-./@:]+$/;
```

- [ ] **Step 3: `capture-pane` 명령에 `-S` 추가**

`activateAndSeed` 안의 `capture-pane` 명령을 수정한다.

`old_string`:

```ts
			const captured = await this.tmux.command(`capture-pane -epJ -t ${paneId}`);
```

`new_string`:

```ts
			const captured = await this.tmux.command(
				`capture-pane -epJ -S -${SCROLLBACK_SEED_LINES} -t ${paneId}`
			);
```

`-S -1000` 의 `-1000` 은 `-S` 의 인자(스크롤백으로 1000줄 거슬러 시작)다. 캡처 결과는 `history(최대 1000줄) + visible` 이고, visible 은 여전히 마지막 `pane_height` 줄이므로 그 뒤의 커서 위치 계산(`seed += \x1b[${cursorY+1};${cursorX+1}H`)은 수정 불필요.

- [ ] **Step 4: 빌드**

Run: `cd bridge && npm run build`
Expected: `tsc -p .` 성공, 출력 에러 없음 (`dist/` 갱신).

- [ ] **Step 5: 기존 테스트 회귀 확인**

Run: `cd bridge && npm run test`
Expected: `gpu.test.ts`, `ocr.test.ts`, `tmuxControlClient.test.ts` 의 모든 테스트 PASS. 실패 0건.

- [ ] **Step 6: 수동 스모크 테스트**

dev 브릿지를 띄운다:

```bash
cd bridge
BRIDGE_PASSWORD=test BRIDGE_SECRET=$(openssl rand -hex 16) \
BRIDGE_ALLOWED_ORIGIN=http://localhost:5173 npm run dev
```

앱 dev 서버(`cd app && npm run dev`)에서 `spectate:` 메타데이터가 있는 관전 노트를 열고 검증한다:

1. 관전 노트 접속 → 모바일 화면에서 데스크탑 페인의 과거 출력(최대 ~1000줄)을 터치로 위로 스크롤해 볼 수 있다.
2. 데스크탑에서 페인/윈도우를 전환 → 새 페인의 스크롤백이 다시 시드된다.
3. 모바일에서 노트를 닫았다 다시 연다(재연결) → 스크롤백이 다시 시드된다.
4. alt-screen 앱(claude code, vim) 페인에서 — 화면이 깨지지 않고 커서 위치 정상, `transform: scale` 폭맞춤 정상.

- [ ] **Step 7: 커밋**

```bash
git add bridge/src/spectatorSession.ts
git commit -m "feat(spectator): 시드에 스크롤백 1000줄 포함 — 모바일 과거 출력 열람"
```
