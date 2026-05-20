import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	isQuotedParagraphText,
	findQuotedParagraphs
} from '$lib/editor/blockquote/blockquote.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeDoc(blocks: JSONContent[]): PMNode {
	currentEditor = new Editor({
		extensions: [StarterKit],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor.state.doc;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

describe('isQuotedParagraphText', () => {
	it('is true only for text starting with "> "', () => {
		expect(isQuotedParagraphText('> 인용문')).toBe(true);
		expect(isQuotedParagraphText('>인용문')).toBe(false);
		expect(isQuotedParagraphText('인용 아님')).toBe(false);
		expect(isQuotedParagraphText('  > 앞공백')).toBe(false);
	});
});

describe('findQuotedParagraphs', () => {
	it('finds a quoted body paragraph', () => {
		const doc = makeDoc([P('제목'), P('> 인용된 단락')]);
		const quoted = findQuotedParagraphs(doc);
		expect(quoted).toHaveLength(1);
		expect(quoted[0].textStart).toBe(quoted[0].paraPos + 1);
		expect(
			doc.textBetween(quoted[0].textStart, quoted[0].textStart + 2)
		).toBe('> ');
	});

	it('ignores non-quoted paragraphs', () => {
		const doc = makeDoc([P('제목'), P('보통 단락')]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('excludes the title even if it starts with "> "', () => {
		const doc = makeDoc([P('> 제목'), P('본문')]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('excludes paragraphs inside a list', () => {
		const doc = makeDoc([
			P('제목'),
			{
				type: 'bulletList',
				content: [{ type: 'listItem', content: [P('> 리스트 안')] }]
			}
		]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('finds every paragraph in a run of consecutive quotes', () => {
		const doc = makeDoc([
			P('제목'),
			P('> 첫 줄'),
			P('> 둘째 줄'),
			P('보통'),
			P('> 떨어진 인용')
		]);
		expect(findQuotedParagraphs(doc)).toHaveLength(3);
	});
});
