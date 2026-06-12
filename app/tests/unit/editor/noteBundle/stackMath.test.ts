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
	it('min(5, N)', () => {
		expect(WINDOW_SIZE).toBe(5);
		expect(windowWidth(0)).toBe(0);
		expect(windowWidth(3)).toBe(3);
		expect(windowWidth(5)).toBe(5);
		expect(windowWidth(12)).toBe(5);
	});
});

describe('clampWindow', () => {
	it('N ≤ W → 항상 0', () => {
		expect(clampWindow(3, 2, 4)).toBe(0);
		expect(clampWindow(0, 0, 5)).toBe(0);
		expect(clampWindow(0, 0, 1)).toBe(0);
	});
	it('활성 위치를 [1, W-2] 로 강제 (prev/next 가시)', () => {
		// N=10, W=5: start ∈ [active-3, active-1]
		expect(clampWindow(0, 7, 10)).toBe(4); // 점프: 아래로 당김
		expect(clampWindow(5, 2, 10)).toBe(1); // 점프: 위로 당김
		expect(clampWindow(2, 3, 10)).toBe(2); // 이미 유효 → 그대로 (최소 이동)
	});
	it('양 끝 고정이 우선', () => {
		expect(clampWindow(0, 0, 10)).toBe(0); // active=0: prev 없음
		expect(clampWindow(5, 9, 10)).toBe(5); // active=N-1: next 없음
		expect(clampWindow(9, 9, 10)).toBe(5); // maxStart=5 초과 클램프
	});
});

describe('stepWindow — eager 슬라이드 + 불변', () => {
	it('아래 연속 스크롤: 정상상태 active 위치 1 (위1/아래3)', () => {
		let start = 0;
		const seq: number[] = [];
		for (let a = 1; a <= 9; a++) {
			start = stepWindow(start, a, 1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5]);
	});
	it('위 연속 스크롤: 정상상태 active 위치 3 (위3/아래1)', () => {
		let start = 5;
		const seq: number[] = [];
		for (let a = 8; a >= 0; a--) {
			start = stepWindow(start, a, -1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([5, 4, 3, 2, 1, 0, 0, 0, 0]);
	});
	it('broken 스킵 멀티 점프도 불변 유지', () => {
		// active 2 → 6 (3,4,5 broken 스킵)
		expect(stepWindow(1, 6, 1, 10)).toBe(3); // [3..7]: prev 5 ✓ next 7 ✓
	});
});

describe('initialWindow — 활성 위 1개', () => {
	it('마운트 초기값', () => {
		expect(initialWindow(0, 10)).toBe(0);
		expect(initialWindow(4, 10)).toBe(3);
		expect(initialWindow(9, 10)).toBe(5);
		expect(initialWindow(2, 4)).toBe(0); // N<5
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
