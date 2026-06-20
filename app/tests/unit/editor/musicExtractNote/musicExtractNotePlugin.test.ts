import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { TomboyMusicExtractNote } from '$lib/editor/musicExtractNote/index.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const SRC = 'https://www.youtube.com/watch?v=v1&list=PLaaa';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;

function mount(html: string) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({
		element: el,
		extensions: [StarterKit, TomboyUrlLink, InlineCheckbox, TomboyMusicExtractNote],
		content: html
	});
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

	it('완료 재생목록에만 🎵 노트 만들기 버튼을 렌더한다', () => {
		const ed = mount(
			`<p>음악추출::x</p><p>${SRC}</p><p>플레이리스트: 가수A 믹스</p>` +
				`<ul><li><p>${U1}</p></li></ul>`
		);
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-makenote')).toHaveLength(1);
		ed.destroy();
	});

	it('미완료 재생목록(결과 없음)에는 노트 만들기 버튼이 없다', () => {
		const ed = mount(`<p>음악추출::x</p><p>${SRC}</p>`);
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-makenote')).toHaveLength(0);
		ed.destroy();
	});

	it('완료 챕터 분할 소스에도 🎵 노트 만들기 버튼을 렌더한다', () => {
		const ed = mount(
			`<p>음악추출::x</p><p>챕터:https://www.youtube.com/watch?v=long1</p>` +
				`<p>플레이리스트: 긴 영상</p><ul><li><p>${U1}</p></li></ul>`
		);
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-makenote')).toHaveLength(1);
		ed.destroy();
	});
});
