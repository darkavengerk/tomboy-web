import { parseTomboyDate, type NoteData } from '$lib/core/note.js';

// Local note-count automation: bucket the current note set by creation week and
// emit a cumulative running total per category, as CSV for a DATA:: note.
//
// Categories = notebooks (`system:notebook:<name>` tags). For now we count the
// fixed `[0] Slip-Box` notebook plus every notebook whose name starts with
// `[1]`, each as its own column. Counts are CUMULATIVE: the value for week W is
// how many still-existing notes in that category were created on or before the
// end of W — a growth curve, which reads naturally as "how many there were".

const NB_PREFIX = 'system:notebook:';
const SLIP_BOX = '[0] Slip-Box';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Notebook name from a note's tags, or null. */
function notebookOf(note: NoteData): string | null {
  const t = note.tags.find((x) => x.startsWith(NB_PREFIX));
  return t ? t.slice(NB_PREFIX.length) : null;
}

/** True for the categories we track: `[0] Slip-Box` and any `[1]…` notebook. */
function isTargetCategory(name: string): boolean {
  return name === SLIP_BOX || name.startsWith('[1]');
}

/** Local-midnight Monday of the week containing `d`. */
function mondayOf(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (date.getDay() + 6) % 7; // Mon=0 … Sun=6
  date.setDate(date.getDate() - dow);
  return date;
}

/** ISO-8601 week label `GGGG-Www` (Mon-start, week 1 holds the first Thursday). */
export function isoWeekLabel(d: Date): string {
  // Move to the Thursday of this week; the ISO week-year is that Thursday's year.
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow + 3);
  const weekYear = date.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4);
  const firstDow = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDow + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / WEEK_MS);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/** Commas would break the bare `split(',')` CSV parser → fold them to spaces. */
function sanitize(label: string): string {
  return label.replace(/\s*,\s*/g, ' ');
}

export interface NoteCountResult {
  csv: string;
  /** Ordered category column names (Slip-Box first, then `[1]…` sorted). */
  categories: string[];
}

/**
 * Build the cumulative weekly note-count CSV.
 * @param notes the current note set (already excludes deleted + templates)
 * @param now   reference "today" — the week axis runs up to this week
 */
export function computeNoteCountCsv(notes: NoteData[], now: Date): NoteCountResult {
  // Gather target notes with their category + creation time.
  const tracked: Array<{ category: string; time: number }> = [];
  const present = new Set<string>();
  for (const n of notes) {
    const nb = notebookOf(n);
    if (!nb || !isTargetCategory(nb)) continue;
    const time = parseTomboyDate(n.createDate).getTime();
    if (!Number.isFinite(time)) continue;
    tracked.push({ category: nb, time });
    present.add(nb);
  }

  // Column order: Slip-Box always first, then [1]… categories actually present.
  const ones = [...present].filter((c) => c !== SLIP_BOX).sort((a, b) => a.localeCompare(b, 'ko'));
  const categories = [SLIP_BOX, ...ones];

  // Week axis: earliest tracked note's week → current week, inclusive.
  const earliest = tracked.length
    ? mondayOf(new Date(Math.min(...tracked.map((t) => t.time))))
    : mondayOf(now);
  const lastMonday = mondayOf(now);

  const rows: string[] = [];
  for (let m = earliest.getTime(); m <= lastMonday.getTime(); m += WEEK_MS) {
    const weekEnd = m + WEEK_MS; // exclusive: notes created before next Monday
    const label = isoWeekLabel(new Date(m));
    const counts = categories.map(
      (cat) => tracked.filter((t) => t.category === cat && t.time < weekEnd).length
    );
    rows.push([label, ...counts].join(','));
  }

  const header = ['week', ...categories.map(sanitize)].join(',');
  const csv = [header, ...rows].join('\n') + '\n';
  return { csv, categories };
}
