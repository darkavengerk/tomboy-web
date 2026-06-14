import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	subscribeNoteReload,
	emitNoteReload,
	subscribeNoteFlush,
	emitNoteFlush,
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

	it('excludes only the listener whose token matches `except`', async () => {
		const saver = vi.fn();
		const sibling = vi.fn();
		const tokenSaver = {};
		const tokenSibling = {};
		subscribeNoteReload('A', saver, tokenSaver);
		subscribeNoteReload('A', sibling, tokenSibling);
		await emitNoteReload(['A'], { except: tokenSaver });
		expect(saver).not.toHaveBeenCalled();
		expect(sibling).toHaveBeenCalledTimes(1);
	});

	it('except=undefined excludes nobody (back-compat)', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn, {});
		await emitNoteReload(['A'], { except: undefined });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('a token-less listener is never excluded', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn); // no token
		await emitNoteReload(['A'], { except: {} });
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

describe('noteReloadBus — flush channel', () => {
	it('flushes a subscribed guid', async () => {
		const fn = vi.fn();
		subscribeNoteFlush('A', fn);
		await emitNoteFlush(['A']);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('awaits an async flush before resolving', async () => {
		let resolveInner: (() => void) | null = null;
		const inner = new Promise<void>((r) => {
			resolveInner = r;
		});
		const fn = vi.fn(async () => {
			await inner;
		});
		subscribeNoteFlush('A', fn);
		const emit = emitNoteFlush(['A']);
		let settled = false;
		void emit.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveInner!();
		await emit;
		expect(settled).toBe(true);
	});

	it('swallows a throwing flush without stalling the batch', async () => {
		const bad = vi.fn(async () => {
			throw new Error('flush boom');
		});
		const good = vi.fn(async () => {});
		subscribeNoteFlush('A', bad);
		subscribeNoteFlush('B', good);
		await expect(emitNoteFlush(['A', 'B'])).resolves.toBeUndefined();
		expect(bad).toHaveBeenCalledTimes(1);
		expect(good).toHaveBeenCalledTimes(1);
	});

	it('flush and reload channels are independent for the same guid', async () => {
		const flushFn = vi.fn();
		const reloadFn = vi.fn();
		subscribeNoteFlush('A', flushFn);
		subscribeNoteReload('A', reloadFn);

		await emitNoteFlush(['A']);
		expect(flushFn).toHaveBeenCalledTimes(1);
		expect(reloadFn).not.toHaveBeenCalled();

		await emitNoteReload(['A']);
		expect(flushFn).toHaveBeenCalledTimes(1);
		expect(reloadFn).toHaveBeenCalledTimes(1);
	});

	it('unsubscribe stops further flushes', async () => {
		const fn = vi.fn();
		const off = subscribeNoteFlush('A', fn);
		await emitNoteFlush(['A']);
		off();
		await emitNoteFlush(['A']);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('emit on a guid with no flush subscriber resolves quietly', async () => {
		await expect(emitNoteFlush(['nobody'])).resolves.toBeUndefined();
	});

	it('_resetForTest clears flush subscribers too', async () => {
		const fn = vi.fn();
		subscribeNoteFlush('A', fn);
		_resetForTest();
		await emitNoteFlush(['A']);
		expect(fn).not.toHaveBeenCalled();
	});
});
