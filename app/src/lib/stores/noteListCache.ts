import type { NoteData } from '$lib/core/note.js';

let cached: NoteData[] | null = null;
let scrollTop = 0;
const listeners = new Set<() => void>();

export function getCachedNotes(): NoteData[] | null {
	return cached;
}

export function setCachedNotes(n: NoteData[]): void {
	cached = n;
}

export function invalidateCache(): void {
	cached = null;
	for (const l of listeners) l();
}

export function getCachedScrollTop(): number {
	return scrollTop;
}

export function setCachedScrollTop(n: number): void {
	scrollTop = n;
}

export function onInvalidate(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function _resetForTest(): void {
	cached = null;
	scrollTop = 0;
	listeners.clear();
}
