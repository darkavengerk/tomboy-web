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
