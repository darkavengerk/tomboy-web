import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';

// jsdom lacks ResizeObserver (used by the child SpreadScrollbar).
class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

// vi.mock is hoisted above all `const` declarations, so mocks that reference
// outer variables must use vi.hoisted() to avoid TDZ errors.
const { focusWindow, close } = vi.hoisted(() => ({
	focusWindow: vi.fn(),
	close: vi.fn()
}));

let fakeWindows: Array<{ guid: string; kind: string; x: number; y: number; width: number; height: number }> = [];
const sources: Record<string, { title: string; el: HTMLElement } | null> = {};

vi.mock('$lib/desktop/session.svelte.js', () => ({
	desktopSession: {
		get windows() {
			return fakeWindows;
		},
		getSnapshotSource: (g: string) => sources[g] ?? null,
		focusWindow
	}
}));
vi.mock('$lib/desktop/spreadView/spreadView.svelte.js', () => ({
	spreadView: {
		get isOpen() {
			return true;
		},
		open() {},
		close,
		toggle() {}
	}
}));

import SpreadOverlay from '$lib/desktop/spreadView/SpreadOverlay.svelte';

beforeEach(() => {
	focusWindow.mockClear();
	close.mockClear();
	const a = document.createElement('div');
	a.textContent = 'note one body';
	const b = document.createElement('div');
	b.textContent = 'note two body';
	sources['a'] = { title: 'Note A', el: a };
	sources['b'] = { title: 'Note B', el: b };
	fakeWindows = [
		{ guid: 'a', kind: 'note', x: 0, y: 0, width: 300, height: 200 },
		{ guid: 'b', kind: 'note', x: 0, y: 400, width: 300, height: 200 },
		{ guid: '__settings__', kind: 'settings', x: 0, y: 0, width: 400, height: 400 }
	];
});

describe('SpreadOverlay', () => {
	it('renders one card per note window (settings excluded) with title + cloned body', () => {
		const { getByText, queryByText } = render(SpreadOverlay);
		expect(getByText('Note A')).toBeInTheDocument();
		expect(getByText('Note B')).toBeInTheDocument();
		expect(getByText('note one body')).toBeInTheDocument();
		expect(getByText('note two body')).toBeInTheDocument();
		expect(queryByText('__settings__')).toBeNull();
	});

	it('clicking a card jumps to that window and closes the overlay', async () => {
		const { getByTitle } = render(SpreadOverlay);
		await fireEvent.click(getByTitle('Note A'));
		expect(focusWindow).toHaveBeenCalledWith('a');
		expect(close).toHaveBeenCalled();
	});

	it('Escape closes the overlay', async () => {
		render(SpreadOverlay);
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(close).toHaveBeenCalled();
	});
});
