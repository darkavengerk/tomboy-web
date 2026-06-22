import { describe, it, expect } from 'vitest';
import {
	parseRecordsFromDoc,
	parseRecordsFromXml,
	upsertRecordInDoc,
	upsertRecords,
	setMarkerRecordsInDoc,
	pickGlobalLatest,
	serializeRecords,
	MUSIC_CONTROL_MARKER,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import type { JSONContent } from '@tiptap/core';

const rec = (o: Partial<MusicControlRecord> = {}): MusicControlRecord => ({
	deviceId: 'dev-a',
	deviceName: '노트북',
	trackUrl: 'https://x/song.mp3',
	trackTitle: '곡',
	noteGuid: 'g1',
	noteTitle: '음악::플리',
	position: 12,
	state: 'paused',
	updatedAt: '2026-06-22T00:00:00.000Z',
	...o
});

const docWith = (...blocks: JSONContent[]): JSONContent => ({
	type: 'doc',
	content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] }, ...blocks]
});

describe('musicControlNote', () => {
	it('parses empty when no marker', () => {
		expect(parseRecordsFromDoc(docWith())).toEqual([]);
	});

	it('upserts by deviceId without duplicating and preserves user content', () => {
		const userPara: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '내 메모' }] };
		let doc = docWith(userPara);
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', position: 1 }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-b', position: 2 }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', position: 9 })); // update a
		const recs = parseRecordsFromDoc(doc);
		expect(recs).toHaveLength(2);
		expect(recs.find((r) => r.deviceId === 'dev-a')!.position).toBe(9);
		const texts = (doc.content ?? []).map((n) => n.content?.[0]?.text ?? '');
		expect(texts).toContain('내 메모');
		const markers = (doc.content ?? []).filter((n) =>
			(n.content?.[0]?.text ?? '').startsWith(MUSIC_CONTROL_MARKER)
		);
		expect(markers).toHaveLength(1);
	});

	it('parseRecordsFromDoc returns [] for docs with no content key', () => {
		expect(parseRecordsFromDoc({ type: 'doc' } as any)).toEqual([]);
		expect(parseRecordsFromDoc({} as any)).toEqual([]);
	});

	it('upsertRecordInDoc replaces marker in-place without displacing user paragraphs', () => {
		const markerText = serializeRecords([rec({ deviceId: 'x' })]);
		const markerPara: JSONContent = {
			type: 'paragraph',
			content: [{ type: 'text', text: markerText }]
		};
		const userPara: JSONContent = {
			type: 'paragraph',
			content: [{ type: 'text', text: '사용자 메모' }]
		};
		// doc: [titlePara, markerPara, userPara]  (marker is NOT the last block)
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] },
				markerPara,
				userPara
			]
		};
		const updated = upsertRecordInDoc(doc, rec({ deviceId: 'x', position: 42 }));
		const content = updated.content ?? [];
		// marker paragraph must still be at index 1
		expect((content[1].content?.[0]?.text ?? '').startsWith(MUSIC_CONTROL_MARKER)).toBe(true);
		// user paragraph must still be at index 2
		expect(content[2].content?.[0]?.text).toBe('사용자 메모');
		// exactly one marker paragraph in the whole doc
		const markers = content.filter((n) =>
			(n.content?.[0]?.text ?? '').startsWith(MUSIC_CONTROL_MARKER)
		);
		expect(markers).toHaveLength(1);
	});

	it('picks global latest by ISO updatedAt', () => {
		const latest = pickGlobalLatest([
			rec({ deviceId: 'a', updatedAt: '2026-06-22T00:00:00.000Z' }),
			rec({ deviceId: 'b', updatedAt: '2026-06-22T05:00:00.000Z' })
		]);
		expect(latest!.deviceId).toBe('b');
		expect(pickGlobalLatest([])).toBeNull();
	});
});

describe('musicControlNote — lossless url round-trip (no-sound regression)', () => {
	// A url whose path embeds an inline-marker token. deserializeContent atomizes
	// `[x]`/`( )`/`[^N]` and paragraphText drops the glyphs → corrupted url →
	// MEDIA_ERR_SRC_NOT_SUPPORTED. parseRecordsFromXml must survive it.
	const trickyUrl = "https://bridge.duck/files/abc-123/001 [x] (o) girl & friends.mp3";

	function xmlFromRecords(records: MusicControlRecord[]): string {
		const base: JSONContent = {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] }]
		};
		return serializeContent(setMarkerRecordsInDoc(base, records));
	}

	it('parseRecordsFromXml preserves a url with [x]/(o)/& through the real serialize path', () => {
		const xml = xmlFromRecords([rec({ trackUrl: trickyUrl })]);
		const parsed = parseRecordsFromXml(xml);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].trackUrl).toBe(trickyUrl);
	});

	it('the OLD deserialize-based read corrupts that url (locks the root cause)', () => {
		const xml = xmlFromRecords([rec({ trackUrl: trickyUrl })]);
		const viaDoc = parseRecordsFromDoc(deserializeContent(xml));
		// either the record drops out or the url is mangled — never byte-identical
		const got = viaDoc[0]?.trackUrl;
		expect(got).not.toBe(trickyUrl);
	});

	it('carries the full queue + index across the round-trip', () => {
		const queue = [
			{ url: trickyUrl, display: '001', title: '001', playlistLabel: '로제' },
			{ url: 'https://bridge.duck/files/abc-123/002.mp3', display: '002', title: '002', playlistLabel: '로제' }
		];
		const xml = xmlFromRecords([rec({ queue, index: 1 })]);
		const parsed = parseRecordsFromXml(xml);
		expect(parsed[0].queue).toHaveLength(2);
		expect(parsed[0].queue![0].url).toBe(trickyUrl);
		expect(parsed[0].index).toBe(1);
	});

	it('upsertRecords replaces by deviceId and keeps others', () => {
		const a1 = rec({ deviceId: 'a', position: 1 });
		const b = rec({ deviceId: 'b', position: 2 });
		const a2 = rec({ deviceId: 'a', position: 9 });
		const out = upsertRecords(upsertRecords([a1], b), a2);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.deviceId === 'a')!.position).toBe(9);
	});

	it('parseRecordsFromXml returns [] when no marker / empty content', () => {
		expect(parseRecordsFromXml('<note-content version="0.1">음악제어::공유\n</note-content>')).toEqual([]);
		expect(parseRecordsFromXml('')).toEqual([]);
	});
});
