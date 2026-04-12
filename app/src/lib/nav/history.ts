/**
 * 앱 내 네비게이션 깊이를 추적하는 경량 헬퍼.
 *
 * 브라우저 history.length 는 동일 origin 다른 탭 방문까지 포함하므로 신뢰 불가.
 * 대신 앱이 시작된 시점을 depth=0 기준으로, 상대적인 깊이 변화만 추적한다.
 *
 * SvelteKit afterNavigate({ type }) 의 type 값:
 *   'enter'   — 앱 최초 진입(direct URL, 새 탭)
 *   'link'    — <a> 클릭
 *   'goto'    — goto() 호출
 *   'form'    — form submit
 *   'popstate'— 브라우저 뒤/앞으로 버튼(히스토리 스택 이동, 새 진입 아님)
 */
export interface HistoryTracker {
	/** SvelteKit afterNavigate type 을 전달해 상태를 갱신한다 */
	onNavigate(type: string): void;
	/** history.back() 을 직접 호출한 것과 동일한 상태 변경 */
	goBack(): void;
	/** history.forward() 을 직접 호출한 것과 동일한 상태 변경 */
	goForward(): void;
	canGoBack(): boolean;
	canGoForward(): boolean;
}

export function createHistoryTracker(): HistoryTracker {
	// depth: 현재 스택 위치 (0 = 앱 진입 시점)
	// forwardDepth: 앞으로 갈 수 있는 단계 수
	let depth = -1;
	let forwardDepth = 0;

	return {
		onNavigate(type: string) {
			if (type === 'enter') {
				// 직접 URL 진입 또는 새 탭: 히스토리 기준점 리셋
				depth = 0;
				forwardDepth = 0;
			} else if (type === 'popstate') {
				// 브라우저 뒤로/앞으로 버튼: 실제 이동 방향을 알 수 없으므로
				// canGoBack 상태는 depth > 0 일 때 그대로 유지한다.
				// popstate 자체가 "뒤로"를 의미하는 경우가 대부분이지만,
				// SvelteKit은 앞으로도 popstate 로 보고한다.
				// 여기서는 보수적으로 depth를 1 감소시킨다.
				if (depth > 0) {
					depth -= 1;
					forwardDepth += 1;
				}
			} else {
				// link, goto, form — 새 히스토리 엔트리 추가
				depth += 1;
				forwardDepth = 0; // 새 페이지로 이동하면 앞으로 갈 곳이 없어진다
			}
		},

		goBack() {
			if (depth > 0) {
				depth -= 1;
				forwardDepth += 1;
			}
		},

		goForward() {
			if (forwardDepth > 0) {
				forwardDepth -= 1;
				depth += 1;
			}
		},

		canGoBack() {
			return depth > 0;
		},

		canGoForward() {
			return forwardDepth > 0;
		}
	};
}
