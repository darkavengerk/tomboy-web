/**
 * Thin Firestore I/O wrapper for note documents.
 *
 * The Firestore primitives are injected so unit tests can exercise the
 * read/write/snapshot paths without touching the real SDK. The production
 * wiring (which constructs the primitives from `firebase/firestore`) lives
 * alongside this module — see `noteSyncClient.firestore.ts`.
 *
 * Doc shape on the wire:
 *   `users/{uid}/notes/{guid}`
 *   { ...FirestoreNotePayload, serverUpdatedAt: <serverTimestamp()> }
 *
 * The `serverUpdatedAt` field is opaque from the conflict-resolver's POV —
 * it exists only as an out-of-band debugging/ordering hint.
 */
import type { NoteData } from '$lib/core/note.js';
import {
	assertValidPayload,
	noteToFirestorePayload,
	type FirestoreNotePayload
} from './notePayload.js';
import type { Unsubscribe } from './openNoteRegistry.js';

export interface DocSnapshot {
	exists: boolean;
	data?: unknown;
}

export interface FirestorePrimitives {
	getDoc(path: string): Promise<DocSnapshot>;
	setDoc(path: string, data: Record<string, unknown>): Promise<void>;
	onSnapshot(
		path: string,
		onNext: (snap: DocSnapshot) => void,
		onError: (err: Error) => void
	): Unsubscribe;
	serverTimestamp(): unknown;
}

export interface NoteSyncClient {
	getNoteDoc(uid: string, guid: string): Promise<FirestoreNotePayload | undefined>;
	setNoteDoc(uid: string, note: NoteData): Promise<void>;
	subscribeNoteDoc(
		uid: string,
		guid: string,
		onChange: (payload: FirestoreNotePayload | undefined) => void
	): Unsubscribe;
}

export function noteDocPath(uid: string, guid: string): string {
	return `users/${uid}/notes/${guid}`;
}

export function createNoteSyncClient(prim: FirestorePrimitives): NoteSyncClient {
	async function getNoteDoc(
		uid: string,
		guid: string
	): Promise<FirestoreNotePayload | undefined> {
		const snap = await prim.getDoc(noteDocPath(uid, guid));
		if (!snap.exists) return undefined;
		const { serverUpdatedAt: _omit, ...rest } = (snap.data as Record<string, unknown>) ?? {};
		assertValidPayload(rest);
		return rest;
	}

	async function setNoteDoc(uid: string, note: NoteData): Promise<void> {
		const payload = noteToFirestorePayload(note);
		await prim.setDoc(noteDocPath(uid, note.guid), {
			...payload,
			serverUpdatedAt: prim.serverTimestamp()
		});
	}

	function subscribeNoteDoc(
		uid: string,
		guid: string,
		onChange: (payload: FirestoreNotePayload | undefined) => void
	): Unsubscribe {
		return prim.onSnapshot(
			noteDocPath(uid, guid),
			(snap) => {
				if (!snap.exists) {
					onChange(undefined);
					return;
				}
				try {
					const { serverUpdatedAt: _omit, ...rest } =
						(snap.data as Record<string, unknown>) ?? {};
					assertValidPayload(rest);
					onChange(rest);
				} catch (err) {
					console.warn(`[noteSyncClient] dropping malformed snapshot for ${guid}`, err);
				}
			},
			(err) => {
				console.warn(`[noteSyncClient] snapshot error for ${guid}`, err);
			}
		);
	}

	return { getNoteDoc, setNoteDoc, subscribeNoteDoc };
}
