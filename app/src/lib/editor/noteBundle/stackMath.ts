/** 묶음 스택 인덱스 계산 — 순수 함수. */
export const WINDOW_SIZE = 3;

/** 타이틀 윈도우 폭 = min(3, N). */
export function windowWidth(n: number): number {
	return Math.min(WINDOW_SIZE, Math.max(0, n));
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

/**
 * 불변 강제 클램프 — active 의 prev/next 가 윈도우 안에 들어오도록 start 를
 * 최소 이동. 활성 윈도우 내 위치 ∈ [1, W-2], 단 양 끝([0, N-W]) 고정이 우선.
 * W=3 에서는 위치가 항상 1(가운데) — active 위·아래 1개씩. 점프(바 탭 /
 * 외부 활성 변경 / 항목 수 변화)에 그대로 사용.
 */
export function clampWindow(start: number, active: number, n: number): number {
	const w = windowWidth(n);
	if (n <= w) return 0;
	const s = clamp(start, active - (w - 2), active - 1);
	return clamp(s, 0, n - w);
}

/**
 * 한 칸 이동: eager 슬라이드 1 + 불변 클램프.
 * W=3 에서는 active 가 늘 가운데로 클램프된다(위1/아래1). nextActive 가
 * broken 스킵으로 여러 칸 점프해도 클램프가 따라잡는다.
 */
export function stepWindow(start: number, nextActive: number, dir: 1 | -1, n: number): number {
	return clampWindow(start + dir, nextActive, n);
}

/** 마운트 초기 윈도우 — 활성 위 1개. */
export function initialWindow(active: number, n: number): number {
	return clamp(active - 1, 0, Math.max(0, n - windowWidth(n)));
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
