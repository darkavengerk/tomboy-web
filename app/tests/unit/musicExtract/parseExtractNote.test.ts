import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { parseExtractNote, pendingItems, isExtractNoteDoc } from '$lib/musicExtract/parseExtractNote.js';

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
		expect(note.items[0].result).toMatchObject({ kind: 'done', title: 'Some Song' });
		expect(note.items[0].result).toHaveProperty('url');
		expect(note.items[1]).toMatchObject({ source: 'Artist - Title' });
		expect(note.items[1].result).toMatchObject({ kind: 'error', message: '실패: 추출 불가' });
		expect(note.items[2].result).toEqual({ kind: 'pending' });
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
