import { describe, it, expect } from 'vitest';
import {
	TAB_CAP,
	tabWindow,
	nodesAtDepth,
	firstNavPath,
	drillFrom,
	repairPath,
	stepPath,
	pickPath,
	type NavNode
} from '$lib/editor/noteBundle/stackMath.js';

const lf = (navigable = true): NavNode => ({ navigable, isLeaf: true, children: [] });
const cat = (children: NavNode[]): NavNode => ({
	navigable: children.some((c) => c.navigable),
	isLeaf: false,
	children
});

describe('tabWindow', () => {
	it('CAP=4 이하면 전부, 초과면 (CAP-1)개 + 나머지', () => {
		expect(TAB_CAP).toBe(4);
		expect(tabWindow(0)).toEqual({ shown: 0, plus: 0 });
		expect(tabWindow(4)).toEqual({ shown: 4, plus: 0 });
		expect(tabWindow(5)).toEqual({ shown: 3, plus: 2 });
		expect(tabWindow(7)).toEqual({ shown: 3, plus: 4 });
	});
});

describe('firstNavPath', () => {
	it('첫 navigable 잎 경로, broken 스킵', () => {
		expect(firstNavPath([lf(), lf()])).toEqual([0]);
		expect(firstNavPath([lf(false), lf()])).toEqual([1]);
		expect(firstNavPath([lf(false), lf(false)])).toBeNull();
		expect(firstNavPath([])).toBeNull();
	});
	it('카테고리 안으로 drill', () => {
		expect(firstNavPath([cat([lf(false), lf()]), lf()])).toEqual([0, 1]);
		// 카테고리 전부 broken → 스킵 후 다음 잎
		expect(firstNavPath([cat([lf(false)]), lf()])).toEqual([1]);
	});
});

describe('drillFrom', () => {
	it('잎이면 [idx], 카테고리면 첫 잎까지, 비navigable 이면 null', () => {
		expect(drillFrom([lf(), lf()], 1)).toEqual([1]);
		expect(drillFrom([cat([lf(false), lf()])], 0)).toEqual([0, 1]);
		expect(drillFrom([lf(false)], 0)).toBeNull();
	});
});

describe('nodesAtDepth', () => {
	it('path 따라 깊이별 형제 목록', () => {
		const t = [lf(), cat([lf(), lf()])];
		expect(nodesAtDepth(t, [1, 0], 0)).toBe(t);
		expect(nodesAtDepth(t, [1, 0], 1)).toBe(t[1].children);
	});
});

describe('repairPath', () => {
	const t = [lf(), cat([lf(), lf()])];
	it('navigable 잎 가리키면 그대로', () => {
		const p = [1, 0];
		expect(repairPath(t, p)).toBe(p);
	});
	it('카테고리에서 끝나면(잎 아님) 첫 잎으로 보정', () => {
		expect(repairPath(t, [1])).toEqual([0]);
	});
	it('범위 밖이면 첫 잎으로', () => {
		expect(repairPath(t, [9])).toEqual([0]);
		expect(repairPath(t, [])).toEqual([0]);
	});
});

describe('stepPath — 가장 깊은 레벨 이동', () => {
	it('형제 잎 이동, 끝이면 유지', () => {
		const t = [lf(), lf(), lf()];
		expect(stepPath(t, [0], 1)).toEqual([1]);
		expect(stepPath(t, [2], 1)).toEqual([2]);
		expect(stepPath(t, [1], -1)).toEqual([0]);
	});
	it('비navigable 형제 스킵', () => {
		const t = [lf(), lf(false), lf()];
		expect(stepPath(t, [0], 1)).toEqual([2]);
	});
	it('형제 카테고리로 이동하면 drill', () => {
		const t = [lf(), cat([lf(), lf()])];
		expect(stepPath(t, [0], 1)).toEqual([1, 0]);
	});
	it('카테고리 내부에서 이동(루트는 안 건드림)', () => {
		const t = [lf(), cat([lf(), lf()])];
		expect(stepPath(t, [1, 0], 1)).toEqual([1, 1]);
		expect(stepPath(t, [1, 1], 1)).toEqual([1, 1]); // 끝
	});
});

describe('pickPath — depth 레벨 탭 선택 + drill', () => {
	const t = [lf(), cat([lf(), lf()]), lf()];
	it('잎 선택', () => {
		expect(pickPath(t, [0], 0, 2)).toEqual([2]);
	});
	it('카테고리 선택 → 첫 잎까지 drill', () => {
		expect(pickPath(t, [0], 0, 1)).toEqual([1, 0]);
	});
	it('하위에서 루트 다른 탭 선택(depth 0)', () => {
		expect(pickPath(t, [1, 0], 0, 2)).toEqual([2]);
	});
	it('비navigable 선택은 path 유지', () => {
		const t2 = [lf(), cat([lf(false)])];
		expect(pickPath(t2, [0], 0, 1)).toEqual([0]);
	});
});
