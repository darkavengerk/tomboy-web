import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '../../../../src/lib/editor/inlineCheckbox';

function makeEditor(content: any = { type: 'doc', content: [{ type: 'paragraph' }] }) {
	return new Editor({
		extensions: [StarterKit, ...TomboyInlineCheckbox],
		content
	});
}

describe('inlineCheckbox schema', () => {
	it('creates an atomic inline node with checked default false', () => {
		const editor = makeEditor();
		const type = editor.schema.nodes.inlineCheckbox;
		expect(type).toBeDefined();
		expect(type.isAtom).toBe(true);
		expect(type.isInline).toBe(true);
		expect(type.spec.selectable).toBe(true);
		expect(type.spec.marks).toBe('');
		const node = type.create({ checked: false });
		expect(node.attrs.checked).toBe(false);
		expect(node.nodeSize).toBe(1);
		editor.destroy();
	});

	it('preserves checked=true through doc round-trip', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '할 일 ' },
						{ type: 'inlineCheckbox', attrs: { checked: true } }
					]
				}
			]
		};
		const editor = makeEditor(doc);
		const para = editor.state.doc.firstChild!;
		const cb = para.lastChild!;
		expect(cb.type.name).toBe('inlineCheckbox');
		expect(cb.attrs.checked).toBe(true);
		editor.destroy();
	});
});

describe('inlineCheckbox NodeView', () => {
	it('renders <span class="tomboy-inline-checkbox" data-checked="false"> for unchecked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: false } }]
				}
			]
		});
		editor.view.updateState(editor.view.state);
		const dom = editor.view.dom.querySelector('.tomboy-inline-checkbox');
		expect(dom).not.toBeNull();
		expect(dom!.getAttribute('data-checked')).toBe('false');
		editor.destroy();
	});

	it('renders data-checked="true" for checked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: true } }]
				}
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-checkbox');
		expect(dom!.getAttribute('data-checked')).toBe('true');
		editor.destroy();
	});
});

function typeText(editor: Editor, text: string) {
	// PM input rules fire via `handleTextInput` prop — call it directly
	// per-character, same pattern as footnote/node.test.ts.
	for (const ch of text) {
		const { from, to } = editor.state.selection;
		const handler = editor.view.someProp('handleTextInput') as
			| ((view: any, from: number, to: number, text: string) => boolean)
			| undefined;
		const handled = handler ? handler(editor.view, from, to, ch) : false;
		if (!handled) {
			editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}
}

describe('inlineCheckbox input rule', () => {
	it('converts [ ] typed in body to unchecked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[ ]');
		const para = editor.state.doc.lastChild!;
		expect(para.childCount).toBe(1);
		expect(para.firstChild!.type.name).toBe('inlineCheckbox');
		expect(para.firstChild!.attrs.checked).toBe(false);
		editor.destroy();
	});

	it('converts [x] typed in body to checked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[x]');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.checked).toBe(true);
		editor.destroy();
	});

	it('converts [X] (uppercase) to checked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[X]');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.checked).toBe(true);
		editor.destroy();
	});

	it('does NOT convert in the title line (idx=0)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, ' [ ]');
		const para = editor.state.doc.firstChild!;
		expect(para.textContent).toContain('[ ]');
		let hasCheckbox = false;
		para.descendants((n) => {
			if (n.type.name === 'inlineCheckbox') hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(false);
		editor.destroy();
	});
});

import { Slice, Fragment } from '@tiptap/pm/model';

function makeSlice(editor: Editor, paragraphText: string): Slice {
	const schema = editor.schema;
	const paragraph = schema.nodes.paragraph.create(
		null,
		schema.text(paragraphText)
	);
	return new Slice(Fragment.from(paragraph), 1, 1);
}

describe('inlineCheckbox paste transform', () => {
	it('splits [ ] / [x] in pasted slice into nodes', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);

		const slice = makeSlice(editor, '할 일 [ ] 라면 [x] 끓이기');
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		const para = transformed.content.firstChild!;
		const types: { type: string; attrs: any }[] = [];
		para.forEach((n) => types.push({ type: n.type.name, attrs: n.attrs }));
		const typeNames = types.map((t) => t.type);
		expect(typeNames).toEqual([
			'text',
			'inlineCheckbox',
			'text',
			'inlineCheckbox',
			'text'
		]);
		expect(types[1].attrs.checked).toBe(false);
		expect(types[3].attrs.checked).toBe(true);
		editor.destroy();
	});

	it('does NOT transform when destination is the title line', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(3);
		const slice = makeSlice(editor, ' [ ]');
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		let hasCheckbox = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineCheckbox') hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(false);
		editor.destroy();
	});

	it('recurses into nested list fragments', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);

		const schema = editor.schema;
		const li = schema.nodes.listItem.create(
			null,
			schema.nodes.paragraph.create(null, schema.text('[ ] 첫 항목'))
		);
		const list = schema.nodes.bulletList.create(null, li);
		const slice = new Slice(Fragment.from(list), 2, 2);

		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		let hasCheckbox = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineCheckbox') hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(true);
		editor.destroy();
	});
});
