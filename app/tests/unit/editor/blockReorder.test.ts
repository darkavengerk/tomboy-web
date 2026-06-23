import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { moveBlockUp, moveBlockDown } from '$lib/editor/blockReorder.js';
import type { JSONContent } from '@tiptap/core';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(d: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem
		],
		content: d
	});
	currentEditor = editor;
	return editor;
}

/** Render the doc as a flat list of top-level block summaries for assertions. */
function outline(json: JSONContent): string {
	const lines: string[] = [];
	for (const node of json.content ?? []) {
		if (node.type === 'paragraph') {
			lines.push((node.content ?? []).map((n) => n.text ?? '').join(''));
		} else if (node.type === 'bulletList' || node.type === 'orderedList') {
			const items = (node.content ?? [])
				.map((li) => {
					const para = li.content?.[0];
					return (para?.content ?? []).map((n) => n.text ?? '').join('');
				})
				.join(',');
			lines.push(`[${node.type === 'bulletList' ? 'ul' : 'ol'}:${items}]`);
		} else {
			lines.push(`<${node.type}>`);
		}
	}
	return lines.join('\n');
}

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

function selectRange(editor: Editor, fromNeedle: string, toNeedle: string): void {
	const from = findPosAfter(editor, fromNeedle) - fromNeedle.length;
	const to = findPosAfter(editor, toNeedle);
	editor.commands.setTextSelection({ from, to });
}

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [p(text)] };
}
function ul(...texts: string[]): JSONContent {
	return { type: 'bulletList', content: texts.map(li) };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

// Note: index 0 is the (hidden) title; body blocks start at index 1.

describe('moveBlockUp — basic', () => {
	it('moves a body paragraph up past its predecessor', () => {
		// Title / A / B(cursor)  →  Title / B / A
		const editor = makeEditor(doc(p('Title'), p('A'), p('B')));
		placeCursorAt(editor, 'B');
		expect(moveBlockUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', 'B', 'A'].join('\n'));
	});

	it('first body block (index 1) cannot move up into the title', () => {
		// Title / A(cursor) / B
		const editor = makeEditor(doc(p('Title'), p('A'), p('B')));
		placeCursorAt(editor, 'A');
		const before = outline(editor.getJSON());
		expect(moveBlockUp(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('returns false when there is only a title + one body block at the floor', () => {
		const editor = makeEditor(doc(p('Title'), p('A')));
		placeCursorAt(editor, 'A');
		expect(moveBlockUp(editor)).toBe(false);
	});
});

describe('moveBlockDown — basic', () => {
	it('moves a body paragraph down past its successor', () => {
		// Title / A(cursor) / B  →  Title / B / A
		const editor = makeEditor(doc(p('Title'), p('A'), p('B')));
		placeCursorAt(editor, 'A');
		expect(moveBlockDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', 'B', 'A'].join('\n'));
	});

	it('last block cannot move down', () => {
		const editor = makeEditor(doc(p('Title'), p('A'), p('B')));
		placeCursorAt(editor, 'B');
		const before = outline(editor.getJSON());
		expect(moveBlockDown(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

describe('title is immovable', () => {
	it('cursor in title: moveBlockUp/Down both no-op', () => {
		const editor = makeEditor(doc(p('Title'), p('A'), p('B')));
		placeCursorAt(editor, 'Title');
		const before = outline(editor.getJSON());
		expect(moveBlockUp(editor)).toBe(false);
		expect(moveBlockDown(editor)).toBe(false);
		expect(outline(editor.getJSON())).toBe(before);
	});

	it('moving the second body block up never reaches the title', () => {
		// Title / A / B / C — repeatedly move C up; it stops below the title.
		const editor = makeEditor(doc(p('Title'), p('A'), p('B'), p('C')));
		placeCursorAt(editor, 'C');
		expect(moveBlockUp(editor)).toBe(true); // Title/A/C/B
		placeCursorAt(editor, 'C');
		expect(moveBlockUp(editor)).toBe(true); // Title/C/A/B
		expect(outline(editor.getJSON())).toBe(['Title', 'C', 'A', 'B'].join('\n'));
		placeCursorAt(editor, 'C');
		expect(moveBlockUp(editor)).toBe(false); // at the floor, title protected
		expect(outline(editor.getJSON())).toBe(['Title', 'C', 'A', 'B'].join('\n'));
	});
});

describe('mixed block types', () => {
	it('swaps a paragraph with a whole list (list moves as a unit)', () => {
		// Title / A(cursor) / [ul: x,y] / end
		// Trailing 'end' paragraph keeps the doc from ending in a list (which would
		// otherwise gain a TrailingNode-injected empty block).
		const editor = makeEditor(doc(p('Title'), p('A'), ul('x', 'y'), p('end')));
		placeCursorAt(editor, 'A');
		expect(moveBlockDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', '[ul:x,y]', 'A', 'end'].join('\n'));
	});

	it('a list block moves up past a paragraph', () => {
		// Title / A / [ul: x,y](cursor in y) / end
		const editor = makeEditor(doc(p('Title'), p('A'), ul('x', 'y'), p('end')));
		// Cursor in the list → caller would route to moveListItem*, but moveBlockUp
		// itself still operates on the top-level block when invoked directly.
		placeCursorAt(editor, 'y');
		expect(moveBlockUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', '[ul:x,y]', 'A', 'end'].join('\n'));
	});
});

describe('cursor / selection preservation', () => {
	it('cursor stays inside the same text after moveUp', () => {
		const editor = makeEditor(doc(p('Title'), p('Alpha'), p('Beta')));
		placeCursorAtOffset(editor, 'Beta', 2);
		expect(moveBlockUp(editor)).toBe(true);
		const { $from } = editor.state.selection;
		expect($from.parent.textContent).toBe('Beta');
		expect($from.parentOffset).toBe(2);
	});

	it('cursor stays inside the same text after moveDown', () => {
		const editor = makeEditor(doc(p('Title'), p('Alpha'), p('Beta')));
		placeCursorAtOffset(editor, 'Alpha', 3);
		expect(moveBlockDown(editor)).toBe(true);
		const { $from } = editor.state.selection;
		expect($from.parent.textContent).toBe('Alpha');
		expect($from.parentOffset).toBe(3);
	});

	it('range selection across two blocks moves together', () => {
		// Title / A / B(sel start) / C(sel end) / D → moveDown → Title/A/D/B/C
		const editor = makeEditor(doc(p('Title'), p('A'), p('B'), p('C'), p('D')));
		selectRange(editor, 'B', 'C');
		expect(moveBlockDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', 'A', 'D', 'B', 'C'].join('\n'));
		expect(editor.state.selection.empty).toBe(false);
		const selectedText = editor.state.doc.textBetween(
			editor.state.selection.from,
			editor.state.selection.to,
			'\n'
		);
		expect(selectedText).toMatch(/B[\s\S]*C/);
	});
});

describe('round-trips', () => {
	it('moveUp then moveDown restores original order', () => {
		const editor = makeEditor(doc(p('Title'), p('A'), p('B'), p('C')));
		const before = outline(editor.getJSON());
		placeCursorAt(editor, 'B');
		expect(moveBlockUp(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(['Title', 'B', 'A', 'C'].join('\n'));
		placeCursorAt(editor, 'B');
		expect(moveBlockDown(editor)).toBe(true);
		expect(outline(editor.getJSON())).toBe(before);
	});
});

describe('marks survive the move', () => {
	it('bold text preserved after moveUp', () => {
		const editor = makeEditor(
			doc(p('Title'), p('A'), {
				type: 'paragraph',
				content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }]
			})
		);
		placeCursorAt(editor, 'Bold');
		expect(moveBlockUp(editor)).toBe(true);
		const json = editor.getJSON();
		// Bold paragraph is now at index 1.
		const para = json.content?.[1] as JSONContent;
		expect(para?.content?.[0]?.text).toBe('Bold');
		expect(para?.content?.[0]?.marks?.[0]?.type).toBe('bold');
	});
});
