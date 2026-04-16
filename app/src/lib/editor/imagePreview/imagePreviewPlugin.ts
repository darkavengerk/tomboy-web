/**
 * ProseMirror plugin that renders inline image previews for image URLs
 * found in text.
 *
 * We scan plain text (via a simple http(s) URL regex) rather than relying
 * on the `tomboyUrlLink` mark — the web editor has no URL auto-link, so
 * pasted URLs stay unmarked. Marked URLs still work because their visible
 * text IS the URL, and we scan all text nodes regardless of marks.
 *
 * Crucially, the plugin NEVER modifies the document — previews are emitted
 * as widget decorations. The underlying text (including any `<link:url>`
 * mark) is preserved verbatim, keeping round-trip compatibility with the
 * desktop Tomboy `.note` XML.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isImageUrl } from './isImageUrl.js';

export const imagePreviewPluginKey = new PluginKey<DecorationSet>('tomboyImagePreview');

export interface ImageUrlRange {
	/** Absolute doc position right after the URL's last character. */
	pos: number;
	/** The image URL. */
	href: string;
}

// Match http(s) URLs up to the next whitespace / quote / angle bracket.
// Deliberately permissive on URL contents — the caller trims trailing
// punctuation and validates the result via `isImageUrl`.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// Trailing characters that are almost always sentence/prose punctuation
// rather than part of a URL. Trimmed off before validating.
const TRAILING_PUNCT_RE = /[.,;:!?)\]\}>]+$/;

/**
 * Scan the doc for image-URL substrings in any text node and return their
 * positions (right after the URL's last char, where a widget would anchor).
 * Exported for testing.
 */
export function findImageUrlRanges(doc: PMNode): ImageUrlRange[] {
	const out: ImageUrlRange[] = [];

	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		const text = node.text;
		URL_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = URL_RE.exec(text)) !== null) {
			let url = m[0];
			// Trim trailing prose punctuation, but iterate in case several
			// stacked up (e.g. ").").
			while (true) {
				const trimmed = url.replace(TRAILING_PUNCT_RE, '');
				if (trimmed === url) break;
				url = trimmed;
			}
			if (!url || !isImageUrl(url)) continue;

			const startInText = m.index;
			const endInText = startInText + url.length;
			// `pos` is the start of this text node in the doc.
			out.push({ pos: pos + endInText, href: url });
		}
	});

	return out;
}

function buildDecorationSet(doc: PMNode): DecorationSet {
	const ranges = findImageUrlRanges(doc);
	if (ranges.length === 0) return DecorationSet.empty;

	const decos = ranges.map(({ pos, href }) =>
		Decoration.widget(pos, () => renderImagePreview(href), {
			// Side > 0 so the widget appears AFTER text inserted at the same
			// position (cursor / typing). Prevents it from being shoved to the
			// left of the cursor when the URL ends right before the cursor.
			side: 1,
			// Stable key so PM doesn't recreate the DOM element on every
			// transaction (avoids image flicker on unrelated edits).
			key: `img:${pos}:${href}`
		})
	);
	return DecorationSet.create(doc, decos);
}

function renderImagePreview(href: string): HTMLElement {
	const img = document.createElement('img');
	img.src = href;
	img.alt = '';
	img.className = 'tomboy-image-preview';
	img.loading = 'lazy';
	img.decoding = 'async';
	// Prevent the widget from being selected/edited as doc content.
	img.setAttribute('contenteditable', 'false');
	img.draggable = false;
	return img;
}

export function createImagePreviewPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: imagePreviewPluginKey,
		state: {
			init: (_, state) => buildDecorationSet(state.doc),
			apply(tr, old) {
				if (!tr.docChanged) return old;
				return buildDecorationSet(tr.doc);
			}
		},
		props: {
			decorations(state) {
				return imagePreviewPluginKey.getState(state);
			}
		}
	});
}
