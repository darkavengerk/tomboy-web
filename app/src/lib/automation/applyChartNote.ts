import { findNoteByTitle, createNote, updateNoteFromEditor } from '$lib/core/noteManager.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import { buildChartNoteDoc, type ChartNoteOptions } from './buildChartNote.js';

export type ChartApplyOutcome = 'created' | 'exists';

/**
 * Ensure a chart note exists for the given data note.
 *
 * Created with a canonical line-chart body when missing. When it already
 * exists we leave it untouched: the chart reads the DATA:: note live (and
 * auto-includes new columns since `y:` is omitted), so no structural refresh
 * is ever needed — and we must not clobber any manual chart tweaks the user
 * made. Returns which happened so the run log can report it.
 */
export async function applyChartNote(opts: ChartNoteOptions): Promise<ChartApplyOutcome> {
  const existing = await findNoteByTitle(opts.noteTitle);
  if (existing) return 'exists';

  const note = await createNote(opts.noteTitle);
  await updateNoteFromEditor(note.guid, buildChartNoteDoc(opts));
  // Self-emit covers the bus; keep the desktop session reload for windows.
  await desktopSession.reloadWindows([note.guid]);
  return 'created';
}
