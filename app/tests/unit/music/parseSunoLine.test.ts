import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { parseSunoLines } from '$lib/music/parseSunoLine.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });
const make = (html: string) => (ed = new Editor({ extensions: [StarterKit, InlineCheckbox], content: html }));

const SUNO = 'https://suno.com/playlist/PL-abc123';

describe('parseSunoLines', () => {
	it('미가져온 SUNO: 줄 탐지', () => {
		make(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p>`);
		const lines = parseSunoLines(ed!.state.doc);
		expect(lines.length).toBe(1);
		expect(lines[0].url).toBe(SUNO);
		expect(lines[0].alreadyImported).toBe(false);
	});

	it('다음 블록이 플레이리스트 헤더면 alreadyImported', () => {
		make(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p><p>플레이리스트: 내 믹스</p><ul><li><p>t</p></li></ul>`);
		const lines = parseSunoLines(ed!.state.doc);
		expect(lines[0].alreadyImported).toBe(true);
	});

	it('음악:: 아닌 노트는 빈 배열', () => {
		make(`<p>그냥 노트</p><p>SUNO:${SUNO}</p>`);
		expect(parseSunoLines(ed!.state.doc)).toEqual([]);
	});

	it('대소문자·선행 공백 허용', () => {
		make(`<p>음악::x</p><p>suno:  ${SUNO}</p>`);
		expect(parseSunoLines(ed!.state.doc)[0].url).toBe(SUNO);
	});
});
