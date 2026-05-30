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
 * 관전 모드 "하단 정렬" 레이아웃이 보여줄 행 수를 계산하기 위한 버퍼 추상화.
 * xterm 의 `term.buffer.active` 을 그대로 받지 않고, 필요한 좌표만 노출해
 * 단위테스트에서 mock 가능하게 한다.
 *
 * - `rows`: 패널 행 수 (= `term.rows`).
 * - `cursorY`: 뷰포트 기준 cursor 행 (0..rows-1).
 * - `isRowEmpty(row)`: 해당 행이 의미 있는 글리프가 없는지 (호출측이 trim 후 판정).
 */
export interface BufferProbe {
	rows: number;
	cursorY: number;
	isRowEmpty(row: number): boolean;
}

/**
 * 셸 모드 + 라이브 맨 아래 고정 상태일 때 stage 박스가 담아야 할 행 수 `n`.
 * 결과는 `max(cursorY + 1, lastNonEmptyRow + 1)` — cursor 위치(=활성 입력 줄)
 * 와 마지막 비어있지 않은 행 중 더 아래쪽이 기준.
 *
 * 두 값을 모두 보는 이유:
 * - 단일 라인 셸: cursor 가 곧 콘텐츠의 끝 → cursorY+1 로 충분.
 * - 다중 라인 프롬프트 (p10k, starship): 프롬프트 프레임이 cursor 위 행들에 있고
 *   cursor 는 입력 줄에 있음 → cursorY+1 이 위 프레임까지 커버.
 * - 백그라운드 출력이 셸 redraw 사이에 cursor 아래로 더 그려진 케이스 → lastNonEmpty+1
 *   가 그 출력까지 커버.
 *
 * 결과는 항상 ≥ 1 (cursor 가 어딘가에는 있으니 stage 가 0 줄로 줄어들면 안 됨).
 */
export function computeAnchorRows(probe: BufferProbe): number {
	let lastNonEmpty = -1;
	for (let i = probe.rows - 1; i >= 0; i--) {
		if (!probe.isRowEmpty(i)) {
			lastNonEmpty = i;
			break;
		}
	}
	return Math.max(probe.cursorY + 1, lastNonEmpty + 1, 1);
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
