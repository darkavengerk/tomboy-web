import type { ChartJsConfig } from './buildChartConfig';

// Chart.js instance type kept loose to avoid importing the heavy module eagerly.
export interface ChartHandle {
	destroy(): void;
}

/**
 * Mount a Chart.js chart into `container`. Chart.js is loaded on demand
 * (dynamic import) so it stays out of the main bundle — same pattern as geoMap.
 */
export async function mountChart(
	container: HTMLElement,
	config: ChartJsConfig,
	height: number
): Promise<ChartHandle | null> {
	container.innerHTML = '';
	container.style.height = `${height}px`;
	const canvas = document.createElement('canvas');
	container.appendChild(canvas);

	const { default: Chart } = await import('chart.js/auto');
	const chart = new Chart(canvas, config as never);
	return chart as unknown as ChartHandle;
}

export function destroyChart(handle: ChartHandle | null): void {
	if (handle) handle.destroy();
}

/** Render a red-toned inline error card with a Korean message. */
export function renderErrorCard(container: HTMLElement, message: string): void {
	container.innerHTML = '';
	container.style.removeProperty('height');
	const card = document.createElement('div');
	card.className = 'tomboy-chart-error';
	card.textContent = `⚠ ${message}`;
	container.appendChild(card);
}
