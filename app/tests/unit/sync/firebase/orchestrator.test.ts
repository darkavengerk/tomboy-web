import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	notifyNoteSaved,
	configureNoteSync,
	setNoteSyncEnabled,
	isNoteSyncEnabled,
	flushAllNoteSync,
	_resetNoteSyncForTest
} from '$lib/sync/firebase/orchestrator.js';
import type { NoteData } from '$lib/core/note.js';

function makeNote(guid: string): NoteData {
	return {
		guid,
		uri: `note://tomboy/${guid}`,
		title: `t-${guid}`,
		xmlContent: `<note-content version="0.1">t-${guid}\n\n</note-content>`,
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
	_resetNoteSyncForTest();
});

afterEach(() => {
	vi.useRealTimers();
	_resetNoteSyncForTest();
});

describe('orchestrator gating', () => {
	it('starts disabled by default', () => {
		expect(isNoteSyncEnabled()).toBe(false);
	});

	it('notifyNoteSaved is a no-op when disabled', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		configureNoteSync({ push, getNote, debounceMs: 100 });

		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(500);

		expect(push).not.toHaveBeenCalled();
	});

	it('notifyNoteSaved enqueues a push when enabled', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		configureNoteSync({ push, getNote, debounceMs: 100 });
		setNoteSyncEnabled(true);

		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(100);

		expect(push).toHaveBeenCalledTimes(1);
		expect(push.mock.calls[0]?.[0]?.guid).toBe('a');
	});

	it('coalesces rapid calls to the same guid', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		configureNoteSync({ push, getNote, debounceMs: 200 });
		setNoteSyncEnabled(true);

		notifyNoteSaved('a');
		vi.advanceTimersByTime(50);
		notifyNoteSaved('a');
		vi.advanceTimersByTime(50);
		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(200);

		expect(push).toHaveBeenCalledTimes(1);
	});

	it('flipping disabled then enabled reactivates without losing prior config', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		configureNoteSync({ push, getNote, debounceMs: 100 });
		setNoteSyncEnabled(true);
		setNoteSyncEnabled(false);
		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(200);
		expect(push).not.toHaveBeenCalled();

		setNoteSyncEnabled(true);
		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(100);
		expect(push).toHaveBeenCalledTimes(1);
	});

	it('flushAllNoteSync drains pending pushes immediately', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));
		configureNoteSync({ push, getNote, debounceMs: 5_000 });
		setNoteSyncEnabled(true);

		notifyNoteSaved('a');
		notifyNoteSaved('b');
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(2);
		const guids = push.mock.calls.map((c) => c[0].guid).sort();
		expect(guids).toEqual(['a', 'b']);
	});

	it('reconfigure swaps the underlying push function', async () => {
		const push1 = vi.fn().mockResolvedValue(undefined);
		const push2 = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => makeNote(g));

		configureNoteSync({ push: push1, getNote, debounceMs: 100 });
		setNoteSyncEnabled(true);
		notifyNoteSaved('a');
		await vi.advanceTimersByTimeAsync(100);
		expect(push1).toHaveBeenCalledTimes(1);

		configureNoteSync({ push: push2, getNote, debounceMs: 100 });
		notifyNoteSaved('b');
		await vi.advanceTimersByTimeAsync(100);
		expect(push2).toHaveBeenCalledTimes(1);
		expect(push1).toHaveBeenCalledTimes(1);
	});
});
