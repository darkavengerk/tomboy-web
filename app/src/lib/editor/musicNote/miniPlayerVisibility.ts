/**
 * 전역 미니 플레이어 가시성 순수 술어. 컴포넌트(라우트/세션 의존)와 분리해 단위 테스트.
 *
 * 공통 규칙: 활성 노트가 있고(큐>0) 그 노트를 "지금 보고 있지 않을" 때만 미니 플레이어를
 * 띄운다. 활성 노트를 보고 있으면 인-노트 MusicPlayerBar 가 풀 컨트롤이라 중복을 피한다.
 */

/** 모바일/일반 라우트: 현재 페이지 노트(=route param)가 활성 노트와 다를 때만 표시. */
export function miniPlayerVisible(
	activeGuid: string | null,
	queueLen: number,
	currentNoteGuid: string | null
): boolean {
	if (!activeGuid || queueLen <= 0) return false;
	return currentNoteGuid !== activeGuid;
}

/** 데스크탑 작업대: 활성 노트의 창이 현재 워크스페이스에 열려 있지 않을 때만 표시. */
export function desktopMiniPlayerVisible(
	activeGuid: string | null,
	queueLen: number,
	openGuids: ReadonlySet<string>
): boolean {
	if (!activeGuid || queueLen <= 0) return false;
	return !openGuids.has(activeGuid);
}
