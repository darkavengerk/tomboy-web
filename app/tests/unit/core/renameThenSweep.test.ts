import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, renameNote } from '$lib/core/noteManager.js';
import { countLinkSweep, applyLinkSweep } from '$lib/core/linkSweep.js';
import * as noteStore from '$lib/storage/noteStore.js';

describe('rename → cascade → re-sweep 합성', () => {
	it('캐스케이드 후 같은 노트에 스윕을 돌려도 링크가 중복되지 않는다', async () => {
		const target = await createNote({ title: '원래 제목' });
		const source = await createNote({ title: '출처' });
		// 출처 노트가 타깃을 평문으로 멘션(아직 링크 아님)
		await noteStore.putNote({
			...source,
			xmlContent: '<note-content version="0.1">출처\n원래 제목 언급\n</note-content>'
		});

		// 1차 스윕: 평문 멘션이 링크가 된다
		const first = await countLinkSweep('원래 제목', target.guid);
		expect(first.matched).toContain(source.guid);
		await applyLinkSweep('원래 제목', target.guid, first.matched);

		// 타깃 리네임 → 캐스케이드가 출처의 링크 텍스트를 새 제목으로 재작성
		const { ok, backlinksUpdated } = await renameNote(target.guid, '바뀐 제목');
		expect(ok).toBe(true);
		expect(backlinksUpdated).toBe(1);

		// 새 제목으로 재-스윕: 멘션이 이미 링크라 변경 없음
		const second = await countLinkSweep('바뀐 제목', target.guid);
		expect(second.matched).not.toContain(source.guid);
	});
});
