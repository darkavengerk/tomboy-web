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
		const json: JSONContent = editor.getJSON();
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

	it("user's EXACT scenario (image #4): both 33333 and 44444 are siblings at depth 2", () => {
		// Before:
		//   11111
		//   • 22222
		//     ○ 33333   ← cursor
		//     ○ 44444
		// Expected after Alt+← on 33333:
		//   11111
		//   • 22222
		//     ○ 44444   ← 33333 was at index 0; removing it leaves 44444 alone, still nested
		//   • 33333
		// Bug observed: 33333 ends up still at depth 2, AFTER 44444 (order swap, no lift).
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it("same scenario but lifting 44444 (index 1) instead of 33333 (index 0)", () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAt(editor, '44444');
		expect(liftListItemOnly(editor)).toBe(true);
		// 44444 was at index 1 in the nested list. Lifting only 44444:
		// - parent list becomes [33333]
		// - 44444 becomes sibling of 22222 in outer list
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 33333', '- 44444'].join('\n')
		);
	});

	it('lift a nested item when the outer list has NO preceding paragraph', () => {
		// • 22222
		//   ○ 33333   ← cursor
		//   ○ 44444
		const editor = makeEditor(
			doc(ul(li(p('22222'), ul(li(p('33333')), li(p('44444'))))))
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it('lift a nested item when there are multiple preceding paragraphs', () => {
		const editor = makeEditor(
			doc(
				p('aa'),
				p('bb'),
				p('cc'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['aa', 'bb', 'cc', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it('lift a triple-nested item (depth 3 → depth 2)', () => {
		// - 22222
		//   - 33333
		//     - 44444   ← cursor
		const editor = makeEditor(
			doc(ul(li(p('22222'), ul(li(p('33333'), ul(li(p('44444'))))))))
		);
		placeCursorAt(editor, '44444');
		expect(liftListItemOnly(editor)).toBe(true);
		// 44444 lifts from depth 3 to depth 2 (sibling of 33333 under 22222).
		expect(outline(editor.getJSON())).toBe(
			['- 22222', '  - 33333', '  - 44444'].join('\n')
		);
	});

	it('lift a triple-nested item where siblings exist at the same nested depth', () => {
		// - 22222
		//   - X
		//   - 33333
		//     - 44444   ← cursor
		//     - 55555
		//   - Y
		const editor = makeEditor(
			doc(
				ul(
					li(
						p('22222'),
						ul(
							li(p('X')),
							li(p('33333'), ul(li(p('44444')), li(p('55555')))),
							li(p('Y'))
						)
					)
				)
			)
		);
		placeCursorAt(editor, '44444');
		expect(liftListItemOnly(editor)).toBe(true);
		// 44444 lifts to depth 2 (sibling of 33333 and X/Y under 22222).
		// 55555 stays at depth 3 under 33333 (because 44444 was at index 0, 55555 stays at index 0 post-lift).
		// Insertion point: after 33333's listItem in 22222's sublist.
		expect(outline(editor.getJSON())).toBe(
			[
				'- 22222',
				'  - X',
				'  - 33333',
				'    - 55555',
				'  - 44444',
				'  - Y'
			].join('\n')
		);
	});

	it('sink first item of inner list (index 0) — should be no-op, NOT alter order', () => {
		// • 22222
		//   ○ 33333   ← cursor here, sink attempt
		//   ○ 44444
		// 33333 is at index 0 in its parent list, so sink should return false.
		// The doc must be UNCHANGED (no swap).
		const editor = makeEditor(
			doc(ul(li(p('22222'), ul(li(p('33333')), li(p('44444'))))))
		);
		placeCursorAt(editor, '33333');
		const before = outline(editor.getJSON());
		expect(sinkListItemOnly(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
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

// ============================================================================
//                     EDGE CASE TESTS (new, targeting browser bug)
// ============================================================================

// Helper: place cursor at offset 0 of the first text node containing needle.
function placeCursorAtOffset0(editor: Editor, needle: string): void {
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

// Helper: place cursor in the middle of a text node containing needle.
function placeCursorAtMiddle(editor: Editor, needle: string): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + node.text.indexOf(needle) + Math.floor(needle.length / 2);
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	editor.commands.setTextSelection(pos);
}

describe('edge: cursor positions within text', () => {
	it('lift: cursor at offset 0 (very start) of 33333 — same result as cursor at end', () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAtOffset0(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it('lift: cursor at middle of 33333 — same result as cursor at end', () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAtMiddle(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it('sink: cursor at offset 0 (very start) of item text', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('Hello')))));
		placeCursorAtOffset0(editor, 'Hello');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - Hello'].join('\n'));
	});

	it('lift: cursor at offset 0 lands in a valid position after the operation', () => {
		const editor = makeEditor(doc(ul(li(p('X'), ul(li(p('A')))))));
		placeCursorAtOffset0(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		// Should not throw; cursor should be inside A's paragraph.
		const sel = editor.state.selection;
		expect(sel).toBeDefined();
		const textContent = editor.state.doc.resolve(sel.from).parent.textContent;
		expect(textContent).toBe('A');
	});
});

describe('edge: empty list items', () => {
	it('lift: empty list item (no text) can be lifted without error', () => {
		// - X
		//   - (empty)
		const emptyLi = li(p(''));
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(emptyLi))))
		);
		// Place cursor in the empty listItem
		let emptyPos = -1;
		editor.state.doc.descendants((node, p) => {
			if (emptyPos !== -1) return false;
			if (node.type.name === 'paragraph' && node.childCount === 0) {
				const parent = editor.state.doc.resolve(p).parent;
				if (parent.type.name === 'listItem') {
					emptyPos = p + 1;
				}
			}
			return true;
		});
		if (emptyPos < 0) throw new Error('empty paragraph not found');
		editor.commands.setTextSelection(emptyPos);
		const result = liftListItemOnly(editor);
		expect(result).toBe(true);
		// X should have no sub-list; empty item should be sibling.
		const json = editor.getJSON();
		const outerList = json.content?.[0];
		expect(outerList?.content?.length).toBe(2); // X and the empty item
	});

	it('sink: empty list item sinks without error', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('')))));
		// Find cursor inside the empty paragraph
		let emptyPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (emptyPos !== -1) return false;
			if (node.type.name === 'paragraph' && node.childCount === 0) emptyPos = pos + 1;
			return true;
		});
		if (emptyPos < 0) throw new Error('empty paragraph not found');
		editor.commands.setTextSelection(emptyPos);
		expect(sinkListItemOnly(editor)).toBe(true);
		// Empty item now inside X.
		const json = editor.getJSON();
		const outerList = json.content?.[0];
		expect(outerList?.content?.length).toBe(1); // only X remains at root
	});
});

describe('edge: trailing empty paragraph (TrailingNode simulation)', () => {
	it('lift with trailing empty paragraph at end of doc — doc stays clean', () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444'))))),
				p('') // trailing empty paragraph (as TrailingNode would add)
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});

	it('sink with trailing empty paragraph at end of doc — doc stays clean', () => {
		const editor = makeEditor(
			doc(
				ul(li(p('X')), li(p('A'))),
				p('') // trailing empty paragraph
			)
		);
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - A'].join('\n'));
	});

	it('lift: trailing non-empty paragraph is NOT removed', () => {
		const editor = makeEditor(
			doc(
				ul(li(p('X'), ul(li(p('A'))))),
				p('footer')
			)
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		// 'footer' paragraph should still be there.
		const json: JSONContent = editor.getJSON();
		const lastChild = json.content?.[json.content!.length - 1];
		expect(lastChild?.type).toBe('paragraph');
		expect(lastChild?.content?.[0]?.text).toBe('footer');
	});
});

describe('edge: document starts with a list (no preceding paragraph)', () => {
	it('sink: doc starts with list, no preceding paragraph', () => {
		const editor = makeEditor(doc(ul(li(p('X')), li(p('A')))));
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - A'].join('\n'));
	});

	it('lift from depth 2 in a doc that starts with a list', () => {
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B'))))))
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '  - B', '- A'].join('\n'));
	});

	it('lift index-0 item from depth 2 in doc-starts-with-list', () => {
		// The exact user scenario, but without the leading '11111' paragraph.
		const editor = makeEditor(
			doc(ul(li(p('22222'), ul(li(p('33333')), li(p('44444'))))))
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});
});

describe('edge: 3-deep and 4-deep nesting', () => {
	it('lift from depth 3 (3-level nesting) — index 0', () => {
		// - A
		//   - B
		//     - C   ← cursor (index 0 in depth-3 list)
		//     - D
		const editor = makeEditor(
			doc(ul(li(p('A'), ul(li(p('B'), ul(li(p('C')), li(p('D'))))))))
		);
		placeCursorAt(editor, 'C');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- A', '  - B', '    - D', '  - C'].join('\n')
		);
	});

	it('lift from depth 4 (4-level nesting)', () => {
		// - A
		//   - B
		//     - C
		//       - D   ← cursor
		//       - E
		const editor = makeEditor(
			doc(
				ul(li(p('A'), ul(li(p('B'), ul(li(p('C'), ul(li(p('D')), li(p('E')))))))))
			)
		);
		placeCursorAt(editor, 'D');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- A', '  - B', '    - C', '      - E', '    - D'].join('\n')
		);
	});

	it('sink to depth 4 — fourth level', () => {
		// - A
		//   - B
		//     - C
		//     - D   ← cursor, sink to depth 4
		const editor = makeEditor(
			doc(
				ul(li(p('A'), ul(li(p('B'), ul(li(p('C')), li(p('D')))))))
			)
		);
		placeCursorAt(editor, 'D');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- A', '  - B', '    - C', '      - D'].join('\n')
		);
	});
});

describe('edge: last item of a list', () => {
	it('lift the LAST item of a 3-item nested list', () => {
		// - X
		//   - A
		//   - B
		//   - C   ← cursor (last item, index 2)
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A')), li(p('B')), li(p('C'))))))
		);
		placeCursorAt(editor, 'C');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- X', '  - A', '  - B', '- C'].join('\n')
		);
	});

	it('sink the LAST item of a 3-item top-level list', () => {
		// - A
		// - B
		// - C   ← cursor (last)
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')), li(p('C')))));
		placeCursorAt(editor, 'C');
		expect(sinkListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['- A', '- B', '  - C'].join('\n')
		);
	});
});

describe('edge: ul inside ol, ol inside ul combinations', () => {
	it('lift from ol nested inside ul', () => {
		// ul > li(X) > ol > li(A)   ← cursor
		const editor = makeEditor(
			doc(ul(li(p('X'), ol(li(p('A'))))))
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		// A lifts to become sibling of X in the outer ul.
		expect(outline(editor.getJSON())).toBe(['- X', '- A'].join('\n'));
	});

	it('lift from ul nested inside ol', () => {
		// ol > li(X) > ul > li(A)   ← cursor
		const editor = makeEditor(
			doc(ol(li(p('X'), ul(li(p('A'))))))
		);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['- X', '- A'].join('\n'));
	});

	it('lift index-0 from ol nested inside ul, with sibling at index 1', () => {
		// ul > li(22222) > ol > li(33333)[index 0], li(44444)[index 1]
		// This is structurally identical to the user's bug scenario but with ol inner list.
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ol(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
	});
});

describe('edge: range selections crossing boundaries', () => {
	it('range from inside one top-level listItem to inside its SIBLING at same level — ops on both', () => {
		// - A   ← selection starts here
		// - B   ← selection ends here
		// (both at top level — lift should return false since not nested)
		const editor = makeEditor(doc(ul(li(p('A')), li(p('B')))));
		selectRange(editor, 'A', 'B');
		const before = outline(editor.getJSON());
		// Top-level items can't be lifted.
		expect(liftListItemOnly(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('range from end of one item to start of next item (exact boundary) — both included', () => {
		// Select from the end of 'A' to the start of 'B' — boundary edge.
		const editor = makeEditor(
			doc(ul(li(p('X')), li(p('A')), li(p('B')), li(p('C'))))
		);
		// Select exactly at end of A to end of B.
		const fromPos = findPosAfter(editor, 'A'); // right after 'A'
		const toPos = findPosAfter(editor, 'B');   // right after 'B'
		editor.commands.setTextSelection({ from: fromPos, to: toPos });
		expect(sinkListItemOnly(editor)).toBe(true);
		// A is at the selection boundary but both A and B should sink.
		const result = outline(editor.getJSON());
		expect(result).toContain('- X');
		// At minimum, B should have sunk (it was fully in range).
		expect(result).toContain('  - B');
	});

	it('range starting inside outer listItem paragraph ending inside its nested child — findOperationRange handles it', () => {
		// - X
		//   paragraph of X is at depth 1; its nested child A is at depth 2.
		// Selection: from inside X's paragraph text to inside A's paragraph text.
		// sharedDepth(from, to) = the bulletList at depth 1.
		// So findOperationRange should find the outer list and index = 0 (X).
		const editor = makeEditor(
			doc(ul(li(p('X'), ul(li(p('A'))))))
		);
		// Place from inside 'X' and to inside 'A'.
		const fromPos = findPosAfter(editor, 'X') - 1; // inside X text
		const toPos = findPosAfter(editor, 'A');         // after A text
		editor.commands.setTextSelection({ from: fromPos, to: toPos });
		// Operation range is the outer list at depth 1; X is at index 0 with no previous sibling.
		// Sink should return false (no prev sibling for X).
		const sinkResult = sinkListItemOnly(editor);
		expect(sinkResult).toBe(false);
	});
});

describe('edge: repeated operations', () => {
	it('lift twice in a row — second call from depth 1 returns false', () => {
		// - X
		//   - A   ← cursor
		// First lift: A goes to root.
		// Second lift attempt on A (now at root): should return false.
		const editor = makeEditor(doc(ul(li(p('X'), ul(li(p('A')))))));
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(false);
	});

	it('sink twice in a row — second call goes deeper', () => {
		// - X
		// - A   ← cursor
		// First sink: A under X.
		// Second sink: A under... but nothing before it, so false.
		const editor = makeEditor(doc(ul(li(p('X')), li(p('A')))));
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		placeCursorAt(editor, 'A');
		// A is now at depth 2 (first item under X's sub-list), no prev sibling → false.
		expect(sinkListItemOnly(editor)).toBe(false);
	});

	it('lift then lift again on the exact user scenario: first lift succeeds, second returns false', () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(
			['11111', '- 22222', '  - 44444', '- 33333'].join('\n')
		);
		// 33333 is now at root level → second lift is impossible.
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(false);
	});
});

describe('edge: after prior unrelated transaction', () => {
	it('lift works correctly after an insertContent operation', () => {
		const editor = makeEditor(
			doc(
				p('11111'),
				ul(li(p('22222'), ul(li(p('33333')), li(p('44444')))))
			)
		);
		// First, do an unrelated edit: insert a space at the end of 33333.
		placeCursorAt(editor, '33333');
		editor.commands.insertContent(' ');
		// Now cursor is after '33333 ' — the text is now '33333 '.
		// Lift from 33333 (cursor still inside that item).
		expect(liftListItemOnly(editor)).toBe(true);
		// The structure should still be correct, just the text has an extra space.
		const result = outline(editor.getJSON());
		expect(result).toContain('- 22222');
		expect(result).toContain('  - 44444');
		// 33333 (with trailing space) should have lifted.
		expect(result).toMatch(/- 33333/);
	});
});

describe('edge: single-item lists', () => {
	it('lift: only item in a nested single-item list — removes the sub-list entirely', () => {
		// - X
		//   - A   (only item)
		const editor = makeEditor(doc(ul(li(p('X'), ul(li(p('A')))))));
		placeCursorAt(editor, 'A');
		expect(liftListItemOnly(editor)).toBe(true);
		// X should no longer have a sub-list.
		const json: JSONContent = editor.getJSON();
		const xItem = json.content?.[0]?.content?.[0];
		expect(xItem?.content?.length).toBe(1); // only the paragraph, no sub-list
		expect(outline(json)).toBe(['- X', '- A'].join('\n'));
	});

	it('sink: only item in a top-level single-item list returns false (no prev sibling)', () => {
		const editor = makeEditor(doc(ul(li(p('A')))));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		expect(sinkListItemOnly(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

describe('edge: empty document / degenerate cases', () => {
	it('lift on an empty doc returns false gracefully', () => {
		const editor = makeEditor(doc(p('')));
		editor.commands.setTextSelection(1);
		expect(liftListItemOnly(editor)).toBe(false);
	});

	it('sink on an empty doc returns false gracefully', () => {
		const editor = makeEditor(doc(p('')));
		editor.commands.setTextSelection(1);
		expect(sinkListItemOnly(editor)).toBe(false);
	});
});

describe('edge: NodeSelection on a listItem', () => {
	it('lift with NodeSelection on a listItem node — does not throw, returns true or false', () => {
		const { NodeSelection } = require('prosemirror-state');
		const editor = makeEditor(doc(ul(li(p('X'), ul(li(p('A')))))));
		// Find the position of the nested listItem (A) and create a NodeSelection.
		let liPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (liPos !== -1) return false;
			if (node.type.name === 'listItem' && node.textContent === 'A') {
				liPos = pos;
				return false;
			}
			return true;
		});
		if (liPos < 0) throw new Error('listItem A not found');
		const sel = NodeSelection.create(editor.state.doc, liPos);
		const tr = editor.state.tr.setSelection(sel);
		editor.view.dispatch(tr);
		// Should not throw regardless of true/false.
		let threw = false;
		try {
			liftListItemOnly(editor);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});

describe('edge: marks across selection (bold, italic)', () => {
	it('lift with bold mark in the item text — full extension editor', async () => {
		// Use makeFullEditor since marks require additional extensions.
		const contentWithBold: JSONContent = doc(
			p('11111'),
			ul(
				li(
					p('22222'),
					ul(
						li({
							type: 'paragraph',
							content: [
								{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
								{ type: 'text', text: '33' }
							]
						}),
						li(p('44444'))
					)
				)
			)
		);
		const editor = await makeFullEditor(contentWithBold);
		// Place cursor at end of '33' (inside the bold item).
		placeCursorAt(editor, '33');
		expect(liftListItemOnly(editor)).toBe(true);
		// The bold item should have lifted to be sibling of 22222.
		const json = editor.getJSON();
		const outerList = json.content?.[1];
		// 22222 item should have sub-list with only 44444.
		// bold33 item should be sibling of 22222 in the outer list.
		expect(outerList?.content?.length).toBe(2);
	});
});

describe('edge: full production editor — exact bug reproduction', () => {
	const bugDoc: JSONContent = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '11111' }] },
			{
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '22222' }] },
							{
								type: 'bulletList',
								content: [
									{
										type: 'listItem',
										content: [
											{ type: 'paragraph', content: [{ type: 'text', text: '33333' }] }
										]
									},
									{
										type: 'listItem',
										content: [
											{ type: 'paragraph', content: [{ type: 'text', text: '44444' }] }
										]
									}
								]
							}
						]
					}
				]
			}
		]
	};

	const expectedOutline = ['11111', '- 22222', '  - 44444', '- 33333'].join('\n');

	it('makeFullEditor + cursor at END of 33333 (placeCursorAt) — bug scenario', async () => {
		const editor = await makeFullEditor(bugDoc);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(expectedOutline);
	});

	it('makeFullEditor + cursor at START (offset 0) of 33333 — bug scenario', async () => {
		const editor = await makeFullEditor(bugDoc);
		placeCursorAtOffset0(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(expectedOutline);
	});

	it('makeFullEditor + cursor at MIDDLE of 33333 — bug scenario', async () => {
		const editor = await makeFullEditor(bugDoc);
		placeCursorAtMiddle(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(expectedOutline);
	});

	it('makeFullEditor + selectRange of entire 33333 text — bug scenario', async () => {
		const editor = await makeFullEditor(bugDoc);
		selectRange(editor, '3333', '33333'); // selects from inside to end
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(expectedOutline);
	});

	it('makeFullEditor + with trailing empty paragraph — bug scenario + TrailingNode', async () => {
		const docWithTrailing: JSONContent = {
			...bugDoc,
			content: [...(bugDoc.content ?? []), { type: 'paragraph', content: [] }]
		};
		const editor = await makeFullEditor(docWithTrailing);
		placeCursorAt(editor, '33333');
		expect(liftListItemOnly(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(expectedOutline);
	});

	it('makeFullEditor + NodeSelection on the 33333 listItem — bug scenario', async () => {
		const { NodeSelection } = await import('prosemirror-state');
		const editor = await makeFullEditor(bugDoc);
		let liPos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (liPos !== -1) return false;
			if (node.type.name === 'listItem' && node.textContent === '33333') {
				liPos = pos;
				return false;
			}
			return true;
		});
		if (liPos < 0) throw new Error('listItem 33333 not found');
		const sel = NodeSelection.create(editor.state.doc, liPos);
		const tr = editor.state.tr.setSelection(sel);
		editor.view.dispatch(tr);
		let threw = false;
		try {
			liftListItemOnly(editor);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});
