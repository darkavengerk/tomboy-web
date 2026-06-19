import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { createMusicNoteFromPlaylist } from '$lib/editor/musicExtractNote/createMusicNoteFromPlaylist.js';
import { findNoteByTitle, getNoteEditorContent } from '$lib/core/noteManager.js';
import { _resetForTest } from '$lib/stores/noteListCache.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const SRC = 'https://www.youtube.com/watch?v=v1&list=PLaaa';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

const TITLE = '음악::가수A 믹스';
const EXTRACT_HTML =
	`<p>음악추출::x</p><p>${SRC}</p><p>플레이리스트: 가수A 믹스</p>` +
	`<ul><li><p>${U1}</p></li><li><p>${U2}</p></li></ul>`;

function extractEditor() {
	return new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: EXTRACT_HTML });
}

// getNoteEditorContent → 음악 노트를 다시 에디터로 파싱.
async function parseSavedMusicNote() {
	const note = await findNoteByTitle(TITLE);
	expect(note).toBeTruthy();
	const ed = new Editor({
		extensions: [StarterKit, TomboyUrlLink, InlineCheckbox],
		content: getNoteEditorContent(note!)
	});
	const music = parseMusicNote(ed.state.doc);
	ed.destroy();
	return music;
}

let ed: Editor | null = null;
afterEach(() => {
	ed?.destroy();
	ed = null;
});

describe('createMusicNoteFromPlaylist', () => {
	beforeEach(() => {
		indexedDB = new IDBFactory();
		_resetDBForTest(); // noteStore 가 캐시한 DB 연결을 끊어 새 IDBFactory 를 실제로 쓰게.
		_resetForTest(); // 모듈 전역 노트 캐시 — IDB 리셋과 함께 비워 stale read-through 차단.
	});

	it('완료 재생목록으로 음악:: 노트를 만들고 트랙을 채운다', async () => {
		ed = extractEditor();
		const nav = vi.fn();
		await createMusicNoteFromPlaylist(ed.view, SRC, nav);

		const music = await parseSavedMusicNote();
		expect(music.playlists[0]?.label).toBe('가수A 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
		expect(nav).toHaveBeenCalledWith(TITLE);
	});

	it('같은 라벨 재호출 시 중복 생성 없이 기존 노트를 연다', async () => {
		ed = extractEditor();
		await createMusicNoteFromPlaylist(ed.view, SRC);
		const nav = vi.fn();
		await createMusicNoteFromPlaylist(ed.view, SRC, nav);
		// '음악::가수A 믹스 (2)' 가 생기면 안 됨.
		expect(await findNoteByTitle('음악::가수A 믹스 (2)')).toBeFalsy();
		expect(nav).toHaveBeenCalledWith(TITLE);
	});

	it('미완료 source 는 노트를 만들지 않는다', async () => {
		ed = new Editor({
			extensions: [StarterKit, TomboyUrlLink, InlineCheckbox],
			content: `<p>음악추출::x</p><p>${SRC}</p>`
		});
		const nav = vi.fn();
		await createMusicNoteFromPlaylist(ed.view, SRC, nav);
		expect(await findNoteByTitle(TITLE)).toBeFalsy();
		expect(nav).not.toHaveBeenCalled();
	});
});
