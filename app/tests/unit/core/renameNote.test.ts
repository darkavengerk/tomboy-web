import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, renameNote, getNote } from '$lib/core/noteManager.js';
import { serializeNote, parseNote } from '$lib/core/noteArchiver.js';
import * as noteStore from '$lib/storage/noteStore.js';

describe('renameNote', () => {
	it('첫 줄과 note.title 을 함께 갱신하고 라운드트립이 일치한다', async () => {
		const n = await createNote({ title: '예전 제목' });
		const { ok } = await renameNote(n.guid, '새 제목');
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
		expect((await renameNote(a.guid, '   ')).ok).toBe(false);
		expect((await renameNote(a.guid, 'A 노트')).ok).toBe(true); // 동일 → no-op 성공
		expect((await renameNote(a.guid, 'B 노트')).ok).toBe(false); // 충돌
	});

	it('백링크 캐스케이드: 소스 노트의 <link:internal> 이 새 타이틀로 재작성된다', async () => {
		// 1. 타깃 노트 생성
		const target = await createNote({ title: '타깃 노트' });

		// 2. 타깃을 내부 링크로 참조하는 소스 노트 생성 후 xmlContent 에 link:internal 삽입.
		//    createNote 로 뼈대를 만든 뒤 xmlContent 를 직접 덮어써서 putNote 로 저장하면
		//    backlinkIndex.updateNote 가 즉시 호출되어 인덱스가 따뜻해진다.
		const source = await createNote({ title: '소스 노트' });
		const sourceWithLink = {
			...source,
			xmlContent:
				'<note-content version="0.1">소스 노트\n<link:internal>타깃 노트</link:internal>\n</note-content>'
		};
		await noteStore.putNote(sourceWithLink);

		// 3. 타깃 노트 이름 변경 → 백링크 캐스케이드 실행
		const { ok, backlinksUpdated } = await renameNote(target.guid, '바뀐 타깃');
		expect(ok).toBe(true);
		expect(backlinksUpdated).toBe(1);

		// 4. 소스 노트가 새 타이틀로 재작성됐는지 확인
		const updatedSource = await noteStore.getNote(source.guid);
		expect(updatedSource!.xmlContent).toContain('<link:internal>바뀐 타깃</link:internal>');
		expect(updatedSource!.xmlContent).not.toContain('<link:internal>타깃 노트</link:internal>');
	});
});
