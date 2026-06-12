import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import { findCellEditRange, commitCellEdit } from '$lib/editor/tableBlock/cellEdit.js';

// Destroy editors so prosemirror's DOMObserver flush timer can't fire after
// jsdom teardown ("document is not defined" unhandled error).
const editors: Editor[] = [];
afterEach(() => {
	for (const ed of editors.splice(0)) ed.destroy();
});

function makeEditor(lines: string[]): Editor {
	const ed = new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		}
	});
	editors.push(ed);
	return ed;
}

describe('findCellEditRange — markdown', () => {
	it('points at the trimmed content of a cell', () => {
		const ed = makeEditor(['| alpha | beta |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const range = findCellEditRange(ed.state.doc, region, 0, 1)!;
		expect(ed.state.doc.textBetween(range.from, range.to, '')).toBe('beta');
	});

	it('returns a zero-width range for an empty cell', () => {
		const ed = makeEditor(['| a |  |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const range = findCellEditRange(ed.state.doc, region, 0, 1)!;
		expect(range.from).toBe(range.to);
	});

	it('commit replaces only the targeted cell', () => {
		const ed = makeEditor(['| alpha | beta |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const tr = commitCellEdit(ed.state, region, 0, 1, 'BETA')!;
		ed.view.dispatch(tr);
		expect(ed.state.doc.firstChild!.textContent).toBe('| alpha | BETA |');
	});
});
