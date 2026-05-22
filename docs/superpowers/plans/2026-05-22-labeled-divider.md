# Labeled Divider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editor plugin that renders a labeled horizontal divider — a divider line with embedded text — from plain-paragraph markup (`-- label --` centered, `label ---` left-aligned).

**Architecture:** Mirrors the existing `hrSplit` HR pattern: the divider is a plain top-level paragraph storing literal markup; a decoration-only ProseMirror plugin hides the dash runs and styles the label. No schema change, no new node, no serialization work. A pure parser (`parseLabeledDivider`) does the string analysis; the plugin is thin glue mapping parser output onto ProseMirror decorations.

**Tech Stack:** TypeScript, ProseMirror (`@tiptap/pm`), Tiptap, Svelte 5, Vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-05-22-labeled-divider-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `app/src/lib/editor/labeledDivider/parseLabeledDivider.ts` | Pure parser — classifies a string as centered/left/none and returns char-offset ranges. No ProseMirror dependency. |
| `app/src/lib/editor/labeledDivider/labeledDividerPlugin.ts` | ProseMirror plugin — walks top-level paragraphs, emits node + inline decorations from parser output. |
| `app/tests/unit/editor/parseLabeledDivider.test.ts` | Unit tests for the parser. |
| `app/tests/unit/editor/labeledDividerPlugin.test.ts` | Plugin tests via a mounted Tiptap editor + DOM assertions. |
| `app/src/lib/editor/TomboyEditor.svelte` | Registers the plugin extension; holds the CSS that paints the line and styles the label. |

All commands below are run from the `app/` directory of the `tigress` worktree.

---

### Task 1: `parseLabeledDivider` pure parser

**Goal:** A pure, ProseMirror-free function that classifies a paragraph's text as a centered or left labeled divider (or neither) and returns the character ranges of the hidden dash runs and the visible label.

**Files:**
- Create: `app/src/lib/editor/labeledDivider/parseLabeledDivider.ts`
- Test: `app/tests/unit/editor/parseLabeledDivider.test.ts`

**Acceptance Criteria:**
- [ ] `-- label --` (2+ dashes each side) parses as `align: 'center'`.
- [ ] `label ---` (3+ trailing dashes, no leading dashes) parses as `align: 'left'`.
- [ ] Dashes-on-both-sides input resolves to `center` (centered checked first).
- [ ] A pure dash run (`---`, `-----`) returns `null` — never mistaken for a divider.
- [ ] A label that is all-dashes/whitespace, or (for `left`) starts with a dash, returns `null`.
- [ ] Returned ranges exactly cover the input: `leadMark`/`labelRange`/`trailMark` are contiguous and the label range matches the `label` string.

**Verify:** `npx vitest run tests/unit/editor/parseLabeledDivider.test.ts` → all tests pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `app/tests/unit/editor/parseLabeledDivider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLabeledDivider } from '$lib/editor/labeledDivider/parseLabeledDivider.js';

describe('parseLabeledDivider — centered', () => {
	it('parses `-- 회의록 --` as a centered divider', () => {
		const r = parseLabeledDivider('-- 회의록 --');
		expect(r).not.toBeNull();
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toEqual([0, 3]);
		expect(r!.labelRange).toEqual([3, 6]);
		expect(r!.trailMark).toEqual([6, 9]);
	});

	it('accepts long dash runs on either side', () => {
		const r = parseLabeledDivider('-- 회의록 ------------');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
	});

	it('folds extra whitespace into the mark ranges', () => {
		const r = parseLabeledDivider('--   회의록   --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toEqual([0, 5]);
		expect(r!.labelRange).toEqual([5, 8]);
		expect(r!.trailMark).toEqual([8, 13]);
	});

	it('keeps internal spaces inside the label', () => {
		const r = parseLabeledDivider('-- 회의 록 --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의 록');
	});

	it('parses an ASCII label', () => {
		const r = parseLabeledDivider('-- Section --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('Section');
	});
});

describe('parseLabeledDivider — left', () => {
	it('parses `회의록 ---` as a left divider', () => {
		const r = parseLabeledDivider('회의록 ---');
		expect(r).not.toBeNull();
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toBeNull();
		expect(r!.labelRange).toEqual([0, 3]);
		expect(r!.trailMark).toEqual([3, 7]);
	});

	it('accepts a long trailing dash run', () => {
		const r = parseLabeledDivider('회의록 ------------------------');
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
	});

	it('accepts trailing dashes with no separating space', () => {
		const r = parseLabeledDivider('회의록---');
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
		expect(r!.labelRange).toEqual([0, 3]);
		expect(r!.trailMark).toEqual([3, 6]);
	});
});

describe('parseLabeledDivider — precedence', () => {
	it('dashes on both sides resolve to centered', () => {
		const r = parseLabeledDivider('-- 회의록 ---');
		expect(r!.align).toBe('center');
	});
});

describe('parseLabeledDivider — rejected input', () => {
	it.each([
		['---'],
		['-----'],
		['------------'],
		['-- 회의록'],          // no trailing dashes
		['회의록 --'],          // only 2 trailing dashes (left needs 3+)
		['- 회의록 ---'],       // left label starts with a dash
		['--  --'],             // label is only whitespace
		['-- -- --'],           // label is only dashes
		['hello world'],        // plain text
		['']                    // empty
	])('returns null for %j', (input) => {
		expect(parseLabeledDivider(input)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/editor/parseLabeledDivider.test.ts`
Expected: FAIL — cannot resolve `$lib/editor/labeledDivider/parseLabeledDivider.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/editor/labeledDivider/parseLabeledDivider.ts`:

```ts
/**
 * A top-level paragraph whose text forms a labeled divider — a divider
 * line with an embedded text label. Two layouts:
 *
 *   centered:  `-- label --`   2+ dashes on each side
 *   left:      `label ---`     3+ trailing dashes, no leading dashes
 *
 * Distinct from a plain `---` horizontal rule (handled by hrSplit): a
 * labeled divider always carries a real, non-dash label.
 */
export interface LabeledDivider {
	align: 'center' | 'left';
	/** The visible label text, exactly as it appears in the document. */
	label: string;
	/**
	 * Half-open `[start, end)` character ranges into the parsed string.
	 * `leadMark` and `trailMark` are the hidden markup runs (dash runs plus
	 * any adjacent whitespace); `labelRange` is the visible label. The three
	 * ranges are contiguous and cover the whole string. `leadMark` is null
	 * when there is no leading hidden run (the common `label ---` case).
	 */
	leadMark: readonly [number, number] | null;
	labelRange: readonly [number, number];
	trailMark: readonly [number, number];
}

// Centered: leading dash run, label, trailing dash run. `.+?` is minimal so
// the label never absorbs the surrounding whitespace (the greedy `\s*` in
// the adjacent groups claims it first).
const CENTERED = /^(\s*-{2,}\s*)(.+?)(\s*-{2,}\s*)$/;

// Left: optional leading whitespace, label, trailing dash run (3+).
const LEFT = /^(\s*)(.+?)(\s*-{3,}\s*)$/;

/** True when `s` contains a character that is neither dash nor whitespace. */
function hasRealChar(s: string): boolean {
	return /[^\s-]/.test(s);
}

/**
 * Classify `text` as a labeled divider. Returns `null` when it is not one
 * (including plain text and pure `---` horizontal rules).
 */
export function parseLabeledDivider(text: string): LabeledDivider | null {
	// Centered first: dashes-on-both-sides always wins over the left pattern.
	const centered = CENTERED.exec(text);
	if (centered) {
		const [, lead, label, trail] = centered;
		if (hasRealChar(label)) {
			const leadEnd = lead.length;
			const labelEnd = leadEnd + label.length;
			return {
				align: 'center',
				label,
				leadMark: [0, leadEnd],
				labelRange: [leadEnd, labelEnd],
				trailMark: [labelEnd, labelEnd + trail.length]
			};
		}
	}

	const left = LEFT.exec(text);
	if (left) {
		const [, lead, label, trail] = left;
		// Left layout is strictly "text then dashes" — reject a label that
		// itself starts with a dash so `- x ---`-style input stays plain.
		if (hasRealChar(label) && label[0] !== '-') {
			const leadEnd = lead.length;
			const labelEnd = leadEnd + label.length;
			return {
				align: 'left',
				label,
				leadMark: leadEnd > 0 ? [0, leadEnd] : null,
				labelRange: [leadEnd, labelEnd],
				trailMark: [labelEnd, labelEnd + trail.length]
			};
		}
	}

	return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/editor/parseLabeledDivider.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/labeledDivider/parseLabeledDivider.ts app/tests/unit/editor/parseLabeledDivider.test.ts
git commit -m "feat(labeled-divider): 구분선 라벨 마크업 파서 추가"
```

---

### Task 2: `labeledDividerPlugin` ProseMirror plugin

**Goal:** A decoration-only ProseMirror plugin that, for each top-level paragraph (skipping the title + subtitle lines), runs `parseLabeledDivider` and emits a node decoration (class for line + alignment) plus inline decorations (hide the dash runs, style the label).

**Files:**
- Create: `app/src/lib/editor/labeledDivider/labeledDividerPlugin.ts`
- Test: `app/tests/unit/editor/labeledDividerPlugin.test.ts`

**Acceptance Criteria:**
- [ ] A centered-divider paragraph at index ≥ 2 gets a `<p class="tomboy-labeled-divider tomboy-labeled-divider--center">`.
- [ ] A left-divider paragraph gets the `tomboy-labeled-divider--left` class.
- [ ] The label text is wrapped in a `.tomboy-labeled-divider-label` span; the dash runs are wrapped in `.tomboy-labeled-divider-mark` spans.
- [ ] Paragraphs at index 0 and 1 (title / subtitle) are never decorated, even if they match the pattern.
- [ ] Plain paragraphs and pure `---` HR paragraphs are not decorated.
- [ ] Decorations recompute when the document changes (typing ` ---` onto a plain paragraph turns it into a divider).

**Verify:** `npx vitest run tests/unit/editor/labeledDividerPlugin.test.ts` → all tests pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `app/tests/unit/editor/labeledDividerPlugin.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createLabeledDividerPlugin } from '$lib/editor/labeledDivider/labeledDividerPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: string): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyLabeledDividerTest',
				addProseMirrorPlugins() {
					return [createLabeledDividerPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('labeledDividerPlugin', () => {
	it('decorates a centered divider and exposes the label', () => {
		const editor = makeEditor(
			'<p>title</p><p>sub</p><p>-- 회의록 --</p>'
		);
		const dom = editor.view.dom;
		expect(dom.querySelector('p.tomboy-labeled-divider--center')).not.toBeNull();
		const label = dom.querySelector('.tomboy-labeled-divider-label');
		expect(label?.textContent).toBe('회의록');
		expect(dom.querySelectorAll('.tomboy-labeled-divider-mark').length).toBe(2);
	});

	it('decorates a left divider with the left class', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>회의록 ---</p>');
		const dom = editor.view.dom;
		expect(dom.querySelector('p.tomboy-labeled-divider--left')).not.toBeNull();
		expect(dom.querySelector('.tomboy-labeled-divider-label')?.textContent).toBe(
			'회의록'
		);
	});

	it('never decorates the title / subtitle lines (index 0 and 1)', () => {
		const editor = makeEditor(
			'<p>-- 회의록 --</p><p>회의록 ---</p><p>body</p>'
		);
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('does not decorate a plain paragraph', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>hello world</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('does not treat a pure --- HR as a labeled divider', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>-----</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('re-parses live when the paragraph text changes', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>회의록</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
		// Append ' ---' to the end of the last paragraph's content.
		const end = editor.state.doc.content.size - 1;
		editor.view.dispatch(editor.state.tr.insertText(' ---', end));
		expect(
			editor.view.dom.querySelector('p.tomboy-labeled-divider--left')
		).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/editor/labeledDividerPlugin.test.ts`
Expected: FAIL — cannot resolve `$lib/editor/labeledDivider/labeledDividerPlugin.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/editor/labeledDivider/labeledDividerPlugin.ts`:

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseLabeledDivider } from './parseLabeledDivider.js';

export const labeledDividerPluginKey = new PluginKey('tomboyLabeledDivider');

/**
 * Top-level children skipped from divider detection: the title (index 0)
 * and the subtitle / date line (index 1). Matches hrSplit's HEADER_COUNT —
 * those lines always render as headers and must never become a divider.
 */
const HEADER_COUNT = 2;

/**
 * Build the decoration set for the current document. Walks only the
 * top-level children (paragraphs don't nest), so this is cheap to run on
 * every state.
 */
export function buildLabeledDividerDecorations(doc: PMNode): DecorationSet {
	const decos: Decoration[] = [];
	doc.forEach((node, offset, index) => {
		if (index < HEADER_COUNT) return;
		if (node.type.name !== 'paragraph') return;
		const parsed = parseLabeledDivider(node.textContent);
		if (!parsed) return;

		// `offset` is the position just before the paragraph; its inline
		// content starts at `offset + 1`. A character at index `i` in the
		// paragraph text is at document position `offset + 1 + i` — text
		// nodes contribute exactly one position per character.
		const contentStart = offset + 1;

		decos.push(
			Decoration.node(offset, offset + node.nodeSize, {
				class:
					parsed.align === 'center'
						? 'tomboy-labeled-divider tomboy-labeled-divider--center'
						: 'tomboy-labeled-divider tomboy-labeled-divider--left'
			})
		);

		const markRanges: ReadonlyArray<readonly [number, number]> =
			parsed.leadMark ? [parsed.leadMark, parsed.trailMark] : [parsed.trailMark];
		for (const [a, b] of markRanges) {
			if (b > a) {
				decos.push(
					Decoration.inline(contentStart + a, contentStart + b, {
						class: 'tomboy-labeled-divider-mark'
					})
				);
			}
		}

		const [labelFrom, labelTo] = parsed.labelRange;
		decos.push(
			Decoration.inline(contentStart + labelFrom, contentStart + labelTo, {
				class: 'tomboy-labeled-divider-label'
			})
		);
	});
	return DecorationSet.create(doc, decos);
}

/**
 * Renders labeled dividers — top-level paragraphs whose text matches
 * `-- label --` (centered) or `label ---` (left). The literal markup stays
 * in the document (so it round-trips through note save/sync untouched);
 * decorations hide the dash runs and style the label.
 *
 * Decoration-only: this plugin never modifies the document.
 */
export function createLabeledDividerPlugin(): Plugin {
	return new Plugin({
		key: labeledDividerPluginKey,
		props: {
			decorations(state: EditorState) {
				return buildLabeledDividerDecorations(state.doc);
			}
		}
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/editor/labeledDividerPlugin.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/labeledDivider/labeledDividerPlugin.ts app/tests/unit/editor/labeledDividerPlugin.test.ts
git commit -m "feat(labeled-divider): 구분선 데코레이션 ProseMirror 플러그인 추가"
```

---

### Task 3: Register the plugin in the editor and add the divider CSS

**Goal:** Wire `createLabeledDividerPlugin` into `TomboyEditor.svelte`'s extension list and add the CSS that paints the divider line and styles the label, so the feature is live in the running app.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import near the hrSplit import ~line 52-54; new `Extension.create` after the `tomboyHrSplit` extension block ~line 466; CSS after the `tomboy-hr-marker` rules, before `.tomboy-hr-split-active` ~line 1342)

**Acceptance Criteria:**
- [ ] `npm run check` passes (no new type errors).
- [ ] Full test suite (`npm run test`) passes.
- [ ] In the running dev server, typing `-- 회의록 --` on a content line renders a centered divider: a thin grey line with `회의록` in the middle, dashes hidden, no layout shift.
- [ ] Typing `회의록 ---` renders a left divider: a short line stub, then `회의록`, then a long line.
- [ ] The label remains directly editable; a real `---` HR on another line still renders as a plain horizontal line.

**Verify:** `npm run check && npm run test` → both succeed; then `npm run dev` and visually confirm both divider layouts in a note (manual — this task's rendering is visual and cannot be asserted by the unit suite).

**Steps:**

- [ ] **Step 1: Add the import**

In `app/src/lib/editor/TomboyEditor.svelte`, immediately after the existing hrSplit import block:

```js
	import {
		createHrSplitPlugin,
		hrSplitPluginKey,
	} from "./hrSplit/hrSplitPlugin.js";
	import { createLabeledDividerPlugin } from "./labeledDivider/labeledDividerPlugin.js";
```

- [ ] **Step 2: Register the extension**

In the same file, in the `extensions` array, immediately after the `tomboyHrSplit` `Extension.create({...})` block (the one that ends just before `SlipNoteArrows,`), insert:

```js
				Extension.create({
					name: "tomboyLabeledDivider",
					addProseMirrorPlugins() {
						return [createLabeledDividerPlugin()];
					},
				}),
```

So the array reads `...tomboyHrSplit Extension.create({...}), <new block>, SlipNoteArrows, DateArrows, ...`.

- [ ] **Step 3: Add the CSS**

In the same file's `<style>` block, immediately after the `.tomboy-todo-ctrl-hold :global(.tomboy-hr-marker:hover::before)` rule (the last `tomboy-hr-marker` rule, ~line 1342) and before the `.tomboy-editor :global(.tiptap.tomboy-hr-split-active)` rule, insert:

```css
	/* Labeled divider — a divider line with embedded text. The literal
	   markup (`-- label --` / `label ---`) lives in a plain paragraph;
	   labeledDividerPlugin hides the dash runs and styles the label.
	   `::before` paints the line (same gradient/colour as the hr-marker);
	   the label sits above it with an opaque background that punches a
	   gap through the line. */
	.tomboy-editor :global(.tomboy-labeled-divider) {
		position: relative;
		margin: 0.6em 0;
		min-height: 1.2em;
		padding: 0;
	}
	.tomboy-editor :global(.tomboy-labeled-divider--center) {
		text-align: center;
	}
	.tomboy-editor :global(.tomboy-labeled-divider--left) {
		text-align: left;
		/* Left padding leaves a short stub of line before the label. */
		padding-left: 1.6em;
	}
	.tomboy-editor :global(.tomboy-labeled-divider::before) {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 0;
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 0.5px),
			#b0b0b0 calc(50% - 0.5px),
			#b0b0b0 calc(50% + 0.5px),
			transparent calc(50% + 0.5px)
		);
		pointer-events: none;
	}
	/* Dash runs: collapsed to zero width so a long trailing run never
	   shifts layout. Still caret-steppable. */
	.tomboy-editor :global(.tomboy-labeled-divider-mark) {
		font-size: 0;
	}
	/* The visible label. The opaque background must match the editor
	   surface (white) so the label cuts a clean gap through the line
	   drawn behind it. */
	.tomboy-editor :global(.tomboy-labeled-divider-label) {
		position: relative;
		z-index: 1;
		background: #fff;
		padding: 0 0.5em;
		color: #666;
		font-size: 0.85em;
	}
```

- [ ] **Step 4: Run typecheck and the full test suite**

Run: `npm run check && npm run test`
Expected: `svelte-check` reports no new errors; all vitest tests pass (including the two new files from Tasks 1 and 2).

- [ ] **Step 5: Manual visual verification**

Run: `npm run dev`. In a note, on a content line (not the title or the line below it):
- Type `-- 회의록 --` → expect a centered divider: grey line with `회의록` centred, dashes invisible.
- On another line type `회의록 ---` → expect a left divider: short line stub, `회의록`, then a long line.
- On another line type `-----` → expect a plain horizontal rule (unchanged hrSplit behaviour).
- Click into a divider's label and edit the text → the divider updates live.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(labeled-divider): 에디터에 구분선 플러그인 등록 및 스타일 추가"
```

---

## Self-Review

**Spec coverage:**
- Centered `-- label --` syntax → Task 1 parser + Task 2 plugin + Task 3 CSS. ✓
- Left `label ---` syntax → same. ✓
- Live rendering (no input rule, decoration-driven) → Task 2 (`props.decorations` recomputes per state); Task 2 test "re-parses live". ✓
- Visual consistency with `tomboy-hr-marker` → Task 3 CSS reuses the same gradient + `#b0b0b0`. ✓
- hrSplit coexistence / header-line exclusion → Task 2 `HEADER_COUNT` skip; Task 2 test covers it. ✓
- Round-trip through sync → guaranteed by storing literal markup in a plain paragraph (no schema/serialization change); no task needed. ✓
- Pure `---` HR not mis-parsed → Task 1 `hasRealChar` rejection; tested in both Task 1 and Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code; every command has expected output. ✓

**Type consistency:** `LabeledDivider` interface (Task 1) — fields `align`, `label`, `leadMark`, `labelRange`, `trailMark` — consumed unchanged by `buildLabeledDividerDecorations` (Task 2). Function names `parseLabeledDivider`, `createLabeledDividerPlugin`, `buildLabeledDividerDecorations` are consistent across tasks, tests, and the editor import. ✓

**Known limitation (documented, intentionally not handled):** position mapping in Task 2 assumes the divider paragraph is plain text (one document position per character). A divider paragraph containing an inline atom (e.g. a pasted image) would break that pattern visually anyway, so it is out of scope — consistent with the spec's Non-Goals.
