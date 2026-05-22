import { describe, it, expect } from 'vitest';
import {
	accumulateTouchScroll,
	computeScrollState,
	INITIAL_SCROLL_STATE,
	type SpectatorScrollState
} from '$lib/editor/terminal/spectatorScroll';

describe('computeScrollState', () => {
	it('맨 아래(viewportY === baseY) — atBottom, newLines 0', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 100, 100);
		expect(s).toEqual({ atBottom: true, freezeBaseY: null, newLines: 0 });
	});

	it('viewportY > baseY 도 맨 아래로 간주(방어적)', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 120, 100);
		expect(s.atBottom).toBe(true);
	});

	it('스크롤업 첫 진입 — freezeBaseY를 현재 baseY로 앵커, newLines 0', () => {
		const s = computeScrollState(INITIAL_SCROLL_STATE, 40, 100);
		expect(s).toEqual({ atBottom: false, freezeBaseY: 100, newLines: 0 });
	});

	it('스크롤업 유지 중 baseY 증가 — newLines = baseY - freezeBaseY', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 0 };
		const s = computeScrollState(prev, 40, 137);
		expect(s).toEqual({ atBottom: false, freezeBaseY: 100, newLines: 37 });
	});

	it('스크롤업 상태에서 맨 아래 복귀 — INITIAL로 리셋', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 37 };
		const s = computeScrollState(prev, 137, 137);
		expect(s).toEqual(INITIAL_SCROLL_STATE);
	});

	it('freezeBaseY보다 baseY가 작아져도 newLines는 음수가 되지 않음', () => {
		const prev: SpectatorScrollState = { atBottom: false, freezeBaseY: 100, newLines: 0 };
		const s = computeScrollState(prev, 40, 90);
		expect(s.newLines).toBe(0);
	});
});

describe('accumulateTouchScroll', () => {
	it('정확히 나누어떨어지면 잔차 0', () => {
		const r = accumulateTouchScroll(0, 30, 10);
		expect(r.lines).toBe(3);
		expect(r.remainder).toBeCloseTo(0);
	});

	it('소수 부분은 잔차로 남는다', () => {
		const r = accumulateTouchScroll(0, 25, 10);
		expect(r.lines).toBe(2);
		expect(r.remainder).toBeCloseTo(0.5);
	});

	it('이전 잔차를 더해 다음 줄을 채운다', () => {
		const r = accumulateTouchScroll(0.5, 25, 10);
		expect(r.lines).toBe(3);
		expect(r.remainder).toBeCloseTo(0);
	});

	it('음수 델타(손가락 위로) — 0 방향으로 절삭, 잔차도 음수', () => {
		const r = accumulateTouchScroll(0, -25, 10);
		expect(r.lines).toBe(-2);
		expect(r.remainder).toBeCloseTo(-0.5);
	});

	it('한 줄 미만 드래그는 0줄, 잔차로 보존된다', () => {
		const r = accumulateTouchScroll(0, 4, 10);
		expect(r.lines).toBe(0);
		expect(r.remainder).toBeCloseTo(0.4);
	});

	it('pxPerLine 가 0 이하면 0줄, 잔차 그대로', () => {
		const r = accumulateTouchScroll(0.7, 50, 0);
		expect(r.lines).toBe(0);
		expect(r.remainder).toBe(0.7);
	});
});
