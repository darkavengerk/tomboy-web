import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { insertTable } from '$lib/editor/insertTable.js';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';

// Destroy editors so prosemirror's DOMObserver flush timer can't fire after
// jsdom teardown ("document is not defined" unhandled error).
const editors: Editor[] = [];
afterEach(() => {
	for (const ed of editors.splice(0)) ed.destroy();
});

function makeEditor(): Editor {
	const ed = new Editor({
		extensions: [Document, Paragraph, Text],
		content: { type: 'doc', content: [{ type: 'paragraph' }] }
	});
	editors.push(ed);
	return ed;
}

describe('insertTable', () => {
	it('inserts an empty 2x2 markdown table', () => {
		const ed = makeEditor();
		insertTable(ed);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		expect(region).toBeTruthy();
		expect(region.rows).toEqual([
			['', ''],
			['', '']
		]);
		expect(region.align).toHaveLength(2);
	});
});
