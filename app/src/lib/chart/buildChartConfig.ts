import type { ChartSpec, ChartType } from './chartSpec';
import type { ChartData } from './transformData';

const DEFAULT_PALETTE = [
	'#3b82f6',
	'#ef4444',
	'#10b981',
	'#f59e0b',
	'#8b5cf6',
	'#ec4899',
	'#14b8a6',
	'#f97316'
];

/** Map our ChartType to a Chart.js base type. */
function baseType(type: ChartType): 'bar' | 'line' | 'scatter' {
	if (type === 'area') return 'line';
	return type;
}

export interface ChartJsConfig {
	type: string;
	data: { labels: string[]; datasets: any[] };
	options: any;
}

export function buildChartConfig(spec: ChartSpec, data: ChartData): ChartJsConfig {
	const palette = spec.colors && spec.colors.length > 0 ? spec.colors : DEFAULT_PALETTE;

	const datasets = data.series.map((s, i) => {
		const color = palette[i % palette.length];
		const ds: any = {
			label: s.name,
			borderColor: color,
			backgroundColor: color
		};
		if (spec.type === 'scatter') {
			ds.data = s.values.map((y, idx) => {
				// Use the numeric label as x; fall back to the row index only when
				// the label isn't a finite number. (`|| idx` would wrongly treat
				// "0" as a fallback, since Number("0") === 0 is falsy.)
				const n = Number(data.labels[idx]);
				return { x: Number.isFinite(n) ? n : idx, y };
			});
			ds.pointRadius = spec.pointRadius ?? 4;
		} else {
			ds.data = s.values;
		}
		if (spec.type === 'area') ds.fill = true;
		if (spec.type === 'line' || spec.type === 'area') {
			ds.tension = spec.smooth ? 0.4 : 0;
			ds.pointRadius = spec.showPoints ? (spec.pointRadius ?? 3) : 0;
		}
		return ds;
	});

	const xScale: any = { stacked: spec.stacked };
	const yScale: any = { stacked: spec.stacked };
	if (spec.xAxisLabel) xScale.title = { display: true, text: spec.xAxisLabel };
	if (spec.yAxisLabel) yScale.title = { display: true, text: spec.yAxisLabel };
	if (spec.yMin !== undefined) yScale.min = spec.yMin;
	if (spec.yMax !== undefined) yScale.max = spec.yMax;

	// NOTE: showValues (data labels) requires the chartjs-plugin-datalabels plugin.
	// This is OUT OF SCOPE for v1. The parser accepts the token but the builder
	// intentionally ignores it. Add chartjs-plugin-datalabels in a follow-up task.

	return {
		type: baseType(spec.type),
		data: { labels: data.labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: spec.showLegend },
				title: { display: !!spec.title, text: spec.title }
			},
			scales: { x: xScale, y: yScale }
		}
	};
}
