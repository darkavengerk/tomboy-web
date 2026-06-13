import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, getNote } from '$lib/core/noteManager.js';
import { getNotebook } from '$lib/core/notebooks.js';

describe('createNote 옵션', () => {
	it('bodyFirstLine 을 본문 2번째 줄로 시드한다', async () => {
		const n = await createNote({ title: '내 서버', bodyFirstLine: 'ssh://pi@host' });
		expect(n.title).toBe('내 서버');
		const lines = n.xmlContent
			.replace(/^<note-content[^>]*>/, '')
			.replace(/<\/note-content>$/, '')
			.split('\n');
		expect(lines[0]).toBe('내 서버');
		expect(lines[1]).toBe('ssh://pi@host');
	});

	it('notebook 옵션을 태그로 넣는다', async () => {
		const n = await createNote({ title: '업무 메모', notebook: '업무' });
		const fresh = await getNote(n.guid);
		expect(getNotebook(fresh!)).toBe('업무');
	});

	it('문자열 인자 역호환 — 날짜형 타이틀 시드 유지', async () => {
		const n = await createNote('2026-06-13');
		expect(n.xmlContent).toContain('2026년');
	});
});
