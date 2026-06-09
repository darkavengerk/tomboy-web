import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { TomboySunoImport } from '$lib/editor/sunoNote/index.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });
const make = (html: string) => (ed = new Editor({ extensions: [StarterKit, InlineCheckbox, TomboySunoImport], content: html }));
const btnCount = () => ed!.view.dom.querySelectorAll('.tomboy-suno-import').length;
const SUNO = 'https://suno.com/playlist/PL-abc123';

describe('sunoImportPlugin', () => {
	it('미가져온 SUNO: 줄에 가져오기 버튼 1개', () => {
		make(`<p>음악::x</p><p>SUNO:${SUNO}</p>`);
		expect(btnCount()).toBe(1);
	});
	it('이미 가져온 줄엔 버튼 없음', () => {
		make(`<p>음악::x</p><p>SUNO:${SUNO}</p><p>플레이리스트: m</p><ul><li><p>t</p></li></ul>`);
		expect(btnCount()).toBe(0);
	});
	it('음악:: 아닌 노트엔 버튼 없음', () => {
		make(`<p>딴 노트</p><p>SUNO:${SUNO}</p>`);
		expect(btnCount()).toBe(0);
	});
	it('미가져온 두 줄 → 버튼 두 개', () => {
		make(`<p>음악::x</p><p>SUNO:${SUNO}</p><p>SUNO:${SUNO}2</p>`);
		expect(btnCount()).toBe(2);
	});
});
