import { describe, it, expect } from 'vitest';
import {
	TAB_FIT_MAX,
	TAB_WINDOW,
	tabView,
	visibleTabs,
	nodesAtDepth,
	firstNavPath,
	drillFrom,
	repairPath,
	stepPath,
	pickPath,
	clampIndex,
	type NavNode
} from '$lib/editor/noteBundle/stackMath.js';

const lf = (navigable = true): NavNode => ({ navigable, isLeaf: true, children: [] });
const cat = (children: NavNode[]): NavNode => ({
	navigable: children.some((c) => c.navigable),
	isLeaf: false,
	children
});

describe('tabView — 활성 중심 윈도우', () => {
	it('상수', () => {
		expect(TAB_FIT_MAX).toBe(4);
		expect(TAB_WINDOW).toBe(3);
	});
	it('4개 이하 → 전부 표시(고정), 배지 없음', () => {
		expect(tabView(0, 0)).toEqual({ start: 0, count: 0, leftPlus: 0, rightPlus: 0 });
		expect(tabView(1, 0)).toEqual({ start: 0, count: 1, leftPlus: 0, rightPlus: 0 });
		expect(tabView(4, 0)).toEqual({ start: 0, count: 4, leftPlus: 0, rightPlus: 0 });
		expect(tabView(4, 3)).toEqual({ start: 0, count: 4, leftPlus: 0, rightPlus: 0 });
	});
	it('5개 이상 → 3개 윈도우, 활성 가운데(2번째), 처음/끝 예외', () => {
		expect(tabView(5, 0)).toEqual({ start: 0, count: 3, leftPlus: 0, rightPlus: 2 }); // 처음 탭
		expect(tabView(5, 1)).toEqual({ start: 0, count: 3, leftPlus: 0, rightPlus: 2 }); // 가운데
		expect(tabView(5, 2)).toEqual({ start: 1, count: 3, leftPlus: 1, rightPlus: 1 });
		expect(tabView(5, 3)).toEqual({ start: 2, count: 3, leftPlus: 2, rightPlus: 0 });
		expect(tabView(5, 4)).toEqual({ start: 2, count: 3, leftPlus: 2, rightPlus: 0 }); // 끝 탭
		// n=7 가운데
		expect(tabView(7, 3)).toEqual({ start: 2, count: 3, leftPlus: 2, rightPlus: 2 });
	});
	it('범위 밖 활성 인덱스 clamp', () => {
		expect(tabView(6, -3)).toEqual({ start: 0, count: 3, leftPlus: 0, rightPlus: 3 });
		expect(tabView(6, 99)).toEqual({ start: 3, count: 3, leftPlus: 3, rightPlus: 0 });
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
	});
	it('카테고리 끝에서 막히면 부모로 버블 — 다음 형제 잎으로 토스', () => {
		const t = [cat([lf(), lf()]), lf()];
		// [0,1] = cat 마지막 자식, 더 못 감 → 부모(루트) 다음 형제 lf(1)
		expect(stepPath(t, [0, 1], 1)).toEqual([1]);
		// 역방향: cat 첫 자식 [0,0] 에서 뒤로 → 부모도 못 감 → 유지
		expect(stepPath(t, [0, 0], -1)).toEqual([0, 0]);
	});
	it('뒤로 버블 — 카테고리 앞 형제로 토스', () => {
		const t = [lf(), cat([lf(), lf()])];
		// [1,0] 에서 뒤로 → cat 내부 못 감 → 부모 이전 형제 lf(0)
		expect(stepPath(t, [1, 0], -1)).toEqual([0]);
		// cat 마지막 [1,1] 앞으로 → 부모도 막힘 → 유지
		expect(stepPath(t, [1, 1], 1)).toEqual([1, 1]);
	});
	it('3중 중첩에서 가장 안쪽 끝 → 루트 형제로 버블', () => {
		// 루트: [ catA[ catB[l, l] ], leaf ]
		const t = [cat([cat([lf(), lf()])]), lf()];
		// [0,0,1] = catB 마지막 → catB·catA 못 감 → 루트 형제 leaf(1)
		expect(stepPath(t, [0, 0, 1], 1)).toEqual([1]);
	});
});

describe('clampIndex / visibleTabs — 범위 밖 인덱스도 undefined 노드 없음', () => {
	it('clampIndex 경계', () => {
		expect(clampIndex(0, 5)).toBe(0);
		expect(clampIndex(3, -2)).toBe(0);
		expect(clampIndex(3, 9)).toBe(2);
		expect(clampIndex(3, 1)).toBe(1);
	});
	it('4개 이하 → 전부, 배지 0', () => {
		const ns = ['a', 'b', 'c'];
		expect(visibleTabs(ns, 1)).toEqual({
			items: [
				{ node: 'a', idx: 0 },
				{ node: 'b', idx: 1 },
				{ node: 'c', idx: 2 }
			],
			leftPlus: 0,
			rightPlus: 0
		});
	});
	it('5개 이상 → 3개 윈도우 + 좌우 배지', () => {
		const ns = ['a', 'b', 'c', 'd', 'e'];
		expect(visibleTabs(ns, 2)).toEqual({
			items: [
				{ node: 'b', idx: 1 },
				{ node: 'c', idx: 2 },
				{ node: 'd', idx: 3 }
			],
			leftPlus: 1,
			rightPlus: 1
		});
	});
	it('재귀 비활성 형제 재현: activeIdx 가 자식 수보다 크면 undefined 노드 안 생김', () => {
		const ns = ['a', 'b']; // 활성 인덱스 5
		const v = visibleTabs(ns, 5);
		expect(v.items.every((it) => it.node !== undefined)).toBe(true);
		expect(v).toEqual({
			items: [
				{ node: 'a', idx: 0 },
				{ node: 'b', idx: 1 }
			],
			leftPlus: 0,
			rightPlus: 0
		});
	});
	it('빈 노드', () => {
		expect(visibleTabs([], 0)).toEqual({ items: [], leftPlus: 0, rightPlus: 0 });
		expect(visibleTabs([], 3)).toEqual({ items: [], leftPlus: 0, rightPlus: 0 });
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
