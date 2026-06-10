import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	tiptapToPdfmake,
	type InternalLinkResolver,
	type PdfBlock
} from '$lib/remarkable/pdf/tiptapToPdfmake.js';

const noResolve: InternalLinkResolver = { resolveInternalTarget: () => null };

function doc(...content: JSONContent[]): JSONContent {
	return { type: 'doc', content };
}
function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('tiptapToPdfmake — image inline', () => {
	it('splits a paragraph around an image url and emits an image block', () => {
		const out = tiptapToPdfmake(doc(p('before https://x.com/cat.png after')), {
			resolver: noResolve,
			imageMap: new Map([['https://x.com/cat.png', 'data:image/png;base64,AAA']])
		});
		expect(out).toHaveLength(3);
		expect((out[0] as PdfBlock).text).toEqual([{ text: 'before ' }]);
		expect((out[1] as PdfBlock).image).toBe('data:image/png;base64,AAA');
		expect((out[2] as PdfBlock).text).toEqual([{ text: ' after' }]);
	});

	it('falls back to URL text when imageMap has no entry', () => {
		const out = tiptapToPdfmake(doc(p('a https://x.com/cat.png b')), {
			resolver: noResolve,
			imageMap: new Map()
		});
		// 단일 paragraph 안에 URL 텍스트 그대로 유지.
		expect(out).toHaveLength(1);
		const block = out[0] as PdfBlock;
		expect(block.image).toBeUndefined();
		expect(JSON.stringify(block.text)).toContain('https://x.com/cat.png');
	});

	it('drops a top-level index listed in dropTopLevelIndexes', () => {
		const out = tiptapToPdfmake(doc(p('keep'), p('drop'), p('keep again')), {
			resolver: noResolve,
			dropTopLevelIndexes: new Set([1])
		});
		expect(out).toHaveLength(2);
		expect((out[0] as PdfBlock).text).toEqual([{ text: 'keep' }]);
		expect((out[1] as PdfBlock).text).toEqual([{ text: 'keep again' }]);
	});

	it('replaces a top-level index with the given block', () => {
		const replacement: PdfBlock = { image: 'data:image/png;base64,ZZ', width: 480 };
		const out = tiptapToPdfmake(doc(p('keep'), p('replace me'), p('keep')), {
			resolver: noResolve,
			replaceTopLevelIndex: new Map([[1, replacement]])
		});
		expect(out).toHaveLength(3);
		expect((out[1] as PdfBlock).image).toBe('data:image/png;base64,ZZ');
	});
});
