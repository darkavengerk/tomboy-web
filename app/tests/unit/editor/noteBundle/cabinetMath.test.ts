import { describe, it, expect } from 'vitest';
import {
	WINDOW_SIZE,
	ACTIVE_SLOT,
	windowWidth,
	centeredWindow,
	firstValidIndex,
	nextValidIndex
} from '$lib/editor/noteBundle/cabinetMath.js';

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

describe('centeredWindow — 활성 3번째 자리 고수', () => {
	it('ACTIVE_SLOT = 2 (3번째)', () => {
		expect(ACTIVE_SLOT).toBe(2);
	});
	it('N ≤ W → 항상 0', () => {
		expect(centeredWindow(2, 4)).toBe(0);
		expect(centeredWindow(0, 5)).toBe(0);
		expect(centeredWindow(0, 1)).toBe(0);
	});
	it('가운데에선 active 가 윈도우 3번째(start = active-2)', () => {
		// N=10, W=5
		expect(centeredWindow(5, 10)).toBe(3); // [3..7], active 5 = 3번째
		expect(centeredWindow(4, 10)).toBe(2);
		expect(centeredWindow(3, 10)).toBe(1);
	});
	it('양 끝 고정이 우선', () => {
		expect(centeredWindow(0, 10)).toBe(0); // 맨 앞: 1번째 자리
		expect(centeredWindow(1, 10)).toBe(0); // 2번째 자리
		expect(centeredWindow(2, 10)).toBe(0); // 비로소 3번째
		expect(centeredWindow(9, 10)).toBe(5); // 맨 뒤: maxStart=5 로 클램프
		expect(centeredWindow(8, 10)).toBe(5);
	});
	it('방향 무관 — start 인자 없이 active 만으로 결정 (스크롤해도 3번째 고수)', () => {
		const down: number[] = [];
		for (let a = 0; a <= 9; a++) down.push(centeredWindow(a, 10));
		expect(down).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 5, 5]);
		// 올라갈 때도 동일 매핑(start 무관)
		const up = [...down].reverse().map((_, i) => centeredWindow(9 - i, 10));
		expect(up).toEqual([5, 5, 5, 4, 3, 2, 1, 0, 0, 0]);
	});
	it('broken 스킵 멀티 점프도 3번째 고수', () => {
		expect(centeredWindow(6, 10)).toBe(4); // [4..8], active 6 = 3번째
	});
});

describe('nextValidIndex / firstValidIndex', () => {
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
