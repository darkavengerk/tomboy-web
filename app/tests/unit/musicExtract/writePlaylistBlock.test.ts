import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writePlaylistBlock } from '$lib/musicExtract/writePlaylistBlock.js';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const SRC = 'https://www.youtube.com/watch?v=v1&list=PLaaa';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

function fullEditor(html: string) {
	return new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: html });
}

describe('writePlaylistBlock', () => {
	it('소스 줄 아래에 [ ]헤더+mp3 불릿을 삽입하고 재생목록을 done 처리', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p>`);
		const wrote = writePlaylistBlock(ed.view, { source: SRC, label: '가수A 믹스', urls: [U1, U2] });
		expect(wrote).toBe(true);
		const note = parseExtractNote(ed.state.doc);
		const pl = note.items.find((i) => i.kind === 'playlist');
		expect(pl && pl.kind === 'playlist' && pl.done).toBe(true);
		ed.destroy();
	});

	it('삽입 블록은 체크 시 parseMusicNote 트랙으로 인식되는 구조', () => {
		const ed = fullEditor(`<p>음악::라이브러리</p><p>${SRC}</p>`);
		writePlaylistBlock(ed.view, { source: SRC, label: '가수A', urls: [U1, U2] });
		let cbPos = -1;
		ed.state.doc.descendants((n, pos) => {
			if (cbPos < 0 && n.type.name === 'inlineCheckbox') cbPos = pos;
		});
		expect(cbPos).toBeGreaterThan(0);
		ed.view.dispatch(ed.state.tr.setNodeAttribute(cbPos, 'checked', true));
		const music = parseMusicNote(ed.state.doc);
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
		expect(music.playlists[0].label).toBe('가수A');
		ed.destroy();
	});

	it('이미 결과 헤더가 있는 소스는 미삽입', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p><p>플레이리스트: 기존</p><ul><li><p>${U1}</p></li></ul>`);
		const wrote = writePlaylistBlock(ed.view, { source: SRC, label: '새로', urls: [U2] });
		expect(wrote).toBe(false);
		ed.destroy();
	});

	it('빈 urls/파괴된 view → false (no-op)', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p>`);
		expect(writePlaylistBlock(ed.view, { source: SRC, label: 'L', urls: [] })).toBe(false);
		const view = ed.view;
		ed.destroy();
		expect(writePlaylistBlock(view, { source: SRC, label: 'L', urls: [U1] })).toBe(false);
	});

	it('inlineCheckbox 미등록 스키마 → [ ] 텍스트 폴백', () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>${SRC}</p>` });
		writePlaylistBlock(ed.view, { source: SRC, label: '폴백', urls: [U1] });
		const text = ed.state.doc.textContent;
		expect(text).toContain('[ ]플레이리스트: 폴백');
		ed.destroy();
	});

	it('챕터 마커 줄(챕터:URL) 아래에도 같은 블록을 삽입하고 done 처리', () => {
		const CHSRC = 'https://www.youtube.com/watch?v=ch1';
		const ed = fullEditor(`<p>음악추출::x</p><p>챕터:${CHSRC}</p>`);
		const wrote = writePlaylistBlock(ed.view, { source: CHSRC, label: '영상 제목', urls: [U1, U2] });
		expect(wrote).toBe(true);
		const note = parseExtractNote(ed.state.doc);
		const ch = note.items.find((i) => i.kind === 'chapter');
		expect(ch && ch.kind === 'chapter' && ch.done).toBe(true);
		// 삽입된 블록은 재생목록과 동형(헤더 체크박스 + mp3 불릿) — 음악:: 호환은 위 재생목록 테스트가 보장.
		expect(ed.state.doc.textContent).toContain('플레이리스트: 영상 제목');
		ed.destroy();
	});

	it('챕터 줄에 이미 결과 헤더가 있으면 미삽입', () => {
		const CHSRC = 'https://www.youtube.com/watch?v=ch1';
		const ed = fullEditor(`<p>음악추출::x</p><p>챕터:${CHSRC}</p><p>플레이리스트: 기존</p><ul><li><p>${U1}</p></li></ul>`);
		expect(writePlaylistBlock(ed.view, { source: CHSRC, label: '새로', urls: [U2] })).toBe(false);
		ed.destroy();
	});
});
