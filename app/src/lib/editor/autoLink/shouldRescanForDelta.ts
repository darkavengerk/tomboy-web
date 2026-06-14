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
 */
export function shouldRescanForDelta(delta: TitleDelta | undefined, docText: string): boolean {
	if (!delta) return true; // unknown delta → conservative full rescan
	if (delta.removed.length > 0) return true;
	return delta.added.some((e) => e.title && docText.includes(e.title));
}
