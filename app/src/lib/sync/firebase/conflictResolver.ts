/**
 * Pure last-write-wins conflict resolver for Firestore note sync.
 *
 * Single-user product, so we don't attempt 3-way merge here — that's the
 * Dropbox sync's job. The decision compares Tomboy `changeDate` (and
 * `metadataChangeDate` as the metadata-only tiebreaker), and falls back to
 * "local wins" when timestamps are equal so we never silently overwrite the
 * user's currently-open editor with a same-time remote variant.
 *
 * The function is intentionally narrow: it only inspects fields that affect
 * the decision. Callers are responsible for actually performing the
 * push/pull side-effect.
 */
export interface ConflictSide {
	xmlContent: string;
	changeDate: string;
	metadataChangeDate: string;
	tags: string[];
	deleted: boolean;
}

export type ConflictDecision =
	| { kind: 'noop' }
	| {
			kind: 'push';
			reason: 'remote-missing' | 'local-newer' | 'tie-prefers-local';
	  }
	| { kind: 'pull'; reason: 'local-missing' | 'remote-newer' };

export function resolveNoteConflict(
	local: ConflictSide | undefined,
	remote: ConflictSide | undefined
): ConflictDecision {
	if (!local && !remote) return { kind: 'noop' };
	if (local && !remote) return { kind: 'push', reason: 'remote-missing' };
	if (!local && remote) return { kind: 'pull', reason: 'local-missing' };

	// Both present.
	const l = local as ConflictSide;
	const r = remote as ConflictSide;

	if (sidesEquivalent(l, r)) return { kind: 'noop' };

	const cmp = compareTomboyDates(l.changeDate, r.changeDate);
	if (cmp > 0) return { kind: 'push', reason: 'local-newer' };
	if (cmp < 0) return { kind: 'pull', reason: 'remote-newer' };

	// changeDate ties — fall back to metadataChangeDate (covers tag/favorite-only edits).
	const mcmp = compareTomboyDates(l.metadataChangeDate, r.metadataChangeDate);
	if (mcmp > 0) return { kind: 'push', reason: 'local-newer' };
	if (mcmp < 0) return { kind: 'pull', reason: 'remote-newer' };

	// Full timestamp tie but content/tags/deleted disagree → keep what the
	// user is looking at locally.
	return { kind: 'push', reason: 'tie-prefers-local' };
}

/**
 * Compare two Tomboy date strings by absolute instant. Lexical comparison is
 * only valid while every writer emits the same UTC offset — an external
 * writer stamping `+00:00` (e.g. the Pi bridge's UTC container) produced
 * strings whose lexical order contradicted chronological order, letting a
 * stale phone doc "win" over a newer bridge write and silently revert it.
 * When either side doesn't parse, or both map to the same millisecond
 * (Tomboy fractions carry sub-ms digits Date can't hold), fall back to
 * string order — byte-identical behavior to the old comparator for
 * same-offset strings.
 */
function compareTomboyDates(a: string, b: string): number {
	const ta = parseTomboyDateMs(a);
	const tb = parseTomboyDateMs(b);
	if (ta !== null && tb !== null && ta !== tb) return ta < tb ? -1 : 1;
	return a.localeCompare(b);
}

function parseTomboyDateMs(s: string): number | null {
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(s);
	if (!m) return null;
	const ms = Date.parse(`${m[1]}.${(m[2] ?? '').padEnd(3, '0').slice(0, 3)}${m[3]}`);
	return Number.isNaN(ms) ? null : ms;
}

function sidesEquivalent(a: ConflictSide, b: ConflictSide): boolean {
	return (
		a.xmlContent === b.xmlContent &&
		a.deleted === b.deleted &&
		stringArraysEqual(a.tags, b.tags)
	);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
