import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, renameNote, getNote } from '$lib/core/noteManager.js';
import { serializeNote, parseNote } from '$lib/core/noteArchiver.js';

describe('renameNote', () => {
	it('첫 줄과 note.title 을 함께 갱신하고 라운드트립이 일치한다', async () => {
		const n = await createNote({ title: '예전 제목' });
		const ok = await renameNote(n.guid, '새 제목');
		expect(ok).toBe(true);
		const fresh = await getNote(n.guid);
		expect(fresh!.title).toBe('새 제목');
		expect(fresh!.xmlContent).toContain('<note-content version="0.1">새 제목');
		const xml = serializeNote(fresh!);
		const reparsed = parseNote(xml, fresh!.uri);
		expect(reparsed.title).toBe('새 제목');
		expect(reparsed.xmlContent).toContain('새 제목');
	});

	it('빈/동일 제목은 no-op, 충돌은 false', async () => {
		const a = await createNote({ title: 'A 노트' });
		await createNote({ title: 'B 노트' });
		expect(await renameNote(a.guid, '   ')).toBe(false);
		expect(await renameNote(a.guid, 'A 노트')).toBe(true); // 동일 → no-op 성공
		expect(await renameNote(a.guid, 'B 노트')).toBe(false); // 충돌
	});
});
