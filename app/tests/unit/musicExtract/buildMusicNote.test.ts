import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import {
	donePlaylistAnchors,
	readPlaylistResult,
	buildMusicNoteDoc,
	musicNoteTitleFor
} from '$lib/musicExtract/buildMusicNote.js';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const SRC = 'https://www.youtube.com/watch?v=v1&list=PLaaa';
const SRC2 = 'https://www.youtube.com/watch?v=v2&list=PLbbb';
const CHAP_URL = 'https://www.youtube.com/watch?v=long1'; // 챕터:<URL> 의 영상 URL
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

function ext() {
	return [StarterKit, TomboyUrlLink, InlineCheckbox];
}

let ed: Editor | null = null;
afterEach(() => {
	ed?.destroy();
	ed = null;
});

// 음악추출 노트: 미완료 소스 줄, 완료(헤더+트랙) 블록을 HTML 로 구성.
const HEADER = (label: string) => `<p>플레이리스트: ${label}</p>`;
const TRACKS = (...u: string[]) => `<ul>${u.map((x) => `<li><p>${x}</p></li>`).join('')}</ul>`;

describe('donePlaylistAnchors', () => {
	it('완료 재생목록만 anchor 를 반환(미완료 소스는 제외)', () => {
		ed = new Editor({
			extensions: ext(),
			content: `<p>음악추출::x</p><p>${SRC}</p>${HEADER('가수A 믹스')}${TRACKS(U1, U2)}<p>${SRC2}</p>`
		});
		const anchors = donePlaylistAnchors(ed.state.doc);
		expect(anchors.map((a) => a.source)).toEqual([SRC]);
		expect(anchors[0].pos).toBeGreaterThan(0);
	});

	it('결과 헤더가 없으면 anchor 없음', () => {
		ed = new Editor({ extensions: ext(), content: `<p>음악추출::x</p><p>${SRC}</p>` });
		expect(donePlaylistAnchors(ed.state.doc)).toHaveLength(0);
	});

	it('완료 챕터 분할 소스(챕터:<URL>)도 anchor 를 반환', () => {
		ed = new Editor({
			extensions: ext(),
			content: `<p>음악추출::x</p><p>챕터:${CHAP_URL}</p>${HEADER('긴 영상')}${TRACKS(U1, U2)}`
		});
		expect(donePlaylistAnchors(ed.state.doc).map((a) => a.source)).toEqual([CHAP_URL]);
	});

	it('미완료 챕터 소스는 anchor 없음', () => {
		ed = new Editor({ extensions: ext(), content: `<p>음악추출::x</p><p>챕터:${CHAP_URL}</p>` });
		expect(donePlaylistAnchors(ed.state.doc)).toHaveLength(0);
	});
});

describe('readPlaylistResult', () => {
	it('source 의 라벨 + 트랙 URL 을 읽는다', () => {
		ed = new Editor({
			extensions: ext(),
			content: `<p>음악추출::x</p><p>${SRC}</p>${HEADER('가수A 믹스')}${TRACKS(U1, U2)}`
		});
		expect(readPlaylistResult(ed.state.doc, SRC)).toEqual({ label: '가수A 믹스', urls: [U1, U2] });
	});

	it('미완료/없는 source 는 null', () => {
		ed = new Editor({ extensions: ext(), content: `<p>음악추출::x</p><p>${SRC}</p>` });
		expect(readPlaylistResult(ed.state.doc, SRC)).toBeNull();
		expect(readPlaylistResult(ed.state.doc, SRC2)).toBeNull();
	});

	it('챕터 분할 소스의 라벨 + 트랙 URL 을 읽는다', () => {
		ed = new Editor({
			extensions: ext(),
			content: `<p>음악추출::x</p><p>챕터:${CHAP_URL}</p>${HEADER('긴 영상')}${TRACKS(U1, U2)}`
		});
		expect(readPlaylistResult(ed.state.doc, CHAP_URL)).toEqual({ label: '긴 영상', urls: [U1, U2] });
	});
});

describe('buildMusicNoteDoc → 음악:: 노트 round-trip', () => {
	it('제목 prefix 합성', () => {
		expect(musicNoteTitleFor('가수A 믹스')).toBe('음악::가수A 믹스');
	});

	it('저장→재로드 후 parseMusicNote 가 트랙을 큐로 복원', () => {
		const title = musicNoteTitleFor('가수A 믹스');
		const doc = buildMusicNoteDoc(title, '가수A 믹스', [U1, U2]);
		const restored = deserializeContent(serializeContent(doc));
		ed = new Editor({ extensions: ext(), content: restored });
		const music = parseMusicNote(ed.state.doc);
		expect(ed.state.doc.firstChild?.textContent).toBe('음악::가수A 믹스');
		expect(music.playlists[0]?.label).toBe('가수A 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
	});
});
