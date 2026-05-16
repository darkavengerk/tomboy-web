/**
 * Pure converters between {@link NoteData} (the IDB shape) and the Firestore
 * note document payload.
 *
 * Firestore stores only the canonical content + metadata fields needed for
 * cross-device sync. Per-device window state (x/y/width/height/cursor),
 * `openOnStartup`, and the local-only sync bookkeeping (`localDirty`,
 * `syncedXmlContent`) are deliberately excluded so each device keeps its
 * own UI state.
 *
 * The conflict resolver runs against `changeDate` (Tomboy wall-clock ISO);
 * Firestore's `serverUpdatedAt` is set out-of-band by the writer via
 * `serverTimestamp()` and is not part of this payload type.
 */
import type { NoteData } from '$lib/core/note.js';
import { createEmptyNote } from '$lib/core/note.js';
import { getNotebook } from '$lib/core/notebooks.js';

export interface FirestoreNotePayload {
	guid: string;
	uri: string;
	title: string;
	xmlContent: string;
	createDate: string;
	changeDate: string;
	metadataChangeDate: string;
	tags: string[];
	deleted: boolean;
	public: boolean;
}

/**
 * Conservative byte ceiling for the JSON-serialised payload. Firestore caps
 * documents at ~1 MiB total including field names and indexes; 900 KB leaves
 * headroom for the field-name overhead Firestore adds on the wire.
 */
export const MAX_FIRESTORE_NOTE_BYTES = 900_000;

export class NotePayloadTooLargeError extends Error {
	constructor(public readonly byteLength: number) {
		super(
			`Note payload is ${byteLength} bytes, exceeds limit of ${MAX_FIRESTORE_NOTE_BYTES}`
		);
		this.name = 'NotePayloadTooLargeError';
	}
}

export class InvalidNotePayloadError extends Error {
	constructor(reason: string) {
		super(`Invalid Firestore note payload: ${reason}`);
		this.name = 'InvalidNotePayloadError';
	}
}

export function noteToFirestorePayload(
	note: NoteData,
	sharedNotebooks: string[]
): FirestoreNotePayload {
	const nb = getNotebook(note);
	const payload: FirestoreNotePayload = {
		guid: note.guid,
		uri: note.uri,
		title: note.title,
		xmlContent: note.xmlContent,
		createDate: note.createDate,
		changeDate: note.changeDate,
		metadataChangeDate: note.metadataChangeDate,
		tags: [...note.tags],
		deleted: note.deleted,
		public: nb !== null && sharedNotebooks.includes(nb)
	};
	const size = byteLengthUtf8(JSON.stringify(payload));
	if (size > MAX_FIRESTORE_NOTE_BYTES) {
		throw new NotePayloadTooLargeError(size);
	}
	return payload;
}

export function assertValidPayload(
	input: unknown
): asserts input is FirestoreNotePayload {
	if (input === null || typeof input !== 'object') {
		throw new InvalidNotePayloadError('not an object');
	}
	const obj = input as Record<string, unknown>;
	const stringFields: (keyof FirestoreNotePayload)[] = [
		'guid',
		'uri',
		'title',
		'xmlContent',
		'createDate',
		'changeDate',
		'metadataChangeDate'
	];
	for (const f of stringFields) {
		if (typeof obj[f] !== 'string') {
			throw new InvalidNotePayloadError(`field "${f}" must be a string`);
		}
	}
	if (typeof obj.deleted !== 'boolean') {
		throw new InvalidNotePayloadError('field "deleted" must be a boolean');
	}
	// `public` was added after this app shipped — old Firestore docs lack it.
	// Treat missing as `false` (= not publicly shared) so legacy snapshots
	// validate. Existing values still must be boolean.
	if (obj.public === undefined) {
		obj.public = false;
	} else if (typeof obj.public !== 'boolean') {
		throw new InvalidNotePayloadError('field "public" must be a boolean');
	}
	if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== 'string')) {
		throw new InvalidNotePayloadError('field "tags" must be a string array');
	}
}

/**
 * Merge a remote payload into a local NoteData, producing a row that's ready
 * to persist via {@link putNoteSynced}. Per-device fields (window state,
 * cursor, openOnStartup) are preserved from the existing local row when one
 * is present; missing locally, sensible defaults from {@link createEmptyNote}
 * are used.
 *
 * The result has `localDirty=false` and `syncedXmlContent` aligned with
 * the remote `xmlContent` so the next 3-way merge has a fresh baseline.
 */
export function mergeRemoteIntoLocal(
	local: NoteData | undefined,
	remote: FirestoreNotePayload
): NoteData {
	const base = local ?? createEmptyNote(remote.guid);
	return {
		guid: remote.guid,
		uri: remote.uri,
		title: remote.title,
		xmlContent: remote.xmlContent,
		// Tomboy createDate is immutable from the user's POV — keep the local
		// value if we already had one, otherwise adopt the remote.
		createDate: local?.createDate ?? remote.createDate,
		changeDate: remote.changeDate,
		metadataChangeDate: remote.metadataChangeDate,
		tags: [...remote.tags],
		deleted: remote.deleted,
		// Per-device UI state survives the merge.
		cursorPosition: base.cursorPosition,
		selectionBoundPosition: base.selectionBoundPosition,
		width: base.width,
		height: base.height,
		x: base.x,
		y: base.y,
		openOnStartup: base.openOnStartup,
		// We just synced from remote; clear dirty + freshen baseline.
		localDirty: false,
		syncedXmlContent: remote.xmlContent
	};
}

function byteLengthUtf8(str: string): number {
	if (typeof TextEncoder !== 'undefined') {
		return new TextEncoder().encode(str).length;
	}
	// Fallback (Node, very old browsers): a manual UTF-8 byte counter.
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}
