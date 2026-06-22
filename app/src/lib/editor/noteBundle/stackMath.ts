/**
 * 묶음 탭 트리 내비게이션 — 순수 함수.
 *
 * 트리는 재귀 탭(파일철). path = 각 레벨에서 선택한 인덱스 배열, 항상
 * **navigable 잎**에서 끝난다. 카테고리(비-잎)는 그 자체로 노트를 열지
 * 않으므로 path 가 카테고리에서 끝나지 않게 drill 한다.
 */

/** 컴포넌트의 ResolvedNode 가 만족하는 최소 형태 */
export interface NavNode {
	/** 펼침 가능: 잎이면 링크 해석됨, 카테고리면 navigable 자손 존재 */
	navigable: boolean;
	/** 잎(노트) 여부. false = 카테고리 */
	isLeaf: boolean;
	children: NavNode[];
}

/** 기본 윈도우 폭 — 한 번에 보이는 탭 수. `탭:N:M` 의 M 으로 덮어쓴다(생략 시 3).
 *  win+1 개 이하면 전부 고정 표시(한 개만 가려질 상황엔 배지가 무의미). */
export const TAB_WINDOW = 3;
/** 기본 윈도우(3)에서 전부 고정 표시되는 최대 탭 수(= TAB_WINDOW + 1). 참고용 상수. */
export const TAB_FIT_MAX = 4;

export interface TabView {
	/** 첫 보이는 인덱스 */
	start: number;
	/** 보이는 탭 수 */
	count: number;
	/** 윈도우 앞(왼쪽)에 숨은 탭 수 — 좌측 +N 배지 */
	leftPlus: number;
	/** 윈도우 뒤(오른쪽)에 숨은 탭 수 — 우측 +N 배지 */
	rightPlus: number;
}

/**
 * 활성 탭 중심 윈도우. `win` = 한 번에 보일 탭 수(기본 TAB_WINDOW=3, `탭:N:M` 의 M).
 * - total ≤ win+1 : 전부 표시(고정). 스크롤해도 탭 불변, 활성 하이라이트만 이동.
 * - total ≥ win+2 : win 개만. 활성을 가운데 슬롯(floor(win/2))에 두려
 *   start=clamp(active-floor(win/2), 0, total-win). 처음/끝 탭이면 가운데 불가 →
 *   활성이 좌/우 끝. 숨은 수는 좌우 +N 배지. (묶음 cabinetMath 와 같은 가운데 원칙.)
 */
export function tabView(total: number, active: number, win: number = TAB_WINDOW): TabView {
	const w = Math.max(1, Math.round(win));
	if (total <= 0) return { start: 0, count: 0, leftPlus: 0, rightPlus: 0 };
	if (total <= w + 1) return { start: 0, count: total, leftPlus: 0, rightPlus: 0 };
	const a = clampIndex(total, active);
	const slot = Math.floor(w / 2); // 활성 슬롯 — 가운데 유지
	// start ∈ [0, total-w] — clampIndex(len, idx) 는 [0, len-1] 클램프.
	const start = clampIndex(total - w + 1, a - slot);
	return {
		start,
		count: w,
		leftPlus: start,
		rightPlus: total - (start + w)
	};
}

/** 주어진 깊이의 형제 노드 목록(path 따라 내려간). 범위 밖이면 null. */
export function nodesAtDepth<T extends NavNode>(tree: T[], path: number[], depth: number): T[] | null {
	let nodes = tree;
	for (let d = 0; d < depth; d++) {
		const n = nodes[path[d]];
		if (!n) return null;
		nodes = n.children as T[];
	}
	return nodes;
}

/** nodes 의 첫 navigable 잎까지의 인덱스 경로. 없으면 null. */
export function firstNavPath(nodes: NavNode[]): number[] | null {
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (!n.navigable) continue;
		if (n.isLeaf) return [i];
		const sub = firstNavPath(n.children);
		if (sub) return [i, ...sub];
	}
	return null;
}

/** nodes[idx] 에서 시작해 잎까지 drill 한 경로([idx, …]). idx 가 navigable 아니면 null. */
export function drillFrom(nodes: NavNode[], idx: number): number[] | null {
	const n = nodes[idx];
	if (!n || !n.navigable) return null;
	if (n.isLeaf) return [idx];
	const sub = firstNavPath(n.children);
	return sub ? [idx, ...sub] : null;
}

/** path 가 navigable 잎에서 끝나면 true(구조 변화 후 stale 경로 검증용). */
export function pathEndsAtLeaf(tree: NavNode[], path: number[]): boolean {
	if (path.length === 0) return false;
	let nodes = tree;
	for (let d = 0; d < path.length; d++) {
		const n = nodes[path[d]];
		if (!n || !n.navigable) return false;
		if (d === path.length - 1) return n.isLeaf;
		nodes = n.children;
	}
	return false;
}

/** path 가 여전히 navigable 잎을 가리키면 그대로, 아니면 첫 navigable 잎으로. */
export function repairPath(tree: NavNode[], path: number[]): number[] {
	if (pathEndsAtLeaf(tree, path)) return path;
	return firstNavPath(tree) ?? [];
}

/** 특정 깊이(strip)의 dir 방향 다음 navigable 형제로 이동 + drill.
 *  stepPath 와 달리 **부모로 버블하지 않고** 그 레벨 끝에서 그대로 멈춘다
 *  (path 유지) — 탭 줄 위 휠 내비게이션처럼 "이 스트립 안에서만" 넘길 때 쓴다.
 *  형제가 카테고리면 그 안 첫 잎까지 내려간다. */
export function stepPathAtDepth(tree: NavNode[], path: number[], depth: number, dir: 1 | -1): number[] {
	const nodes = nodesAtDepth(tree, path, depth);
	if (!nodes) return path;
	let j = (path[depth] ?? 0) + dir;
	while (j >= 0 && j < nodes.length) {
		const drilled = drillFrom(nodes, j);
		if (drilled) return path.slice(0, depth).concat(drilled);
		j += dir;
	}
	return path; // 이 레벨 끝 — 멈춤(버블 없음)
}

/** 가장 깊은(현재) 레벨에서 dir 방향 다음 navigable 형제로 이동 + drill.
 *  형제가 카테고리면 그 안 첫 잎까지 내려간다. 현재 레벨에서 더 갈 곳이
 *  없으면 부모 레벨로 **버블** — 카테고리 끝에서 스크롤하면 부모의 다음
 *  형제로 토스된다(스크롤이 자식에 갇히지 않게). 루트까지 막히면 path 유지. */
export function stepPath(tree: NavNode[], path: number[], dir: 1 | -1): number[] {
	for (let d = path.length - 1; d >= 0; d--) {
		const nodes = nodesAtDepth(tree, path, d);
		if (!nodes) continue;
		let j = path[d] + dir;
		while (j >= 0 && j < nodes.length) {
			const drilled = drillFrom(nodes, j);
			if (drilled) return path.slice(0, d).concat(drilled);
			j += dir;
		}
		// 이 레벨에서 못 감 → 부모 레벨로 버블(루프 계속)
	}
	return path;
}

/** activeIdx 를 [0, len-1] 로 보정(len=0 이면 0). */
export function clampIndex(len: number, idx: number): number {
	if (len <= 0) return 0;
	return Math.min(Math.max(0, idx), len - 1);
}

export interface VisibleTabs<T> {
	items: Array<{ node: T; idx: number }>;
	leftPlus: number;
	rightPlus: number;
}

/** 활성 중심 윈도우의 보이는 탭들 + 좌우 숨김 수. `win` = 윈도우 폭(기본 3,
 *  `탭:N:M` 의 M). activeIdx 가 범위 밖이어도 절대 undefined 노드를 만들지
 *  않는다(재귀 비활성 형제 보호 — tabView 가 clamp). */
export function visibleTabs<T>(nodes: T[], activeIdx: number, win: number = TAB_WINDOW): VisibleTabs<T> {
	const n = nodes.length;
	if (n === 0) return { items: [], leftPlus: 0, rightPlus: 0 };
	const v = tabView(n, activeIdx, win);
	const items: Array<{ node: T; idx: number }> = [];
	for (let i = v.start; i < v.start + v.count; i++) items.push({ node: nodes[i], idx: i });
	return { items, leftPlus: v.leftPlus, rightPlus: v.rightPlus };
}

/** depth 레벨의 idx 탭을 선택(+drill). navigable 아니면 path 유지. */
export function pickPath(tree: NavNode[], path: number[], depth: number, idx: number): number[] {
	const nodes = nodesAtDepth(tree, path, depth);
	if (!nodes) return path;
	const drilled = drillFrom(nodes, idx);
	if (!drilled) return path;
	return path.slice(0, depth).concat(drilled);
}
