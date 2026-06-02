import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseAutomationNote, parseAutomationTitle } from '$lib/automation/parseAutomationNote.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('parseAutomationTitle', () => {
  it('extracts the command id', () => {
    expect(parseAutomationTitle('자동화::loc-history')).toBe('loc-history');
  });
  it('takes the first token when a label follows', () => {
    expect(parseAutomationTitle('자동화::loc-history 코드 갱신')).toBe('loc-history');
  });
  it('returns null for non-automation / empty id', () => {
    expect(parseAutomationTitle('DATA::tomboy')).toBeNull();
    expect(parseAutomationTitle('자동화::')).toBeNull();
    expect(parseAutomationTitle('그냥 노트')).toBeNull();
  });
});

describe('parseAutomationNote', () => {
  it('reads the first paragraph as the title', () => {
    expect(parseAutomationNote(doc(['자동화::loc-history', '', '- 로그']))).toEqual({ commandId: 'loc-history' });
  });
  it('returns null when the first line is not an automation title', () => {
    expect(parseAutomationNote(doc(['DATA::tomboy', '```csv']))).toBeNull();
  });
});
