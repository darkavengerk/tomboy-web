import { describe, it, expect } from 'vitest';
import { transformData } from '../../../src/lib/chart/transformData';
import type { ChartSpec } from '../../../src/lib/chart/chartSpec';
import type { DataTable } from '../../../src/lib/chart/parseDataNote';

function baseSpec(over: Partial<ChartSpec> = {}): ChartSpec {
	return {
		type: 'bar',
		title: 't',
		checked: true,
		dataNoteTitle: 'DATA::d',
		range: { kind: 'all' },
		stacked: false,
		smooth: false,
		showPoints: false,
		showValues: false,
		showLegend: true,
		height: 240,
		...over
	};
}

const table: DataTable = {
	format: 'csv',
	columns: ['월', '매출', '비용'],
	rows: [
		['1월', '100', '40'],
		['2월', '200', '60'],
		['3월', '300', '90'],
		['4월', '400', '120']
	]
};

describe('transformData', () => {
	it('default mapping: first col = labels, rest = series', () => {
		const out = transformData(baseSpec(), table);
		expect(out.labels).toEqual(['1월', '2월', '3월', '4월']);
		expect(out.series).toEqual([
			{ name: '매출', values: [100, 200, 300, 400] },
			{ name: '비용', values: [40, 60, 90, 120] }
		]);
	});

	it('explicit y columns', () => {
		const out = transformData(baseSpec({ yColumns: ['비용'] }), table);
		expect(out.series).toEqual([{ name: '비용', values: [40, 60, 90, 120] }]);
	});

	it('range last:2', () => {
		const out = transformData(baseSpec({ range: { kind: 'last', n: 2 } }), table);
		expect(out.labels).toEqual(['3월', '4월']);
	});

	it('binning with average', () => {
		const out = transformData(baseSpec({ bin: { count: 2, method: 'average' } }), table);
		expect(out.labels).toEqual(['1월', '3월']); // first x of each bin
		expect(out.series[0].values).toEqual([150, 350]); // avg(100,200), avg(300,400)
	});

	it('binning with sum', () => {
		const out = transformData(baseSpec({ bin: { count: 2, method: 'sum' } }), table);
		expect(out.series[0].values).toEqual([300, 700]);
	});

	it('throws for unknown column', () => {
		expect(() => transformData(baseSpec({ yColumns: ['없음'] }), table)).toThrow(/없음/);
	});
});
