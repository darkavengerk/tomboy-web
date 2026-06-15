import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import {
	buildTitleInsertTr,
	buildFallbackInsertTr
} from '$lib/editor/noteTitleDrop/noteTitleDropPlugin.js';

let editor: Editor | null = null;
function mount(html: string) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	editor = new Editor({ element: el, extensions: [StarterKit], content: html });
	return editor;
}
afterEach(() => {
	editor?.destroy();
	editor = null;
});

describe('buildTitleInsertTr — adjacency spacing', () => {
	it('inserts spaces on BOTH sides when dropped mid-word', () => {
		const ed = mount('<p>helloworld</p>'); // content positions 1..11
		const tr = buildTitleInsertTr(ed.state, 6, 'TITLE'); // between hello|world
		expect(tr.doc.textContent).toBe('hello TITLE world');
	});

	it('space only BEFORE when dropped at end of a word', () => {
		const ed = mount('<p>hello</p>');
		const tr = buildTitleInsertTr(ed.state, 6, 'TITLE'); // after o, block end
		expect(tr.doc.textContent).toBe('hello TITLE');
	});

	it('space only AFTER when dropped at start of a word', () => {
		const ed = mount('<p>hello</p>');
		const tr = buildTitleInsertTr(ed.state, 1, 'TITLE'); // before h
		expect(tr.doc.textContent).toBe('TITLE hello');
	});

	it('no extra space when an existing space already abuts', () => {
		const ed = mount('<p>a b</p>'); // 1=a 2=space 3=b
		const tr = buildTitleInsertTr(ed.state, 3, 'TITLE'); // after the space, before b
		expect(tr.doc.textContent).toBe('a TITLE b'); // no double space before
	});

	it('caret lands right after the inserted title', () => {
		const ed = mount('<p>helloworld</p>');
		const tr = buildTitleInsertTr(ed.state, 6, 'TITLE');
		// pos 6 + 1 leading space + 5 title chars = 12
		expect(tr.selection.from).toBe(12);
	});
});

describe('buildFallbackInsertTr — newline then title', () => {
	it('splits at the cursor and drops the title on a new line', () => {
		const ed = mount('<p>hello</p>');
		ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 6)));
		const tr = buildFallbackInsertTr(ed.state, 'TITLE');
		expect(tr.doc.childCount).toBe(2);
		expect(tr.doc.child(0).textContent).toBe('hello');
		expect(tr.doc.child(1).textContent).toBe('TITLE');
	});
});
