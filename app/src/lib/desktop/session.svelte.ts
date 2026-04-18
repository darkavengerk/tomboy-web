import type { Editor } from '@tiptap/core';
import { getNote, findNoteByTitle } from '$lib/core/noteManager.js';
import { getHomeNote } from '$lib/core/home.js';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';

const STORAGE_KEY = 'desktop:session';
const WALLPAPER_KEY = 'desktop:wallpaper';
const VERSION = 3;
const WORKSPACE_COUNT = 4;

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
	pinned?: boolean;
}

interface GeometrySnapshot {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface WorkspaceState {
	windows: DesktopWindowState[];
	/** Remembered geometry for every guid ever opened in this workspace. */
	geometryByGuid: Record<string, GeometrySnapshot>;
	nextZ: number;
}

// --- Persisted shapes ----------------------------------------------------

interface PersistedV3 {
	version: 3;
	currentWorkspace: number;
	workspaces: Array<{
		windows: Array<
			Partial<DesktopWindowState> &
				Pick<DesktopWindowState, 'guid' | 'x' | 'y' | 'width' | 'height' | 'z'> & {
					pinned?: boolean;
				}
		>;
		geometryByGuid?: Record<string, GeometrySnapshot>;
		nextZ?: number;
	}>;
}

interface PersistedV2 {
	version: number;
	windows: Array<
		Partial<DesktopWindowState> &
			Pick<DesktopWindowState, 'guid' | 'x' | 'y' | 'width' | 'height' | 'z'>
	>;
	geometryByGuid?: Record<string, GeometrySnapshot>;
}

type Persisted = PersistedV3 | PersistedV2;

// --- Defaults ------------------------------------------------------------

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 520;
const DEFAULT_SETTINGS_WIDTH = 460;
const DEFAULT_SETTINGS_HEIGHT = 640;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const STAGGER = 30;
// Width reserved for the SidePanel rail. Note coordinates are stored in
// canvas-local space (the canvas element already excludes this width), so
// this constant is only used to size the usable viewport for staggering —
// it is NOT added to stored x values.
const RAIL_WIDTH = 80;

function emptyWorkspace(): WorkspaceState {
	return { windows: [], geometryByGuid: {}, nextZ: 1 };
}

// --- Module-level state --------------------------------------------------

let workspaces = $state<WorkspaceState[]>(
	Array.from({ length: WORKSPACE_COUNT }, () => emptyWorkspace())
);
let currentWorkspaceIndex = $state(0);
// Incrementing token consumed by NoteWindow to grab keyboard focus + play
// the opened/refocus flash animation. Using a counter (instead of a guid)
// means two consecutive requests for the same window still re-trigger.
let focusRequest = $state<{ guid: string; token: number } | null>(null);
let focusRequestCounter = 0;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const flushHooks = new Map<string, () => Promise<void> | void>();
const editorRegistry = new Map<string, Editor>();

// --- Flush hooks ---------------------------------------------------------

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

async function runAllFlushHooks(guids: Iterable<string>): Promise<void> {
	const tasks: Array<Promise<void> | void> = [];
	for (const guid of guids) {
		const fn = flushHooks.get(guid);
		if (fn) {
			try {
				tasks.push(Promise.resolve(fn()));
			} catch {
				/* best-effort */
			}
		}
	}
	await Promise.all(tasks.map((p) => Promise.resolve(p).catch(() => {})));
}

// --- Persistence ---------------------------------------------------------

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistNow();
	}, 300);
	ensurePersistFlushOnHide();
}

/**
 * Because `schedulePersist` debounces by 300ms, a refresh right after a drag
 * or resize would lose the tail-end geometry if we didn't flush on page
 * hide. This installs (at most once) a `pagehide` + `visibilitychange`
 * listener that cancels the timer and kicks off `persistNow()` synchronously
 * — IndexedDB writes initiated from these handlers are allowed to complete
 * by modern browsers, so the latest state reliably survives a reload.
 */
let flushListenersInstalled = false;
function ensurePersistFlushOnHide(): void {
	if (flushListenersInstalled) return;
	if (typeof window === 'undefined') return;
	flushListenersInstalled = true;
	const flush = () => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
			void persistNow();
		}
	};
	window.addEventListener('pagehide', flush);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flush();
	});
}

async function persistNow(): Promise<void> {
	// Svelte 5 `$state` wraps nested objects and arrays in proxies that
	// IndexedDB's structured-clone algorithm cannot serialise ("DataCloneError:
	// #<Object> could not be cloned"). Shallow spreads (`{ ...w }`) leave
	// deeper objects — e.g. the geometry values inside `geometryByGuid` —
	// still wrapped. `$state.snapshot` returns a plain deep copy, which is
	// safe to persist.
	const snapshot: PersistedV3 = $state.snapshot({
		version: VERSION,
		currentWorkspace: currentWorkspaceIndex,
		workspaces
	}) as PersistedV3;
	try {
		await setSetting(STORAGE_KEY, snapshot);
	} catch {
		/* ignore — persistence is best-effort */
	}
}

// --- Helpers -------------------------------------------------------------

function current(): WorkspaceState {
	return workspaces[currentWorkspaceIndex];
}

function cacheGeometry(ws: WorkspaceState, win: DesktopWindowState): void {
	ws.geometryByGuid[win.guid] = {
		x: win.x,
		y: win.y,
		width: win.width,
		height: win.height
	};
}

function defaultGeometry(ws: WorkspaceState, kind: DesktopWindowKind): GeometrySnapshot {
	if (kind === 'settings') {
		return staggeredFrom(ws, DEFAULT_SETTINGS_WIDTH, DEFAULT_SETTINGS_HEIGHT);
	}
	return staggeredFrom(ws, DEFAULT_WIDTH, DEFAULT_HEIGHT);
}

function staggeredFrom(ws: WorkspaceState, width: number, height: number): GeometrySnapshot {
	const baseX = 40;
	const baseY = 80;
	const i = ws.windows.length;
	const viewportW = typeof window !== 'undefined' ? window.innerWidth - RAIL_WIDTH : 1200;
	const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
	const x = (baseX + i * STAGGER) % Math.max(200, viewportW - width);
	const y = (baseY + i * STAGGER) % Math.max(160, viewportH - height);
	return { x, y, width, height };
}

function bumpZ(ws: WorkspaceState, win: DesktopWindowState): void {
	win.z = ++ws.nextZ;
}

// --- Workspace direction mapping ----------------------------------------

type Dir = 'left' | 'right' | 'up' | 'down';

function neighborIndex(from: number, dir: Dir): number | null {
	// 2x2 layout:  0 1
	//              2 3
	switch (dir) {
		case 'left':
			return from === 1 ? 0 : from === 3 ? 2 : null;
		case 'right':
			return from === 0 ? 1 : from === 2 ? 3 : null;
		case 'up':
			return from === 2 ? 0 : from === 3 ? 1 : null;
		case 'down':
			return from === 0 ? 2 : from === 1 ? 3 : null;
	}
}

// --- Load / migrate ------------------------------------------------------

function restoreWorkspaceFromPersisted(
	raw: {
		windows: PersistedV2['windows'];
		geometryByGuid?: Record<string, GeometrySnapshot>;
		nextZ?: number;
	},
	keepGuids: Set<string>
): WorkspaceState {
	const geometryByGuid = { ...(raw.geometryByGuid ?? {}) };
	const windows: DesktopWindowState[] = [];
	for (const w of raw.windows ?? []) {
		const kind: DesktopWindowKind = w.kind ?? 'note';
		if (kind === 'note' && !keepGuids.has(w.guid)) continue;
		const geom = {
			x: Math.max(0, w.x),
			y: Math.max(0, w.y),
			width: Math.max(MIN_WIDTH, w.width),
			height: Math.max(MIN_HEIGHT, w.height)
		};
		windows.push({ guid: w.guid, kind, ...geom, z: w.z, pinned: w.pinned ?? false });
		geometryByGuid[w.guid] = geom;
	}
	const nextZ =
		typeof raw.nextZ === 'number' && raw.nextZ > 0
			? Math.max(raw.nextZ, windows.reduce((m, w) => Math.max(m, w.z), 0) + 1)
			: windows.reduce((m, w) => Math.max(m, w.z), 0) + 1;
	return { windows, geometryByGuid, nextZ };
}

async function collectExistingGuids(persisted: Persisted): Promise<Set<string>> {
	const guids = new Set<string>();
	const allRaws: PersistedV2['windows'] = [];
	if ('workspaces' in persisted && Array.isArray(persisted.workspaces)) {
		for (const ws of persisted.workspaces) {
			if (Array.isArray(ws?.windows)) allRaws.push(...ws.windows);
		}
	} else if ('windows' in persisted && Array.isArray(persisted.windows)) {
		allRaws.push(...persisted.windows);
	}
	const seen = new Set<string>();
	await Promise.all(
		allRaws.map(async (w) => {
			const kind: DesktopWindowKind = w.kind ?? 'note';
			if (kind !== 'note') return;
			if (seen.has(w.guid)) return;
			seen.add(w.guid);
			const note = await getNote(w.guid);
			if (note && !note.deleted) guids.add(w.guid);
		})
	);
	return guids;
}

async function loadPersisted(): Promise<void> {
	const persisted = (await getSetting<Persisted>(STORAGE_KEY)) as Persisted | undefined;
	if (!persisted) return;

	const keepGuids = await collectExistingGuids(persisted);

	if ('workspaces' in persisted && Array.isArray(persisted.workspaces)) {
		const restored: WorkspaceState[] = [];
		for (let i = 0; i < WORKSPACE_COUNT; i++) {
			const raw = persisted.workspaces[i];
			if (raw && Array.isArray(raw.windows)) {
				restored.push(
					restoreWorkspaceFromPersisted(
						{
							windows: raw.windows,
							geometryByGuid: raw.geometryByGuid,
							nextZ: raw.nextZ
						},
						keepGuids
					)
				);
			} else {
				restored.push(emptyWorkspace());
			}
		}
		workspaces = restored;
		const idx = persisted.currentWorkspace;
		currentWorkspaceIndex =
			typeof idx === 'number' && idx >= 0 && idx < WORKSPACE_COUNT ? idx : 0;
	} else if ('windows' in persisted && Array.isArray(persisted.windows)) {
		// v2 migration: everything lives in workspace 0.
		const migrated: WorkspaceState[] = Array.from({ length: WORKSPACE_COUNT }, () =>
			emptyWorkspace()
		);
		migrated[0] = restoreWorkspaceFromPersisted(
			{ windows: persisted.windows, geometryByGuid: persisted.geometryByGuid },
			keepGuids
		);
		workspaces = migrated;
		currentWorkspaceIndex = 0;
	}
}

// --- Public API ----------------------------------------------------------

export const desktopSession = {
	get windows(): DesktopWindowState[] {
		return workspaces[currentWorkspaceIndex].windows;
	},

	get currentWorkspace(): number {
		return currentWorkspaceIndex;
	},

	get workspaceCount(): number {
		return WORKSPACE_COUNT;
	},

	/** Reactive summary for UI (window counts per workspace). */
	get workspaceSummaries(): Array<{ index: number; windowCount: number }> {
		return workspaces.map((ws, index) => ({ index, windowCount: ws.windows.length }));
	},

	/**
	 * A (guid, token) pair NoteWindow watches to react to "please focus +
	 * flash" signals from open/re-raise actions. The token is the piece
	 * that actually re-triggers reactively — a second open of the same
	 * guid still produces a fresh token.
	 */
	get focusRequest(): { guid: string; token: number } | null {
		return focusRequest;
	},

	/**
	 * Guid of the topmost note window in the current workspace (highest raw
	 * z among kind==='note'), or null if no notes are open. Used by
	 * NoteWindow to show its toolbar only on the focused note — unfocused
	 * notes reclaim the toolbar row for editor content.
	 */
	get focusedNoteGuid(): string | null {
		const ws = current();
		let top: DesktopWindowState | null = null;
		for (const w of ws.windows) {
			if (w.kind !== 'note') continue;
			if (!top || w.z > top.z) top = w;
		}
		return top?.guid ?? null;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		await loadPersisted();
		if (current().windows.length === 0) {
			const home = await getHomeNote();
			if (home) this.openWindow(home.guid);
		}
	},

	openWindow(guid: string): void {
		const ws = current();
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			schedulePersist();
			return;
		}
		const cached = ws.geometryByGuid[guid];
		const geom = cached ?? defaultGeometry(ws, 'note');
		const win: DesktopWindowState = {
			guid,
			kind: 'note',
			x: geom.x,
			y: geom.y,
			width: geom.width,
			height: geom.height,
			z: ++ws.nextZ
		};
		ws.windows.push(win);
		cacheGeometry(ws, win);
		focusRequest = { guid, token: ++focusRequestCounter };
		schedulePersist();
	},

	/**
	 * Opens a window with a caller-specified initial position / size. If the
	 * window is already open it is merely focused. If not, `pos` overrides any
	 * cached geometry (used by Ctrl+L to center new notes on screen).
	 */
	openWindowAt(
		guid: string,
		pos: { x: number; y: number; width?: number; height?: number }
	): void {
		const ws = current();
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			schedulePersist();
			return;
		}
		const width = Math.max(MIN_WIDTH, Math.round(pos.width ?? DEFAULT_WIDTH));
		const height = Math.max(MIN_HEIGHT, Math.round(pos.height ?? DEFAULT_HEIGHT));
		const win: DesktopWindowState = {
			guid,
			kind: 'note',
			x: Math.max(0, Math.round(pos.x)),
			y: Math.max(0, Math.round(pos.y)),
			width,
			height,
			z: ++ws.nextZ
		};
		ws.windows.push(win);
		cacheGeometry(ws, win);
		focusRequest = { guid, token: ++focusRequestCounter };
		schedulePersist();
	},

	openSettings(): void {
		const ws = current();
		const guid = SETTINGS_WINDOW_GUID;
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			schedulePersist();
			return;
		}
		const cached = ws.geometryByGuid[guid];
		const geom = cached ?? defaultGeometry(ws, 'settings');
		const win: DesktopWindowState = {
			guid,
			kind: 'settings',
			x: geom.x,
			y: geom.y,
			width: geom.width,
			height: geom.height,
			z: ++ws.nextZ
		};
		ws.windows.push(win);
		cacheGeometry(ws, win);
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
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		const topZ = ws.windows.reduce((m, w) => Math.max(m, w.z), 0);
		if (win.z === topZ && win.z !== 0) return;
		bumpZ(ws, win);
		schedulePersist();
	},

	async closeWindow(guid: string): Promise<void> {
		await runFlushHook(guid);
		const ws = current();
		const idx = ws.windows.findIndex((w) => w.guid === guid);
		if (idx < 0) return;
		// Snapshot geometry at close so reopening restores the last-known pose
		// even if no move/resize happened during this session.
		cacheGeometry(ws, ws.windows[idx]);
		ws.windows.splice(idx, 1);
		// Chain focus to the most-recently-focused remaining note so ESC can
		// cascade closes. Raw z is already the focus-history stack (bumped by
		// open/focus). Settings is skipped — it doesn't consume focusRequest.
		let next: DesktopWindowState | null = null;
		for (const w of ws.windows) {
			if (w.kind !== 'note') continue;
			if (!next || w.z > next.z) next = w;
		}
		if (next) focusRequest = { guid: next.guid, token: ++focusRequestCounter };
		schedulePersist();
	},

	moveWindow(guid: string, x: number, y: number): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		win.x = Math.max(0, Math.round(x));
		win.y = Math.max(0, Math.round(y));
		cacheGeometry(ws, win);
		schedulePersist();
	},

	resizeWindow(guid: string, width: number, height: number): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		win.width = Math.max(MIN_WIDTH, Math.round(width));
		win.height = Math.max(MIN_HEIGHT, Math.round(height));
		cacheGeometry(ws, win);
		schedulePersist();
	},

	/** Update all four geometry fields atomically (used by 8-way resize). */
	updateGeometry(guid: string, g: { x: number; y: number; width: number; height: number }): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		win.x = Math.max(0, Math.round(g.x));
		win.y = Math.max(0, Math.round(g.y));
		win.width = Math.max(MIN_WIDTH, Math.round(g.width));
		win.height = Math.max(MIN_HEIGHT, Math.round(g.height));
		cacheGeometry(ws, win);
		schedulePersist();
	},

	isPinned(guid: string): boolean {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		return win?.pinned ?? false;
	},

	togglePin(guid: string): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		win.pinned = !win.pinned;
		schedulePersist();
	},

	/** Set z = minZ - 1 where minZ is the minimum z among OTHER windows. */
	sendToBack(guid: string): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		const others = ws.windows.filter((w) => w.guid !== guid);
		if (others.length === 0) return;
		const minZ = others.reduce((m, w) => Math.min(m, w.z), Infinity);
		win.z = minZ - 1;
		schedulePersist();
	},

	async switchWorkspace(index: number): Promise<void> {
		if (index === currentWorkspaceIndex) return;
		if (index < 0 || index >= WORKSPACE_COUNT) return;
		// Flush unsaved edits from all currently visible windows before they
		// unmount.
		const visibleGuids = current().windows.map((w) => w.guid);
		await runAllFlushHooks(visibleGuids);
		currentWorkspaceIndex = index;
		schedulePersist();
	},

	async switchWorkspaceDir(dir: Dir): Promise<void> {
		const next = neighborIndex(currentWorkspaceIndex, dir);
		if (next == null) return;
		await this.switchWorkspace(next);
	},

	/** Register a Tiptap editor instance keyed by window guid. */
	registerEditor(guid: string, editor: Editor): () => void {
		editorRegistry.set(guid, editor);
		return () => {
			if (editorRegistry.get(guid) === editor) editorRegistry.delete(guid);
		};
	},

	/** Look up the Tiptap editor for an open window by guid, if any. */
	getEditorForGuid(guid: string): Editor | null {
		return editorRegistry.get(guid) ?? null;
	},

	/**
	 * Return the (guid, editor) pair whose Tiptap instance currently owns focus.
	 * Used by the Ctrl+L handler to read the active selection.
	 */
	getFocusedEditor(): { guid: string; editor: Editor } | null {
		for (const [guid, editor] of editorRegistry) {
			try {
				if (editor.isFocused) return { guid, editor };
			} catch {
				/* destroyed editor — skip */
			}
		}
		return null;
	},

	_reset(): void {
		workspaces = Array.from({ length: WORKSPACE_COUNT }, () => emptyWorkspace());
		currentWorkspaceIndex = 0;
		focusRequest = null;
		focusRequestCounter = 0;
		loaded = false;
		flushHooks.clear();
		editorRegistry.clear();
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};

// --- Wallpaper -----------------------------------------------------------

export async function loadWallpaper(): Promise<Blob | null> {
	const blob = await getSetting<Blob>(WALLPAPER_KEY);
	return blob ?? null;
}

export async function setWallpaper(file: File): Promise<void> {
	await setSetting(WALLPAPER_KEY, file);
}

export async function clearWallpaper(): Promise<void> {
	await deleteSetting(WALLPAPER_KEY);
}

export const DESKTOP_WINDOW_MIN_WIDTH = MIN_WIDTH;
export const DESKTOP_WINDOW_MIN_HEIGHT = MIN_HEIGHT;
