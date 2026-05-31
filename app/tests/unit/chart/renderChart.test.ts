import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderErrorCard } from '../../../src/lib/chart/renderChart';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('renderErrorCard', () => {
	it('renders the error card from the container ownerDocument', () => {
		const container = document.createElement('div');
		renderErrorCard(container, '오류');
		const card = container.firstElementChild as HTMLElement;
		expect(card?.className).toBe('tomboy-chart-error');
		expect(card?.textContent).toBe('⚠ 오류');
	});

	// Reproduces the chart-plugin flake: the widget's detached async render can
	// resolve AFTER vitest has torn down the jsdom environment, so the global
	// `document` is gone by the time the catch path calls renderErrorCard.
	// Using the container's own ownerDocument (which still exists) avoids the
	// `document is not defined` unhandled rejection.
	it('survives when the global document has been torn down', () => {
		const container = document.createElement('div'); // created while document exists
		vi.stubGlobal('document', undefined);
		expect(() => renderErrorCard(container, '늦은 오류')).not.toThrow();
		const card = container.firstElementChild as HTMLElement;
		expect(card?.className).toBe('tomboy-chart-error');
		expect(card?.textContent).toBe('⚠ 늦은 오류');
	});
});
