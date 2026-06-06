import type { JSONContent } from '@tiptap/core';

// Author a chart note that renders a DATA:: note as a chart. A chart note is an
// ordinary note: its first line is the note title; a body paragraph holds a
// `[x] Chart:<type> <title>` header followed by a bulletList config that the
// existing chartBlock plugin parses (parseChartBlock). The leading `[x]` is
// written as literal text here — the save→reload pipeline turns it into the
// inlineCheckbox atom, exactly as a hand-typed chart header round-trips.
//
// We deliberately omit a `y:` line so transformData auto-includes every numeric
// column: when a new `[1]…` category appears in the data note the chart picks it
// up with no edit to this note.

export interface ChartNoteOptions {
  /** The chart note's own title (its first line). */
  noteTitle: string;
  /** Title shown on the chart header line. */
  chartTitle: string;
  /** Data source — a `DATA::…` note title. */
  dataNoteTitle: string;
  /** Column used for the x-axis. */
  xColumn: string;
  /** Chart type; defaults to line. */
  chartType?: 'line' | 'bar' | 'area' | 'scatter';
  /** Smooth (곡선) line. */
  smooth?: boolean;
}

function para(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function listItem(text: string): JSONContent {
  return { type: 'listItem', content: [para(text)] };
}

export function buildChartNoteDoc(opts: ChartNoteOptions): JSONContent {
  const type = opts.chartType ?? 'line';
  const config: JSONContent[] = [listItem(opts.dataNoteTitle), listItem(`x:${opts.xColumn}`)];
  if (opts.smooth) config.push(listItem('[x]곡선'));

  return {
    type: 'doc',
    content: [
      para(opts.noteTitle),
      para(`[x] Chart:${type} ${opts.chartTitle}`),
      { type: 'bulletList', content: config }
    ]
  };
}
