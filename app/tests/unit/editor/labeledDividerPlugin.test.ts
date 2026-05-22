import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createLabeledDividerPlugin } from '$lib/editor/labeledDivider/labeledDividerPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: string): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyLabeledDividerTest',
				addProseMirrorPlugins() {
					return [createLabeledDividerPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('labeledDividerPlugin', () => {
	it('decorates a centered divider and exposes the label', () => {
		const editor = makeEditor(
			'<p>title</p><p>sub</p><p>-- 회의록 --</p>'
		);
		const dom = editor.view.dom;
		expect(dom.querySelector('p.tomboy-labeled-divider--center')).not.toBeNull();
		const label = dom.querySelector('.tomboy-labeled-divider-label');
		expect(label?.textContent).toBe('회의록');
		expect(dom.querySelectorAll('.tomboy-labeled-divider-mark').length).toBe(2);
	});

	it('decorates a left divider with the left class', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>회의록 ---</p>');
		const dom = editor.view.dom;
		expect(dom.querySelector('p.tomboy-labeled-divider--left')).not.toBeNull();
		expect(dom.querySelector('.tomboy-labeled-divider-label')?.textContent).toBe(
			'회의록'
		);
		expect(dom.querySelectorAll('.tomboy-labeled-divider-mark').length).toBe(1);
	});

	it('decorates multiple labeled dividers in one document', () => {
		const editor = makeEditor(
			'<p>title</p><p>sub</p><p>-- A --</p><p>plain</p><p>B ---</p>'
		);
		const dom = editor.view.dom;
		expect(dom.querySelectorAll('p.tomboy-labeled-divider').length).toBe(2);
	});

	it('never decorates the title / subtitle lines (index 0 and 1)', () => {
		const editor = makeEditor(
			'<p>-- 회의록 --</p><p>회의록 ---</p><p>body</p>'
		);
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('does not decorate a plain paragraph', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>hello world</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('does not treat a pure --- HR as a labeled divider', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>-----</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
	});

	it('re-parses live when the paragraph text changes', () => {
		const editor = makeEditor('<p>title</p><p>sub</p><p>회의록</p>');
		expect(
			editor.view.dom.querySelector('.tomboy-labeled-divider')
		).toBeNull();
		// Append ' ---' to the end of the last paragraph's content.
		const end = editor.state.doc.content.size - 1;
		editor.view.dispatch(editor.state.tr.insertText(' ---', end));
		expect(
			editor.view.dom.querySelector('p.tomboy-labeled-divider--left')
		).not.toBeNull();
	});
});
