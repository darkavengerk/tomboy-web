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
		return INITIAL_SCROLL_STATE;
	}
	const freezeBaseY = prev.freezeBaseY ?? baseY;
	const newLines = Math.max(0, baseY - freezeBaseY);
	return { atBottom: false, freezeBaseY, newLines };
}
