import type { JSONContent } from '@tiptap/core';

/**
 * Flatten a TipTap JSON document to a plain-text preview string.
 *
 * Inserts a newline between top-level blocks (paragraph, heading, list item)
 * and a single space between inline text nodes. Intended for the graph page's
 * click-preview panel, not for fidelity-preserving round-trips.
 */
export function toPlainText(doc: JSONContent, maxChars = 1000): string {
	const out: string[] = [];
	walk(doc, out, 0);
	const joined = out.join('').replace(/\n{3,}/g, '\n\n').trim();
	if (joined.length <= maxChars) return joined;
	return joined.slice(0, maxChars) + '…';
}

function walk(node: JSONContent, out: string[], depth: number): void {
	if (node.text) {
		out.push(node.text);
		return;
	}
	if (!node.content || node.content.length === 0) {
		if (isBlock(node.type)) out.push('\n');
		return;
	}
	for (const child of node.content) walk(child, out, depth + 1);
	if (isBlock(node.type)) out.push('\n');
}

function isBlock(type: string | undefined): boolean {
	if (!type) return false;
	return (
		type === 'paragraph' ||
		type === 'heading' ||
		type === 'listItem' ||
		type === 'bulletList' ||
		type === 'orderedList' ||
		type === 'blockquote'
	);
}
