import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	attachOpenNote,
	detachOpenNote,
	configureNoteSync,
	setNoteSyncEnabled,
	flushAllNoteSync,
	_resetNoteSyncForTest,
	type RemoteSubscribe
} from '$lib/sync/firebase/orchestrator.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { createNote, updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	subscribeNoteReload,
	_resetForTest as _resetReloadBus
} from '$lib/core/noteReloadBus.js';
import type { FirestoreNotePayload } from '$lib/sync/firebase/notePayload.js';
import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function docOf(...lines: string[]): JSONContent {
	return { type: 'doc', content: lines.map(p) };
}

function payloadFromNote(n: NoteData, overrides: Partial<FirestoreNotePayload> = {}): FirestoreNotePayload {
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

function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface FakeSub {
	emit: (p: FirestoreNotePayload | undefined) => void;
	unsubscribed: boolean;
}

function makeFakeSubscribe(): {
	subscribe: RemoteSubscribe;
	subs: Map<string, FakeSub>;
} {
	const subs = new Map<string, FakeSub>();
	const subscribe: RemoteSubscribe = (_uid, guid, onChange) => {
		const entry: FakeSub = {
			emit: onChange,
			unsubscribed: false
		};
		subs.set(guid, entry);
		return () => {
			entry.unsubscribed = true;
		};
	};
	return { subscribe, subs };
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetReloadBus();
	_resetNoteSyncForTest();
});

describe('orchestrator attach/detach realtime sync', () => {
	it('does nothing when sync is disabled', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 50,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});

		const n = await createNote('disabled-attach');
		attachOpenNote(n.guid);
		await tick(20);
		expect(subs.size).toBe(0);
	});

	it('does nothing when getUid returns null', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 50,
			getUid: async () => null,
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('no-uid');
		attachOpenNote(n.guid);
		await tick(20);
		expect(subs.size).toBe(0);
	});

	it('first remote=undefined snapshot pushes the local note (remote-missing)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('remote-missing');
		attachOpenNote(n.guid);
		await tick(20);

		expect(subs.has(n.guid)).toBe(true);
		subs.get(n.guid)!.emit(undefined);
		await tick(20);
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		expect((push.mock.calls[0][0] as NoteData).guid).toBe(n.guid);
	});

	it('first remote=newer snapshot pulls into IDB and fires the reload bus', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('Old Local');
		await updateNoteFromEditor(n.guid, docOf('Old Local', 'old body'));
		const local = (await noteStore.getNote(n.guid))!;

		const reloadFired = vi.fn();
		const unsubReload = subscribeNoteReload(n.guid, reloadFired);

		attachOpenNote(n.guid);
		await tick(20);
		expect(subs.has(n.guid)).toBe(true);

		const remote = payloadFromNote(local, {
			title: 'Remote Newer',
			xmlContent: '<note-content version="0.1">Remote Newer\n\nremote body</note-content>',
			changeDate: '2099-12-31T23:59:59.0000000+09:00',
			metadataChangeDate: '2099-12-31T23:59:59.0000000+09:00'
		});
		subs.get(n.guid)!.emit(remote);
		await tick(20);

		const after = await noteStore.getNote(n.guid);
		expect(after?.title).toBe('Remote Newer');
		expect(after?.xmlContent).toContain('remote body');
		expect(after?.localDirty).toBe(false);
		expect(reloadFired).toHaveBeenCalledTimes(1);

		unsubReload();
	});

	it('first remote=older snapshot pushes local (local-newer)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('Local Newer');
		await updateNoteFromEditor(n.guid, docOf('Local Newer', 'fresh'));
		push.mockClear();

		const local = (await noteStore.getNote(n.guid))!;
		attachOpenNote(n.guid);
		await tick(20);

		const stale = payloadFromNote(local, {
			xmlContent: '<note-content version="0.1">Local Newer\n\nstale</note-content>',
			changeDate: '2000-01-01T00:00:00.0000000+09:00',
			metadataChangeDate: '2000-01-01T00:00:00.0000000+09:00'
		});
		subs.get(n.guid)!.emit(stale);
		await tick(20);
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		expect((push.mock.calls[0][0] as NoteData).xmlContent).toContain('fresh');
	});

	it('equivalent remote snapshot is a noop (no push, no IDB rewrite)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('Same');
		const local = (await noteStore.getNote(n.guid))!;
		const beforeChangeDate = local.changeDate;

		attachOpenNote(n.guid);
		await tick(20);
		subs.get(n.guid)!.emit(payloadFromNote(local));
		await tick(20);
		await flushAllNoteSync();

		expect(push).not.toHaveBeenCalled();
		const after = await noteStore.getNote(n.guid);
		expect(after?.changeDate).toBe(beforeChangeDate);
	});

	it('detach unsubscribes', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('detached');
		attachOpenNote(n.guid);
		await tick(20);
		expect(subs.get(n.guid)?.unsubscribed).toBe(false);

		detachOpenNote(n.guid);
		expect(subs.get(n.guid)?.unsubscribed).toBe(true);
	});

	it('detach without prior attach is a no-op', () => {
		expect(() => detachOpenNote('never-attached')).not.toThrow();
	});

	it('two attaches share one subscription, refcount keeps it alive on first detach', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		const startSpy = vi.fn(subscribe);
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: startSpy
		});
		setNoteSyncEnabled(true);

		const n = await createNote('shared');
		attachOpenNote(n.guid);
		attachOpenNote(n.guid);
		await tick(20);
		expect(startSpy).toHaveBeenCalledTimes(1);

		detachOpenNote(n.guid);
		expect(subs.get(n.guid)?.unsubscribed).toBe(false);

		detachOpenNote(n.guid);
		expect(subs.get(n.guid)?.unsubscribed).toBe(true);
	});

	it('a remote tombstone arriving for a live local note marks it deleted', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const { subscribe, subs } = makeFakeSubscribe();
		configureNoteSync({
			push,
			getNote: noteStore.getNote,
			debounceMs: 30,
			getUid: async () => 'dbx-u',
			subscribeRemote: subscribe
		});
		setNoteSyncEnabled(true);

		const n = await createNote('To-be-killed');
		const local = (await noteStore.getNote(n.guid))!;

		attachOpenNote(n.guid);
		await tick(20);
		subs.get(n.guid)!.emit(
			payloadFromNote(local, {
				deleted: true,
				changeDate: '2099-12-31T23:59:59.0000000+09:00',
				metadataChangeDate: '2099-12-31T23:59:59.0000000+09:00'
			})
		);
		await tick(20);

		const after = await noteStore.getNote(n.guid);
		expect(after?.deleted).toBe(true);
		expect(after?.localDirty).toBe(false);
	});
});
