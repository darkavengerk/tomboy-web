/**
 * Node-decoration placeholder for the second top-level paragraph (the
 * "subtitle" slot). Whenever the second paragraph is empty, a gray
 * placeholder like `2026-04-17` is shown — purely a decoration, never
 * written to the document, so no .note XML round-trip impact. It stays
 * visible even while the cursor sits on the empty line (the caret renders
 * before the floated placeholder text) and disappears only once the user
 * types real content there.
 *
 * Exception: notes whose title contains `::` (automation/data notes such as
 * `자동화::제목` or `DATA::project`) use the second line as a log slot, so the
 * whole subtitle treatment is suppressed for them. This plugin both skips the
 * placeholder AND tags the editor root with `NO_SUBTITLE_CLASS` so the muted
 * `p:nth-child(2)` CSS opts out too — see `subtitleSlot.ts` for the shared rule.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { NO_SUBTITLE_CLASS, suppressesSubtitle } from '../subtitleSlot.js';

export interface SubtitlePlaceholderOptions {
	/**
	 * Returns the text to render as the placeholder, or null to skip.
	 * Called on every decoration pass, so return a stable value.
	 */
	getPlaceholderText: () => string | null;
}

export const subtitlePlaceholderPluginKey = new PluginKey('tomboySubtitlePlaceholder');

export const TomboySubtitlePlaceholder = Extension.create<SubtitlePlaceholderOptions>({
	name: 'tomboySubtitlePlaceholder',

	addOptions() {
		return {
			getPlaceholderText: () => null
		};
	},

	addProseMirrorPlugins() {
		const options = this.options;
		return [
			new Plugin({
				key: subtitlePlaceholderPluginKey,
				props: {
					decorations: (state: EditorState) => {
						return buildDecorations(state, options.getPlaceholderText());
					},
					// Tag the editable root so the muted subtitle CSS can opt out
					// for `::` notes — single source of the rule lives in subtitleSlot.
					attributes: (state: EditorState): Record<string, string> =>
						suppressesSubtitle(state.doc) ? { class: NO_SUBTITLE_CLASS } : {}
				}
			})
		];
	}
});

function buildDecorations(state: EditorState, text: string | null): DecorationSet {
	if (!text) return DecorationSet.empty;

	const doc = state.doc;
	if (doc.childCount < 2) return DecorationSet.empty;

	// Automation/data notes (`::` in the title) use the second line as a real
	// log slot, not a subtitle — skip the placeholder there. (Shared rule.)
	if (suppressesSubtitle(doc)) return DecorationSet.empty;

	const second = doc.child(1);
	if (second.type.name !== 'paragraph') return DecorationSet.empty;
	if (second.content.size > 0) return DecorationSet.empty;

	// Intentionally NOT hidden while the cursor is on this line — the date
	// should stay visible until the user types real content (the caret simply
	// renders before the floated placeholder text).

	const from = doc.child(0).nodeSize;
	const to = from + second.nodeSize;
	const deco = Decoration.node(from, to, {
		class: 'tomboy-subtitle-placeholder',
		'data-placeholder': text
	});
	return DecorationSet.create(doc, [deco]);
}
