import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { applyChartNote } from '$lib/automation/applyChartNote.js';
import { findNoteByTitle, getNoteEditorContent } from '$lib/core/noteManager.js';
import { parseDataNote } from '$lib/chart/parseDataNote.js';

const OPTS = {
  noteTitle: '노트 수 추이',
  chartTitle: '노트 수 추이',
  dataNoteTitle: 'DATA::note-count',
  xColumn: 'week',
  smooth: true
} as const;

describe('applyChartNote', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
  });

  it('creates the chart note when missing', async () => {
    const outcome = await applyChartNote(OPTS);
    expect(outcome).toBe('created');
    const note = await findNoteByTitle('노트 수 추이');
    expect(note).toBeTruthy();
    // Body must round-trip to a parseable chart header after save+reload.
    const doc = getNoteEditorContent(note!);
    const text = JSON.stringify(doc);
    expect(text).toContain('Chart:line');
    expect(text).toContain('DATA::note-count');
  });

  it('leaves an existing note untouched', async () => {
    await applyChartNote(OPTS);
    const before = JSON.stringify(getNoteEditorContent((await findNoteByTitle('노트 수 추이'))!));
    const outcome = await applyChartNote(OPTS);
    expect(outcome).toBe('exists');
    const after = JSON.stringify(getNoteEditorContent((await findNoteByTitle('노트 수 추이'))!));
    expect(after).toBe(before);
  });
});
