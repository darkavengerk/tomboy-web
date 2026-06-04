import { describe, it, expect } from 'vitest';
import { buildChartNoteDoc } from '$lib/automation/buildChartNote.js';
import { parseChartBlock } from '$lib/chart/parseChartBlock.js';

function lineTexts(doc: ReturnType<typeof buildChartNoteDoc>): string[] {
  const out: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === 'paragraph') {
        out.push((n.content ?? []).map((c: any) => (c.type === 'text' ? c.text : '')).join(''));
      } else if (n.content) {
        walk(n.content);
      }
    }
  };
  walk(doc.content ?? []);
  return out;
}

describe('buildChartNoteDoc', () => {
  const doc = buildChartNoteDoc({
    noteTitle: '노트 수 추이',
    chartTitle: '노트 수 추이',
    dataNoteTitle: 'DATA::note-count',
    xColumn: 'week',
    smooth: true
  });

  it('puts the note title on the first line', () => {
    expect(lineTexts(doc)[0]).toBe('노트 수 추이');
  });

  it('emits a checked line-chart header + config referencing the data note', () => {
    const texts = lineTexts(doc);
    expect(texts).toContain('[x] Chart:line 노트 수 추이');
    expect(texts).toContain('DATA::note-count');
    expect(texts).toContain('x:week');
    expect(texts).toContain('[x]곡선');
  });

  it('produces a config the real chart parser accepts (y omitted → all columns)', () => {
    const texts = lineTexts(doc);
    const headerIdx = texts.findIndex((t) => t.startsWith('[x] Chart:'));
    const spec = parseChartBlock(texts[headerIdx], texts.slice(headerIdx + 1));
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe('line');
    expect(spec!.checked).toBe(true);
    expect(spec!.dataNoteTitle).toBe('DATA::note-count');
    expect(spec!.xColumn).toBe('week');
    expect(spec!.yColumns).toBeUndefined();
    expect(spec!.smooth).toBe(true);
  });
});
