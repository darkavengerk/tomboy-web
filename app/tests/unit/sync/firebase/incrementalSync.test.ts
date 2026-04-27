import { describe, it, expect, vi } from 'vitest';
import {
	createIncrementalSync,
	type IncrementalSyncDeps
} from '$lib/sync/firebase/incrementalSync.js';
import type { FirestoreNotePayload } from '$lib/sync/firebase/notePayload.js';
import type { Unsubscribe } from '$lib/sync/firebase/openNoteRegistry.js';

function payload(guid: string, overrides: Partial<FirestoreNotePayload> = {}): FirestoreNotePayload {
	return {
		guid,
		uri: `note://tomboy/${guid}`,
		title: `T-${guid}`,
		xmlContent: `<note-content version="0.1">T-${guid}\n\n</note-content>`,
		createDate: '2026-04-27T09:00:00.0000000+09:00',
		changeDate: '2026-04-27T10:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
		tags: [],
		deleted: false,
		...overrides
	};
}

interface FakeSub {
	uid: string;
	since: number;
	onChange: (
		changes: Array<{ payload: FirestoreNotePayload; serverUpdatedAtMillis: number }>
	) => void;
	onError: (err: Error) => void;
	unsubscribed: boolean;
}

function makeDeps(initialSinceMillis = 0): {
	deps: IncrementalSyncDeps;
	subs: FakeSub[];
	applied: FirestoreNotePayload[];
	persisted: number[];
	lastPersistedRef: { value: number };
	failNextApplyFor?: { guid: string };
} {
	const subs: FakeSub[] = [];
	const applied: FirestoreNotePayload[] = [];
	const persisted: number[] = [];
	const lastPersistedRef = { value: initialSinceMillis };

	const deps: IncrementalSyncDeps = {
		subscribe: (uid, since, onChange, onError) => {
			const entry: FakeSub = {
				uid,
				since,
				onChange,
				onError,
				unsubscribed: false
			};
			subs.push(entry);
			const unsub: Unsubscribe = () => {
				entry.unsubscribed = true;
			};
			return unsub;
		},
		applyRemote: vi.fn(async (p: FirestoreNotePayload) => {
			applied.push(p);
		}),
		getLastSyncMillis: async () => lastPersistedRef.value,
		setLastSyncMillis: async (m: number) => {
			lastPersistedRef.value = m;
			persisted.push(m);
		}
	};

	return { deps, subs, applied, persisted, lastPersistedRef };
}

function tick(ms = 0): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe('createIncrementalSync', () => {
	it('isRunning() is false before start() is called', () => {
		const { deps } = makeDeps();
		const inc = createIncrementalSync(deps);
		expect(inc.isRunning()).toBe(false);
	});

	it('start(uid) reads lastSyncMillis and uses it as the lower bound for subscribe', async () => {
		const { deps, subs } = makeDeps(1700000000000);
		const inc = createIncrementalSync(deps);

		await inc.start('dbx-u');

		expect(subs.length).toBe(1);
		expect(subs[0].uid).toBe('dbx-u');
		expect(subs[0].since).toBe(1700000000000);
		expect(inc.isRunning()).toBe(true);
	});

	it('forwards each emitted change through applyRemote in order', async () => {
		const { deps, subs, applied } = makeDeps();
		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		subs[0].onChange([
			{ payload: payload('a'), serverUpdatedAtMillis: 1000 },
			{ payload: payload('b'), serverUpdatedAtMillis: 2000 }
		]);
		await tick();

		expect(applied.map((p) => p.guid)).toEqual(['a', 'b']);
	});

	it('advances and persists the watermark to the max serverUpdatedAtMillis seen', async () => {
		const { deps, subs, persisted, lastPersistedRef } = makeDeps(500);
		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		subs[0].onChange([
			{ payload: payload('a'), serverUpdatedAtMillis: 1000 },
			{ payload: payload('b'), serverUpdatedAtMillis: 3000 },
			{ payload: payload('c'), serverUpdatedAtMillis: 2000 }
		]);
		await tick();

		expect(lastPersistedRef.value).toBe(3000);
		expect(persisted[persisted.length - 1]).toBe(3000);
	});

	it('does not regress the watermark when a later batch contains older docs only', async () => {
		const { deps, subs, lastPersistedRef } = makeDeps();
		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		subs[0].onChange([{ payload: payload('a'), serverUpdatedAtMillis: 5000 }]);
		await tick();
		expect(lastPersistedRef.value).toBe(5000);

		// Older emission (shouldn't normally happen, but be safe).
		subs[0].onChange([{ payload: payload('b'), serverUpdatedAtMillis: 100 }]);
		await tick();
		expect(lastPersistedRef.value).toBe(5000);
	});

	it('continues processing remaining docs when applyRemote throws on one', async () => {
		const { deps, subs, applied } = makeDeps();
		(deps.applyRemote as ReturnType<typeof vi.fn>).mockImplementation(
			async (p: FirestoreNotePayload) => {
				if (p.guid === 'b') throw new Error('boom');
				applied.push(p);
			}
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		subs[0].onChange([
			{ payload: payload('a'), serverUpdatedAtMillis: 100 },
			{ payload: payload('b'), serverUpdatedAtMillis: 200 },
			{ payload: payload('c'), serverUpdatedAtMillis: 300 }
		]);
		await tick();

		expect(applied.map((p) => p.guid)).toEqual(['a', 'c']);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('stop() unsubscribes the inner subscription and isRunning becomes false', async () => {
		const { deps, subs } = makeDeps();
		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		expect(subs[0].unsubscribed).toBe(false);
		inc.stop();
		expect(subs[0].unsubscribed).toBe(true);
		expect(inc.isRunning()).toBe(false);
	});

	it('start() is idempotent — second call while already running does not double-subscribe', async () => {
		const { deps, subs } = makeDeps();
		const inc = createIncrementalSync(deps);

		await inc.start('dbx-u');
		await inc.start('dbx-u');

		expect(subs.length).toBe(1);
	});

	it('start after stop subscribes again with the latest persisted bound', async () => {
		const { deps, subs } = makeDeps(1000);
		const inc = createIncrementalSync(deps);

		await inc.start('dbx-u');
		subs[0].onChange([{ payload: payload('a'), serverUpdatedAtMillis: 9000 }]);
		await tick();

		inc.stop();
		await inc.start('dbx-u');

		expect(subs.length).toBe(2);
		expect(subs[1].since).toBe(9000);
	});

	it('stop() called before subscribe resolves still tears down the eventual sub', async () => {
		// Subscribe asynchronously — represents the real getUid + subscribe race.
		const subs: FakeSub[] = [];
		const deps: IncrementalSyncDeps = {
			subscribe: (uid, since, onChange, onError) => {
				const entry: FakeSub = { uid, since, onChange, onError, unsubscribed: false };
				subs.push(entry);
				return () => {
					entry.unsubscribed = true;
				};
			},
			applyRemote: async () => undefined,
			getLastSyncMillis: () => new Promise((r) => setTimeout(() => r(0), 5)),
			setLastSyncMillis: async () => undefined
		};

		const inc = createIncrementalSync(deps);
		const startPromise = inc.start('dbx-u');
		// Stop immediately — before getLastSyncMillis resolves.
		inc.stop();
		await startPromise;
		await tick(20);

		// Either: (a) we never subscribed, or (b) we subscribed and then unsubscribed.
		if (subs.length > 0) {
			expect(subs[0].unsubscribed).toBe(true);
		}
		expect(inc.isRunning()).toBe(false);
	});

	it('emits applied payloads even when serverUpdatedAtMillis batch contains an entry with watermark <= since', async () => {
		// The query clamps with `>` server-side, but if the test deps emit a
		// boundary value (== since), we should still apply rather than silently
		// drop — applyRemote is idempotent via the conflict resolver.
		const { deps, subs, applied } = makeDeps(1000);
		const inc = createIncrementalSync(deps);
		await inc.start('dbx-u');

		subs[0].onChange([{ payload: payload('a'), serverUpdatedAtMillis: 1000 }]);
		await tick();

		expect(applied.map((p) => p.guid)).toEqual(['a']);
	});
});
