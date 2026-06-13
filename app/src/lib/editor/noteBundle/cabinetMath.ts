/** 묶음(서류함) 스택 인덱스 계산 — 순수 함수. 5칸 타이틀 윈도우. */
export const WINDOW_SIZE = 5;

/** 타이틀 윈도우 폭 = min(5, N). */
export function windowWidth(n: number): number {
	return Math.min(WINDOW_SIZE, Math.max(0, n));
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

/** 활성 노트가 윈도우 안에서 고수할 자리(0-기준). 3번째 = 2 → 위·아래 2칸씩. */
export const ACTIVE_SLOT = 2;

/**
 * 활성 노트를 윈도우 ACTIVE_SLOT(3번째) 자리에 고정 — 스크롤 방향과 무관하게
 * 항상 가운데를 고수해 위·아래 맥락이 대칭으로 보인다. 단 양 끝([0, N-W])
 * 고정이 우선(맨 앞이면 1·2번째, 맨 뒤면 마지막 자리). 점프·스텝·초기 마운트
 * 모두 이 한 함수로 — 직전 start 와 무관하게 active 만으로 결정된다.
 */
export function centeredWindow(active: number, n: number): number {
	const w = windowWidth(n);
	if (n <= w) return 0;
	return clamp(active - ACTIVE_SLOT, 0, n - w);
}

export interface ResolvedEntryLike {
	broken: boolean;
}

/** dir 방향 가장 가까운 펼침 가능(비-broken) 인덱스. 없으면 from 유지. */
export function nextValidIndex(entries: ResolvedEntryLike[], from: number, dir: 1 | -1): number {
	let i = from + dir;
	while (i >= 0 && i < entries.length) {
		if (!entries[i].broken) return i;
		i += dir;
	}
	return from;
}

/** 첫 펼침 가능 인덱스. 없으면 -1. */
export function firstValidIndex(entries: ResolvedEntryLike[]): number {
	for (let i = 0; i < entries.length; i++) if (!entries[i].broken) return i;
	return -1;
}
