import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { parseExtractNote, pendingItems, isExtractNoteDoc } from '$lib/musicExtract/parseExtractNote.js';
import type { PlaylistItem, SingleItem } from '$lib/musicExtract/parseExtractNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';

function docFrom(html: string) {
	const ed = new Editor({ extensions: [StarterKit], content: html });
	const doc = ed.state.doc;
	ed.destroy();
	return doc;
}

const NOTE = `
<p>음악추출::내 라이브러리</p>
<ul>
  <li><p>https://www.youtube.com/watch?v=aaa</p>
    <ul><li><p>https://bridge.example/files/${UUID}/Some%20Song.mp3</p></li></ul>
  </li>
  <li><p>Artist - Title</p><ul><li><p>❌ 실패: 추출 불가</p></li></ul></li>
  <li><p>https://www.youtube.com/watch?v=ccc</p></li>
</ul>`;

describe('parseExtractNote', () => {
	it('비음악추출 노트는 isExtract=false', () => {
		const note = parseExtractNote(docFrom('<p>그냥 노트</p><ul><li><p>x</p></li></ul>'));
		expect(note.isExtract).toBe(false);
		expect(note.items).toEqual([]);
	});

	it('항목을 소스/결과로 분류한다', () => {
		const note = parseExtractNote(docFrom(NOTE));
		expect(note.isExtract).toBe(true);
		expect(note.items).toHaveLength(3);
		expect(note.items[0].source).toBe('https://www.youtube.com/watch?v=aaa');
		expect((note.items[0] as SingleItem).result).toMatchObject({ kind: 'done', title: 'Some Song' });
		expect((note.items[0] as SingleItem).result).toHaveProperty('url');
		expect(note.items[1]).toMatchObject({ source: 'Artist - Title' });
		expect((note.items[1] as SingleItem).result).toMatchObject({ kind: 'error', message: '실패: 추출 불가' });
		expect((note.items[2] as SingleItem).result).toEqual({ kind: 'pending' });
	});

	it('pendingItems는 done 아닌 항목만(신규+실패)', () => {
		const note = parseExtractNote(docFrom(NOTE));
		const pend = pendingItems(note);
		expect(pend.map((p) => p.source)).toEqual(['Artist - Title', 'https://www.youtube.com/watch?v=ccc']);
	});

	it('bare-text 소스 URL의 끝 구두점을 제거한다', () => {
		const note = parseExtractNote(docFrom('<p>음악추출::x</p><ul><li><p>https://youtu.be/abc.</p></li></ul>'));
		expect(note.items[0].source).toBe('https://youtu.be/abc');
	});

	it('isExtractNoteDoc는 JSON 첫 단락만 본다', () => {
		expect(isExtractNoteDoc({ content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악추출::x' }] }] })).toBe(true);
		expect(isExtractNoteDoc({ content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악::x' }] }] })).toBe(false);
		expect(isExtractNoteDoc(null)).toBe(false);
	});
});

describe('parseExtractNote — 재생목록(혼합)', () => {
	const MIXED = `
	<p>음악추출::혼합</p>
	<p>https://www.youtube.com/watch?v=v1&list=PLaaa</p>
	<ul>
	  <li><p>https://www.youtube.com/watch?v=single1</p></li>
	  <li><p>https://www.youtube.com/watch?v=done1</p>
	    <ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li>
	</ul>`;

	it('일반 줄의 list= URL은 playlist 항목', () => {
		const note = parseExtractNote(docFrom(MIXED));
		const pl = note.items.filter((i) => i.kind === 'playlist');
		expect(pl).toHaveLength(1);
		expect(pl[0]).toMatchObject({ kind: 'playlist', source: 'https://www.youtube.com/watch?v=v1&list=PLaaa', done: false });
	});

	it('불릿은 single 항목으로 유지', () => {
		const note = parseExtractNote(docFrom(MIXED));
		const singles = note.items.filter((i) => i.kind === 'single');
		expect(singles.map((s) => s.source)).toEqual([
			'https://www.youtube.com/watch?v=single1',
			'https://www.youtube.com/watch?v=done1'
		]);
	});

	it('직후 플레이리스트: 헤더가 있으면 done', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLbbb</p>` +
			`<p>플레이리스트: 가수A</p><ul><li><p>https://b.ex/files/${UUID}/T.mp3</p></li></ul>`
		));
		const pl = note.items.filter((i) => i.kind === 'playlist');
		expect(pl[0].kind === 'playlist' && (pl[0] as PlaylistItem).done).toBe(true);
		expect(note.items.some((i) => i.source.includes('/files/'))).toBe(false);
	});

	it('pendingItems: done 재생목록·done single 제외', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p>` +
			`<p>https://www.youtube.com/watch?v=a&list=PLc</p><p>플레이리스트: 라벨</p><ul><li><p>https://b.ex/files/${UUID}/A.mp3</p></li></ul>` +
			`<p>https://www.youtube.com/watch?v=b&list=PLd</p>`
		));
		const pend = pendingItems(note);
		expect(pend).toHaveLength(1);
		expect(pend[0].source).toBe('https://www.youtube.com/watch?v=b&list=PLd');
	});

	it('list= 없는 일반 줄/제목은 무시', () => {
		const note = parseExtractNote(docFrom('<p>음악추출::x</p><p>그냥 메모</p><p>https://example.com/page</p>'));
		expect(note.items).toEqual([]);
	});

	it('소스 없는 고아 플레이리스트: 헤더 — 결과 리스트 스킵, 항목 0', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p><p>플레이리스트: 고아</p><ul><li><p>https://b.ex/files/${UUID}/Z.mp3</p></li></ul>`
		));
		expect(note.items).toEqual([]);
	});

	it('연속 재생목록 줄 두 개 — 둘 다 playlist(done=false)', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p>` +
			`<p>https://www.youtube.com/watch?v=a&list=PL1</p>` +
			`<p>https://www.youtube.com/watch?v=b&list=PL2</p>`
		));
		const pl = note.items.filter((i) => i.kind === 'playlist');
		expect(pl).toHaveLength(2);
		expect(pl.every((i) => i.kind === 'playlist' && i.done === false)).toBe(true);
	});
});
