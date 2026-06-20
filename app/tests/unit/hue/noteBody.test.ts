import { describe, it, expect } from 'vitest';
import { firstBodyLineOf } from '$lib/hue/noteBody.js';
describe('firstBodyLineOf', () => {
  it('extracts second line', () => {
    expect(firstBodyLineOf('<note-content version="0.1">조명::거실\nlight:abc\n\n</note-content>')).toBe('light:abc');
  });
});
