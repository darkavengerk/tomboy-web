import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	sinkListItemOnly,
	liftListItemOnly
} from '$lib/editor/listItemDepth.js';
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

async function makeFullEditor(doc: JSONContent): Promise<Editor> {
	const { TomboySize } = await import('$lib/editor/extensions/TomboySize.js');
	const { TomboyMonospace } = await import('$lib/editor/extensions/TomboyMonospace.js');
	const { TomboyInternalLink } = await import('$lib/editor/extensions/TomboyInternalLink.js');
	const { TomboyUrlLink } = await import('$lib/editor/extensions/TomboyUrlLink.js');
	const { TomboyDatetime } = await import('$lib/editor/extensions/TomboyDatetime.js');
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			TomboySize,
			TomboyMonospace,
			TomboyDatetime,
			TomboyInternalLink.configure({ getTitles: () => [], getCurrentGuid: () => null }),
			TomboyUrlLink
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

// Helper to build a doc programmatically.
function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
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
//                                  SINK ONLY
// ============================================================================

describe('sinkListItemOnly — basic', () => {
	it('with a previous sibling and no children, behaves like standard sink', () => {
		// - X
		// - A
		const editor = makeEditor(doc(ul(li(p('X')), li(p('A')))));
		placeCursorAt(editor, 'A');
		const ok = sinkListItemOnly(editor);
		expect(ok).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - A'].join('\n'));
	});

	it('on the first item (no previous sibling), is a no-op and returns false', () => {
		// - A
		// - X
		const editor = makeEditor(doc(ul(li(p('A')), li(p('X')))));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		const ok = sinkListItemOnly(editor);
		expect(ok).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it("with one direct child, the child becomes the operated item's sibling at the SAME depth", () => {
		// - X
		// - A
		//   - B
		// Expected after Alt+→ on A:
		// - X
		//   - A
		//   - B
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A'), ul(li(p('B'))))))
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B'].join('\n')
		);
	});

	it('with multiple direct children, all children become siblings of the operated item', () => {
		// - X
		// - A
		//   - B
		//   - C
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A'), ul(li(p('B')), li(p('C'))))))
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '  - C'].join('\n')
		);
	});

	it('grandchildren keep their relative depth under their (now-promoted) parent', () => {
		// - X
		// - A
		//   - B
		//     - D
		// Expected:
		// - X
		//   - A
		//   - B
		//     - D
		const editor = makeEditor(
			doc(
				ul(
					li(p('X')),
					li(p('A'), ul(li(p('B'), ul(li(p('D'))))))
				)
			)
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '    - D'].join('\n')
		);
	});

	it('regression: leaf A sinking into X that ALREADY has a nested list — A is appended, not "adopting" X\'s children', () => {
		// - X
		//   - 3
		// - A
		// Expected (Alt+→ on A):
		// - X
		//   - 3
		//   - A
		// Bug observed: previously the code had A adopt X's existing sub-list
		// as its own child, producing `- X / - A / - 3` at different depths.
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('3')))), li(p('A'))))
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - 3', '  - A'].join('\n')
		);
	});

	it('regression: leaf A sinks AFTER existing children (order preserved)', () => {
		// - X
		//   - 3
		//   - 5
		// - A
		// Expected:
		// - X
		//   - 3
		//   - 5
		//   - A
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('3')), li(p('5')))), li(p('A'))))
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - 3', '  - 5', '  - A'].join('\n')
		);
	});

	it('regression: cursor stays inside A after sink-appending to an existing sub-list', () => {
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('3')))), li(p('Hello'))))
		);
		placeCursorAt(editor, 'Hello');
		expect(sinkListItemOnly(editor)).toBe(true);
		// Cursor must land inside the paragraph that contains "Hello"
		// (not in "3" which is the previous sibling after the move).
		const { $from } = editor.state.selection;
		const paraText = $from.parent.textContent;
		expect(paraText).toBe('Hello');
	});

	it('preserves cursor position inside the operated item after sink', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('Hello')))));
		placeCursorAt(editor, 'Hello');
		const before = editor.state.selection.from;
		expect(sinkListItemOnly(editor)).toBe(true);
		// After sink, the operated item still contains "Hello" and the cursor
		// must be inside that paragraph (not jumped to another item).
		const sel = editor.state.selection;
		const node = editor.state.doc.nodeAt(sel.from);
		expect(node?.isText && node.text?.includes('H')).toBeTruthy();
		expect(sel.from).not.toBe(before); // text moved into nested ul, position shifted
	});
});

describe('sinkListItemOnly — ordered lists & mixed', () => {
	it('works inside an ordered list', () => {
		const editor = makeEditor(doc(ol(li(p('X')), li(p('A'), ol(li(p('B')))))));
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B'].join('\n')
		);
		// outline() renders both as "-" — that's intentional, the structural
		// shape is what we care about. The list type of the children's wrapper
		// should still be ordered; validate via raw JSON.
		const json = editor.getJSON();
		const outerList = json.content?.[0];
		expect(outerList?.type).toBe('orderedList');
	});

	it('preserves the inner list type when promoting children', () => {
		// outer ordered, inner bullet — A's children (bullet) become siblings
		// of A inside the outer ordered list. The promoted children KEEP their
		// original wrapper type? Or take the outer's type? We pick: promoted
		// children join the operated item's NEW parent list as items of that
		// list's type (so the existing list invariant is respected).
		const editor = makeEditor(
			doc(ol(li(p('X')), li(p('A'), ul(li(p('B'))))))
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		const json = editor.getJSON();
		const outerList = json.content?.[0];
		expect(outerList?.type).toBe('orderedList');
		const innerWrapper = outerList?.content?.[0]?.content?.[1];
		// A and B both end up as siblings inside the new ordered list inside X.
		expect(innerWrapper?.type).toBe('orderedList');
		expect(innerWrapper?.content?.length).toBe(2);
	});
});

describe('sinkListItemOnly — empty / weird content', () => {
	it('handles an empty list item (no text)', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('')))));
		placeCursorAt(editor, 'X');
		// Move cursor into the empty li — find by tree position
		const lastLiPos = (() => {
			let pos = -1;
			editor.state.doc.descendants((node, p) => {
				if (node.type.name === 'listItem') pos = p + 2; // inside paragraph
			});
			return pos;
		})();
		editor.commands.setTextSelection(lastLiPos);
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - '].join('\n'));
	});
});

// ============================================================================
//                                  LIFT ONLY
// ============================================================================

describe('liftListItemOnly — basic', () => {
	it('lifting a top-level item with no parent list is a no-op and returns false', () => {
		const editor = makeEditor(doc(ul(li(p('A')))));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		const ok = liftListItemOnly(editor);
		expect(ok).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('with no children, behaves like standard lift', () => {
		// - X
		//   - A
		// Expected:
		// - X
		// - A
		const editor = makeEditor(doc(ul(li(p('X'), ul(li(p('A')))))));
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '- A'].join('\n'));
	});

	it("with children, the children stay at their current visual depth (become operated item's old-parent's children)", () => {
		// - X
		//   - A
		//     - B
		// Expected (Alt+← on A): A goes to root level; B keeps its visual
		// depth (= 1) as X's child, since A vacated that slot.
		// - X
		//   - B
		// - A
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A'), ul(li(p('B'))))))))
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '- A'].join('\n')
		);
	});

	it('with multiple direct children, all of them stay under the old parent', () => {
		// - X
		//   - A
		//     - B
		//     - C
		// Expected:
		// - X
		//   - B
		//   - C
		// - A
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(li(p('A'), ul(li(p('B')), li(p('C')))))
					)
				)
			)
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '  - C', '- A'].join('\n')
		);
	});

	it('grandchildren keep their relative depth under their parent (which stayed)', () => {
		// - X
		//   - A
		//     - B
		//       - D
		// Expected:
		// - X
		//   - B
		//     - D
		// - A
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(
							li(
								p('A'),
								ul(li(p('B'), ul(li(p('D')))))
							)
						)
					)
				)
			)
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - B', '    - D', '- A'].join('\n')
		);
	});
});

describe('liftListItemOnly — regression: following sibling preserved', () => {
	function placeCursorAtStartOf(editor: Editor, needle: string): void {
		let pos = -1;
		editor.state.doc.descendants((node, p) => {
			if (pos !== -1) return false;
			if (node.isText && node.text?.includes(needle)) {
				pos = p + node.text.indexOf(needle);
				return false;
			}
			return true;
		});
		if (pos < 0) throw new Error(`needle not found: ${needle}`);
		editor.commands.setTextSelection(pos);
	}

	it("user's scenario with cursor at END of 33333", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario with cursor at START of 33333", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		placeCursorAtStartOf(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario with a trailing empty paragraph (as TipTap would normally have)", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				),
				p('')
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario with a text-selection WITHIN 33333 (partial range, not cursor)", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		selectRange(editor, '333', '3');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario: selection entire '33333' word (from after '3' to end of line)", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		// Select from right after first '3' to end of "33333"
		selectRange(editor, '3', '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario with FULL extension set (same as production editor)", async () => {
		const editor = await makeFullEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});

	it("user's scenario: lift a lone nested child when parent has following siblings", () => {
		// Doc:
		//   11111
		//   • 22222
		//     ○ 33333
		//   • 44444
		// Cursor on 33333, Alt+←.
		// Expected:
		//   11111
		//   • 22222
		//   • 33333
		//   • 44444
		// Bug observed: 33333 and 44444 swap order.
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(
					li(p('22222'), ul(li(p('33333')))),
					li(p('44444'))
				)
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '- 33333', '- 44444'].join('\n')
		);
	});
});

describe('liftListItemOnly — interaction with siblings', () => {
	it('lifting an item with following-sibling items keeps those siblings in the original list', () => {
		// - X
		//   - A
		//   - Y
		// Expected (Alt+← on A): A goes to root, Y stays under X.
		// - X
		//   - Y
		// - A
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('Y'))))))
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - Y', '- A'].join('\n')
		);
	});
});

// ============================================================================
//                                ROUND-TRIPS
// ============================================================================

// ============================================================================
//                           MULTI-SELECTION (Range)
// ============================================================================

// ============================================================================
//                     SELECTION PRESERVATION (multi-select)
// ============================================================================

describe('selection preservation', () => {
	it('sink: multi-line range selection stays selected after the operation', () => {
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A')), li(p('B')), li(p('C'))))
		);
		selectRange(editor, 'A', 'C');
		// Before: selection covers "A..C" across three list items.
		const beforeText = editor.state.doc.textBetween(
			editor.state.selection.from,
			editor.state.selection.to,
			'\n'
		);
		expect(beforeText).toMatch(/A[\s\S]*B[\s\S]*C/);
		expect(sinkListItemOnly(editor)).toBe(true);
		// After: selection should still cover the same logical block.
		expect(editor.state.selection.empty).toBe(false);
		const afterText = editor.state.doc.textBetween(
			editor.state.selection.from,
			editor.state.selection.to,
			'\n'
		);
		expect(afterText).toMatch(/A[\s\S]*B[\s\S]*C/);
	});

	it('lift: multi-line range selection stays selected after the operation', () => {
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(li(p('A')), li(p('B')), li(p('C')))
					)
				)
			)
		);
		selectRange(editor, 'A', 'C');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(editor.state.selection.empty).toBe(false);
		const afterText = editor.state.doc.textBetween(
			editor.state.selection.from,
			editor.state.selection.to,
			'\n'
		);
		expect(afterText).toMatch(/A[\s\S]*B[\s\S]*C/);
	});

	it('sink: single-cursor selection remains a single cursor after the operation', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('Hello')))));
		placeCursorAt(editor, 'Hello');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(editor.state.selection.empty).toBe(true);
	});
});

describe('sinkListItemOnly — multi-selection', () => {
	it('sinks all selected consecutive items into the previous sibling', () => {
		// - X
		// - A   ← selection from here
		// - B
		// - C   ← to here
		// Expected:
		// - X
		//   - A
		//   - B
		//   - C
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A')), li(p('B')), li(p('C'))))
		);
		selectRange(editor, 'A', 'C');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '  - C'].join('\n')
		);
	});

	it('selection touching the last char of an item still includes that item', () => {
		// Selection from A..B (ends right after B) — both A and B are in-range.
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A')), li(p('B')), li(p('C'))))
		);
		selectRange(editor, 'A', 'B');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '- C'].join('\n')
		);
	});

	it("if the first selected item has no previous sibling, returns false (no-op)", () => {
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		selectRange(editor, 'A', 'B');
		const before = outline(editor.getJSON());
		expect(sinkListItemOnly(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('multi-selection where items have children: each item\'s children stay at their visual depth', () => {
		// - X
		// - A
		//   - A1
		// - B
		//   - B1
		// Select A..B
		// Expected:
		// - X
		//   - A
		//   - A1
		//   - B
		//   - B1
		const editor = makeEditor(
			doc(
				ul(
					li(p('X')),
					li(p('A'), ul(li(p('A1')))),
					li(p('B'), ul(li(p('B1'))))
				)
			)
		);
		selectRange(editor, 'A', 'B');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - A1', '  - B', '  - B1'].join('\n')
		);
	});

	it('selection that includes non-selected intermediate items treats them as part of the block', () => {
		// - X
		// - A   ← start selection inside A
		// - B       (not touched by selection, but in between)
		// - C   ← end selection inside C
		// Expected: A, B, C all sink together (block behavior).
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A')), li(p('B')), li(p('C'))))
		);
		selectRange(editor, 'A', 'C');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '  - C'].join('\n')
		);
	});

	it('single-position selection (no range) — behaves like single-item (regression)', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('A')))));
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - A'].join('\n'));
	});
});

describe('liftListItemOnly — multi-selection', () => {
	it('lifts all selected consecutive items out of their parent', () => {
		// - X
		//   - A   ← start
		//   - B
		//   - C   ← end
		// Expected:
		// - X
		// - A
		// - B
		// - C
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(li(p('A')), li(p('B')), li(p('C')))
					)
				)
			)
		);
		selectRange(editor, 'A', 'C');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '- A', '- B', '- C'].join('\n')
		);
	});

	it('lifting a subset leaves non-selected siblings under the original parent', () => {
		// - X
		//   - A   ← start
		//   - B   ← end
		//   - C       (not selected)
		// Expected:
		// - X
		//   - C
		// - A
		// - B
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(li(p('A')), li(p('B')), li(p('C')))
					)
				)
			)
		);
		selectRange(editor, 'A', 'B');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - C', '- A', '- B'].join('\n')
		);
	});

	it('lifting multi-selection items that each have children keeps those children under the old parent', () => {
		// - X
		//   - A
		//     - A1
		//   - B
		//     - B1
		// Select A..B
		// Expected:
		// - X
		//   - A1
		//   - B1
		// - A
		// - B
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('X'),
						ul(li(p('A'), ul(li(p('A1')))), li(p('B'), ul(li(p('B1')))))
					)
				)
			)
		);
		selectRange(editor, 'A', 'B');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A1', '  - B1', '- A', '- B'].join('\n')
		);
	});

	it('lifting every child of X empties X\'s sub-list (no orphan empty list node)', () => {
		// - X
		//   - A
		//   - B
		// Select A..B, lift both → X has no sub-list; A and B at root.
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B'))))))
		);
		selectRange(editor, 'A', 'B');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '- A', '- B'].join('\n')
		);
	});
});

describe('sink+lift inverse property', () => {
	// Full round-trip only holds when the operated item has no children —
	// with children, the "keep absolute visual depth" rule intentionally
	// flattens nesting into same-depth siblings, losing the hierarchy.
	it('sink-then-lift on a leaf restores the original outline', () => {
		// - X
		// - A
		const original = doc(ul(li(p('X')), li(p('A'))));
		const editor = makeEditor(original);
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		expect(sinkListItemOnly(editor)).toBe(true);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('lift-then-sink on a leaf restores the original outline', () => {
		// - X
		//   - A
		const original = doc(ul(li(p('X'), ul(li(p('A'))))));
		const editor = makeEditor(original);
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		expect(liftListItemOnly(editor)).toBe(true);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});
});
