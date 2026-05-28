/**
 * Local-only favorite-note set.
 *
 * Favorites used to live as a `system:pinned` tag on the .note XML,
 * which made them sync across all devices via Dropbox / Firebase.
 * They are now per-device — stored in appSettings under
 * `local:favorites` as a `Record<guid, true>` and never propagated.
 *
 * Pattern matches `lib/desktop/recentOpens.svelte.ts`: a Svelte 5
 * `$state` module with debounced persistence.
 *
 * No automatic LRU/cap: favorites are explicit user actions, not
 * background telemetry. The set won't grow without the user pressing
 * the toggle.
 */
import { getSetting, setSetting } from './appSettings.js';

const STORAGE_KEY = 'local:favorites';
const PERSIST_DEBOUNCE_MS = 300;

let members = $state<Record<string, true>>({});
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		const snapshot = $state.snapshot(members) as Record<string, true>;
		void setSetting(STORAGE_KEY, snapshot);
	}, PERSIST_DEBOUNCE_MS);
}

export const favoriteStore = {
	has(guid: string): boolean {
		return members[guid] === true;
	},

	toggle(guid: string): boolean {
		if (members[guid]) {
			delete members[guid];
			schedulePersist();
			return false;
		}
		members[guid] = true;
		schedulePersist();
		return true;
	},

	forget(guid: string): void {
		if (members[guid]) {
			delete members[guid];
			schedulePersist();
		}
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const stored = await getSetting<Record<string, true>>(STORAGE_KEY);
		if (stored && typeof stored === 'object') {
			const next: Record<string, true> = {};
			for (const [k, v] of Object.entries(stored)) {
				if (v === true) next[k] = true;
			}
			members = next;
		}
	},

	_reset(): void {
		members = {};
		loaded = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};
