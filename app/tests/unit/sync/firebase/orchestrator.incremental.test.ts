import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	configureNoteSync,
	setNoteSyncEnabled,
	flushAllNoteSync,
	_resetNoteSyncForTest
} from '$lib/sync/firebase/orchestrator.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { createNote, updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	subscribeNoteReload,
	_resetForTest as _resetReloadBus
} from '$lib/core/noteReloadBus.js';
import {
	onInvalidate,
	_resetForTest as _resetNoteListCache
} from '$lib/stores/noteListCache.js';
import type { FirestoreNotePayload } from '$lib/sync/firebase/notePayload.js';
import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';
import type { IncrementalSyncChange } from '$lib/sync/firebase/incrementalSync.js';

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function docOf(...lines: string[]): JSONContent {
	return { type: 'doc', content: lines.map(p) };
}

function payloadFromNote(
	n: NoteData,
	overrides: Partial<FirestoreNotePayload> = {}
): FirestoreNotePayload {
	return {
		guid: n.guid,
		uri: n.uri,
		title: n.title,
		xmlContent: n.xmlContent,
		createDate: n.createDate,
		changeDate: n.changeDate,
		metadataChangeDate: n.metadataChangeDate,
		tags: [...n.tags],
		deleted: n.deleted,
		...overrides
	};
}

function tick(ms = 20): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface FakeIncrSub {
	uid: string;
	since: number;
	onChange: (changes: IncrementalSyncChange[]) => void;
	onError: (err: Error) => void;
	unsubscribed: boolean;
}

function makeIncrementalDeps(initialSinceMillis = 0): {
	subscribeNoteCollection: (
		uid: string,
		since: number,
		onChange: (changes: IncrementalSyncChange[]) => void,
		onError: (err: Error) => void
	) => () => void;
	subs: FakeIncrSub[];
	getLastSyncMillis: () => Promise<number>;
	setLastSyncMillis: (m: number) => Promise<void>;
	persistedRef: { value: number };
} {
	const subs: FakeIncrSub[] = [];
	const persistedRef = { value: initialSinceMillis };
	return {
		subs,
		persistedRef,
		subscribeNoteCollection: (uid, since, onChange, onError) => {
			const entry: FakeIncrSub = { uid, since, onChange, onError, unsubscribed: false };
			subs.push(entry);
			return () => {
				entry.unsubscribed = true;
			};
		},
		getLastSyncMillis: async () => persistedRef.value,
		setLastSyncMillis: async (m) => {
			persistedRef.value = m;
		}
	};
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetReloadBus();
	_resetNoteListCache();
	_resetNoteSyncForTest();
});

describe('orchestrator incremental collection sync', () => {
	it('does not start incremental sync while disabled', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});

		await tick();
		expect(subs.length).toBe(0);
	});

	it('starts the collection listener on enable, with the persisted bound', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps(7777);
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});

		setNoteSyncEnabled(true);
		await tick();

		expect(subs.length).toBe(1);
		expect(subs[0].uid).toBe('dbx-u');
		expect(subs[0].since).toBe(7777);
	});

	it('pulls a remote-only note into IDB when emitted by the listener (local-missing → pull)', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});
		setNoteSyncEnabled(true);
		await tick();
		expect(subs.length).toBe(1);

		const remote: FirestoreNotePayload = {
			guid: 'remote-only-1',
			uri: 'note://tomboy/remote-only-1',
			title: 'Remote Only',
			xmlContent:
				'<note-content version="0.1">Remote Only\n\nfrom another device</note-content>',
			createDate: '2026-04-27T09:00:00.0000000+09:00',
			changeDate: '2026-04-27T10:00:00.0000000+09:00',
			metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
			tags: [],
			deleted: false
		};

		subs[0].onChange([{ payload: remote, serverUpdatedAtMillis: 1234567 }]);
		await tick();

		const stored = await noteStore.getNote('remote-only-1');
		expect(stored).toBeDefined();
		expect(stored?.title).toBe('Remote Only');
		expect(stored?.xmlContent).toContain('from another device');
		expect(stored?.localDirty).toBe(false);
	});

	it('persists the watermark to setLastSyncMillis after applying a batch', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis, persistedRef } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});
		setNoteSyncEnabled(true);
		await tick();

		subs[0].onChange([
			{
				payload: {
					guid: 'g',
					uri: 'note://tomboy/g',
					title: 'g',
					xmlContent: '<note-content version="0.1">g\n\n</note-content>',
					createDate: '2026-04-27T09:00:00.0000000+09:00',
					changeDate: '2026-04-27T10:00:00.0000000+09:00',
					metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
					tags: [],
					deleted: false
				},
				serverUpdatedAtMillis: 9999
			}
		]);
		await tick();

		expect(persistedRef.value).toBe(9999);
	});

	it('disabling sync stops the subscription', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});

		setNoteSyncEnabled(true);
		await tick();
		expect(subs[0].unsubscribed).toBe(false);

		setNoteSyncEnabled(false);
		expect(subs[0].unsubscribed).toBe(true);
	});

	it('echo of our own pushed write resolves to noop (no IDB rewrite)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});
		setNoteSyncEnabled(true);
		await tick();

		const n = await createNote('echo-test');
		await updateNoteFromEditor(n.guid, docOf('echo-test', 'body'));
		await flushAllNoteSync();

		const local = (await noteStore.getNote(n.guid))!;
		const beforeChangeDate = local.changeDate;

		// Listener echoes the doc back at us.
		subs[0].onChange([{ payload: payloadFromNote(local), serverUpdatedAtMillis: 5000 }]);
		await tick();

		const after = await noteStore.getNote(n.guid);
		expect(after?.changeDate).toBe(beforeChangeDate);
		expect(after?.localDirty).toBe(local.localDirty);
	});

	it('newer remote payload pulls into IDB and fires the reload bus', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});
		setNoteSyncEnabled(true);
		await tick();

		const n = await createNote('Old Local');
		await updateNoteFromEditor(n.guid, docOf('Old Local', 'old body'));
		const local = (await noteStore.getNote(n.guid))!;

		const reloadFired = vi.fn();
		const unsubReload = subscribeNoteReload(n.guid, reloadFired);

		const newer = payloadFromNote(local, {
			title: 'Remote Newer',
			xmlContent: '<note-content version="0.1">Remote Newer\n\nremote body</note-content>',
			changeDate: '2099-12-31T23:59:59.0000000+09:00',
			metadataChangeDate: '2099-12-31T23:59:59.0000000+09:00'
		});
		subs[0].onChange([{ payload: newer, serverUpdatedAtMillis: 9000 }]);
		await tick();

		const after = await noteStore.getNote(n.guid);
		expect(after?.title).toBe('Remote Newer');
		expect(after?.xmlContent).toContain('remote body');
		expect(reloadFired).toHaveBeenCalledTimes(1);

		unsubReload();
	});

	it('a remote-only note pulled by the incremental listener invalidates the note list cache', async () => {
		// SidePanel and the auto-link title index subscribe to
		// noteListCache.onInvalidate. Without this fan-out, a brand-new note
		// arriving via incremental sync stays invisible until the user
		// refreshes.
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});
		setNoteSyncEnabled(true);
		await tick();

		const invalidated = vi.fn();
		const off = onInvalidate(invalidated);

		const remote: FirestoreNotePayload = {
			guid: 'remote-only-2',
			uri: 'note://tomboy/remote-only-2',
			title: 'Brand New From Other Device',
			xmlContent:
				'<note-content version="0.1">Brand New From Other Device\n\n</note-content>',
			createDate: '2026-04-27T09:00:00.0000000+09:00',
			changeDate: '2026-04-27T10:00:00.0000000+09:00',
			metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
			tags: [],
			deleted: false
		};
		subs[0].onChange([{ payload: remote, serverUpdatedAtMillis: 1234 }]);
		await tick();

		expect(invalidated).toHaveBeenCalled();
		off();
	});

	it('does nothing when getUid returns null', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => null,
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});

		setNoteSyncEnabled(true);
		await tick();

		expect(subs.length).toBe(0);
	});

	it('disable then re-enable subscribes again with the latest persisted bound', async () => {
		const { subscribeNoteCollection, subs, getLastSyncMillis, setLastSyncMillis } =
			makeIncrementalDeps();
		configureNoteSync({
			push: vi.fn().mockResolvedValue(undefined),
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeNoteCollection,
			getLastSyncMillis,
			setLastSyncMillis
		});

		setNoteSyncEnabled(true);
		await tick();
		expect(subs.length).toBe(1);

		// First batch advances the watermark to 7000.
		subs[0].onChange([
			{
				payload: {
					guid: 'g',
					uri: 'note://tomboy/g',
					title: 'g',
					xmlContent: '<note-content version="0.1">g\n\n</note-content>',
					createDate: '2026-04-27T09:00:00.0000000+09:00',
					changeDate: '2026-04-27T10:00:00.0000000+09:00',
					metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
					tags: [],
					deleted: false
				},
				serverUpdatedAtMillis: 7000
			}
		]);
		await tick();

		setNoteSyncEnabled(false);
		expect(subs[0].unsubscribed).toBe(true);

		setNoteSyncEnabled(true);
		await tick();
		expect(subs.length).toBe(2);
		expect(subs[1].since).toBe(7000);
	});
});
