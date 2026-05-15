/**
 * Per-browser persistence for the HR split-layout feature.
 *
 * Active splits are keyed by note guid + HR ordinal (0-based index among HRs
 * in the note). The ordinal is stable across edits within HRs, but shifts if
 * the user inserts/deletes an HR — acceptable for an ephemeral view state.
 *
 * Storage is plain localStorage, scoped per browser. Never synced.
 */

const KEY_PREFIX = 'tomboy.hrSplit.';
const WIDTHS_KEY_PREFIX = 'tomboy.hrSplit.widths.';

function storageKey(guid: string): string {
	return KEY_PREFIX + guid;
}

function widthsKey(guid: string): string {
	return WIDTHS_KEY_PREFIX + guid;
}

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function loadActiveOrdinals(guid: string | null): Set<number> {
	if (!guid) return new Set();
	const ls = safeStorage();
	if (!ls) return new Set();
	const raw = ls.getItem(storageKey(guid));
	if (!raw) return new Set();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		const out = new Set<number>();
		for (const v of parsed) {
			if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out.add(v);
		}
		return out;
	} catch {
		return new Set();
	}
}

export function saveActiveOrdinals(guid: string | null, ordinals: ReadonlySet<number>): void {
	if (!guid) return;
	const ls = safeStorage();
	if (!ls) return;
	try {
		if (ordinals.size === 0) {
			ls.removeItem(storageKey(guid));
		} else {
			const arr = Array.from(ordinals).sort((a, b) => a - b);
			ls.setItem(storageKey(guid), JSON.stringify(arr));
		}
	} catch {
		// Quota exceeded or storage disabled — silently no-op; the split is
		// still visible for this session.
	}
}

/**
 * Per-column fr fractions for the active split, persisted alongside the
 * active ordinals but in a separate localStorage entry. Returns `null`
 * when nothing is stored, the JSON is malformed, or any entry is not a
 * positive finite number — callers fall back to equal-width columns.
 */
export function loadColumnWidths(guid: string | null): number[] | null {
	if (!guid) return null;
	const ls = safeStorage();
	if (!ls) return null;
	const raw = ls.getItem(widthsKey(guid));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length < 2) return null;
		const out: number[] = [];
		for (const v of parsed) {
			if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
			out.push(v);
		}
		return out;
	} catch {
		return null;
	}
}

export function saveColumnWidths(
	guid: string | null,
	widths: ReadonlyArray<number>
): void {
	if (!guid) return;
	const ls = safeStorage();
	if (!ls) return;
	try {
		// Drop trivial / invalid widths so a freshly toggled split starts at
		// the default equal layout. Two columns at 1:1 are considered trivial.
		const trivial =
			widths.length < 2 ||
			widths.some(w => !Number.isFinite(w) || w <= 0) ||
			widths.every(w => Math.abs(w - widths[0]) < 1e-6);
		if (trivial) {
			ls.removeItem(widthsKey(guid));
			return;
		}
		ls.setItem(widthsKey(guid), JSON.stringify(widths));
	} catch {
		// Quota exceeded or storage disabled — silently no-op.
	}
}
