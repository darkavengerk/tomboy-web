import { getNote, findNoteByTitle } from '$lib/core/noteManager.js';
import { getHomeNote } from '$lib/core/home.js';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';

const STORAGE_KEY = 'desktop:session';
const VERSION = 1;

export interface DesktopWindowState {
	guid: string;
	x: number;
	y: number;
	width: number;
	height: number;
	z: number;
}

interface PersistedSession {
	version: number;
	windows: DesktopWindowState[];
}

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const STAGGER = 30;

let windowsState = $state<DesktopWindowState[]>([]);
let nextZ = 1;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hook points for the UI layer to flush pending saves before a window
 * is closed or the session persists. Keyed by guid.
 */
const flushHooks = new Map<string, () => Promise<void> | void>();

export function registerFlushHook(guid: string, fn: () => Promise<void> | void): () => void {
	flushHooks.set(guid, fn);
	return () => {
		if (flushHooks.get(guid) === fn) flushHooks.delete(guid);
	};
}

async function runFlushHook(guid: string): Promise<void> {
	const fn = flushHooks.get(guid);
	if (!fn) return;
	try {
		await fn();
	} catch {
		/* best-effort */
	}
}

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistNow();
	}, 300);
}

async function persistNow(): Promise<void> {
	const snapshot: PersistedSession = {
		version: VERSION,
		windows: windowsState.map((w) => ({ ...w }))
	};
	try {
		await setSetting(STORAGE_KEY, snapshot);
	} catch {
		/* ignore — persistence is best-effort */
	}
}

function nextStaggerPosition(): { x: number; y: number } {
	const baseX = 120;
	const baseY = 80;
	const i = windowsState.length;
	const viewportW = typeof window !== 'undefined' ? window.innerWidth - 300 : 1200;
	const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
	const x = (baseX + i * STAGGER) % Math.max(200, viewportW - DEFAULT_WIDTH);
	const y = (baseY + i * STAGGER) % Math.max(160, viewportH - DEFAULT_HEIGHT);
	return { x, y };
}

function bumpZ(win: DesktopWindowState): void {
	win.z = ++nextZ;
}

export const desktopSession = {
	get windows(): DesktopWindowState[] {
		return windowsState;
	},

	/**
	 * Load persisted session from IndexedDB. Filters out windows whose notes
	 * no longer exist. If nothing to restore, opens the home note.
	 */
	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;

		const persisted = await getSetting<PersistedSession>(STORAGE_KEY);
		if (persisted && Array.isArray(persisted.windows)) {
			const restored: DesktopWindowState[] = [];
			for (const w of persisted.windows) {
				const note = await getNote(w.guid);
				if (!note || note.deleted) continue;
				restored.push({
					guid: w.guid,
					x: Math.max(0, w.x),
					y: Math.max(0, w.y),
					width: Math.max(MIN_WIDTH, w.width),
					height: Math.max(MIN_HEIGHT, w.height),
					z: w.z
				});
			}
			windowsState = restored;
			nextZ = restored.reduce((m, w) => Math.max(m, w.z), 0) + 1;
		}

		if (windowsState.length === 0) {
			const home = await getHomeNote();
			if (home) {
				this.openWindow(home.guid);
			}
		}
	},

	openWindow(guid: string): void {
		const existing = windowsState.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(existing);
			schedulePersist();
			return;
		}
		const { x, y } = nextStaggerPosition();
		windowsState.push({
			guid,
			x,
			y,
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
			z: ++nextZ
		});
		schedulePersist();
	},

	async openByTitle(title: string): Promise<void> {
		const trimmed = title.trim();
		if (!trimmed) return;
		const linked = await findNoteByTitle(trimmed);
		if (!linked || linked.deleted) {
			pushToast(`'${trimmed}' 노트를 찾을 수 없습니다.`, { kind: 'error' });
			return;
		}
		this.openWindow(linked.guid);
	},

	focusWindow(guid: string): void {
		const win = windowsState.find((w) => w.guid === guid);
		if (!win) return;
		// Only bump if not already on top — avoid unnecessary persist churn.
		const topZ = windowsState.reduce((m, w) => Math.max(m, w.z), 0);
		if (win.z === topZ && win.z !== 0) return;
		bumpZ(win);
		schedulePersist();
	},

	async closeWindow(guid: string): Promise<void> {
		await runFlushHook(guid);
		const idx = windowsState.findIndex((w) => w.guid === guid);
		if (idx < 0) return;
		windowsState.splice(idx, 1);
		schedulePersist();
	},

	moveWindow(guid: string, x: number, y: number): void {
		const win = windowsState.find((w) => w.guid === guid);
		if (!win) return;
		win.x = Math.max(0, Math.round(x));
		win.y = Math.max(0, Math.round(y));
		schedulePersist();
	},

	resizeWindow(guid: string, width: number, height: number): void {
		const win = windowsState.find((w) => w.guid === guid);
		if (!win) return;
		win.width = Math.max(MIN_WIDTH, Math.round(width));
		win.height = Math.max(MIN_HEIGHT, Math.round(height));
		schedulePersist();
	},

	/** For tests. */
	_reset(): void {
		windowsState = [];
		nextZ = 1;
		loaded = false;
		flushHooks.clear();
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};

export const DESKTOP_WINDOW_MIN_WIDTH = MIN_WIDTH;
export const DESKTOP_WINDOW_MIN_HEIGHT = MIN_HEIGHT;
