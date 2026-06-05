import { describe, it, expect } from 'vitest';
import { computeYearlyCsv, computeMonthlyCsv } from '$lib/automation/noteCount.js';
import { createEmptyNote, formatTomboyDate, type NoteData } from '$lib/core/note.js';

let seq = 0;
function note(create: Date, notebook: string | null): NoteData {
  const n = createEmptyNote(`g-${seq++}`);
  n.createDate = formatTomboyDate(create);
  n.tags = notebook ? [`system:notebook:${notebook}`] : [];
  return n;
}

const SLIP = '[0] Slip-Box';

describe('computeYearlyCsv', () => {
  it('always emits a [0] Slip-Box column even with no notes', () => {
    const { csv, categories } = computeYearlyCsv([], new Date(2026, 5, 4));
    expect(categories).toEqual([SLIP]);
    expect(csv.trim().split('\n')).toEqual([`year,${SLIP}`, '2026,0']);
  });

  it('counts per-year creation deltas (not cumulative)', () => {
    const notes = [
      note(new Date(2024, 2, 1), SLIP),
      note(new Date(2024, 8, 1), SLIP),
      note(new Date(2026, 0, 1), SLIP) // 2025 has none → row of 0
    ];
    const { csv } = computeYearlyCsv(notes, new Date(2026, 5, 4));
    expect(csv.trim().split('\n')).toEqual([
      `year,${SLIP}`,
      '2024,2',
      '2025,0',
      '2026,1'
    ]);
  });

  it('gives each [1]* category its own column, Slip-Box first then sorted', () => {
    const notes = [
      note(new Date(2026, 0, 1), '[1] Bar'),
      note(new Date(2026, 0, 1), '[1] Apple'),
      note(new Date(2026, 0, 1), SLIP),
      note(new Date(2026, 0, 1), '[2] Ignored'),
      note(new Date(2026, 0, 1), null)
    ];
    const { categories, csv } = computeYearlyCsv(notes, new Date(2026, 5, 4));
    expect(categories).toEqual([SLIP, '[1] Apple', '[1] Bar']);
    expect(csv.trim().split('\n')).toEqual([`year,${SLIP},[1] Apple,[1] Bar`, '2026,1,1,1']);
  });

  it('sanitizes commas in category labels', () => {
    const notes = [note(new Date(2026, 0, 1), '[1] Foo, Bar')];
    const { csv } = computeYearlyCsv(notes, new Date(2026, 5, 4));
    expect(csv.split('\n')[0]).toBe(`year,${SLIP},[1] Foo Bar`);
  });
});

describe('computeMonthlyCsv', () => {
  it('lists Jan→current month for the current year', () => {
    const notes = [
      note(new Date(2026, 0, 10), SLIP), // Jan
      note(new Date(2026, 2, 5), SLIP), // Mar
      note(new Date(2026, 2, 20), SLIP), // Mar
      note(new Date(2025, 11, 1), SLIP) // prior year → excluded
    ];
    const { csv } = computeMonthlyCsv(notes, 2026, new Date(2026, 2, 15)); // now = Mar 2026
    expect(csv.trim().split('\n')).toEqual([
      `month,${SLIP}`,
      '2026-01,1',
      '2026-02,0',
      '2026-03,2'
    ]);
  });

  it('lists all 12 months for a past year', () => {
    const notes = [note(new Date(2024, 6, 1), SLIP)]; // Jul 2024
    const { csv } = computeMonthlyCsv(notes, 2024, new Date(2026, 5, 4));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(`month,${SLIP}`);
    expect(lines).toHaveLength(13); // header + 12 months
    expect(lines[7]).toBe('2024-07,1');
    expect(lines[1]).toBe('2024-01,0');
    expect(lines[12]).toBe('2024-12,0');
  });
});
