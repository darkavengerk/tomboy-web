import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { EditorView } from '@tiptap/pm/view';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	selectBundleEntry,
	writeBundleHeightPct,
	type BundleSpec,
	type StackController
} from '$lib/editor/noteBundle';
import { serializeContent } from '$lib/core/noteContentArchiver.js';

// Track ALL created editors/hosts so they are ALL destroyed in afterEach.
const allEditors: Editor[] = [];
const allHosts: HTMLElement[] = [];

afterEach(() => {
	for (const ed of allEditors) ed.destroy();
	allEditors.length = 0;
	for (const h of allHosts) h.remove();
	allHosts.length = 0;
});

function makeStub() {
	const calls = { mounted: 0, updates: [] as BundleSpec[], destroyed: 0 };
	const mountStack = (
		_c: HTMLElement,
		_v: EditorView,
		_s: BundleSpec
	): StackController => {
		calls.mounted++;
		return {
			update: (s) => calls.updates.push(s),
			destroy: () => calls.destroyed++
		};
	};
	return { calls, mountStack };
}

function makeEditor(content: object, mountStack: ReturnType<typeof makeStub>['mountStack']) {
	// 위젯 isConnected 가드 통과를 위해 실제 document 에 붙인다.
	const host = document.createElement('div');
	document.body.appendChild(host);
	allHosts.push(host);
	const editor = new Editor({
		element: host,
		extensions: [
			StarterKit,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null,
				deferred: true
			}),
			Extension.create({
				name: 'tomboyNoteBundle',
				addProseMirrorPlugins() {
					return [createNoteBundlePlugin({ mountStack })];
				}
			})
		],
		content
	});
	allEditors.push(editor);
	return editor;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const titleLine = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const kw = (text: string, checked: boolean) => ({
	type: 'paragraph',
	content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text }]
});
const li = (t: string, radio: boolean | null) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
				...(radio === null ? [] : [{ type: 'inlineRadio', attrs: { selected: radio } }]),
				{
					type: 'text',
					text: t,
					marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
				}
			]
		}
	]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

function radios(ed: Editor): boolean[] {
	const out: boolean[] = [];
	ed.state.doc.descendants((n) => {
		if (n.type.name === 'inlineRadio') out.push(n.attrs.selected === true);
	});
	return out;
}

describe('noteBundlePlugin', () => {
	it('checked 번들 → 스택 1회 마운트 + 리스트 숨김 데코레이션', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		expect(calls.mounted).toBe(1);
		const st = noteBundlePluginKey.getState(ed.state)!;
		const b = st.bundles[0];
		const hidden = st.decorations.find(b.listPos!, b.listEnd!);
		expect(hidden.length).toBeGreaterThan(0);
		// 호스트 타이핑 → 리마운트 없음, update 로 전달
		ed.commands.insertContentAt(ed.state.doc.content.size, { type: 'paragraph' });
		await tick();
		expect(calls.mounted).toBe(1);
		expect(calls.updates.length).toBeGreaterThan(0);
	});

	it('unchecked 번들 → 마운트 안 함', async () => {
		const { calls, mountStack } = makeStub();
		makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', false), list(li('A', true))),
			mountStack
		);
		await tick();
		expect(calls.mounted).toBe(0);
	});

	it('라디오 자동삽입: checked + 라디오 없는 항목 → 삽입 + 첫 항목 (o)', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', null), li('B', null))),
			mountStack
		);
		await tick();
		await tick(); // 삽입 tr 반영
		expect(radios(ed)).toEqual([true, false]);
	});

	it('체크 해제 → destroy + 데코레이션 제거', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true))),
			mountStack
		);
		await tick();
		const st = noteBundlePluginKey.getState(ed.state)!;
		ed.view.dispatch(ed.state.tr.setNodeAttribute(st.bundles[0].checkboxPos, 'checked', false));
		await tick();
		expect(calls.destroyed).toBe(1);
		const st2 = noteBundlePluginKey.getState(ed.state)!;
		expect(st2.decorations.find().length).toBe(0);
	});

	it('selectBundleEntry: 라디오 상호 배타 갱신', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		const b = noteBundlePluginKey.getState(ed.state)!.bundles[0];
		selectBundleEntry(ed.view, b, 1);
		expect(radios(ed)).toEqual([false, true]);
	});

	it('writeBundleHeightPct: 숫자 교체 + 숫자 없으면 삽입 + 클램프', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true))),
			mountStack
		);
		await tick();
		let b = noteBundlePluginKey.getState(ed.state)!.bundles[0];
		writeBundleHeightPct(ed.view, b, 63);
		expect(ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n')).toContain('노트 묶음:63');

		// 숫자 없는 키워드에 삽입 (별도 editor)
		const { mountStack: mountStack2 } = makeStub();
		const ed2 = makeEditor(
			doc(titleLine('호스트2'), kw('노트 묶음:', true), list(li('A', true))),
			mountStack2
		);
		await tick();
		b = noteBundlePluginKey.getState(ed2.state)!.bundles[0];
		writeBundleHeightPct(ed2.view, b, 95);
		expect(ed2.state.doc.textBetween(0, ed2.state.doc.content.size, '\n')).toContain(
			'노트 묶음:90'
		);
	});

	it('XML 라운드트립: 데코레이션은 직렬화에 영향 없음', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		const xml = serializeContent(ed.getJSON());
		expect(xml).toContain('[x]노트 묶음:50');
		expect(xml).toContain('(o)');
		expect(xml).toContain('( )');
		expect(xml).toContain('<link:internal>A</link:internal>');
	});
});
