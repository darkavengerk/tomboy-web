import { describe, it, expect, beforeEach } from 'vitest';
import { spreadView } from '$lib/desktop/spreadView/spreadView.svelte.js';

beforeEach(() => spreadView.close());

describe('spreadView', () => {
	it('starts closed and toggles open/closed', () => {
		expect(spreadView.isOpen).toBe(false);
		spreadView.open();
		expect(spreadView.isOpen).toBe(true);
		spreadView.close();
		expect(spreadView.isOpen).toBe(false);
		spreadView.toggle();
		expect(spreadView.isOpen).toBe(true);
		spreadView.toggle();
		expect(spreadView.isOpen).toBe(false);
	});
});
