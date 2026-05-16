import { describe, it, expect } from 'vitest';
import {
	noteToFirestorePayload,
	assertValidPayload,
	mergeRemoteIntoLocal,
	NotePayloadTooLargeError,
	InvalidNotePayloadError,
	MAX_FIRESTORE_NOTE_BYTES,
	type FirestoreNotePayload
} from '$lib/sync/firebase/notePayload.js';
import type { NoteData } from '$lib/core/note.js';
import { createEmptyNote } from '$lib/core/note.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		guid: '11111111-1111-1111-1111-111111111111',
		uri: 'note://tomboy/11111111-1111-1111-1111-111111111111',
		title: '예제 노트',
		xmlContent:
			'<note-content version="0.1">예제 노트\n\n본문</note-content>',
		createDate: '2026-04-26T10:00:00.0000000+09:00',
		changeDate: '2026-04-27T11:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T11:00:00.0000000+09:00',
		cursorPosition: 12,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 200,
		y: 120,
		tags: ['system:notebook:Work'],
		openOnStartup: false,
		localDirty: true,
		deleted: false,
		syncedXmlContent: '<note-content version="0.1">예제 노트\n\n이전</note-content>',
		...overrides
	};
}

describe('noteToFirestorePayload', () => {
	it('returns the canonical content/metadata fields', () => {
		const note = makeNote();
		const payload = noteToFirestorePayload(note, []);
		expect(payload).toEqual({
			guid: note.guid,
			uri: note.uri,
			title: note.title,
			xmlContent: note.xmlContent,
			createDate: note.createDate,
			changeDate: note.changeDate,
			metadataChangeDate: note.metadataChangeDate,
			tags: note.tags,
			deleted: false,
			public: false
		});
	});

	it('omits local-only and per-device fields', () => {
		const note = makeNote();
		const payload = noteToFirestorePayload(note, []) as unknown as Record<string, unknown>;
		for (const key of [
			'localDirty',
			'syncedXmlContent',
			'cursorPosition',
			'selectionBoundPosition',
			'width',
			'height',
			'x',
			'y',
			'openOnStartup'
		]) {
			expect(payload, `should omit ${key}`).not.toHaveProperty(key);
		}
	});

	it('returns a fresh tags array (no aliasing)', () => {
		const note = makeNote({ tags: ['a', 'b'] });
		const payload = noteToFirestorePayload(note, []);
		expect(payload.tags).toEqual(['a', 'b']);
		expect(payload.tags).not.toBe(note.tags);
	});

	it('preserves deleted=true tombstones', () => {
		const payload = noteToFirestorePayload(makeNote({ deleted: true }), []);
		expect(payload.deleted).toBe(true);
	});

	it('throws NotePayloadTooLargeError when serialised payload exceeds the limit', () => {
		const huge = 'x'.repeat(MAX_FIRESTORE_NOTE_BYTES + 1);
		const note = makeNote({ xmlContent: huge });
		expect(() => noteToFirestorePayload(note, [])).toThrow(NotePayloadTooLargeError);
	});
});

describe('assertValidPayload', () => {
	const valid: FirestoreNotePayload = {
		guid: '22222222-2222-2222-2222-222222222222',
		uri: 'note://tomboy/22222222-2222-2222-2222-222222222222',
		title: '제목',
		xmlContent: '<note-content version="0.1">제목\n\n</note-content>',
		createDate: '2026-04-27T09:00:00.0000000+09:00',
		changeDate: '2026-04-27T09:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T09:00:00.0000000+09:00',
		tags: [],
		deleted: false,
		public: false
	};

	it('accepts a complete object', () => {
		expect(() => assertValidPayload({ ...valid })).not.toThrow();
	});

	it('rejects null/undefined/non-objects', () => {
		expect(() => assertValidPayload(null)).toThrow(InvalidNotePayloadError);
		expect(() => assertValidPayload(undefined)).toThrow(InvalidNotePayloadError);
		expect(() => assertValidPayload('hi')).toThrow(InvalidNotePayloadError);
	});

	it('rejects when a required string field is missing', () => {
		const { changeDate: _omit, ...without } = valid;
		expect(() => assertValidPayload(without)).toThrow(InvalidNotePayloadError);
	});

	it('rejects when a required string field has the wrong type', () => {
		expect(() =>
			assertValidPayload({ ...valid, changeDate: 12345 })
		).toThrow(InvalidNotePayloadError);
	});

	it('rejects when tags contains a non-string', () => {
		expect(() =>
			assertValidPayload({ ...valid, tags: ['ok', 7] })
		).toThrow(InvalidNotePayloadError);
	});

	it('rejects when deleted is not a boolean', () => {
		expect(() =>
			assertValidPayload({ ...valid, deleted: 'true' })
		).toThrow(InvalidNotePayloadError);
	});

	it('rejects when public is not a boolean', () => {
		expect(() =>
			assertValidPayload({ ...valid, public: 'true' })
		).toThrow(InvalidNotePayloadError);
	});

	it('coerces missing public to false (legacy docs)', () => {
		const { public: _omit, ...legacy } = valid;
		const obj = { ...legacy } as Record<string, unknown>;
		expect(() => assertValidPayload(obj)).not.toThrow();
		expect(obj.public).toBe(false);
	});
});

describe('mergeRemoteIntoLocal', () => {
	const remote: FirestoreNotePayload = {
		guid: '33333333-3333-3333-3333-333333333333',
		uri: 'note://tomboy/33333333-3333-3333-3333-333333333333',
		title: '원격 제목',
		xmlContent: '<note-content version="0.1">원격 제목\n\n원격 본문</note-content>',
		createDate: '2026-04-20T10:00:00.0000000+09:00',
		changeDate: '2026-04-27T15:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T15:00:00.0000000+09:00',
		tags: ['system:notebook:Inbox'],
		deleted: false,
		public: false
	};

	it('with no local note produces a full NoteData ready to persist as synced', () => {
		const merged = mergeRemoteIntoLocal(undefined, remote);
		expect(merged.guid).toBe(remote.guid);
		expect(merged.uri).toBe(remote.uri);
		expect(merged.title).toBe(remote.title);
		expect(merged.xmlContent).toBe(remote.xmlContent);
		expect(merged.changeDate).toBe(remote.changeDate);
		expect(merged.metadataChangeDate).toBe(remote.metadataChangeDate);
		expect(merged.tags).toEqual(remote.tags);
		expect(merged.deleted).toBe(false);
		expect(merged.localDirty).toBe(false);
		expect(merged.syncedXmlContent).toBe(remote.xmlContent);
		// sensible window defaults
		expect(typeof merged.width).toBe('number');
		expect(typeof merged.height).toBe('number');
	});

	it('with a local note preserves per-device window/cursor state', () => {
		const local = makeNote({
			guid: remote.guid,
			uri: remote.uri,
			x: 555,
			y: 333,
			width: 700,
			height: 500,
			cursorPosition: 42,
			selectionBoundPosition: 50,
			openOnStartup: true
		});
		const merged = mergeRemoteIntoLocal(local, remote);
		expect(merged.x).toBe(555);
		expect(merged.y).toBe(333);
		expect(merged.width).toBe(700);
		expect(merged.height).toBe(500);
		expect(merged.cursorPosition).toBe(42);
		expect(merged.selectionBoundPosition).toBe(50);
		expect(merged.openOnStartup).toBe(true);
		// content fields come from remote
		expect(merged.title).toBe(remote.title);
		expect(merged.xmlContent).toBe(remote.xmlContent);
		expect(merged.changeDate).toBe(remote.changeDate);
		expect(merged.localDirty).toBe(false);
		expect(merged.syncedXmlContent).toBe(remote.xmlContent);
	});

	it('preserves the local createDate when one already exists', () => {
		const local = makeNote({
			guid: remote.guid,
			createDate: '2025-01-01T00:00:00.0000000+09:00'
		});
		const merged = mergeRemoteIntoLocal(local, remote);
		expect(merged.createDate).toBe('2025-01-01T00:00:00.0000000+09:00');
	});

	it('applies a remote tombstone to the local note', () => {
		const local = makeNote({ guid: remote.guid });
		const merged = mergeRemoteIntoLocal(local, { ...remote, deleted: true });
		expect(merged.deleted).toBe(true);
		expect(merged.localDirty).toBe(false);
	});

	it('produces an isolated tags array (mutating the result does not change the payload)', () => {
		const merged = mergeRemoteIntoLocal(undefined, remote);
		merged.tags.push('mutation');
		expect(remote.tags).toEqual(['system:notebook:Inbox']);
	});
});

describe('noteToFirestorePayload public flag', () => {
	function noteIn(nb: string | null) {
		const n = createEmptyNote('g1');
		if (nb) n.tags.push(`system:notebook:${nb}`);
		return n;
	}

	it('marks public when notebook is in shared list', () => {
		const p = noteToFirestorePayload(noteIn('공유A'), ['공유A', '공유B']);
		expect(p.public).toBe(true);
	});

	it('marks not-public when notebook is outside shared list', () => {
		const p = noteToFirestorePayload(noteIn('비공유'), ['공유A']);
		expect(p.public).toBe(false);
	});

	it('marks not-public when note has no notebook', () => {
		const p = noteToFirestorePayload(noteIn(null), ['공유A']);
		expect(p.public).toBe(false);
	});
});
