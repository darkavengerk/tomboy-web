import { getDB } from './db.js';

interface Row<T> {
	id: string;
	value: T;
}

export async function getSetting<T>(id: string): Promise<T | undefined> {
	const db = await getDB();
	const row = (await db.get('appSettings', id)) as Row<T> | undefined;
	return row?.value;
}

export async function setSetting<T>(id: string, value: T): Promise<void> {
	const db = await getDB();
	await db.put('appSettings', { id, value });
}

export async function deleteSetting(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('appSettings', id);
}

/** Read every row from appSettings. */
export async function getAllSettings(): Promise<Array<{ id: string; value: unknown }>> {
	const db = await getDB();
	const rows = (await db.getAll('appSettings')) as Array<{ id: string; value: unknown }>;
	return rows;
}

/** Replace the whole appSettings store with the provided rows. */
export async function replaceAllSettings(
	rows: Array<{ id: string; value: unknown }>
): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('appSettings', 'readwrite');
	await tx.store.clear();
	for (const row of rows) {
		await tx.store.put(row);
	}
	await tx.done;
}
