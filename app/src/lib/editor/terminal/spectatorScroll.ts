/**
 * 관전 모드 스크롤 상태 — xterm 버퍼 좌표로부터 freeze 패턴 UI를 구동한다.
 *
 * `viewportY` = 뷰포트 맨 위에 보이는 버퍼 줄 인덱스.
 * `baseY`     = 맨 아래까지 스크롤했을 때의 `viewportY` (= 스크롤백 줄 수).
 * 둘이 같으면(또는 viewportY가 더 크면) 라이브 맨 아래에 붙어 있는 상태.
 */
export interface SpectatorScrollState {
	/** 뷰포트가 라이브 맨 아래에 고정돼 있으면 true. */
	atBottom: boolean;
	/** 사용자가 맨 아래를 떠난 순간의 baseY 앵커. atBottom이면 null. */
	freezeBaseY: number | null;
	/** 맨 아래를 떠난 뒤 새로 도착한 줄 수. atBottom이면 0. */
	newLines: number;
}

export const INITIAL_SCROLL_STATE: SpectatorScrollState = {
	atBottom: true,
	freezeBaseY: null,
	newLines: 0
};

/**
 * 이전 상태 + 현재 버퍼 좌표로 다음 스크롤 상태를 계산한다. 순수 함수.
 * 스크롤 이벤트와 데이터 도착 양쪽에서 호출된다 — 전자는 viewportY를,
 * 후자는 baseY를 움직이므로 둘 다 새 상태를 만들 수 있다.
 */
export function computeScrollState(
	prev: SpectatorScrollState,
	viewportY: number,
	baseY: number
): SpectatorScrollState {
	if (viewportY >= baseY) {
		return { atBottom: true, freezeBaseY: null, newLines: 0 };
	}
	const freezeBaseY = prev.freezeBaseY ?? baseY;
	const newLines = Math.max(0, baseY - freezeBaseY);
	return { atBottom: false, freezeBaseY, newLines };
}

/**
 * 모바일 관전 모드의 터치 드래그를 xterm 줄 스크롤로 환산한다. 순수 함수.
 *
 * xterm v6 자체 터치 스크롤 제스처는 관전 모드의 `transform: scale` 안에서
 * 화면 픽셀↔버퍼 좌표가 어긋나 동작하지 않으므로, `TerminalView`가 터치
 * 델타를 직접 `term.scrollLines()`로 넘긴다 — 데스크탑 휠과 같은
 * 프로그래매틱 경로라 transform 의 영향을 받지 않는다.
 *
 * `term.scrollLines()`는 정수만 받으므로, 한 줄에 못 미치는 드래그가
 * 버려지지 않도록 소수 잔차를 누적해 다음 호출로 넘긴다. `0` 방향 절삭이라
 * 잔차 부호가 델타 부호와 일치 → 위/아래 드래그 모두 매끄럽게 이어진다.
 *
 * `pxPerLine` = 화면 픽셀 기준 한 줄 높이(스케일된 .xterm-stage 높이 /
 * term.rows). 0 이하(레이아웃 미확정)면 아무것도 하지 않는다.
 */
export function accumulateTouchScroll(
	remainder: number,
	deltaPx: number,
	pxPerLine: number
): { lines: number; remainder: number } {
	if (!(pxPerLine > 0)) return { lines: 0, remainder };
	const total = remainder + deltaPx / pxPerLine;
	const lines = Math.trunc(total);
	return { lines, remainder: total - lines };
}
