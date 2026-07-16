import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DateNoteFooter from '$lib/desktop/calendar/DateNoteFooter.svelte';
import { putNote } from '$lib/storage/noteStore.js';
import { SEND_TARGET_GUID } from '$lib/editor/sendListItem/transferListItem.js';
import { createEmptyNote } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';

// 허브 노트 xml — 2024 년도 링크 하나.
function hubXml(): string {
	return (
		'<note-content version="0.1">히스토리 기록\n' +
		'<link:internal>2024 - 히스토리 기록</link:internal></note-content>'
	);
}
// 2024 년도 노트 xml — 7월 16일 항목.
function yearXml(): string {
	return (
		'<note-content version="0.1">2024 - 히스토리 기록\n2024\n7월\n' +
		'<list><list-item dir="ltr">16일(화) 독서모임</list-item></list></note-content>'
	);
}

async function seedNote(guid: string, title: string, xml: string) {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = xml;
	await putNote(n);
}

describe('DateNoteFooter', () => {
	beforeEach(async () => {
		// fake-indexeddb 는 vitest setup 에서 자동 초기화되지 않음 — 기존 IDB-touching
		// 테스트(home.test.ts, favorite.test.ts) 패턴대로 매 테스트 새 팩토리로 리셋한다.
		globalThis.indexedDB = new IDBFactory();
		_resetDBForTest();
		await seedNote(SEND_TARGET_GUID, '히스토리 기록', hubXml());
		await seedNote('year-2024-guid', '2024 - 히스토리 기록', yearXml());
	});
	afterEach(() => cleanup());

	it('renders prev-year records for a date title', async () => {
		const { findByText } = render(DateNoteFooter, { props: { title: '2026-07-16' } });
		expect(await findByText('독서모임')).toBeTruthy();
		expect(await findByText('2024')).toBeTruthy();
	});

	it('renders nothing for a non-date title', () => {
		const { container } = render(DateNoteFooter, { props: { title: '아무 노트' } });
		expect(container.querySelector('.date-note-footer')).toBeNull();
	});
});
