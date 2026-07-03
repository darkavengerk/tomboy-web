import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatSendBar from '$lib/editor/chatNote/ChatSendBar.svelte';
import {
	beginImageUpload,
	endImageUpload
} from '$lib/editor/imageUploadTracker.svelte.js';
import type { Editor } from '@tiptap/core';

/**
 * 전송 가능한 claude:// 채팅 노트 doc — 시그니처 + 빈 줄 + 'Q: ...' 턴.
 * ChatSendBar는 editor.getJSON()/on/off만 쓰므로 얇은 fake로 충분.
 */
function chatDocJson() {
	const p = (text: string) => ({
		type: 'paragraph',
		content: text === '' ? [] : [{ type: 'text', text }]
	});
	return {
		type: 'doc',
		content: [p('채팅 노트'), p('claude://'), p(''), p('Q: 이 이미지 읽어줘')]
	};
}

function fakeEditor(): Editor {
	return {
		getJSON: () => chatDocJson(),
		on: () => {},
		off: () => {},
		view: { dom: document.createElement('div') }
	} as unknown as Editor;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
	const btn = container.querySelector('button');
	if (!btn) throw new Error('send button not found');
	return btn as HTMLButtonElement;
}

describe('ChatSendBar — 업로드 중 전송 게이트', () => {
	afterEach(cleanup);

	it('업로드 없으면 전송 가능', () => {
		const editor = fakeEditor();
		const { container } = render(ChatSendBar, {
			props: { editor, bridgeUrl: 'https://b', bridgeToken: 't' }
		});
		expect(sendButton(container).disabled).toBe(false);
	});

	it('이미지 업로드 진행 중이면 전송 비활성 — 완료되면 재활성', async () => {
		const editor = fakeEditor();
		const { container } = render(ChatSendBar, {
			props: { editor, bridgeUrl: 'https://b', bridgeToken: 't' }
		});
		beginImageUpload(editor);
		await tick();
		expect(sendButton(container).disabled).toBe(true);

		endImageUpload(editor);
		await tick();
		expect(sendButton(container).disabled).toBe(false);
	});

	it('다른 에디터의 업로드는 이 노트 전송을 막지 않음', async () => {
		const editor = fakeEditor();
		const other = fakeEditor();
		const { container } = render(ChatSendBar, {
			props: { editor, bridgeUrl: 'https://b', bridgeToken: 't' }
		});
		beginImageUpload(other);
		await tick();
		expect(sendButton(container).disabled).toBe(false);
		endImageUpload(other);
	});
});
