import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Slice, Fragment } from '@tiptap/pm/model';
import { TomboyInlineRadio, insertInlineRadio } from '../../../../src/lib/editor/inlineRadio';
import { TomboyInlineCheckbox } from '../../../../src/lib/editor/inlineCheckbox';

function makeEditor(content: any = { type: 'doc', content: [{ type: 'paragraph' }] }) {
	return new Editor({
		extensions: [StarterKit, ...TomboyInlineRadio, ...TomboyInlineCheckbox],
		content
	});
}

function typeText(editor: Editor, text: string) {
	// PM input rules fire via `handleTextInput` prop — iterate all plugins
	// via someProp's callback form so the correct extension's rule wins
	// when multiple inputRulesPlugins are stacked (radio + checkbox + StarterKit).
	for (const ch of text) {
		const { from, to } = editor.state.selection;
		const handled = editor.view.someProp(
			'handleTextInput',
			(f: any) => f(editor.view, from, to, ch)
		);
		if (!handled) {
			editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}
}

describe('inlineRadio schema', () => {
	it('creates an atomic inline node with selected default false', () => {
		const editor = makeEditor();
		const type = editor.schema.nodes.inlineRadio;
		expect(type).toBeDefined();
		expect(type.isAtom).toBe(true);
		expect(type.isInline).toBe(true);
		expect(type.spec.selectable).toBe(true);
		expect(type.spec.marks).toBe('');
		const node = type.create({ selected: false });
		expect(node.attrs.selected).toBe(false);
		expect(node.nodeSize).toBe(1);
		editor.destroy();
	});
});

describe('inlineRadio NodeView render', () => {
	it('renders span.tomboy-inline-radio data-selected="false"', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'inlineRadio', attrs: { selected: false } }] }
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-radio');
		expect(dom).not.toBeNull();
		expect(dom!.getAttribute('data-selected')).toBe('false');
		editor.destroy();
	});

	it('renders data-selected="true" for selected', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'inlineRadio', attrs: { selected: true } }] }
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-radio');
		expect(dom!.getAttribute('data-selected')).toBe('true');
		editor.destroy();
	});
});

describe('inlineRadio input rule', () => {
	it('converts ( ) typed in body to unselected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '( )');
		const para = editor.state.doc.lastChild!;
		expect(para.childCount).toBe(1);
		expect(para.firstChild!.type.name).toBe('inlineRadio');
		expect(para.firstChild!.attrs.selected).toBe(false);
		editor.destroy();
	});

	it('converts (o) typed in body to selected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '(o)');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('converts (O) uppercase to selected node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '(O)');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('does NOT convert in the title line (idx=0)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, ' ( )');
		let hasRadio = false;
		editor.state.doc.firstChild!.descendants((n) => {
			if (n.type.name === 'inlineRadio') hasRadio = true;
		});
		expect(hasRadio).toBe(false);
		editor.destroy();
	});
});

function makeParagraphSlice(editor: Editor, text: string): Slice {
	const schema = editor.schema;
	const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
	return new Slice(Fragment.from(paragraph), 1, 1);
}

// 여러 extension 의 transformPasted 가 동시에 등록돼 있을 때
// someProp 은 첫 truthy 만 돌려준다. 라디오 변환을 검증하려면
// 모든 transformPasted 플러그인을 순서대로 적용해야 한다.
function applyAllTransformPasted(editor: Editor, slice: Slice): Slice {
	let cur = slice;
	const plugins = (editor.view.state as any).plugins as any[];
	for (const p of plugins) {
		const fn = p.props?.transformPasted;
		if (typeof fn === 'function') {
			cur = fn(cur, editor.view);
		}
	}
	return cur;
}

describe('inlineRadio paste transform', () => {
	it('splits ( ) / (o) in pasted slice into nodes', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		const slice = makeParagraphSlice(editor, '답: ( ) A (o) B');
		const transformed = applyAllTransformPasted(editor, slice);
		const para = transformed.content.firstChild!;
		const types: { type: string; attrs: any }[] = [];
		para.forEach((n) => types.push({ type: n.type.name, attrs: n.attrs }));
		expect(types.map((t) => t.type)).toEqual([
			'text',
			'inlineRadio',
			'text',
			'inlineRadio',
			'text'
		]);
		expect(types[1].attrs.selected).toBe(false);
		expect(types[3].attrs.selected).toBe(true);
		editor.destroy();
	});

	it('does NOT transform when destination is the title line', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(3);
		const slice = makeParagraphSlice(editor, ' ( )');
		const transformed = applyAllTransformPasted(editor, slice);
		let hasRadio = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineRadio') hasRadio = true;
		});
		expect(hasRadio).toBe(false);
		editor.destroy();
	});
});

describe('insertInlineRadio (Alt+R 헬퍼)', () => {
	it('inserts an unselected radio atom at the cursor in body', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '질문: ' }] }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		const ok = insertInlineRadio(editor);
		expect(ok).toBe(true);
		const para = editor.state.doc.lastChild!;
		expect(para.lastChild!.type.name).toBe('inlineRadio');
		expect(para.lastChild!.attrs.selected).toBe(false);
		editor.destroy();
	});

	it('places the cursor right after the inserted atom', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '답: ' }] }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		const before = editor.state.selection.from;
		insertInlineRadio(editor);
		// atom 크기 1 → 커서는 삽입 위치 + 1
		expect(editor.state.selection.from).toBe(before + 1);
		editor.destroy();
	});

	it('refuses to insert in the title line (idx=0)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(3);
		const before = editor.state.doc.toJSON();
		const ok = insertInlineRadio(editor);
		expect(ok).toBe(false);
		expect(editor.state.doc.toJSON()).toEqual(before);
		editor.destroy();
	});
});

describe('inlineRadio group toggle (mousedown)', () => {
	it('selecting an unselected radio clears siblings in same paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'text', text: ' A ' },
						{ type: 'inlineRadio', attrs: { selected: false } },
						{ type: 'text', text: ' B' }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		expect(radios.length).toBe(2);
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		const r0 = para.child(0);
		const r1 = para.child(2);
		expect(r0.attrs.selected).toBe(false);
		expect(r1.attrs.selected).toBe(true);
		editor.destroy();
	});

	it('clicking an already-selected radio toggles it off (none selected)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		(radios[0] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		expect(para.child(0).attrs.selected).toBe(false);
		expect(para.child(1).attrs.selected).toBe(false);
		editor.destroy();
	});

	it('radios in different list-item bodies are independent groups', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'inlineRadio', attrs: { selected: true } },
										{ type: 'text', text: ' 상위' }
									]
								},
								{
									type: 'bulletList',
									content: [
										{
											type: 'listItem',
											content: [
												{
													type: 'paragraph',
													content: [
														{ type: 'inlineRadio', attrs: { selected: false } },
														{ type: 'text', text: ' 자식' }
													]
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		expect(radios.length).toBe(2);
		// Click the nested-item radio → parent-item radio must stay selected.
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		let parentRadioSelected: boolean | null = null;
		let childRadioSelected: boolean | null = null;
		let seen = 0;
		editor.state.doc.descendants((n) => {
			if (n.type.name !== 'inlineRadio') return;
			if (seen === 0) parentRadioSelected = n.attrs.selected;
			else childRadioSelected = n.attrs.selected;
			seen++;
		});
		expect(parentRadioSelected).toBe(true);
		expect(childRadioSelected).toBe(true);
		editor.destroy();
	});

	it('does NOT affect inlineCheckbox in the same paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineCheckbox', attrs: { checked: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radio = editor.view.dom.querySelector('.tomboy-inline-radio') as HTMLElement;
		radio.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para = editor.state.doc.lastChild!;
		expect(para.child(0).attrs.checked).toBe(true);
		expect(para.child(1).attrs.selected).toBe(true);
		editor.destroy();
	});

	it('undo restores group state in a single step', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineRadio', attrs: { selected: true } },
						{ type: 'inlineRadio', attrs: { selected: false } }
					]
				}
			]
		});
		const radios = editor.view.dom.querySelectorAll('.tomboy-inline-radio');
		(radios[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const para1 = editor.state.doc.lastChild!;
		expect(para1.child(0).attrs.selected).toBe(false);
		expect(para1.child(1).attrs.selected).toBe(true);
		editor.commands.undo();
		const para2 = editor.state.doc.lastChild!;
		expect(para2.child(0).attrs.selected).toBe(true);
		expect(para2.child(1).attrs.selected).toBe(false);
		editor.destroy();
	});
});
