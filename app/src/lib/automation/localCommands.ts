import { getAllNotes } from '$lib/storage/noteStore.js';
import { computeYearlyCsv, computeMonthlyCsv } from './noteCount.js';
import type { ChartNoteOptions } from './buildChartNote.js';

// Local (browser-side) automation commands. Unlike bridge commands, these run
// entirely against the local IndexedDB — no Pi bridge / desktop service. The
// `자동화::<id>` note's ⟳ button routes here first; only ids absent from this
// registry fall through to the bridge (runAutomation).
//
// A handler returns the same `{results, errors}` shape as the bridge (so the
// existing DATA:: splice path is reused verbatim) plus an optional list of
// chart notes to ensure exist.
//
// Two note-count commands:
//   • note-count-yearly         — per-year creation deltas
//   • note-count-monthly[-YYYY] — per-month deltas for a year (default: current)

export interface LocalCommandResult {
  /** project → CSV, fed to applyDataNoteCsv (DATA::<project>). */
  results: Record<string, string>;
  /** project → error message. */
  errors: Record<string, string>;
  /** Chart notes to create-if-missing. */
  charts: ChartNoteOptions[];
}

export type LocalCommandHandler = () => Promise<LocalCommandResult>;

/** `자동화::note-count-yearly` — per-year creation deltas by category. */
async function runYearly(): Promise<LocalCommandResult> {
  const notes = await getAllNotes();
  const { csv } = computeYearlyCsv(notes, new Date());
  return {
    results: { 'note-count-yearly': csv },
    errors: {},
    charts: [
      {
        noteTitle: '연도별 노트 수',
        chartTitle: '연도별 노트 수',
        dataNoteTitle: 'DATA::note-count-yearly',
        xColumn: 'year',
        chartType: 'line',
        smooth: true
      }
    ]
  };
}

/** `자동화::note-count-monthly[-YYYY]` — per-month deltas for one year. */
async function runMonthly(year: number): Promise<LocalCommandResult> {
  const notes = await getAllNotes();
  const { csv } = computeMonthlyCsv(notes, year, new Date());
  const project = `note-count-${year}`;
  return {
    results: { [project]: csv },
    errors: {},
    charts: [
      {
        noteTitle: `${year}년 월별 노트 수`,
        chartTitle: `${year}년 월별 노트 수`,
        dataNoteTitle: `DATA::${project}`,
        xColumn: 'month',
        chartType: 'line',
        smooth: true
      }
    ]
  };
}

const MONTHLY_RE = /^note-count-monthly(?:-(\d{4}))?$/;

/**
 * The local handler for `id`, or undefined if it's a bridge command.
 * `note-count-monthly` takes an optional `-YYYY` suffix (default: current year).
 */
export function getLocalCommand(id: string): LocalCommandHandler | undefined {
  if (id === 'note-count-yearly') return runYearly;
  const m = MONTHLY_RE.exec(id);
  if (m) {
    const year = m[1] ? Number(m[1]) : new Date().getFullYear();
    return () => runMonthly(year);
  }
  return undefined;
}
