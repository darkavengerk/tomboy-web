import { describe, it, expect } from 'vitest';
import { assignColumns, type BlockKind } from '$lib/editor/hrSplit/assignColumns.js';

function k(s: string): BlockKind[] {
	// Compact spec: 'b' = block, 'h' = hr
	return s.split('').map(c => (c === 'h' ? 'hr' : 'block'));
}

describe('assignColumns', () => {
	it('all full when no active ordinals', () => {
		const roles = assignColumns({ kinds: k('bbhbbhb'), activeOrdinals: new Set() });
		expect(roles).toEqual([
			'full',
			'full',
			'plain-hr',
			'full',
			'full',
			'plain-hr',
			'full'
		]);
	});

	it('activating the only HR splits surrounding blocks', () => {
		const roles = assignColumns({ kinds: k('bbhbb'), activeOrdinals: new Set([0]) });
		expect(roles).toEqual(['left', 'left', 'divider', 'right', 'right']);
	});

	it('empty segment on one side still works', () => {
		// HR is the very first block: left segment is empty.
		const roles = assignColumns({ kinds: k('hbb'), activeOrdinals: new Set([0]) });
		expect(roles).toEqual(['divider', 'right', 'right']);

		// HR is the very last block: right segment is empty.
		const roles2 = assignColumns({ kinds: k('bbh'), activeOrdinals: new Set([0]) });
		expect(roles2).toEqual(['left', 'left', 'divider']);
	});

	it('two HRs, only second active — first stays plain', () => {
		const roles = assignColumns({ kinds: k('bhbhb'), activeOrdinals: new Set([1]) });
		expect(roles).toEqual(['full', 'plain-hr', 'left', 'divider', 'right']);
	});

	it('two non-adjacent active HRs each split their own region', () => {
		// b h b b h b — activate both HR0 and HR1 (no inactive HR between).
		// First-wins rule consumes seg0 (left of HR0) and seg1 (right of HR0).
		// HR1 then has no fresh left-segment so it falls back to plain-hr.
		const roles = assignColumns({ kinds: k('bhbbhb'), activeOrdinals: new Set([0, 1]) });
		expect(roles).toEqual(['left', 'divider', 'right', 'right', 'plain-hr', 'full']);
	});

	it('inactive HR between two active HRs separates them into independent splits', () => {
		// b h b h b h b
		// Active: HR0 and HR2. HR1 is inactive.
		const roles = assignColumns({
			kinds: k('bhbhbhb'),
			activeOrdinals: new Set([0, 2])
		});
		expect(roles).toEqual([
			'left',
			'divider',
			'right',
			'plain-hr',
			'left',
			'divider',
			'right'
		]);
	});

	it('out-of-range active ordinal is ignored', () => {
		const roles = assignColumns({ kinds: k('bhb'), activeOrdinals: new Set([5]) });
		expect(roles).toEqual(['full', 'plain-hr', 'full']);
	});

	it('no HRs at all', () => {
		const roles = assignColumns({ kinds: k('bbbb'), activeOrdinals: new Set() });
		expect(roles).toEqual(['full', 'full', 'full', 'full']);
	});

	it('preserves array length', () => {
		const kinds = k('bhbhbhbhb');
		const roles = assignColumns({ kinds, activeOrdinals: new Set([1, 3]) });
		expect(roles).toHaveLength(kinds.length);
	});
});
