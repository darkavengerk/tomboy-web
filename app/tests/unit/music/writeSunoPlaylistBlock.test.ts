import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const SUNO = 'https://suno.com/playlist/PL-abc123';
const A1 = 'https://cdn1.suno.ai/c1.mp3';
const A2 = 'https://cdn1.suno.ai/c2.mp3';
const full = (html: string) => new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: html });

describe('writeSunoPlaylistBlock', () => {
	it('SUNO: 줄 아래 패턴A 블록 삽입 → parseMusicNote 가 제목/URL 복원', () => {
		const ed = full(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p>`);
		const wrote = writeSunoPlaylistBlock(ed.view, SUNO, { label: '내 믹스', tracks: [{ url: A1, title: 'Song One' }, { url: A2, title: 'Song Two' }] });
		expect(wrote).toBe(true);
		const music = parseMusicNote(ed.state.doc);
		expect(music.playlists[0].label).toBe('내 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([A1, A2]);
		expect(music.flatQueue.map((t) => t.display)).toEqual(['Song One', 'Song Two']);
		ed.destroy();
	});

	it('이미 헤더 있는 줄 → false', () => {
		const ed = full(`<p>음악::x</p><p>SUNO:${SUNO}</p><p>플레이리스트: 기존</p><ul><li><p>t</p></li></ul>`);
		expect(writeSunoPlaylistBlock(ed.view, SUNO, { label: 'L', tracks: [{ url: A1, title: 'X' }] })).toBe(false);
		ed.destroy();
	});

	it('빈 tracks / 파괴된 view → false', () => {
		const ed = full(`<p>음악::x</p><p>SUNO:${SUNO}</p>`);
		expect(writeSunoPlaylistBlock(ed.view, SUNO, { label: 'L', tracks: [] })).toBe(false);
		const view = ed.view; ed.destroy();
		expect(writeSunoPlaylistBlock(view, SUNO, { label: 'L', tracks: [{ url: A1, title: 'X' }] })).toBe(false);
	});
});
