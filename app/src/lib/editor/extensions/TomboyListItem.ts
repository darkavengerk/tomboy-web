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
				// 체크리스트 항목의 완료 여부. 체크리스트 영역 밖의 일반
				// 리스트 항목에서는 의미 없이 false 로 남는다. 화면 표시는
				// checklist 플러그인이 데코레이션으로 처리하므로 DOM 에
				// 렌더링하지 않는다(rendered: false).
				default: false,
				rendered: false
			}
		};
	}
});
