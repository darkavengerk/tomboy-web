# 관전 모드 패널 선택기 확장 + 활성 패널 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 노트 관전 모드 푸터의 패널 점프 버튼을 `1~4` → `1~5`로 확장하고, 현재 관전 중인 패널의 버튼을 액센트 색으로 하이라이트하며, 윈도우의 패널 개수를 넘는 버튼은 비활성화한다.

**Architecture:** 브릿지가 `pane-switch` WS 프레임에 활성 패널의 순번(`paneOrdinal`)과 전체 개수(`paneCount`)를 추가한다. 순번은 `list-panes -F '#{pane_id}'` 상의 1-based 위치로, 푸터 버튼이 `selectPane`으로 패널을 푸는 방식과 동일해 버튼 번호 ↔ 하이라이트가 항상 일치한다. WS 클라이언트는 두 필드를 그대로 전달하고, `TerminalView`가 버튼 렌더링·하이라이트·비활성화에 사용한다.

**Tech Stack:** TypeScript, Node.js (term-bridge — `node:test`), SvelteKit / Svelte 5 runes, xterm.js, vitest.

설계 문서: `docs/superpowers/specs/2026-05-23-spectator-pane-picker-design.md`

## Prerequisites

이 워크트리에는 `node_modules`가 없다. 각 태스크의 Step 1이 해당 디렉터리
(`bridge/` 또는 `app/`)에 의존성이 없으면 설치한다 — 멱등이라 반복 실행해도
안전하다. `app`의 첫 `npm install`은 수 분 걸릴 수 있다.

`server.ts`는 수정하지 않는다: `bridge/src/server.ts:334`의
`paneSwitch: (info) => send({ type: 'pane-switch', ...info })`가 `info`를 그대로
스프레드하므로, 콜백 인자에 `paneOrdinal`·`paneCount`가 들어가면 WS 프레임에
자동 포함된다.

---

### Task 1: 브릿지 — 활성 패널 순번/개수 계산 + pane-switch 프레임에 추가

**Goal:** `spectatorSession`이 패널 전환·부트스트랩 시 활성 패널의 1-based 순번과 윈도우 패널 개수를 계산해 `pane-switch` 콜백에 싣는다.

**Files:**
- Modify: `bridge/src/spectatorSession.ts` — `panePosition` export 추가(파일 끝), `SpectatorCallbacks.paneSwitch` 인자 타입에 `paneOrdinal`/`paneCount` 추가(L29-36), `activateAndSeed` 쿼리부 재작성(L299-348)
- Create: `bridge/src/spectatorSession.test.ts` — `panePosition` 단위 테스트(`node:test`)

**Acceptance Criteria:**
- [ ] `panePosition(paneIds, activePaneId)`가 `{ ordinal, count }`를 반환 — `ordinal`은 `indexOf(activePaneId)+1`(없으면 `0`), `count`는 `paneIds.length`
- [ ] `SpectatorCallbacks.paneSwitch` 인자 타입에 `paneOrdinal: number`, `paneCount: number` 포함
- [ ] `activateAndSeed`가 `list-panes -t <session> -F '#{pane_id}'`를 조회해 `paneOrdinal`/`paneCount`를 계산하고 `cb.paneSwitch`에 전달
- [ ] `list-panes` 조회 실패 시 `paneOrdinal=0`, `paneCount=0`으로 두고 패널 전환·시드는 정상 진행
- [ ] `cd bridge && npm test` 전체 통과(신규 테스트 포함), `cd bridge && npx tsc -p . --noEmit` 오류 0건

**Verify:** `cd bridge && npm test` → 신규 `spectatorSession.test.ts` 포함 전체 PASS

**Steps:**

- [ ] **Step 1: 브릿지 의존성 확인/설치**

Run: `cd bridge && [ -d node_modules ] || npm install`
Expected: `node_modules`가 존재하게 됨(이미 있으면 무동작).

- [ ] **Step 2: `panePosition` 실패 테스트 작성**

Create `bridge/src/spectatorSession.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panePosition } from './spectatorSession.js';

test('panePosition: active pane is the 2nd of 4', () => {
	const r = panePosition(['%1', '%2', '%3', '%4'], '%2');
	assert.deepEqual(r, { ordinal: 2, count: 4 });
});

test('panePosition: active pane id absent → ordinal 0, count kept', () => {
	const r = panePosition(['%1', '%2'], '%9');
	assert.deepEqual(r, { ordinal: 0, count: 2 });
});

test('panePosition: empty pane list → ordinal 0, count 0', () => {
	const r = panePosition([], '%1');
	assert.deepEqual(r, { ordinal: 0, count: 0 });
});

test('panePosition: first pane → ordinal 1', () => {
	const r = panePosition(['%7', '%8'], '%7');
	assert.deepEqual(r, { ordinal: 1, count: 2 });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `panePosition` is not exported from `./spectatorSession.js`.

- [ ] **Step 4: `panePosition` 구현**

`bridge/src/spectatorSession.ts` 파일 **맨 끝**(마지막 `}` 다음, 새 줄)에 추가:

```ts

/**
 * Active pane's 1-based position among the window's panes, plus the total
 * count. Position is the index in `list-panes -F '#{pane_id}'` order — the
 * same ordering `SpectatorSession.selectPane()` resolves footer-button
 * numbers against, so a highlighted button always matches the button that
 * would re-select it. Ordinal is 0 when the active pane id is not in the list.
 */
export function panePosition(
	paneIds: string[],
	activePaneId: string
): { ordinal: number; count: number } {
	return { ordinal: paneIds.indexOf(activePaneId) + 1, count: paneIds.length };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS — `spectatorSession.test.ts`의 4개 테스트 모두 통과.

- [ ] **Step 6: `paneSwitch` 콜백 인자 타입 확장**

`bridge/src/spectatorSession.ts`에서 다음 블록(L28-42 부근)을 찾는다:

```ts
export interface SpectatorCallbacks {
	paneSwitch(info: {
		paneId: string;
		cols: number;
		rows: number;
		altScreen: boolean;
		windowIndex: string;
		windowName: string;
	}): void;
```

다음으로 교체한다:

```ts
export interface SpectatorCallbacks {
	paneSwitch(info: {
		paneId: string;
		cols: number;
		rows: number;
		altScreen: boolean;
		windowIndex: string;
		windowName: string;
		/** Active pane's 1-based footer-button ordinal; 0 = unknown. */
		paneOrdinal: number;
		/** Total panes in the spectated window; 0 = unknown. */
		paneCount: number;
	}): void;
```

- [ ] **Step 7: `activateAndSeed` 쿼리부 재작성**

`bridge/src/spectatorSession.ts`에서 `activateAndSeed`의 본문 중 다음 구간을
찾는다 (`this.decoder = ...` 다음 줄부터 `this.cb.data(seed);` 직전까지):

```ts
		this.cb.paneSwitch({ paneId, cols, rows, altScreen, windowIndex, windowName });

		// Build seed: reset → optional alt-screen → captured content → cursor.
		// '\x1bc' (RIS) clears scrollback + resets all attributes/modes.
		// '\x1b[?1049l' first to exit alt-screen if we were left in one.
		let seed = '\x1b[?1049l\x1bc';
		if (altScreen) seed += '\x1b[?1049h';

		try {
			const captured = await this.tmux.command(
				`capture-pane -epJ -S -${SCROLLBACK_SEED_LINES} -t ${paneId}`
			);
			seed += captured.join('\r\n');
		} catch (err) {
			this.cb.error(`capture-pane: ${(err as Error).message}`);
		}

		// Cursor positioning: CSI row;col H is 1-indexed; tmux reports 0-indexed.
		if (Number.isFinite(cursorY) && Number.isFinite(cursorX)) {
			seed += `\x1b[${cursorY + 1};${cursorX + 1}H`;
		}
```

다음으로 교체한다:

```ts
		// Kick off both tmux queries up front so they pipeline on the control
		// channel (command() is FIFO-safe — see tmuxControlClient). list-panes
		// gives the active pane's footer-button ordinal; capture-pane gives the
		// seed. Each promise swallows its own failure so a transient query
		// error degrades gracefully instead of aborting the pane switch.
		const panesPromise = this.tmux
			.command(`list-panes -t ${this.sessionName} -F '#{pane_id}'`)
			.catch(() => [] as string[]);
		const capturePromise = this.tmux
			.command(`capture-pane -epJ -S -${SCROLLBACK_SEED_LINES} -t ${paneId}`)
			.catch((err) => {
				this.cb.error(`capture-pane: ${(err as Error).message}`);
				return [] as string[];
			});

		const paneIds = (await panesPromise).map((l) => l.trim());
		const { ordinal: paneOrdinal, count: paneCount } = panePosition(paneIds, paneId);

		this.cb.paneSwitch({
			paneId,
			cols,
			rows,
			altScreen,
			windowIndex,
			windowName,
			paneOrdinal,
			paneCount
		});

		// Build seed: reset → optional alt-screen → captured content → cursor.
		// '\x1bc' (RIS) clears scrollback + resets all attributes/modes.
		// '\x1b[?1049l' first to exit alt-screen if we were left in one.
		let seed = '\x1b[?1049l\x1bc';
		if (altScreen) seed += '\x1b[?1049h';
		seed += (await capturePromise).join('\r\n');

		// Cursor positioning: CSI row;col H is 1-indexed; tmux reports 0-indexed.
		if (Number.isFinite(cursorY) && Number.isFinite(cursorX)) {
			seed += `\x1b[${cursorY + 1};${cursorX + 1}H`;
		}
```

주의: `panePosition`은 같은 파일 끝에 정의돼 있으므로 별도 import 불필요.
`this.sessionName`은 `selectPane`에서도 쓰는 기존 필드다.

- [ ] **Step 8: 타입체크 + 전체 테스트**

Run: `cd bridge && npx tsc -p . --noEmit && npm test`
Expected: tsc 오류 0건; `npm test` 전체 PASS (`tmuxControlClient.test.ts`,
`spectatorSession.test.ts` 등).

- [ ] **Step 9: 커밋**

```bash
git add bridge/src/spectatorSession.ts bridge/src/spectatorSession.test.ts
git commit -m "$(cat <<'EOF'
feat(spectator): 브릿지가 pane-switch 프레임에 활성 패널 순번·개수 전송

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: wsClient — pane-switch 프레임에서 paneOrdinal/paneCount 전달

**Goal:** `TerminalWsClient`가 `pane-switch` 프레임의 `paneOrdinal`·`paneCount`를 파싱해 `onPaneSwitch` 콜백으로 넘긴다. 필드가 없으면(구버전 브릿지) `0`.

**Files:**
- Modify: `app/src/lib/editor/terminal/wsClient.ts` — `PaneSwitchInfo`(L3-10), `ServerMsg`(L32-43), `pane-switch` 핸들러(L132-147)
- Create: `app/tests/unit/editor/wsClientPaneSwitch.test.ts` — vitest 단위 테스트

**Acceptance Criteria:**
- [ ] `PaneSwitchInfo`에 `paneOrdinal: number`, `paneCount: number` 추가
- [ ] `ServerMsg`에 `paneOrdinal?: number`, `paneCount?: number` 추가
- [ ] `pane-switch` 핸들러가 두 값을 `onPaneSwitch`로 전달하고, 값이 없거나 number가 아니면 `0`으로 기본 처리
- [ ] 신규 테스트 2건 통과, `cd app && npm run check` 신규 오류 0건

**Verify:** `cd app && npm run test -- wsClientPaneSwitch` → 2 PASS; 이어서 `npm run check`

**Steps:**

- [ ] **Step 1: 앱 의존성 확인/설치**

Run: `cd app && [ -d node_modules ] || npm install`
Expected: `node_modules`가 존재하게 됨(이미 있으면 무동작).

- [ ] **Step 2: 실패 테스트 작성**

Create `app/tests/unit/editor/wsClientPaneSwitch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';
import type { PaneSwitchInfo } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: (ev: { data: string }) => void;
	onclose?: () => void;
	onerror?: () => void;
}

describe('TerminalWsClient pane-switch parsing', () => {
	let fake: FakeState;
	let switches: PaneSwitchInfo[];

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() { return fake.readyState; }
			send(s: string) { fake.sent.push(s); }
			close() {}
			set onopen(fn: (() => void) | undefined) { fake.onopen = fn; }
			set onmessage(fn: ((ev: { data: string }) => void) | undefined) { fake.onmessage = fn; }
			set onclose(fn: (() => void) | undefined) { fake.onclose = fn; }
			set onerror(fn: (() => void) | undefined) { fake.onerror = fn; }
			static OPEN = 1;
		};

		switches = [];
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://you@desktop',
			token: 't',
			cols: 80,
			rows: 24,
			spectate: 'main',
			onData: () => {},
			onStatus: () => {},
			onPaneSwitch: (info) => switches.push(info)
		});
		client.connect();
		fake.onopen?.();
	});

	it('forwards paneOrdinal and paneCount from the frame', () => {
		fake.onmessage?.({
			data: JSON.stringify({
				type: 'pane-switch',
				paneId: '%3',
				cols: 80,
				rows: 24,
				altScreen: false,
				windowIndex: '1',
				windowName: 'main',
				paneOrdinal: 2,
				paneCount: 4
			})
		});
		expect(switches).toHaveLength(1);
		expect(switches[0].paneOrdinal).toBe(2);
		expect(switches[0].paneCount).toBe(4);
	});

	it('defaults paneOrdinal/paneCount to 0 when the frame omits them', () => {
		fake.onmessage?.({
			data: JSON.stringify({
				type: 'pane-switch',
				paneId: '%3',
				cols: 80,
				rows: 24,
				altScreen: false,
				windowIndex: '1',
				windowName: 'main'
			})
		});
		expect(switches).toHaveLength(1);
		expect(switches[0].paneOrdinal).toBe(0);
		expect(switches[0].paneCount).toBe(0);
	});
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd app && npm run test -- wsClientPaneSwitch`
Expected: FAIL — `paneOrdinal`/`paneCount`가 `PaneSwitchInfo`에 없어 타입
오류, 또는 런타임에서 `undefined`.

- [ ] **Step 4: `PaneSwitchInfo` 확장**

`app/src/lib/editor/terminal/wsClient.ts`에서 다음 블록(L3-10)을 찾는다:

```ts
export interface PaneSwitchInfo {
	paneId: string;
	cols: number;
	rows: number;
	altScreen: boolean;
	windowIndex: string;
	windowName: string;
}
```

다음으로 교체한다:

```ts
export interface PaneSwitchInfo {
	paneId: string;
	cols: number;
	rows: number;
	altScreen: boolean;
	windowIndex: string;
	windowName: string;
	/** Active pane's 1-based footer-button ordinal; 0 when unknown. */
	paneOrdinal: number;
	/** Total panes in the spectated window; 0 when unknown. */
	paneCount: number;
}
```

- [ ] **Step 5: `ServerMsg` 확장**

같은 파일에서 다음 블록(L32-43)을 찾는다:

```ts
interface ServerMsg {
	type: 'data' | 'exit' | 'error' | 'ready' | 'pane-switch' | 'pane-resize';
	d?: string;
	code?: number;
	message?: string;
	paneId?: string;
	cols?: number;
	rows?: number;
	altScreen?: boolean;
	windowIndex?: string;
	windowName?: string;
}
```

다음으로 교체한다:

```ts
interface ServerMsg {
	type: 'data' | 'exit' | 'error' | 'ready' | 'pane-switch' | 'pane-resize';
	d?: string;
	code?: number;
	message?: string;
	paneId?: string;
	cols?: number;
	rows?: number;
	altScreen?: boolean;
	windowIndex?: string;
	windowName?: string;
	paneOrdinal?: number;
	paneCount?: number;
}
```

- [ ] **Step 6: `pane-switch` 핸들러 확장**

같은 파일에서 다음 블록(L132-147)을 찾는다:

```ts
			} else if (msg.type === 'pane-switch') {
				if (
					this.opts.onPaneSwitch &&
					typeof msg.paneId === 'string' &&
					typeof msg.cols === 'number' &&
					typeof msg.rows === 'number'
				) {
					this.opts.onPaneSwitch({
						paneId: msg.paneId,
						cols: msg.cols,
						rows: msg.rows,
						altScreen: !!msg.altScreen,
						windowIndex: typeof msg.windowIndex === 'string' ? msg.windowIndex : '',
						windowName: typeof msg.windowName === 'string' ? msg.windowName : ''
					});
				}
			} else if (msg.type === 'pane-resize') {
```

다음으로 교체한다:

```ts
			} else if (msg.type === 'pane-switch') {
				if (
					this.opts.onPaneSwitch &&
					typeof msg.paneId === 'string' &&
					typeof msg.cols === 'number' &&
					typeof msg.rows === 'number'
				) {
					this.opts.onPaneSwitch({
						paneId: msg.paneId,
						cols: msg.cols,
						rows: msg.rows,
						altScreen: !!msg.altScreen,
						windowIndex: typeof msg.windowIndex === 'string' ? msg.windowIndex : '',
						windowName: typeof msg.windowName === 'string' ? msg.windowName : '',
						paneOrdinal: typeof msg.paneOrdinal === 'number' ? msg.paneOrdinal : 0,
						paneCount: typeof msg.paneCount === 'number' ? msg.paneCount : 0
					});
				}
			} else if (msg.type === 'pane-resize') {
```

- [ ] **Step 7: 테스트 통과 + 타입체크**

Run: `cd app && npm run test -- wsClientPaneSwitch && npm run check`
Expected: 신규 테스트 2건 PASS; `npm run check` 신규 오류 0건.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/editor/terminal/wsClient.ts app/tests/unit/editor/wsClientPaneSwitch.test.ts
git commit -m "$(cat <<'EOF'
feat(spectator): wsClient가 pane-switch의 paneOrdinal·paneCount 전달

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: TerminalView — 패널 버튼 5개 + 활성 하이라이트 + 개수 비활성화

**Goal:** 관전 푸터가 5개 패널 버튼을 렌더링하고, 활성 패널 버튼을 액센트 색으로 하이라이트하며, 윈도우 패널 개수를 넘는 버튼을 dim + 클릭 비활성화한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` — `$state` 2개 추가(L71 뒤), `onPaneSwitch` 콜백 2곳(L509, L642), 푸터 `{#each}`(L792), CSS(L1022 뒤)

**Acceptance Criteria:**
- [ ] `spectatorPaneOrdinal`·`spectatorPaneCount` `$state` 추가
- [ ] 두 `onPaneSwitch` 콜백(초기 연결·재연결) 모두 두 상태를 갱신
- [ ] 푸터가 패널 버튼 5개(`1~5`)를 렌더링
- [ ] `n === spectatorPaneOrdinal`인 버튼에 `active` 클래스 부여
- [ ] `status !== 'open'`이거나 (`spectatorPaneCount > 0` 이고 `n > spectatorPaneCount`)면 버튼 `disabled`
- [ ] CSS `.spec-footer button.pane-num.active`가 채워진 액센트 배경(idle/disabled와 명확히 구분)
- [ ] `cd app && npm run check` 신규 오류 0건

**Verify:** `cd app && npm run check` → 신규 svelte-check 오류 0건. 이후 아래 수동 검증.

**Steps:**

- [ ] **Step 1: 앱 의존성 확인**

Run: `cd app && [ -d node_modules ] || npm install`
Expected: `node_modules` 존재(Task 2에서 이미 설치됨 — 보통 무동작).

- [ ] **Step 2: 관전 패널 상태 추가**

`app/src/lib/editor/terminal/TerminalView.svelte`에서 다음 줄(L71)을 찾는다:

```ts
	let spectatorWindowName = $state('');
```

다음으로 교체한다:

```ts
	let spectatorWindowName = $state('');
	// Active pane's footer-button ordinal (1-based) + the window's pane count,
	// reported by the bridge on every pane-switch. Ordinal 0 = unknown (or the
	// active pane is past button 5). Count 0 = no info yet / bridge too old to
	// send it — the footer then leaves all five buttons enabled.
	let spectatorPaneOrdinal = $state(0);
	let spectatorPaneCount = $state(0);
```

- [ ] **Step 3: 초기 연결 경로의 `onPaneSwitch` 콜백 갱신**

같은 파일에서 다음 블록(L509-519)을 찾는다:

```ts
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
				// term.resize triggers an async re-render; defer the fit one
				// frame so .xterm's new natural dimensions have settled.
				requestAnimationFrame(() => applySpectatorFit());
			},
```

다음으로 교체한다:

```ts
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName, paneOrdinal, paneCount }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				spectatorPaneOrdinal = paneOrdinal;
				spectatorPaneCount = paneCount;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
				// term.resize triggers an async re-render; defer the fit one
				// frame so .xterm's new natural dimensions have settled.
				requestAnimationFrame(() => applySpectatorFit());
			},
```

- [ ] **Step 4: 재연결 경로의 `onPaneSwitch` 콜백 갱신**

같은 파일에서 다음 블록(L642-649)을 찾는다:

```ts
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
			},
```

다음으로 교체한다:

```ts
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName, paneOrdinal, paneCount }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				spectatorPaneOrdinal = paneOrdinal;
				spectatorPaneCount = paneCount;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
			},
```

- [ ] **Step 5: 푸터 패널 버튼 5개 + 하이라이트 + 비활성화**

같은 파일에서 다음 블록(L792-800)을 찾는다:

```svelte
					{#each [1, 2, 3, 4] as n (n)}
						<button
							type="button"
							class="icon pane-num"
							title="패널 {n}"
							onclick={() => selectPane(n)}
							disabled={status !== 'open'}
						>{n}</button>
					{/each}
```

다음으로 교체한다:

```svelte
					{#each [1, 2, 3, 4, 5] as n (n)}
						<button
							type="button"
							class="icon pane-num"
							class:active={n === spectatorPaneOrdinal}
							title="패널 {n}"
							onclick={() => selectPane(n)}
							disabled={status !== 'open' || (spectatorPaneCount > 0 && n > spectatorPaneCount)}
						>{n}</button>
					{/each}
```

- [ ] **Step 6: 활성 버튼 CSS 추가**

같은 파일에서 다음 블록(L1019-1022)을 찾는다:

```css
	.spec-footer button.pane-num {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-weight: 600;
	}
```

다음으로 교체한다 (`.active` 규칙을 바로 뒤에 추가):

```css
	.spec-footer button.pane-num {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-weight: 600;
	}
	/* Active pane: filled accent. Distinct from idle (#3a3a3a) and the
	   disabled state (opacity 0.5 via `.spec-footer button:disabled`). */
	.spec-footer button.pane-num.active {
		background: #2563eb;
		border-color: #5b8def;
		color: #fff;
	}
```

- [ ] **Step 7: 타입체크**

Run: `cd app && npm run check`
Expected: 신규 svelte-check 오류 0건 (기존 baseline 대비 증가 없음).

- [ ] **Step 8: 수동 검증 (dev 서버, 실제 관전 세션 필요)**

Run: `cd app && npm run dev` 후 브라우저에서 관전(`spectate:`) 노트를 연다.
**브릿지는 Task 1 변경분으로 재배포돼 있어야 한다** (`systemctl --user
restart term-bridge`).

확인 항목:
1. 활성 패널 번호 버튼이 액센트(파란색)로 하이라이트되는지.
2. 데스크탑에서 패널을 바꾸거나 `Ctrl+H/L`·`«`/`»`로 이동 → 하이라이트가 추종.
3. 패널이 5개 미만인 윈도우 → 초과 번호 버튼이 dim + 클릭 비활성.
4. 푸터 `1`~`5` 버튼 클릭 → 해당 패널로 전환, 하이라이트 갱신.
5. 모바일 `/note/[id]` 라우트와 데스크탑 `NoteWindow` 양쪽 동일 확인.
6. 비관전(셸 모드) 터미널 노트 — 푸터 없음, 회귀 없음.

(실제 브릿지+tmux 인프라가 없으면 1~5는 사용자 검증으로 넘긴다. `npm run
check`는 환경 무관하게 통과해야 한다.)

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "$(cat <<'EOF'
feat(spectator): 관전 푸터 패널 버튼 5개 + 활성 패널 하이라이트

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 검증 요약

- 자동:
  - `cd bridge && npm test` — `panePosition` 단위 테스트 + 기존 브릿지 테스트.
  - `cd app && npm run test -- wsClientPaneSwitch` — `pane-switch` 파싱 테스트.
  - `cd app && npm run check` / `cd bridge && npx tsc -p . --noEmit` — 타입체크.
- 수동: Task 3 Step 8 — 실제 관전 세션에서 하이라이트·비활성화 시각 확인
  (브릿지 재배포 필요). CSS·UI 시각 변경이라 유닛 테스트 범위 밖.
