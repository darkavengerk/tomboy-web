import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { parseExtractNote, type SingleItem } from '$lib/musicExtract/parseExtractNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
function makeEditor(html: string) {
	return new Editor({ extensions: [StarterKit], content: html });
}

describe('writeExtractResult', () => {
	it('대기 항목에 성공 링크 자식을 추가한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>https://yt/aaa</p></li></ul>');
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/Song.mp3`, title: 'Song' });
		const note = parseExtractNote(ed.state.doc);
		expect((note.items[0] as SingleItem).result).toMatchObject({ kind: 'done', title: 'Song' });
		ed.destroy();
	});

	it('대기 항목에 실패 자식을 추가한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>검색어</p></li></ul>');
		writeExtractResult(ed.view, '검색어', { kind: 'error', message: '추출 불가' });
		const note = parseExtractNote(ed.state.doc);
		expect((note.items[0] as SingleItem).result).toMatchObject({ kind: 'error', message: '실패: 추출 불가' });
		ed.destroy();
	});

	it('기존 실패 자식을 성공으로 교체한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>https://yt/aaa</p><ul><li><p>❌ 실패: 추출 불가</p></li></ul></li></ul>');
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/Song.mp3`, title: 'Song' });
		const note = parseExtractNote(ed.state.doc);
		expect((note.items[0] as SingleItem).result.kind).toBe('done');
		ed.destroy();
	});

	it('이미 done인 항목은 건드리지 않는다', () => {
		const ed = makeEditor(`<p>음악추출::x</p><ul><li><p>https://yt/aaa</p><ul><li><p>https://b.ex/files/${UUID}/Old.mp3</p></li></ul></li></ul>`);
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/New.mp3`, title: 'New' });
		const note = parseExtractNote(ed.state.doc);
		expect(((note.items[0] as SingleItem).result as { title: string }).title).toBe('Old');
		ed.destroy();
	});

	it('파괴된 view면 no-op', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>https://yt/aaa</p></li></ul>');
		const view = ed.view;
		ed.destroy();
		expect(() => writeExtractResult(view, 'https://yt/aaa', { kind: 'error', message: 'x' })).not.toThrow();
	});
});
