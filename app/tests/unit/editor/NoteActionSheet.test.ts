import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import NoteActionSheet from '$lib/editor/NoteActionSheet.svelte';
import type { NoteData } from '$lib/core/note.js';

afterEach(() => cleanup());

function makeNote(title: string): NoteData {
	return {
		guid: 'g1', title, uri: 'note://tomboy/g1',
		xmlContent: `<note-content version="0.1">${title}</note-content>`,
		createDate: '', changeDate: '', metadataChangeDate: ''
	} as NoteData;
}

describe('NoteActionSheet reflectTitle', () => {
	it('제목이 있으면 "전체 문서에 이 제목 반영" 버튼이 onaction(reflectTitle)을 호출', async () => {
		const onaction = vi.fn();
		const { getByText } = render(NoteActionSheet, {
			props: { note: makeNote('어떤 제목'), dirty: false, onaction, onclose: () => {} }
		});
		await fireEvent.click(getByText('전체 문서에 이 제목 반영'));
		expect(onaction).toHaveBeenCalledWith('reflectTitle');
	});

	it('제목이 비면 반영 버튼을 렌더하지 않는다', () => {
		const { queryByText } = render(NoteActionSheet, {
			props: { note: makeNote('   '), dirty: false, onaction: () => {}, onclose: () => {} }
		});
		expect(queryByText('전체 문서에 이 제목 반영')).toBeNull();
	});
});
