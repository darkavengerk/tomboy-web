import type { JSONContent } from '@tiptap/core';

/** Fixed shared GUID — every device maps to the SAME Firestore doc. Like the
 *  sleepnote index note, this is a hardcoded constant, NOT generated per device. */
export const MUSIC_CONTROL_GUID = '2d9f1a40-7c3e-4b58-9e21-6f0c5a8d3b14';
export const MUSIC_CONTROL_TITLE = '음악제어::공유';
export const MUSIC_CONTROL_TITLE_PREFIX = '음악제어::';
/** Prefix of the single machine-owned paragraph holding compact JSON records. */
export const MUSIC_CONTROL_MARKER = '음악제어데이터::';

export type TransportState = 'playing' | 'paused' | 'stopped';

/** A single queue entry as carried cross-device. Mirrors the playable fields of
 *  MusicTrack (engine-only — liPos is editor-local and intentionally omitted). */
export interface MusicControlTrack {
	url: string;
	display: string;
	title?: string | null;
	playlistLabel?: string;
}

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
	/** Full queue snapshot from the SOURCE device (parsed live there). The receiver
	 *  restores this verbatim so ⏭/⏮ work and the urls are the source's freshly
	 *  parsed (playable) ones. Optional for back-compat with v1 single-track records. */
	queue?: MusicControlTrack[];
	/** currentIndex within `queue`. */
	index?: number;
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

const MARKER_LINE_RE = new RegExp(MUSIC_CONTROL_MARKER + '([^\\n]*)');

/** Undo the content-side XML escaping (`escapeXmlContent` does only & < >; the
 *  title path may add &apos;/&quot;). `&amp;` MUST be undone last. */
function xmlUnescape(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

/** Read the records straight from the raw `<note-content>` XML — NOT via
 *  `deserializeContent`. The editor archiver atomizes inline markers
 *  (`[x]` `[ ]` `(o)` `[^N]`) on deserialize and `paragraphText` then drops the
 *  atom glyphs, silently corrupting any url/title that embeds those tokens
 *  (e.g. a bridge filename). The marker JSON is a single compact line, so a raw
 *  regex read is lossless and keeps the JSON readable in 원본 보기. */
export function parseRecordsFromXml(xmlContent: string): MusicControlRecord[] {
	if (!xmlContent) return [];
	const m = MARKER_LINE_RE.exec(xmlContent);
	if (!m) return [];
	let json = m[1];
	// Content `<` is escaped (&lt;), so a *literal* `<` on this line can only be
	// the `</note-content>` close tag — cut there.
	const lt = json.indexOf('<');
	if (lt >= 0) json = json.slice(0, lt);
	json = xmlUnescape(json).trim();
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
	} catch {
		return [];
	}
}

/** Pure upsert by deviceId into a records array (replaces this device's entry). */
export function upsertRecords(
	records: MusicControlRecord[],
	record: MusicControlRecord
): MusicControlRecord[] {
	const next = records.filter((r) => r.deviceId !== record.deviceId);
	next.push(record);
	return next;
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

/** Write `records` into the doc's single marker paragraph (replace if present,
 *  else append as the last block). Other blocks untouched. The marker paragraph
 *  is rebuilt clean from `records`, so any pre-existing atomization of the old
 *  marker block in `doc` is discarded. */
export function setMarkerRecordsInDoc(doc: JSONContent, records: MusicControlRecord[]): JSONContent {
	const content = [...(doc?.content ?? [])];
	const markerPara: JSONContent = {
		type: 'paragraph',
		content: [{ type: 'text', text: serializeRecords(records) }]
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
