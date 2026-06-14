import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	subscribeNoteReload,
	_resetForTest as resetBus
} from '$lib/core/noteReloadBus.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';
import { _resetForTest as resetCache } from '$lib/stores/noteListCache.js';
import { _resetForTest as resetTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { _resetDBForTest } from '$lib/storage/db.js';

// Firebase + schedule hooks are no-ops here; stub to keep the test offline.
vi.mock('$lib/sync/firebase/orchestrator.js', () => ({ notifyNoteSaved: vi.fn() }));
vi.mock('$lib/schedule/syncSchedule.js', () => ({
	syncScheduleFromNote: vi.fn(async () => ({ isScheduleNote: false, added: 0, removed: 0 }))
}));
vi.mock('$lib/schedule/flushScheduler.js', () => ({ flushIfEnabled: vi.fn(async () => {}) }));

beforeEach(() => {
	clearIndex();
	resetBus();
	resetCache();
	resetTitleProvider();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('same-note convergence', () => {
	it('reloads sibling editors of the same guid, excludes the saver', async () => {
		const note = createEmptyNote('G');
		note.title = 'Hello';
		note.xmlContent = '<note-content version="0.1">Hello\n\nbody</note-content>';
		await noteStore.putNote(note);

		const tokenA = {}; // the saving editor
		const tokenB = {}; // a sibling editor
		const reloadedA = vi.fn();
		const reloadedB = vi.fn();
		subscribeNoteReload('G', reloadedA, tokenA);
		subscribeNoteReload('G', reloadedB, tokenB);

		const newDoc = deserializeContent('<note-content version="0.1">Hello\n\nedited body</note-content>');
		await updateNoteFromEditor('G', newDoc, tokenA);

		expect(reloadedA).not.toHaveBeenCalled(); // saver excluded
		expect(reloadedB).toHaveBeenCalledTimes(1); // sibling converges
		const stored = await noteStore.getNote('G');
		expect(stored!.xmlContent).toContain('edited body');
	});
});
