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

// ── Terminal history settings ────────────────────────────────────────

const TERM_HIST_OPEN_DESKTOP = 'terminalHistoryPanelOpenDesktop';
const TERM_HIST_OPEN_MOBILE = 'terminalHistoryPanelOpenMobile';
const TERM_HIST_BLOCKLIST = 'terminalHistoryBlocklist';
const TERM_HIST_BANNER_DISMISSED = 'terminalShellIntegrationBannerDismissed';

export const TERMINAL_HISTORY_BLOCKLIST_DEFAULT: string[] = [
	'ls', 'cd', 'pwd', 'clear', 'cls', 'exit', 'logout', 'whoami', 'date', 'history'
];

export async function getTerminalHistoryPanelOpenDesktop(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_DESKTOP);
	return typeof v === 'boolean' ? v : true;
}

export async function setTerminalHistoryPanelOpenDesktop(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_DESKTOP, value);
}

export async function getTerminalHistoryPanelOpenMobile(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_MOBILE);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalHistoryPanelOpenMobile(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_MOBILE, value);
}

export async function getTerminalHistoryBlocklist(): Promise<string[]> {
	const v = await getSetting<unknown>(TERM_HIST_BLOCKLIST);
	if (!Array.isArray(v)) return [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
	}
	return out.length > 0 ? out : [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
}

export async function setTerminalHistoryBlocklist(value: string[]): Promise<void> {
	await setSetting(TERM_HIST_BLOCKLIST, value);
}

export async function getTerminalShellIntegrationBannerDismissed(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_BANNER_DISMISSED);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalShellIntegrationBannerDismissed(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_BANNER_DISMISSED, value);
}
