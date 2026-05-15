import { describe, it, expect, vi } from 'vitest';
import {
	createNoteSyncClient,
	noteDocPath,
	type FirestorePrimitives,
	type DocSnapshot
} from '$lib/sync/firebase/noteSyncClient.js';
import {
	InvalidNotePayloadError,
	NotePayloadTooLargeError,
	MAX_FIRESTORE_NOTE_BYTES,
	type FirestoreNotePayload
} from '$lib/sync/firebase/notePayload.js';
import type { NoteData } from '$lib/core/note.js';

const SERVER_TS = Symbol('serverTimestamp');

function makePrim(overrides: Partial<FirestorePrimitives> = {}): FirestorePrimitives {
	return {
		getDoc: vi.fn(async () => ({ exists: false } as DocSnapshot)),
		setDoc: vi.fn(async () => undefined),
		onSnapshot: vi.fn(() => () => undefined),
		onNotesAfter: vi.fn(() => () => undefined),
		serverTimestamp: () => SERVER_TS,
		...overrides
	};
}

function validPayload(): FirestoreNotePayload {
	return {
		guid: 'g1',
		uri: 'note://tomboy/g1',
		title: '제목',
		xmlContent: '<note-content version="0.1">제목\n\n</note-content>',
		createDate: '2026-04-27T09:00:00.0000000+09:00',
		changeDate: '2026-04-27T10:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
		tags: ['x'],
		deleted: false,
		public: false
	};
}

function noteFromPayload(p: FirestoreNotePayload): NoteData {
	return {
		...p,
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		openOnStartup: false,
		localDirty: true
	};
}

describe('noteDocPath', () => {
	it('builds users/{uid}/notes/{guid}', () => {
		expect(noteDocPath('dbx-abc', 'g1')).toBe('users/dbx-abc/notes/g1');
	});
});

describe('createNoteSyncClient.getNoteDoc', () => {
	it('returns undefined when the doc does not exist', async () => {
		const prim = makePrim({
			getDoc: vi.fn(async () => ({ exists: false } as DocSnapshot))
		});
		const client = createNoteSyncClient(prim);
		const out = await client.getNoteDoc('dbx-u', 'g1');
		expect(out).toBeUndefined();
		expect(prim.getDoc).toHaveBeenCalledWith('users/dbx-u/notes/g1');
	});

	it('returns the parsed payload when the doc exists', async () => {
		const p = validPayload();
		const prim = makePrim({
			getDoc: vi.fn(async () => ({ exists: true, data: { ...p, serverUpdatedAt: 'whatever' } } as DocSnapshot))
		});
		const client = createNoteSyncClient(prim);
		const out = await client.getNoteDoc('dbx-u', 'g1');
		expect(out).toEqual(p);
	});

	it('throws InvalidNotePayloadError when stored data is malformed', async () => {
		const prim = makePrim({
			getDoc: vi.fn(async () => ({ exists: true, data: { guid: 'g1' } } as DocSnapshot))
		});
		const client = createNoteSyncClient(prim);
		await expect(client.getNoteDoc('dbx-u', 'g1')).rejects.toBeInstanceOf(InvalidNotePayloadError);
	});
});

describe('createNoteSyncClient.setNoteDoc', () => {
	it('writes the canonical payload plus a serverTimestamp field', async () => {
		const prim = makePrim();
		const client = createNoteSyncClient(prim);
		const note = noteFromPayload(validPayload());

		await client.setNoteDoc('dbx-u', note);

		expect(prim.setDoc).toHaveBeenCalledTimes(1);
		const [path, data] = (prim.setDoc as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(path).toBe('users/dbx-u/notes/g1');
		// payload fields present
		expect(data.guid).toBe('g1');
		expect(data.xmlContent).toBe(note.xmlContent);
		// serverUpdatedAt is the sentinel returned by serverTimestamp()
		expect(data.serverUpdatedAt).toBe(SERVER_TS);
		// local-only fields not leaked
		expect(data.localDirty).toBeUndefined();
		expect(data.cursorPosition).toBeUndefined();
	});

	it('propagates NotePayloadTooLargeError without calling setDoc', async () => {
		const prim = makePrim();
		const client = createNoteSyncClient(prim);
		const huge = noteFromPayload({
			...validPayload(),
			xmlContent: 'x'.repeat(MAX_FIRESTORE_NOTE_BYTES + 1)
		});

		await expect(client.setNoteDoc('dbx-u', huge)).rejects.toBeInstanceOf(NotePayloadTooLargeError);
		expect(prim.setDoc).not.toHaveBeenCalled();
	});
});

describe('createNoteSyncClient.subscribeNoteDoc', () => {
	it('forwards undefined for non-existent snapshots and parsed payload for existing ones', () => {
		let snapCb: ((s: DocSnapshot) => void) | undefined;
		const unsub = vi.fn();
		const prim = makePrim({
			onSnapshot: vi.fn((_path, cb) => {
				snapCb = cb;
				return unsub;
			})
		});
		const client = createNoteSyncClient(prim);
		const onChange = vi.fn();

		const unsubReturned = client.subscribeNoteDoc('dbx-u', 'g1', onChange);

		snapCb!({ exists: false });
		expect(onChange).toHaveBeenLastCalledWith(undefined);

		const p = validPayload();
		snapCb!({ exists: true, data: { ...p, serverUpdatedAt: 't' } });
		expect(onChange).toHaveBeenLastCalledWith(p);

		expect(unsubReturned).toBe(unsub);
	});

	it('logs and skips malformed snapshot data without throwing', () => {
		let snapCb: ((s: DocSnapshot) => void) | undefined;
		const prim = makePrim({
			onSnapshot: vi.fn((_p, cb) => {
				snapCb = cb;
				return () => undefined;
			})
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const client = createNoteSyncClient(prim);
		const onChange = vi.fn();

		client.subscribeNoteDoc('dbx-u', 'g1', onChange);
		expect(() => snapCb!({ exists: true, data: { broken: true } })).not.toThrow();
		expect(onChange).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('subscribes against the right doc path', () => {
		const prim = makePrim();
		const client = createNoteSyncClient(prim);
		client.subscribeNoteDoc('dbx-u', 'g1', () => undefined);
		expect(prim.onSnapshot).toHaveBeenCalledWith(
			'users/dbx-u/notes/g1',
			expect.any(Function),
			expect.any(Function)
		);
	});
});

describe('createNoteSyncClient.subscribeNoteCollection', () => {
	it('passes the (uid, sinceMillis) bounds through to the primitive', () => {
		const prim = makePrim();
		const client = createNoteSyncClient(prim);
		client.subscribeNoteCollection('dbx-u', 1234, () => undefined, () => undefined);
		expect(prim.onNotesAfter).toHaveBeenCalledWith(
			'dbx-u',
			1234,
			expect.any(Function),
			expect.any(Function)
		);
	});

	it('forwards parsed payloads + serverUpdatedAtMillis to the caller', () => {
		let primCb:
			| ((docs: Array<{ data: unknown; serverUpdatedAtMillis: number }>) => void)
			| undefined;
		const prim = makePrim({
			onNotesAfter: vi.fn((_uid, _since, onNext) => {
				primCb = onNext;
				return () => undefined;
			})
		});
		const client = createNoteSyncClient(prim);
		const onChange = vi.fn();

		client.subscribeNoteCollection('dbx-u', 0, onChange, () => undefined);

		const p = validPayload();
		primCb!([
			{ data: { ...p, serverUpdatedAt: 't1' }, serverUpdatedAtMillis: 5000 }
		]);

		expect(onChange).toHaveBeenCalledTimes(1);
		const batch = onChange.mock.calls[0][0] as Array<{
			payload: FirestoreNotePayload;
			serverUpdatedAtMillis: number;
		}>;
		expect(batch).toEqual([{ payload: p, serverUpdatedAtMillis: 5000 }]);
	});

	it('drops malformed docs from the batch, keeps valid ones', () => {
		let primCb:
			| ((docs: Array<{ data: unknown; serverUpdatedAtMillis: number }>) => void)
			| undefined;
		const prim = makePrim({
			onNotesAfter: vi.fn((_uid, _since, onNext) => {
				primCb = onNext;
				return () => undefined;
			})
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const client = createNoteSyncClient(prim);
		const onChange = vi.fn();
		const p = validPayload();

		client.subscribeNoteCollection('dbx-u', 0, onChange, () => undefined);

		primCb!([
			{ data: { broken: true }, serverUpdatedAtMillis: 1000 },
			{ data: { ...p, serverUpdatedAt: 't1' }, serverUpdatedAtMillis: 2000 }
		]);

		expect(onChange).toHaveBeenCalledTimes(1);
		const batch = onChange.mock.calls[0][0];
		expect(batch).toHaveLength(1);
		expect(batch[0].payload.guid).toBe(p.guid);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('returns the primitive\'s unsubscribe handle', () => {
		const unsub = vi.fn();
		const prim = makePrim({
			onNotesAfter: vi.fn(() => unsub)
		});
		const client = createNoteSyncClient(prim);
		const ret = client.subscribeNoteCollection('dbx-u', 0, () => undefined, () => undefined);
		expect(ret).toBe(unsub);
	});

	it('forwards subscription errors to onError', () => {
		let primErr: ((e: Error) => void) | undefined;
		const prim = makePrim({
			onNotesAfter: vi.fn((_uid, _since, _onNext, onError) => {
				primErr = onError;
				return () => undefined;
			})
		});
		const client = createNoteSyncClient(prim);
		const onError = vi.fn();
		client.subscribeNoteCollection('dbx-u', 0, () => undefined, onError);
		const err = new Error('snap-failed');
		primErr!(err);
		expect(onError).toHaveBeenCalledWith(err);
	});
});
