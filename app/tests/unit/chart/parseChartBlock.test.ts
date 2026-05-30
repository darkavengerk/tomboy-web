import { describe, it, expect } from 'vitest';
import { parseChartHeader, parseChartBlock } from '../../../src/lib/chart/parseChartBlock';

describe('parseChartHeader', () => {
	it('parses type, title, checked', () => {
		expect(parseChartHeader('[x] Chart:bar 월별 매출')).toEqual({
			type: 'bar',
			title: '월별 매출',
			checked: true
		});
	});
	it('unchecked + line type', () => {
		expect(parseChartHeader('[ ]Chart:line 추세')).toEqual({
			type: 'line',
			title: '추세',
			checked: false
		});
	});
	it('returns null for non-chart line', () => {
		expect(parseChartHeader('그냥 텍스트')).toBeNull();
	});
	it('returns null for unknown type', () => {
		expect(parseChartHeader('[x]Chart:pie 비율')).toBeNull();
	});
});

describe('parseChartBlock', () => {
	const header = '[x] Chart:bar 월별 매출';
	it('extracts data note title and defaults', () => {
		const spec = parseChartBlock(header, ['DATA::월별 매출 데이터'])!;
		expect(spec.dataNoteTitle).toBe('DATA::월별 매출 데이터');
		expect(spec.range).toEqual({ kind: 'all' });
		expect(spec.stacked).toBe(false);
		expect(spec.showLegend).toBe(true);
		expect(spec.height).toBe(240);
	});
	it('picks checked range option', () => {
		const spec = parseChartBlock(header, ['DATA::d', '[ ]last:15, [x]all'])!;
		expect(spec.range).toEqual({ kind: 'all' });
		const spec2 = parseChartBlock(header, ['DATA::d', '[x]last:15, [ ]all'])!;
		expect(spec2.range).toEqual({ kind: 'last', n: 15 });
	});
	it('parses binning, columns, toggles, axis options', () => {
		const spec = parseChartBlock(header, [
			'DATA::d',
			'x:월',
			'y:매출, 비용',
			'묶기:30',
			'방식:평균',
			'[x]stacked',
			'[x]곡선, [x]점표시',
			'점크기:5',
			'색상:#3b82f6, #ef4444',
			'[x]범례, [x]값표시',
			'x축:월, y축:금액',
			'y최소:0, y최대:1000',
			'높이:300',
			'범위'
		])!;
		expect(spec.xColumn).toBe('월');
		expect(spec.yColumns).toEqual(['매출', '비용']);
		expect(spec.bin).toEqual({ count: 30, method: 'average' });
		expect(spec.stacked).toBe(true);
		expect(spec.smooth).toBe(true);
		expect(spec.showPoints).toBe(true);
		expect(spec.pointRadius).toBe(5);
		expect(spec.colors).toEqual(['#3b82f6', '#ef4444']);
		expect(spec.showValues).toBe(true);
		expect(spec.xAxisLabel).toBe('월');
		expect(spec.yAxisLabel).toBe('금액');
		expect(spec.yMin).toBe(0);
		expect(spec.yMax).toBe(1000);
		expect(spec.height).toBe(300);
	});
	it('keeps comma-joined Hangul-keyed tokens separate', () => {
		// Two Korean-only keys on one comma-separated line must both be parsed.
		const spec = parseChartBlock(header, ['DATA::d', '묶기:30, 방식:합계'])!;
		expect(spec.bin).toEqual({ count: 30, method: 'sum' });
	});

	it('keeps a comma-separated value inside one key together', () => {
		const spec = parseChartBlock(header, ['DATA::d', '색상:#3b82f6, #ef4444'])!;
		expect(spec.colors).toEqual(['#3b82f6', '#ef4444']);
	});

	it('returns null when header invalid', () => {
		expect(parseChartBlock('nope', ['DATA::d'])).toBeNull();
	});
});
