import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { moveListItemUp, moveListItemDown } from '$lib/editor/listItemReorder.js';
import type { JSONContent } from '@tiptap/core';

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
			const marker = node.type === 'listItem' ? '-' : '#';
			lines.push('  '.repeat(depth) + `${marker} ${text}`);
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
 * Select a range from just after `fromNeedle` to just after `toNeedle` (inclusive
 * of the final char), so the selection spans multiple list items.
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

/** Place the cursor at a specific offset within the first text occurrence of `needle`. */
function placeCursorAtOffset(editor: Editor, needle: string, offset: number): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + node.text.indexOf(needle) + offset;
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	editor.commands.setTextSelection(pos);
}

// Helper to build a doc programmatically.
function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function pBold(text: string): JSONContent {
	return {
		type: 'paragraph',
		content: text
			? [{ type: 'text', text, marks: [{ type: 'bold' }] }]
			: []
	};
}
function li(...children: JSONContent[]): JSONContent {
	return { type: 'listItem', content: children };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function ol(...items: JSONContent[]): JSONContent {
	return { type: 'orderedList', content: items };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

// ============================================================================
//                           moveListItemUp — basic
// ============================================================================

describe('moveListItemUp — basic', () => {
	it('move second item up in 2-item list', () => {
		// - A
		// - B   ← cursor
		// Expected: B, A
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A'].join('\n'));
	});

	it('move third item up in 3-item list', () => {
		// - A
		// - B
		// - C   ← cursor
		// Expected: A, C, B
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'C');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- A', '- C', '- B'].join('\n'));
	});

	it('first item returns false (no-op)', () => {
		// - A   ← cursor (index 0)
		// - B
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		const result = moveListItemUp(editor);
		expect(result).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('single-item list returns false', () => {
		// - A   ← only item
		const editor = makeEditor(doc(ul(li(p('A')))));
		placeCursorAt(editor, 'A');
		const result = moveListItemUp(editor);
		expect(result).toBe(false);
	});
});

// ============================================================================
//                  moveListItemUp — with nested children
// ============================================================================

describe('moveListItemUp — with nested children', () => {
	it('item with nested sub-list moves as a unit', () => {
		// - A
		// - B       ← cursor
		//   - B1
		//   - B2
		// Expected:
		// - B
		//   - B1
		//   - B2
		// - A
		const editor = makeEditor(
			doc(ul(li(p('A')), li(p('B'), ul(li(p('B1')), li(p('B2'))))))
		);
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- B', '  - B1', '  - B2', '- A'].join('\n')
		);
	});

	it('item moves past sibling that also has nested children', () => {
		// - A
		//   - A1
		// - B       ← cursor
		// Expected:
		// - B
		// - A
		//   - A1
		const editor = makeEditor(
			doc(ul(li(p('A'), ul(li(p('A1')))), li(p('B'))))
		);
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- B', '- A', '  - A1'].join('\n')
		);
	});
});

// ============================================================================
//                  moveListItemUp — nested list contexts
// ============================================================================

describe('moveListItemUp — nested list contexts', () => {
	it('move up in a nested list (depth 2)', () => {
		// - X
		//   - A
		//   - B   ← cursor
		//   - C
		// Expected: inner list becomes [B, A, C]
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B')), li(p('C'))))))
		);
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '  - A', '  - C'].join('\n')
		);
	});

	it('last item in nested list moves up', () => {
		// - X
		//   - A
		//   - B   ← cursor (last in nested)
		// Expected: [B, A]
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B'))))))
		);
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '  - A'].join('\n')
		);
	});
});

// ============================================================================
//                          moveListItemDown — basic
// ============================================================================

describe('moveListItemDown — basic', () => {
	it('move first item down in 2-item list', () => {
		// - A   ← cursor
		// - B
		// Expected: B, A
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A'].join('\n'));
	});

	it('move first item down in 3-item list', () => {
		// - A   ← cursor
		// - B
		// - C
		// Expected: B, A, C
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A', '- C'].join('\n'));
	});

	it('last item returns false (no-op)', () => {
		// - A
		// - B   ← cursor (last)
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		placeCursorAt(editor, 'B');
		const before = outline(editor.getJSON());
		const result = moveListItemDown(editor);
		expect(result).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('single-item list returns false', () => {
		// - A   ← only item
		const editor = makeEditor(doc(ul(li(p('A')))));
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(false);
	});
});

// ============================================================================
//                moveListItemDown — with nested children
// ============================================================================

describe('moveListItemDown — with nested children', () => {
	it('item with nested sub-list moves down as a unit', () => {
		// - A       ← cursor
		//   - A1
		//   - A2
		// - B
		// Expected:
		// - B
		// - A
		//   - A1
		//   - A2
		const editor = makeEditor(
			doc(ul(li(p('A'), ul(li(p('A1')), li(p('A2')))), li(p('B'))))
		);
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- B', '- A', '  - A1', '  - A2'].join('\n')
		);
	});
});

// ============================================================================
//                          Multi-selection
// ============================================================================

describe('multi-selection', () => {
	it('multi-selection range [1..2] moves up together', () => {
		// - A
		// - B   ← selection start
		// - C   ← selection end
		// Expected after moveUp: B, C, A
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		selectRange(editor, 'B', 'C');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- C', '- A'].join('\n'));
	});

	it('multi-selection range [0..1] moves down together', () => {
		// - A   ← selection start
		// - B   ← selection end
		// - C
		// Expected after moveDown: C, A, B
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		selectRange(editor, 'A', 'B');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- C', '- A', '- B'].join('\n'));
	});

	it('multi-selection starting at index 0 moveUp returns false', () => {
		// - A   ← selection start (index 0)
		// - B   ← selection end
		// - C
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		selectRange(editor, 'A', 'B');
		const before = outline(editor.getJSON());
		const result = moveListItemUp(editor);
		expect(result).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

// ============================================================================
//                    Cursor/selection preservation
// ============================================================================

describe('cursor/selection preservation', () => {
	it('cursor stays inside same text after moveUp', () => {
		// - Alpha
		// - Beta   ← cursor in the middle of "Beta"
		// - Gamma
		const editor = makeEditor(doc(ul(li(p('Alpha')), li(p('Beta')), li(p('Gamma')))));
		// Place cursor at offset 2 inside "Beta" (between 'e' and 't')
		placeCursorAtOffset(editor, 'Beta', 2);
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		// Verify cursor is still inside "Beta"
		const { $from } = editor.state.selection;
		expect($from.parent.textContent).toBe('Beta');
		// Verify offset is preserved
		expect($from.parentOffset).toBe(2);
	});

	it('range selection preserved after moveDown', () => {
		// - Alpha   ← selection start
		// - Beta    ← selection end
		// - Gamma
		const editor = makeEditor(doc(ul(li(p('Alpha')), li(p('Beta')), li(p('Gamma')))));
		selectRange(editor, 'Alpha', 'Beta');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		// Verify selection is not empty (still a range)
		expect(editor.state.selection.empty).toBe(false);
		// Verify the selected text still spans Alpha and Beta
		const selectedText = editor.state.doc.textBetween(
			editor.state.selection.from,
			editor.state.selection.to,
			'\n'
		);
		expect(selectedText).toMatch(/Alpha[\s\S]*Beta/);
	});
});

// ============================================================================
//                            Round-trips
// ============================================================================

describe('round-trips', () => {
	it('moveUp then moveDown restores original order', () => {
		// - A
		// - B   ← cursor
		// - C
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'B');
		const before = outline(editor.getJSON());
		expect(moveListItemUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A', '- C'].join('\n'));
		// Cursor should still be on B; move down to restore
		placeCursorAt(editor, 'B');
		expect(moveListItemDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('moveDown then moveUp restores original order', () => {
		// - A
		// - B   ← cursor
		// - C
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'B');
		const before = outline(editor.getJSON());
		expect(moveListItemDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- A', '- C', '- B'].join('\n'));
		// Cursor should still be on B; move up to restore
		placeCursorAt(editor, 'B');
		expect(moveListItemUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

// ============================================================================
//                            Edge cases
// ============================================================================

describe('edge cases', () => {
	it('empty list item moves up', () => {
		// - A
		// - (empty)  ← cursor
		const editor = makeEditor(doc(ul(li(p('A')), li(p('')))));
		// Place cursor in the empty li — find by tree position
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
		if (emptyPos < 0) throw new Error('empty paragraph not found');
		editor.commands.setTextSelection(emptyPos);
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- ', '- A'].join('\n'));
	});

	it('not in a list (paragraph) returns false', () => {
		// Just a plain paragraph, no list
		const editor = makeEditor(doc(p('Hello world')));
		placeCursorAt(editor, 'Hello');
		const resultUp = moveListItemUp(editor);
		expect(resultUp).toBe(false);
		const resultDown = moveListItemDown(editor);
		expect(resultDown).toBe(false);
	});

	it('ordered list items reorder correctly', () => {
		// 1. A
		// 2. B   ← cursor
		// 3. C
		const editor = makeEditor(doc(ol(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		// Verify order changed
		expect(outline(editor.getJSON())).toBe(['- B', '- A', '- C'].join('\n'));
		// Verify the list type is still orderedList
		const json = editor.getJSON();
		const outerList = json.content?.[0];
		expect(outerList?.type).toBe('orderedList');
	});

	it('item with marks (bold text) preserved after move', () => {
		// - A
		// - **Bold**   ← cursor, bold text
		const editor = makeEditor(
			doc(
				ul(
					li(p('A')),
					li({
						type: 'paragraph',
						content: [
							{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }
						]
					})
				)
			)
		);
		placeCursorAt(editor, 'Bold');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		// Verify the bold mark survived the move
		const json = editor.getJSON();
		const firstItem = json.content?.[0]?.content?.[0] as any;
		const paraContent = firstItem?.content?.[0]?.content;
		expect(paraContent).toBeDefined();
		expect(paraContent?.[0]?.marks?.[0]?.type).toBe('bold');
		expect(paraContent?.[0]?.text).toBe('Bold');
	});
});

// ============================================================================
//                   Additional edge cases & robustness
// ============================================================================

describe('moveListItemDown — nested list contexts', () => {
	it('move down in a nested list (depth 2)', () => {
		// - X
		//   - A   ← cursor
		//   - B
		//   - C
		// Expected: inner list becomes [B, A, C]
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B')), li(p('C'))))))
		);
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '  - A', '  - C'].join('\n')
		);
	});

	it('first item in nested list moves down', () => {
		// - X
		//   - A   ← cursor
		//   - B
		// Expected: [B, A]
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B'))))))
		);
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '  - A'].join('\n')
		);
	});
});

describe('multi-selection — edge cases', () => {
	it('multi-selection ending at last index moveDown returns false', () => {
		// - A
		// - B   ← selection start
		// - C   ← selection end (last item)
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		selectRange(editor, 'B', 'C');
		const before = outline(editor.getJSON());
		const result = moveListItemDown(editor);
		expect(result).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('multi-selection with nested children moves as a block up', () => {
		// - A
		// - B
		//   - B1
		// - C
		//   - C1
		// Select B-C, moveUp => B(+B1), C(+C1), A
		const editor = makeEditor(
			doc(
				ul(
					li(p('A')),
					li(p('B'), ul(li(p('B1')))),
					li(p('C'), ul(li(p('C1'))))
				)
			)
		);
		selectRange(editor, 'B', 'C');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- B', '  - B1', '- C', '  - C1', '- A'].join('\n')
		);
	});
});

describe('repeated moves', () => {
	it('moveUp twice moves item to the top', () => {
		// - A
		// - B
		// - C   ← cursor
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'C');
		expect(moveListItemUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- A', '- C', '- B'].join('\n'));
		placeCursorAt(editor, 'C');
		expect(moveListItemUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- C', '- A', '- B'].join('\n'));
		// Third time: already at top, returns false
		placeCursorAt(editor, 'C');
		expect(moveListItemUp(editor)).toBe(false);
	});

	it('moveDown twice moves item to the bottom', () => {
		// - A   ← cursor
		// - B
		// - C
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'A');
		expect(moveListItemDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- A', '- C'].join('\n'));
		placeCursorAt(editor, 'A');
		expect(moveListItemDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- B', '- C', '- A'].join('\n'));
		// Third time: already at bottom, returns false
		placeCursorAt(editor, 'A');
		expect(moveListItemDown(editor)).toBe(false);
	});
});

describe('moveDown with paragraph context', () => {
	it('does not affect surrounding paragraphs', () => {
		// header
		// - A   ← cursor
		// - B
		// footer
		const editor = makeEditor(
			doc(p('header'), ul(li(p('A')), li(p('B'))), p('footer'))
		);
		placeCursorAt(editor, 'A');
		const result = moveListItemDown(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['header', '- B', '- A', 'footer'].join('\n')
		);
	});
});

describe('moveUp with paragraph context', () => {
	it('does not affect surrounding paragraphs', () => {
		// header
		// - A
		// - B   ← cursor
		// footer
		const editor = makeEditor(
			doc(p('header'), ul(li(p('A')), li(p('B'))), p('footer'))
		);
		placeCursorAt(editor, 'B');
		const result = moveListItemUp(editor);
		expect(result).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['header', '- B', '- A', 'footer'].join('\n')
		);
	});
});
