import { describe, it, expect } from 'vitest';
import { evaluateReload, RELOAD_MAX, RELOAD_WINDOW_MS } from '$lib/nav/reloadGuard';

describe('evaluateReload', () => {
	it('allows the first reload from a clean slate and stamps the window start', () => {
		const { allow, next } = evaluateReload(null, 1000);
		expect(allow).toBe(true);
		expect(next).toEqual({ count: 1, first: 1000 });
	});

	it('accumulates count across reloads within the window (does NOT reset)', () => {
		// This is the regression guard: each reload must SEE the prior budget.
		let budget = evaluateReload(null, 1000).next; // count 1
		budget = evaluateReload(budget, 1100).next; // count 2
		const third = evaluateReload(budget, 1200);
		expect(third.allow).toBe(true);
		expect(third.next).toEqual({ count: 3, first: 1000 });
	});

	it('stops reloading once the cap is hit within the window', () => {
		let budget: { count: number; first: number } | null = null;
		// Spend the full budget.
		for (let i = 0; i < RELOAD_MAX; i++) {
			const d = evaluateReload(budget, 1000 + i);
			expect(d.allow).toBe(true);
			budget = d.next;
		}
		// The next preloadError within the window must be refused — loop dies here.
		const over = evaluateReload(budget, 1000 + RELOAD_MAX);
		expect(over.allow).toBe(false);
		expect(over.next.count).toBe(RELOAD_MAX); // persists exhausted so repeats keep failing closed
	});

	it('refuses repeatedly while still inside the window after exhaustion', () => {
		const exhausted = { count: RELOAD_MAX, first: 1000 };
		const a = evaluateReload(exhausted, 1000 + RELOAD_WINDOW_MS - 1);
		const b = evaluateReload(a.next, 1000 + RELOAD_WINDOW_MS - 1);
		expect(a.allow).toBe(false);
		expect(b.allow).toBe(false);
	});

	it('starts a fresh window once the old one fully elapses', () => {
		// A long-running session that hits a LATER deploy must get a fresh budget.
		const exhausted = { count: RELOAD_MAX, first: 1000 };
		const later = evaluateReload(exhausted, 1000 + RELOAD_WINDOW_MS);
		expect(later.allow).toBe(true);
		expect(later.next).toEqual({ count: 1, first: 1000 + RELOAD_WINDOW_MS });
	});

	it('treats a corrupt/zeroed first timestamp as a fresh window', () => {
		const { allow, next } = evaluateReload({ count: 5, first: 0 }, 5000);
		expect(allow).toBe(true);
		expect(next).toEqual({ count: 1, first: 5000 });
	});

	it('respects custom window/max overrides', () => {
		const budget = { count: 1, first: 100 };
		// max=1 → already exhausted
		expect(evaluateReload(budget, 150, 1000, 1).allow).toBe(false);
		// wider need: max=2 within window → allowed
		expect(evaluateReload(budget, 150, 1000, 2).allow).toBe(true);
	});
});
