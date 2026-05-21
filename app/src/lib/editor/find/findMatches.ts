import type { Node as PMNode } from '@tiptap/pm/model';

/** A single search hit, expressed as ProseMirror document positions. */
export interface FindMatch {
	/** Document position of the first matched character. */
	from: number;
	/** Document position just past the last matched character. */
	to: number;
}

/**
 * Placeholder substituted for inline atom nodes (hard breaks, inline
 * widgets) so their single document position is kept in the per-textblock
 * search string without ever taking part in a match. U+FFFF is a permanent
 * Unicode non-character — it cannot occur in real note text or in a query.
 */
const ATOM_PLACEHOLDER = '￿';

/**
 * Find every case-insensitive occurrence of `query` inside `doc`.
 *
 * Matching is scoped to a single textblock, so a query never spans a
 * paragraph / heading boundary. Within a textblock the inline text is
 * concatenated across mark boundaries, so a partially-bold word
 * (`hel` + bold `lo`) still matches `hello`.
 *
 * Returns matches as document positions in ascending order. An empty
 * `query` returns no matches.
 *
 * Note: case folding uses `String.prototype.toLowerCase()`, which is 1:1
 * for Latin + Hangul (this app's content). The rare characters that change
 * length when lowercased are not handled.
 */
export function findMatches(doc: PMNode, query: string): FindMatch[] {
	if (query === '') return [];
	const needle = query.toLowerCase();
	const matches: FindMatch[] = [];

	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;

		// Build the textblock's search string and a parallel array mapping
		// each string index to its document position. Inline content
		// starts at pos + 1 (just inside the block's opening token).
		let haystack = '';
		const posAt: number[] = [];
		let childPos = pos + 1;
		node.forEach((child) => {
			if (child.isText) {
				const text = child.text ?? '';
				for (let i = 0; i < text.length; i++) {
					haystack += text[i];
					posAt.push(childPos + i);
				}
			} else {
				// Inline atom: one document position, one placeholder char.
				haystack += ATOM_PLACEHOLDER;
				posAt.push(childPos);
			}
			childPos += child.nodeSize;
		});

		const lower = haystack.toLowerCase();
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			matches.push({
				from: posAt[idx],
				to: posAt[idx + needle.length - 1] + 1
			});
			idx = lower.indexOf(needle, idx + needle.length);
		}

		// Textblocks don't nest — no need to descend into inline content.
		return false;
	});

	return matches;
}
