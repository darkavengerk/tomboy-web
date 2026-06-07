import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { parseMusicNote, deriveName } from '$lib/music/parseMusicNote.js';

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: html });
	return ed;
}

// 헤더 앞 inlineCheckbox atom 을 HTML 로 구성 (data-checked 로 상태 지정).
function cb(checked: boolean): string {
	return `<span class="tomboy-inline-checkbox" data-checked="${checked}"></span>`;
}
afterEach(() => { ed?.destroy(); ed = null; });

describe('parseMusicNote — detection', () => {
	it('detects 음악:: title and name', () => {
		const note = parseMusicNote(makeEditor('<p>음악::주말</p>').state.doc);
		expect(note.isMusic).toBe(true);
		expect(note.name).toBe('주말');
	});
	it('음악:: with empty name still music', () => {
		const emptyNote = parseMusicNote(makeEditor('<p>음악::</p>').state.doc);
		expect(emptyNote.isMusic).toBe(true);
		expect(emptyNote.name).toBe('');
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
	it("pattern B: bridge URL with literal ' is not truncated; display is decoded name", () => {
		// encodeURIComponent leaves ' literal, so bridge mp3 URLs really contain it.
		// The URL must survive whole, and the row must show the decoded filename —
		// not fall through to displaying the raw URL as the title.
		const url =
			"https://h/files/11111111-2222-3333-4444-555555555555/CHUNG%20HA%20'Snapping'%20Official.mp3";
		const note = parseMusicNote(
			makeEditor(`<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>${url}</p></li></ul>`).state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe(url);
		expect(note.flatQueue[0].title).toBeNull();
		expect(note.flatQueue[0].display).toBe("CHUNG HA 'Snapping' Official");
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
		expect(note.flatQueue[0].title).toBe('노래');
		expect(note.flatQueue[0].display).toBe('노래');
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
	it('각 트랙에 소속 플레이리스트 label 이 부착된다', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/1.mp3</p></li></ul><p>플레이리스트: 저녁</p><ul><li><p>https://h/2.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue.map((t) => t.playlistLabel)).toEqual(['아침', '저녁']);
	});
	it('header immediately followed required (intervening paragraph resets)', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: a</p><p>끼어든 문단</p><ul><li><p>https://h/x.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(0);
	});
	it('orderedList: track extracted from ol under 플레이리스트 header', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 테스트</p><ol><li><p>https://h/o.mp3</p></li></ol>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/o.mp3');
	});
	it('trailing punctuation stripped from URL in nested pattern-A item', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 구두점</p><ul><li><p>제목</p><ul><li><p>https://h/a.mp3).</p></li></ul></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/a.mp3');
	});
});

describe('parseMusicNote — 체크박스 토글 게이팅', () => {
	it('checked [x]플레이리스트 → 플레이리스트 모드(트랙 추출)', () => {
		const note = parseMusicNote(
			makeEditor(`<p>음악::x</p><p>${cb(true)}플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>`).state.doc
		);
		expect(note.playlists.map((p) => p.label)).toEqual(['아침']);
		expect(note.flatQueue.map((t) => t.url)).toEqual(['https://h/b.mp3']);
	});
	it('unchecked [ ]플레이리스트 → 텍스트 모드(트랙/플레이리스트 없음)', () => {
		const note = parseMusicNote(
			makeEditor(`<p>음악::x</p><p>${cb(false)}플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>`).state.doc
		);
		expect(note.playlists).toEqual([]);
		expect(note.flatQueue).toEqual([]);
	});
	it('체크박스 없는 레거시 플레이리스트는 그대로 플레이리스트 모드', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue.map((t) => t.url)).toEqual(['https://h/b.mp3']);
	});
	it('체크박스가 헤더 토글을 개별 제어 — 첫째만 체크', () => {
		const note = parseMusicNote(
			makeEditor(
				`<p>음악::x</p><p>${cb(true)}플레이리스트: 켜짐</p><ul><li><p>https://h/1.mp3</p></li></ul>` +
					`<p>${cb(false)}플레이리스트: 꺼짐</p><ul><li><p>https://h/2.mp3</p></li></ul>`
			).state.doc
		);
		expect(note.playlists.map((p) => p.label)).toEqual(['켜짐']);
		expect(note.flatQueue.map((t) => t.url)).toEqual(['https://h/1.mp3']);
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
