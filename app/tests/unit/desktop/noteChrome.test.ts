// @vitest-environment node
// Node environment is required so that globalThis.structuredClone properly
// preserves Blob instances (jsdom's structuredClone collapses them to {}).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	loadNoteBg,
	loadNoteBgMode,
	setNoteBg,
	clearNoteBg,
	loadNoteOpacity,
	setNoteOpacity,
	desktopSession
} from '$lib/desktop/session.svelte.js';

const NOTE_BG_KEY = 'note:bg';
const NOTE_BG_MODE_KEY = 'note:bg-mode';
const NOTE_OPACITY_KEY = 'note:opacity';
const G = 'guid-a';
const H = 'guid-b';

function blob(tag: string): Blob {
	return new Blob([tag], { type: 'image/png' });
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('per-note background', () => {
	it('loadNoteBg returns null when unset', async () => {
		expect(await loadNoteBg(G)).toBeNull();
	});

	it('loadNoteBgMode defaults to contain when unset', async () => {
		expect(await loadNoteBgMode(G)).toBe('contain');
	});

	it('setNoteBg writes the per-note blob + mode keys and bumps noteChromeEpoch', async () => {
		const before = desktopSession.noteChromeEpoch;
		await setNoteBg(G, blob('a'), 'tile');
		expect(await getSetting<Blob>(`${NOTE_BG_KEY}:${G}`)).toBeInstanceOf(Blob);
		expect(await getSetting(`${NOTE_BG_MODE_KEY}:${G}`)).toBe('tile');
		expect(await (await loadNoteBg(G))!.text()).toBe('a');
		expect(await loadNoteBgMode(G)).toBe('tile');
		expect(desktopSession.noteChromeEpoch).toBe(before + 1);
	});

	it('background is independent per note', async () => {
		await setNoteBg(G, blob('a'), 'cover');
		await setNoteBg(H, blob('b'), 'center');
		expect(await (await loadNoteBg(G))!.text()).toBe('a');
		expect(await loadNoteBgMode(G)).toBe('cover');
		expect(await (await loadNoteBg(H))!.text()).toBe('b');
		expect(await loadNoteBgMode(H)).toBe('center');
	});

	it('loadNoteBgMode falls back to contain for an unrecognized stored value', async () => {
		await setSetting(`${NOTE_BG_MODE_KEY}:${G}`, 'bogus');
		expect(await loadNoteBgMode(G)).toBe('contain');
	});

	it('clearNoteBg removes both keys and bumps noteChromeEpoch', async () => {
		await setNoteBg(G, blob('a'), 'fill');
		const before = desktopSession.noteChromeEpoch;
		await clearNoteBg(G);
		expect(await getSetting(`${NOTE_BG_KEY}:${G}`)).toBeUndefined();
		expect(await getSetting(`${NOTE_BG_MODE_KEY}:${G}`)).toBeUndefined();
		expect(await loadNoteBg(G)).toBeNull();
		expect(desktopSession.noteChromeEpoch).toBe(before + 1);
	});
});

describe('per-note opacity', () => {
	it('defaults to 1 when unset', async () => {
		expect(await loadNoteOpacity(G)).toBe(1);
	});

	it('setNoteOpacity persists the value', async () => {
		await setNoteOpacity(G, 0.5);
		expect(await getSetting<number>(`${NOTE_OPACITY_KEY}:${G}`)).toBe(0.5);
		expect(await loadNoteOpacity(G)).toBe(0.5);
	});

	it('setNoteOpacity clamps to [0.2, 1]', async () => {
		await setNoteOpacity(G, 0.05);
		expect(await loadNoteOpacity(G)).toBe(0.2);
		await setNoteOpacity(H, 2);
		expect(await loadNoteOpacity(H)).toBe(1);
	});

	it('loadNoteOpacity clamps an out-of-range stored value', async () => {
		await setSetting(`${NOTE_OPACITY_KEY}:${G}`, 0.01);
		expect(await loadNoteOpacity(G)).toBe(0.2);
	});

	it('loadNoteOpacity ignores a non-numeric stored value', async () => {
		await setSetting(`${NOTE_OPACITY_KEY}:${G}`, 'oops');
		expect(await loadNoteOpacity(G)).toBe(1);
	});

	it('opacity is independent per note', async () => {
		await setNoteOpacity(G, 0.4);
		await setNoteOpacity(H, 0.8);
		expect(await loadNoteOpacity(G)).toBe(0.4);
		expect(await loadNoteOpacity(H)).toBe(0.8);
	});
});
