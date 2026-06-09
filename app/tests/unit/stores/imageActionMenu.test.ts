import { describe, it, expect, beforeEach } from 'vitest';
import { imageActionMenu } from '$lib/stores/imageActionMenu.svelte.js';

describe('imageActionMenu store', () => {
	beforeEach(() => {
		imageActionMenu.close();
	});

	it('starts closed', () => {
		expect(imageActionMenu.state).toBeNull();
	});

	it('open() stores position and href', () => {
		imageActionMenu.open(12, 34, 'https://example.com/a.png');
		expect(imageActionMenu.state).toEqual({ x: 12, y: 34, href: 'https://example.com/a.png' });
	});

	it('close() clears state', () => {
		imageActionMenu.open(1, 2, 'https://x/y.png');
		imageActionMenu.close();
		expect(imageActionMenu.state).toBeNull();
	});

	it('a second open() replaces the previous', () => {
		imageActionMenu.open(1, 2, 'https://x/a.png');
		imageActionMenu.open(5, 6, 'https://x/b.png');
		expect(imageActionMenu.state).toEqual({ x: 5, y: 6, href: 'https://x/b.png' });
	});
});
