import { describe, it, expect } from 'vitest';
import {
	collapsedBarStart,
	firstValidIndex,
	nextValidIndex
} from '$lib/editor/noteBundle/stackMath.js';

const e = (broken: boolean) => ({ broken });

describe('stackMath', () => {
	it('collapsedBarStart: k 위로 최대 4개', () => {
		expect(collapsedBarStart(0)).toBe(0);
		expect(collapsedBarStart(3)).toBe(0);
		expect(collapsedBarStart(4)).toBe(0);
		expect(collapsedBarStart(5)).toBe(1);
		expect(collapsedBarStart(9)).toBe(5);
	});

	it('nextValidIndex: broken 건너뜀, 끝이면 from 유지', () => {
		const entries = [e(false), e(true), e(false)];
		expect(nextValidIndex(entries, 0, 1)).toBe(2);
		expect(nextValidIndex(entries, 2, -1)).toBe(0);
		expect(nextValidIndex(entries, 2, 1)).toBe(2);
		expect(nextValidIndex(entries, 0, -1)).toBe(0);
	});

	it('firstValidIndex: 전부 broken 이면 -1', () => {
		expect(firstValidIndex([e(true), e(false)])).toBe(1);
		expect(firstValidIndex([e(true), e(true)])).toBe(-1);
		expect(firstValidIndex([])).toBe(-1);
	});
});
