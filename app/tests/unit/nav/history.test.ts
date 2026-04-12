import { describe, it, expect } from 'vitest';
import { createHistoryTracker } from '$lib/nav/history';

describe('history tracker', () => {
	it('starts with canGoBack=false on first navigation', () => {
		const h = createHistoryTracker();
		h.onNavigate('enter');
		expect(h.canGoBack()).toBe(false);
		expect(h.canGoForward()).toBe(false);
	});

	it('enables back after a forward navigation', () => {
		const h = createHistoryTracker();
		h.onNavigate('enter');
		h.onNavigate('link');
		expect(h.canGoBack()).toBe(true);
	});

	it('enables forward after going back', () => {
		const h = createHistoryTracker();
		h.onNavigate('enter');
		h.onNavigate('link');
		h.goBack();
		expect(h.canGoForward()).toBe(true);
		expect(h.canGoBack()).toBe(false);
	});

	it('going forward restores back state', () => {
		const h = createHistoryTracker();
		h.onNavigate('enter');
		h.onNavigate('link');
		h.onNavigate('link');
		h.goBack();
		h.goBack();
		h.goForward();
		expect(h.canGoBack()).toBe(true);
		expect(h.canGoForward()).toBe(true);
	});

	it('popstate navigation does not push new depth', () => {
		const h = createHistoryTracker();
		h.onNavigate('enter');
		h.onNavigate('link');
		// popstate = going back via browser button; should not add new history entry
		h.onNavigate('popstate');
		expect(h.canGoBack()).toBe(false);
	});
});
