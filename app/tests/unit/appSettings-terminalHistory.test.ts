import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	getTerminalHistoryPanelOpenDesktop,
	setTerminalHistoryPanelOpenDesktop,
	getTerminalHistoryPanelOpenMobile,
	setTerminalHistoryPanelOpenMobile,
	getTerminalHistoryBlocklist,
	setTerminalHistoryBlocklist,
	getTerminalShellIntegrationBannerDismissed,
	setTerminalShellIntegrationBannerDismissed,
	TERMINAL_HISTORY_BLOCKLIST_DEFAULT
} from '$lib/storage/appSettings.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('terminal history settings — defaults', () => {
	it('panel open desktop defaults true', async () => {
		expect(await getTerminalHistoryPanelOpenDesktop()).toBe(true);
	});

	it('panel open mobile defaults false', async () => {
		expect(await getTerminalHistoryPanelOpenMobile()).toBe(false);
	});

	it('blocklist defaults to canonical list', async () => {
		expect(await getTerminalHistoryBlocklist()).toEqual(TERMINAL_HISTORY_BLOCKLIST_DEFAULT);
	});

	it('banner dismissed defaults false', async () => {
		expect(await getTerminalShellIntegrationBannerDismissed()).toBe(false);
	});
});

describe('terminal history settings — round-trip', () => {
	it('panel open desktop persists', async () => {
		await setTerminalHistoryPanelOpenDesktop(false);
		expect(await getTerminalHistoryPanelOpenDesktop()).toBe(false);
	});

	it('blocklist trims and filters empties', async () => {
		await setTerminalHistoryBlocklist(['  ls  ', '', 'cat']);
		expect(await getTerminalHistoryBlocklist()).toEqual(['ls', 'cat']);
	});

	it('panel open mobile persists', async () => {
		await setTerminalHistoryPanelOpenMobile(true);
		expect(await getTerminalHistoryPanelOpenMobile()).toBe(true);
	});

	it('banner dismissed persists', async () => {
		await setTerminalShellIntegrationBannerDismissed(true);
		expect(await getTerminalShellIntegrationBannerDismissed()).toBe(true);
	});

	it('blocklist falls back to defaults when stored value is corrupted', async () => {
		await setSetting('terminalHistoryBlocklist', 'not-an-array');
		expect(await getTerminalHistoryBlocklist()).toEqual(TERMINAL_HISTORY_BLOCKLIST_DEFAULT);
	});
});
