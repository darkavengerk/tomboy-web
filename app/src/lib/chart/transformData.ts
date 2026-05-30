import type { AggMethod, ChartSpec } from './chartSpec';
import type { DataTable } from './parseDataNote';

export interface Series {
	name: string;
	values: number[];
}
export interface ChartData {
	labels: string[];
	series: Series[];
}

function colIndex(table: DataTable, name: string): number {
	const idx = table.columns.indexOf(name);
	if (idx < 0) throw new Error(`지정한 열 '${name}'을 데이터에서 찾을 수 없습니다`);
	return idx;
}

function toNum(cell: string): number {
	const n = Number(cell);
	return Number.isFinite(n) ? n : 0;
}

function sliceRange(rows: string[][], range: ChartSpec['range']): string[][] {
	if (range.kind === 'all' || !range.n || range.n <= 0) return rows;
	if (range.kind === 'last') return rows.slice(Math.max(0, rows.length - range.n));
	return rows.slice(0, range.n); // first
}

function aggregate(values: number[], method: AggMethod): number {
	if (values.length === 0) return 0;
	switch (method) {
		case 'sum':
			return values.reduce((a, b) => a + b, 0);
		case 'max':
			return Math.max(...values);
		case 'min':
			return Math.min(...values);
		case 'count':
			return values.length;
		case 'average':
		default:
			return values.reduce((a, b) => a + b, 0) / values.length;
	}
}

/** Split [0..len) into `count` contiguous, roughly-even bins; returns [start,end) pairs. */
function binRanges(len: number, count: number): Array<[number, number]> {
	const bins: Array<[number, number]> = [];
	for (let b = 0; b < count; b++) {
		const start = Math.floor((b * len) / count);
		const end = Math.floor(((b + 1) * len) / count);
		if (end > start) bins.push([start, end]);
	}
	return bins;
}

export function transformData(spec: ChartSpec, table: DataTable): ChartData {
	const xIdx = spec.xColumn ? colIndex(table, spec.xColumn) : 0;
	const yNames =
		spec.yColumns && spec.yColumns.length > 0
			? spec.yColumns
			: table.columns.filter((_, i) => i !== xIdx);
	const yIdxs = yNames.map((n) => colIndex(table, n));

	const rows = sliceRange(table.rows, spec.range);

	if (spec.bin && spec.bin.count > 0 && rows.length > spec.bin.count) {
		const bins = binRanges(rows.length, spec.bin.count);
		const labels = bins.map(([s]) => rows[s][xIdx]);
		const series: Series[] = yNames.map((name, k) => ({
			name,
			values: bins.map(([s, e]) =>
				aggregate(
					rows.slice(s, e).map((r) => toNum(r[yIdxs[k]])),
					spec.bin!.method
				)
			)
		}));
		return { labels, series };
	}

	const labels = rows.map((r) => r[xIdx]);
	const series: Series[] = yNames.map((name, k) => ({
		name,
		values: rows.map((r) => toNum(r[yIdxs[k]]))
	}));
	return { labels, series };
}
