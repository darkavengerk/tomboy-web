import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Toolbar from '$lib/editor/Toolbar.svelte';
import { modKeys } from '$lib/desktop/modKeys.svelte.js';

afterEach(() => {
	cleanup();
	// modKeys is a module-level singleton — reset between tests.
	if (modKeys.ctrlLocked) modKeys.toggleCtrlLock();
	if (modKeys.altLocked) modKeys.toggleAltLock();
});

/**
 * Returns the visible direct children of `.key-tray` in DOM order, each
 * mapped to a short tag for assertion convenience.
 */
function trayLayout(container: HTMLElement): string[] {
	const tray = container.querySelector('.key-tray');
	if (!tray) return [];
	return Array.from(tray.children).map((el) => {
		if (!(el instanceof HTMLElement)) return 'unknown';
		if (el.classList.contains('mod-toggle')) {
			const label = el.querySelector('.mod-label')?.textContent?.trim() ?? '';
			return `tog:${label}`;
		}
		if (el.classList.contains('key-row')) {
			return `row:${el.getAttribute('aria-label') ?? ''}`;
		}
		return el.tagName.toLowerCase();
	});
}

describe('Toolbar modifier tray order', () => {
	it('둘 다 off — Ctrl 토글, Alt 토글 순서', () => {
		const { container } = render(Toolbar, { editor: null });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'tog:Alt']);
	});

	it('Ctrl 잠금 — Ctrl 토글이 왼쪽, Ctrl 단축키가 오른쪽', () => {
		modKeys.toggleCtrlLock();
		const { container } = render(Toolbar, { editor: null });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'row:Ctrl 단축키']);
	});

	it('Alt 잠금 — Alt 토글이 왼쪽, Alt 단축키가 오른쪽', () => {
		modKeys.toggleAltLock();
		const { container } = render(Toolbar, { editor: null });
		expect(trayLayout(container)).toEqual(['tog:Alt', 'row:Alt 단축키']);
	});
});
