import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPushQueue } from '$lib/sync/firebase/pushQueue.js';
import type { NoteData } from '$lib/core/note.js';

function makeNote(guid: string, suffix = ''): NoteData {
	return {
		guid,
		uri: `note://tomboy/${guid}`,
		title: `t-${guid}${suffix}`,
		xmlContent: `<note-content version="0.1">t-${guid}${suffix}\n\n</note-content>`,
		createDate: '2026-04-27T10:00:00.0000000+09:00',
		changeDate: '2026-04-27T10:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-27T10:00:00.0000000+09:00',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: true,
		deleted: false
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createPushQueue', () => {
	it('does not call push before the debounce window expires', () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		vi.advanceTimersByTime(399);

		expect(push).not.toHaveBeenCalled();
	});

	it('calls push exactly once after the debounce window', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		await vi.advanceTimersByTimeAsync(400);

		expect(push).toHaveBeenCalledTimes(1);
		expect(push.mock.calls[0]?.[0]?.guid).toBe('a');
	});

	it('coalesces repeated enqueues of the same guid into one push with the latest snapshot', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const versions = ['v1', 'v2', 'v3'];
		let i = 0;
		const getNote = vi.fn(async (g: string) => makeNote(g, versions[i++]));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		vi.advanceTimersByTime(100);
		q.enqueue('a');
		vi.advanceTimersByTime(100);
		q.enqueue('a');
		await vi.advanceTimersByTimeAsync(400);

		// getNote is consulted exactly once at fire time, so it gets the
		// freshest IDB row (the test stub returns 'v1' here because the
		// counter only advances per call).
		expect(getNote).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(1);
		expect(push.mock.calls[0]?.[0]?.title).toBe('t-av1');
	});

	it('debounces independently per guid', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		vi.advanceTimersByTime(200);
		q.enqueue('b');
		await vi.advanceTimersByTimeAsync(200); // a fires at 400
		expect(push).toHaveBeenCalledTimes(1);
		expect(push.mock.calls[0]?.[0]?.guid).toBe('a');

		await vi.advanceTimersByTimeAsync(200); // b fires at 600
		expect(push).toHaveBeenCalledTimes(2);
		expect(push.mock.calls[1]?.[0]?.guid).toBe('b');
	});

	it('flush(guid) pushes immediately and cancels the pending timer', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		await q.flush('a');
		expect(push).toHaveBeenCalledTimes(1);

		// The cancelled timer must not refire.
		await vi.advanceTimersByTimeAsync(1000);
		expect(push).toHaveBeenCalledTimes(1);
	});

	it('flushAll() pushes every pending guid', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		q.enqueue('b');
		await q.flushAll();

		expect(push).toHaveBeenCalledTimes(2);
		const guids = push.mock.calls.map((c) => c[0].guid).sort();
		expect(guids).toEqual(['a', 'b']);
	});

	it('skips push when getNote returns undefined (note disappeared)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async () => undefined);
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		await vi.advanceTimersByTimeAsync(400);

		expect(push).not.toHaveBeenCalled();
	});

	it('a failed push does not block subsequent enqueues', async () => {
		const push = vi
			.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		q.enqueue('a');
		await vi.advanceTimersByTimeAsync(400);
		// drain the rejected promise
		await Promise.resolve();

		q.enqueue('a');
		await vi.advanceTimersByTimeAsync(400);

		expect(push).toHaveBeenCalledTimes(2);
	});

	it('flush of an unqueued guid is a no-op', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		const q = createPushQueue({ debounceMs: 400, push, getNote });

		await q.flush('never-enqueued');
		expect(push).not.toHaveBeenCalled();
	});
});
