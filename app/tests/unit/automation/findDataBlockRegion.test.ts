import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { findDataBlockRegion, csvToParagraphs } from '$lib/automation/findDataBlockRegion.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('findDataBlockRegion', () => {
  it('finds the first csv block', () => {
    const d = doc(['DATA::x', '', '```csv', 'a,b', '1,2', '```']);
    expect(findDataBlockRegion(d)).toEqual({ openIdx: 2, closeIdx: 5, format: 'csv' });
  });
  it('finds a tsv block', () => {
    const d = doc(['```tsv', 'a\tb', '```']);
    expect(findDataBlockRegion(d)).toEqual({ openIdx: 0, closeIdx: 2, format: 'tsv' });
  });
  it('returns null when unclosed', () => {
    expect(findDataBlockRegion(doc(['```csv', 'a,b']))).toBeNull();
  });
  it('returns null when no block', () => {
    expect(findDataBlockRegion(doc(['DATA::x', '본문']))).toBeNull();
  });
});

describe('csvToParagraphs', () => {
  it('splits lines into paragraphs, trimming trailing newline', () => {
    expect(csvToParagraphs('a,b\n1,2\n')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a,b' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '1,2' }] }
    ]);
  });
  it('emits an empty paragraph for blank lines', () => {
    expect(csvToParagraphs('a\n\nb')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }
    ]);
  });
});
