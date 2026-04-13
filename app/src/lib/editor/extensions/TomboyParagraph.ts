import Paragraph from '@tiptap/extension-paragraph';

/**
 * Extends TipTap's default Paragraph to carry a `tomboyTrailingMarks` attr.
 *
 * Tomboy's flat-text-buffer format can apply an inline mark to just the
 * separator newline between two blocks (e.g. `<datetime>\n</datetime>` or
 * a link-marked newline). The archiver captures those marks as a structural
 * hint on the preceding paragraph; the serializer re-wraps the block
 * separator on output. The attr is schema-only (not rendered to DOM).
 */
export const TomboyParagraph = Paragraph.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			tomboyTrailingMarks: {
				default: null,
				rendered: false
			}
		};
	}
});
