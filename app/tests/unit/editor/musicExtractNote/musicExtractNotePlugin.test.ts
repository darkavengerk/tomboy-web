import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyMusicExtractNote } from '$lib/editor/musicExtractNote/index.js';

function mount(html: string) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({ element: el, extensions: [StarterKit, TomboyMusicExtractNote], content: html });
}

describe('musicExtractNotePlugin', () => {
	it('음악추출 노트에 ⟳ 진행 버튼을 렌더한다', () => {
		const ed = mount('<p>음악추출::x</p><ul><li><p>https://yt/a</p></li></ul>');
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-run')).toHaveLength(1);
		ed.destroy();
	});
	it('일반 노트에는 버튼이 없다', () => {
		const ed = mount('<p>그냥</p>');
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-run')).toHaveLength(0);
		ed.destroy();
	});
});
