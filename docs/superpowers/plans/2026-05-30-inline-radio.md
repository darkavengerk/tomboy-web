# Inline Radio Atomic Node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `inlineRadio` atomic ProseMirror node that round-trips as `( )` / `(o)` plain text and behaves as a radio group within its containing text block (paragraph / list-item body).

**Architecture:** Mirrors `inlineCheckbox` exactly except: (a) text pattern is `( )` / `(o)` instead of `[ ]` / `[x]`, (b) clicking selects + de-selects siblings in the same `$pos.parent` textblock (group scope = ProseMirror textblock; no group IDs), (c) toggling a selected radio is allowed (returns to "none selected"). Archiver mirroring adds a 4th split pass and 3 serialize emit sites alongside the checkbox ones.

**Tech Stack:** TipTap 3 `Node.create`, ProseMirror `Plugin` for `transformPasted`, vitest + @testing-library/svelte unit tests, Svelte 5 (TomboyEditor.svelte).

**Spec:** `docs/superpowers/specs/2026-05-30-inline-radio-design.md`

---

### Task 1: `inlineRadio` node module + group-toggle NodeView

**Goal:** Create the `inlineRadio` ProseMirror Node with input rule, paste transform plugin, and a NodeView whose click handler implements the same-textblock radio-group toggle (selected→none allowed).

**Files:**
- Create: `app/src/lib/editor/inlineRadio/index.ts`
- Create: `app/src/lib/editor/inlineRadio/node.ts`
- Create: `app/tests/unit/editor/inlineRadio/node.test.ts`

**Acceptance Criteria:**
- [ ] `inlineRadio` schema is atomic, inline, selectable, `marks: ''`, `selected` attr default false.
- [ ] Typing `( )`, `(o)`, or `(O)` in the body inserts an `inlineRadio` node with the correct `selected` attr.
- [ ] Typing `( )` on the title line (`$from.index(0) === 0`) does NOT convert.
- [ ] Pasting a slice containing `( )` / `(o)` splits text into nodes around the matches; title-destination paste is skipped; nested fragments recurse.
- [ ] Clicking an unselected radio sets it `selected=true` AND clears `selected` on all other `inlineRadio` siblings in the same textblock parent.
- [ ] Clicking an already-selected radio sets it `selected=false` (toggle off; "none selected" allowed).
- [ ] A radio in a list-item body does NOT affect a radio in a nested list-item's body, and vice versa.
- [ ] An `inlineCheckbox` in the same textblock is unaffected by radio clicks.
- [ ] Single `Editor.transaction` per click (undo restores the prior state of all affected radios in one step).

**Verify:** `cd app && npm run test -- inlineRadio/node.test.ts` → all tests pass.

**Steps:**

- [ ] **Step 1: Write the failing tests** — `app/tests/unit/editor/inlineRadio/node.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Slice, Fragment } from '@tiptap/pm/model';
import { TomboyInlineRadio } from '../../../../src/lib/editor/inlineRadio';
import { TomboyInlineCheckbox } from '../../../../src/lib/editor/inlineCheckbox';

function makeEditor(content: any = { type: 'doc', content: [{ type: 'paragraph' }] }) {
	return new Editor({
		extensions: [StarterKit, ...TomboyInlineRadio, ...TomboyInlineCheckbox],
		content
	});
}

function typeText(editor: Editor, text: string) {
	for (const ch of text) {
		const { from, to } = editor.state.selection;
		const handler = editor.view.someProp('handleTextInput') as
			| ((view: any, from: number, to: number, text: string) => boolean)
			| undefined;
		const handled = handler ? handler(editor.view, from, to, ch) : false;
		if (!handled) {
			editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}
}

describe('inlineRadio schema', () => {
	it('creates an atomic inline node with selected default false', () => {
		const editor = makeEditor();
		const type = editor.schema.nodes.inlineRadio;
		expect(type).toBeDefined();
		expect(type.isAtom).toBe(true);
		expect(type.isInline).toBe(true);
		expect(type.spec.selectable).toBe(true);
		expect(type.spec.marks).toBe('');
		const node = type.create({ selected: false });
		expect(node.attrs.selected).toBe(false);
		expect(node.nodeSize).toBe(1);
		editor.destroy();
	});
});

describe('inlineRadio NodeView render', () => {
	it('renders span.tomboy-inline-radio data-selected="false"', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'inlineRadio', attrs: { selected: false } }] }
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-radio');
		expect(dom).not.toBeNull();
		expect(dom!.getAttribute('data-selected')).toBe('false');
		editor.destroy();
	});

	it('renders data-selected="true" for selected', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'inlineRadio', attrs: { selected: true } }] }
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-radio');
		expect(dom!.getAttribute('data-selected')).toBe('true');
		editor.destroy();
	});
});

describe('inlineRadio input rule', () => {
	it('converts ( ) typed in body to unselected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '( )');
		const para = editor.state.doc.lastChild!;
		expect(para.childCount).toBe(1);
		expect(para.firstChild!.type.name).toBe('inlineRadio');
		expect(para.firstChild!.attrs.selected).toBe(false);
		editor.destroy();
	});

	it('converts (o) typed in body to selected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '(o)');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('converts (O) uppercase to selected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '(O)');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('does NOT convert in the title line (idx=0)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, ' ( )');
		let hasRadio = false;
		editor.state.doc.firstChild!.descendants((n) => {
			if (n.type.name === 'inlineRadio') hasRadio = true;
		});
		expect(hasRadio).toBe(false);
		editor.destroy();
	});
});

function makeParagraphSlice(editor: Editor, text: string): Slice {
	const schema = editor.schema;
	const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
	return new Slice(Fragment.from(paragraph), 1, 1);
}

describe('inlineRadio paste transform', () => {
	it('splits ( ) / (o) in pasted slice into nodes', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		const slice = makeParagraphSlice(editor, '답: ( ) A (o) B');
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		const para = transformed.content.firstChild!;
		const types: { type: string; attrs: any }[] = [];
		para.forEach((n) => types.push({ type: n.type.name, attrs: n.attrs }));
		expect(types.map((t) => t.type)).toEqual([
			'text',
			'inlineRadio',
			'text',
			'inlineRadio',
			'text'
		]);
		expect(types[1].attrs.selected).toBe(false);
		expect(types[3].attrs.selected).toBe(true);
		editor.destroy();
	});

	it('does NOT transform when destination is the title line', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(3);
		const slice = makeParagraphSlice(editor, ' ( )');
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		let hasRadio = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineRadio') hasRadio = true;
		});
		expect(hasRadio).toBe(false);
		editor.destroy();
	});
});

describe('inlineRadio group toggle (mousedown)', () => {
	it('selecting an unselected radio clears siblings in same paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'text', text: ' A ' },
						{ type: 'inlineRadio', attrs: { selected: false } },
						{ type: 'text', text: ' B' }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		expect(radios.length).toBe(2);
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		const r0 = para.child(0);
		const r1 = para.child(2);
		expect(r0.attrs.selected).toBe(false);
		expect(r1.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('clicking an already-selected radio toggles it off (none selected)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		(radios[0] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		expect(para.child(0).attrs.selected).toBe(false);
		expect(para.child(1).attrs.selected).toBe(false);
		editor.destroy();
	});

	it('radios in different list-item bodies are independent groups', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'inlineRadio', attrs: { selected: true } },
										{ type: 'text', text: ' 상위' }
									]
								},
								{
									type: 'bulletList',
									content: [
										{
											type: 'listItem',
											content: [
												{
													type: 'paragraph',
													content: [
														{ type: 'inlineRadio', attrs: { selected: false } },
														{ type: 'text', text: ' 자식' }
													]
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		expect(radios.length).toBe(2);
		// Click the nested-item radio → parent-item radio must stay selected.
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		let parentRadioSelected: boolean | null = null;
		let childRadioSelected: boolean | null = null;
		let seen = 0;
		editor.state.doc.descendants((n) => {
			if (n.type.name !== 'inlineRadio') return;
			if (seen === 0) parentRadioSelected = n.attrs.selected;
			else childRadioSelected = n.attrs.selected;
			seen++;
		});
		expect(parentRadioSelected).toBe(true);
		expect(childRadioSelected).toBe(true);
		editor.destroy();
	});

	it('does NOT affect inlineCheckbox in the same paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineCheckbox', attrs: { checked: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radio = editor.view.dom.querySelector('.tomboy-inline-radio') as HTMLElement;
		radio.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		expect(para.child(0).attrs.checked).toBe(true);
		expect(para.child(1).attrs.selected).toBe(true);
		editor.destroy();
	});

	it('undo restores group state in a single step', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para1 = editor.state.doc.lastChild!;
		expect(para1.child(0).attrs.selected).toBe(false);
		expect(para1.child(1).attrs.selected).toBe(true);
		editor.commands.undo();
		const para2 = editor.state.doc.lastChild!;
		expect(para2.child(0).attrs.selected).toBe(true);
		expect(para2.child(1).attrs.selected).toBe(false);
		editor.destroy();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npm run test -- inlineRadio/node.test.ts
```

Expected: every test FAILs with module-not-found for `../../../../src/lib/editor/inlineRadio`.

- [ ] **Step 3: Create `app/src/lib/editor/inlineRadio/node.ts`**

```ts
/**
 * Inline 라디오 atomic 노드.
 *
 * 본문 어디서나 ( ) / (o) 입력 → atomic 노드. 캐럿 진입 불가, 부분
 * 삭제 불가, mark 도 받지 않는다. 같은 텍스트 블록 ($pos.parent =
 * paragraph / list-item 본체) 안의 다른 inlineRadio 와 상호 배타로
 * 동작 — 선택 시 형제 라디오들은 모두 해제. 선택된 라디오 재클릭은
 * 해제 (none selected 상태 허용). 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 ( ) / (o) 텍스트 ↔ 노드로 변환.
 */
import { InputRule, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

export const InlineRadio = Node.create({
	name: 'inlineRadio',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	marks: '',

	addAttributes() {
		return {
			selected: { default: false }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-inline-radio',
				getAttrs: (el) => ({
					selected: (el as HTMLElement).getAttribute('data-selected') === 'true'
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{
				class: 'tomboy-inline-radio',
				'data-selected': node.attrs.selected ? 'true' : 'false'
			}
		];
	},

	addInputRules() {
		const type = this.type;
		return [
			new InputRule({
				find: /\(([ oO])\)$/,
				handler: ({ state, range, match }) => {
					const $from = state.doc.resolve(range.from);
					if ($from.index(0) === 0) return null; // 제목 차단
					const selected = match[1] === 'o' || match[1] === 'O';
					const node = type.create({ selected });
					state.tr.replaceWith(range.from, range.to, node);
				}
			})
		];
	},

	addProseMirrorPlugins() {
		const type = this.type;
		return [createPasteTransformPlugin(type)];
	},

	addNodeView() {
		return ({ node, getPos, editor }) => {
			const view = editor.view;
			const getPosFn = getPos as () => number | undefined;
			const dom = document.createElement('span');
			dom.className = 'tomboy-inline-radio';
			dom.setAttribute('data-selected', node.attrs.selected ? 'true' : 'false');
			dom.contentEditable = 'false';
			dom.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const pos = getPosFn();
				if (pos == null) return;
				const current = view.state.doc.nodeAt(pos);
				if (!current || current.type.name !== 'inlineRadio') return;

				const $pos = view.state.doc.resolve(pos);
				const parent = $pos.parent;
				const parentStart = $pos.start();
				const wasSelected = current.attrs.selected;
				const tr = view.state.tr;

				if (wasSelected) {
					tr.setNodeAttribute(pos, 'selected', false);
				} else {
					parent.forEach((child, offset) => {
						if (child.type.name !== 'inlineRadio') return;
						const childPos = parentStart + offset;
						if (childPos === pos) {
							tr.setNodeAttribute(childPos, 'selected', true);
						} else if (child.attrs.selected) {
							tr.setNodeAttribute(childPos, 'selected', false);
						}
					});
				}
				view.dispatch(tr);
			});
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'inlineRadio') return false;
					dom.setAttribute(
						'data-selected',
						updatedNode.attrs.selected ? 'true' : 'false'
					);
					return true;
				}
			};
		};
	}
});

const RADIO_PASTE_RE = /\(([ oO])\)/g;

function transformPastedSlice(slice: Slice, radioType: NodeType): Slice {
	const newContent = transformFragment(slice.content, radioType);
	if (newContent === slice.content) return slice;
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, radioType: NodeType): Fragment {
	const out: PMNode[] = [];
	let changed = false;
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string') {
			RADIO_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			let split = false;
			const pieces: PMNode[] = [];
			while ((m = RADIO_PASTE_RE.exec(text)) !== null) {
				split = true;
				if (m.index > last) {
					pieces.push(child.cut(last, m.index));
				}
				const selected = m[1] === 'o' || m[1] === 'O';
				pieces.push(radioType.create({ selected }));
				last = m.index + m[0].length;
			}
			if (split) {
				if (last < text.length) pieces.push(child.cut(last));
				out.push(...pieces);
				changed = true;
			} else {
				out.push(child);
			}
		} else if (child.content.size > 0) {
			const inner = transformFragment(child.content, radioType);
			if (inner !== child.content) {
				out.push(child.copy(inner));
				changed = true;
			} else {
				out.push(child);
			}
		} else {
			out.push(child);
		}
	});
	if (!changed) return frag;
	return Fragment.fromArray(out);
}

function createPasteTransformPlugin(radioType: NodeType): Plugin {
	return new Plugin({
		props: {
			transformPasted: (slice: Slice, view: EditorView) => {
				const $from = view.state.selection.$from;
				if ($from.depth >= 1 && $from.index(0) === 0) return slice;
				return transformPastedSlice(slice, radioType);
			}
		}
	});
}
```

- [ ] **Step 4: Create `app/src/lib/editor/inlineRadio/index.ts`**

```ts
import { InlineRadio } from './node.js';

export { InlineRadio };

export const TomboyInlineRadio = [InlineRadio];
```

- [ ] **Step 5: Run tests — schema / NodeView / input-rule / paste / group-toggle**

```bash
cd app && npm run test -- inlineRadio/node.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/inlineRadio/ app/tests/unit/editor/inlineRadio/
git commit -m "$(cat <<'EOF'
feat(editor): inlineRadio atomic node + group toggle

같은 textblock ( $pos.parent ) 내 형제 라디오와 상호 배타.
( )/(o) 입력 규칙, paste 변환, 제목 가드 — inlineCheckbox 패턴
미러링. 선택된 라디오 재클릭 시 해제 허용.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Archiver round-trip for `inlineRadio`

**Goal:** Add `( )` / `(o)` text ↔ `inlineRadio` node conversion to `noteContentArchiver.ts` parse + serialize paths, mirroring the existing `inlineCheckbox` handling at 4 sites: split helper, parse-split call, serialize emit (2 locations), `nextTextNodeMarks` early-return, `getPlainText` branch.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts` (lines 96 area, 205, 280-284, 422-436 area, 785-789, 976-978)
- Create: `app/tests/unit/core/archiverInlineRadio.test.ts`

**Acceptance Criteria:**
- [ ] `deserializeContent` converts `( )` in `<note-content>` body text into `{ type: 'inlineRadio', attrs: { selected: false } }`.
- [ ] `deserializeContent` converts `(o)` → `selected: true`; `(O)` (uppercase) → `selected: true`.
- [ ] `serializeContent` emits `( )` for `selected: false` and `(o)` for `selected: true`, closing all open marks before the radio (so `<bold>중요 ( ) 작업</bold>` round-trips as `<bold>중요 </bold>( )<bold> 작업</bold>`).
- [ ] Radios coexist with checkboxes and footnote markers in the same paragraph text.
- [ ] Title line (block 0) does NOT get radios — title is single-text-node only and the splitter only runs on inline text inside subsequent blocks; round-trip preserves `( )` as literal characters in the title.
- [ ] `getPlainText` returns `( )` / `(o)` for an `inlineRadio` node (so `isChecklistHeaderText` and similar plain-text consumers see the correct character payload).
- [ ] `nextTextNodeMarks` returns `[]` when encountering an `inlineRadio` (parity with `inlineCheckbox`) so marks don't leak across the radio.

**Verify:** `cd app && npm run test -- archiverInlineRadio.test.ts` → all tests pass. Also `cd app && npm run test -- archiverInlineCheckbox.test.ts` → still passes (no regression).

**Steps:**

- [ ] **Step 1: Write the failing tests** — `app/tests/unit/core/archiverInlineRadio.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '../../../src/lib/core/noteContentArchiver';

function paragraphInlines(doc: any, idx = 1) {
	return doc.content[idx].content;
}

describe('archiver: ( )/(o) text → inlineRadio node', () => {
	it('parses ( ) as unselected inlineRadio', () => {
		const xml = `<note-content version="0.1">제목\n( ) 사과</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineRadio',
			attrs: { selected: false }
		});
		expect(inlines[1]).toEqual({ type: 'text', text: ' 사과' });
	});

	it('parses (o) as selected inlineRadio', () => {
		const xml = `<note-content version="0.1">제목\n(o) 선택됨</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineRadio',
			attrs: { selected: true }
		});
	});

	it('parses uppercase (O) as selected', () => {
		const xml = `<note-content version="0.1">제목\n(O) 대문자</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0].attrs.selected).toBe(true);
	});

	it('handles mark-crossing — bold splits around the radio', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 ( ) 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(3);
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('bold');
		expect(inlines[1].type).toBe('inlineRadio');
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('bold');
	});

	it('coexists with checkbox and footnote in same text', () => {
		const xml = `<note-content version="0.1">제목\n( ) A [ ] B [^1] (o) C</note-content>`;
		const doc = deserializeContent(xml);
		const types = paragraphInlines(doc).map((n: any) => n.type);
		expect(types).toContain('inlineRadio');
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});

	it('handles consecutive ( )(o) as two adjacent nodes', () => {
		const xml = `<note-content version="0.1">제목\n( )(o)</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(2);
		expect(inlines[0].type).toBe('inlineRadio');
		expect(inlines[0].attrs.selected).toBe(false);
		expect(inlines[1].type).toBe('inlineRadio');
		expect(inlines[1].attrs.selected).toBe(true);
	});
});

describe('archiver: inlineRadio node → ( )/(o) text', () => {
	it('serializes unselected node to ( )', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: false } },
						{ type: 'text', text: ' 사과' }
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('( ) 사과');
	});

	it('serializes selected node to (o)', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineRadio', attrs: { selected: true } }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('(o)');
	});

	it('round-trips simple ( ) 사과', () => {
		const xml = `<note-content version="0.1">제목\n( ) 사과</note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('( ) 사과');
	});

	it('round-trips with mark crossing — bold splits around radio', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 (o) 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toMatch(/<bold>중요 <\/bold>\(o\)<bold> 작업<\/bold>/);
	});
});
```

- [ ] **Step 2: Run tests — should fail with `( )` parsing not happening**

```bash
cd app && npm run test -- archiverInlineRadio.test.ts
```

Expected: tests FAIL — radios appear as plain text, not as nodes.

- [ ] **Step 3: Add radio split helper next to checkbox split helper** — `app/src/lib/core/noteContentArchiver.ts`, immediately after `splitInlineCheckboxesInText` (currently ends near line 132). Insert:

```ts
// Inline-radio 패턴. `( )` (공백 1 개) 또는 `(o)` / `(O)`.
const INLINE_RADIO_SPLIT_RE = /\(([ oO])\)/g;

/**
 * 텍스트 안의 ( )/(o) 패턴을 inlineRadio 노드로 split.
 * splitInlineCheckboxesInText 와 동일 구조 — atomic 노드는 mark 안
 * 받음, 좌우 텍스트만 원본 mark 유지.
 */
function splitInlineRadiosInText(
	text: string,
	marks: InlineMark[] | undefined
): JSONContent[] {
	INLINE_RADIO_SPLIT_RE.lastIndex = 0;
	const out: JSONContent[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = INLINE_RADIO_SPLIT_RE.exec(text)) !== null) {
		if (m.index > last) {
			const piece: JSONContent = { type: 'text', text: text.slice(last, m.index) };
			if (marks) piece.marks = marks;
			out.push(piece);
		}
		const selected = m[1] === 'o' || m[1] === 'O';
		out.push({ type: 'inlineRadio', attrs: { selected } });
		last = m.index + m[0].length;
	}
	if (last === 0) {
		const piece: JSONContent = { type: 'text', text };
		if (marks) piece.marks = marks;
		return [piece];
	}
	if (last < text.length) {
		const piece: JSONContent = { type: 'text', text: text.slice(last) };
		if (marks) piece.marks = marks;
		out.push(piece);
	}
	return out;
}
```

- [ ] **Step 4: Wire radio split into `appendInlineNodes` after the checkbox split** — `app/src/lib/core/noteContentArchiver.ts`, around line 428. Currently the loop does:

```ts
const fnSplit = splitFootnotesInText(n.text, n.marks);
const split: JSONContent[] = [];
for (const piece of fnSplit) {
	if (piece.type === 'text' && typeof piece.text === 'string') {
		split.push(...splitInlineCheckboxesInText(piece.text, piece.marks));
	} else {
		split.push(piece);
	}
}
```

Replace with — chain a radio split after the checkbox split, taking only text pieces:

```ts
const fnSplit = splitFootnotesInText(n.text, n.marks);
const cbSplit: JSONContent[] = [];
for (const piece of fnSplit) {
	if (piece.type === 'text' && typeof piece.text === 'string') {
		cbSplit.push(...splitInlineCheckboxesInText(piece.text, piece.marks));
	} else {
		cbSplit.push(piece);
	}
}
const split: JSONContent[] = [];
for (const piece of cbSplit) {
	if (piece.type === 'text' && typeof piece.text === 'string') {
		split.push(...splitInlineRadiosInText(piece.text, piece.marks));
	} else {
		split.push(piece);
	}
}
```

Also update the comment above the block to mention 3-pass split (footnote → checkbox → radio).

- [ ] **Step 5: Add radio early-return in `nextTextNodeMarks`** — line 205 area, currently:

```ts
if (inline.type === 'inlineCheckbox') return [];
```

Add a sibling line below it:

```ts
if (inline.type === 'inlineRadio') return [];
```

- [ ] **Step 6: Add radio emit branch in the main paragraph-serialize loop** — line 280-284 area, after the `inlineCheckbox` branch:

```ts
} else if (inline.type === 'inlineRadio') {
	// 모든 mark 닫고 ( )/(o) emit. 다음 text 노드가 mark 를 다시 연다.
	closeAll();
	result += inline.attrs?.selected ? '(o)' : '( )';
}
```

- [ ] **Step 7: Add radio emit branch in `serializeBulletList` inline loop** — line 785-789 area, after the `inlineCheckbox` branch:

```ts
} else if (node.type === 'inlineRadio') {
	closeAll();
	result += node.attrs?.selected ? '(o)' : '( )';
}
```

(Use the same closeAll function in scope. Reference the existing checkbox branch for the exact closure name — it is `closeAll` in both serialize scopes.)

- [ ] **Step 8: Add radio branch in `getPlainText`** — line 976 area, after the `inlineCheckbox` branch:

```ts
if (node.type === 'inlineRadio') {
	return node.attrs?.selected ? '(o)' : '( )';
}
```

- [ ] **Step 9: Run radio tests**

```bash
cd app && npm run test -- archiverInlineRadio.test.ts
```

Expected: all PASS.

- [ ] **Step 10: Run full archiver suite to confirm no regression**

```bash
cd app && npm run test -- archiverInlineCheckbox.test.ts
cd app && npm run test -- noteContentArchiver
cd app && npm run check
```

Expected: all PASS. `npm run check` reports 0 errors.

- [ ] **Step 11: Commit**

```bash
git add app/src/lib/core/noteContentArchiver.ts app/tests/unit/core/archiverInlineRadio.test.ts
git commit -m "$(cat <<'EOF'
feat(archiver): inlineRadio round-trip ( ) / (o)

3-pass inline split (footnote → checkbox → radio). serialize 두 경로
( paragraph + bulletList ) 와 nextTextNodeMarks / getPlainText 모두
체크박스 옆에 라디오 분기 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Register extension + CSS in `TomboyEditor.svelte`

**Goal:** Register `TomboyInlineRadio` in the editor's extension list and add CSS that mirrors `.tomboy-inline-checkbox` styling but with circular shape and centered dot for the selected state.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (line 94 area — import; line 527 area — extensions; line 2016+ — CSS section after the checkbox styles)
- Modify: `app/src/lib/core/noteContentArchiver.ts` — no further edits (Task 2 covered it)

**Acceptance Criteria:**
- [ ] `TomboyInlineRadio` is imported and spread into the editor's `extensions` array.
- [ ] A note containing `( ) 사과 (o) 배` rendered in `TomboyEditor` shows two circular controls; the second has a centered dot, the first is empty.
- [ ] CSS selector `.tomboy-editor :global(.tomboy-inline-radio)` exists with `border-radius: 50%`, has a 24×24 invisible `::before` hit area, and a `[data-selected='true']` rule that renders the inner dot.
- [ ] `npm run check` reports 0 errors.

**Verify:**
1. `cd app && npm run check` → 0 errors.
2. Manual smoke (golden path):
   - `cd app && npm run dev`
   - Open any non-title paragraph, type: `메뉴: ( ) 사과 ( ) 배 ( ) 포도`
   - Click `( )` next to "사과" — it becomes filled (dot), other two stay empty.
   - Click `( )` next to "배" — it becomes filled, "사과" auto-clears.
   - Click "배" radio again — it clears (none selected).
   - Visit `/admin` (or any Dropbox-sync UI) and ensure the saved `<note-content>` XML contains `( )` and `(o)` literals (use the NoteXmlViewer if present).

**Steps:**

- [ ] **Step 1: Add the import** — `app/src/lib/editor/TomboyEditor.svelte` near line 94, alongside `TomboyInlineCheckbox`:

```ts
import { TomboyInlineRadio } from './inlineRadio';
```

- [ ] **Step 2: Spread the extension into the editor config** — line 527 area, in the `extensions: [...]` literal, immediately after `...TomboyInlineCheckbox,`:

```ts
...TomboyInlineRadio,
```

- [ ] **Step 3: Add the radio CSS** — after the `.tomboy-inline-checkbox[data-checked='true']` block (ends near line 2050). Insert:

```css
/* 인라인 라디오 — TomboyInlineRadio 노드의 NodeView 가
   .tomboy-inline-radio span 을 렌더한다. 14px 원형, 모바일
   hit-area 는 ::before 가 24×24 px 확보. 같은 textblock 의 다른
   라디오와 상호 배타 (NodeView 클릭 핸들러). */
.tomboy-editor :global(.tomboy-inline-radio) {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--text-muted, #888);
	border-radius: 50%;
	vertical-align: -2px;
	margin: 0 2px;
	cursor: pointer;
	background: transparent;
	user-select: none;
	position: relative;
	box-sizing: border-box;
	transition: background-color 0.12s ease, border-color 0.12s ease;
}

.tomboy-editor :global(.tomboy-inline-radio::before) {
	content: '';
	position: absolute;
	top: -5px;
	left: -5px;
	right: -5px;
	bottom: -5px;
}

.tomboy-editor :global(.tomboy-inline-radio[data-selected='true']) {
	border-color: var(--accent, #4a76d4);
}

.tomboy-editor :global(.tomboy-inline-radio[data-selected='true']::after) {
	content: '';
	position: absolute;
	top: 50%;
	left: 50%;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background-color: var(--accent, #4a76d4);
	transform: translate(-50%, -50%);
}
```

- [ ] **Step 4: Type-check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd app && npm run dev
```

In browser:
1. Create a new note or open an existing non-title paragraph.
2. Type: `메뉴: ( ) 사과 ( ) 배 ( ) 포도`. Each `( )` becomes a circular control after the closing paren.
3. Click the "사과" radio — it fills with a dot.
4. Click the "배" radio — "배" fills, "사과" empties.
5. Click "배" again — "배" empties (none selected).
6. Save/refresh (or 지금 동기화) and reopen — state persists; `( )` / `(o)` round-trips.
7. Add a nested bullet list, put one radio in the parent `<li>` body and one in a nested `<li>` body — toggling either does NOT affect the other.

If any step fails, debug before moving on; do NOT mark this task complete.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "$(cat <<'EOF'
feat(editor): TomboyEditor 에 inlineRadio 등록 + CSS

체크박스 옆에 라디오 NodeView 스타일 ( 원형, 중앙 dot ).
extensions 배열에 TomboyInlineRadio 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Node definition (atomic, inline, marks: '', selected attr) | Task 1, Step 3 |
| Input rule `( )` / `(o)` / `(O)` + 제목 가드 | Task 1, Step 3 (`addInputRules`) |
| Paste 변환 plugin | Task 1, Step 3 (`createPasteTransformPlugin`) |
| 그룹 동작 NodeView (textblock 경계, toggle off, single tr) | Task 1, Step 3 (`addNodeView`) |
| 라운드트립 split (parse) | Task 2, Steps 3 + 4 |
| 라운드트립 emit 3 사이트 (`paragraph` serialize, `bulletList` serialize, `getPlainText`) | Task 2, Steps 6 + 7 + 8 |
| `nextTextNodeMarks` 라디오 early-return | Task 2, Step 5 |
| CSS (원형 + dot + 24×24 hit area) | Task 3, Step 3 |
| TomboyEditor 등록 | Task 3, Steps 1 + 2 |
| Tests (schema / NodeView / input rule / paste / group / 라운드트립) | Tasks 1 + 2 test files |
