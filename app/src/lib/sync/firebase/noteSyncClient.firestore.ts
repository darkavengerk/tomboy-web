/**
 * Production wiring for {@link createNoteSyncClient} against the real
 * `firebase/firestore` SDK. Lives in its own module so the heavy SDK import
 * stays out of unit tests — they construct the client with fake primitives.
 */
import {
	collection,
	doc,
	getDoc as fsGetDoc,
	setDoc as fsSetDoc,
	onSnapshot as fsOnSnapshot,
	query,
	where,
	Timestamp,
	serverTimestamp as fsServerTimestamp,
	type DocumentData,
	type QueryDocumentSnapshot
} from 'firebase/firestore';
import { ensureSignedIn, getFirebaseFirestore } from '$lib/firebase/app.js';
import {
	createNoteSyncClient,
	type CollectionDocChange,
	type FirestorePrimitives
} from './noteSyncClient.js';

function primitives(): FirestorePrimitives {
	return {
		async getDoc(path) {
			const snap = await fsGetDoc(doc(getFirebaseFirestore(), path));
			return { exists: snap.exists(), data: snap.data() };
		},
		async setDoc(path, data) {
			await fsSetDoc(doc(getFirebaseFirestore(), path), data);
		},
		onSnapshot(path, onNext, onError) {
			return fsOnSnapshot(
				doc(getFirebaseFirestore(), path),
				(snap) => onNext({ exists: snap.exists(), data: snap.data() }),
				onError
			);
		},
		onNotesAfter(uid, sinceMillis, onNext, onError) {
			const notesCol = collection(getFirebaseFirestore(), 'users', uid, 'notes');
			const q = query(
				notesCol,
				where('serverUpdatedAt', '>', Timestamp.fromMillis(sinceMillis))
			);
			return fsOnSnapshot(
				q,
				(qsnap) => {
					const docs: CollectionDocChange[] = [];
					for (const change of qsnap.docChanges()) {
						if (change.type !== 'added' && change.type !== 'modified') continue;
						const change_doc = change.doc as QueryDocumentSnapshot<DocumentData>;
						const data = change_doc.data();
						const ts = data.serverUpdatedAt;
						if (!ts || typeof (ts as Timestamp).toMillis !== 'function') {
							// serverTimestamp() not yet finalised by the server — wait for
							// the follow-up snapshot.
							continue;
						}
						docs.push({
							data,
							serverUpdatedAtMillis: (ts as Timestamp).toMillis()
						});
					}
					onNext(docs);
				},
				onError
			);
		},
		serverTimestamp: () => fsServerTimestamp()
	};
}

let clientSingleton: ReturnType<typeof createNoteSyncClient> | null = null;

export function getRealNoteSyncClient(): ReturnType<typeof createNoteSyncClient> {
	if (!clientSingleton) clientSingleton = createNoteSyncClient(primitives());
	return clientSingleton;
}

/**
 * Ensure the Dropbox-bridged Firebase user is signed in, returning their uid.
 * Returns null when sign-in is impossible (no Dropbox connection, network
 * down, etc.) so callers can quietly skip sync.
 */
export async function getCurrentNoteSyncUid(): Promise<string | null> {
	try {
		const user = await ensureSignedIn();
		return user.uid;
	} catch (err) {
		console.warn('[noteSync] sign-in failed', err);
		return null;
	}
}
