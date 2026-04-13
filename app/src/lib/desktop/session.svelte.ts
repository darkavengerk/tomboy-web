import { getNote, findNoteByTitle } from '$lib/core/noteManager.js';
import { getHomeNote } from '$lib/core/home.js';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';

const STORAGE_KEY = 'desktop:session';
const VERSION = 2;

export type DesktopWindowKind = 'note' | 'settings';

/** Singleton guid used for the settings window. */
export const SETTINGS_WINDOW_GUID = '__settings__';

export interface DesktopWindowState {
	guid: string;
	kind: DesktopWindowKind;
	x: number;
	y: number;
	width: number;
	height: number;
	z: number;
}

interface GeometrySnapshot {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PersistedSession {
	version: number;
	windows: Array<Partial<DesktopWindowState> & Pick<DesktopWindowState, 'guid' | 'x' | 'y' | 'width' | 'height' | 'z'>>;
	/** Remembered geometry for every guid ever opened, so reopening restores it. */
	geometryByGuid?: Record<string, GeometrySnapshot>;
}

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 520;
const DEFAULT_SETTINGS_WIDTH = 460;
const DEFAULT_SETTINGS_HEIGHT = 640;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const STAGGER = 30;

let windowsState = $state<DesktopWindowState[]>([]);
let geometryCache: Record<string, GeometrySnapshot> = {};
let nextZ = 1;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

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
		windows: windowsState.map((w) => ({ ...w })),
		geometryByGuid: { ...geometryCache }
	};
	try {
		await setSetting(STORAGE_KEY, snapshot);
	} catch {
		/* ignore — persistence is best-effort */
	}
}

function cacheGeometry(win: DesktopWindowState): void {
	geometryCache[win.guid] = {
		x: win.x,
		y: win.y,
		width: win.width,
		height: win.height
	};
}

function defaultGeometry(kind: DesktopWindowKind): GeometrySnapshot {
	if (kind === 'settings') {
		return staggeredFrom(DEFAULT_SETTINGS_WIDTH, DEFAULT_SETTINGS_HEIGHT);
	}
	return staggeredFrom(DEFAULT_WIDTH, DEFAULT_HEIGHT);
}

function staggeredFrom(width: number, height: number): GeometrySnapshot {
	const baseX = 120;
	const baseY = 80;
	const i = windowsState.length;
	const viewportW = typeof window !== 'undefined' ? window.innerWidth - 300 : 1200;
	const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
	const x = (baseX + i * STAGGER) % Math.max(200, viewportW - width);
	const y = (baseY + i * STAGGER) % Math.max(160, viewportH - height);
	return { x, y, width, height };
}

function bumpZ(win: DesktopWindowState): void {
	win.z = ++nextZ;
}

export const desktopSession = {
	get windows(): DesktopWindowState[] {
		return windowsState;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;

		const persisted = await getSetting<PersistedSession>(STORAGE_KEY);
		if (persisted) {
			geometryCache = { ...(persisted.geometryByGuid ?? {}) };
			if (Array.isArray(persisted.windows)) {
				const restored: DesktopWindowState[] = [];
				for (const w of persisted.windows) {
					const kind: DesktopWindowKind = w.kind ?? 'note';
					if (kind === 'note') {
						const note = await getNote(w.guid);
						if (!note || note.deleted) continue;
					}
					const geom = {
						x: Math.max(0, w.x),
						y: Math.max(0, w.y),
						width: Math.max(MIN_WIDTH, w.width),
						height: Math.max(MIN_HEIGHT, w.height)
					};
					restored.push({ guid: w.guid, kind, ...geom, z: w.z });
					// Keep geometry cache in sync for any open window, so close+reopen
					// within the same session lands on the last-known position even if
					// we never moved it.
					geometryCache[w.guid] = geom;
				}
				windowsState = restored;
				nextZ = restored.reduce((m, w) => Math.max(m, w.z), 0) + 1;
			}
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
		const cached = geometryCache[guid];
		const geom = cached ?? defaultGeometry('note');
		const win: DesktopWindowState = {
			guid,
			kind: 'note',
			x: geom.x,
			y: geom.y,
			width: geom.width,
			height: geom.height,
			z: ++nextZ
		};
		windowsState.push(win);
		cacheGeometry(win);
		schedulePersist();
	},

	openSettings(): void {
		const guid = SETTINGS_WINDOW_GUID;
		const existing = windowsState.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(existing);
			schedulePersist();
			return;
		}
		const cached = geometryCache[guid];
		const geom = cached ?? defaultGeometry('settings');
		const win: DesktopWindowState = {
			guid,
			kind: 'settings',
			x: geom.x,
			y: geom.y,
			width: geom.width,
			height: geom.height,
			z: ++nextZ
		};
		windowsState.push(win);
		cacheGeometry(win);
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
		const topZ = windowsState.reduce((m, w) => Math.max(m, w.z), 0);
		if (win.z === topZ && win.z !== 0) return;
		bumpZ(win);
		schedulePersist();
	},

	async closeWindow(guid: string): Promise<void> {
		await runFlushHook(guid);
		const idx = windowsState.findIndex((w) => w.guid === guid);
		if (idx < 0) return;
		// Snapshot geometry at close so reopening restores the last-known pose
		// even if no move/resize happened during this session.
		cacheGeometry(windowsState[idx]);
		windowsState.splice(idx, 1);
		schedulePersist();
	},

	moveWindow(guid: string, x: number, y: number): void {
		const win = windowsState.find((w) => w.guid === guid);
		if (!win) return;
		win.x = Math.max(0, Math.round(x));
		win.y = Math.max(0, Math.round(y));
		cacheGeometry(win);
		schedulePersist();
	},

	resizeWindow(guid: string, width: number, height: number): void {
		const win = windowsState.find((w) => w.guid === guid);
		if (!win) return;
		win.width = Math.max(MIN_WIDTH, Math.round(width));
		win.height = Math.max(MIN_HEIGHT, Math.round(height));
		cacheGeometry(win);
		schedulePersist();
	},

	_reset(): void {
		windowsState = [];
		geometryCache = {};
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
