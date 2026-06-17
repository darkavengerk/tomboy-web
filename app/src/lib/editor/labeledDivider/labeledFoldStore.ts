/**
 * Per-browser persistence for the labeled-divider list accordion.
 *
 * Focused dividers are keyed by note guid + labeled-divider ordinal (same
 * numbering as assignAccordion). The ordinal shifts if the user
 * inserts/removes a divider — acceptable for ephemeral view state.
 *
 * Plain localStorage, scoped per browser. Never synced, never in `.note`.
 */

const KEY_PREFIX = 'tomboy.labeledFold.';

function storageKey(guid: string): string {
	return KEY_PREFIX + guid;
}

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function loadFocusedOrdinals(guid: string | null): Set<number> {
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

export function saveFocusedOrdinals(
	guid: string | null,
	ordinals: ReadonlySet<number>
): void {
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
		/* quota / disabled — fold still visible this session */
	}
}
