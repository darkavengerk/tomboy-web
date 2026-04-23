/**
 * Local-only "recently opened" timestamps for desktop note windows.
 *
 * Used by the SidePanel hover list to surface the notes the user has
 * actually been working with — `note.changeDate` only tracks edits, so
 * read-only revisits would otherwise sink to the bottom.
 *
 * Persisted via appSettings under `desktop:recentOpens`. Not synced to
 * Dropbox: this is a per-device UX hint.
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const STORAGE_KEY = 'desktop:recentOpens';
// Cap stored entries so the map can't grow unbounded over years of use.
// 200 comfortably covers the 50-item SidePanel cap with headroom.
const MAX_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 300;

let openedAt = $state<Record<string, number>>({});
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		const snapshot = $state.snapshot(openedAt) as Record<string, number>;
		void setSetting(STORAGE_KEY, snapshot);
	}, PERSIST_DEBOUNCE_MS);
}

function trim(): void {
	const keys = Object.keys(openedAt);
	if (keys.length <= MAX_ENTRIES) return;
	const kept = keys
		.map((k) => [k, openedAt[k]] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_ENTRIES);
	const next: Record<string, number> = {};
	for (const [k, v] of kept) next[k] = v;
	openedAt = next;
}

export const recentOpens = {
	/** Reactive map of guid → epoch ms of last open. */
	get map(): Record<string, number> {
		return openedAt;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const stored = await getSetting<Record<string, number>>(STORAGE_KEY);
		if (stored && typeof stored === 'object') openedAt = { ...stored };
	},

	/** Record an open/focus event for the given guid. */
	record(guid: string): void {
		openedAt[guid] = Date.now();
		trim();
		schedulePersist();
	},

	/** Drop the entry for a deleted/forgotten note. */
	forget(guid: string): void {
		if (guid in openedAt) {
			delete openedAt[guid];
			schedulePersist();
		}
	},

	_reset(): void {
		openedAt = {};
		loaded = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};
