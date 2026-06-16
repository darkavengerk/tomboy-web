/** 묶음(서류함) 스택 인덱스 계산 — 순수 함수. 가변 타이틀 윈도우. */

/** 기본 윈도우 폭(`묶음:N:M` 의 M 미지정 시). */
export const WINDOW_SIZE = 5;

/** 타이틀 윈도우 폭 = min(max, N). max 생략 시 기본 5(개수 옵션 `:M`). */
export function windowWidth(n: number, max: number = WINDOW_SIZE): number {
	return Math.min(Math.max(1, max), Math.max(0, n));
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

/** 폭 w 윈도우의 가운데 자리(0-기준). w=5 → 2(3번째). */
export function activeSlot(w: number): number {
	return Math.floor(w / 2);
}

/** 기본 폭(5)의 가운데 자리 — 하위호환 상수(3번째 = 2). */
export const ACTIVE_SLOT = activeSlot(WINDOW_SIZE);

/**
 * 활성 노트를 윈도우 가운데 자리(activeSlot)에 고정 — 스크롤 방향과 무관하게
 * 항상 가운데를 고수해 위·아래 맥락이 대칭으로 보인다. 단 양 끝([0, N-W])
 * 고정이 우선(맨 앞이면 앞쪽 자리, 맨 뒤면 마지막 자리). 점프·스텝·초기 마운트
 * 모두 이 한 함수로 — 직전 start 와 무관하게 active 만으로 결정된다.
 * max 로 윈도우 폭을 키우면(`:M`) 가운데 자리도 그에 맞춰 이동한다.
 */
export function centeredWindow(active: number, n: number, max: number = WINDOW_SIZE): number {
	const w = windowWidth(n, max);
	if (n <= w) return 0;
	return clamp(active - activeSlot(w), 0, n - w);
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
