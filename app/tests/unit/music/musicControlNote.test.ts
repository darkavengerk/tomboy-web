import { describe, it, expect } from 'vitest';
import {
	parseRecordsFromDoc,
	upsertRecordInDoc,
	pickGlobalLatest,
	MUSIC_CONTROL_MARKER,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
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

	it('picks global latest by ISO updatedAt', () => {
		const latest = pickGlobalLatest([
			rec({ deviceId: 'a', updatedAt: '2026-06-22T00:00:00.000Z' }),
			rec({ deviceId: 'b', updatedAt: '2026-06-22T05:00:00.000Z' })
		]);
		expect(latest!.deviceId).toBe('b');
		expect(pickGlobalLatest([])).toBeNull();
	});
});
