import { describe, it, expect } from 'vitest';
import {
	WINDOW_SIZE,
	ACTIVE_SLOT,
	activeSlot,
	windowWidth,
	centeredWindow,
	firstValidIndex,
	nextValidIndex,
	bundleBox
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

describe('가변 윈도우 폭 (개수 옵션 :M)', () => {
	it('windowWidth(N, max) = min(max, N)', () => {
		expect(windowWidth(20, 10)).toBe(10);
		expect(windowWidth(7, 10)).toBe(7); // N < max → N
		expect(windowWidth(50, 100)).toBe(50); // 전부(개수 100)
	});
	it('activeSlot = floor(w/2) — 가운데 자리', () => {
		expect(activeSlot(5)).toBe(2); // 기본 = ACTIVE_SLOT
		expect(activeSlot(5)).toBe(ACTIVE_SLOT);
		expect(activeSlot(10)).toBe(5);
		expect(activeSlot(1)).toBe(0);
	});
	it('centeredWindow 가 max 에 맞춰 가운데 고수', () => {
		// N=20, max=10 → w=10, slot=5
		expect(centeredWindow(7, 20, 10)).toBe(2); // active 7 = 6번째(slot 5)
		expect(centeredWindow(0, 20, 10)).toBe(0); // 맨 앞 고정
		expect(centeredWindow(19, 20, 10)).toBe(10); // 맨 뒤: maxStart = 20-10
	});
	it('개수 ≥ N(전부) → start 0, 윈도우 = N', () => {
		expect(centeredWindow(8, 12, 12)).toBe(0);
		expect(windowWidth(12, 12)).toBe(12);
	});
});

describe('bundleBox — 높이/스크롤 모드 (앞=100 fit 이 개수보다 우선)', () => {
	// 인자: (heightPct, titleOnly, dedicated)
	// titleOnly = heightPct<=0 || maxCount>=100 (호출부가 계산해 넘김)
	it('앞=100 → fit, 개수(뒤=100 으로 titleOnly)와 무관', () => {
		// 묶음:100:100 — 종전엔 개수 100 의 "긴 목차" 동작이 fit 을 덮어썼다.
		expect(bundleBox(100, true, false)).toBe('fit');
		// 묶음:100 (개수 기본 5 → titleOnly 아님)
		expect(bundleBox(100, false, false)).toBe('fit');
	});
	it('타이틀만 + 앞<100 → grow (긴 목차, 페이지 스크롤)', () => {
		expect(bundleBox(50, true, false)).toBe('grow'); // 묶음:50:100 / 묶음::100
		expect(bundleBox(0, true, false)).toBe('grow'); // 묶음:0
	});
	it('일반(앞<100, 본문 로드) → window', () => {
		expect(bundleBox(50, false, false)).toBe('window'); // 묶음:50
		expect(bundleBox(90, false, false)).toBe('window');
	});
	it('전용 노트 → dedicated, 높이/개수 무관(fit/grow 가 가로채지 않음)', () => {
		expect(bundleBox(100, true, true)).toBe('dedicated'); // :100:100
		expect(bundleBox(0, true, true)).toBe('dedicated'); // :0
		expect(bundleBox(50, false, true)).toBe('dedicated');
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
