import type { JSONContent } from '@tiptap/core';
import { isImageUrl } from '$lib/editor/imagePreview/isImageUrl.js';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]\}>]+$/;

function trimTrailingPunct(url: string): string {
	let prev = url;
	while (true) {
		const next = prev.replace(TRAILING_PUNCT_RE, '');
		if (next === prev) return next;
		prev = next;
	}
}

/**
 * Find image URLs embedded in the text nodes of a tiptap document, the same
 * way `imagePreviewPlugin.findImageUrlRanges` does — but operating on the
 * tiptap JSON (no PMNode positions). Same URL may appear multiple times in
 * the result if the document contains it more than once.
 */
export function extractImageUrlsFromDoc(doc: JSONContent): string[] {
	const out: string[] = [];
	walk(doc);
	return out;

	function walk(node: JSONContent): void {
		if (node.type === 'text' && typeof node.text === 'string') {
			const text = node.text;
			URL_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = URL_RE.exec(text)) !== null) {
				const url = trimTrailingPunct(m[0]);
				if (url && isImageUrl(url)) out.push(url);
			}
			return;
		}
		for (const child of node.content ?? []) walk(child);
	}
}

/**
 * Split a single text string into alternating literal/url segments. The url
 * segments are exactly what would be returned by `extractImageUrlsFromDoc` for
 * a doc containing this string — same trim rules.
 */
export interface TextSegment {
	kind: 'text' | 'image';
	value: string;
}

export function splitTextOnImageUrls(text: string): TextSegment[] {
	URL_RE.lastIndex = 0;
	const segments: TextSegment[] = [];
	let cursor = 0;
	let m: RegExpExecArray | null;
	while ((m = URL_RE.exec(text)) !== null) {
		const raw = m[0];
		const trimmed = trimTrailingPunct(raw);
		if (!trimmed || !isImageUrl(trimmed)) continue;
		const start = m.index;
		if (start > cursor) segments.push({ kind: 'text', value: text.slice(cursor, start) });
		segments.push({ kind: 'image', value: trimmed });
		cursor = start + trimmed.length;
		// regex lastIndex points to start + raw.length (post-trimming bytes go to next iteration)
		URL_RE.lastIndex = cursor;
	}
	if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
	if (segments.length === 0) segments.push({ kind: 'text', value: text });
	return segments;
}
