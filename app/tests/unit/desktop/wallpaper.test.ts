// @vitest-environment node
// Node environment is required so that globalThis.structuredClone properly
// preserves Blob instances (jsdom's structuredClone collapses them to {}).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	loadWallpaper,
	setWallpaper,
	clearWallpaper,
	desktopSession
} from '$lib/desktop/session.svelte.js';

const WALLPAPER_KEY = 'desktop:wallpaper';
function blob(tag: string): Blob {
	return new Blob([tag], { type: 'image/png' });
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('per-workspace wallpaper', () => {
	it('setWallpaper writes only the per-workspace key', async () => {
		await setWallpaper(blob('w2'), 2);
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:2`)).toBeInstanceOf(Blob);
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:0`)).toBeUndefined();
		expect(await getSetting<Blob>(WALLPAPER_KEY)).toBeUndefined();
	});

	it('loadWallpaper returns the per-workspace blob when present', async () => {
		await setWallpaper(blob('w1'), 1);
		const b = await loadWallpaper(1);
		expect(b).toBeInstanceOf(Blob);
		expect(await b!.text()).toBe('w1');
	});

	it('loadWallpaper falls back to the legacy global key', async () => {
		await setSetting(WALLPAPER_KEY, blob('legacy'));
		const b = await loadWallpaper(3);
		expect(await b!.text()).toBe('legacy');
	});

	it('per-workspace blob overrides the legacy global', async () => {
		await setSetting(WALLPAPER_KEY, blob('legacy'));
		await setWallpaper(blob('own3'), 3);
		expect(await (await loadWallpaper(3))!.text()).toBe('own3');
	});

	it('loadWallpaper returns null when neither exists', async () => {
		expect(await loadWallpaper(0)).toBeNull();
	});

	it('setWallpaper bumps wallpaperEpoch', async () => {
		const before = desktopSession.wallpaperEpoch;
		await setWallpaper(blob('x'), 0);
		expect(desktopSession.wallpaperEpoch).toBe(before + 1);
	});

	it('clearWallpaper removes the per-workspace key and bumps epoch', async () => {
		await setWallpaper(blob('x'), 2);
		const before = desktopSession.wallpaperEpoch;
		await clearWallpaper(2);
		expect(await getSetting(`${WALLPAPER_KEY}:2`)).toBeUndefined();
		expect(desktopSession.wallpaperEpoch).toBe(before + 1);
	});

	it('setWallpaperForCurrent targets the current workspace', async () => {
		await desktopSession.setWallpaperForCurrent(blob('cur'));
		const i = desktopSession.currentWorkspace;
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:${i}`)).toBeInstanceOf(Blob);
	});
});
