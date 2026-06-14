import type { TitleEntry } from './findTitleMatches.js';

export interface TitleDelta {
	added: TitleEntry[];
	removed: TitleEntry[];
}

/**
 * Pure predicate deciding whether a `TomboyEditor` must re-run its full
 * auto-link scan after a `titleProvider` refresh.
 *
 * Conservative when delta is unknown (`undefined` → true). Otherwise:
 * - Any removal means old marks may be stale → must rescan.
 * - Any added title that appears verbatim in the doc text → must rescan.
 * - Empty delta (nothing changed) → skip the expensive rescan.
 *
 * This is a deliberate over-approximation: `includes` is a substring (not
 * whole-word) test, so a very short title (1–2 chars) matches almost any
 * non-empty doc and that editor will rescan. False positives are harmless —
 * `findTitleMatches` applies the real word-boundary check during the scan — but
 * a false negative would drop a needed link, so we err toward rescanning.
 */
export function shouldRescanForDelta(delta: TitleDelta | undefined, docText: string): boolean {
	if (!delta) return true; // unknown delta → conservative full rescan
	if (delta.removed.length > 0) return true;
	// `e.title` is always non-blank (titleProvider filters blanks on build); the
	// truthiness guard is just defensive against an empty string sneaking in.
	return delta.added.some((e) => e.title && docText.includes(e.title));
}
