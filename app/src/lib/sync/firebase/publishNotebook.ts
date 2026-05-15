/**
 * Host-side helper: toggle a notebook's "publicly shared" state by batch-updating
 * the `public` field on every note tagged for that notebook, then updating
 * `publicConfig.sharedNotebooks`.
 */
import { writeBatch, doc } from 'firebase/firestore';
import { getFirebaseFirestore, ensureSignedIn } from '$lib/firebase/app.js';
import { getAllNotes } from '$lib/storage/noteStore.js';
import { getNotebook } from '$lib/core/notebooks.js';
import { writePublicConfigAsHost, readPublicConfigForHost } from './publicConfig.js';

const BATCH_CHUNK = 450;

export async function setNotebookPublic(
	name: string,
	isPublic: boolean,
	onProgress?: (done: number, total: number) => void
): Promise<void> {
	const user = await ensureSignedIn();
	const db = getFirebaseFirestore();
	const all = await getAllNotes();
	const notes = all.filter((n) => getNotebook(n) === name);

	let done = 0;
	for (let i = 0; i < notes.length; i += BATCH_CHUNK) {
		const batch = writeBatch(db);
		const slice = notes.slice(i, i + BATCH_CHUNK);
		for (const n of slice) {
			batch.update(doc(db, 'users', user.uid, 'notes', n.guid), { public: isPublic });
		}
		await batch.commit();
		done += slice.length;
		onProgress?.(done, notes.length);
	}

	const cfg = await readPublicConfigForHost(user.uid);
	const next = new Set(cfg.sharedNotebooks);
	if (isPublic) next.add(name);
	else next.delete(name);
	await writePublicConfigAsHost(user.uid, { sharedNotebooks: [...next] });
}
