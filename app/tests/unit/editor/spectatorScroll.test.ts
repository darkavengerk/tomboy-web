import { describe, it, expect } from 'vitest';
import {
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
