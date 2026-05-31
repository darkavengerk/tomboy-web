import { describe, it, expect } from 'vitest';
import {
	accumulateTouchScroll,
	computeAnchorRows,
	computeScrollState,
	INITIAL_SCROLL_STATE,
	type BufferProbe,
	type SpectatorScrollState
} from '$lib/editor/terminal/spectatorScroll';

function makeProbe(rows: number, cursorY: number, lines: string[]): BufferProbe {
	return {
		rows,
		cursorY,
		isRowEmpty: (row: number) => (lines[row] ?? '').trim().length === 0
	};
}

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

describe('computeAnchorRows', () => {
	it('전부 빈 버퍼 + cursor at 0 → n = 1 (cursor 자리만)', () => {
		const probe = makeProbe(60, 0, []);
		expect(computeAnchorRows(probe)).toBe(1);
	});

	it('Ctrl+L 직후: row 0 에 프롬프트, 나머지 빈 칸 → n = 1', () => {
		const lines = ['$ ', ...Array(59).fill('')];
		const probe = makeProbe(60, 0, lines);
		expect(computeAnchorRows(probe)).toBe(1);
	});

	it('단일라인 프롬프트 ls 직후: 10줄 출력 + cursor at row 10 → n = 11', () => {
		const lines = [
			'$ ls',
			'a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt',
			'f.txt', 'g.txt', 'h.txt', 'i.txt',
			'$ ',
			...Array(49).fill('')
		];
		const probe = makeProbe(60, 10, lines);
		expect(computeAnchorRows(probe)).toBe(11);
	});

	it('다중라인 프롬프트 (p10k 류): row 0,1 프롬프트 프레임 + row 2 입력 줄 → n = 3', () => {
		const lines = ['╭─ user@host ~/proj', '╰─$ ', ...Array(58).fill('')];
		const probe = makeProbe(60, 2, lines);
		expect(computeAnchorRows(probe)).toBe(3);
	});

	it('cursor 위에 백그라운드 출력이 있는 경우: cursor at 2, 마지막 비어있지 않은 줄 = 5 → n = 6', () => {
		const lines = ['$ ', '', '> ', '', 'BG: ping1', 'BG: ping2', ...Array(54).fill('')];
		const probe = makeProbe(60, 2, lines);
		expect(computeAnchorRows(probe)).toBe(6);
	});

	it('cursor 가 마지막 행: n = rows', () => {
		const probe = makeProbe(60, 59, Array(60).fill('x'));
		expect(computeAnchorRows(probe)).toBe(60);
	});

	it('rows = 1 인 단일행 패널: n = 1', () => {
		const probe = makeProbe(1, 0, ['$ ']);
		expect(computeAnchorRows(probe)).toBe(1);
	});

	it('공백만 있는 줄은 비어있는 것으로 간주 (호출측 isRowEmpty 가 trim 후 판정)', () => {
		const lines = ['   ', '\t\t', ...Array(58).fill('')];
		const probe = makeProbe(60, 0, lines);
		expect(computeAnchorRows(probe)).toBe(1); // cursor+1=1, lastNonEmpty=-1 → max=1
	});
});
