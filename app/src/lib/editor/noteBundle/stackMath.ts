/** 노트 묶음 스택 인덱스 계산 — 순수 함수. */
export const MAX_COLLAPSED_BARS = 4;

/** 접힌 바 윈도우 시작 — 펼침 k 위로 최대 4개 (총 타이틀 5개). */
export function collapsedBarStart(k: number): number {
	return Math.max(0, k - MAX_COLLAPSED_BARS);
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
