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
