import { describe, it, expect } from 'vitest';
import { modeFromUrl } from '$lib/stores/appMode.svelte.js';

const params = (s = '') => new URLSearchParams(s);

describe('modeFromUrl — calendar', () => {
	it('maps /calendar to calendar mode', () => {
		expect(modeFromUrl('/calendar', params())).toBe('calendar');
	});

	it('keeps calendar highlighted for a note opened from the calendar', () => {
		expect(modeFromUrl('/note/abc', params('from=calendar'))).toBe('calendar');
	});

	it('still maps the other primary routes', () => {
		expect(modeFromUrl('/', params())).toBe('home');
		expect(modeFromUrl('/sleepnote', params())).toBe('sleepnote');
		expect(modeFromUrl('/notes', params())).toBe('notes');
	});
});
