import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
import { getNote } from '$lib/core/noteManager.js';

describe('newNoteFlow', () => {
	beforeEach(() => newNoteFlow.cancel());

	it('open → input, submit → creating → ready → idle', async () => {
		let openedGuid: string | null = null;
		newNoteFlow.open({ notebook: null, navigate: (n) => { openedGuid = n.guid; } });
		expect(newNoteFlow.phase).toBe('input');

		const p = newNoteFlow.submit({ title: '서버', typeId: 'terminal', notebook: null });
		// phase transitions to 'creating' after the async duplicate-check resolves — poll briefly
		for (let i = 0; i < 20 && newNoteFlow.phase !== 'creating'; i++) await new Promise(r => setTimeout(r, 5));
		expect(newNoteFlow.phase).toBe('creating');
		// poll until navigate has been called (openedGuid is set)
		for (let i = 0; i < 50 && !openedGuid; i++) await new Promise(r => setTimeout(r, 5));
		expect(openedGuid).not.toBeNull();
		newNoteFlow.markEditorReady(openedGuid!);
		await p;
		expect(newNoteFlow.phase).toBe('idle');

		const note = await getNote(openedGuid!);
		expect(note!.title).toBe('서버');
		expect(note!.xmlContent).toContain('ssh://user@host');
	});

	it('중복 제목이면 생성하지 않고 input 단계를 유지한다', async () => {
		const { createNote: realCreate } = await import('$lib/core/noteManager.js');
		await realCreate({ title: '중복될 제목' });

		newNoteFlow.open({ notebook: null, navigate: () => {} });
		await newNoteFlow.submit({ title: '중복될 제목', typeId: 'plain', notebook: null });
		expect(newNoteFlow.phase).toBe('input'); // 다이얼로그 유지
	});
});
