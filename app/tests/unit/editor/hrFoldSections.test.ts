import { describe, it, expect } from 'vitest';
import {
	assignSections,
	computeBoxRegion,
	type SectionRole
} from '$lib/editor/hrSplit/assignSections.js';
import type { BlockKind } from '$lib/editor/hrSplit/assignColumns.js';

function k(s: string): BlockKind[] {
	return s.split('').map(c => (c === 'h' ? 'hr' : 'block'));
}

function roles(input: { kinds: BlockKind[]; headerCount?: number }): SectionRole[] {
	return assignSections(input).roles;
}

describe('assignSections — section = content below each HR', () => {
	it('no HRs → everything is outside, zero sections', () => {
		const out = assignSections({ kinds: k('bbb') });
		expect(out.hrCount).toBe(0);
		expect(out.roles).toEqual([
			{ role: 'outside' },
			{ role: 'outside' },
			{ role: 'outside' }
		]);
	});

	it('blocks before the first HR are outside', () => {
		expect(roles({ kinds: k('bbhb') })).toEqual([
			{ role: 'outside' },
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: false },
			{ role: 'first', section: 0 }
		]);
	});

	it('one HR owning two blocks → first + rest', () => {
		expect(roles({ kinds: k('bhbb') })).toEqual([
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: false },
			{ role: 'first', section: 0 },
			{ role: 'rest', section: 0 }
		]);
	});

	it('two HRs split content into two sections', () => {
		expect(roles({ kinds: k('bhbbhbb') })).toEqual([
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: false },
			{ role: 'first', section: 0 },
			{ role: 'rest', section: 0 },
			{ role: 'hr', ord: 1, sectionEmpty: false },
			{ role: 'first', section: 1 },
			{ role: 'rest', section: 1 }
		]);
	});

	it('HR immediately followed by another HR → empty section', () => {
		expect(roles({ kinds: k('bhhb') })).toEqual([
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: true },
			{ role: 'hr', ord: 1, sectionEmpty: false },
			{ role: 'first', section: 1 }
		]);
	});

	it('trailing HR at the end of the doc → empty section', () => {
		expect(roles({ kinds: k('bhbh') })).toEqual([
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: false },
			{ role: 'first', section: 0 },
			{ role: 'hr', ord: 1, sectionEmpty: true }
		]);
	});

	it('headerCount excludes leading children from sections', () => {
		// First 2 children are headers — even if one looks like an HR
		// (kinds[] from describeTopLevel never marks headers as hr, but
		// assignSections must still treat the first headerCount entries
		// as outside regardless).
		expect(roles({ kinds: k('bbhbb'), headerCount: 2 })).toEqual([
			{ role: 'outside' },
			{ role: 'outside' },
			{ role: 'hr', ord: 0, sectionEmpty: false },
			{ role: 'first', section: 0 },
			{ role: 'rest', section: 0 }
		]);
	});

	it('headerCount larger than kinds length is clamped', () => {
		const out = assignSections({ kinds: k('bb'), headerCount: 10 });
		expect(out.roles).toEqual([{ role: 'outside' }, { role: 'outside' }]);
		expect(out.hrCount).toBe(0);
	});

	it('hr inside header range still counts as outside', () => {
		// Defensive: if a caller passes kinds with an hr inside the header
		// range, it must not become a section boundary.
		expect(roles({ kinds: k('hbb'), headerCount: 1 })).toEqual([
			{ role: 'outside' },
			{ role: 'outside' },
			{ role: 'outside' }
		]);
	});

	it('hrCount counts only post-header HRs', () => {
		const out = assignSections({ kinds: k('hbhbh'), headerCount: 1 });
		expect(out.hrCount).toBe(2);
	});

	it('empty kinds array', () => {
		const out = assignSections({ kinds: [] });
		expect(out.roles).toEqual([]);
		expect(out.hrCount).toBe(0);
	});
});

describe('assignSections — fold visibility helpers', () => {
	it('roles expose enough info to hide a folded section', () => {
		const out = assignSections({ kinds: k('bhbbbhb') });
		// Section 0 = indices 2,3,4 (first, rest, rest); section 1 = index 6.
		const section0 = out.roles
			.map((r, i) => ({ r, i }))
			.filter(({ r }) => (r.role === 'first' || r.role === 'rest') && r.section === 0)
			.map(({ i }) => i);
		expect(section0).toEqual([2, 3, 4]);
	});
});

/** Convenience: roles for the kinds string with headerCount=1 (index 0 is a
 *  title header so the first `---` lands at a stable index ≥ 1). */
function box(kinds: string, folded: number[] = []) {
	const { roles } = assignSections({ kinds: k(kinds), headerCount: 1 });
	return computeBoxRegion(roles, new Set(folded));
}

describe('computeBoxRegion — 1×N table frame', () => {
	it('no `---` at all → no box', () => {
		expect(box('bbbb')).toEqual({ top: -1, end: -1, bottom: -1 });
	});

	it('bare `---` with no content section → no box', () => {
		// header, then `---` at the very end (empty section).
		expect(box('bh')).toEqual({ top: -1, end: -1, bottom: -1 });
	});

	it('single content section → top at the `---`, end+bottom at its content', () => {
		// idx: 0 header, 1 `---`(ord0), 2 first, 3 rest.
		expect(box('bhbb')).toEqual({ top: 1, end: 3, bottom: 3 });
	});

	it('two content sections → spans first `---` to last block', () => {
		// idx: 0 header, 1 `---`(0), 2 first, 3 rest, 4 `---`(1), 5 first, 6 rest.
		expect(box('bhbbhbb')).toEqual({ top: 1, end: 6, bottom: 6 });
	});

	it('leading bare `---` is skipped — box starts at the first content `---`', () => {
		// idx: 0 header, 1 `---`(0, empty), 2 `---`(1, content), 3 first.
		expect(box('bhhb')).toEqual({ top: 2, end: 3, bottom: 3 });
	});

	it('trailing bare `---` is excluded — box closes under real content', () => {
		// idx: 0 header, 1 `---`(0), 2 first, 3 `---`(1, empty trailing).
		expect(box('bhbh')).toEqual({ top: 1, end: 2, bottom: 2 });
	});

	it('folding the last section moves bottom to its clamped first block', () => {
		// idx: 0 header, 1 `---`(0), 2 first, 3 `---`(1), 4 first, 5 rest, 6 rest.
		// Section 1 folded → idx 5,6 hidden, idx 4 (first) stays clamped/visible.
		expect(box('bhbhbbb', [1])).toEqual({ top: 1, end: 6, bottom: 4 });
	});

	it('folding a middle section leaves bottom on the last block', () => {
		// Fold section 0 (idx 2 first stays, idx 3 rest hidden) — last block
		// idx 6 (section 1) still visible, so bottom stays at end.
		expect(box('bhbbhbb', [0])).toEqual({ top: 1, end: 6, bottom: 6 });
	});

	it('single section folded → bottom stays on its clamped first block', () => {
		// idx: 0 header, 1 `---`(0), 2 first, 3 rest. Fold 0 → idx 3 hidden.
		expect(box('bhbb', [0])).toEqual({ top: 1, end: 3, bottom: 2 });
	});
});
