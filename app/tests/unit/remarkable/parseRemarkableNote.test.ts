import { describe, it, expect } from 'vitest';
import { parseRemarkableNote } from '$lib/remarkable/parseRemarkableNote.js';
import type { JSONContent } from '@tiptap/core';

function doc(...paras: string[]): JSONContent {
	return {
		type: 'doc',
		content: paras.map((text) => ({
			type: 'paragraph',
			content: text === '' ? undefined : [{ type: 'text', text }]
		}))
	};
}

describe('parseRemarkableNote', () => {
	it('returns null for empty/null/undefined doc', () => {
		expect(parseRemarkableNote(undefined)).toBeNull();
		expect(parseRemarkableNote(null)).toBeNull();
		expect(parseRemarkableNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature is present', () => {
		expect(parseRemarkableNote(doc('hello', 'world'))).toBeNull();
	});

	it('returns null when the signature is on line 1 only (no 2nd line)', () => {
		// 1번째 줄은 항상 제목 — 시그니처가 거기 있어도 인식하지 않는다.
		expect(parseRemarkableNote(doc('remarkable://rm2'))).toBeNull();
	});

	it('returns null when the signature is on line 1 (line 2 is not a signature)', () => {
		// content[0]은 제목으로 무시되고, content[1]('절전 중:')은 시그니처가 아니다.
		expect(parseRemarkableNote(doc('remarkable://rm2', '절전 중:'))).toBeNull();
	});

	it('recognizes the signature on line 2, title on line 1', () => {
		const r = parseRemarkableNote(doc('리마커블 배경', 'remarkable://rm2'));
		expect(r).not.toBeNull();
		expect(r!.host).toBe('rm2');
		expect(r!.slots).toEqual([]);
	});

	it('treats line 1 as a free title — any text is allowed', () => {
		const r = parseRemarkableNote(doc('아무 제목!@# 123 — 자유롭게', 'remarkable://rm2'));
		expect(r!.host).toBe('rm2');
	});

	it('accepts an empty title line', () => {
		const r = parseRemarkableNote(doc('', 'remarkable://rm2'));
		expect(r!.host).toBe('rm2');
	});

	it('returns empty slots when a label has no following URL', () => {
		const r = parseRemarkableNote(doc('제목', 'remarkable://rm2', '절전 중:'));
		expect(r).not.toBeNull();
		expect(r!.slots).toEqual([]);
	});

	it('collects an image URL under a section label', () => {
		const r = parseRemarkableNote(
			doc('제목', 'remarkable://rm2', '절전 중:', 'https://example.com/sleep.png')
		);
		expect(r!.slots).toEqual([{ slot: 'suspended', imageUrl: 'https://example.com/sleep.png' }]);
	});

	it('collects multiple sections', () => {
		const r = parseRemarkableNote(
			doc(
				'제목',
				'remarkable://rm2',
				'절전 중:',
				'https://example.com/sleep.png',
				'부팅 중:',
				'https://example.com/boot.png'
			)
		);
		expect(r!.slots).toEqual([
			{ slot: 'suspended', imageUrl: 'https://example.com/sleep.png' },
			{ slot: 'starting', imageUrl: 'https://example.com/boot.png' }
		]);
	});

	it('ignores unrecognized labels and stray paragraphs', () => {
		const r = parseRemarkableNote(
			doc('제목', 'remarkable://rm2', '메모', '아무 텍스트', '전원 꺼짐:', 'https://x.io/off.png')
		);
		expect(r!.slots).toEqual([{ slot: 'poweroff', imageUrl: 'https://x.io/off.png' }]);
	});

	it('keeps only the first URL / first occurrence per slot', () => {
		const r = parseRemarkableNote(
			doc(
				'제목',
				'remarkable://rm2',
				'절전 중:',
				'https://a.io/1.png',
				'https://a.io/2.png',
				'절전 중:',
				'https://a.io/3.png'
			)
		);
		expect(r!.slots).toEqual([{ slot: 'suspended', imageUrl: 'https://a.io/1.png' }]);
	});

	it('reads a URL carried inside a link mark', () => {
		const d: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'remarkable://rm2' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '부팅 중:' }] },
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'https://dropbox.com/s/x/boot.png?dl=1',
							marks: [{ type: 'link', attrs: { href: 'https://dropbox.com/s/x/boot.png?dl=1' } }]
						}
					]
				}
			]
		};
		const r = parseRemarkableNote(d);
		expect(r!.slots).toEqual([
			{ slot: 'starting', imageUrl: 'https://dropbox.com/s/x/boot.png?dl=1' }
		]);
	});

	it('returns null for a malformed signature on line 2', () => {
		expect(parseRemarkableNote(doc('제목', 'remarkable://'))).toBeNull();
		expect(parseRemarkableNote(doc('제목', 'remarkable:/rm2'))).toBeNull();
	});
});
