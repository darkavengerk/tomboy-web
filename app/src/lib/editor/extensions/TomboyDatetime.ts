import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * Preserves Tomboy's <datetime> inline element on round-trip.
 *
 * In Tomboy desktop, <datetime>…</datetime> wraps user-inserted date / time
 * references. We model it as a simple mark so the text content is preserved
 * verbatim and the tag is re-emitted on serialisation. We don't apply any
 * special visual styling beyond a `data-tomboy-datetime` attribute for
 * optional CSS hooks.
 */
export const TomboyDatetime = Mark.create({
	name: 'tomboyDatetime',

	addOptions() {
		return {
			HTMLAttributes: {}
		};
	},

	addAttributes() {
		return {
			// Unique per source <datetime> element. Keeps two adjacent
			// datetime anchors from being coalesced by PM's mark-merging (which
			// considers marks with identical attrs to be the same instance).
			// `rendered: false` keeps it out of the DOM output.
			instanceId: {
				default: null,
				rendered: false
			}
		};
	},

	parseHTML() {
		return [
			{ tag: 'span[data-tomboy-datetime]' },
			// Some parsers may expose the raw <datetime> element as-is.
			{ tag: 'datetime' }
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			'span',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
				'data-tomboy-datetime': 'true',
				class: 'tomboy-datetime'
			}),
			0
		];
	}
});
