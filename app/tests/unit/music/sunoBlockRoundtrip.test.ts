import { describe, it, expect } from 'vitest';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const SUNO = 'https://suno.com/playlist/PL-abc123';
const A1 = 'https://cdn1.suno.ai/c1.mp3';

describe('Suno 블록 .note 라운드트립', () => {
	it('직렬화→역직렬화 후 audio_url href 와 제목 보존', () => {
		const ed = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: `<p>음악::x</p><p>SUNO:${SUNO}</p>` });
		writeSunoPlaylistBlock(ed.view, SUNO, { label: '내 믹스', tracks: [{ url: A1, title: 'Song One' }] });
		const json = ed.getJSON();
		ed.destroy();

		const restored = deserializeContent(serializeContent(json));
		const ed2 = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: restored });
		const music = parseMusicNote(ed2.state.doc);
		expect(music.flatQueue.map((t) => t.url)).toEqual([A1]);
		expect(music.flatQueue[0].display).toBe('Song One');
		ed2.destroy();
	});
});
