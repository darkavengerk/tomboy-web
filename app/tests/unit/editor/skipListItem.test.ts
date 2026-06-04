import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { skipListItem } from '$lib/editor/sendListItem/transferListItem.js';
import {
	createSendListItemPlugin,
	sendListItemPluginKey
} from '$lib/editor/sendListItem/sendListItemPlugin.js';
import { findMonthBulletList } from '$lib/editor/sendListItem/recurringCopy.js';

// 토스트는 부수효과일 뿐 — 테스트 환경에서 조용히 무시.
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

const WD = ['일', '월', '화', '수', '목', '금', '토'] as const;
function wd(year: number, month: number, day: number): string {
	return WD[new Date(year, month - 1, day).getDay()];
}
function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [para(text)] };
}
function bullet(items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

let currentEditor: Editor | null = null;
let mountEl: HTMLElement | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
	mountEl?.remove();
	mountEl = null;
});

function makeEditor(doc: JSONContent, opts?: { onSend?: () => void; onSkip?: () => void }): Editor {
	const extensions = [
		StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
		TomboyParagraph,
		TomboyListItem
	];
	if (opts) {
		extensions.push(
			Extension.create({
				name: 'tomboySendListItem',
				addProseMirrorPlugins() {
					return [
						createSendListItemPlugin({
							onSend: opts.onSend ?? (() => {}),
							onSkip: opts.onSkip ?? (() => {})
						})
					];
				}
			}) as never
		);
	}
	mountEl = document.createElement('div');
	document.body.appendChild(mountEl);
	const editor = new Editor({ element: mountEl, extensions, content: doc });
	currentEditor = editor;
	return editor;
}

function findLiPos(editor: Editor, match: string): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos >= 0) return false;
		if (node.type.name !== 'listItem') return true;
		if ((node.firstChild?.textContent ?? '') === match) {
			pos = p;
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`listItem not found: ${match}`);
	return pos;
}
function monthTexts(editor: Editor, month: number): string[] {
	const list = findMonthBulletList(editor.state.doc, month);
	if (!list) return [];
	const out: string[] = [];
	list.node.forEach((child) => out.push(child.firstChild?.textContent ?? ''));
	return out;
}
function skip(editor: Editor, match: string) {
	const pos = findLiPos(editor, match);
	const node = editor.state.doc.nodeAt(pos)!;
	skipListItem(editor, pos, node);
}

describe('skipListItem (히스토리 이동 없이 삭제 / 다음 주기 이동)', () => {
	const year = new Date().getFullYear();

	it('마커 없는 항목: 그냥 삭제, 복제본 없음', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('3(금) 등산'), li('9(목) 빨래')])]
		});
		skip(editor, '3(금) 등산');
		// 삭제만 — 다음 항목만 남고 어디에도 복제본 없음
		expect(monthTexts(editor, 5)).toEqual(['9(목) 빨래']);
	});

	it('monthly 마커: 삭제 대신 다음 달로 이동(원본 제거 + 다음 달 정렬 삽입)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('25*(수) 가스점검'), li('3(금) 등산')]),
				para('6월'),
				bullet([li('1(월) 친구'), li('30(화) 마감')])
			]
		});
		skip(editor, '25*(수) 가스점검');
		// 5월: 원본 제거
		expect(monthTexts(editor, 5)).toEqual(['3(금) 등산']);
		// 6월: 다음 주기로 이동, 마커 보존, 정렬됨
		expect(monthTexts(editor, 6)).toEqual([
			'1(월) 친구',
			`25*(${wd(year, 6, 25)}) 가스점검`,
			'30(화) 마감'
		]);
	});

	it('everyNWeeks 마커: 다음 주기(+N주)로 이동, 마커 보존', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('1(수) a'), li('8(수) b'), li('15(수**) routine')])]
		});
		skip(editor, '15(수**) routine');
		// 15 제거, 29(=15+14) 추가, 정렬, ** 보존
		expect(monthTexts(editor, 5)).toEqual([
			'1(수) a',
			'8(수) b',
			`29(${wd(year, 5, 29)}**) routine`
		]);
	});
});

describe('createSendListItemPlugin (스킵 + 보내기 버튼)', () => {
	function activate(editor: Editor) {
		editor.view.dispatch(editor.state.tr.setMeta(sendListItemPluginKey, { active: true }));
	}

	it('활성 시 리스트 아이템마다 스킵·보내기 버튼을 렌더한다', () => {
		const editor = makeEditor(
			{ type: 'doc', content: [bullet([li('3(금) a'), li('9(목) b')])] },
			{}
		);
		activate(editor);
		const skips = editor.view.dom.querySelectorAll('.tomboy-skip-li-btn');
		const sends = editor.view.dom.querySelectorAll('.tomboy-send-li-btn');
		expect(skips).toHaveLength(2);
		expect(sends).toHaveLength(2);
		expect(skips[0].textContent).toBe('스킵');
		expect(sends[0].textContent).toBe('보내기');
	});

	it('스킵 클릭은 onSkip을, 보내기 클릭은 onSend를 호출한다', () => {
		const onSkip = vi.fn();
		const onSend = vi.fn();
		const editor = makeEditor(
			{ type: 'doc', content: [bullet([li('3(금) a')])] },
			{ onSend, onSkip }
		);
		activate(editor);
		const skipBtn = editor.view.dom.querySelector('.tomboy-skip-li-btn') as HTMLButtonElement;
		const sendBtn = editor.view.dom.querySelector('.tomboy-send-li-btn') as HTMLButtonElement;
		skipBtn.click();
		expect(onSkip).toHaveBeenCalledTimes(1);
		expect(onSend).not.toHaveBeenCalled();
		const [, liNode] = onSkip.mock.calls[0];
		expect(liNode.firstChild?.textContent).toBe('3(금) a');
		sendBtn.click();
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it('비활성 시 버튼을 렌더하지 않는다', () => {
		const editor = makeEditor(
			{ type: 'doc', content: [bullet([li('3(금) a')])] },
			{}
		);
		expect(editor.view.dom.querySelectorAll('.tomboy-skip-li-btn')).toHaveLength(0);
		expect(editor.view.dom.querySelectorAll('.tomboy-send-li-btn')).toHaveLength(0);
	});
});
