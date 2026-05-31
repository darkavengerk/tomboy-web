import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	FootnoteMarker,
	TomboyFootnoteExtension,
	findFootnoteMatches,
	getDefinitionPreviewText
} from '$lib/editor/footnote/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

type Part = string | { fn: string };
const P = (...parts: Part[]): JSONContent => {
	const content: JSONContent[] = [];
	for (const p of parts) {
		if (typeof p === 'string') {
			if (p.length > 0) content.push({ type: 'text', text: p });
		} else {
			content.push({ type: 'footnoteMarker', attrs: { label: p.fn } });
		}
	}
	return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

function makeDoc(blocks: JSONContent[]): PMNode {
	currentEditor = new Editor({
		extensions: [StarterKit, FootnoteMarker, TomboyFootnoteExtension],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor.state.doc;
}

function defMatchOf(doc: PMNode) {
	const m = findFootnoteMatches(doc).find((x) => x.isDefinitionMarker);
	if (!m) throw new Error('설명 마커를 찾지 못함');
	return m;
}

describe('getDefinitionPreviewText', () => {
	it('설명 단락 본문을 마커 없이 반환한다', () => {
		const doc = makeDoc([
			P('제목'),
			P('본문 ', { fn: '1' }, ' 참조'),
			P({ fn: '1' }, ' 첫 번째 설명 내용')
		]);
		expect(getDefinitionPreviewText(doc, defMatchOf(doc))).toBe('첫 번째 설명 내용');
	});

	it('짧은 설명은 말줄임 없이 그대로', () => {
		const doc = makeDoc([
			P('제목'),
			P('본문 ', { fn: '1' }),
			P({ fn: '1' }, ' 짧음')
		]);
		expect(getDefinitionPreviewText(doc, defMatchOf(doc))).toBe('짧음');
	});

	it('120자 초과 시 … 로 말줄임', () => {
		const long = '가'.repeat(200);
		const doc = makeDoc([
			P('제목'),
			P('본문 ', { fn: '1' }),
			P({ fn: '1' }, ' ' + long)
		]);
		const text = getDefinitionPreviewText(doc, defMatchOf(doc));
		expect(text.length).toBe(121); // 120자 + …
		expect(text.endsWith('…')).toBe(true);
		expect(text.startsWith('가')).toBe(true);
	});

	it('maxLen 인자로 절단 길이를 조정한다', () => {
		const doc = makeDoc([
			P('제목'),
			P('본문 ', { fn: '1' }),
			P({ fn: '1' }, ' 0123456789')
		]);
		expect(getDefinitionPreviewText(doc, defMatchOf(doc), 4)).toBe('0123…');
	});
});
