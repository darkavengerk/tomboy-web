import { describe, it, expect } from 'vitest';
import {
	assignSections,
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
