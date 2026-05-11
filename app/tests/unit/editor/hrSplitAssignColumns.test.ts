import { describe, it, expect } from 'vitest';
import { assignColumns, type BlockKind } from '$lib/editor/hrSplit/assignColumns.js';
import { computeGridStyles } from '$lib/editor/hrSplit/hrSplitPlugin.js';

function k(s: string): BlockKind[] {
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
		const roles = assignColumns({ kinds: k('hbb'), activeOrdinals: new Set([0]) });
		expect(roles).toEqual(['divider', 'right', 'right']);

		const roles2 = assignColumns({ kinds: k('bbh'), activeOrdinals: new Set([0]) });
		expect(roles2).toEqual(['left', 'left', 'divider']);
	});

	it('two HRs, only second active — first stays plain', () => {
		const roles = assignColumns({ kinds: k('bhbhb'), activeOrdinals: new Set([1]) });
		expect(roles).toEqual(['full', 'plain-hr', 'left', 'divider', 'right']);
	});

	it('two adjacent active HRs resolve first-wins; second reverts to plain-hr', () => {
		const roles = assignColumns({
			kinds: k('bhbbhb'),
			activeOrdinals: new Set([0, 1])
		});
		expect(roles).toEqual(['left', 'divider', 'right', 'right', 'plain-hr', 'full']);
	});

	it('inactive HR between two active HRs separates them into independent splits', () => {
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

	it('preserves array length', () => {
		const kinds = k('bhbhbhbhb');
		const roles = assignColumns({ kinds, activeOrdinals: new Set([1, 3]) });
		expect(roles).toHaveLength(kinds.length);
	});
});

describe('computeGridStyles', () => {
	it('no splits → every block gets a full-width row', () => {
		const { styleFor, hasSplit } = computeGridStyles([
			'full',
			'full',
			'plain-hr',
			'full'
		]);
		expect(hasSplit).toBe(false);
		expect(styleFor).toEqual([
			'grid-column:1 / -1;grid-row:1;',
			'grid-column:1 / -1;grid-row:2;',
			'grid-column:1 / -1;grid-row:3;',
			'grid-column:1 / -1;grid-row:4;'
		]);
	});

	it('single split: divider spans the larger of left/right rows', () => {
		// 2 left + divider + 5 right → divider spans 5 rows.
		const roles = [
			'left',
			'left',
			'divider',
			'right',
			'right',
			'right',
			'right',
			'right'
		] as const;
		const { styleFor, hasSplit } = computeGridStyles(roles as never);
		expect(hasSplit).toBe(true);
		// Left items in column 1, rows 1..2.
		expect(styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(styleFor[1]).toBe('grid-column:1;grid-row:2;');
		// Divider in column 2, spanning 5 rows from row 1.
		expect(styleFor[2]).toBe('grid-column:2;grid-row:1 / span 5;');
		// Right items in column 3, rows 1..5.
		expect(styleFor[3]).toBe('grid-column:3;grid-row:1;');
		expect(styleFor[4]).toBe('grid-column:3;grid-row:2;');
		expect(styleFor[7]).toBe('grid-column:3;grid-row:5;');
	});

	it('full block following a split occupies the next free row', () => {
		const roles = [
			'left',
			'divider',
			'right',
			'right',
			'right',
			'full',
			'full'
		] as const;
		const { styleFor } = computeGridStyles(roles as never);
		// Split takes rows 1..3 (max(1, 3) = 3 rows).
		expect(styleFor[1]).toBe('grid-column:2;grid-row:1 / span 3;');
		// Next full block starts at row 4.
		expect(styleFor[5]).toBe('grid-column:1 / -1;grid-row:4;');
		expect(styleFor[6]).toBe('grid-column:1 / -1;grid-row:5;');
	});

	it('empty-left split still emits divider with span >= 1', () => {
		const roles = ['divider', 'right', 'right'] as const;
		const { styleFor } = computeGridStyles(roles as never);
		expect(styleFor[0]).toBe('grid-column:2;grid-row:1 / span 2;');
		expect(styleFor[1]).toBe('grid-column:3;grid-row:1;');
		expect(styleFor[2]).toBe('grid-column:3;grid-row:2;');
	});

	it('empty-right split: divider spans the left count', () => {
		const roles = ['left', 'left', 'divider'] as const;
		const { styleFor } = computeGridStyles(roles as never);
		expect(styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(styleFor[1]).toBe('grid-column:1;grid-row:2;');
		expect(styleFor[2]).toBe('grid-column:2;grid-row:1 / span 2;');
	});
});
