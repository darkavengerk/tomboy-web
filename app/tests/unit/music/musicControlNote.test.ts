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
	MUSIC_CONTROL_TITLE,
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
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', updatedAt: '2026-06-22T01:00:00.000Z' }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-b', updatedAt: '2026-06-22T02:00:00.000Z' }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', updatedAt: '2026-06-22T09:00:00.000Z' })); // update a
		const recs = parseRecordsFromDoc(doc);
		expect(recs).toHaveLength(2);
		expect(recs.find((r) => r.deviceId === 'dev-a')!.updatedAt).toBe('2026-06-22T09:00:00.000Z');
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
		const updated = upsertRecordInDoc(doc, rec({ deviceId: 'x', updatedAt: '2026-06-22T04:00:00.000Z' }));
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

	it('carries extra (legacy) fields across the round-trip losslessly', () => {
		// Extra JSON keys not in the current interface pass through serialize→parse unchanged.
		// This is the "legacy tolerance" invariant: old records with queue/index/position
		// are not dropped by isRecord and their extra keys survive in the raw JSON.
		const queue = [
			{ url: trickyUrl, display: '001', title: '001', playlistLabel: '로제' },
			{ url: 'https://bridge.duck/files/abc-123/002.mp3', display: '002', title: '002', playlistLabel: '로제' }
		];
		const legacyRec = { ...rec({ trackUrl: trickyUrl }), queue, index: 1 } as MusicControlRecord;
		const xml = xmlFromRecords([legacyRec]);
		const parsed = parseRecordsFromXml(xml);
		expect(parsed).toHaveLength(1);
		expect((parsed[0] as unknown as Record<string, unknown>).queue).toHaveLength(2); // extra key survived
		expect(((parsed[0] as unknown as Record<string, unknown>).queue as typeof queue)[0].url).toBe(trickyUrl);
		expect((parsed[0] as unknown as Record<string, unknown>).index).toBe(1);
	});

	it('upsertRecords replaces by deviceId and keeps others', () => {
		const a1 = rec({ deviceId: 'a', updatedAt: '2026-06-22T01:00:00.000Z' });
		const b = rec({ deviceId: 'b', updatedAt: '2026-06-22T02:00:00.000Z' });
		const a2 = rec({ deviceId: 'a', updatedAt: '2026-06-22T09:00:00.000Z' });
		const out = upsertRecords(upsertRecords([a1], b), a2);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.deviceId === 'a')!.updatedAt).toBe('2026-06-22T09:00:00.000Z');
	});

	it('parseRecordsFromXml returns [] when no marker / empty content', () => {
		expect(parseRecordsFromXml('<note-content version="0.1">음악제어::공유\n</note-content>')).toEqual([]);
		expect(parseRecordsFromXml('')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Slim MusicControlRecord — Task 1 (Channel A schema slim)
// ---------------------------------------------------------------------------

const slim = (): MusicControlRecord => ({
	deviceId: 'd1',
	deviceName: '아이폰',
	noteGuid: 'g1',
	trackUrl: 'https://x/a.mp3',
	trackTitle: 'A',
	noteTitle: '음악::로제',
	state: 'playing',
	updatedAt: '2026-06-23T10:00:00.000Z'
});

describe('slim MusicControlRecord', () => {
	it('serializes without queue/index/position keys', () => {
		const json = serializeRecords([slim()]);
		expect(json).not.toMatch(/"queue"/);
		expect(json).not.toMatch(/"index"/);
		expect(json).not.toMatch(/"position"/);
	});

	it('parses a slim record from xml (no position field required)', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
				{ type: 'paragraph', content: [{ type: 'text', text: serializeRecords([slim()]) }] }
			]
		};
		const xml = serializeContent(doc);
		const recs = parseRecordsFromXml(xml);
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3');
		expect((recs[0] as unknown as Record<string, unknown>).position).toBeUndefined();
	});

	it('tolerates a legacy record carrying queue/position (extra keys ignored)', () => {
		const legacy = { ...slim(), position: 42, index: 1, queue: [{ url: 'u', display: 'd' }] };
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
				{ type: 'paragraph', content: [{ type: 'text', text: serializeRecords([legacy as MusicControlRecord]) }] }
			]
		};
		const xml = serializeContent(doc);
		const recs = parseRecordsFromXml(xml);
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3'); // core fields survive
	});

	it('rejects a record missing noteGuid (now load-bearing — the queue-rebuild key)', () => {
		const { noteGuid: _drop, ...noGuid } = slim();
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
				{ type: 'paragraph', content: [{ type: 'text', text: serializeRecords([noGuid as MusicControlRecord]) }] }
			]
		};
		expect(parseRecordsFromXml(serializeContent(doc))).toHaveLength(0);
	});
});
