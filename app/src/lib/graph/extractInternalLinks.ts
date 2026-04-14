import type { JSONContent } from '@tiptap/core';

/**
 * Walk a TipTap JSON document and collect every `tomboyInternalLink` mark's
 * `target` attribute (which stores the target note's **title**, not its GUID).
 *
 * Returns deduplicated targets in insertion order. Broken marks
 * (`attrs.broken === true`) are excluded — they already represent links to
 * notes that don't exist, so there's no edge to draw.
 */
export function extractInternalLinkTargets(doc: JSONContent): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	walk(doc, seen, out);
	return out;
}

function walk(node: JSONContent, seen: Set<string>, out: string[]): void {
	if (Array.isArray(node.marks)) {
		for (const mark of node.marks) {
			if (mark.type === 'tomboyInternalLink') {
				const attrs = (mark.attrs ?? {}) as { target?: string; broken?: boolean };
				if (attrs.broken) continue;
				const target = typeof attrs.target === 'string' ? attrs.target.trim() : '';
				if (!target) continue;
				if (!seen.has(target)) {
					seen.add(target);
					out.push(target);
				}
			}
		}
	}
	if (node.content) {
		for (const child of node.content) walk(child, seen, out);
	}
}
