import { getAllNotes } from '$lib/storage/noteStore.js';
import { computeNoteCountCsv } from './noteCount.js';
import type { ChartNoteOptions } from './buildChartNote.js';

// Local (browser-side) automation commands. Unlike bridge commands, these run
// entirely against the local IndexedDB — no Pi bridge / desktop service. The
// `자동화::<id>` note's ⟳ button routes here first; only ids absent from this
// registry fall through to the bridge (runAutomation).
//
// A handler returns the same `{results, errors}` shape as the bridge (so the
// existing DATA:: splice path is reused verbatim) plus an optional list of
// chart notes to ensure exist.

export interface LocalCommandResult {
  /** project → CSV, fed to applyDataNoteCsv (DATA::<project>). */
  results: Record<string, string>;
  /** project → error message. */
  errors: Record<string, string>;
  /** Chart notes to create-if-missing. */
  charts: ChartNoteOptions[];
}

export type LocalCommandHandler = () => Promise<LocalCommandResult>;

/** `자동화::note-count` — weekly cumulative note count by category. */
async function runNoteCountCommand(): Promise<LocalCommandResult> {
  const notes = await getAllNotes();
  const { csv } = computeNoteCountCsv(notes, new Date());
  return {
    results: { 'note-count': csv },
    errors: {},
    charts: [
      {
        noteTitle: '노트 수 추이',
        chartTitle: '노트 수 추이',
        dataNoteTitle: 'DATA::note-count',
        xColumn: 'week',
        chartType: 'line',
        smooth: true
      }
    ]
  };
}

const LOCAL_COMMANDS: Record<string, LocalCommandHandler> = {
  'note-count': runNoteCountCommand
};

/** The local handler for `id`, or undefined if it's a bridge command. */
export function getLocalCommand(id: string): LocalCommandHandler | undefined {
  return Object.prototype.hasOwnProperty.call(LOCAL_COMMANDS, id)
    ? LOCAL_COMMANDS[id]
    : undefined;
}
