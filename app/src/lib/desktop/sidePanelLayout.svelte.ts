/**
 * Persisted layout for the desktop SidePanel.
 *
 * Two independently user-resizable widths:
 * - railWidth: always-visible left rail (workspace switcher, notebook
 *   chips, settings).
 * - mainWidth: hover-revealed (or always-open in slipnote workspace)
 *   column with search + note list.
 *
 * Both are consumed by SidePanel (rail flex-basis, main flex-basis,
 * total side-panel width, resize-handle x positions) and by
 * DesktopWorkspace (canvas left offset, so notes don't slide under the
 * rail). session.svelte.ts also reads railWidth for staggered window
 * placement math.
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const STORAGE_RAIL_KEY = 'desktop:sidePanelRailWidth';
const STORAGE_MAIN_KEY = 'desktop:sidePanelMainWidth';
const DEFAULT_RAIL_WIDTH = 80;
const DEFAULT_MAIN_WIDTH = 220;
export const RAIL_MIN_WIDTH = 60;
export const RAIL_MAX_WIDTH = 320;
export const MAIN_MIN_WIDTH = 180;
export const MAIN_MAX_WIDTH = 720;
const PERSIST_DEBOUNCE_MS = 300;

let railWidth = $state(DEFAULT_RAIL_WIDTH);
let mainWidth = $state(DEFAULT_MAIN_WIDTH);
let loaded = false;
let railPersistTimer: ReturnType<typeof setTimeout> | null = null;
let mainPersistTimer: ReturnType<typeof setTimeout> | null = null;

function clampRail(px: number): number {
	if (!Number.isFinite(px)) return DEFAULT_RAIL_WIDTH;
	return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.round(px)));
}

function clampMain(px: number): number {
	if (!Number.isFinite(px)) return DEFAULT_MAIN_WIDTH;
	return Math.max(MAIN_MIN_WIDTH, Math.min(MAIN_MAX_WIDTH, Math.round(px)));
}

function scheduleRailPersist(): void {
	if (railPersistTimer) clearTimeout(railPersistTimer);
	railPersistTimer = setTimeout(() => {
		railPersistTimer = null;
		void setSetting(STORAGE_RAIL_KEY, railWidth);
	}, PERSIST_DEBOUNCE_MS);
}

function scheduleMainPersist(): void {
	if (mainPersistTimer) clearTimeout(mainPersistTimer);
	mainPersistTimer = setTimeout(() => {
		mainPersistTimer = null;
		void setSetting(STORAGE_MAIN_KEY, mainWidth);
	}, PERSIST_DEBOUNCE_MS);
}

export const sidePanelLayout = {
	get railWidth(): number {
		return railWidth;
	},

	get mainWidth(): number {
		return mainWidth;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const [rail, main] = await Promise.all([
			getSetting<number>(STORAGE_RAIL_KEY),
			getSetting<number>(STORAGE_MAIN_KEY)
		]);
		if (typeof rail === 'number') railWidth = clampRail(rail);
		if (typeof main === 'number') mainWidth = clampMain(main);
	},

	setRailWidth(px: number): void {
		const next = clampRail(px);
		if (next === railWidth) return;
		railWidth = next;
		scheduleRailPersist();
	},

	setMainWidth(px: number): void {
		const next = clampMain(px);
		if (next === mainWidth) return;
		mainWidth = next;
		scheduleMainPersist();
	},

	_reset(): void {
		railWidth = DEFAULT_RAIL_WIDTH;
		mainWidth = DEFAULT_MAIN_WIDTH;
		loaded = false;
		if (railPersistTimer) {
			clearTimeout(railPersistTimer);
			railPersistTimer = null;
		}
		if (mainPersistTimer) {
			clearTimeout(mainPersistTimer);
			mainPersistTimer = null;
		}
	}
};
