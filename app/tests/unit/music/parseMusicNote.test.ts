import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { parseMusicNote, deriveName } from '$lib/music/parseMusicNote.js';

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}
afterEach(() => { ed?.destroy(); ed = null; });

describe('parseMusicNote — detection', () => {
	it('detects 음악:: title and name', () => {
		const note = parseMusicNote(makeEditor('<p>음악::주말</p>').state.doc);
		expect(note.isMusic).toBe(true);
		expect(note.name).toBe('주말');
	});
	it('음악:: with empty name still music', () => {
		expect(parseMusicNote(makeEditor('<p>음악::</p>').state.doc).isMusic).toBe(true);
		expect(parseMusicNote(makeEditor('<p>음악::</p>').state.doc).name).toBe('');
	});
	it('non-music title', () => {
		const note = parseMusicNote(makeEditor('<p>그냥 노트</p>').state.doc);
		expect(note.isMusic).toBe(false);
		expect(note.flatQueue).toEqual([]);
	});
});

describe('parseMusicNote — track extraction', () => {
	it('pattern B: depth-1 URL item', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/b.mp3');
		expect(note.flatQueue[0].title).toBeNull();
		expect(note.flatQueue[0].display).toBe('b');
		expect(note.flatQueue[0].liPos).toBeGreaterThan(0);
	});
	it('pattern A: depth-1 title + depth-2 URL', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>Song A</p><ul><li><p>https://h/a.mp3</p></li></ul></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].title).toBe('Song A');
		expect(note.flatQueue[0].url).toBe('https://h/a.mp3');
		expect(note.flatQueue[0].display).toBe('Song A');
	});
	it('recognizes tomboyUrlLink mark href', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트:</p><ul><li><p><a class="tomboy-link-url" href="https://h/c.mp3">노래</a></p></li></ul>').state.doc
		);
		expect(note.flatQueue[0].url).toBe('https://h/c.mp3');
	});
	it('skips non-URL items, ignores lists without a 플레이리스트 header', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><ul><li><p>일반 메모</p></li></ul><p>플레이리스트: a</p><ul><li><p>설명만</p></li><li><p>https://h/d.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/d.mp3');
	});
	it('flattens multiple playlists in document order', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/1.mp3</p></li></ul><p>플레이리스트: 저녁</p><ul><li><p>https://h/2.mp3</p></li></ul>').state.doc
		);
		expect(note.playlists.map((p) => p.label)).toEqual(['아침', '저녁']);
		expect(note.flatQueue.map((t) => t.url)).toEqual(['https://h/1.mp3', 'https://h/2.mp3']);
	});
	it('header immediately followed required (intervening paragraph resets)', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: a</p><p>끼어든 문단</p><ul><li><p>https://h/x.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(0);
	});
});

describe('deriveName', () => {
	it('decodes filename and strips extension', () => {
		expect(deriveName('https://h/path/My%20Song.mp3')).toBe('My Song');
	});
	it('falls back to raw url when unparseable', () => {
		expect(deriveName('not a url')).toBe('not a url');
	});
});
