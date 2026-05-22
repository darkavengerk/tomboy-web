# 관전 모드 스크롤백 열람 (클라이언트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관전 모드 xterm 버퍼에 시드된 스크롤백을 모바일·데스크탑에서 스크롤해 열람하고, 라이브 스트리밍 중에는 freeze + "맨 아래로" 인디케이터로 방해 없이 읽게 한다.

**Architecture:** 접근 A — xterm 자체의 `.xterm-viewport` 스크롤백 스크롤을 관전 모드에서 노출한다(Task 1, 실기기 go/no-go 게이트). 그 위에 순수 헬퍼 `spectatorScroll.ts`(Task 2)와 `TerminalView.svelte`의 freeze 상태 + "↓ 맨 아래로" 인디케이터(Task 3)를 얹는다.

**Tech Stack:** Svelte 5 (runes), TypeScript, xterm.js v6, vitest.

선행 설계: `docs/superpowers/specs/2026-05-21-spectator-scrollback-client-design.md`

> **게이트 주의:** Task 1은 실기기 스파이크 — go/no-go 게이트다. **no-go이면** 설계 §5c(접근 B: 커스텀 `.xterm-host` → `scrollToLine`)로 Task 1을 재설계하고 이 플랜을 갱신한다. Task 2~3(헬퍼 + freeze/인디케이터 UX)은 접근 A/B 어느 쪽이든 거의 그대로 유효하다(스크롤 좌표 입력 배선만 달라짐).

---

## File Structure

- **Create** `app/src/lib/editor/terminal/spectatorScroll.ts` — 순수 헬퍼. xterm 버퍼 좌표로부터 "맨 아래 여부 / freeze 이후 새 출력 줄 수"를 계산한다. 단일 책임, 순수 함수.
- **Create** `app/tests/unit/editor/spectatorScroll.test.ts` — 위 헬퍼의 vitest 단위 테스트.
- **Modify** `app/src/lib/editor/terminal/TerminalView.svelte` — Task 1(스크롤 면 노출) + Task 3(onScroll/onData 배선, freeze 상태, "↓ 맨 아래로" 인디케이터).

---

### Task 1: 스파이크 — 관전 모드에서 xterm 네이티브 스크롤백 스크롤 노출

**Goal:** 관전 모드의 `transform: scale`된 3-레이어 DOM 안에서 xterm 자체의 `.xterm-viewport` 스크롤백 스크롤이 실기기 터치로 동작하도록 최소 변경을 적용하고, 사용자가 실기기에서 go/no-go를 판정한다.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured. 실기기 스모크(아래 userGate 항목)는 사용자가 직접 수행하며, 그 결과 없이 이 태스크를 닫지 않는다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (스펙테이터 DOM/CSS — `.xterm-host`/`.xterm-stage`/`.xterm-mount`: 템플릿 ~648-652, CSS ~1001-1033; xterm 초기화 ~321-334)

**Acceptance Criteria:**
- [ ] xterm `.xterm-viewport`가 관전 모드에서 스크롤백 스크롤 면으로 동작하도록 필요한 최소 변경이 적용됨 (또는 변경 없이 이미 동작함이 코드+기기로 확인됨)
- [ ] 시드 직후 `term.buffer.active.length` / `baseY`를 한 번 콘솔에 찍는 진단 로그가 관전 모드에 추가됨 (Task 3에서 제거 예정)
- [ ] `cd app && npm run check` 통과 (svelte-check 타입 에러 없음)
- [ ] `cd app && npm run build` 성공
- [ ] (userGate, 실기기) 일반 화면 패널(셸 히스토리가 한 화면 이상 있는 패널 또는 claude code)을 관전 시, 모바일에서 터미널 영역을 터치 드래그하면 스크롤백이 위로 스크롤되어 과거 출력이 보임
- [ ] (userGate, 실기기) 스크롤 중 글리프 깨짐·셀 위치 어긋남이 없고, 스크롤이 사용 가능한 수준으로 매끄러움
- [ ] go/no-go 판정이 기록됨 — go → Task 2 진행 / no-go → 설계 §5c(접근 B)로 재설계

**Verify:** `cd app && npm run check && npm run build` → 둘 다 통과. 이어서 실기기 스모크(위 userGate 두 항목)를 사용자가 수행하고 go/no-go를 보고.

**Steps:**

- [ ] **Step 1: 현재 관전 스크롤 DOM/CSS 파악**

`app/src/lib/editor/terminal/TerminalView.svelte`에서 다음을 읽는다:
- 템플릿 3-레이어 DOM (~648-652): `.xterm-host > .xterm-stage > .xterm-mount`.
- `applySpectatorFit()` (~200-218): `.xterm-mount`에 `transform: scale`, `.xterm-stage`를 보이는 화면 크기로 잡음.
- 스펙테이터 CSS (~1001-1033): `.terminal-page.spectator .xterm-host { overflow-y: auto }` 등.

xterm.js는 `.xterm-mount` 안에 자체적으로 `.xterm-viewport`(내부 overflow-y 스크롤 요소 — 전체 버퍼 높이의 sizer를 가짐)와 `.xterm-screen`(렌더된 행)을 만든다. 스크롤백이 있으면 `.xterm-viewport`는 스크롤 가능 상태가 된다.

- [ ] **Step 2: 진단 로그 추가**

xterm `term` 생성 + `client` 배선 직후의 spectator 분기에, 시드가 도착했을 때 버퍼 상태를 한 번 찍는 로그를 더한다. 관전 모드 `onData` 콜백(파일에 두 군데: `onMount` ~419, `reconnect` ~547 — 둘 다)에서, 최초 1회만:

```ts
let spectatorBufferLogged = false;
// ... onData 콜백 안:
onData: (chunk) => {
    term?.write(chunk);
    if (isSpectator && !spectatorBufferLogged && term) {
        spectatorBufferLogged = true;
        const b = term.buffer.active;
        console.log('[spectator] buffer after seed:', {
            length: b.length, baseY: b.baseY, viewportY: b.viewportY, rows: term.rows
        });
    }
},
```

이 로그로 실기기 콘솔에서 "스크롤백이 버퍼에 실제로 있는가"(`length > rows`, `baseY > 0`)를 확인할 수 있다.

- [ ] **Step 3: 네이티브 스크롤 노출 (leading hypothesis)**

유력 가설: 외곽 `.xterm-host { overflow-y: auto }`가 — `.xterm-stage`가 보이는 화면 크기로만 잡혀 보통 스크롤할 게 없는데도 — 터치 제스처를 가로채 안쪽 `.xterm-viewport`로 닿지 못한다. 최소 변경 후보:

```css
/* .terminal-page.spectator .xterm-host — overflow-y:auto → hidden 으로.
   세로 스크롤은 xterm 자체 .xterm-viewport 가 담당하게 한다. */
.terminal-page.spectator .xterm-host {
	overflow-x: hidden;
	overflow-y: hidden;
}
```

적용 후, `.xterm-viewport`가 스케일된 마운트 안에서 터치로 스크롤되는지 확인 대상이 된다. 조사 결과 다른 원인(`touch-action`, 마운트 클리핑 등)이 드러나면 그에 맞춰 최소 변경으로 조정한다 — 스파이크의 산출은 "기기에서 검증된 최소 변경"이다.

- [ ] **Step 4: 빌드 + 타입체크**

Run: `cd app && npm run check && npm run build`
Expected: svelte-check 에러 0, 빌드 성공.

- [ ] **Step 5: 실기기 스모크 (userGate — 사용자 수행)**

`npm run dev`로 띄운 앱을 실기기(모바일)에서 열고, 셸 히스토리가 한 화면 이상 쌓인 일반 화면 패널(또는 claude code)을 관전한다. 터미널 영역을 터치 드래그해 스크롤백이 보이는지, 글리프 깨짐 없이 매끄러운지 확인한다. 콘솔의 `[spectator] buffer after seed` 로그로 스크롤백 존재를 교차 확인한다. **go/no-go를 보고한다.**

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(spectator): xterm 네이티브 스크롤백 스크롤 노출 (스파이크)"
```

---

### Task 2: `spectatorScroll.ts` — 스크롤 상태 순수 헬퍼

**Goal:** xterm 버퍼 좌표로부터 "맨 아래 여부 / freeze 이후 새로 도착한 줄 수"를 계산하는 순수 함수와 그 단위 테스트를 만든다.

**Files:**
- Create: `app/src/lib/editor/terminal/spectatorScroll.ts`
- Create (test): `app/tests/unit/editor/spectatorScroll.test.ts`

**Acceptance Criteria:**
- [ ] `computeScrollState(prev, viewportY, baseY)` 순수 함수가 존재하고, 맨 아래일 때 `atBottom:true`·`newLines:0`·`freezeBaseY:null`을 반환
- [ ] 스크롤업 첫 진입 시 `freezeBaseY`를 현재 `baseY`로 앵커링하고, 이후 `baseY` 증가분을 `newLines`로 계산
- [ ] 맨 아래 복귀 시 `INITIAL_SCROLL_STATE`로 리셋
- [ ] `cd app && npm run test -- spectatorScroll` 의 모든 테스트 통과
- [ ] `cd app && npm run check` 통과

**Verify:** `cd app && npm run test -- spectatorScroll && npm run check` → 테스트 전부 PASS + 타입 에러 없음.

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

Create `app/tests/unit/editor/spectatorScroll.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	computeScrollState,
	INITIAL_SCROLL_STATE,
	type SpectatorScrollState
} from '$lib/editor/terminal/spectatorScroll';

describe('computeScrollState', () => {
	it('맨 아래(viewportY === baseY) — atBottom, newLines 0', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 100, 100);
		expect(s).toEqual({ atBottom: true, freezeBaseY: null, newLines: 0 });
	});

	it('viewportY > baseY 도 맨 아래로 간주(방어적)', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 120, 100);
		expect(s.atBottom).toBe(true);
	});

	it('스크롤업 첫 진입 — freezeBaseY를 현재 baseY로 앵커, newLines 0', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 40, 100);
		expect(s).toEqual({ atBottom: false, freezeBaseY: 100, newLines: 0 });
	});

	it('스크롤업 유지 중 baseY 증가 — newLines = baseY - freezeBaseY', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 0 };
		const s = computeScrollState(prev, 40, 137);
		expect(s).toEqual({ atBottom: false, freezeBaseY: 100, newLines: 37 });
	});

	it('스크롤업 상태에서 맨 아래 복귀 — INITIAL로 리셋', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 37 };
		const s = computeScrollState(prev, 137, 137);
		expect(s).toEqual(INITIAL_SCROLL_STATE);
	});

	it('freezeBaseY보다 baseY가 작아져도 newLines는 음수가 되지 않음', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 0 };
		const s = computeScrollState(prev, 40, 90);
		expect(s.newLines).toBe(0);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- spectatorScroll`
Expected: FAIL — `spectatorScroll` 모듈이 없음.

- [ ] **Step 3: 헬퍼 구현**

Create `app/src/lib/editor/terminal/spectatorScroll.ts`:

```ts
/**
 * 관전 모드 스크롤 상태 — xterm 버퍼 좌표로부터 freeze 패턴 UI를 구동한다.
 *
 * `viewportY` = 뷰포트 맨 위에 보이는 버퍼 줄 인덱스.
 * `baseY`     = 맨 아래까지 스크롤했을 때의 `viewportY` (= 스크롤백 줄 수).
 * 둘이 같으면(또는 viewportY가 더 크면) 라이브 맨 아래에 붙어 있는 상태.
 */
export interface SpectatorScrollState {
	/** 뷰포트가 라이브 맨 아래에 고정돼 있으면 true. */
	atBottom: boolean;
	/** 사용자가 맨 아래를 떠난 순간의 baseY 앵커. atBottom이면 null. */
	freezeBaseY: number | null;
	/** 맨 아래를 떠난 뒤 새로 도착한 줄 수. atBottom이면 0. */
	newLines: number;
}

export const INITIAL_SCROLL_STATE: SpectatorScrollState = {
	atBottom: true,
	freezeBaseY: null,
	newLines: 0
};

/**
 * 이전 상태 + 현재 버퍼 좌표로 다음 스크롤 상태를 계산한다. 순수 함수.
 * 스크롤 이벤트와 데이터 도착 양쪽에서 호출된다 — 전자는 viewportY를,
 * 후자는 baseY를 움직이므로 둘 다 새 상태를 만들 수 있다.
 */
export function computeScrollState(
	prev: SpectatorScrollState,
	viewportY: number,
	baseY: number
): SpectatorScrollState {
	if (viewportY >= baseY) {
		return INITIAL_SCROLL_STATE;
	}
	const freezeBaseY = prev.freezeBaseY ?? baseY;
	const newLines = Math.max(0, baseY - freezeBaseY);
	return { atBottom: false, freezeBaseY, newLines };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- spectatorScroll`
Expected: 모든 테스트 PASS.

- [ ] **Step 5: 타입체크**

Run: `cd app && npm run check`
Expected: 에러 0.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/terminal/spectatorScroll.ts app/tests/unit/editor/spectatorScroll.test.ts
git commit -m "feat(spectator): 스크롤 상태 순수 헬퍼 + 단위 테스트"
```

---

### Task 3: `TerminalView.svelte` — freeze 배선 + "↓ 맨 아래로" 인디케이터

**Goal:** Task 2의 헬퍼를 써서 관전 모드의 스크롤 상태를 추적하고, 스크롤업 상태일 때 "↓ 새 출력 N줄 · 맨 아래로" 인디케이터 버튼을 띄워 탭하면 맨 아래로 복귀하게 한다. Task 1의 진단 로그를 제거한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (스크립트: import·`$state`·`recomputeScroll`·`onData`/`onScroll` 배선·진단 로그 제거; 템플릿: 인디케이터 버튼; CSS: 버튼 스타일)

**Acceptance Criteria:**
- [ ] 관전 모드에서 `term.onScroll`과 데이터 도착 양쪽에서 `computeScrollState`로 스크롤 상태를 갱신함
- [ ] 스크롤업 상태(`!atBottom`)일 때만 인디케이터 버튼이 보이고, `newLines > 0`이면 "↓ 새 출력 N줄", 아니면 "↓ 맨 아래로" 표기
- [ ] 인디케이터 탭 시 `term.scrollToBottom()` 호출 → 버튼이 사라짐
- [ ] 비관전(shell) 모드에는 인디케이터가 없고 동작 변화 없음
- [ ] Task 1의 `[spectator] buffer after seed` 진단 로그가 제거됨
- [ ] `cd app && npm run check` 통과, `cd app && npm run build` 성공
- [ ] (실기기 스모크) 스트리밍 중 위로 스크롤 → freeze + 인디케이터 → 탭 → 맨 아래 복귀 + 추종 재개

**Verify:** `cd app && npm run check && npm run build` → 통과. 이어 실기기 스모크(위 마지막 항목).

**Steps:**

- [ ] **Step 1: 헬퍼 import + 상태 추가**

`TerminalView.svelte` `<script>` 상단 import 구역에 추가:

```ts
import {
	computeScrollState,
	INITIAL_SCROLL_STATE,
	type SpectatorScrollState
} from './spectatorScroll.js';
```

스펙테이터 `$state` 묶음(파일의 `spectatorPaneId` 등 근처)에 추가:

```ts
let scrollState: SpectatorScrollState = $state(INITIAL_SCROLL_STATE);
```

- [ ] **Step 2: `recomputeScroll` 함수 추가**

`applySpectatorFit` 근처에 추가:

```ts
/** 관전 모드 스크롤 상태를 xterm 버퍼 좌표로부터 갱신한다. */
function recomputeScroll(): void {
	if (!isSpectator || !term) return;
	const b = term.buffer.active;
	scrollState = computeScrollState(scrollState, b.viewportY, b.baseY);
}
```

- [ ] **Step 3: `onScroll` 구독 + `onData`에서 갱신, 진단 로그 제거**

xterm 생성 직후의 spectator 분기에 `onScroll` 구독을 추가한다(파일에서 `applySpectatorFit()`를 spectator용으로 호출하는 곳 근처):

```ts
if (isSpectator) {
	term.onScroll(() => recomputeScroll());
}
```

`onData` 콜백(파일 두 군데: `onMount`·`reconnect`)에서 Task 1의 진단 로그를 제거하고, 스펙테이터일 때 쓰기 완료 후 스크롤 상태를 갱신하도록 바꾼다:

```ts
onData: (chunk) => {
	if (term) {
		term.write(chunk, () => {
			if (isSpectator) recomputeScroll();
		});
	}
},
```

(`term.write`의 2번째 인자는 처리 완료 콜백 — `baseY`가 갱신된 뒤 호출된다.)

- [ ] **Step 4: 인디케이터 버튼 마크업**

템플릿의 `.xterm-host` 블록(`<div class="xterm-host" ...>` ~648) 바로 다음, `.body` 안에 추가:

```svelte
{#if isSpectator && !scrollState.atBottom}
	<button
		type="button"
		class="scroll-bottom-indicator"
		onclick={() => { term?.scrollToBottom(); }}
	>
		{scrollState.newLines > 0 ? `↓ 새 출력 ${scrollState.newLines}줄` : '↓ 맨 아래로'}
	</button>
{/if}
```

- [ ] **Step 5: 인디케이터 CSS**

`<style>`의 스펙테이터 CSS 구역에 추가:

```css
.scroll-bottom-indicator {
	position: absolute;
	left: 50%;
	bottom: 12px;
	transform: translateX(-50%);
	z-index: 20;
	background: #1e6f3f;
	color: #fff;
	border: 1px solid #2b8;
	border-radius: 14px;
	padding: 5px 14px;
	font-size: 0.78rem;
	cursor: pointer;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.scroll-bottom-indicator:active {
	background: #28814c;
}
```

`.body`가 인디케이터의 `position: absolute` 기준이 되도록, `.body` 규칙에 `position: relative`가 없으면 추가한다.

- [ ] **Step 6: 빌드 + 타입체크**

Run: `cd app && npm run check && npm run build`
Expected: svelte-check 에러 0, 빌드 성공.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(spectator): freeze 인디케이터 — 스크롤업 시 '맨 아래로' 버튼"
```
