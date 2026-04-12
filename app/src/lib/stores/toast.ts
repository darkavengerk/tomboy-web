import { writable } from 'svelte/store';

export interface Toast {
	id: number;
	message: string;
	kind?: 'info' | 'error';
}

export const toasts = writable<Toast[]>([]);
let nextId = 1;

export function pushToast(
	message: string,
	opts: { timeoutMs?: number; kind?: Toast['kind'] } = {}
): number {
	const id = nextId++;
	const kind = opts.kind ?? 'info';
	toasts.update((ts) => [...ts, { id, message, kind }]);
	const t = opts.timeoutMs ?? 2500;
	if (t > 0) setTimeout(() => dismissToast(id), t);
	return id;
}

export function dismissToast(id: number): void {
	toasts.update((ts) => ts.filter((x) => x.id !== id));
}

/** Reset for testing */
export function _resetForTest(): void {
	toasts.set([]);
	nextId = 1;
}
