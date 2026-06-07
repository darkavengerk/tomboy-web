import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseRemarkableUploadNote, parseRemarkableUploadTitle } from '$lib/remarkable/parseRemarkableUploadNote.js';

function doc(lines: string[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((text) => ({
			type: 'paragraph',
			content: text === '' ? [] : [{ type: 'text', text }]
		}))
	};
}

describe('parseRemarkableUploadTitle', () => {
	it('detects the signature', () => {
		expect(parseRemarkableUploadTitle('리마커블::오늘 일기')).toBe(true);
	});
	it('returns false for blank label', () => {
		expect(parseRemarkableUploadTitle('리마커블::')).toBe(false);
	});
	it('returns false for other signatures', () => {
		expect(parseRemarkableUploadTitle('자동화::loc-history')).toBe(false);
		expect(parseRemarkableUploadTitle('DATA::tomboy')).toBe(false);
		expect(parseRemarkableUploadTitle('일반 노트')).toBe(false);
	});
});

describe('parseRemarkableUploadNote', () => {
	it('reads the first paragraph as signature, no header', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::오늘 일기', '', '본문']))).toEqual({
			isRemarkableNote: true,
			notebook: undefined
		});
	});
	it('reads 폴더 header from second paragraph', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::오늘 일기', '폴더: Diary', '']))).toEqual({
			isRemarkableNote: true,
			notebook: 'Diary'
		});
	});
	it('trims surrounding whitespace in header value', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::x', '폴더:   Workout  ']))).toEqual({
			isRemarkableNote: true,
			notebook: 'Workout'
		});
	});
	it('폴더: with no space after colon also works', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::x', '폴더:Diary']))).toEqual({
			isRemarkableNote: true,
			notebook: 'Diary'
		});
	});
	it('ignores empty 폴더 value', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::x', '폴더: ']))).toEqual({
			isRemarkableNote: true,
			notebook: undefined
		});
	});
	it('returns null when first paragraph is not signature', () => {
		expect(parseRemarkableUploadNote(doc(['자동화::x']))).toBeNull();
		expect(parseRemarkableUploadNote(doc(['리마커블::']))).toBeNull();
		expect(parseRemarkableUploadNote(doc(['DATA::tomboy', '폴더: x']))).toBeNull();
		expect(parseRemarkableUploadNote(doc(['일반 노트']))).toBeNull();
	});
	it('does not pick up 폴더 from a non-header position (third paragraph and beyond ignored)', () => {
		expect(parseRemarkableUploadNote(doc(['리마커블::x', '본문 내용', '폴더: Diary']))).toEqual({
			isRemarkableNote: true,
			notebook: undefined
		});
	});
	it('handles hardBreak inside header paragraph', () => {
		const d: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '리마커블::오늘 일기' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '폴더:' },
						{ type: 'hardBreak' },
						{ type: 'text', text: ' Diary' }
					]
				}
			]
		};
		expect(parseRemarkableUploadNote(d)).toEqual({
			isRemarkableNote: true,
			notebook: 'Diary'
		});
	});
});
