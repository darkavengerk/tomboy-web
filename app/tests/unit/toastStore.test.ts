import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toasts, pushToast, dismissToast, _resetForTest } from '$lib/stores/toast.js';
import { get } from 'svelte/store';

beforeEach(() => {
	_resetForTest();
});

describe('toastStore', () => {
	it('push() adds a toast with auto-generated id', () => {
		const id = pushToast('hello');
		const all = get(toasts);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ id, message: 'hello' });
	});

	it('dismiss(id) removes only that toast', () => {
		const id1 = pushToast('first', { timeoutMs: 0 });
		const id2 = pushToast('second', { timeoutMs: 0 });
		dismissToast(id1);
		const all = get(toasts);
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe(id2);
	});

	it('push(msg, { timeoutMs }) auto-removes after timer', () => {
		vi.useFakeTimers();
		pushToast('bye', { timeoutMs: 1000 });
		expect(get(toasts)).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(get(toasts)).toHaveLength(0);
		vi.useRealTimers();
	});

	it('subscribe() delivers snapshots on each mutation', () => {
		const snapshots: number[] = [];
		const unsub = toasts.subscribe((ts) => snapshots.push(ts.length));
		pushToast('a', { timeoutMs: 0 });
		pushToast('b', { timeoutMs: 0 });
		dismissToast(1);
		unsub();
		// initial(0), after push a(1), after push b(2), after dismiss(1)
		expect(snapshots).toEqual([0, 1, 2, 1]);
	});

	it('toast has default kind "info"', () => {
		pushToast('test');
		expect(get(toasts)[0].kind).toBe('info');
	});

	it('toast can have kind "error"', () => {
		pushToast('err', { kind: 'error' });
		expect(get(toasts)[0].kind).toBe('error');
	});
});
