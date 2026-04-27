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

	const cmp = l.changeDate.localeCompare(r.changeDate);
	if (cmp > 0) return { kind: 'push', reason: 'local-newer' };
	if (cmp < 0) return { kind: 'pull', reason: 'remote-newer' };

	// changeDate ties — fall back to metadataChangeDate (covers tag/favorite-only edits).
	const mcmp = l.metadataChangeDate.localeCompare(r.metadataChangeDate);
	if (mcmp > 0) return { kind: 'push', reason: 'local-newer' };
	if (mcmp < 0) return { kind: 'pull', reason: 'remote-newer' };

	// Full timestamp tie but content/tags/deleted disagree → keep what the
	// user is looking at locally.
	return { kind: 'push', reason: 'tie-prefers-local' };
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
