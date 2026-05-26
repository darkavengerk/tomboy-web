import { getDB } from '../storage/db.js';

export interface ImageCacheRecord {
	url: string;
	blob: Blob;
	contentType: string;
	size: number;
	lastAccess: number;
	insertedAt: number;
}

const STORE = 'imageCache' as const;
const INDEX_LAST_ACCESS = 'by_lastAccess' as const;

export async function getImageRecord(url: string): Promise<ImageCacheRecord | undefined> {
	const db = await getDB();
	return db.get(STORE, url);
}

export async function putImageRecord(record: ImageCacheRecord): Promise<void> {
	const db = await getDB();
	await db.put(STORE, record);
}

export async function deleteImageRecord(url: string): Promise<void> {
	const db = await getDB();
	await db.delete(STORE, url);
}

export async function clearImageStore(): Promise<void> {
	const db = await getDB();
	await db.clear(STORE);
}

/**
 * Evict the least-recently-accessed records until at least targetBytesToFree
 * bytes have been freed. Operates in a single readwrite transaction.
 */
export async function evictLRU(targetBytesToFree: number): Promise<{
	evictedUrls: string[];
	freedBytes: number;
}> {
	if (targetBytesToFree <= 0) return { evictedUrls: [], freedBytes: 0 };

	const db = await getDB();
	const tx = db.transaction(STORE, 'readwrite');
	const index = tx.store.index(INDEX_LAST_ACCESS);

	const evictedUrls: string[] = [];
	let freedBytes = 0;

	let cursor = await index.openCursor();
	while (cursor && freedBytes < targetBytesToFree) {
		evictedUrls.push(cursor.value.url);
		freedBytes += cursor.value.size;
		await cursor.delete();
		cursor = await cursor.continue();
	}
	await tx.done;

	return { evictedUrls, freedBytes };
}

/**
 * Cursor-scan sum of all record sizes — used for correctness reconciliation.
 * Operates in a single readonly transaction.
 */
export async function cursorSumSize(): Promise<number> {
	const db = await getDB();
	const tx = db.transaction(STORE, 'readonly');
	let total = 0;
	let cursor = await tx.store.openCursor();
	while (cursor) {
		total += cursor.value.size;
		cursor = await cursor.continue();
	}
	await tx.done;
	return total;
}

/**
 * Returns the number of records currently in the imageCache store.
 */
export async function countRecords(): Promise<number> {
	const db = await getDB();
	return db.count(STORE);
}
