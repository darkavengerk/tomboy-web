/**
 * Per-guid debounced push queue.
 *
 * The editor save path enqueues a push for each modified note; rapid keystrokes
 * collapse into a single Firestore write. The queue resolves the latest
 * NoteData via {@link PushQueueOptions.getNote} at fire time so coalesced
 * enqueues automatically pick up whatever is on disk.
 *
 * Errors are caught locally — the next enqueue retries naturally — so a
 * transient Firestore failure can never wedge later writes.
 */
import type { NoteData } from '$lib/core/note.js';

export interface PushQueueOptions {
	debounceMs: number;
	push: (note: NoteData) => Promise<void>;
	getNote: (guid: string) => Promise<NoteData | undefined>;
	onError?: (guid: string, err: unknown) => void;
}

export interface PushQueue {
	enqueue(guid: string): void;
	flush(guid: string): Promise<void>;
	flushAll(): Promise<void>;
}

export function createPushQueue(opts: PushQueueOptions): PushQueue {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	async function fire(guid: string): Promise<void> {
		timers.delete(guid);
		try {
			const note = await opts.getNote(guid);
			if (!note) return;
			await opts.push(note);
		} catch (err) {
			opts.onError?.(guid, err);
		}
	}

	function enqueue(guid: string): void {
		const existing = timers.get(guid);
		if (existing) clearTimeout(existing);
		const t = setTimeout(() => {
			void fire(guid);
		}, opts.debounceMs);
		timers.set(guid, t);
	}

	async function flush(guid: string): Promise<void> {
		const existing = timers.get(guid);
		if (!existing) return;
		clearTimeout(existing);
		await fire(guid);
	}

	async function flushAll(): Promise<void> {
		const guids = [...timers.keys()];
		await Promise.all(guids.map((g) => flush(g)));
	}

	return { enqueue, flush, flushAll };
}
