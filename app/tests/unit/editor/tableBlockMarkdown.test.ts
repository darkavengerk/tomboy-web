import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Extension } from '@tiptap/core';
import { createTableBlockPlugin } from '$lib/editor/tableBlock/tableBlockPlugin.js';

function makeEditor(lines: string[]): Editor {
	const el = document.createElement('div');
	return new Editor({
		element: el,
		extensions: [
			Document,
			Paragraph,
			Text,
			Extension.create({
				name: 'tomboyTableBlock',
				addProseMirrorPlugins() {
					return [createTableBlockPlugin()];
				}
			})
		],
		content: {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		}
	});
}

describe('tableBlockPlugin — markdown', () => {
	it('renders a markdown table', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		expect(ed.view.dom.querySelector('.tomboy-table-block-table')).toBeTruthy();
	});

	it('applies column alignment to cells', () => {
		const ed = makeEditor(['| a | b | c |', '| :--- | :--: | ---: |', '| 1 | 2 | 3 |']);
		const ths = ed.view.dom.querySelectorAll('.tomboy-table-block-table th');
		expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
		expect((ths[1] as HTMLElement).style.textAlign).toBe('center');
		expect((ths[2] as HTMLElement).style.textAlign).toBe('right');
	});

	it('coexists with a csv fence table', () => {
		const ed = makeEditor([
			'```csv',
			'x,y',
			'```',
			'',
			'| a | b |',
			'| --- | --- |',
			'| 1 | 2 |'
		]);
		expect(ed.view.dom.querySelectorAll('.tomboy-table-block-table').length).toBe(2);
	});
});
