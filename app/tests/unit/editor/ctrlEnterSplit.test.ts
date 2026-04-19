import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { ctrlEnterSplit } from '$lib/editor/ctrlEnterSplit.js';
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

function docJson(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}
function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

/** Outline the doc as readable text. One line per block. Bullets indented.
 *  Drops TipTap's auto-inserted trailing empty paragraph after a top-level
 *  list so assertions focus on meaningful content. */
function outline(json: JSONContent): string {
	const lines: string[] = [];
	function visit(node: JSONContent, depth: number, inList: boolean): void {
		if (node.type === 'doc') {
			const kids = [...(node.content ?? [])];
			if (kids.length >= 2) {
				const last = kids[kids.length - 1];
				const secondLast = kids[kids.length - 2];
				const isEmptyPara =
					last.type === 'paragraph' && (!last.content || last.content.length === 0);
				if (
					isEmptyPara &&
					(secondLast.type === 'bulletList' || secondLast.type === 'orderedList')
				) {
					kids.pop();
				}
			}
			for (const c of kids) visit(c, depth, false);
			return;
		}
		if (node.type === 'bulletList' || node.type === 'orderedList') {
			for (const c of node.content ?? []) visit(c, depth, true);
			return;
		}
		if (node.type === 'listItem') {
			const firstPara = (node.content ?? []).find((c) => c.type === 'paragraph');
			const text = (firstPara?.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			lines.push('  '.repeat(depth) + '- ' + text);
			for (const c of (node.content ?? []).slice(1)) visit(c, depth + 1, true);
			return;
		}
		if (node.type === 'paragraph') {
			const text = (node.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			if (!inList) lines.push(text);
		}
	}
	visit(json, 0, false);
	return lines.join('\n');
}

describe('ctrlEnterSplit — paragraphs', () => {
	it('with caret in middle: preserves the line and inserts empty line below', () => {
		const editor = makeEditor(docJson(p('hello world')));
		// "hello world" — place caret right after "hello" (pos 6 inside the paragraph).
		editor.commands.setTextSelection(6);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('hello world\n');
	});

	it('with caret at the start of the line: behaves like Enter at end of line', () => {
		const editor = makeEditor(docJson(p('hello')));
		editor.commands.setTextSelection(1); // caret before 'h'
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('hello\n');
	});

	it('with caret at the end of the line: same as regular Enter', () => {
		const editor = makeEditor(docJson(p('hello')));
		editor.commands.setTextSelection(6); // after "hello"
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('hello\n');
	});

	it('caret lands on the newly inserted empty line', () => {
		const editor = makeEditor(docJson(p('hello')));
		editor.commands.setTextSelection(3); // middle of "hello"
		ctrlEnterSplit(editor);
		const { from } = editor.state.selection;
		// Caret should sit inside the new empty paragraph, past the first para.
		const firstParaEnd = 'hello'.length + 2; // <p>hello</p> closes at 7
		expect(from).toBeGreaterThan(firstParaEnd);
	});

	it('only splits the current line — other blocks unchanged', () => {
		const editor = makeEditor(docJson(p('first'), p('second'), p('third')));
		// Place cursor in the middle of "second".
		editor.commands.setTextSelection(11);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('first\nsecond\n\nthird');
	});

	it('on an empty paragraph: inserts another empty paragraph below', () => {
		const editor = makeEditor(docJson(p('')));
		editor.commands.setTextSelection(1);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('\n');
	});
});

describe('ctrlEnterSplit — list items', () => {
	it('caret in middle of a list item: preserves the item, adds an empty sibling below', () => {
		const editor = makeEditor(
			docJson({
				type: 'bulletList',
				content: [
					{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
					{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }
				]
			})
		);
		// Position cursor inside "one" — between 'o' and 'n' (offset 2 inside
		// the paragraph inside listItem 0).
		// Positions: bulletList opens at 0; listItem at 1; paragraph at 2; text "one" starts at 3.
		// Caret at pos 4 = between 'o' and 'n'.
		editor.commands.setTextSelection(4);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('- one\n- \n- two');
	});

	it('caret at the end of a list item: same as Enter at end of line', () => {
		const editor = makeEditor(
			docJson({
				type: 'bulletList',
				content: [
					{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }
				]
			})
		);
		// End of paragraph inside listItem: pos 6 (after "one").
		editor.commands.setTextSelection(6);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('- one\n- ');
	});

	it('caret inside a nested list item: new sibling at the same nesting level', () => {
		const editor = makeEditor(
			docJson({
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
							{
								type: 'bulletList',
								content: [
									{
										type: 'listItem',
										content: [
											{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }
										]
									}
								]
							}
						]
					}
				]
			})
		);
		// Move cursor into "inner". Structure:
		//   bulletList(0) > listItem(1) > paragraph(2) "outer" [3..8] >
		//     bulletList(9) > listItem(10) > paragraph(11) > text "inner" starts at 12.
		// Caret at pos 14 = between 'i' and 'n' in "inner".
		editor.commands.setTextSelection(14);
		ctrlEnterSplit(editor);
		expect(outline(editor.getJSON())).toBe('- outer\n  - inner\n  - ');
	});
});
