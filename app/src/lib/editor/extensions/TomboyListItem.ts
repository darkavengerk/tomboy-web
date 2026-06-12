import ListItem from '@tiptap/extension-list-item';

/**
 * Extends TipTap's default ListItem to carry a `tomboyTrailingNewline` attr.
 *
 * The Tomboy XML format encodes, per list-item, whether a literal '\n' appears
 * immediately before `</list-item>`. The archiver's parser records this on
 * each listItem node so the serializer can reproduce the source byte-for-byte.
 * Without declaring it here, TipTap would strip the attr on any edit cycle
 * (or even on initial `setContent`), forcing a normalizing save.
 *
 * The attr is schema-only — no DOM rendering or parsing — so it lives
 * invisibly in the PM document.
 */
export const TomboyListItem = ListItem.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			tomboyTrailingNewline: {
				default: null,
				rendered: false
			},
			checked: {
				// 체크리스트/항목 단위 박스의 완료(선택) 여부. 박스 없는 일반
				// 항목에서는 의미 없이 false 로 남는다. 화면 표시는 checklist /
				// listBox 플러그인이 데코레이션으로 처리하므로 DOM 에
				// 렌더링하지 않는다(rendered: false). keepOnSplit: false —
				// Enter 분할로 생긴 새 항목은 항상 미체크로 시작한다.
				default: false,
				rendered: false,
				keepOnSplit: false
			},
			boxKind: {
				// 항목 단위 박스 마커: 'checkbox' | 'radio' | null.
				// 체크리스트: 영역과 무관하게 li 단독으로 불릿을 체크박스/
				// 라디오로 교체한다(listBox 모듈). keepOnSplit 기본값(true)
				// 이라 Enter 로 만든 새 항목에 종류가 상속된다.
				default: null,
				rendered: false
			}
		};
	}
});
