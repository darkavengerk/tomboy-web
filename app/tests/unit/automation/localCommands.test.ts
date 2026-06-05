import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { getLocalCommand } from '$lib/automation/localCommands.js';
import { createNote } from '$lib/core/noteManager.js';
import { assignNotebook } from '$lib/core/notebooks.js';

describe('getLocalCommand routing', () => {
  it('resolves yearly + monthly (with and without a year)', () => {
    expect(getLocalCommand('note-count-yearly')).toBeTypeOf('function');
    expect(getLocalCommand('note-count-monthly')).toBeTypeOf('function');
    expect(getLocalCommand('note-count-monthly-2024')).toBeTypeOf('function');
  });

  it('returns undefined for bridge / unknown ids', () => {
    expect(getLocalCommand('loc-history')).toBeUndefined();
    expect(getLocalCommand('note-count')).toBeUndefined();
    expect(getLocalCommand('note-count-monthly-99')).toBeUndefined(); // not 4 digits
  });
});

describe('local command handlers (against fake IDB)', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
  });

  it('monthly-YYYY emits a DATA::note-count-YYYY result + chart for that year', async () => {
    const n = await createNote('짧은 노트');
    await assignNotebook(n.guid, '[0] Slip-Box');

    const out = await getLocalCommand('note-count-monthly-2024')!();
    expect(Object.keys(out.results)).toEqual(['note-count-2024']);
    expect(out.results['note-count-2024'].split('\n')[0]).toBe('month,[0] Slip-Box');
    expect(out.charts[0]).toMatchObject({
      noteTitle: '2024년 월별 노트 수',
      dataNoteTitle: 'DATA::note-count-2024',
      xColumn: 'month'
    });
  });

  it('yearly emits a DATA::note-count-yearly result + chart', async () => {
    const out = await getLocalCommand('note-count-yearly')!();
    expect(Object.keys(out.results)).toEqual(['note-count-yearly']);
    expect(out.results['note-count-yearly'].split('\n')[0]).toBe('year,[0] Slip-Box');
    expect(out.charts[0]).toMatchObject({
      noteTitle: '연도별 노트 수',
      dataNoteTitle: 'DATA::note-count-yearly',
      xColumn: 'year'
    });
  });
});
