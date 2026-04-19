import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	subscribeNoteReload,
	emitNoteReload,
	_resetForTest
} from '$lib/core/noteReloadBus.js';

beforeEach(() => {
	_resetForTest();
});

describe('noteReloadBus', () => {
	it('calls a subscribed listener when its guid is emitted', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn);
		await emitNoteReload(['A']);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('calls every listener subscribed to the same guid', async () => {
		const fn1 = vi.fn();
		const fn2 = vi.fn();
		subscribeNoteReload('A', fn1);
		subscribeNoteReload('A', fn2);
		await emitNoteReload(['A']);
		expect(fn1).toHaveBeenCalledTimes(1);
		expect(fn2).toHaveBeenCalledTimes(1);
	});

	it('does not invoke listeners for other guids', async () => {
		const fnA = vi.fn();
		const fnB = vi.fn();
		subscribeNoteReload('A', fnA);
		subscribeNoteReload('B', fnB);
		await emitNoteReload(['A']);
		expect(fnA).toHaveBeenCalledTimes(1);
		expect(fnB).not.toHaveBeenCalled();
	});

	it('invokes listeners across multiple guids in one emit', async () => {
		const fnA = vi.fn();
		const fnB = vi.fn();
		subscribeNoteReload('A', fnA);
		subscribeNoteReload('B', fnB);
		await emitNoteReload(['A', 'B']);
		expect(fnA).toHaveBeenCalledTimes(1);
		expect(fnB).toHaveBeenCalledTimes(1);
	});

	it('swallows a throwing sync listener without skipping others', async () => {
		const fnBad = vi.fn(() => {
			throw new Error('boom');
		});
		const fnGood = vi.fn();
		subscribeNoteReload('A', fnBad);
		subscribeNoteReload('A', fnGood);
		await expect(emitNoteReload(['A'])).resolves.toBeUndefined();
		expect(fnBad).toHaveBeenCalledTimes(1);
		expect(fnGood).toHaveBeenCalledTimes(1);
	});

	it('swallows a throwing async listener without skipping others', async () => {
		const fnBad = vi.fn(async () => {
			throw new Error('boom');
		});
		const fnGood = vi.fn(async () => {});
		subscribeNoteReload('A', fnBad);
		subscribeNoteReload('A', fnGood);
		await expect(emitNoteReload(['A'])).resolves.toBeUndefined();
		expect(fnBad).toHaveBeenCalledTimes(1);
		expect(fnGood).toHaveBeenCalledTimes(1);
	});

	it('unsubscribe stops further invocations', async () => {
		const fn = vi.fn();
		const off = subscribeNoteReload('A', fn);
		await emitNoteReload(['A']);
		expect(fn).toHaveBeenCalledTimes(1);
		off();
		await emitNoteReload(['A']);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('emit on a guid with no subscriber resolves without throwing', async () => {
		await expect(emitNoteReload(['nobody'])).resolves.toBeUndefined();
	});

	it('emit on an empty guid list resolves without throwing', async () => {
		await expect(emitNoteReload([])).resolves.toBeUndefined();
	});

	it('_resetForTest clears the registry', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn);
		_resetForTest();
		await emitNoteReload(['A']);
		expect(fn).not.toHaveBeenCalled();
	});

	it('awaits every async listener before resolving', async () => {
		let resolveInner: (() => void) | null = null;
		const innerPromise = new Promise<void>((r) => {
			resolveInner = r;
		});
		const fn = vi.fn(async () => {
			await innerPromise;
		});
		subscribeNoteReload('A', fn);
		const emitPromise = emitNoteReload(['A']);
		// Kick the microtask queue; emit should still be pending.
		let settled = false;
		void emitPromise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveInner!();
		await emitPromise;
		expect(settled).toBe(true);
	});
});
