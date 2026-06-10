import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';
import {
	deleteTrackRange,
	moveTrackSwap,
	canMoveTrack,
	buildTrackCopyHtml,
	trackCopyPlain
} from '$lib/editor/musicNote/trackTools.js';

let ed: Editor | null = null;
function editor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}
afterEach(() => {
	ed?.destroy();
	ed = null;
});

const THREE =
	'<p>음악::x</p><p>플레이리스트: a</p>' +
	'<ul><li><p>https://h/1.mp3</p></li><li><p>https://h/2.mp3</p></li><li><p>https://h/3.mp3</p></li></ul>';
const ONE = '<p>음악::x</p><p>플레이리스트: a</p><ul><li><p>https://h/only.mp3</p></li></ul>';
const NESTED =
	'<p>음악::x</p><p>플레이리스트: a</p>' +
	'<ul><li><p>좋은 날</p><ul><li><p>https://h/g.mp3</p></li></ul></li>' +
	'<li><p>https://h/2.mp3</p></li></ul>';

function urls(e: Editor): string[] {
	return parseMusicNote(e.state.doc).flatQueue.map((t) => t.url);
}

describe('deleteTrackRange', () => {
	it('가운데 곡 삭제 → 그 곡만 사라지고 나머지 순서 유지', () => {
		const e = editor(THREE);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		const r = deleteTrackRange(e.state.doc, tracks[1].liPos);
		expect(r).not.toBeNull();
		e.view.dispatch(e.state.tr.delete(r!.from, r!.to));
		expect(urls(e)).toEqual(['https://h/1.mp3', 'https://h/3.mp3']);
	});

	it('마지막 남은 곡 삭제 → 리스트째 제거(빈-리스트 스키마 위반 없음), 헤더는 남음', () => {
		const e = editor(ONE);
		const track = parseMusicNote(e.state.doc).flatQueue[0];
		const r = deleteTrackRange(e.state.doc, track.liPos);
		expect(r).not.toBeNull();
		// 적용이 throw 없이 성공하고 곡이 0개가 되어야 한다.
		expect(() => e.view.dispatch(e.state.tr.delete(r!.from, r!.to))).not.toThrow();
		expect(parseMusicNote(e.state.doc).flatQueue.length).toBe(0);
		// 헤더 단락은 남아 있다.
		expect(e.state.doc.textContent).toContain('플레이리스트: a');
	});

	it('중첩(제목+URL) 곡 삭제 → 제목·URL 둘 다 제거', () => {
		const e = editor(NESTED);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		const r = deleteTrackRange(e.state.doc, tracks[0].liPos);
		e.view.dispatch(e.state.tr.delete(r!.from, r!.to));
		expect(urls(e)).toEqual(['https://h/2.mp3']);
		expect(e.state.doc.textContent).not.toContain('좋은 날');
	});

	it('listItem 시작이 아닌 pos → null', () => {
		const e = editor(THREE);
		expect(deleteTrackRange(e.state.doc, 0)).toBeNull();
	});
});

describe('moveTrackSwap', () => {
	it('가운데 곡 위로 → 앞 곡과 자리 교환', () => {
		const e = editor(THREE);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		const r = moveTrackSwap(e.state.doc, tracks[1].liPos, 'up');
		expect(r).not.toBeNull();
		e.view.dispatch(e.state.tr.replaceWith(r!.from, r!.to, r!.nodes));
		expect(urls(e)).toEqual(['https://h/2.mp3', 'https://h/1.mp3', 'https://h/3.mp3']);
	});

	it('가운데 곡 아래로 → 뒤 곡과 자리 교환', () => {
		const e = editor(THREE);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		const r = moveTrackSwap(e.state.doc, tracks[1].liPos, 'down');
		e.view.dispatch(e.state.tr.replaceWith(r!.from, r!.to, r!.nodes));
		expect(urls(e)).toEqual(['https://h/1.mp3', 'https://h/3.mp3', 'https://h/2.mp3']);
	});

	it('첫 곡 up / 끝 곡 down → null (경계)', () => {
		const e = editor(THREE);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		expect(moveTrackSwap(e.state.doc, tracks[0].liPos, 'up')).toBeNull();
		expect(moveTrackSwap(e.state.doc, tracks[2].liPos, 'down')).toBeNull();
	});

	it('중첩(제목+URL) 곡 이동 → 제목+URL 구조 보존하며 교환', () => {
		const e = editor(NESTED);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		const r = moveTrackSwap(e.state.doc, tracks[0].liPos, 'down');
		e.view.dispatch(e.state.tr.replaceWith(r!.from, r!.to, r!.nodes));
		const after = parseMusicNote(e.state.doc).flatQueue;
		expect(after.map((t) => t.url)).toEqual(['https://h/2.mp3', 'https://h/g.mp3']);
		// 교환 후에도 제목이 살아 있어야 한다.
		expect(after.find((t) => t.url === 'https://h/g.mp3')?.display).toBe('좋은 날');
	});

	it('canMoveTrack — 경계 판정', () => {
		const e = editor(THREE);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		expect(canMoveTrack(e.state.doc, tracks[0].liPos, 'up')).toBe(false);
		expect(canMoveTrack(e.state.doc, tracks[0].liPos, 'down')).toBe(true);
		expect(canMoveTrack(e.state.doc, tracks[2].liPos, 'down')).toBe(false);
	});
});

describe('buildTrackCopyHtml / trackCopyPlain', () => {
	it('제목 있는 곡 → 패턴 A(제목 + 중첩 URL, text===href)', () => {
		const html = buildTrackCopyHtml({ url: 'https://h/g.mp3', title: '좋은 날', display: '좋은 날', liPos: 0 });
		expect(html).toBe(
			'<ul><li><p>좋은 날</p><ul><li><p><a href="https://h/g.mp3">https://h/g.mp3</a></p></li></ul></li></ul>'
		);
	});

	it('제목 없는 bare URL 곡 → URL 한 줄짜리 li', () => {
		const html = buildTrackCopyHtml({ url: 'https://h/1.mp3', title: null, display: '1', liPos: 0 });
		expect(html).toBe('<ul><li><p><a href="https://h/1.mp3">https://h/1.mp3</a></p></li></ul>');
	});

	it('제목/URL 특수문자 이스케이프', () => {
		const html = buildTrackCopyHtml({
			url: 'https://h/a.mp3?x=1&y=2',
			title: '<b>"A&B"</b>',
			display: 'x',
			liPos: 0
		});
		expect(html).toContain('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
		expect(html).toContain('href="https://h/a.mp3?x=1&amp;y=2"');
	});

	it('붙여넣기 라운드트립 — 만든 HTML 이 다른 음악 노트에서 같은 곡으로 파싱됨', () => {
		const html = buildTrackCopyHtml({ url: 'https://h/g.mp3', title: '좋은 날', display: '좋은 날', liPos: 0 });
		const e = editor(`<p>음악::dst</p><p>플레이리스트: b</p>${html}`);
		const tracks = parseMusicNote(e.state.doc).flatQueue;
		expect(tracks.length).toBe(1);
		expect(tracks[0].url).toBe('https://h/g.mp3');
		expect(tracks[0].display).toBe('좋은 날');
	});

	it('trackCopyPlain → 재생 URL', () => {
		expect(trackCopyPlain({ url: 'https://h/1.mp3', title: null, display: '1', liPos: 0 })).toBe(
			'https://h/1.mp3'
		);
	});
});
