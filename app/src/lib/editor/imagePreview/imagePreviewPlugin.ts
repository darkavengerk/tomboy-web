/**
 * ProseMirror plugin that renders inline image previews for `tomboyUrlLink`
 * marks whose `href` looks like an image URL.
 *
 * Crucially, this plugin does NOT modify the document — the underlying
 * Tomboy `<link:url>` mark is preserved verbatim so round-trip compatibility
 * with the desktop Tomboy `.note` XML is unchanged. Previews are purely
 * visual, emitted as widget decorations that sit at the end of each
 * image-URL run.
 *
 * Position model: we walk text nodes. For each contiguous run of text
 * sharing the same `tomboyUrlLink` mark (href + instanceId), we emit a
 * single widget at the run's end position. Adjacent text nodes split by
 * inner marks (bold inside a url link, etc.) thus still produce ONE preview.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isImageUrl } from './isImageUrl.js';

export const imagePreviewPluginKey = new PluginKey<DecorationSet>('tomboyImagePreview');

export interface ImageUrlRange {
	/** Absolute doc position right after the marked text run (where the widget anchors). */
	pos: number;
	/** The image URL from the `tomboyUrlLink` mark's `href`. */
	href: string;
}

/**
 * Scan the doc for `tomboyUrlLink` marks whose href is an image URL,
 * merging adjacent text nodes that belong to the same anchor instance.
 * Exported for testing.
 */
export function findImageUrlRanges(doc: PMNode): ImageUrlRange[] {
	interface Entry {
		from: number;
		to: number;
		href: string;
		instanceId: string | null;
	}
	const entries: Entry[] = [];

	doc.descendants((node, pos) => {
		if (!node.isText) return;
		const mark = node.marks.find((m) => m.type.name === 'tomboyUrlLink');
		if (!mark) return;
		const href = (mark.attrs.href as string | null) ?? null;
		if (!href || !isImageUrl(href)) return;
		const instanceId = (mark.attrs.instanceId as string | null) ?? null;
		const nodeEnd = pos + node.nodeSize;

		const last = entries[entries.length - 1];
		if (
			last &&
			last.to === pos &&
			last.href === href &&
			last.instanceId === instanceId
		) {
			last.to = nodeEnd;
		} else {
			entries.push({ from: pos, to: nodeEnd, href, instanceId });
		}
	});

	return entries.map((e) => ({ pos: e.to, href: e.href }));
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
	const wrap = document.createElement('img');
	wrap.src = href;
	wrap.alt = '';
	wrap.className = 'tomboy-image-preview';
	wrap.loading = 'lazy';
	wrap.decoding = 'async';
	// Prevent the widget from being selected/edited as doc content.
	wrap.setAttribute('contenteditable', 'false');
	wrap.draggable = false;
	return wrap;
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
