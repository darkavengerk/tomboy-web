/**
 * Single source of truth for the "subtitle slot" rule.
 *
 * The second top-level paragraph of a note is normally the *subtitle* slot:
 * rendered smaller + muted, with a gray date/label placeholder on the empty
 * line. Automation / data notes — whose title contains `::` (e.g. `자동화::cmd`,
 * `DATA::project`, `음악추출::…`) — use that line as a real log/body slot, so
 * the entire subtitle treatment (placeholder + muted styling) is suppressed.
 *
 * This rule has three visual consumers, all keyed off the helpers below:
 *  - `TomboySubtitlePlaceholder` — skips the placeholder decoration AND tags
 *    the editor root with {@link NO_SUBTITLE_CLASS} so CSS can opt out.
 *  - `TomboyEditor.svelte` — `.tiptap:not(.tomboy-no-subtitle) > p:nth-child(2)`
 *  - `StickyHeader.svelte` — same gate on the cloned-header mirror.
 *
 * Keep the rule here; do not re-test `::` at the call sites.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { dedicatedBundleKind } from './noteBundle/parser.js';

/** Root class added to the editable DOM when the subtitle slot is suppressed. */
export const NO_SUBTITLE_CLASS = 'tomboy-no-subtitle';

/**
 * True when the note's title (first top-level paragraph) suppresses the
 * subtitle slot — i.e. the title contains `::`.
 *
 * Exception: dedicated filing notes (`탭::`/`묶음::`) use their second line as a
 * structured options slot (`:높이:개수`), not a freeform log, so they KEEP the
 * subtitle treatment (the placeholder there shows the option-syntax hint).
 */
export function suppressesSubtitle(doc: PMNode): boolean {
	const title = doc.firstChild?.textContent ?? '';
	if (!title.includes('::')) return false;
	if (dedicatedBundleKind(title)) return false;
	return true;
}
