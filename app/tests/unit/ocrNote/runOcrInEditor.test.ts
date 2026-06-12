import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ClaudeChatError } from '$lib/chatNote/backends/claude.js';
import { runOcrInEditor } from '$lib/ocrNote/runOcrInEditor.js';
import type { OcrNoteSpec } from '$lib/ocrNote/parseOcrNote.js';

// vi.mock must be at the top level (hoisted by vitest)
const sendClaudeMock = vi.fn();

vi.mock('$lib/chatNote/backends/claude.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/chatNote/backends/claude.js')>();
	return {
		...original,
		sendClaude: (...args: unknown[]) => sendClaudeMock(...args)
	};
});

// Destroy editors so prosemirror's DOMObserver flush timer can't fire after
// jsdom teardown ("document is not defined" unhandled error).
const editors: Editor[] = [];
afterEach(() => {
	for (const ed of editors.splice(0)) ed.destroy();
});

function makeEditor() {
	const ed = new Editor({
		extensions: [StarterKit],
		content: '<p>ocr://claude</p><p></p>'
	});
	editors.push(ed);
	return ed;
}

function baseSpec(overrides: Partial<OcrNoteSpec> = {}): OcrNoteSpec {
	return {
		backend: 'claude',
		model: 'claude',
		legacy: false,
		options: {},
		...overrides
	};
}

describe('runOcrInEditor — Claude backend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sendClaude 호출, sendOcr/sendChat 호출 안 됨', async () => {
		sendClaudeMock.mockImplementation(async (opts: { onToken: (d: string) => void }) => {
			opts.onToken('[원문]\nhello\n\n[번역]\n안녕\n');
			return { reason: 'done' };
		});
		const editor = makeEditor();
		const result = await runOcrInEditor({
			editor,
			spec: baseSpec(),
			imageUrl: 'https://dropbox.com/foo.png',
			bridgeUrl: 'wss://bridge.example/ws',
			bridgeToken: 'TOK'
		});
		expect(sendClaudeMock).toHaveBeenCalledOnce();
		expect(result.reason).toBe('done');
		expect(editor.getText()).toContain('hello');
		expect(editor.getText()).toContain('안녕');
	});

	it('body에 image/url 콘텐츠 블록 포함', async () => {
		let captured: { messages: Array<{ role: string; content: Array<{ type: string; source?: { type: string; url: string } }> }> } | undefined;
		sendClaudeMock.mockImplementation(async (opts: { body: typeof captured }) => {
			captured = opts.body;
			return { reason: 'done' };
		});
		await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec(),
			imageUrl: 'https://dropbox.com/foo.png',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(captured!.messages[0].content[0]).toEqual({
			type: 'image',
			source: { type: 'url', url: 'https://dropbox.com/foo.png' }
		});
	});

	it('model="claude"는 body.model undefined로 전달', async () => {
		let captured: { model?: string } | undefined;
		sendClaudeMock.mockImplementation(async (opts: { body: typeof captured }) => {
			captured = opts.body;
			return { reason: 'done' };
		});
		await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec({ model: 'claude' }),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(captured!.model).toBeUndefined();
	});

	it('model="claude-opus-4-7"는 그대로 전달', async () => {
		let captured: { model?: string } | undefined;
		sendClaudeMock.mockImplementation(async (opts: { body: typeof captured }) => {
			captured = opts.body;
			return { reason: 'done' };
		});
		await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec({ model: 'claude-opus-4-7' }),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(captured!.model).toBe('claude-opus-4-7');
	});

	it('빈 응답 → [OCR 결과 없음]', async () => {
		sendClaudeMock.mockResolvedValue({ reason: 'done' });
		const editor = makeEditor();
		await runOcrInEditor({
			editor,
			spec: baseSpec(),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(editor.getText()).toContain('[OCR 결과 없음]');
	});

	it('ClaudeChatError → [OCR 오류: …]', async () => {
		sendClaudeMock.mockImplementation(async () => {
			throw new ClaudeChatError('service_unavailable');
		});
		const editor = makeEditor();
		const result = await runOcrInEditor({
			editor,
			spec: baseSpec(),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(result.reason).toBe('error');
		expect(editor.getText()).toContain('[OCR 오류:');
	});

	it('editor.setEditable(true) 모든 종료 경로에서 호출', async () => {
		sendClaudeMock.mockImplementation(async () => {
			throw new ClaudeChatError('network');
		});
		const editor = makeEditor();
		await runOcrInEditor({
			editor,
			spec: baseSpec(),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(editor.isEditable).toBe(true);
	});

	it('signal abort → reason="abort"', async () => {
		sendClaudeMock.mockResolvedValue({ reason: 'abort' });
		const result = await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec(),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(result.reason).toBe('abort');
	});

	it('system 비어있으면 OCR_CLAUDE_SYSTEM_PROMPT 사용', async () => {
		let captured: { system?: string } | undefined;
		sendClaudeMock.mockImplementation(async (opts: { body: typeof captured }) => {
			captured = opts.body;
			return { reason: 'done' };
		});
		await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec({ system: undefined }),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(captured!.system).toContain('[원문]');
	});

	it('effort 비어있으면 high가 기본값', async () => {
		let captured: { effort?: string } | undefined;
		sendClaudeMock.mockImplementation(async (opts: { body: typeof captured }) => {
			captured = opts.body;
			return { reason: 'done' };
		});
		await runOcrInEditor({
			editor: makeEditor(),
			spec: baseSpec(),
			imageUrl: 'x',
			bridgeUrl: 'wss://b/ws',
			bridgeToken: 'T'
		});
		expect(captured!.effort).toBe('high');
	});
});
