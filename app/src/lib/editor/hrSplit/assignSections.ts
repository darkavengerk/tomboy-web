/**
 * Pure section-assignment logic for the HR fold feature.
 *
 * Model — each HR marker "owns" the content below it: section `k` runs
 * from the block right after HR `k` up to (but not including) the next
 * HR or the end of the document. The header area and anything above the
 * first HR are not foldable (`outside`).
 *
 * HR ordinals use the same post-header numbering as the hrSplit feature
 * (assignColumns), so fold state and split state key off the same
 * ordinal space.
 */

import type { BlockKind } from './assignColumns.js';

export type SectionRole =
	| { role: 'outside' }
	| { role: 'hr'; ord: number; sectionEmpty: boolean }
	| { role: 'first'; section: number }
	| { role: 'rest'; section: number };

export interface SectionInput {
	kinds: BlockKind[];
	/** Number of leading top-level children excluded from sections.
	 *  Mirrors assignColumns' headerCount. Defaults to 0. */
	headerCount?: number;
}

export interface SectionOutput {
	roles: SectionRole[];
	/** Number of post-header HR markers (= number of sections, some of
	 *  which may be empty). */
	hrCount: number;
}

export function assignSections({
	kinds,
	headerCount: rawHeaderCount = 0
}: SectionInput): SectionOutput {
	const headerCount = Math.max(0, Math.min(rawHeaderCount, kinds.length));
	const roles: SectionRole[] = [];
	// -1 = above the first HR (not a section).
	let section = -1;
	let firstSeen = false;

	for (let i = 0; i < kinds.length; i++) {
		if (i < headerCount) {
			roles.push({ role: 'outside' });
			continue;
		}
		if (kinds[i] === 'hr') {
			section++;
			firstSeen = false;
			// sectionEmpty is patched below once we know whether any block
			// follows before the next HR / end of doc.
			roles.push({ role: 'hr', ord: section, sectionEmpty: true });
		} else if (section < 0) {
			roles.push({ role: 'outside' });
		} else if (!firstSeen) {
			firstSeen = true;
			roles.push({ role: 'first', section });
		} else {
			roles.push({ role: 'rest', section });
		}
	}

	// Patch sectionEmpty: an HR's section is non-empty iff a 'first' role
	// with its ordinal exists.
	const nonEmpty = new Set<number>();
	for (const r of roles) {
		if (r.role === 'first') nonEmpty.add(r.section);
	}
	for (const r of roles) {
		if (r.role === 'hr') r.sectionEmpty = !nonEmpty.has(r.ord);
	}

	return { roles, hrCount: section + 1 };
}

/**
 * The "section box" — a 1×N table frame drawn around the run of
 * content-bearing `---` sections. The box spans the first non-empty
 * section's HR marker (top edge) down to the last section block; each `---`
 * inside is a row divider. Bare `---` (an HR whose own section is empty)
 * never opens a box on its own.
 *
 * This is a *visual* frame independent of fold state — it renders whenever
 * a content `---` section exists. The only fold-dependent part is `bottom`:
 * a folded section hides its 'rest' blocks (`display:none`), so the bottom
 * border must land on the last *visible* block, which is a folded last
 * section's clamped 'first' block rather than its hidden tail.
 */
export interface BoxRegion {
	/** Top-level index of the first non-empty section's HR marker — the box
	 *  top edge. -1 when there is no content `---` section (no box). */
	top: number;
	/** Top-level index of the last section content block (logical end; may be
	 *  hidden when its section is folded). -1 when there is no box. */
	end: number;
	/** Top-level index that carries the bottom border = the last *visible*
	 *  block in `[top, end]` for the given folded set. Always a content block
	 *  ('first' stays visible/clamped even when folded). -1 when no box. */
	bottom: number;
}

export function computeBoxRegion(
	roles: SectionRole[],
	folded: ReadonlySet<number> = new Set()
): BoxRegion {
	// top = first HR whose own section is non-empty. A leading bare/empty
	// `---` (or anything 'outside') stays outside the box.
	let top = -1;
	for (let i = 0; i < roles.length; i++) {
		const r = roles[i];
		if (r.role === 'hr' && !r.sectionEmpty) {
			top = i;
			break;
		}
	}
	if (top < 0) return { top: -1, end: -1, bottom: -1 };

	// end = last content block at or after top. A trailing bare `---` past
	// the last section is excluded so the box closes under real content.
	let end = -1;
	for (let i = roles.length - 1; i > top; i--) {
		const r = roles[i];
		if (r.role === 'first' || r.role === 'rest') {
			end = i;
			break;
		}
	}

	// bottom = last index in [top, end] that is visible. A 'rest' block of a
	// folded section is hidden; its 'first' block is only clamped (visible).
	let bottom = -1;
	for (let i = end; i > top; i--) {
		const r = roles[i];
		const hidden = r.role === 'rest' && folded.has(r.section);
		if (!hidden) {
			bottom = i;
			break;
		}
	}

	return { top, end, bottom };
}
