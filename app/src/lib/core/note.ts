export const NOTE_VERSION = '0.3';
export const NOTE_CONTENT_VERSION = '0.1';
export const NOTE_NS = 'http://beatniksoftware.com/tomboy';
export const NOTE_NS_LINK = 'http://beatniksoftware.com/tomboy/link';
export const NOTE_NS_SIZE = 'http://beatniksoftware.com/tomboy/size';

export interface NoteData {
	/** Unique identifier, e.g. "note://tomboy/<guid>" */
	uri: string;
	/** Bare UUID (lowercase, no dashes in Tomboy but we use standard UUID) */
	guid: string;
	/** Note title — derived from the first line of note-content */
	title: string;
	/** Raw <note-content>...</note-content> XML string (canonical format) */
	xmlContent: string;
	/** ISO-8601 date in Tomboy format: yyyy-MM-ddTHH:mm:ss.fffffffzzz */
	createDate: string;
	/** Last content modification time */
	changeDate: string;
	/** Last non-content metadata change time */
	metadataChangeDate: string;
	cursorPosition: number;
	selectionBoundPosition: number;
	width: number;
	height: number;
	x: number;
	y: number;
	/** Tags, e.g. ["system:notebook:Work", "system:pinned"] */
	tags: string[];
	openOnStartup: boolean;

	// --- Local-only fields (not serialized to .note XML) ---

	/** True if modified since last Dropbox sync */
	localDirty: boolean;
	/** Soft-delete tombstone for sync */
	deleted: boolean;
}

/** Create a blank NoteData with sensible defaults */
export function createEmptyNote(guid: string): NoteData {
	const now = formatTomboyDate(new Date());
	const title = 'New Note';
	const xmlContent = `<note-content version="${NOTE_CONTENT_VERSION}">${escapeXml(title)}\n\n</note-content>`;

	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title,
		xmlContent,
		createDate: now,
		changeDate: now,
		metadataChangeDate: now,
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: true,
		deleted: false
	};
}

/**
 * Format a Date to Tomboy's date format: yyyy-MM-ddTHH:mm:ss.fffffffzzz
 * JavaScript only has millisecond precision, so we pad to 7 fractional digits.
 */
export function formatTomboyDate(date: Date): string {
	const pad = (n: number, len = 2) => String(n).padStart(len, '0');

	const yyyy = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const dd = pad(date.getDate());
	const HH = pad(date.getHours());
	const mm = pad(date.getMinutes());
	const ss = pad(date.getSeconds());
	const ms = pad(date.getMilliseconds(), 3);
	const frac = ms + '0000'; // pad to 7 digits

	const tzOffset = -date.getTimezoneOffset();
	const tzSign = tzOffset >= 0 ? '+' : '-';
	const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
	const tzMinutes = pad(Math.abs(tzOffset) % 60);

	return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}.${frac}${tzSign}${tzHours}:${tzMinutes}`;
}

/**
 * Parse a Tomboy date string to a Date object.
 * Handles the 7-digit fractional seconds by truncating to 3 (milliseconds).
 */
export function parseTomboyDate(dateStr: string): Date {
	// Replace 7-digit fraction with 3-digit for JS compatibility
	const normalized = dateStr.replace(
		/\.(\d{3})\d{4}/,
		'.$1'
	);
	return new Date(normalized);
}

/** Escape special XML characters */
export function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
