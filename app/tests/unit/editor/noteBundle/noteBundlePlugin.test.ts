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
const li = (t: string) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
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

function radioCount(ed: Editor): number {
	let n = 0;
	ed.state.doc.descendants((node) => {
		if (node.type.name === 'inlineRadio') n++;
	});
	return n;
}

describe('noteBundlePlugin', () => {
	it('checked 번들 → 스택 1회 마운트 + 리스트 숨김 데코레이션', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'))),
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
		makeEditor(doc(titleLine('호스트'), kw('묶음:50', false), list(li('A'))), mountStack);
		await tick();
		expect(calls.mounted).toBe(0);
	});

	it('라디오 자동삽입 없음 — 리스트 내용 무수정', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'))),
			mountStack
		);
		await tick();
		await tick();
		expect(radioCount(ed)).toBe(0);
	});

	it('체크 해제 → destroy + 데코레이션 제거', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'))),
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

	it('writeBundleHeightPct: 숫자 교체 + 숫자 없으면 삽입 + 클램프', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'))),
			mountStack
		);
		await tick();
		writeBundleHeightPct(ed.view, 0, 63);
		expect(ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n')).toContain('묶음:63');

		// 숫자 없는 키워드에 삽입 (별도 editor)
		const { mountStack: mountStack2 } = makeStub();
		const ed2 = makeEditor(
			doc(titleLine('호스트2'), kw('묶음:', true), list(li('A'))),
			mountStack2
		);
		await tick();
		writeBundleHeightPct(ed2.view, 0, 95);
		expect(ed2.state.doc.textBetween(0, ed2.state.doc.content.size, '\n')).toContain('묶음:90');
	});

	it('XML 라운드트립: 데코레이션은 직렬화에 영향 없음', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'))),
			mountStack
		);
		await tick();
		const xml = serializeContent(ed.getJSON());
		expect(xml).toContain('[x]묶음:50');
		expect(xml).toContain('<link:internal>A</link:internal>');
		expect(xml).toContain('<link:internal>B</link:internal>');
	});

	it('리스트 없는 번들 위젯 — 크래시 없음 + listPos === null', async () => {
		// bulletList 없이 키워드만 있는 경우
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:50', true)), mountStack);
		await tick();
		// 위젯은 keywordEnd 에 붙어야 하므로 마운트 1회
		expect(calls.mounted).toBe(1);
		const st = noteBundlePluginKey.getState(ed.state)!;
		expect(st.bundles[0].listPos).toBeNull();
		// node 데코레이션(hidden) 은 없어야 한다
		const nodeDecos = st.decorations.find().filter((d) => {
			// widget decoration 은 from===to, node decoration 은 from<to
			return (d as { from: number; to: number }).from < (d as { from: number; to: number }).to;
		});
		expect(nodeDecos.length).toBe(0);
	});

	it('ordinal 재배정 — 컨트롤러 1개 destroy + 생존 컨트롤러가 2번째 번들 spec 수신', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:50', true),
				list(li('A')),
				kw('묶음:60', true),
				list(li('B'))
			),
			mountStack
		);
		await tick();
		expect(calls.mounted).toBe(2);

		// 첫 번째 번들의 키워드 paragraph + list 범위를 삭제한다.
		const st = noteBundlePluginKey.getState(ed.state)!;
		const b0 = st.bundles[0];
		// keyword paragraph 시작: checkboxPos - 1 (paragraph 열기 토큰)
		const paraStart = b0.checkboxPos - 1;
		// list 끝: b0.listEnd (exclusive)
		const listEnd = b0.listEnd!;
		ed.view.dispatch(ed.state.tr.delete(paraStart, listEnd));
		await tick();

		// 첫 번째 컨트롤러가 destroy 됐어야 한다
		expect(calls.destroyed).toBe(1);
		// 남은 컨트롤러(ordinal 0 으로 재배정)가 update 를 받았어야 한다
		// — 마지막 update spec 의 tree[0].label 이 'B' (원 2번 번들)
		const lastUpdate = calls.updates[calls.updates.length - 1];
		expect(lastUpdate).toBeDefined();
		expect(lastUpdate.tree[0]?.label).toBe('B');
	});
});
