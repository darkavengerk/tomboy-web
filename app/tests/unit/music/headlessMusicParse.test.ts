import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import { buildQueueFromXml } from '$lib/music/headlessMusicParse.js';

function xmlOf(content: JSONContent[]): string {
	return serializeContent({ type: 'doc', content });
}
const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const urlPara = (url: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] }]
});
const li = (children: JSONContent[]): JSONContent => ({ type: 'listItem', content: children });
const ul = (items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items });

describe('buildQueueFromXml', () => {
	it('returns [] for a non-music note', () => {
		expect(buildQueueFromXml(xmlOf([p('그냥 노트'), p('내용')]))).toEqual([]);
	});

	it('extracts bare-URL list items under a playlist header', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([li([urlPara('https://x/a.mp3')]), li([urlPara('https://x/b.mp3')])])
		]);
		const q = buildQueueFromXml(xml);
		expect(q.map((t) => t.url)).toEqual(['https://x/a.mp3', 'https://x/b.mp3']);
	});

	it('extracts title + nested-list URL (pattern A)', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([li([p('첫 곡'), ul([li([urlPara('https://x/a.mp3')])])])])
		]);
		const q = buildQueueFromXml(xml);
		expect(q[0].url).toBe('https://x/a.mp3');
		expect(q[0].title).toBe('첫 곡');
	});

	it('excludes a list whose header has a leading UNCHECKED inlineCheckbox', () => {
		const xml = xmlOf([
			p('음악::로제'),
			{
				type: 'paragraph',
				content: [
					{ type: 'inlineCheckbox', attrs: { checked: false } },
					{ type: 'text', text: '플레이리스트:끔' }
				]
			},
			ul([li([urlPara('https://x/off.mp3')])])
		]);
		expect(buildQueueFromXml(xml)).toEqual([]);
	});

	it('includes a list whose header inlineCheckbox is CHECKED', () => {
		const xml = xmlOf([
			p('음악::로제'),
			{
				type: 'paragraph',
				content: [
					{ type: 'inlineCheckbox', attrs: { checked: true } },
					{ type: 'text', text: '플레이리스트:켬' }
				]
			},
			ul([li([urlPara('https://x/on.mp3')])])
		]);
		expect(buildQueueFromXml(xml).map((t) => t.url)).toEqual(['https://x/on.mp3']);
	});

	// Pattern C with text != href is NOT recoverable from stored XML: the archiver
	// serializes <link:url> with TEXT ONLY (href is dropped, rebuilt from textContent
	// on read — see project_tomboyurllink_roundtrip_href). So a head mark-link whose
	// visible text is a title (not the URL) loses its URL on save; the editor's own
	// parseMusicNote can't recover it post-reload either. buildQueueFromXml runs on
	// stored XML, so it correctly yields no track — matching the editor post-reload.
	it('yields no track for a head mark-link whose text != href (href stripped on serialize)', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([
				li([
					{
						type: 'paragraph',
						content: [
							{ type: 'text', text: '내 노래', marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://x/song.mp3' } }] }
						]
					}
				])
			])
		]);
		expect(buildQueueFromXml(xml)).toEqual([]);
	});

	// The pattern that DOES survive + carries a title: pattern A (title in the head
	// text, URL as visible text in a nested list item). text === href there, so the
	// URL round-trips. This is the canonical title+url music-note shape.
	it('preserves title + URL via pattern A (URL as visible text survives round-trip)', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([li([p('내 노래'), ul([li([urlPara('https://x/song.mp3')])])])])
		]);
		const q = buildQueueFromXml(xml);
		expect(q[0].url).toBe('https://x/song.mp3');
		expect(q[0].title).toBe('내 노래');
	});
});
