import { describe, it, expect } from 'vitest';
import { shouldRing } from '$lib/editor/terminal/terminalBell.js';

describe('shouldRing', () => {
	it('rings the first time (no previous bell)', () => {
		expect(shouldRing(null, 1000)).toBe(true);
	});

	it('suppresses a bell within the throttle window', () => {
		expect(shouldRing(1000, 1100)).toBe(false); // 100ms < 300ms
	});

	it('allows a bell at and after the throttle window', () => {
		expect(shouldRing(1000, 1300)).toBe(true); // exactly 300ms
		expect(shouldRing(1000, 1500)).toBe(true);
	});
});
