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

/** 한 줄(스트립)에 보일 탭 수 — 최소 1/4 너비 → 최대 4. 넘치면 +N. */
export const TAB_CAP = 4;

/** total 개 탭 중 몇 개를 보이고 +N 은 몇인지. CAP 초과면 (CAP-1)개 + 나머지. */
export function tabWindow(total: number): { shown: number; plus: number } {
	if (total <= TAB_CAP) return { shown: Math.max(0, total), plus: 0 };
	return { shown: TAB_CAP - 1, plus: total - (TAB_CAP - 1) };
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

function pathEndsAtLeaf(tree: NavNode[], path: number[]): boolean {
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

/** 가장 깊은(현재) 레벨에서 dir 방향 다음 navigable 형제로 이동 + drill.
 *  형제가 카테고리면 그 안 첫 잎까지 내려간다. 없으면 path 유지. */
export function stepPath(tree: NavNode[], path: number[], dir: 1 | -1): number[] {
	if (path.length === 0) return path;
	const d = path.length - 1;
	const nodes = nodesAtDepth(tree, path, d);
	if (!nodes) return path;
	let j = path[d] + dir;
	while (j >= 0 && j < nodes.length) {
		const drilled = drillFrom(nodes, j);
		if (drilled) return path.slice(0, d).concat(drilled);
		j += dir;
	}
	return path;
}

/** depth 레벨의 idx 탭을 선택(+drill). navigable 아니면 path 유지. */
export function pickPath(tree: NavNode[], path: number[], depth: number, idx: number): number[] {
	const nodes = nodesAtDepth(tree, path, depth);
	if (!nodes) return path;
	const drilled = drillFrom(nodes, idx);
	if (!drilled) return path;
	return path.slice(0, depth).concat(drilled);
}
