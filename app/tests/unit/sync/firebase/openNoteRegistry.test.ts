import { describe, it, expect, vi } from 'vitest';
import { createOpenNoteRegistry } from '$lib/sync/firebase/openNoteRegistry.js';

describe('createOpenNoteRegistry', () => {
	it('attach starts a subscription and reports the guid as open', () => {
		const unsub = vi.fn();
		const start = vi.fn(() => unsub);
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		expect(start).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledWith('a');
		expect(r.isOpen('a')).toBe(true);
		expect(r.openCount()).toBe(1);
	});

	it('attaching the same guid twice only starts one subscription (refcounted)', () => {
		const unsub = vi.fn();
		const start = vi.fn(() => unsub);
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.attach('a');
		expect(start).toHaveBeenCalledTimes(1);
		expect(r.openCount()).toBe(1);
	});

	it('detach calls unsubscribe only when refcount reaches zero', () => {
		const unsub = vi.fn();
		const start = vi.fn(() => unsub);
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.attach('a');
		r.detach('a');
		expect(unsub).not.toHaveBeenCalled();
		expect(r.isOpen('a')).toBe(true);

		r.detach('a');
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(r.isOpen('a')).toBe(false);
		expect(r.openCount()).toBe(0);
	});

	it('detach beyond zero is a no-op', () => {
		const unsub = vi.fn();
		const start = vi.fn(() => unsub);
		const r = createOpenNoteRegistry({ start });

		r.detach('a');
		r.detach('a');
		expect(unsub).not.toHaveBeenCalled();
	});

	it('attach after detach starts a fresh subscription', () => {
		const unsub = vi.fn();
		const start = vi.fn(() => unsub);
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.detach('a');
		r.attach('a');
		expect(start).toHaveBeenCalledTimes(2);
		expect(unsub).toHaveBeenCalledTimes(1);
	});

	it('different guids get independent subscriptions', () => {
		const unsubA = vi.fn();
		const unsubB = vi.fn();
		const start = vi.fn((g: string) => (g === 'a' ? unsubA : unsubB));
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.attach('b');
		expect(r.openCount()).toBe(2);

		r.detach('a');
		expect(unsubA).toHaveBeenCalledTimes(1);
		expect(unsubB).not.toHaveBeenCalled();
		expect(r.isOpen('b')).toBe(true);
	});

	it('detachAll() unsubscribes every active guid', () => {
		const unsubs: Record<string, () => void> = {
			a: vi.fn(),
			b: vi.fn(),
			c: vi.fn()
		};
		const start = (g: string): (() => void) => unsubs[g];
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.attach('b');
		r.attach('b'); // refcount=2
		r.attach('c');

		r.detachAll();
		expect(unsubs.a).toHaveBeenCalledTimes(1);
		expect(unsubs.b).toHaveBeenCalledTimes(1);
		expect(unsubs.c).toHaveBeenCalledTimes(1);
		expect(r.openCount()).toBe(0);
	});

	it('a throwing unsubscribe does not block other detaches', () => {
		const unsubA = vi.fn(() => {
			throw new Error('boom');
		});
		const unsubB = vi.fn();
		const start = vi.fn((g: string) => (g === 'a' ? unsubA : unsubB));
		const r = createOpenNoteRegistry({ start });

		r.attach('a');
		r.attach('b');
		expect(() => r.detachAll()).not.toThrow();
		expect(unsubB).toHaveBeenCalledTimes(1);
	});
});
