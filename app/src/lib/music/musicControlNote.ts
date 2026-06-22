import type { JSONContent } from '@tiptap/core';

/** Fixed shared GUID — every device maps to the SAME Firestore doc. Like the
 *  sleepnote index note, this is a hardcoded constant, NOT generated per device. */
export const MUSIC_CONTROL_GUID = '2d9f1a40-7c3e-4b58-9e21-6f0c5a8d3b14';
export const MUSIC_CONTROL_TITLE = '음악제어::공유';
export const MUSIC_CONTROL_TITLE_PREFIX = '음악제어::';
/** Prefix of the single machine-owned paragraph holding compact JSON records. */
export const MUSIC_CONTROL_MARKER = '음악제어데이터::';

export type TransportState = 'playing' | 'paused' | 'stopped';

export interface MusicControlRecord {
	deviceId: string;
	deviceName: string;
	trackUrl: string;
	trackTitle: string;
	/** The music note that holds the track (activeNoteGuid). For future full-queue rebuild. */
	noteGuid: string;
	noteTitle: string;
	position: number;
	state: TransportState;
	/** ISO-8601 — sorts lexically, like Tomboy changeDate. */
	updatedAt: string;
}

export function isMusicControlNoteTitle(title: string): boolean {
	return (title ?? '').trimStart().startsWith(MUSIC_CONTROL_TITLE_PREFIX);
}

function paragraphText(node: JSONContent | undefined): string {
	if (!node?.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

function isRecord(v: unknown): v is MusicControlRecord {
	const e = v as Record<string, unknown>;
	return (
		!!e &&
		typeof e.deviceId === 'string' &&
		typeof e.trackUrl === 'string' &&
		typeof e.position === 'number' &&
		typeof e.state === 'string' &&
		typeof e.updatedAt === 'string'
	);
}

function markerIndex(content: JSONContent[]): number {
	return content.findIndex((n) => paragraphText(n).startsWith(MUSIC_CONTROL_MARKER));
}

export function parseRecordsFromDoc(doc: JSONContent): MusicControlRecord[] {
	const content = doc?.content ?? [];
	const idx = markerIndex(content);
	if (idx === -1) return [];
	const text = paragraphText(content[idx]).slice(MUSIC_CONTROL_MARKER.length).trim();
	if (!text) return [];
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
	} catch {
		return [];
	}
}

export function serializeRecords(records: MusicControlRecord[]): string {
	return MUSIC_CONTROL_MARKER + JSON.stringify(records);
}

/** New doc with `record` upserted by deviceId into the marker paragraph.
 *  Marker absent → appended as the last block. Other blocks untouched. */
export function upsertRecordInDoc(doc: JSONContent, record: MusicControlRecord): JSONContent {
	const content = [...(doc?.content ?? [])];
	const next = parseRecordsFromDoc(doc).filter((r) => r.deviceId !== record.deviceId);
	next.push(record);
	const markerPara: JSONContent = {
		type: 'paragraph',
		content: [{ type: 'text', text: serializeRecords(next) }]
	};
	const idx = markerIndex(content);
	if (idx === -1) content.push(markerPara);
	else content[idx] = markerPara;
	return { ...doc, content };
}

export function pickGlobalLatest(records: MusicControlRecord[]): MusicControlRecord | null {
	let best: MusicControlRecord | null = null;
	for (const r of records) {
		if (!best || r.updatedAt > best.updatedAt) best = r;
	}
	return best;
}
