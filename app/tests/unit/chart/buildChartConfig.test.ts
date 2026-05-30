import { describe, it, expect } from 'vitest';
import { buildChartConfig } from '../../../src/lib/chart/buildChartConfig';
import type { ChartSpec } from '../../../src/lib/chart/chartSpec';
import type { ChartData } from '../../../src/lib/chart/transformData';

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
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
const data: ChartData = {
	labels: ['1월', '2월'],
	series: [{ name: '매출', values: [100, 200] }]
};

describe('buildChartConfig', () => {
	it('bar config with labels and datasets', () => {
		const cfg = buildChartConfig(spec(), data);
		expect(cfg.type).toBe('bar');
		expect(cfg.data.labels).toEqual(['1월', '2월']);
		expect(cfg.data.datasets[0].label).toBe('매출');
		expect(cfg.data.datasets[0].data).toEqual([100, 200]);
	});

	it('area = line + fill', () => {
		const cfg = buildChartConfig(spec({ type: 'area' }), data);
		expect(cfg.type).toBe('line');
		expect(cfg.data.datasets[0].fill).toBe(true);
	});

	it('scatter uses {x,y} points', () => {
		const cfg = buildChartConfig(spec({ type: 'scatter' }), {
			labels: ['1', '2'],
			series: [{ name: 's', values: [10, 20] }]
		});
		expect(cfg.type).toBe('scatter');
		expect(cfg.data.datasets[0].data).toEqual([
			{ x: 1, y: 10 },
			{ x: 2, y: 20 }
		]);
	});

	it('stacked sets scale stacking', () => {
		const cfg = buildChartConfig(spec({ stacked: true }), data);
		expect(cfg.options.scales.x.stacked).toBe(true);
		expect(cfg.options.scales.y.stacked).toBe(true);
	});

	it('axis labels, range, legend', () => {
		const cfg = buildChartConfig(
			spec({ xAxisLabel: '월', yAxisLabel: '금액', yMin: 0, yMax: 500, showLegend: false }),
			data
		);
		expect(cfg.options.scales.x.title).toMatchObject({ display: true, text: '월' });
		expect(cfg.options.scales.y.min).toBe(0);
		expect(cfg.options.scales.y.max).toBe(500);
		expect(cfg.options.plugins.legend.display).toBe(false);
	});

	it('custom colors applied', () => {
		const cfg = buildChartConfig(spec({ colors: ['#abc'] }), data);
		expect(cfg.data.datasets[0].backgroundColor).toBe('#abc');
	});
});
