import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseLabeledDivider } from './parseLabeledDivider.js';

export const labeledDividerPluginKey = new PluginKey('tomboyLabeledDivider');

/**
 * Top-level children skipped from divider detection: the title (index 0)
 * and the subtitle / date line (index 1). Matches hrSplit's HEADER_COUNT —
 * those lines always render as headers and must never become a divider.
 */
const HEADER_COUNT = 2;

/**
 * Build the decoration set for the current document. Walks only the
 * top-level children (paragraphs don't nest), so this is cheap to run on
 * every state.
 */
function buildLabeledDividerDecorations(doc: PMNode): DecorationSet {
	const decos: Decoration[] = [];
	doc.forEach((node, offset, index) => {
		if (index < HEADER_COUNT) return;
		if (node.type.name !== 'paragraph') return;
		const parsed = parseLabeledDivider(node.textContent);
		if (!parsed) return;

		// `offset` is the position just before the paragraph; its inline
		// content starts at `offset + 1`. A character at index `i` in the
		// paragraph text is at document position `offset + 1 + i` — text
		// nodes contribute exactly one position per character.
		const contentStart = offset + 1;

		decos.push(
			Decoration.node(offset, offset + node.nodeSize, {
				class:
					parsed.align === 'center'
						? 'tomboy-labeled-divider tomboy-labeled-divider--center'
						: 'tomboy-labeled-divider tomboy-labeled-divider--left'
			})
		);

		const markRanges: ReadonlyArray<readonly [number, number]> =
			parsed.leadMark ? [parsed.leadMark, parsed.trailMark] : [parsed.trailMark];
		for (const [a, b] of markRanges) {
			if (b > a) {
				decos.push(
					Decoration.inline(contentStart + a, contentStart + b, {
						class: 'tomboy-labeled-divider-mark'
					})
				);
			}
		}

		const [labelFrom, labelTo] = parsed.labelRange;
		decos.push(
			Decoration.inline(contentStart + labelFrom, contentStart + labelTo, {
				class: 'tomboy-labeled-divider-label'
			})
		);
	});
	return DecorationSet.create(doc, decos);
}

/**
 * Renders labeled dividers — top-level paragraphs whose text matches
 * `-- label --` (centered) or `label ---` (left). The literal markup stays
 * in the document (so it round-trips through note save/sync untouched);
 * decorations hide the dash runs and style the label.
 *
 * Decoration-only: this plugin never modifies the document.
 */
export function createLabeledDividerPlugin(): Plugin {
	return new Plugin({
		key: labeledDividerPluginKey,
		props: {
			decorations(state: EditorState) {
				return buildLabeledDividerDecorations(state.doc);
			}
		}
	});
}
