/**
 * Per-workspace "active" (pinned) notebook sets for the desktop SidePanel,
 * plus the runtime background-click "locked open" toggle.
 *
 * Notebook keys mirror the existing selectedNotebook domain:
 *  - '' = 미분류 (uncategorised)
 *  - non-empty string = notebook name
 *  - 전체 (the "all" filter) is NOT stored here — it is the permanent
 *    fallback and the "clear all" action, never a member of an active set.
 *
 * `sets` is persisted per workspace index (appSettings), mirroring the
 * debounce pattern in sidePanelLayout.svelte.ts. `lockedOpen` is pure
 * runtime state (resets on reload) shared by SidePanel (reveal class) and
 * DesktopWorkspace (canvas background click).
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const STORAGE_KEY = 'desktop:activeNotebooks';
const PERSIST_DEBOUNCE_MS = 300;

let sets = $state<Record<number, string[]>>({});
let lockedOpen = $state(false);
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Deep-copy to plain arrays so fake-indexeddb / structuredClone sees no
// Svelte proxy wrappers when serialising.
function buildSnapshot(): Record<number, string[]> {
	const snapshot: Record<number, string[]> = {};
	for (const [k, v] of Object.entries(sets)) {
		snapshot[Number(k)] = [...v];
	}
	return snapshot;
}

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void setSetting(STORAGE_KEY, buildSnapshot());
	}, PERSIST_DEBOUNCE_MS);
}

export const activeNotebooks = {
	get lockedOpen(): boolean {
		return lockedOpen;
	},

	list(ws: number): string[] {
		return sets[ws] ?? [];
	},

	top(ws: number): string | undefined {
		return sets[ws]?.[0];
	},

	isActive(ws: number, key: string): boolean {
		return (sets[ws] ?? []).includes(key);
	},

	toggle(ws: number, key: string): void {
		const cur = sets[ws] ?? [];
		const next = cur.includes(key)
			? cur.filter((k) => k !== key)
			: [key, ...cur]; // newest pin becomes topmost (= default displayed)
		sets = { ...sets, [ws]: next };
		schedulePersist();
	},

	clear(ws: number): void {
		if (!sets[ws]?.length) return;
		sets = { ...sets, [ws]: [] };
		schedulePersist();
	},

	toggleLockedOpen(): void {
		lockedOpen = !lockedOpen;
	},

	setLockedOpen(v: boolean): void {
		lockedOpen = v;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const stored = await getSetting<Record<number, string[]>>(STORAGE_KEY);
		if (stored && typeof stored === 'object') {
			const clean: Record<number, string[]> = {};
			for (const [k, v] of Object.entries(stored)) {
				const idx = Number(k);
				if (Number.isInteger(idx) && Array.isArray(v)) {
					clean[idx] = v.filter((x): x is string => typeof x === 'string');
				}
			}
			sets = clean;
		}
	},

	/** Test-only: cancel any pending debounced persist and write now (awaitable). */
	async _flushPersist(): Promise<void> {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		await setSetting(STORAGE_KEY, buildSnapshot());
	},

	_reset(): void {
		sets = {};
		lockedOpen = false;
		loaded = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};
