import { describe, it, expect } from 'vitest';
import { computeNoteCountCsv, isoWeekLabel } from '$lib/automation/noteCount.js';
import { createEmptyNote, formatTomboyDate, type NoteData } from '$lib/core/note.js';

function note(create: Date, notebook: string | null): NoteData {
  const n = createEmptyNote(`g-${create.getTime()}-${notebook ?? 'none'}`);
  n.createDate = formatTomboyDate(create);
  n.tags = notebook ? [`system:notebook:${notebook}`] : [];
  return n;
}

const SLIP = '[0] Slip-Box';

describe('isoWeekLabel', () => {
  it('labels ISO weeks (Mon-start, week-of-first-Thursday)', () => {
    // 2026-01-01 is a Thursday → that week is 2026-W01.
    expect(isoWeekLabel(new Date(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeekLabel(new Date(2026, 0, 4))).toBe('2026-W01'); // Sun of W01
    expect(isoWeekLabel(new Date(2026, 0, 5))).toBe('2026-W02'); // Mon of W02
    expect(isoWeekLabel(new Date(2026, 0, 19))).toBe('2026-W04');
  });
});

describe('computeNoteCountCsv', () => {
  it('always emits a [0] Slip-Box column even with no notes', () => {
    const { csv, categories } = computeNoteCountCsv([], new Date(2026, 0, 19));
    expect(categories).toEqual([SLIP]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(`week,${SLIP}`);
    // single current-week row of zeros
    expect(lines[1]).toBe('2026-W04,0');
  });

  it('counts Slip-Box notes cumulatively by creation week', () => {
    const notes = [
      note(new Date(2026, 0, 5, 10), SLIP), // W02
      note(new Date(2026, 0, 12, 10), SLIP) // W03
    ];
    const { csv } = computeNoteCountCsv(notes, new Date(2026, 0, 19, 10));
    expect(csv.trim().split('\n')).toEqual([
      `week,${SLIP}`,
      '2026-W02,1',
      '2026-W03,2',
      '2026-W04,2'
    ]);
  });

  it('gives each [1]* category its own column, Slip-Box first then sorted', () => {
    const notes = [
      note(new Date(2026, 0, 5, 10), '[1] Bar'),
      note(new Date(2026, 0, 5, 10), '[1] Apple'),
      note(new Date(2026, 0, 5, 10), SLIP),
      note(new Date(2026, 0, 5, 10), '[2] Ignored'), // not a target category
      note(new Date(2026, 0, 5, 10), null) // no notebook → ignored
    ];
    const { categories, csv } = computeNoteCountCsv(notes, new Date(2026, 0, 5, 12));
    expect(categories).toEqual([SLIP, '[1] Apple', '[1] Bar']);
    expect(csv.trim().split('\n')).toEqual([`week,${SLIP},[1] Apple,[1] Bar`, '2026-W02,1,1,1']);
  });

  it('sanitizes commas in category labels so the CSV stays splittable', () => {
    const notes = [note(new Date(2026, 0, 5, 10), '[1] Foo, Bar')];
    const { csv } = computeNoteCountCsv(notes, new Date(2026, 0, 5, 12));
    expect(csv.split('\n')[0]).toBe(`week,${SLIP},[1] Foo Bar`);
  });
});
