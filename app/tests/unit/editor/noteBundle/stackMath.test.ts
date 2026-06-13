import { describe, it, expect } from 'vitest';
import {
	WINDOW_SIZE,
	windowWidth,
	clampWindow,
	stepWindow,
	initialWindow,
	firstValidIndex,
	nextValidIndex
} from '$lib/editor/noteBundle/stackMath.js';

const e = (broken: boolean) => ({ broken });

describe('windowWidth', () => {
	it('min(3, N)', () => {
		expect(WINDOW_SIZE).toBe(3);
		expect(windowWidth(0)).toBe(0);
		expect(windowWidth(2)).toBe(2);
		expect(windowWidth(3)).toBe(3);
		expect(windowWidth(12)).toBe(3);
	});
});

describe('clampWindow', () => {
	it('N ≤ W → 항상 0', () => {
		expect(clampWindow(2, 1, 3)).toBe(0);
		expect(clampWindow(0, 0, 3)).toBe(0);
		expect(clampWindow(0, 0, 1)).toBe(0);
	});
	it('활성을 가운데(위치 1)로 강제 — W=3 → start = active-1', () => {
		// N=10, W=3
		expect(clampWindow(0, 7, 10)).toBe(6); // 점프: 아래로 당김
		expect(clampWindow(5, 2, 10)).toBe(1); // 점프: 위로 당김
		expect(clampWindow(2, 3, 10)).toBe(2); // 이미 유효 → 그대로
	});
	it('양 끝 고정이 우선', () => {
		expect(clampWindow(0, 0, 10)).toBe(0); // active=0: prev 없음
		expect(clampWindow(5, 9, 10)).toBe(7); // active=N-1: maxStart=N-W=7
		expect(clampWindow(9, 9, 10)).toBe(7); // maxStart 초과 클램프
	});
});

describe('stepWindow — 가운데 클램프', () => {
	it('아래 연속 스크롤: active 가운데(maxStart 7 에서 고정)', () => {
		let start = 0;
		const seq: number[] = [];
		for (let a = 1; a <= 9; a++) {
			start = stepWindow(start, a, 1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7]);
	});
	it('위 연속 스크롤: active 가운데(0 에서 고정)', () => {
		let start = 7;
		const seq: number[] = [];
		for (let a = 8; a >= 0; a--) {
			start = stepWindow(start, a, -1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 0]);
	});
	it('broken 스킵 멀티 점프도 가운데 유지', () => {
		// active 1 → 6 (broken 스킵). start = 6-1 = 5
		expect(stepWindow(1, 6, 1, 10)).toBe(5);
	});
});

describe('initialWindow — 활성 위 1개', () => {
	it('마운트 초기값', () => {
		expect(initialWindow(0, 10)).toBe(0);
		expect(initialWindow(4, 10)).toBe(3);
		expect(initialWindow(9, 10)).toBe(7); // maxStart=N-W=7
		expect(initialWindow(2, 4)).toBe(1); // N=4,W=3 → maxStart=1
	});
});

describe('nextValidIndex / firstValidIndex — v1 불변', () => {
	it('broken 건너뜀, 끝이면 from 유지', () => {
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
