import { describe, it, expect } from 'vitest';
import { applyResize, type ResizeDir } from '$lib/desktop/dragResize.js';

const base = { x: 100, y: 100, width: 400, height: 300 };
const MIN = { width: 200, height: 150 };

function run(dir: ResizeDir, dx: number, dy: number) {
	return applyResize(base, dir, dx, dy, MIN);
}

describe('applyResize — single-side handles', () => {
	it('east: grows width only', () => {
		expect(run('e', 50, 0)).toEqual({ x: 100, y: 100, width: 450, height: 300 });
	});
	it('east: shrinks width; clamps to min width', () => {
		expect(run('e', -300, 0)).toEqual({ x: 100, y: 100, width: 200, height: 300 });
	});
	it('south: grows height only', () => {
		expect(run('s', 0, 40)).toEqual({ x: 100, y: 100, width: 400, height: 340 });
	});
	it('south: clamps to min height', () => {
		expect(run('s', 0, -300)).toEqual({ x: 100, y: 100, width: 400, height: 150 });
	});
	it('west: shrinks width AND shifts x right', () => {
		expect(run('w', 50, 0)).toEqual({ x: 150, y: 100, width: 350, height: 300 });
	});
	it('west: growing (dx negative) moves x left and grows width', () => {
		expect(run('w', -30, 0)).toEqual({ x: 70, y: 100, width: 430, height: 300 });
	});
	it('west: min-width clamp keeps right edge stable', () => {
		// Asking to shrink by 500 — width would go below min. Right edge (x+w = 500) must stay.
		const out = run('w', 500, 0);
		expect(out.width).toBe(MIN.width);
		expect(out.x + out.width).toBe(base.x + base.width);
	});
	it('north: shrinks height AND shifts y down', () => {
		expect(run('n', 0, 50)).toEqual({ x: 100, y: 150, width: 400, height: 250 });
	});
	it('north: min-height clamp keeps bottom edge stable', () => {
		const out = run('n', 0, 500);
		expect(out.height).toBe(MIN.height);
		expect(out.y + out.height).toBe(base.y + base.height);
	});
});

describe('applyResize — corner handles', () => {
	it('se: bottom-right — grows width and height only', () => {
		expect(run('se', 30, 40)).toEqual({ x: 100, y: 100, width: 430, height: 340 });
	});
	it('ne: top-right — grows width, shrinks height, shifts y', () => {
		expect(run('ne', 30, 40)).toEqual({ x: 100, y: 140, width: 430, height: 260 });
	});
	it('sw: bottom-left — shrinks width, shifts x, grows height', () => {
		expect(run('sw', 30, 40)).toEqual({ x: 130, y: 100, width: 370, height: 340 });
	});
	it('nw: top-left — shrinks width and height; shifts both x and y', () => {
		expect(run('nw', 30, 40)).toEqual({ x: 130, y: 140, width: 370, height: 260 });
	});
	it('nw clamps both mins independently, keeping right and bottom edges stable', () => {
		const out = run('nw', 500, 500);
		expect(out.width).toBe(MIN.width);
		expect(out.height).toBe(MIN.height);
		expect(out.x + out.width).toBe(base.x + base.width);
		expect(out.y + out.height).toBe(base.y + base.height);
	});
});

describe('applyResize — identity', () => {
	it('zero delta returns the original geometry for every direction', () => {
		const dirs: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
		for (const d of dirs) {
			expect(applyResize(base, d, 0, 0, MIN)).toEqual(base);
		}
	});
});

describe('applyResize — ignores cross-axis deltas on side handles', () => {
	it('east: non-zero dy is ignored (no height change, no y shift)', () => {
		expect(run('e', 10, 99)).toEqual({ ...base, width: 410 });
	});
	it('south: non-zero dx is ignored (no width change, no x shift)', () => {
		expect(run('s', 99, 10)).toEqual({ ...base, height: 310 });
	});
});
