/**
 * ProseMirror plugin that renders inline image previews for image URLs
 * found in text, and makes each preview behave like a single atomic
 * character from the user's perspective.
 *
 * UX:
 *   - The image URL text is hidden (CSS `display: none` via inline
 *     decoration) when it's a valid image URL.
 *   - A widget decoration shows the actual <img> at the URL's end.
 *   - Backspace / Delete at a URL boundary deletes the WHOLE URL text.
 *   - ArrowLeft / ArrowRight at a URL boundary skips past the hidden text.
 *   - Clicking the image selects the full URL range (so Backspace / Delete
 *     then clears it).
 *
 * Invariant: the document itself is NEVER modified by rendering. The URL
 * stays in the doc (and in any surrounding `tomboyUrlLink` mark) verbatim
 * so the Tomboy `.note` XML round-trip is stable. Only *user-driven* key
 * / click actions mutate the doc, and when they do, they delete the
 * WHOLE URL — keeping "image acts like a character" semantics.
 */

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isImageUrl } from './isImageUrl.js';

export const imagePreviewPluginKey = new PluginKey<PluginState>('tomboyImagePreview');

export interface ImageUrlRange {
	/** Absolute doc position of the URL's first character. */
	from: number;
	/** Absolute doc position immediately after the URL's last character. */
	to: number;
	/** The image URL. */
	href: string;
}

interface PluginState {
	decorations: DecorationSet;
	ranges: ImageUrlRange[];
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
 * absolute `[from, to)` positions plus the cleaned href. Exported for testing.
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
			while (true) {
				const trimmed = url.replace(TRAILING_PUNCT_RE, '');
				if (trimmed === url) break;
				url = trimmed;
			}
			if (!url || !isImageUrl(url)) continue;

			const startInText = m.index;
			const endInText = startInText + url.length;
			out.push({
				from: pos + startInText,
				to: pos + endInText,
				href: url
			});
		}
	});

	return out;
}

function buildState(doc: PMNode): PluginState {
	const ranges = findImageUrlRanges(doc);
	if (ranges.length === 0) {
		return { decorations: DecorationSet.empty, ranges };
	}

	const decos: Decoration[] = [];
	for (const r of ranges) {
		// Hide the URL text. inclusiveStart/End: false so that user-typed chars
		// at either boundary don't get absorbed into the hidden range.
		decos.push(
			Decoration.inline(
				r.from,
				r.to,
				{ class: 'tomboy-image-url-hidden' },
				{ inclusiveStart: false, inclusiveEnd: false }
			)
		);
		// Image widget at the URL end.
		decos.push(
			Decoration.widget(r.to, (view) => renderImagePreview(r, view), {
				side: 1,
				key: `img:${r.from}:${r.to}:${r.href}`
			})
		);
	}
	return { decorations: DecorationSet.create(doc, decos), ranges };
}

function renderImagePreview(range: ImageUrlRange, view: EditorView): HTMLElement {
	const img = document.createElement('img');
	img.src = range.href;
	img.alt = '';
	img.className = 'tomboy-image-preview';
	img.loading = 'lazy';
	img.decoding = 'async';
	img.setAttribute('contenteditable', 'false');
	img.draggable = false;

	// Click on the image → select the whole (hidden) URL range, so that a
	// subsequent Backspace / Delete removes it as a single atomic unit —
	// matching the user-facing "image behaves like a character" model.
	img.addEventListener('mousedown', (e) => {
		e.preventDefault();
		// Re-derive the current live range from plugin state because doc
		// mutations may have shifted positions since the widget was rendered.
		const state = imagePreviewPluginKey.getState(view.state);
		if (!state) return;
		const live = state.ranges.find((r) => r.href === range.href && r.to === range.to)
			?? state.ranges.find((r) => r.href === range.href);
		if (!live) return;
		view.dispatch(
			view.state.tr.setSelection(
				TextSelection.create(view.state.doc, live.from, live.to)
			)
		);
		view.focus();
	});

	return img;
}

export type AtomicKey = 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight';

/**
 * Pure helper: given the current editor state, the plugin's known ranges
 * and a pressed key, return a transaction that applies atomic-character
 * behavior to the key — or `null` if the key should be handled normally.
 *
 * Exported for direct testing. The plugin's handleKeyDown just wires this
 * up to view.dispatch.
 */
export function handleAtomicKey(
	state: EditorState,
	ranges: ImageUrlRange[],
	key: AtomicKey
): Transaction | null {
	const { selection } = state;
	if (!selection.empty) return null;
	const pos = selection.from;

	switch (key) {
		case 'Backspace': {
			const r = ranges.find((r) => r.to === pos);
			if (!r) return null;
			return state.tr.delete(r.from, r.to);
		}
		case 'Delete': {
			const r = ranges.find((r) => r.from === pos);
			if (!r) return null;
			return state.tr.delete(r.from, r.to);
		}
		case 'ArrowLeft': {
			const r = ranges.find((r) => r.to === pos);
			if (!r) return null;
			return state.tr.setSelection(TextSelection.create(state.doc, r.from));
		}
		case 'ArrowRight': {
			const r = ranges.find((r) => r.from === pos);
			if (!r) return null;
			return state.tr.setSelection(TextSelection.create(state.doc, r.to));
		}
	}
}

function keyFromEvent(e: KeyboardEvent): AtomicKey | null {
	// Any modifier that changes the semantic action (ctrl/meta for word-skip /
	// select-to, alt for word, shift for selection extend) falls through to the
	// browser / other handlers. We only intercept the pure character-nav keys.
	if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
	if (e.key === 'Backspace' || e.key === 'Delete') return e.key;
	if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return e.key;
	return null;
}

export function createImagePreviewPlugin(): Plugin<PluginState> {
	return new Plugin<PluginState>({
		key: imagePreviewPluginKey,
		state: {
			init: (_, s) => buildState(s.doc),
			apply(tr, old) {
				if (!tr.docChanged) return old;
				return buildState(tr.doc);
			}
		},
		props: {
			decorations(state) {
				return imagePreviewPluginKey.getState(state)?.decorations;
			},
			handleKeyDown(view, event) {
				const k = keyFromEvent(event);
				if (!k) return false;
				const st = imagePreviewPluginKey.getState(view.state);
				if (!st || st.ranges.length === 0) return false;
				const tr = handleAtomicKey(view.state, st.ranges, k);
				if (!tr) return false;
				view.dispatch(tr);
				return true;
			}
		}
	});
}
