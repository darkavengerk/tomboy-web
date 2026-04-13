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
			}
		};
	}
});
