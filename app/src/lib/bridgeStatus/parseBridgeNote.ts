/**
 * `브릿지::` 대시보드 노트 인식.
 *
 * 음악추출/자동화처럼 제목 접두로 노트 타입을 가린다. 본문은 ⟳ 가 통째로
 * 다시 그리므로(스냅샷 교체) 항목 파싱은 없다 — 제목 판별만 있으면 된다.
 */
export const BRIDGE_TITLE_PREFIX = '브릿지::';

export function isBridgeTitle(titleText: string): boolean {
	return titleText.trimStart().startsWith(BRIDGE_TITLE_PREFIX);
}
