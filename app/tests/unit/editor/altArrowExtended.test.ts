import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { sinkListItemOnly, liftListItemOnly, isInList } from '$lib/editor/listItemDepth.js';
import { moveListItemUp, moveListItemDown } from '$lib/editor/listItemReorder.js';
import type { JSONContent } from '@tiptap/core';

// ============================================================================
// Editor lifecycle
// ============================================================================

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

// ============================================================================
// Doc builder helpers
// ============================================================================

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function li(...children: JSONContent[]): JSONContent {
	return { type: 'listItem', content: children };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

// ============================================================================
// Inspection helpers
// ============================================================================

/**
 * Render the doc as an indented text outline (for readable assertions).
 * Each list item becomes a line `"<2*depth spaces>- <text>"`. Top-level
 * paragraphs become a line `"<text>"`.
 */
function outline(json: JSONContent): string {
	const lines: string[] = [];
	function visit(node: JSONContent, depth: number, inList: boolean): void {
		if (node.type === 'bulletList' || node.type === 'orderedList') {
			for (const c of node.content ?? []) visit(c, depth, true);
			return;
		}
		if (node.type === 'listItem') {
			const text = (node.content?.[0]?.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			lines.push('  '.repeat(depth) + `- ${text}`);
			for (const c of (node.content ?? []).slice(1)) visit(c, depth + 1, true);
			return;
		}
		if (node.type === 'paragraph') {
			const text = (node.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			if (!inList && text !== '') lines.push(text);
			return;
		}
		if (node.type === 'doc') {
			for (const c of node.content ?? []) visit(c, depth, false);
		}
	}
	visit(json, 0, false);
	return lines.join('\n');
}

/** Compute the absolute position just after the first occurrence of `needle`. */
function findPosAfter(editor: Editor, needle: string): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + (node.text.indexOf(needle) + needle.length);
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	return pos;
}

/**
 * Select a range from just after `fromNeedle` to just after `toNeedle`.
 */
function selectRange(editor: Editor, fromNeedle: string, toNeedle: string): void {
	const from = findPosAfter(editor, fromNeedle) - fromNeedle.length;
	const to = findPosAfter(editor, toNeedle);
	editor.commands.setTextSelection({ from, to });
}

/** Place the cursor inside the first text occurrence of `needle`. */
function placeCursorAt(editor: Editor, needle: string): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + (node.text.indexOf(needle) + needle.length);
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	editor.commands.setTextSelection(pos);
}

/** Place cursor inside an empty paragraph (the first one found with no text). */
function placeCursorInEmptyParagraph(editor: Editor): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.type.name === 'paragraph' && node.childCount === 0) {
			pos = p + 1; // inside the empty paragraph
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error('empty paragraph not found');
	editor.commands.setTextSelection(pos);
}

// isInList imported from listItemDepth.js
// moveListItemUp/moveListItemDown imported from listItemReorder.js

// ============================================================================
// Composite handler helpers (simulate what TomboyEditor keydown will do)
// ============================================================================

/**
 * Simulates the Alt+Right handler:
 * 1. Try sinkListItemOnly. If it succeeds, done.
 * 2. If sink failed and cursor is NOT in a list, toggle bullet list (convert paragraph to list).
 * 3. Otherwise (in list but can't sink, e.g. first item), return false.
 */
function handleAltRight(editor: Editor): boolean {
	const sunk = sinkListItemOnly(editor);
	if (!sunk && !isInList(editor)) {
		return editor.chain().focus().toggleBulletList().run();
	}
	return sunk;
}

/**
 * Simulates the Alt+Left handler:
 * 1. Try liftListItemOnly. If it succeeds, done.
 * 2. If lift failed and cursor IS in a list (depth-1 item that can't be surgically lifted),
 *    use the standard liftListItem command to un-list it.
 * 3. Otherwise (not in a list), return false.
 */
function handleAltLeft(editor: Editor): boolean {
	const lifted = liftListItemOnly(editor);
	if (!lifted && isInList(editor)) {
		return editor.commands.liftListItem('listItem');
	}
	return lifted;
}

// ============================================================================
//                     Alt+Right — non-list to list conversion
// ============================================================================

describe('Alt+Right — non-list to list conversion', () => {
	it('paragraph becomes bullet list item', () => {
		const editor = makeEditor(doc(p('hello')));
		placeCursorAt(editor, 'hello');
		const result = handleAltRight(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe('- hello');
	});

	it('empty paragraph becomes empty list item', () => {
		const editor = makeEditor(doc(p('')));
		placeCursorInEmptyParagraph(editor);
		const result = handleAltRight(editor);
		expect(result).toBe(true);
		// The doc should now have a bullet list with one empty item.
		const json = editor.getJSON();
		const firstChild = json.content?.[0];
		expect(firstChild?.type).toBe('bulletList');
		expect(firstChild?.content?.length).toBe(1);
	});

	it('already in list, has prev sibling → sinks normally', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'B');
		const result = handleAltRight(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- A', '  - B'].join('\n'));
	});

	it('already in list, first item → no-op', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		const result = handleAltRight(editor);
		expect(result).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

// ============================================================================
//                     Alt+Left — un-list at depth 1
// ============================================================================

describe('Alt+Left — un-list at depth 1', () => {
	it('single-item list → becomes paragraph', () => {
		const editor = makeEditor(doc(ul(li(p('hello')))));
		placeCursorAt(editor, 'hello');
		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// Should now be a plain paragraph, not in a list.
		const json = editor.getJSON();
		const firstChild = json.content?.[0];
		expect(firstChild?.type).toBe('paragraph');
		expect((firstChild?.content?.[0] as any)?.text).toBe('hello');
	});

	it('multi-item list, middle item → only that item lifts out', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'B');
		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// Expected: A in list, B as paragraph, C in list
		expect(outline(editor.getJSON())).toBe(['- A', 'B', '- C'].join('\n'));
	});

	it('multi-item list, first item → lifts out, rest stay', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'A');
		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// Expected: A as paragraph, [B,C] in list
		expect(outline(editor.getJSON())).toBe(['A', '- B', '- C'].join('\n'));
	});

	it('multi-item list, last item → lifts out, rest stay', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'C');
		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// Expected: [A,B] in list, C as paragraph
		expect(outline(editor.getJSON())).toBe(['- A', '- B', 'C'].join('\n'));
	});

	it('nested list (depth 2) → surgical lift behavior unchanged', () => {
		// - A
		//   - A1
		//   - A2
		// Cursor on A1, handleAltLeft → A1 lifts to parent level (surgical lift via liftListItemOnly)
		const editor = makeEditor(
			doc(ul(li(p('A'), ul(li(p('A1')), li(p('A2'))))))
		);
		placeCursorAt(editor, 'A1');
		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// A1 lifts from depth 2 to depth 1 (sibling of A).
		// A2 stays under A.
		expect(outline(editor.getJSON())).toBe(
			['- A', '  - A2', '- A1'].join('\n')
		);
	});

	it('not in a list → no-op', () => {
		const editor = makeEditor(doc(p('hello')));
		placeCursorAt(editor, 'hello');
		const result = handleAltLeft(editor);
		expect(result).toBe(false);
		// Doc unchanged.
		const json = editor.getJSON();
		expect(json.content?.[0]?.type).toBe('paragraph');
		expect((json.content?.[0]?.content?.[0] as any)?.text).toBe('hello');
	});

	it('empty list item at depth 1 → becomes empty paragraph', () => {
		const editor = makeEditor(doc(ul(li(p('')))));
		// Place cursor in the empty list item's paragraph.
		let emptyPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (emptyPos !== -1) return false;
			if (node.type.name === 'paragraph' && node.childCount === 0) {
				const resolved = editor.state.doc.resolve(pos);
				if (resolved.parent.type.name === 'listItem') {
					emptyPos = pos + 1;
				}
			}
			return true;
		});
		if (emptyPos < 0) throw new Error('empty list item paragraph not found');
		editor.commands.setTextSelection(emptyPos);

		const result = handleAltLeft(editor);
		expect(result).toBe(true);
		// Should now be a plain empty paragraph, not in a list.
		const json = editor.getJSON();
		const firstChild = json.content?.[0];
		expect(firstChild?.type).toBe('paragraph');
	});
});

// ============================================================================
//                     Alt+Up/Down — integration with handler
// ============================================================================

describe('Alt+Up/Down — integration with handler', () => {
	it('Alt+Up on second item moves it up', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A'].join('\n'));
	});

	it('Alt+Down on first item moves it down', () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A'].join('\n'));
	});

	it('Alt+Up on paragraph (not in list) returns false', () => {
		const editor = makeEditor(doc(p('hello')));
		placeCursorAt(editor, 'hello');
		const result = moveListItemUp(editor);
		expect(result).toBe(false);
	});

	it('Alt+Down on paragraph (not in list) returns false', () => {
		const editor = makeEditor(doc(p('hello')));
		placeCursorAt(editor, 'hello');
		const result = moveListItemDown(editor);
		expect(result).toBe(false);
	});
});

// ============================================================================
//                     round-trip: convert → unconvert
// ============================================================================

describe('round-trip: convert → unconvert', () => {
	it('Alt+Right then Alt+Left on single paragraph restores original', () => {
		const editor = makeEditor(doc(p('hello')));
		placeCursorAt(editor, 'hello');
		const before = outline(editor.getJSON());

		// Alt+Right: paragraph → list item
		expect(handleAltRight(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe('- hello');

		// Alt+Left: list item → paragraph
		placeCursorAt(editor, 'hello');
		expect(handleAltLeft(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('Alt+Right on paragraph, then Alt+Right again sinks (if prev sibling)', () => {
		// Two paragraphs: A, B. Convert both to list items, then sink B under A.
		const editor = makeEditor(doc(p('A'), p('B')));

		// Convert A to a list item.
		placeCursorAt(editor, 'A');
		expect(handleAltRight(editor)).toBe(true);

		// Convert B to a list item.
		placeCursorAt(editor, 'B');
		expect(handleAltRight(editor)).toBe(true);

		// Now both A and B should be list items (possibly in same or separate lists).
		// TipTap may merge adjacent bullet lists automatically.
		// B should be in a list; Alt+Right again on B should sink it under A.
		placeCursorAt(editor, 'B');
		expect(handleAltRight(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- A', '  - B'].join('\n'));
	});
});
