import { describe, it, expect } from 'vitest';
import { formatHHMM } from '$lib/desktop/clock.svelte.js';

describe('formatHHMM', () => {
	it('formats hours and minutes zero-padded in 24-hour form', () => {
		expect(formatHHMM(new Date(2026, 6, 6, 9, 5))).toBe('09:05');
	});

	it('uses 24-hour hours past noon', () => {
		expect(formatHHMM(new Date(2026, 6, 6, 14, 30))).toBe('14:30');
	});

	it('renders midnight as 00:00', () => {
		expect(formatHHMM(new Date(2026, 6, 6, 0, 0))).toBe('00:00');
	});
});
