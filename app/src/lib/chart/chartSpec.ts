export type ChartType = 'bar' | 'line' | 'area' | 'scatter';
export type RangeKind = 'all' | 'last' | 'first';
export type AggMethod = 'average' | 'sum' | 'max' | 'min' | 'count';

export interface ChartSpec {
	type: ChartType;
	title: string;
	checked: boolean;
	dataNoteTitle: string;
	range: { kind: RangeKind; n?: number };
	xColumn?: string;
	yColumns?: string[];
	bin?: { count: number; method: AggMethod };
	stacked: boolean;
	smooth: boolean;
	showPoints: boolean;
	pointRadius?: number;
	colors?: string[];
	palette?: string;
	showLegend: boolean;
	showValues: boolean;
	xAxisLabel?: string;
	yAxisLabel?: string;
	yMin?: number;
	yMax?: number;
	height: number;
}

export const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'scatter'];
export const DEFAULT_HEIGHT = 240;
export const DATA_NOTE_PREFIX = 'DATA::';

/** Korean aggregation method label → AggMethod. */
export const AGG_METHODS: Record<string, AggMethod> = {
	평균: 'average',
	합계: 'sum',
	최대: 'max',
	최소: 'min',
	개수: 'count'
};

/** Matches the chart header line: [x] Chart:bar Some Title */
export const CHART_HEADER_RE = /^\[([ xX])\]\s*Chart:(\w+)\s+(.+)$/;

export function isChartType(s: string): s is ChartType {
	return (CHART_TYPES as string[]).includes(s);
}
