import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { JSONContent } from '@tiptap/core';
import { buildUpdatedDoc, applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { createNote, findNoteByTitle, getNoteEditorContent } from '$lib/core/noteManager.js';
import { parseDataNote } from '$lib/chart/parseDataNote.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('buildUpdatedDoc', () => {
  it('replaces the body of an existing csv block', () => {
    const d = doc(['DATA::x', '```csv', 'old', '```']);
    const out = buildUpdatedDoc(d, 'a,b\n1,2\n');
    const texts = (out.content ?? []).map((p) => (p.content?.[0] as { text?: string })?.text ?? '');
    expect(texts).toEqual(['DATA::x', '```csv', 'a,b', '1,2', '```']);
  });
  it('appends a new csv block after the title when none exists', () => {
    const d = doc(['DATA::x']);
    const out = buildUpdatedDoc(d, 'a\n1\n');
    const texts = (out.content ?? []).map((p) => (p.content?.[0] as { text?: string })?.text ?? '');
    expect(texts).toEqual(['DATA::x', '```csv', 'a', '1', '```']);
  });
});

describe('applyDataNoteCsv', () => {
  beforeEach(async () => {
    // fresh fake-indexeddb per test
    indexedDB = new IDBFactory();
  });

  it('creates a DATA:: note when missing', async () => {
    const outcome = await applyDataNoteCsv('tomboy', 'a,b\n1,2\n');
    expect(outcome).toBe('created');
    const note = await findNoteByTitle('DATA::tomboy');
    expect(note).toBeTruthy();
    const tables = parseDataNote(getNoteEditorContent(note!));
    expect(tables[0].columns).toEqual(['a', 'b']);
    expect(tables[0].rows).toEqual([['1', '2']]);
  });

  it('updates an existing DATA:: note in place', async () => {
    await createNote('DATA::tomboy');
    await applyDataNoteCsv('tomboy', 'x\n9\n'); // first run adds block
    const outcome = await applyDataNoteCsv('tomboy', 'a,b\n1,2\n'); // second replaces
    expect(outcome).toBe('updated');
    const note = await findNoteByTitle('DATA::tomboy');
    const tables = parseDataNote(getNoteEditorContent(note!));
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([['1', '2']]);
  });
});
