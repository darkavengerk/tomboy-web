import { describe, it, expect } from 'vitest';
import {
	assignColumns,
	computeGridStyles,
	type BlockKind,
	type Placement
} from '$lib/editor/hrSplit/assignColumns.js';

function k(s: string): BlockKind[] {
	return s.split('').map(c => (c === 'h' ? 'hr' : 'block'));
}
function active(...ords: number[]): Set<number> {
	return new Set(ords);
}

describe('assignColumns — column count = activeCount + 1', () => {
	it('no HRs → 1 column, all blocks in column 1', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbb'),
			activeOrdinals: active()
		});
		expect(totalColumns).toBe(1);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'block', col: 1 }
		]);
	});

	it('one inactive HR → 1 column, HR is an h-line in column 1', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhb'),
			activeOrdinals: active()
		});
		expect(totalColumns).toBe(1);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'h-line', col: 1 },
			{ role: 'block', col: 1 }
		]);
	});

	it('one active HR → 2 columns, divider between them', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhb'),
			activeOrdinals: active(0)
		});
		expect(totalColumns).toBe(2);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 }
		]);
	});

	it('two active HRs → 3 columns, 2 dividers', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhb'),
			activeOrdinals: active(0, 1)
		});
		expect(totalColumns).toBe(3);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		]);
	});

	it('three active HRs → 4 columns, 3 dividers', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhbhb'),
			activeOrdinals: active(0, 1, 2)
		});
		expect(totalColumns).toBe(4);
		expect(placements.filter(p => p.role === 'v-divider')).toHaveLength(3);
		expect(placements.filter(p => p.role === 'block').map(p => (p as { col: number }).col))
			.toEqual([1, 2, 3, 4]);
	});

	it('mixed active and inactive: inactive HR becomes h-line in its column', () => {
		// kinds: b h0 b h1 b h2 b   — activate only h1.
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhbhb'),
			activeOrdinals: active(1)
		});
		expect(totalColumns).toBe(2);
		// h0 is in column 1 as h-line; h1 is the divider; h2 is in column 2 as h-line.
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'h-line', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'h-line', col: 2 },
			{ role: 'block', col: 2 }
		]);
	});

	it('two active + one inactive between them: 3 columns; inactive HR is h-line in column 2', () => {
		// kinds: b h0 b h1 b h2 b  — activate h0 and h2.
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhbhb'),
			activeOrdinals: active(0, 2)
		});
		expect(totalColumns).toBe(3);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'h-line', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		]);
	});

	it('all three active when there are three HRs → 4 columns', () => {
		// kinds: b h b h b h b
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhbhb'),
			activeOrdinals: active(0, 1, 2)
		});
		expect(totalColumns).toBe(4);
		// Each column gets exactly one block.
		const blocks = placements.filter(p => p.role === 'block') as Array<{ col: number }>;
		expect(blocks.map(p => p.col)).toEqual([1, 2, 3, 4]);
	});

	it('active HR at start: column 1 is empty, content starts in column 2', () => {
		// kinds: h b b
		const { placements, totalColumns } = assignColumns({
			kinds: k('hbb'),
			activeOrdinals: active(0)
		});
		expect(totalColumns).toBe(2);
		expect(placements).toEqual([
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 }
		]);
	});

	it('active HR at end: column 2 is empty', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbh'),
			activeOrdinals: active(0)
		});
		expect(totalColumns).toBe(2);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 }
		]);
	});

	it('adjacent active HRs: middle column is empty', () => {
		// kinds: b h h b   — activate both.
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhhb'),
			activeOrdinals: active(0, 1)
		});
		expect(totalColumns).toBe(3);
		expect(placements).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		]);
	});

	it('column can contain multiple h-lines (independent note-like behavior)', () => {
		// kinds: b h b h b h b h b   — activate only the middle HR (h1).
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhbhbhbhb'),
			activeOrdinals: active(1)
		});
		expect(totalColumns).toBe(2);
		// Column 1: b, h-line(h0), b
		// Divider: h1
		// Column 2: b, h-line(h2), b, h-line(h3), b
		const col1Items = placements.slice(0, 3);
		expect(col1Items).toEqual([
			{ role: 'block', col: 1 },
			{ role: 'h-line', col: 1 },
			{ role: 'block', col: 1 }
		]);
		const col2Items = placements.slice(4);
		expect(col2Items).toEqual([
			{ role: 'block', col: 2 },
			{ role: 'h-line', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'h-line', col: 2 },
			{ role: 'block', col: 2 }
		]);
	});

	it('out-of-range active ordinal is silently ignored', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bhb'),
			activeOrdinals: active(5)
		});
		expect(totalColumns).toBe(1);
		expect(placements[1]).toEqual({ role: 'h-line', col: 1 });
	});

	it('preserves array length', () => {
		const kinds = k('bhbhbhbhbhb');
		const { placements } = assignColumns({
			kinds,
			activeOrdinals: active(0, 2, 4)
		});
		expect(placements).toHaveLength(kinds.length);
	});
});

describe('computeGridStyles — grid template and explicit row/column tracks', () => {
	it('no splits → no template, no styles', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'h-line', col: 1 },
			{ role: 'block', col: 1 }
		];
		const out = computeGridStyles(placements, 1);
		expect(out.template).toBeNull();
		expect(out.styleFor).toEqual([null, null, null]);
	});

	it('2 columns → template "1fr auto 1fr"', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 }
		];
		const out = computeGridStyles(placements, 2);
		expect(out.template).toBe('1fr auto 1fr');
		expect(out.styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(out.styleFor[1]).toBe('grid-column:2;grid-row:1 / span 1;');
		expect(out.styleFor[2]).toBe('grid-column:3;grid-row:1;');
	});

	it('3 columns → template "1fr auto 1fr auto 1fr"', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		];
		const out = computeGridStyles(placements, 3);
		expect(out.template).toBe('1fr auto 1fr auto 1fr');
		// Divider 0 → track 2; divider 1 → track 4; column 3 → track 5.
		expect(out.styleFor[1]).toBe('grid-column:2;grid-row:1 / span 1;');
		expect(out.styleFor[3]).toBe('grid-column:4;grid-row:1 / span 1;');
		expect(out.styleFor[4]).toBe('grid-column:5;grid-row:1;');
	});

	it('4 columns → template "1fr auto 1fr auto 1fr auto 1fr"', () => {
		const placements: Placement[] = Array.from({ length: 7 }, (_, i) =>
			i % 2 === 0 ? { role: 'block', col: i / 2 + 1 } : { role: 'v-divider', dividerIdx: (i - 1) / 2 }
		);
		const out = computeGridStyles(placements as Placement[], 4);
		expect(out.template).toBe('1fr auto 1fr auto 1fr auto 1fr');
	});

	it('row numbers count up independently per column', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 }
		];
		const out = computeGridStyles(placements, 2);
		expect(out.styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(out.styleFor[1]).toBe('grid-column:1;grid-row:2;');
		expect(out.styleFor[3]).toBe('grid-column:3;grid-row:1;');
		expect(out.styleFor[4]).toBe('grid-column:3;grid-row:2;');
		expect(out.styleFor[5]).toBe('grid-column:3;grid-row:3;');
	});

	it('h-lines occupy rows in their column just like blocks', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'h-line', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 }
		];
		const out = computeGridStyles(placements, 2);
		expect(out.styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(out.styleFor[1]).toBe('grid-column:1;grid-row:2;');
		expect(out.styleFor[2]).toBe('grid-column:1;grid-row:3;');
		// Divider spans the tallest column (col 1 has 3 rows, col 2 has 1).
		expect(out.styleFor[3]).toBe('grid-column:2;grid-row:1 / span 3;');
		expect(out.styleFor[4]).toBe('grid-column:3;grid-row:1;');
	});

	it('divider span equals max(rowCount) across all columns', () => {
		// Column 1: 2 blocks. Column 2: 5 blocks. Column 3: 1 block.
		// Dividers should each span 5 rows.
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		];
		const out = computeGridStyles(placements, 3);
		expect(out.styleFor[2]).toBe('grid-column:2;grid-row:1 / span 5;');
		expect(out.styleFor[8]).toBe('grid-column:4;grid-row:1 / span 5;');
	});

	it('adjacent dividers with empty middle column still produce a valid layout', () => {
		const placements: Placement[] = [
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'v-divider', dividerIdx: 1 },
			{ role: 'block', col: 3 }
		];
		const out = computeGridStyles(placements, 3);
		expect(out.template).toBe('1fr auto 1fr auto 1fr');
		expect(out.styleFor[0]).toBe('grid-column:1;grid-row:1;');
		expect(out.styleFor[1]).toBe('grid-column:2;grid-row:1 / span 1;');
		expect(out.styleFor[2]).toBe('grid-column:4;grid-row:1 / span 1;');
		expect(out.styleFor[3]).toBe('grid-column:5;grid-row:1;');
	});

	it('empty first column with content in column 2', () => {
		const placements: Placement[] = [
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 },
			{ role: 'block', col: 2 }
		];
		const out = computeGridStyles(placements, 2);
		expect(out.styleFor[0]).toBe('grid-column:2;grid-row:1 / span 2;');
		expect(out.styleFor[1]).toBe('grid-column:3;grid-row:1;');
		expect(out.styleFor[2]).toBe('grid-column:3;grid-row:2;');
	});
});

describe('headerCount — first N children excluded from split layout', () => {
	it('headerCount=2 marks first two children as header regardless of content', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbbhb'),
			activeOrdinals: active(0),
			headerCount: 2
		});
		expect(totalColumns).toBe(2);
		expect(placements).toEqual([
			{ role: 'header' },
			{ role: 'header' },
			{ role: 'block', col: 1 },
			{ role: 'v-divider', dividerIdx: 0 },
			{ role: 'block', col: 2 }
		]);
	});

	it('header count caps at kinds.length (short notes do not crash)', () => {
		const { placements, totalColumns, headerCount } = assignColumns({
			kinds: k('b'),
			activeOrdinals: active(),
			headerCount: 2
		});
		expect(totalColumns).toBe(1);
		expect(headerCount).toBe(1);
		expect(placements).toEqual([{ role: 'header' }]);
	});

	it('HR ordinal numbering skips header indices', () => {
		// First two are header. The first real HR is at index 2 with ordinal 0.
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbhbhb'),
			activeOrdinals: active(1), // activate the SECOND real HR
			headerCount: 2
		});
		expect(totalColumns).toBe(2);
		expect(placements[2]).toEqual({ role: 'h-line', col: 1 }); // ordinal 0 stays inactive
		expect(placements[4]).toEqual({ role: 'v-divider', dividerIdx: 0 }); // ordinal 1 activates
	});

	it('computeGridStyles places headers at full-width rows, content below', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbbhb'),
			activeOrdinals: active(0),
			headerCount: 2
		});
		const out = computeGridStyles(placements, totalColumns);
		// Headers: rows 1, 2; full width.
		expect(out.styleFor[0]).toBe('grid-column:1 / -1;grid-row:1;');
		expect(out.styleFor[1]).toBe('grid-column:1 / -1;grid-row:2;');
		// Content block in col 1 starts at row 3.
		expect(out.styleFor[2]).toBe('grid-column:1;grid-row:3;');
		// Divider spans rows 3..3 (each column has 1 content row).
		expect(out.styleFor[3]).toBe('grid-column:2;grid-row:3 / span 1;');
		// Right column block at row 3.
		expect(out.styleFor[4]).toBe('grid-column:3;grid-row:3;');
	});

	it('divider span ignores header rows (= max content rows only)', () => {
		// Headers (2) + col 1: 3 blocks + divider + col 2: 5 blocks.
		// Divider should span 5 rows starting at row 3, NOT 7 (which would
		// include headers).
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbbbbhbbbbb'),
			activeOrdinals: active(0),
			headerCount: 2
		});
		const out = computeGridStyles(placements, totalColumns);
		const dividerIdx = placements.findIndex(p => p.role === 'v-divider');
		expect(out.styleFor[dividerIdx]).toBe('grid-column:2;grid-row:3 / span 5;');
	});

	it('no split + headers → no grid layout (headers flow normally)', () => {
		const { placements, totalColumns } = assignColumns({
			kinds: k('bbbb'),
			activeOrdinals: active(),
			headerCount: 2
		});
		const out = computeGridStyles(placements, totalColumns);
		expect(out.template).toBeNull();
		expect(out.styleFor).toEqual([null, null, null, null]);
	});
});

describe('integration: kinds → placements → grid styles', () => {
	it('three active HRs, mixed column heights', () => {
		// b b h0 b h1 b b b h2 b
		// active: all three → 4 columns
		// col 1: b, b (2 rows)
		// col 2: b (1 row)
		// col 3: b, b, b (3 rows)
		// col 4: b (1 row)
		// max rows = 3 → dividers span 3 rows
		const kinds = k('bbhbhbbbhb');
		const { placements, totalColumns } = assignColumns({
			kinds,
			activeOrdinals: active(0, 1, 2)
		});
		expect(totalColumns).toBe(4);
		const out = computeGridStyles(placements, totalColumns);
		expect(out.template).toBe('1fr auto 1fr auto 1fr auto 1fr');
		// Find divider indices in the array.
		const dividerIndices = placements
			.map((p, i) => (p.role === 'v-divider' ? i : -1))
			.filter(i => i >= 0);
		expect(dividerIndices).toHaveLength(3);
		for (const i of dividerIndices) {
			expect(out.styleFor[i]).toMatch(/span 3;$/);
		}
	});

	it('one active among many: only one divider; other HRs are h-lines in their respective columns', () => {
		// b h0 b h1 b h2 b h3 b — activate h2 only.
		// Result: 2 columns. h0, h1 are h-lines in col 1; h3 is h-line in col 2.
		const kinds = k('bhbhbhbhb');
		const { placements, totalColumns } = assignColumns({
			kinds,
			activeOrdinals: active(2)
		});
		expect(totalColumns).toBe(2);
		// h0 at index 1, h1 at index 3 → both h-line col 1.
		expect(placements[1]).toEqual({ role: 'h-line', col: 1 });
		expect(placements[3]).toEqual({ role: 'h-line', col: 1 });
		// h2 at index 5 → divider.
		expect(placements[5]).toEqual({ role: 'v-divider', dividerIdx: 0 });
		// h3 at index 7 → h-line col 2.
		expect(placements[7]).toEqual({ role: 'h-line', col: 2 });
	});
});
