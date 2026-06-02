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
 * mapped to a short tag for assertion convenience. The tray always holds the
 * Ctrl/Alt toggles; the shortcut keys live in a separate `.key-drawer` row.
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
		return el.tagName.toLowerCase();
	});
}

describe('Toolbar modifier tray', () => {
	it('둘 다 off — 트레이엔 Ctrl·Alt 토글만, 단축키 행 없음', () => {
		const { container } = render(Toolbar, { editor: null });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'tog:Alt']);
		expect(container.querySelector('.key-drawer')).toBeNull();
	});

	it('Ctrl 잠금 — 토글은 트레이에 그대로, Ctrl 단축키 행이 별도로 표시', () => {
		modKeys.toggleCtrlLock();
		const { container } = render(Toolbar, { editor: null });
		// 토글은 잠금 여부와 무관하게 항상 트레이에 둘 다 남는다.
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'tog:Alt']);
		expect(
			container.querySelector('.key-drawer[aria-label="Ctrl 단축키"]')
		).not.toBeNull();
		// Alt 행은 나오지 않는다.
		expect(
			container.querySelector('.key-drawer[aria-label="Alt 단축키"]')
		).toBeNull();
	});

	it('Alt 잠금 — 토글은 트레이에 그대로, Alt 단축키 행이 별도로 표시', () => {
		modKeys.toggleAltLock();
		const { container } = render(Toolbar, { editor: null });
		expect(trayLayout(container)).toEqual(['tog:Ctrl', 'tog:Alt']);
		expect(
			container.querySelector('.key-drawer[aria-label="Alt 단축키"]')
		).not.toBeNull();
		expect(
			container.querySelector('.key-drawer[aria-label="Ctrl 단축키"]')
		).toBeNull();
	});

	it('Alt 잠금 — Alt 단축키 행 안에 ← ↑ ↓ → J P 6개 버튼이 순서대로', () => {
		modKeys.toggleAltLock();
		const { container } = render(Toolbar, { editor: null });
		const row = container.querySelector('.key-drawer[aria-label="Alt 단축키"]');
		expect(row).not.toBeNull();
		const labels = Array.from(row!.querySelectorAll('button')).map(
			(b) => b.textContent?.trim() ?? ''
		);
		expect(labels).toEqual(['←', '↑', '↓', '→', 'J', 'P']);
	});
});
