import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

// writePlaylistBlock 이 만드는 형태를 JSON 으로 직접 구성(checked 가변).
const trackLi = (u: string) => ({
	type: 'listItem',
	content: [{ type: 'paragraph', content: [{ type: 'text', text: u, marks: [{ type: 'tomboyUrlLink', attrs: { href: u } }] }] }]
});
const docOf = (checked: boolean) => ({
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: '음악::라이브러리' }] },
		{ type: 'paragraph', content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text: '플레이리스트: 가수A 믹스' }] },
		{ type: 'bulletList', content: [trackLi(U1), trackLi(U2)] }
	]
});

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });

describe('플레이리스트 블록 .note 라운드트립', () => {
	it('미체크 블록: mp3 href·헤더·체크박스 보존', () => {
		const restored = deserializeContent(serializeContent(docOf(false)));
		const json = JSON.stringify(restored);
		expect(json).toContain(`/files/${UUID}/Song1.mp3`);
		expect(json).toContain(`/files/${UUID}/Song2.mp3`);
		expect(json).toContain('플레이리스트: 가수A 믹스');
		expect(json).toContain('inlineCheckbox');
	});

	it('체크 블록: 라운드트립 후 parseMusicNote 가 트랙 복원', () => {
		const restored = deserializeContent(serializeContent(docOf(true)));
		ed = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: restored });
		const music = parseMusicNote(ed.state.doc);
		expect(music.playlists[0]?.label).toBe('가수A 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
	});
});
