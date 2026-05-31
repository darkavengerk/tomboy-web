# 모바일 모디파이어 바 좌측 고정 + Alt+J 각주 삽입 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alt 잠금 버튼이 모바일 단축키 트레이의 왼쪽에 고정되도록 마크업을 재배치하고, 각주 모듈에 `insertFootnote` 명령을 추가해 Alt+J 단축키(물리 키보드) + Alt-row J 버튼(모바일) 으로 호출 가능하게 만든다.

**Architecture:** 셋 다 독립적이라 4개 commit 으로 분리. Task 1 (A) 는 Toolbar.svelte 의 두 `{#if}` 블록 자리만 교환하는 순수 마크업 변경. Task 2 (B core) 는 `buildInsertFootnoteTransaction` 순수 함수 + 전체 단위 테스트 (TDD). Task 3 (B+C wire) 는 함수를 `TomboyFootnote.addCommands` 로 노출하고 `TomboyEditor.svelte` 의 `handleKeyDown` 에 Alt+J 분기 추가. Task 4 (C mobile) 는 Toolbar 의 Alt-row 에 `J` 버튼 추가 + `runAlt` 시그니처 확장.

**Tech Stack:** SvelteKit (Svelte 5 runes), TipTap 3, ProseMirror, vitest, @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-05-24-mobile-modifier-bar-and-alt-footnote-design.md`

---

## Task 1: Alt 잠금 버튼 좌측 고정 (A)

**Goal:** Toolbar.svelte 의 Alt-row 와 Alt-toggle 블록의 자리를 교환해 Alt 잠금 시 잠금 버튼이 왼쪽에 남고 단축키가 오른쪽으로 펼쳐지게 만든다.

**Files:**
- Modify: `app/src/lib/editor/Toolbar.svelte` (lines 224-244)

**Acceptance Criteria:**
- [ ] DOM 순서가 `[Ctrl-tog] [Ctrl-row] [Alt-tog] [Alt-row]` 로 바뀐다 (현 `[Ctrl-tog] [Ctrl-row] [Alt-row] [Alt-tog]` 에서).
- [ ] Ctrl 잠금 상태에서 렌더링 결과는 그대로 `[Ctrl] [↵DSHMOK]` (회귀 없음).
- [ ] Alt 잠금 상태에서 렌더링 결과는 `[Alt] [←↑↓→]` (잠금 버튼이 왼쪽).
- [ ] 둘 다 off 상태에서는 `[Ctrl] [Alt]` 로 두 잠금 버튼만 보임.
- [ ] CSS, state, 이벤트 핸들러는 무변경.

**Verify:** `cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts` → PASS.

**Steps:**

- [ ] **Step 1: Write the failing component test**

새 파일 `app/tests/unit/editor/toolbarModifierOrder.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Toolbar from '$lib/editor/Toolbar.svelte';
import { modKeys } from '$lib/desktop/modKeys.svelte.js';

afterEach(() => {
	cleanup();
	// modKeys is a module-level singleton — reset between tests.
	if (modKeys.ctrlLocked) modKeys.toggleCtrlLock();
	if (modKeys.altLocked) modKeys.toggleAltLock();
});

/**
 * Returns the visible direct children of `.key-tray` in DOM order, each
 * mapped to a short tag for assertion convenience.
 */
function trayLayout(container: HTMLElement): string[] {
	const tray = container.querySelector('.key-tray');
	if (!tray) return [];
	return Array.from(tray.children).map((el) => {
		if (!(el instanceof HTMLElement)) return 'unknown';
		if (el.classList.contains('mod-toggle')) {
			const label = el.querySelector('.mod-label')?.textContent?.trim() ?? '';
			return `tog:${label}`;
		}
		if (el.classList.contains('key-row')) {
			return `row:${el.getAttribute('aria-label') ?? ''}`;
		}
		return el.tagName.toLowerCase();
	});
}

describe('Toolbar modifier tray order', () => {
	it('둘 다 off — Ctrl 토글, Alt 토글 순서', () => {
		const { container } = render(Toolbar, { props: { editor: null } });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'tog:Alt']);
	});

	it('Ctrl 잠금 — Ctrl 토글이 왼쪽, Ctrl 단축키가 오른쪽', () => {
		modKeys.toggleCtrlLock();
		const { container } = render(Toolbar, { props: { editor: null } });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'row:Ctrl 단축키']);
	});

	it('Alt 잠금 — Alt 토글이 왼쪽, Alt 단축키가 오른쪽', () => {
		modKeys.toggleAltLock();
		const { container } = render(Toolbar, { props: { editor: null } });
		expect(trayLayout(container)).toEqual(['tog:Alt', 'row:Alt 단축키']);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts
```

Expected: "Alt 잠금" 테스트 FAIL (현재 순서가 `['row:Alt 단축키', 'tog:Alt']`).

- [ ] **Step 3: Swap the two `{#if}` blocks**

`app/src/lib/editor/Toolbar.svelte` 의 라인 224-244 를 다음으로 교체.

찾을 코드 (BEFORE):

```svelte
			{#if altLocked}
				<div class="key-row" aria-label="Alt 단축키">
					<button class="key-btn" onclick={() => runAlt('left')} title="내어쓰기 (Alt+←)">←</button>
					<button class="key-btn" onclick={() => runAlt('up')} title="위로 이동 (Alt+↑)">↑</button>
					<button class="key-btn" onclick={() => runAlt('down')} title="아래로 이동 (Alt+↓)">↓</button>
					<button class="key-btn" onclick={() => runAlt('right')} title="들여쓰기 (Alt+→)">→</button>
				</div>
			{/if}

			{#if !ctrlLocked}
				<button
					class="mod-toggle"
					class:active={altLocked}
					onclick={() => modKeys.toggleAltLock()}
					title="Alt 고정 — 리스트 들여쓰기/순서 변경 단축키 표시"
					aria-pressed={altLocked}
				>
					<span class="mod-label">Alt</span>
					<span class="mod-dot" aria-hidden="true"></span>
				</button>
			{/if}
```

교체 (AFTER — `{#if !ctrlLocked}` 블록을 먼저, `{#if altLocked}` 블록을 뒤로):

```svelte
			{#if !ctrlLocked}
				<button
					class="mod-toggle"
					class:active={altLocked}
					onclick={() => modKeys.toggleAltLock()}
					title="Alt 고정 — 리스트 들여쓰기/순서 변경 단축키 표시"
					aria-pressed={altLocked}
				>
					<span class="mod-label">Alt</span>
					<span class="mod-dot" aria-hidden="true"></span>
				</button>
			{/if}

			{#if altLocked}
				<div class="key-row" aria-label="Alt 단축키">
					<button class="key-btn" onclick={() => runAlt('left')} title="내어쓰기 (Alt+←)">←</button>
					<button class="key-btn" onclick={() => runAlt('up')} title="위로 이동 (Alt+↑)">↑</button>
					<button class="key-btn" onclick={() => runAlt('down')} title="아래로 이동 (Alt+↓)">↓</button>
					<button class="key-btn" onclick={() => runAlt('right')} title="들여쓰기 (Alt+→)">→</button>
				</div>
			{/if}
```

CSS, state, 이벤트 핸들러 무변경.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 5: Run full check to confirm no regressions**

```bash
cd app && npm run check && npx vitest run
```

Expected: type check 0 error, 모든 단위 테스트 통과.

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.claude/worktrees/tigress
git add app/src/lib/editor/Toolbar.svelte app/tests/unit/editor/toolbarModifierOrder.test.ts
git commit -m "fix(toolbar): Alt 잠금 시 토글 버튼을 왼쪽 고정"
```

---

## Task 2: buildInsertFootnoteTransaction 순수 함수 + 단위 테스트 (B core)

**Goal:** `app/src/lib/editor/footnote/insertCommand.ts` 에 순수 함수 `buildInsertFootnoteTransaction(state)` 를 구현 — 커서 위치에 새 참조 삽입, 모든 숫자 라벨을 그룹 단위로 doc-order dense renumber, 본문 끝에 정의 단락 (+ 첫 각주면 `---`) 추가, 커서를 새 정의 단락의 `[^N] ` 뒤로 이동.

**Files:**
- Create: `app/src/lib/editor/footnote/insertCommand.ts`
- Create: `app/tests/unit/editor/footnote/insertCommand.test.ts`

**Acceptance Criteria:**
- [ ] `InsertFootnoteResult` discriminated union 으로 `{ ok: true; tr: Transaction }` 또는 `{ ok: false; reason: 'in-title' | 'inside-existing-marker' }` 반환.
- [ ] 빈 문서 (제목만) → `---` + `[^1] ` 정의 단락 추가.
- [ ] 기존 정의 마커가 하나라도 있으면 새 `---` 안 만들고 정의 단락만 append.
- [ ] 본문 중간에 커서 → 새 참조의 라벨이 doc-order 그룹 순서에 맞게 부여되고 뒤따르는 숫자 라벨들이 +1 씩 밀린다.
- [ ] 같은 숫자 라벨 다중 참조 (예: `[^1]` 가 본문에 N번) → 한 그룹으로 묶여 모두 같은 새 라벨로 치환된다 (공유 의미 보존).
- [ ] 비숫자 라벨 (`[^abc]`, `[^*]`) 은 건드리지 않는다.
- [ ] 커서가 0번 단락(제목) 안 → `ok: false, reason: 'in-title'`.
- [ ] 커서가 기존 `[^N]` 내부 (`from < pos < to`) → `ok: false, reason: 'inside-existing-marker'`. 경계 (`pos === from` 또는 `pos === to`) 는 허용.
- [ ] 셀렉션 영역 (`from !== to`) → 셀렉션을 새 참조로 대체.
- [ ] 커서가 새 정의 단락 끝 (`[^N] ` 의 공백 뒤) 으로 이동.
- [ ] `tr.scrollIntoView()` 호출됨.

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/insertCommand.test.ts` → 모든 테스트 PASS.

**Steps:**

- [ ] **Step 1: Write the failing test file**

새 파일 `app/tests/unit/editor/footnote/insertCommand.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import { buildInsertFootnoteTransaction } from '$lib/editor/footnote/insertCommand.js';

function makeEditor(doc: JSONContent): Editor {
	return new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboyFootnote
		],
		content: doc
	});
}

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

/**
 * Place the cursor at character offset `charOffset` within the textblock
 * at top-level index `paraIndex`. Returns the absolute PM position used.
 */
function setCursor(editor: Editor, paraIndex: number, charOffset: number): number {
	const para = editor.state.doc.child(paraIndex);
	let absStart = 0;
	editor.state.doc.forEach((node, offset, i) => {
		if (i === paraIndex) absStart = offset;
	});
	const pos = absStart + 1 + charOffset; // +1 for paragraph's opening token
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos)))
	);
	return pos;
}

/** Top-level paragraphs as a string array (text content per paragraph). */
function paragraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(node.textContent);
	});
	return out;
}

describe('buildInsertFootnoteTransaction', () => {
	it('빈 문서 — 첫 각주는 --- + [^1] 정의 단락 추가', () => {
		const editor = makeEditor(doc(p('제목'), p('')));
		setCursor(editor, 1, 0);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual(['제목', '[^1]', '---', '[^1] ']);
		editor.destroy();
	});

	it('기존 각주 있으면 --- 안 만들고 정의 단락만 append', () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 이어서'), p('---'), p('[^1] 기존 설명'))
		);
		setCursor(editor, 1, '본문 [^1] 이어서'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'본문 [^1] 이어서[^2]',
			'---',
			'[^1] 기존 설명',
			'[^2] '
		]);
		editor.destroy();
	});

	it('중간 삽입 — 라벨 시퀀스 재계산 ([^1] [^2] 사이에 새 참조 → 새는 [^2], 기존 [^2]는 [^3])', () => {
		const editor = makeEditor(
			doc(
				p('제목'),
				p('[^1] 와 [^2] 사이'),
				p('---'),
				p('[^1] 일'),
				p('[^2] 이')
			)
		);
		// 커서를 '[^1] 와 '와 '[^2]' 사이에 — "[^1] 와 " 다음 (char offset 8)
		setCursor(editor, 1, '[^1] 와 '.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 와 [^2][^3] 사이',
			'---',
			'[^1] 일',
			'[^3] 이',
			'[^2] '
		]);
		editor.destroy();
	});

	it('같은 라벨 다중 참조 — 한 그룹으로 묶여 함께 리넘버', () => {
		const editor = makeEditor(
			doc(p('제목'), p('[^1] 본문 [^2] 또 [^1]'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		// 커서를 끝에
		setCursor(editor, 1, '[^1] 본문 [^2] 또 [^1]'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// '1' 그룹의 첫 등장은 본문 시작 → new '1'
		// '2' 그룹의 첫 등장은 '본문 ' 뒤 → new '2'
		// 새 그룹의 첫 등장은 커서(끝) → new '3'
		// 두 번째 [^1] 도 그룹 '1' 이므로 [^1] 유지
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 본문 [^2] 또 [^1][^3]',
			'---',
			'[^1] 일',
			'[^2] 이',
			'[^3] '
		]);
		editor.destroy();
	});

	it('비숫자 라벨 보존 — [^abc] 는 건드리지 않고 숫자만 리넘버', () => {
		const editor = makeEditor(
			doc(p('제목'), p('[^abc] 와 [^1] 와 [^foo]'), p('---'), p('[^abc] a'), p('[^1] 일'), p('[^foo] f'))
		);
		setCursor(editor, 1, '[^abc] 와 [^1] 와 [^foo]'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 숫자 그룹: '1' (pos = first numeric occurrence), '__NEW__' (pos = 끝)
		// new '1' (was 1), new '2' (was __NEW__)
		// abc, foo 그대로
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^abc] 와 [^1] 와 [^foo][^2]',
			'---',
			'[^abc] a',
			'[^1] 일',
			'[^foo] f',
			'[^2] '
		]);
		editor.destroy();
	});

	it('커서가 제목(0번 단락) 안 → abort with reason "in-title"', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		setCursor(editor, 0, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('in-title');
		editor.destroy();
	});

	it('커서가 기존 [^N] 안 (strictly inside) → abort with reason "inside-existing-marker"', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// "[^1]" 의 '1' 위 — 정확히는 '[^' 뒤 (char offset 4 in 'a [^1] b'  →  a, ' ', '[', '^', '1', ']')
		// strictly inside: pos > from && pos < to
		// 본문 paragraph 의 "[^1]" 은 char index 2~6, 우리는 char index 4 ('1' 앞) 로 세팅
		setCursor(editor, 1, 4);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('inside-existing-marker');
		editor.destroy();
	});

	it('마커 경계 (pos === from) 는 허용 — 마커 바로 앞에 새 참조 삽입', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// "[^1]" 바로 앞 — char offset 2 ('[' 바로 앞)
		setCursor(editor, 1, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 새 참조의 첫 등장 = pos 2, 기존 '1' 의 첫 등장 = pos 2 도. 동률.
		// Map.set 의 시퀀스가 결정 — '1' 이 먼저 등록(매치 스캔), '__NEW__' 가 뒤.
		// sort stable: '1' 먼저 → new '1' = 1, __NEW__ = 2
		// 새 참조 '[^2]' 가 기존 '[^1]' 바로 앞에 삽입.
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'a [^2][^1] b',
			'---',
			'[^1] 일',
			'[^2] '
		]);
		editor.destroy();
	});

	it('셀렉션 영역 (from !== to) → 셀렉션을 새 참조로 대체', () => {
		const editor = makeEditor(doc(p('제목'), p('hello world')));
		// "hello" 를 선택 (char 0..5)
		const paraStart = 0;
		// find absolute pos
		let absStart = 0;
		editor.state.doc.forEach((node, offset, i) => {
			if (i === 1) absStart = offset;
		});
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, absStart + 1, absStart + 1 + 5)
			)
		);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual(['제목', '[^1] world', '---', '[^1] ']);
		editor.destroy();
	});

	it('커서가 새 정의 단락 끝 ([^N] 의 공백 뒤) 로 이동', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		setCursor(editor, 1, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		const sel = editor.state.selection;
		const lastPara = editor.state.doc.lastChild!;
		const lastParaTextEnd = editor.state.doc.content.size - 1;
		expect(sel.from).toBe(lastParaTextEnd);
		expect(sel.$from.parent).toBe(lastPara);
		expect(lastPara.textContent).toBe('[^1] ');
		editor.destroy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run tests/unit/editor/footnote/insertCommand.test.ts
```

Expected: 모든 테스트 FAIL — `buildInsertFootnoteTransaction is not a function` 또는 import resolve 실패.

- [ ] **Step 3: Implement the function**

새 파일 `app/src/lib/editor/footnote/insertCommand.ts`:

```ts
/**
 * 각주 삽입 트랜잭션 빌더 — 순수 함수.
 *
 * 알고리즘:
 *  1) Guard — 커서가 제목 단락 안이거나 기존 마커 내부면 abort.
 *  2) 숫자 라벨 매치를 라벨 단위로 그룹핑 (같은 라벨의 모든 참조+정의 = 한 그룹).
 *     새 참조도 가짜 그룹 '__NEW__' 으로 등록, 첫 등장 위치 = 커서.
 *  3) 그룹들을 첫 등장 위치 오름차순으로 정렬 → 1부터 새 라벨 부여.
 *  4) 치환 + 삽입 작업을 from 내림차순으로 정렬해 적용 (뒤따르는 위치 안 어긋남).
 *     새 참조 삽입은 selection.from..selection.to 범위 — 셀렉션이면 자연 대체.
 *  5) 정의 단락 (+ 첫 각주면 ---) 을 본문 끝에 추가.
 *  6) 커서를 새 정의 단락의 [^N] 뒤 (공백 뒤) 로 이동, scrollIntoView.
 *
 * 비숫자 라벨은 매치 필터에서 제외돼 그대로 보존된다.
 */
import { Fragment } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

import { findFootnoteMatches, findFootnoteAt } from './footnotes.js';

export type InsertFootnoteResult =
	| { ok: true; tr: Transaction }
	| { ok: false; reason: 'in-title' | 'inside-existing-marker' };

const NEW_GROUP_KEY = '__NEW__';

/** 커서가 0번 단락(제목) 안에 있는지. */
function isInTitle(state: EditorState): boolean {
	const $from = state.selection.$from;
	// depth 0 = doc. depth 1 의 index 가 0 이면 제목 단락(또는 그 자손).
	if ($from.depth === 0) return false;
	return $from.index(0) === 0;
}

export function buildInsertFootnoteTransaction(state: EditorState): InsertFootnoteResult {
	// (1) Guard.
	if (isInTitle(state)) return { ok: false, reason: 'in-title' };

	const matches = findFootnoteMatches(state.doc);
	const selFrom = state.selection.from;
	const selTo = state.selection.to;

	// 셀렉션이 없는(=커서) 경우만 마커-내부 체크. 셀렉션은 마커 일부를 통째로
	// 덮어쓰는 의도된 동작이라 허용.
	if (selFrom === selTo) {
		if (findFootnoteAt(matches, selFrom)) {
			return { ok: false, reason: 'inside-existing-marker' };
		}
	}

	// (2) 숫자 그룹 식별.
	const numericMatches = matches.filter((m) => /^\d+$/.test(m.label));
	const groupFirstPos = new Map<string, number>();
	for (const m of numericMatches) {
		if (!groupFirstPos.has(m.label)) groupFirstPos.set(m.label, m.from);
	}
	groupFirstPos.set(NEW_GROUP_KEY, selFrom);

	// (3) 라벨 재할당. 첫 등장 위치 오름차순 → 1..N. Array.sort 가 stable 이라
	// 위치가 같으면 Map 등록 순서 (= 매치 스캔 순서) 가 유지된다.
	const ordered = [...groupFirstPos.entries()].sort((a, b) => a[1] - b[1]);
	const oldToNew = new Map<string, string>();
	ordered.forEach(([key], i) => oldToNew.set(key, String(i + 1)));
	const newLabel = oldToNew.get(NEW_GROUP_KEY)!;

	// (4) 치환/삽입 작업 빌드.
	type Op = { from: number; to: number; text: string };
	const ops: Op[] = numericMatches.map((m) => ({
		from: m.from,
		to: m.to,
		text: `[^${oldToNew.get(m.label)}]`
	}));
	// 새 참조 삽입 (셀렉션이면 그 범위를 대체).
	ops.push({ from: selFrom, to: selTo, text: `[^${newLabel}]` });

	// from 내림차순 + to 내림차순으로 정렬. 정렬 안정성 덕에 같은 from 이면
	// to 큰 쪽이 먼저 적용된다(= 더 넓은 범위가 먼저 처리됨).
	ops.sort((a, b) => b.from - a.from || b.to - a.to);

	const tr = state.tr;
	for (const op of ops) tr.insertText(op.text, op.from, op.to);

	// (5) 정의 단락 (+ 첫 각주면 ---) 을 끝에 추가.
	const hasExistingDef = matches.some((m) => m.isDefinitionMarker);
	const paragraphType = state.schema.nodes.paragraph;
	const defPara = paragraphType.create(null, state.schema.text(`[^${newLabel}] `));
	const toInsert = hasExistingDef
		? [defPara]
		: [paragraphType.create(null, state.schema.text('---')), defPara];
	tr.insert(tr.doc.content.size, Fragment.fromArray(toInsert));

	// (6) 커서를 새 정의 단락 끝 (close 직전 = 공백 바로 뒤) 으로.
	const cursorPos = tr.doc.content.size - 1;
	tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
	tr.scrollIntoView();

	return { ok: true, tr };
}
```

- [ ] **Step 4: Run tests — all PASS**

```bash
cd app && npx vitest run tests/unit/editor/footnote/insertCommand.test.ts
```

Expected: 모든 테스트 (9개) PASS.

- [ ] **Step 5: Full check**

```bash
cd app && npm run check && npx vitest run
```

Expected: 0 type error, 모든 테스트 통과.

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.claude/worktrees/tigress
git add app/src/lib/editor/footnote/insertCommand.ts app/tests/unit/editor/footnote/insertCommand.test.ts
git commit -m "feat(footnote): buildInsertFootnoteTransaction 순수 함수"
```

---

## Task 3: TomboyFootnote.insertFootnote 명령 + Alt+J 키바인딩 + 토스트 (B+C wire)

**Goal:** `buildInsertFootnoteTransaction` 을 TipTap 명령 `editor.commands.insertFootnote()` 로 노출하고, `TomboyEditor.svelte` 의 `handleKeyDown` 에 Alt+J 분기를 추가해 물리 키보드 단축키로 호출 가능하게 만든다. abort 케이스에는 한국어 토스트를 띄운다.

**Files:**
- Modify: `app/src/lib/editor/footnote/index.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (handleKeyDown 의 Alt 블록 라인 ~606-667)

**Acceptance Criteria:**
- [ ] `editor.commands.insertFootnote()` 가 정의되고 호출 시 트랜잭션을 dispatch.
- [ ] abort 케이스 (`in-title`, `inside-existing-marker`) 에서 명령이 `false` 를 반환하고 한국어 토스트를 띄움 (각각 "각주는 본문에서만 삽입할 수 있습니다", "기존 각주 안에서는 삽입할 수 없습니다").
- [ ] `Alt+J` (Ctrl, Cmd, Shift 없이) 가 `insertFootnote` 명령을 호출하고 `preventDefault()` + `return true`.
- [ ] 다른 Alt+ 단축키 (`Alt+←`, `Alt+→`, `Alt+↑`, `Alt+↓`) 회귀 없음.

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/insertCommand.test.ts tests/unit/editor/footnote/extensionCommand.test.ts` → 모두 PASS.

**Steps:**

- [ ] **Step 1: Write the failing extension-command test**

새 파일 `app/tests/unit/editor/footnote/extensionCommand.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';
import { get } from 'svelte/store';

import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import { toasts, _resetForTest } from '$lib/stores/toast.js';

let currentEditor: Editor | null = null;

beforeEach(() => {
	_resetForTest();
});
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

function makeEditor(d: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboyFootnote
		],
		content: d
	});
	currentEditor = editor;
	return editor;
}

function setCursorAt(editor: Editor, paraIndex: number, charOffset: number) {
	let absStart = 0;
	editor.state.doc.forEach((_n, offset, i) => {
		if (i === paraIndex) absStart = offset;
	});
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.near(editor.state.doc.resolve(absStart + 1 + charOffset))
		)
	);
}

describe('TomboyFootnote.commands.insertFootnote', () => {
	it('정상 경로 — 트랜잭션 dispatch, 본문 끝에 정의 단락', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		setCursorAt(editor, 1, 2);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(true);

		const paragraphs: string[] = [];
		editor.state.doc.forEach((n) => paragraphs.push(n.textContent));
		expect(paragraphs).toEqual(['제목', '본[^1]문', '---', '[^1] ']);
	});

	it('in-title — false 반환 + 토스트', () => {
		const editor = makeEditor(doc(p('제목')));
		setCursorAt(editor, 0, 1);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(false);
		const ts = get(toasts);
		expect(ts).toHaveLength(1);
		expect(ts[0].message).toBe('각주는 본문에서만 삽입할 수 있습니다');
		expect(ts[0].kind).toBe('error');
	});

	it('inside-existing-marker — false 반환 + 토스트', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// "[^1]" 안 — char offset 4 ('1' 앞)
		setCursorAt(editor, 1, 4);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(false);
		const ts = get(toasts);
		expect(ts).toHaveLength(1);
		expect(ts[0].message).toBe('기존 각주 안에서는 삽입할 수 없습니다');
		expect(ts[0].kind).toBe('error');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run tests/unit/editor/footnote/extensionCommand.test.ts
```

Expected: 모든 테스트 FAIL — `insertFootnote is not a function on commands`.

- [ ] **Step 3: Add addCommands to TomboyFootnote extension**

`app/src/lib/editor/footnote/index.ts` 전체 교체:

```ts
import { Extension } from '@tiptap/core';

import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';
import { buildInsertFootnoteTransaction } from './insertCommand.js';
import { pushToast } from '$lib/stores/toast.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';
export { buildInsertFootnoteTransaction } from './insertCommand.js';
export type { InsertFootnoteResult } from './insertCommand.js';

const ABORT_TOAST: Record<'in-title' | 'inside-existing-marker', string> = {
	'in-title': '각주는 본문에서만 삽입할 수 있습니다',
	'inside-existing-marker': '기존 각주 안에서는 삽입할 수 없습니다'
};

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyFootnote: {
			/** 커서 위치에 새 각주 참조를 삽입하고 본문 끝에 정의 단락을 추가. */
			insertFootnote: () => ReturnType;
		};
	}
}

export const TomboyFootnote = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return {
			onMissing: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createFootnotePlugin(this.options)];
	},
	addCommands() {
		return {
			insertFootnote:
				() =>
				({ state, dispatch }) => {
					const result = buildInsertFootnoteTransaction(state);
					if (!result.ok) {
						pushToast(ABORT_TOAST[result.reason], { kind: 'error' });
						return false;
					}
					if (dispatch) dispatch(result.tr);
					return true;
				}
		};
	}
});
```

- [ ] **Step 4: Run extension test — all PASS**

```bash
cd app && npx vitest run tests/unit/editor/footnote/extensionCommand.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 5: Wire Alt+J into TomboyEditor handleKeyDown**

`app/src/lib/editor/TomboyEditor.svelte`, Alt 블록 (현 라인 ~606-667) 의 `ArrowDown` 분기 다음, 닫는 `}` 직전에 추가:

```typescript
// 위치: ArrowDown 분기 끝 `return true; }` 와 Alt 블록 닫는 `}` 사이.
if (event.key === "j" || event.key === "J") {
    event.preventDefault();
    ed.chain().focus().insertFootnote().run();
    return true;
}
```

전체 Alt 블록의 끝 부분이 다음과 같이 보여야 한다 (변경 후):

```typescript
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            try {
                                moveListItemDown(ed);
                            } catch (err) {
                                console.error(
                                    "[listItemReorder] operation failed:",
                                    err,
                                );
                            }
                            return true;
                        }
                        if (event.key === "j" || event.key === "J") {
                            event.preventDefault();
                            ed.chain().focus().insertFootnote().run();
                            return true;
                        }
                    }
```

(주: `"j"` 와 `"J"` 둘 다 매치하는 이유는 일부 키보드 레이아웃 + Shift+Alt 조합에서 `event.key` 가 대문자로 들어올 수 있어서. 위 가드의 `!event.shiftKey` 가 이미 Shift+Alt 를 차단하므로 사실 `"j"` 만 와도 되지만 방어적으로 둘 다.)

- [ ] **Step 6: Write a small handleKeyDown integration test (optional but recommended)**

`tests/unit/editor/toolbarShortcuts.test.ts` 의 패턴을 따라, Editor 인스턴스에 직접 `handleKeyDown` 으로 Alt+J KeyboardEvent 를 흘리는 식의 테스트는 ProseMirror 의 view.dom 이 jsdom 환경에서 안정적이지 않다. **handleKeyDown 분기는 수동 검증으로 충분** — Step 8 의 수동 테스트로 커버.

(이 step 은 작업 없음. 다음 step 로.)

- [ ] **Step 7: Type-check and full vitest**

```bash
cd app && npm run check && npx vitest run
```

Expected: 0 type error, 모든 자동 테스트 PASS. 기존 footnote / Alt+Arrow 테스트도 그대로 통과.

- [ ] **Step 8: Manual smoke (physical keyboard)**

데스크탑 dev 서버에서 노트 열고 본문에서 Alt+J → 본문에 `[^1]` 삽입 + 본문 끝에 `---` + `[^1] ` 단락, 커서가 새 단락 끝. 한 번 더 Alt+J → 본문에 `[^2]`, 끝에 `[^2] ` 추가됨 (이미 `---` 있으므로 새로 안 만듦). 제목에서 Alt+J → 토스트 "각주는 본문에서만 삽입할 수 있습니다".

```bash
cd app && npm run dev
# → 브라우저로 http://localhost:5173 접속, 새 노트, Alt+J 시도
```

- [ ] **Step 9: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.claude/worktrees/tigress
git add app/src/lib/editor/footnote/index.ts app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/footnote/extensionCommand.test.ts
git commit -m "feat(footnote): Alt+J 단축키로 각주 삽입"
```

---

## Task 4: Toolbar Alt-row J 버튼 (C mobile)

**Goal:** Toolbar.svelte 의 Alt-row 끝에 `J` 버튼을 추가하고 `runAlt` 시그니처를 `'footnote'` 까지 확장해, 모바일에서 Alt 잠금 → J 탭 → 각주 삽입 흐름이 동작하게 만든다.

**Files:**
- Modify: `app/src/lib/editor/Toolbar.svelte`

**Acceptance Criteria:**
- [ ] Alt-row 의 `→` 다음에 `J` 라벨 버튼이 추가됨 (title="각주 (Alt+J)").
- [ ] `runAlt` 시그니처가 `'left' | 'right' | 'up' | 'down' | 'footnote'` 로 확장됨.
- [ ] `runAlt('footnote')` 가 `editor.chain().focus().insertFootnote().run()` 을 호출.
- [ ] 기존 4개 화살표 버튼 동작 회귀 없음.
- [ ] Alt 잠금 상태에서 DOM 순서: `[tog:Alt] [row:Alt 단축키 — ← ↑ ↓ → J]` (Task 1 의 좌측 고정 + 새 J 버튼).

**Verify:** `cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts` → "Alt 잠금" 테스트가 5개 키 버튼 확인까지 PASS.

**Steps:**

- [ ] **Step 1: Extend the existing Toolbar test to assert J button presence**

`app/tests/unit/editor/toolbarModifierOrder.test.ts` 의 "Alt 잠금" 테스트 끝에 추가:

```ts
	it('Alt 잠금 — Alt-row 안에 ← ↑ ↓ → J 5개 버튼이 순서대로', () => {
		modKeys.toggleAltLock();
		const { container } = render(Toolbar, { props: { editor: null } });
		const row = container.querySelector('.key-row[aria-label="Alt 단축키"]');
		expect(row).not.toBeNull();
		const labels = Array.from(row!.querySelectorAll('button')).map(
			(b) => b.textContent?.trim() ?? ''
		);
		expect(labels).toEqual(['←', '↑', '↓', '→', 'J']);
	});
```

- [ ] **Step 2: Run test to verify the J assertion fails**

```bash
cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts
```

Expected: 새로 추가한 "5개 버튼" 테스트 FAIL (현재 4개 라벨만 있음).

- [ ] **Step 3: Add J button to Alt-row and extend runAlt**

`app/src/lib/editor/Toolbar.svelte` — `runAlt` 함수 (현 라인 96-121) 의 시그니처와 본문 변경.

찾을 코드 (BEFORE):

```typescript
	function runAlt(arrow: 'left' | 'right' | 'up' | 'down') {
		const ed = editor;
		if (!ed) return;
		try {
			if (arrow === 'right') {
```

교체 (AFTER):

```typescript
	function runAlt(key: 'left' | 'right' | 'up' | 'down' | 'footnote') {
		const ed = editor;
		if (!ed) return;
		if (key === 'footnote') {
			ed.chain().focus().insertFootnote().run();
			return;
		}
		try {
			if (key === 'right') {
```

함수 안의 다른 `arrow === 'left' | 'up' | 'down' | 'right'` 참조도 모두 `key === ...` 로 바꿔야 한다 (sink/lift/up/down 분기 4개).

그리고 Alt-row 의 `→` 버튼 다음에 J 버튼 추가. Task 1 결과로 Alt-row 가 토글 뒤로 옮겨갔으므로 현 라인은 ~234-244 영역:

```svelte
			{#if altLocked}
				<div class="key-row" aria-label="Alt 단축키">
					<button class="key-btn" onclick={() => runAlt('left')} title="내어쓰기 (Alt+←)">←</button>
					<button class="key-btn" onclick={() => runAlt('up')} title="위로 이동 (Alt+↑)">↑</button>
					<button class="key-btn" onclick={() => runAlt('down')} title="아래로 이동 (Alt+↓)">↓</button>
					<button class="key-btn" onclick={() => runAlt('right')} title="들여쓰기 (Alt+→)">→</button>
					<button class="key-btn" onclick={() => runAlt('footnote')} title="각주 (Alt+J)">J</button>
				</div>
			{/if}
```

- [ ] **Step 4: Run tests — all PASS**

```bash
cd app && npx vitest run tests/unit/editor/toolbarModifierOrder.test.ts
```

Expected: 4/4 PASS (둘 다 off / Ctrl 잠금 / Alt 잠금 순서 / Alt-row 5개 버튼).

- [ ] **Step 5: Full check**

```bash
cd app && npm run check && npx vitest run
```

Expected: 0 type error, 모든 단위 테스트 PASS.

- [ ] **Step 6: Manual smoke (mobile / responsive devtools)**

```bash
cd app && npm run dev
```

브라우저 devtools 의 mobile preview 또는 실제 폰에서:
1. 노트 열기 → 하단 dock 의 `Alt` 잠금 탭.
2. `[Alt] [← ↑ ↓ → J]` 순서로 표시되는지 (Task 1 + 4 검증).
3. `J` 탭 → 본문에 `[^1]` 삽입, 끝에 `---` + `[^1] `, 키보드가 새 단락에서 자동 팝업, 커서가 공백 뒤.
4. 한 번 더 `J` 탭 → `[^2]` 추가, `---` 신규 생성 안 됨.

- [ ] **Step 7: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.claude/worktrees/tigress
git add app/src/lib/editor/Toolbar.svelte app/tests/unit/editor/toolbarModifierOrder.test.ts
git commit -m "feat(toolbar): Alt-row 에 각주 삽입 J 버튼 추가"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| A. 모디파이어 바 — Alt 잠금 버튼 좌측 고정 | Task 1 |
| B. 각주 삽입 명령 — 알고리즘 1~6단계 | Task 2 (pure function) |
| B. abort 케이스 토스트 | Task 3 (extension wrap) |
| C. 키보드 단축키 Alt+J | Task 3 (handleKeyDown 분기) |
| C. 모바일 J 버튼 | Task 4 |
| 엣지 케이스 표 (제목/마커 안/셀렉션/빈 문서/공유 라벨/비숫자/중간 ---/기존 정의/고아) | Task 2 단위 테스트 8개로 직접 검증 |
| 회귀 — footnote 클릭/스크롤 | Task 2/3 의 full vitest 가 기존 footnote 테스트(있다면) 통과로 확인. `plugin.ts` 무변경. |
| 회귀 — Alt+Arrow | Task 3 의 `altArrowExtended.test.ts` 와 Task 1 의 toolbarModifierOrder 테스트가 함께 보호 |
| 회귀 — noteContentArchiver | 코드 무변경, 별도 테스트 불필요 (spec 명시) |
| 회귀 — hrSplit | `---` 단락은 일반 paragraph, 사용자 토글 전엔 일반 HR (spec 명시), 무변경 |

전 항목 커버. 누락 없음.

**Placeholder scan:**

- "TBD/TODO/fill in" 없음 (검색 완료).
- 모든 코드 step 에 실제 코드 블록 첨부.
- 모든 verify 명령에 expected 결과 명시.

**Type consistency:**

- `InsertFootnoteResult` 타입이 Task 2 정의, Task 3 에서 동일 시그니처로 import.
- `editor.commands.insertFootnote()` 시그니처가 Task 3 의 `declare module` 와 Task 4 의 `runAlt` 호출에서 일치 (no-args, returns boolean).
- `pushToast(message, { kind: 'error' })` 시그니처가 toast.ts 의 실제 export 와 일치.
- `runAlt` 의 매개변수명을 `arrow` → `key` 로 바꾸는 변경이 Task 4 Step 3 에 명시.

문제 없음.
