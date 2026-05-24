# Spectator 패널 고정(pin) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spectator 모드 footer의 패널 버튼을 한 번 더 눌러 특정 패널을 고정 관전하는 기능을 추가하고, 고정 상태를 `spectate: <session>:<N>` 형식으로 노트에 자동 저장한다.

**Architecture:** 전부 클라이언트(`TerminalView.svelte`) 안에서 결정. Bridge / WS 프로토콜 / 서버 코드는 변경 없음. 핵심: pin 활성일 때 `pane-switch` 프레임을 감시해 `pinDetached` 플래그를 결정하고, detached이면 `onData`를 무시하고 다음 클릭/타이핑 때 `selectPane(N)`으로 자동 re-attach.

**Tech Stack:** Svelte 5 runes, TypeScript, vitest, TipTap JSON, xterm.js.

**Spec:** `docs/superpowers/specs/2026-05-24-spectator-pin-pane-design.md`

---

## 파일 구조

| 파일 | 변경 종류 | 책임 |
|---|---|---|
| `app/src/lib/editor/terminal/parseTerminalNote.ts` | Modify | `SPECTATE_RE` 정규식 확장, `TerminalNoteSpec.pinnedPane` 필드, `rewriteSpectateLine` 헬퍼 |
| `app/tests/unit/editor/parseTerminalNote.test.ts` | Modify | `spectate: <s>:<N>` 파싱 케이스 추가 |
| `app/tests/unit/editor/rewriteSpectateLine.test.ts` | Create | `rewriteSpectateLine` 단위 테스트 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | Modify | pin state, 분기된 `onPaneSwitch`/`onData`, 토글 핸들러, persist 헬퍼, detach 배너, CSS, 키보드 단축키 가드 |
| `CLAUDE.md` | Modify | `tomboy-terminal` 섹션에 pin 동작 1단락 추가 |

Bridge (`bridge/src/spectatorSession.ts`, WS 프로토콜)는 손대지 않음 — A안의 핵심.

---

## Task 1: 파서 확장 — `spectate: <session>:<N>` 파싱

**Goal:** `parseTerminalNote`가 `spectate: main:3`을 `spectate="main"` + `pinnedPane=3`으로 파싱하도록 한다. 1~5 범위 밖은 무시(=`pinnedPane=undefined`).

**Files:**
- Modify: `app/src/lib/editor/terminal/parseTerminalNote.ts`
- Modify: `app/tests/unit/editor/parseTerminalNote.test.ts`

**Acceptance Criteria:**
- [ ] `TerminalNoteSpec`에 `pinnedPane?: number` 필드 추가됨
- [ ] `spectate: main` → `{ spectate: 'main', pinnedPane: undefined }`
- [ ] `spectate: main:3` → `{ spectate: 'main', pinnedPane: 3 }`
- [ ] `spectate: main:0` → `{ spectate: 'main', pinnedPane: undefined }` (범위 밖)
- [ ] `spectate: main:99` → `{ spectate: 'main', pinnedPane: undefined }` (범위 밖)
- [ ] `spectate: main:foo` → `{ spectate: 'main:foo', pinnedPane: undefined }` (숫자 아니면 세션 이름 일부)
- [ ] `spectate: grp:web:2` → `{ spectate: 'grp:web', pinnedPane: 2 }` (콜론 포함 세션 이름 보존)
- [ ] 기존 spectate 테스트들 모두 통과 (특히 `grp:web` 같은 케이스는 콜론 허용이라 기존 ALPHANUMERIC 정규식과 호환되는지 확인)

**Verify:** `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 새 테스트 케이스를 먼저 작성 (TDD)**

`app/tests/unit/editor/parseTerminalNote.test.ts`의 `describe('parseTerminalNote — spectate', ...)` 블록 끝에 아래 케이스를 추가:

```ts
	it('parses spectate: <session>:<N> as session + pinnedPane', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: main:3'));
		expect(r).toMatchObject({ spectate: 'main', pinnedPane: 3 });
	});

	it('treats spectate: <session>:0 as pinnedPane undefined (out of range)', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: main:0'));
		expect(r).toMatchObject({ spectate: 'main', pinnedPane: undefined });
	});

	it('treats spectate: <session>:99 as pinnedPane undefined (out of range)', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: main:99'));
		expect(r).toMatchObject({ spectate: 'main', pinnedPane: undefined });
	});

	it('treats non-numeric suffix as part of session name', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: main:foo'));
		expect(r).toMatchObject({ spectate: 'main:foo', pinnedPane: undefined });
	});

	it('preserves colon in session name when pin trails (grp:web:2)', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: grp:web:2'));
		expect(r).toMatchObject({ spectate: 'grp:web', pinnedPane: 2 });
	});

	it('regular spectate: line still leaves pinnedPane undefined', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://you@desktop', 'spectate: main'));
		expect(r).toMatchObject({ spectate: 'main', pinnedPane: undefined });
	});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts`
Expected: 6개 신규 테스트가 모두 FAIL (`pinnedPane` 필드 없음).

- [ ] **Step 3: `TerminalNoteSpec`에 필드 추가**

`app/src/lib/editor/terminal/parseTerminalNote.ts`의 `TerminalNoteSpec` interface 끝(`pinneds` 다음)에 추가:

```ts
	/**
	 * Pinned spectator pane ordinal (1..5). When set, the spectator view stays
	 * locked to this pane regardless of the desktop's active-pane changes.
	 * Encoded in the note as `spectate: <session>:<N>`.
	 * Out-of-range values from the note are silently dropped (= undefined).
	 */
	pinnedPane?: number;
```

- [ ] **Step 4: `SPECTATE_RE` 갱신 + 파싱 로직 추가**

`SPECTATE_RE`는 그대로 두고(콜론을 이미 허용), match 후 trailing `:<digits>` 분리 로직을 추가. `SPECTATE_RE` 매칭 블록(`parseTerminalNote.ts` 라인 ~101)을 다음으로 교체:

```ts
		const spectateMatch = SPECTATE_RE.exec(text);
		if (spectateMatch) {
			if (spectate !== undefined) return null;
			const raw = spectateMatch[1];
			const pinMatch = /^(.+):(\d+)$/.exec(raw);
			if (pinMatch) {
				const n = Number(pinMatch[2]);
				if (Number.isInteger(n) && n >= 1 && n <= 5) {
					spectate = pinMatch[1];
					pinnedPane = n;
				} else {
					// Out-of-range trailing :<N> → keep raw session, drop pin.
					spectate = pinMatch[1];
					// pinnedPane stays undefined.
				}
			} else {
				spectate = raw;
			}
			continue;
		}
```

그리고 동일 함수 윗부분(현재 `let bridge: ...` / `let spectate: ...` 선언 근처)에 추가:

```ts
	let pinnedPane: number | undefined;
```

마지막 return 객체에 `pinnedPane` 추가:

```ts
	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge,
		spectate,
		histories,
		history,
		connect: connect ?? [],
		pinneds,
		pinnedPane
	};
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts`
Expected: 신규 6개 + 기존 모든 테스트 PASS.

- [ ] **Step 6: `npm run check` 통과 확인**

Run: `cd app && npm run check`
Expected: 0 errors, 0 warnings (TerminalView.svelte의 `spec.pinnedPane` 참조가 아직 없어도 타입 추가는 통과해야 함).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/editor/terminal/parseTerminalNote.ts app/tests/unit/editor/parseTerminalNote.test.ts
git commit -m "feat(terminal): parse spectate: <session>:<N> as pinnedPane"
```

---

## Task 2: `rewriteSpectateLine` 헬퍼

**Goal:** 자물쇠 토글 시 노트 본문을 직접 수정하기 위한 in-place 텍스트 치환 헬퍼. ProseMirror JSON round-trip 없이 `<note-content>` raw XML에서 `spectate:` 라인만 갈아끼운다.

**Files:**
- Modify: `app/src/lib/editor/terminal/parseTerminalNote.ts` (헬퍼 export 추가)
- Create: `app/tests/unit/editor/rewriteSpectateLine.test.ts`

**Acceptance Criteria:**
- [ ] `rewriteSpectateLine(xml, session, n)` 시그니처 정의 — `n: number | null`
- [ ] `n=null` & 현재 `spectate: main:3` → `spectate: main`
- [ ] `n=3` & 현재 `spectate: main` → `spectate: main:3`
- [ ] `n=5` & 현재 `spectate: main:3` → `spectate: main:5`
- [ ] `spectate:` 라인이 없으면 입력 그대로 반환 (no-op)
- [ ] 콜론 포함 세션 (`grp:web:2` → `grp:web:5`)
- [ ] 단일 인스턴스만 치환 (`spectate:`가 두 번 나오는 비정상 케이스에선 첫 번째만)
- [ ] 다른 메타 라인 (`bridge:`, `ssh://`)은 건드리지 않음

**Verify:** `cd app && npx vitest run tests/unit/editor/rewriteSpectateLine.test.ts` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 테스트 파일 작성 (TDD)**

`app/tests/unit/editor/rewriteSpectateLine.test.ts` 생성:

```ts
import { describe, it, expect } from 'vitest';
import { rewriteSpectateLine } from '$lib/editor/terminal/parseTerminalNote.js';

/**
 * The XML format mirrors what TipTap's `<note-content>` produces — paragraphs
 * are typically separated by newlines or wrapped in <p>...</p> depending on
 * the serializer. We test against the actual shape used by Tomboy notes:
 * each paragraph is a sequence of text/marked text inside <note-content>,
 * with paragraph boundaries being newlines in the raw XML.
 */

describe('rewriteSpectateLine', () => {
	it('adds :N when none was present', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 3);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>'
		);
	});

	it('removes :N when n is null', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', null);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main\nbody</note-content>'
		);
	});

	it('replaces :N with a different :M', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 5);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:5\nbody</note-content>'
		);
	});

	it('returns input unchanged when no spectate: line is present', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nbridge: wss://b/ws</note-content>';
		expect(rewriteSpectateLine(xml, 'main', 3)).toBe(xml);
	});

	it('preserves colons inside session names (grp:web:2 → grp:web:5)', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: grp:web:2\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'grp:web', 5);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: grp:web:5\nbody</note-content>'
		);
	});

	it('only replaces the first spectate: line if multiple exist', () => {
		const xml = '<note-content version="0.1">spectate: a\nspectate: b\n</note-content>';
		const out = rewriteSpectateLine(xml, 'a', 4);
		expect(out).toBe('<note-content version="0.1">spectate: a:4\nspectate: b\n</note-content>');
	});

	it('does not touch bridge: or ssh:// lines', () => {
		const xml = '<note-content version="0.1">ssh://host\nbridge: wss://b/ws\nspectate: main</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 2);
		expect(out).toBe(
			'<note-content version="0.1">ssh://host\nbridge: wss://b/ws\nspectate: main:2</note-content>'
		);
	});

	it('handles spectate: line at the very end of content (no trailing newline)', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 1);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:1</note-content>'
		);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/rewriteSpectateLine.test.ts`
Expected: import 실패 — `rewriteSpectateLine`가 export 안 됨.

- [ ] **Step 3: 헬퍼 구현**

`app/src/lib/editor/terminal/parseTerminalNote.ts` 끝에 추가:

```ts
/**
 * `<note-content>` 내부의 첫 번째 `spectate:` 라인을 in-place 치환한다.
 * ProseMirror JSON round-trip 없이 raw XML 텍스트 노드만 건드리는 보수적 접근:
 * `spectate:` 라인은 메타 라인이라 mark가 거의 없고, 있어도 텍스트 부분만
 * 교체하면 마크 자체는 자동으로 보존된다.
 *
 * - `n === null`: `:<N>` 부분 제거. 라인은 `spectate: <session>` 으로 남음.
 * - `n` (1..5): `:<N>` 부분 추가/교체. 라인은 `spectate: <session>:<n>` 가 됨.
 * - 라인이 없으면 입력을 그대로 반환 (no-op).
 *
 * 첫 번째 매칭만 치환. 다중 spectate: 라인은 파서가 reject 하므로 실제로는
 * 발생하지 않지만 방어적으로 첫 인스턴스만 건드린다.
 */
export function rewriteSpectateLine(
	xmlContent: string,
	session: string,
	n: number | null
): string {
	// `spectate:` 다음 공백 + 임의 문자열 (라인/태그 경계까지). `<` 이전 또는
	// 줄바꿈 이전에서 멈춤 — 라인 단위 메타 형식이라 충분.
	const re = /spectate:\s*([^\n<]+)/;
	const m = re.exec(xmlContent);
	if (!m) return xmlContent;
	const replacement = n === null ? `spectate: ${session}` : `spectate: ${session}:${n}`;
	return xmlContent.slice(0, m.index) + replacement + xmlContent.slice(m.index + m[0].length);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/rewriteSpectateLine.test.ts`
Expected: 8개 모두 PASS.

- [ ] **Step 5: 회귀 확인**

Run: `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts`
Expected: 기존 + Task 1 신규 테스트 모두 PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/parseTerminalNote.ts app/tests/unit/editor/rewriteSpectateLine.test.ts
git commit -m "feat(terminal): rewriteSpectateLine helper for pin persistence"
```

---

## Task 3: TerminalView pin state + footer 토글

**Goal:** 컴포넌트 안에 `pinnedOrdinal` / `pinDetached` 상태를 두고, footer 1~5 버튼이 「활성 버튼 더블클릭 = 고정 / 자물쇠 버튼 클릭 = 해제」로 동작하게 한다. 노트에는 아직 저장하지 않는다 (Task 5에서).

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] `pinnedOrdinal` (number | null) state — `spec.pinnedPane ?? null` 로 초기화
- [ ] `pinDetached` (boolean) state — false 로 초기화
- [ ] Footer 1~5 버튼이 새 핸들러 `onPaneNumClick` 호출
- [ ] 자물쇠 표시(🔒)가 `n === pinnedOrdinal`일 때 보임
- [ ] pin 중에는 다른 번호 버튼이 `disabled`
- [ ] `pinned`/`detached` CSS 클래스 추가
- [ ] 자물쇠 토글 시 콘솔 에러 없음

**Verify:** `cd app && npm run check` → 0 errors. 수동으로 dev 서버 열어서 토글 동작 확인.

**Steps:**

- [ ] **Step 1: state 선언**

`TerminalView.svelte`의 `<script lang="ts">` 안, `spectatorPaneCount = $state(0);` 라인 다음에 추가:

```ts
	/**
	 * Pinned pane ordinal (1..5). When non-null, the spectator view stays locked
	 * to this pane: pane-switch frames for other panes flip `pinDetached=true`
	 * which suppresses incoming `data` and shows the detach banner. Initial
	 * value comes from `spec.pinnedPane` (parsed from `spectate: <s>:<N>`).
	 */
	let pinnedOrdinal: number | null = $state(spec.pinnedPane ?? null);
	/**
	 * True when pin is active AND the desktop's active pane is not our pinned
	 * ordinal (or the ordinal is past the window's pane count). While detached,
	 * incoming `data` is dropped and the last-seen frame stays frozen on screen.
	 */
	let pinDetached = $state(false);
```

- [ ] **Step 2: 토글 핸들러 추가**

`selectPane` 함수 다음(`/** Whether keyboard ... */` 직전)에 추가:

```ts
	/**
	 * Footer pane-button click router. Three branches:
	 *  - 자물쇠 버튼 (n === pinnedOrdinal) → 고정 해제.
	 *  - pin 없음 + 클릭한 번호가 이미 active → 그 번호로 고정.
	 *  - 그 외 → 일반 select-pane(n).
	 *
	 * pin 활성 + 다른 번호 클릭은 footer가 disabled로 막아 여기까지 안 옴.
	 */
	function onPaneNumClick(n: number): void {
		if (pinnedOrdinal === n) {
			pinnedOrdinal = null;
			pinDetached = false;
			// Task 5에서 persistPinToNote(null) 추가
			return;
		}
		if (pinnedOrdinal === null && n === spectatorPaneOrdinal) {
			pinnedOrdinal = n;
			pinDetached = false;
			// Task 5에서 persistPinToNote(n) 추가
			return;
		}
		client?.selectPane(n);
	}
```

- [ ] **Step 3: Footer 버튼 마크업 갱신**

`{#each [1, 2, 3, 4, 5] as n (n)}` 블록을 다음으로 교체:

```svelte
						{#each [1, 2, 3, 4, 5] as n (n)}
							<button
								type="button"
								class="icon pane-num"
								class:active={n === spectatorPaneOrdinal && pinnedOrdinal === null}
								class:pinned={n === pinnedOrdinal}
								class:detached={n === pinnedOrdinal && pinDetached}
								title={n === pinnedOrdinal
									? `패널 ${n} 고정 (해제하려면 다시 누르세요)`
									: `패널 ${n}`}
								onclick={() => onPaneNumClick(n)}
								disabled={status !== 'open'
									|| (spectatorPaneCount > 0 && n > spectatorPaneCount)
									|| (pinnedOrdinal !== null && n !== pinnedOrdinal)}
							>{#if n === pinnedOrdinal}🔒{/if}{n}</button>
						{/each}
```

- [ ] **Step 4: CSS 추가**

`.spec-footer button.pane-num.active` 블록 다음에 추가:

```css
		.spec-footer button.pane-num.pinned {
			background: #2563eb;
			border-color: #5b8def;
			color: #fff;
		}
		.spec-footer button.pane-num.pinned.detached {
			border-color: #f87171;
			box-shadow: inset 0 0 0 1px #f87171;
		}
```

- [ ] **Step 5: 타입 체크 + dev 서버 수동 확인**

Run: `cd app && npm run check`
Expected: 0 errors.

수동: `cd app && npm run dev` → 터미널 노트(spectator) 열기 → 활성 패널 버튼 한 번 더 누름 → 🔒 표시 + 다른 번호 disabled 확인 → 자물쇠 다시 누르면 해제.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): spectator pin state + footer toggle UI"
```

---

## Task 4: `onPaneSwitch` / `onData` 분기 + re-attach 트리거 + detach 배너

**Goal:** Pin 활성 시 `pane-switch` 프레임을 보고 detach 결정, `pinDetached`이면 `onData` 무시, 클릭/타이핑 시 자동 re-attach. 마운트 시 pin이 있으면 자동 `selectPane`.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] Pin 활성 + active≠N → `pinDetached=true`, xterm에 새 데이터 안 들어감 (옛 화면 정지)
- [ ] Pin 활성 + active=N → `pinDetached=false`, 정상 표시
- [ ] `paneOrdinal === 0` (구버전 bridge / unknown) → detach 결정 보류, 다른 spectator state는 갱신
- [ ] 클릭 또는 데스크탑 키 입력 시 `client.selectPane(pinnedOrdinal)` 호출, 결과 `pane-switch`로 자동 attach
- [ ] 모바일 보내기 popup의 submit / quick key / 이미지 전송 시에도 re-attach
- [ ] WS open 시 `pinnedOrdinal !== null`이면 `selectPane(pinnedOrdinal)` 자동 호출 (초기 attach)
- [ ] WS 재연결(`reconnect()`) 시 `pinnedOrdinal` 유지, `pinDetached=false` 리셋, `selectPane` 자동 재호출
- [ ] Detach 중일 때 화면 상단에 안내 배너 표시: "패널 N번 고정 — 현재 비활성. 화면을 클릭하면 다시 부착됩니다."

**Verify:** 수동 — `cd app && npm run dev` → 노트 두 개 열고(데스크탑 + 모바일 가정) 데스크탑에서 패널 옮기면 모바일은 detach 배너 + 정지 → 모바일 화면 클릭/키 입력 → re-attach.

**Steps:**

- [ ] **Step 1: `reattachIfPinned` 헬퍼**

`onPaneNumClick` 함수 다음에 추가:

```ts
	/**
	 * If pin is active AND we're currently detached, send select-pane(N) to
	 * pull the active pane back to our pinned ordinal. The resulting
	 * pane-switch frame flips pinDetached=false naturally.
	 *
	 * Wired into every user-input path: page click, desktop keyboard,
	 * mobile send popup, image send. The bridge silently no-ops if the
	 * ordinal is past list-panes count — pinDetached stays true and the
	 * banner keeps showing.
	 */
	function reattachIfPinned(): void {
		if (pinnedOrdinal !== null && pinDetached) {
			client?.selectPane(pinnedOrdinal);
		}
	}
```

- [ ] **Step 2: `handlePageClick`에 re-attach 추가**

기존:
```ts
	function handlePageClick(): void {
		refocusTerminal();
	}
```
교체:
```ts
	function handlePageClick(): void {
		reattachIfPinned();
		refocusTerminal();
	}
```

- [ ] **Step 3: `onPaneSwitch` 분기**

마운트 시 client 생성 블록의 `onPaneSwitch` 콜백(`onPaneSwitch: (info) => { ... }`)을 다음으로 교체:

```ts
				onPaneSwitch: (info) => {
					if (pinnedOrdinal === null) {
						applyPaneSwitch(info);
						try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
						requestAnimationFrame(() => applySpectatorFit());
						return;
					}
					// Pin mode — header/footer info always reflects the desktop's
					// current active pane so the user can see what's happening over there.
					spectatorPaneOrdinal = info.paneOrdinal;
					spectatorPaneCount = info.paneCount;
					spectatorWindowIndex = info.windowIndex;
					spectatorWindowName = info.windowName;
					// Older bridges (or unknown) report 0 — can't decide attach state.
					// Keep last-known pinDetached, skip resize.
					if (info.paneOrdinal === 0) return;
					if (info.paneOrdinal === pinnedOrdinal) {
						spectatorPaneId = info.paneId;
						spectatorCols = info.cols;
						spectatorRows = info.rows;
						pinDetached = false;
						try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
						requestAnimationFrame(() => applySpectatorFit());
					} else {
						// Active moved elsewhere. Set detach synchronously so the
						// follow-up `data` frames (the new pane's seed) are dropped
						// by onData. Old spectatorPaneId/Cols/Rows stay so the header
						// still shows "we're stuck on pane X".
						pinDetached = true;
					}
				},
```

`reconnect()`의 `onPaneSwitch` 콜백도 동일 패턴으로 교체 (raf 호출은 생략 가능 — 기존 reconnect 콜백 패턴 유지하되 pin 분기 추가):

```ts
				onPaneSwitch: (info) => {
					if (pinnedOrdinal === null) {
						applyPaneSwitch(info);
						try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
						return;
					}
					spectatorPaneOrdinal = info.paneOrdinal;
					spectatorPaneCount = info.paneCount;
					spectatorWindowIndex = info.windowIndex;
					spectatorWindowName = info.windowName;
					if (info.paneOrdinal === 0) return;
					if (info.paneOrdinal === pinnedOrdinal) {
						spectatorPaneId = info.paneId;
						spectatorCols = info.cols;
						spectatorRows = info.rows;
						pinDetached = false;
						try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
					} else {
						pinDetached = true;
					}
				},
```

- [ ] **Step 4: `onData` 분기**

마운트 시 client 생성 블록의 `onData`:

```ts
				onData: (chunk) => {
					if (term) {
						term.write(chunk, () => {
							if (isSpectator) recomputeScroll();
						});
					}
				},
```
교체:
```ts
				onData: (chunk) => {
					if (pinDetached) return;
					if (term) {
						term.write(chunk, () => {
							if (isSpectator) recomputeScroll();
						});
					}
				},
```

`reconnect()`의 `onData`도 동일하게 `if (pinDetached) return;` 추가.

- [ ] **Step 5: `onPaneResize` 분기**

마운트 시와 `reconnect()`의 `onPaneResize` 콜백에 `pinDetached` 가드 추가:

```ts
				onPaneResize: ({ cols, rows }) => {
					if (pinDetached) return;
					spectatorCols = cols;
					spectatorRows = rows;
					try { term?.resize(cols, rows); } catch { /* ignore */ }
					requestAnimationFrame(() => applySpectatorFit());
				},
```

(`reconnect()`에서는 raf 라인 없이 기존 패턴 유지)

- [ ] **Step 6: 마운트 직후 자동 selectPane**

`onStatus` 콜백에서 `s === 'open'`일 때 자동 호출. 마운트 client의 onStatus 끝에 추가:

```ts
				onStatus: (s, info) => {
					status = s;
					if (info?.message) statusMessage = info.message;
					else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
					else if (s === 'open') statusMessage = '';
					else if (s === 'connecting') statusMessage = '';
					if (!isSpectator && s === 'open' && !connectFired) {
						connectFired = true;
						void runConnectScript(spec.connect, (line) => client?.send(line));
					}
					// 관전 모드 + pin 활성 → 자동 attach. Bridge first reports the
					// desktop's actual active pane via pane-switch; we then nudge it
					// to our pinned ordinal. The first pane-switch may briefly
					// show pinDetached=true before the second arrives — minor flicker.
					if (isSpectator && s === 'open' && pinnedOrdinal !== null) {
						client?.selectPane(pinnedOrdinal);
					}
				},
```

`reconnect()`의 `onStatus`에도 동일한 마지막 if 블록 추가.

`reconnect()`의 `resetSpectatorState()` 호출 다음 라인에 추가:

```ts
		resetSpectatorState();
		pinDetached = false; // 재연결 직후엔 detach 결정 보류 (마운트 시와 동일)
```

- [ ] **Step 7: 데스크탑 키 입력에 re-attach 트리거**

마운트의 `term.onData(...)` 콜백:

```ts
		term.onData((data) => {
			if (isSpectator && isMobile) return;
			client?.send(data);
		});
```
교체:
```ts
		term.onData((data) => {
			if (isSpectator && isMobile) return;
			reattachIfPinned();
			client?.send(data);
		});
```

- [ ] **Step 8: 모바일 보내기 popup에 re-attach 트리거**

`sendPopupSubmit`, `sendQuickKey`에 진입 시 호출 추가:

```ts
	function sendPopupSubmit(autoExecute: boolean): void {
		const text = sendPopupText;
		if (!text && !autoExecute) {
			closeSendPopup();
			return;
		}
		reattachIfPinned();
		client?.sendCommand(text, autoExecute);
		closeSendPopup();
	}
	function sendQuickKey(bytes: string): void {
		reattachIfPinned();
		client?.send(bytes);
	}
```

`sendImageFile` 함수 시작부 (validateImageFile 직전):

```ts
	async function sendImageFile(file: File): Promise<void> {
		reattachIfPinned();
		const v = validateImageFile(file);
		// ... 나머지 그대로
```

- [ ] **Step 9: Detach 배너 추가**

`{#if statusMessage}` 블록 다음, `{#if shellHintVisible}` 블록 직전에 추가:

```svelte
	{#if pinDetached}
		<div class="banner banner-pin-detached">
			패널 {pinnedOrdinal}번 고정 — 현재 비활성. 화면을 클릭하면 다시 부착됩니다.
		</div>
	{/if}
```

CSS 끝(`.banner-hint a { color: #9bf; }` 근처)에 추가:

```css
		.banner-pin-detached {
			background: #3a3a4a;
			color: #cfe;
			font-size: 0.78rem;
		}
```

- [ ] **Step 10: 타입 체크 + 수동 확인**

Run: `cd app && npm run check`
Expected: 0 errors.

수동:
1. spectator 노트 열기. 활성 패널 버튼 더블클릭 → 🔒 표시.
2. 데스크탑에서 다른 패널로 이동 → 모바일 화면 정지 + 배너 표시.
3. 모바일 화면 탭 → 자동 re-attach (데스크탑 active도 N으로 돌아감).
4. 데스크탑에서 또 다른 패널로 이동 → 다시 detach.
5. `« »`로 윈도우 이동 → 새 윈도우 N번 attach 또는 detach.
6. 노트 닫고 다시 열기 → pin 유지 안 됨 (저장은 Task 5).

- [ ] **Step 11: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): pin-aware pane-switch / data routing + auto-reattach"
```

---

## Task 5: 자물쇠 토글 → 노트 자동 저장 (`persistPinToNote`)

**Goal:** 자물쇠 토글 시 노트 본문 `spectate:` 라인을 `rewriteSpectateLine`으로 갱신하고 `putNote` + `formatTomboyDate`로 저장. 다음에 노트를 다시 열어도 pin 상태가 유지된다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] 자물쇠 토글 시 노트가 IDB에 저장됨 (xmlContent 갱신 + changeDate/metadataChangeDate 현재 시각)
- [ ] 토글 → 노트 닫고 다시 열기 → pin 상태 복원 (자물쇠 표시 + view가 N번에 시작)
- [ ] spectate 라인이 사라진 노트로 편집됐을 경우 에러 토스트 표시 (in-memory pin은 유지)
- [ ] `putNote` 사용 (localDirty=true → Dropbox/Firebase로 propagate)

**Verify:** 수동 — spectator 노트에서 자물쇠 토글 → `/admin/browse`에서 노트 본문 확인 → `spectate: main:3` 확인.

**Steps:**

- [ ] **Step 1: import 추가**

`TerminalView.svelte` 상단 import 블록에 추가/수정:

```ts
	import { getNote, putNote } from '$lib/storage/noteStore.js';
	import { formatTomboyDate } from '$lib/core/note.js';
	import { parseTerminalNote, rewriteSpectateLine } from './parseTerminalNote.js';
```

(이미 `getNote`와 `parseTerminalNote`가 import되어 있으므로 `putNote` 추가, `formatTomboyDate` 신규 import, `rewriteSpectateLine` 추가.)

- [ ] **Step 2: `persistPinToNote` 헬퍼**

`reattachIfPinned` 함수 다음에 추가:

```ts
	/**
	 * Persist the current pin state to the note by rewriting its `spectate:`
	 * line. Called on every lock-icon toggle. `putNote` marks the note dirty
	 * so Dropbox/Firebase sync propagates the change. changeDate +
	 * metadataChangeDate bumps are required so firebase sees it as a real edit.
	 *
	 * If the note no longer has a spectate: line (user removed it manually),
	 * rewriteSpectateLine returns the input unchanged — we surface a toast and
	 * keep in-memory pin so the user isn't silently betrayed.
	 */
	async function persistPinToNote(n: number | null): Promise<void> {
		const sessionName = spec.spectate;
		if (!sessionName) return; // shouldn't happen — pin is spectator-only
		const note = await getNote(guid);
		if (!note) return;
		const updated = rewriteSpectateLine(note.xmlContent, sessionName, n);
		if (updated === note.xmlContent) {
			pushToast('고정을 저장할 수 없습니다 (노트 형식이 바뀌었습니다)', { kind: 'error' });
			return;
		}
		const now = formatTomboyDate(new Date());
		await putNote({
			...note,
			xmlContent: updated,
			changeDate: now,
			metadataChangeDate: now
		});
	}
```

- [ ] **Step 3: `onPaneNumClick`에 persist 호출 추가**

Task 3에서 만든 `onPaneNumClick`을 `async`로 바꾸고 persist 호출:

```ts
	async function onPaneNumClick(n: number): Promise<void> {
		if (pinnedOrdinal === n) {
			pinnedOrdinal = null;
			pinDetached = false;
			await persistPinToNote(null);
			return;
		}
		if (pinnedOrdinal === null && n === spectatorPaneOrdinal) {
			pinnedOrdinal = n;
			pinDetached = false;
			await persistPinToNote(n);
			return;
		}
		client?.selectPane(n);
	}
```

`onclick` 콜백은 `await` 안 해도 됨 — Svelte가 async 핸들러를 그대로 받음 (`onclick={() => onPaneNumClick(n)}`).

- [ ] **Step 4: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 5: 수동 검증**

1. spectator 노트 열기 → 활성 패널 버튼 더블클릭 (자물쇠)
2. 노트 닫고 다시 열기 → 🔒 표시 유지 + view가 N번에 시작
3. `/admin/browse` 가서 노트 파일 본문 확인 → `spectate: main:3` 같이 `:N` 추가됨
4. 자물쇠 다시 누름 → `:N` 사라짐, 일반 자동 따라가기로 복귀
5. 노트 본문을 직접 편집해서 `spectate:` 라인 지운 다음 자물쇠 토글 시도 → 에러 토스트

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): persist spectator pin to note (spectate: <s>:<N>)"
```

---

## Task 6: 데스크탑 키보드 단축키 가드

**Goal:** Pin 활성 중에 `Ctrl+H` / `Ctrl+L` (prev/next-pane)을 무효화 — footer 1~5 disabled 정책과 일관. `Ctrl+Shift+H` / `Ctrl+Shift+L` (prev/next-window)는 그대로 동작 — « » 정책과 일관.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] Pin 활성 + `Ctrl+H`/`Ctrl+L` → 무효 (이벤트 흡수, tmuxNav 호출 안 함)
- [ ] Pin 활성 + `Ctrl+Shift+H`/`Ctrl+Shift+L` → 그대로 prev/next-window 동작
- [ ] Pin 없음 → 기존 동작 그대로
- [ ] 키 이벤트가 xterm에 leak되지 않음 (e.preventDefault + stopPropagation 유지)

**Verify:** 수동 — 데스크탑 spectator 노트에서 자물쇠 켜고 `Ctrl+L` → 아무 변화 없어야. `Ctrl+Shift+L` → 다음 윈도우로 이동.

**Steps:**

- [ ] **Step 1: `handleWindowKeydown` 수정**

기존 마지막 부분:
```ts
		if (e.shiftKey) {
			tmuxNav(k === 'h' ? 'prev-window' : 'next-window');
		} else {
			tmuxNav(k === 'h' ? 'prev-pane' : 'next-pane');
		}
```
교체:
```ts
		if (e.shiftKey) {
			tmuxNav(k === 'h' ? 'prev-window' : 'next-window');
		} else {
			// Pin 활성 중에는 pane shift도 footer 1~5처럼 비활성.
			// 이벤트는 이미 preventDefault 했으므로 ^H/^L이 셸로 가지는 않음.
			if (pinnedOrdinal !== null) return;
			tmuxNav(k === 'h' ? 'prev-pane' : 'next-pane');
		}
```

- [ ] **Step 2: 수동 검증**

데스크탑에서:
1. spectator 노트 + pin 없음 → `Ctrl+L` → 다음 패널로 이동
2. 자물쇠 켜기 → `Ctrl+L` → 아무 변화 없음, 셸에도 `^L` 안 감
3. `Ctrl+Shift+L` → 다음 윈도우로 이동 (pin 유지)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): suppress Ctrl+H/L pane shift when pin is active"
```

---

## Task 7: CLAUDE.md 갱신

**Goal:** `tomboy-terminal` 섹션에 spectator pin 동작을 1~2단락으로 설명. 다음 세션에서 이 영역을 건드릴 때 context로 사용됨.

**Files:**
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `tomboy-terminal` 섹션에 spectator pin 동작 단락 추가
- [ ] 노트 포맷 (`spectate: main:3`)이 명시됨
- [ ] 클라이언트 전담(bridge 변경 없음)이라는 점 명시됨
- [ ] detach 안전 패턴 (재진입 시 깜빡임, 패널 없음 시 정지) 짧게 언급

**Verify:** `git diff CLAUDE.md` → 변경 내용이 합리적인지 검토.

**Steps:**

- [ ] **Step 1: 단락 추가**

`CLAUDE.md`의 `## 터미널 노트 (SSH terminal in a note)` 섹션 안, `Spectator (mobile-side observer ...)` 단락 끝에 다음을 추가:

```markdown

**관전 패널 고정 (pin)**: spectator footer의 1~5 버튼 중 현재 활성 번호를
한 번 더 누르면 그 패널을 고정 관전. 자물쇠(🔒) 표시. 다시 누르면 해제.
영속 형식은 `spectate: <session>:<N>` (예: `spectate: main:3`) — 자물쇠
토글 시 노트 자동 저장(`rewriteSpectateLine`). 동작은 전부
**클라이언트(`TerminalView.svelte`) 전담** — bridge / WS 프로토콜 변경
없음. Pin 활성 + 데스크탑 active≠N → `pinDetached=true`로 `onData`를
무시해 마지막 본 화면이 정지 + 안내 배너 표시. 노트 화면 클릭 또는 키
입력 시 자동으로 `selectPane(N)`을 호출해 데스크탑 active를 끌어옴
(고정은 유지). 같은 세션을 여러 노트에서 동시에 관전해도 각 노트가
독립 SpectatorSession이라 충돌 없음.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document spectator pane pin behavior"
```

---

## Task 8: 통합 회귀 + 최종 검증

**Goal:** 전체 테스트 + 타입 체크를 다시 돌려 회귀가 없는지 확인하고, 엣지 케이스를 수동으로 확인.

**Files:** (없음 — 검증 전용)

**Acceptance Criteria:**
- [ ] `npm run test` 전 테스트 통과
- [ ] `npm run check` 0 errors
- [ ] 수동 엣지 케이스 시나리오 7개 통과 (아래 Steps)

**Verify:** `cd app && npm run test && npm run check` → 둘 다 성공

**Steps:**

- [ ] **Step 1: 자동 테스트**

```bash
cd app && npm run test
cd app && npm run check
```
Expected: 둘 다 성공. 새 테스트 (`parseTerminalNote.test.ts` 신규 + `rewriteSpectateLine.test.ts`) 포함 모두 PASS.

- [ ] **Step 2: 수동 엣지 케이스**

데스크탑 + 모바일에서 (혹은 두 브라우저 탭) spectator 노트를 동시에 열고:

1. **기본 흐름**: 활성 버튼 더블클릭 → 🔒 → 데스크탑에서 패널 이동 → 배너 + 정지 → 모바일 탭 클릭 → 자동 re-attach.
2. **윈도우 이동 (« »)**: pin 켠 채 « 누르기 → 새 윈도우 N번 표시. 새 윈도우에 N번이 없으면 detach 배너만 표시 (다음 « 누르면 또 시도).
3. **다른 번호 disabled**: pin 중 1~5의 다른 번호 버튼이 회색/반응 안 함.
4. **노트 닫고 다시 열기**: pin 유지. 본문에 `:N` 보존.
5. **자물쇠 토글 해제**: 자물쇠 다시 클릭 → 본문 `:N` 사라짐 → 일반 자동 따라가기 복귀.
6. **포맷 깨짐 시나리오**: 노트 편집 모드 → spectate 라인 제거 → 일반 노트로 fallback → 다시 spectate 추가 → 노트 열기 → spectator 모드 + pin 없음으로 시작.
7. **두 노트 동시 관전 — 한쪽만 pin**: 한 노트는 pin 안 하고 자동 따라가기, 다른 노트는 pin. pin한 쪽이 detach 됐을 때 다른 노트는 정상 동작. 영향 없음.

- [ ] **Step 3: 모든 시나리오 통과 시 종료**

(commit 없음 — 검증 task)

---

## Self-Review

스펙 커버리지 체크:

| 스펙 결정사항 | 구현 task |
|---|---|
| `pinnedPane` 필드 + 파싱 | Task 1 |
| `rewriteSpectateLine` 헬퍼 | Task 2 |
| `pinnedOrdinal` / `pinDetached` state | Task 3 |
| Footer 자물쇠 토글 + disabled 정책 | Task 3 |
| `onPaneSwitch` / `onData` 분기 | Task 4 |
| `paneOrdinal === 0` 가드 | Task 4 |
| Re-attach 트리거 (클릭/타이핑/보내기/이미지) | Task 4 |
| 마운트/재연결 시 자동 selectPane | Task 4 |
| Detach 배너 | Task 4 |
| « » 윈도우 nav (pin 유지) | Task 4 (기존 코드 그대로 — pin 분기에서 windowIndex/Name만 갱신, 동작 변화 없음) |
| 노트 자동 저장 | Task 5 |
| spectate 라인 없음 → 에러 토스트 | Task 5 |
| 데스크탑 단축키 Ctrl+H/L 가드 | Task 6 |
| CLAUDE.md 갱신 | Task 7 |
| 통합 검증 | Task 8 |
| 동시 관전 분리 | (자동 — bridge가 노트별 SpectatorSession 띄움. Task 8 시나리오 7로 검증) |
| 같은 노트 이중 열기 분기 허용 | (스펙에서 허용 명시. 별도 task 불필요) |

타입 일관성: `pinnedOrdinal` / `pinDetached` 이름은 Task 3~6에서 일관. `rewriteSpectateLine` 시그니처 (`xml: string, session: string, n: number | null`)는 Task 2 정의 + Task 5 호출 일치. `persistPinToNote(n: number | null)`은 Task 5 정의 + Task 3 분기 일치 (Task 5에서 onPaneNumClick async화).

플레이스홀더: 없음.

스펙에 있는데 plan에 없는 항목 없음.
