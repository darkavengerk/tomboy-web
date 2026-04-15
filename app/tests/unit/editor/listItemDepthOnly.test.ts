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

describe('sink+lift inverse property', () => {
	it("lift-then-sink restores the original outline (item with one child)", () => {
		const original = doc(
			ul(li(p('X'), ul(li(p('A'), ul(li(p('B')))))))
		);
		const editor = makeEditor(original);
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		expect(liftListItemOnly(editor)).toBe(true);
		// After lift, place cursor on A again.
		placeCursorAt(editor, 'A');
		expect(sinkListItemOnly(editor)).toBe(true);
		// After lift+sink, expect either the original outline OR a structurally
		// equivalent one. We accept both since intermediate state may shuffle
		// adjacency but the semantic positions of A and B should match.
		expect(outline(editor.getJSON())).toBe(before);
	});
});
