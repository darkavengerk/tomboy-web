import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	createFootnoteClaudePlugin,
	footnoteClaudeKey,
	abortFootnoteFill
} from '$lib/editor/footnote/claudePlugin.js';

const sendClaudeMock = vi.fn();
vi.mock('$lib/chatNote/backends/claude.js', async (orig) => {
	const actual = await orig<typeof import('$lib/chatNote/backends/claude.js')>();
	return { ...actual, sendClaude: (...a: unknown[]) => sendClaudeMock(...a) };
});
vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'https://bridge.example'),
	getTerminalBridgeToken: vi.fn(async () => 'tok')
}));
vi.mock('$lib/storage/appSettings.js', async (orig) => {
	const actual = await orig<typeof import('$lib/storage/appSettings.js')>();
	return {
		...actual,
		getClaudeDefaultModel: vi.fn(async () => 'claude-x'),
		getClaudeDefaultEffort: vi.fn(async () => 'high')
	};
});
const toastMock = vi.fn();
vi.mock('$lib/stores/toast.js', async (orig) => {
	const actual = await orig<typeof import('$lib/stores/toast.js')>();
	return { ...actual, pushToast: (...a: unknown[]) => toastMock(...a) };
});

import { runFootnoteClaude } from '$lib/editor/footnote/claudeFill.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});
beforeEach(() => {
	sendClaudeMock.mockReset();
	toastMock.mockReset();
});

function makeEditor(): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote,
			Extension.create({
				name: 'tomboyFootnoteClaudeTest',
				addProseMirrorPlugins() {
					return [createFootnoteClaudePlugin()];
				}
			})
		],
		content: {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				},
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: '설명해줘 @claude ' }
					]
				}
			]
		} as never
	});
	editor = e;
	return e;
}

function defText(e: Editor): string {
	let out = '';
	const doc = e.state.doc;
	doc.descendants((node, pos) => {
		if (node.type.name === 'footnoteMarker') {
			const $a = doc.resolve(pos + 1);
			if ($a.index(0) === 2) out = doc.textBetween(pos + 1, $a.end(), '\n');
		}
		return true;
	});
	return out;
}

describe('runFootnoteClaude', () => {
	it('성공: 정의 칸을 답변으로 채우고 잠금 해제', async () => {
		sendClaudeMock.mockImplementation(async (opts: never) => {
			const o = opts as { onToken: (d: string) => void };
			o.onToken('답변');
			o.onToken(' 본문');
			return { reason: 'done' };
		});
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(defText(e)).toBe('답변 본문');
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
		const body = (sendClaudeMock.mock.calls[0][0] as { body: never }).body as {
			system: string;
			model: string;
			effort: string;
			messages: unknown[];
		};
		expect(body.system).toMatch(/각주/);
		expect(body.model).toBe('claude-x');
		expect(body.effort).toBe('high');
		expect(body.messages).toHaveLength(1);
	});

	it('실패: 원문 복원(@claude, 끝공백 없음) + 토스트', async () => {
		sendClaudeMock.mockRejectedValue(new Error('boom'));
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(defText(e)).toBe('설명해줘 @claude');
		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
	});

	it('bridge 미설정: sendClaude 미호출, 복원 + 토스트', async () => {
		const mod = await import('$lib/editor/terminal/bridgeSettings.js');
		(mod.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(sendClaudeMock).not.toHaveBeenCalled();
		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(defText(e)).toBe('설명해줘 @claude');
	});

	it('중단(abort): signal 발화 시 원문 복원 + 잠금 해제', async () => {
		sendClaudeMock.mockImplementation(
			(opts: { signal?: AbortSignal }) =>
				new Promise((resolve) => {
					opts.signal?.addEventListener('abort', () =>
						resolve({ reason: 'abort' })
					);
				})
		);
		const e = makeEditor();
		const p = runFootnoteClaude(e.view, '1', '설명해줘');
		await new Promise((r) => setTimeout(r, 0)); // sendClaude 호출까지 대기
		abortFootnoteFill(e.view, '1');
		await p;
		expect(defText(e)).toBe('설명해줘 @claude');
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
	});
});
