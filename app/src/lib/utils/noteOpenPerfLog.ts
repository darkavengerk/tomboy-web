/**
 * Checkpoint-based performance log for "opening a note" in desktop mode.
 *
 * Purpose: we've observed that opening a (especially previously-closed) note
 * in desktop mode spends a visible amount of time doing *something* before the
 * window becomes interactive. Rather than guess from the code, this module
 * lets us sprinkle `mark()` calls at meaningful points along the pipeline and
 * get a single console.table dump at the end so we can see — per note — what
 * ran and how long after the open each step landed.
 *
 * Model: at most one session is active at a time. `start(guid)` opens a
 * window; subsequent `mark()` calls within `DURATION_MS` are appended with the
 * elapsed time since start. The session auto-finalises (prints its table and
 * clears itself) once DURATION_MS elapses, or if a new session starts for a
 * different guid before then.
 *
 * No-op when no session is active, so leaving `mark()` calls in hot paths is
 * cheap.
 */
/* eslint-disable no-console */

interface PerfMark {
	/** Milliseconds since session start (t0). */
	t: number;
	label: string;
	detail?: unknown;
}

interface PerfSession {
	guid: string;
	t0: number;
	marks: PerfMark[];
	timer: ReturnType<typeof setTimeout> | null;
}

const DURATION_MS = 5000;

let session: PerfSession | null = null;

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Begin a new perf session keyed on `guid`. Any previously-active session is
 * finalised (printed) first. Intended to be called from the site that first
 * causes a NoteWindow to mount for the given guid (e.g. desktopSession.openWindow).
 */
export function startNoteOpenPerf(guid: string, label = 'openWindow'): void {
	if (session) finalize();
	const t0 = now();
	const timer = setTimeout(() => finalize(), DURATION_MS);
	session = {
		guid,
		t0,
		marks: [{ t: 0, label }],
		timer
	};
	console.log(`[note-open-perf] start guid=${guid} label=${label}`);
}

/**
 * Record a checkpoint against the currently active session. Pass `guid` when
 * the caller can identify the note in question — the mark is dropped if it
 * doesn't match the active session's guid (prevents unrelated concurrent
 * activity from polluting the log).
 *
 * To record a mark regardless of guid (e.g. when investigating cross-window
 * interference), pass `'*'` as the guid — the mark is always accepted and
 * the actual guid should be encoded in `detail` so the reader can tell which
 * window produced it.
 */
export function markNoteOpenPerf(
	label: string,
	detail?: unknown,
	guid?: string
): void {
	const s = session;
	if (!s) return;
	if (guid !== undefined && guid !== '*' && guid !== s.guid) return;
	s.marks.push({ t: now() - s.t0, label, detail });
}

/** True while a session is open (optionally scoped to a specific guid). */
export function isNoteOpenPerfActive(guid?: string): boolean {
	const s = session;
	if (!s) return false;
	if (guid !== undefined && guid !== s.guid) return false;
	return true;
}

/** Return the active session's guid, or null if no session is active. */
export function activeNoteOpenPerfGuid(): string | null {
	return session?.guid ?? null;
}

function finalize(): void {
	const s = session;
	if (!s) return;
	if (s.timer) clearTimeout(s.timer);
	session = null;
	const rows = s.marks.map((m, i) => ({
		'#': i,
		'Δms': m.t.toFixed(1),
		label: m.label,
		detail:
			m.detail === undefined
				? ''
				: typeof m.detail === 'object'
					? JSON.stringify(m.detail)
					: String(m.detail)
	}));
	console.log(
		`[note-open-perf] end guid=${s.guid} marks=${s.marks.length} windowMs=${DURATION_MS}`
	);
	console.table(rows);
}

/** Test-only: drop any active session without logging. */
export function _resetNoteOpenPerfForTest(): void {
	if (session?.timer) clearTimeout(session.timer);
	session = null;
}
