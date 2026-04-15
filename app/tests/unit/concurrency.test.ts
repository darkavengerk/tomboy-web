/**
 * Unit tests for the bounded-parallelism helpers in lib/sync/concurrency.ts.
 *
 * Invariants:
 *   - peak in-flight ≤ limit
 *   - runWithConcurrency is fail-fast: on first rejection, no new tasks
 *     start, and the returned promise rejects after in-flight tasks settle.
 *   - runAllSettledWithConcurrency visits every task and returns a settled
 *     result in the original index order.
 */

import { describe, it, expect } from 'vitest';
import { runWithConcurrency, runAllSettledWithConcurrency } from '$lib/sync/concurrency.js';

function tracker() {
	let inFlight = 0;
	let peak = 0;
	return {
		start() {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
		},
		end() { inFlight--; },
		get peak() { return peak; }
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe('runWithConcurrency', () => {
	it('respects concurrency limit under bursty timing', async () => {
		const t = tracker();
		const tasks = Array.from({ length: 40 }, (_, i) => async () => {
			t.start();
			await delay(2 + (i % 3));
			t.end();
			return i;
		});
		const results = await runWithConcurrency(tasks, 6);
		expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i));
		expect(t.peak).toBeLessThanOrEqual(6);
		expect(t.peak).toBeGreaterThan(1);
	});

	it('fails fast: on rejection, no further tasks start', async () => {
		let started = 0;
		const tasks: Array<() => Promise<number>> = Array.from({ length: 20 }, (_, i) => async () => {
			started++;
			if (i === 3) throw new Error('boom');
			await delay(5);
			return i;
		});
		await expect(runWithConcurrency(tasks, 4)).rejects.toThrow('boom');
		// With limit=4 and fail at i=3, at most ~4 concurrent workers started before drain.
		// Strictly < 20 proves we stopped scheduling.
		expect(started).toBeLessThan(20);
	});

	it('waits for in-flight to settle before rejecting', async () => {
		let resolvedSlow = false;
		const tasks: Array<() => Promise<void>> = [
			async () => { await delay(20); resolvedSlow = true; },
			async () => { throw new Error('fast-fail'); }
		];
		await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('fast-fail');
		expect(resolvedSlow).toBe(true);
	});

	it('limit=1 is sequential', async () => {
		const t = tracker();
		const tasks = Array.from({ length: 5 }, () => async () => {
			t.start(); await delay(3); t.end();
		});
		await runWithConcurrency(tasks, 1);
		expect(t.peak).toBe(1);
	});

	it('empty task list resolves to []', async () => {
		const out = await runWithConcurrency<number>([], 4);
		expect(out).toEqual([]);
	});
});

describe('runAllSettledWithConcurrency', () => {
	it('collects every outcome in original order', async () => {
		const tasks: Array<() => Promise<number>> = [
			async () => { await delay(5); return 0; },
			async () => { throw new Error('e1'); },
			async () => { await delay(1); return 2; },
			async () => { throw new Error('e3'); }
		];
		const results = await runAllSettledWithConcurrency(tasks, 2);
		expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });
		expect(results[1].status).toBe('rejected');
		expect(results[2]).toEqual({ status: 'fulfilled', value: 2 });
		expect(results[3].status).toBe('rejected');
	});

	it('continues after rejections (visits every task)', async () => {
		let count = 0;
		const tasks = Array.from({ length: 30 }, (_, i) => async () => {
			count++;
			if (i % 5 === 0) throw new Error(`e${i}`);
			return i;
		});
		const results = await runAllSettledWithConcurrency(tasks, 4);
		expect(count).toBe(30);
		expect(results).toHaveLength(30);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(6);
	});

	it('respects concurrency limit', async () => {
		const t = tracker();
		const tasks = Array.from({ length: 30 }, () => async () => {
			t.start(); await delay(3); t.end();
		});
		await runAllSettledWithConcurrency(tasks, 5);
		expect(t.peak).toBeLessThanOrEqual(5);
		expect(t.peak).toBeGreaterThan(1);
	});
});
