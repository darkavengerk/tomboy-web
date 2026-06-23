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

/** 묶음 박스 높이/스크롤 모드. */
export type BundleBox =
	/** 전용 노트(`묶음::`) — 컨테이너를 flex 로 채우고 넘치면 내부 스크롤. */
	| 'dedicated'
	/** 앞 인자 100(`묶음:100[:M]`) — 호스트 노트 끝까지 고정 높이 + 넘치면 내부
	 *  스크롤. **개수(M)와 무관** — M=100 이어도 fit 이 우선(긴 목차 페이지 스크롤 X). */
	| 'fit'
	/** 타이틀만(앞<100) + 전부 표시 = 긴 목차 — 높이 auto, 페이지 스크롤. */
	| 'grow'
	/** 그 외 — 높이 % 고정 박스 + 활성 본문 내부 스크롤. */
	| 'window';

/**
 * 묶음 박스 모드 결정 — 순수. fit(앞=100)이 grow(개수 100·타이틀만)보다 우선해
 * `묶음:100:100` 이 페이지 스크롤로 새지 않고 고정+내부 스크롤이 된다.
 * @param heightPct 앞 인자(클램프됨: 0 타이틀만 / 100 fit / 20–90)
 * @param titleOnly heightPct<=0 || maxCount>=100 (본문 미로드 여부, 호출부 계산)
 * @param dedicated 전용 노트(`묶음::`) 여부
 */
export function bundleBox(heightPct: number, titleOnly: boolean, dedicated: boolean): BundleBox {
	if (dedicated) return 'dedicated';
	if (heightPct >= 100) return 'fit';
	if (titleOnly) return 'grow';
	return 'window';
}

/**
 * 고정 박스에 물리적으로 들어가는 바 수 — 순수. 요청 개수(`:M`)가 이보다 크면
 * 호출부가 실효 윈도우를 이만큼 깎아(`min(M, capacity)`) 못 들어간 바를 `.off`로
 * 접고 `+N` 배지 + 스와이프 브라우즈로 넘긴다(스크롤바 없이, 묶음 본연의 훑어보기).
 * @param boxPx 박스(스택) 안쪽 높이
 * @param barPx 바 1개 높이(border 포함). `<=0`(미측정) → `Infinity` = 클램프 안 함
 * @param reservePx 바 외 예약 높이(본문 모드의 활성 본문 최소; 타이틀만 0)
 */
export function barCapacity(boxPx: number, barPx: number, reservePx: number): number {
	if (barPx <= 0) return Infinity;
	return Math.max(1, Math.floor((boxPx - Math.max(0, reservePx)) / barPx));
}

/** 코드포인트 기준 길이 max 로 자르고, 넘치면 말줄임(…) 붙임. 한글 음절은
 *  단일 코드포인트라 글자 수 그대로 — Array.from 으로 서로게이트도 안전. */
export function truncateChars(s: string, max: number): string {
	const a = Array.from(s);
	return a.length > max ? a.slice(0, max).join('') + '…' : s;
}

/** 두 문자열의 공통 접두 길이(코드포인트 수). */
export function commonPrefixLen(a: string, b: string): number {
	const aa = Array.from(a);
	const bb = Array.from(b);
	let i = 0;
	while (i < aa.length && i < bb.length && aa[i] === bb[i]) i++;
	return i;
}

/**
 * +N 배지 대신 보여줄 숨은 타이틀들을 짧은 표시 문자열로 — 순수.
 * 첫 타이틀(anchor)은 그대로(firstMax 까지), 나머지는 첫 타이틀과 공통 접두를
 * 최대한 제거한 뒤 나머지를 restMax 까지. 예) ['음악::블랙핑크','음악::아이브']
 * → ['음악::블랙핑크','아이브'].
 * 접두 제거 후 빈 문자열이 되면(타이틀이 anchor 의 접두부와 동일) 원본 사용.
 * 공통 접두가 없으면 원본을 restMax 까지.
 */
export function collapseHiddenTitles(titles: string[], firstMax = 10, restMax = 5): string[] {
	if (titles.length === 0) return [];
	const anchor = titles[0];
	return titles.map((t, i) => {
		if (i === 0) return truncateChars(t, firstMax);
		const tc = Array.from(t);
		const n = commonPrefixLen(anchor, t);
		const rest = n > 0 && n < tc.length ? tc.slice(n).join('') : t;
		return truncateChars(rest, restMax);
	});
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
