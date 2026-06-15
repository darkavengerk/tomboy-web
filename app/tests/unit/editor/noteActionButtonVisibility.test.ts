import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { createTitleIsolationPlugin } from '$lib/editor/titleIsolation/titleIsolationPlugin.js';
import { createAutomationNotePlugin } from '$lib/editor/automationNote/automationNotePlugin.js';
import { createMusicExtractNotePlugin } from '$lib/editor/musicExtractNote/musicExtractNotePlugin.js';
import { createRemarkableNotePlugin } from '$lib/editor/remarkableNote/remarkableNotePlugin.js';

// Mirrors how TomboyEditor hides the title line (hideTitleLine=true everywhere):
// the first top-level node gets `.tomboy-title-hidden { display:none }`.
const TitleIsolation = Extension.create({
	name: 'testTitleIsolation',
	addProseMirrorPlugins() {
		return [createTitleIsolationPlugin(() => true)];
	}
});

function wrap(name: string, factory: () => Plugin) {
	return Extension.create({
		name,
		addProseMirrorPlugins() {
			return [factory()];
		}
	});
}

let editor: Editor | null = null;
function mount(extension: Extension, html: string) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	editor = new Editor({
		element: el,
		extensions: [StarterKit, TitleIsolation, extension],
		content: html
	});
	return editor;
}

afterEach(() => {
	editor?.destroy();
	editor = null;
});

describe('note-action buttons survive the hidden title line', () => {
	it('자동화 노트의 ⟳ 실행 버튼이 숨은 타이틀 밖에 렌더된다', () => {
		const ed = mount(
			wrap('testAutomation', createAutomationNotePlugin),
			'<p>자동화::loc-history</p><ul><li><p>log</p></li></ul>'
		);
		const btn = ed.view.dom.querySelector('button.tomboy-automation-run');
		expect(btn).not.toBeNull();
		// The bug: the widget was a child of the display:none title node.
		expect(btn!.closest('.tomboy-title-hidden')).toBeNull();
	});

	it('음악추출 노트의 ⟳ 진행 버튼이 숨은 타이틀 밖에 렌더된다', () => {
		const ed = mount(
			wrap('testMusicExtract', createMusicExtractNotePlugin),
			'<p>음악추출::x</p><ul><li><p>https://yt/a</p></li></ul>'
		);
		const btn = ed.view.dom.querySelector('button.tomboy-music-extract-run');
		expect(btn).not.toBeNull();
		expect(btn!.closest('.tomboy-title-hidden')).toBeNull();
	});

	it('리마커블 노트의 📥 업로드 버튼이 숨은 타이틀 밖에 렌더된다', () => {
		const ed = mount(
			wrap('testRemarkable', createRemarkableNotePlugin),
			'<p>리마커블::내 노트</p><p>본문</p>'
		);
		const btn = ed.view.dom.querySelector('button.tomboy-remarkable-upload');
		expect(btn).not.toBeNull();
		expect(btn!.closest('.tomboy-title-hidden')).toBeNull();
	});
});
