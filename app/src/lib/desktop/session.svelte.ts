import type { Editor } from '@tiptap/core';
import { getNote, findNoteByTitle } from '$lib/core/noteManager.js';
import { getHomeNote } from '$lib/core/home.js';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';
import { recentOpens } from './recentOpens.svelte.js';
import { sidePanelLayout } from './sidePanelLayout.svelte.js';

const STORAGE_KEY = 'desktop:session';
const WALLPAPER_KEY = 'desktop:wallpaper';
const WALLPAPER_MODE_KEY = 'desktop:wallpaper-mode';
const VERSION = 3;
const WORKSPACE_COUNT = 4;
const DRAWER_COUNT = 2; // 0 = F2 (left), 1 = F3 (right)
const DEFAULT_DRAWER_WIDTH = 480;
const DRAWER_MIN_WIDTH = 280;
const DRAWER_MAX_WIDTH = 1200;

/**
 * How a workspace wallpaper image fills the canvas. Mirrors the common
 * desktop-OS options. `contain` is the historical default (the original
 * single-wallpaper render used `object-fit: contain`), so existing wallpapers
 * keep their look until a mode is explicitly chosen.
 *
 * - `cover`   — 채우기: scale to fill, crop overflow
 * - `contain` — 맞춤: scale to fit whole image, letterbox
 * - `fill`    — 확대: stretch to exactly fill (may distort)
 * - `center`  — 가운데: original size, centered
 * - `tile`    — 바둑판식: repeat at original size
 */
export type WallpaperMode = 'cover' | 'contain' | 'fill' | 'center' | 'tile';
const WALLPAPER_MODES: readonly WallpaperMode[] = ['cover', 'contain', 'fill', 'center', 'tile'];
const DEFAULT_WALLPAPER_MODE: WallpaperMode = 'contain';

// Per-note background + window opacity (desktop, LOCAL-ONLY). Keyed by note
// guid. appSettings (IndexedDB) is never synced to Dropbox/Firestore, so these
// visual prefs stay on this device — matching the requested behavior.
const NOTE_BG_KEY = 'note:bg';
const NOTE_BG_MODE_KEY = 'note:bg-mode';
const NOTE_OPACITY_KEY = 'note:opacity';
// Floor on note-window opacity so a note can never be dialed fully invisible
// (and thus impossible to find/click to restore).
const MIN_NOTE_OPACITY = 0.2;

/**
 * 데스크탑 윈도우 z 모델 (CLAUDE.md "z-index 레이어 규약" 참고):
 * 각 윈도우의 z 는 `++nextZ` 로 단조 증가(포커스/열기마다 상승)하고, pinned 윈도우는
 * 렌더 시 z 에 DESKTOP_PINNED_Z 를 더해 항상 비고정 윈도우 위에 둔다. 이 값들은 모두
 * `.canvas`(position:fixed) stacking context **안에서만** 의미가 있다 — 바깥의 `--z-*`
 * 토큰(예: SidePanel=--z-nav, SpreadOverlay=--z-modal)과 숫자로 직접 비교되지 않고,
 * `.canvas` 의 형제 DOM 순서가 밴드 위아래를 결정한다. 따라서 이 오프셋이 아무리 커도
 * 윈도우 스택은 `.canvas` 밖으로 새어 나가지 않는다.
 */
export const DESKTOP_PINNED_Z = 1_000_000;

export type DesktopWindowKind = 'note' | 'settings' | 'admin' | 'history';

/** Singleton guid used for the settings window. */
export const SETTINGS_WINDOW_GUID = '__settings__';

/** Singleton guid used for the admin window. */
export const ADMIN_WINDOW_GUID = '__admin__';

/** Prefix for ephemeral revision-history windows. Source note guid follows. */
export const HISTORY_GUID_PREFIX = '__history__';

export interface DesktopWindowState {
	guid: string;
	kind: DesktopWindowKind;
	x: number;
	y: number;
	width: number;
	height: number;
	z: number;
	pinned?: boolean;
	/**
	 * Minimized windows stay in `windows[]` (so they remain part of the
	 * workspace — F4 spread still sees them) but render hidden. Restored via
	 * the SidePanel 최소화됨 list or an F4-spread card click. Per-workspace by
	 * construction (windows are per-workspace). Persisted (additive optional
	 * field, like `pinned` — no VERSION bump). Desktop-only.
	 */
	minimized?: boolean;
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
// Admin is a wide operator UI (sync dashboard, revision tables), so it
// opens larger than the settings panel.
const DEFAULT_ADMIN_WIDTH = 820;
const DEFAULT_ADMIN_HEIGHT = 680;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
// The SidePanel rail's width is user-resizable and persisted in
// `sidePanelLayout`. Note coordinates stay canvas-local (the canvas
// element already excludes the rail), so the live rail width is only used
// here to size the usable viewport for staggering — it is NOT added to
// stored x values.
function railWidth(): number {
	return sidePanelLayout.railWidth;
}

function emptyWorkspace(): WorkspaceState {
	return { windows: [], geometryByGuid: {}, nextZ: 1 };
}

// --- Module-level state --------------------------------------------------

let workspaces = $state<WorkspaceState[]>(
	Array.from({ length: WORKSPACE_COUNT }, () => emptyWorkspace())
);
let currentWorkspaceIndex = $state(0);
// Drawers are GLOBAL slide-in surfaces (F2 left, F3 right), independent of
// the 2×2 workspaces. Each is structurally a WorkspaceState (own windows[],
// geometryByGuid, nextZ). activeDrawer = which one is open + live (null =
// canvas live). drawerWidths = per-drawer panel extent (px). Persisted in v4.
let drawers = $state<WorkspaceState[]>(
	Array.from({ length: DRAWER_COUNT }, () => emptyWorkspace())
);
let activeDrawer = $state<number | null>(null);
let drawerWidths = $state<number[]>(
	Array.from({ length: DRAWER_COUNT }, () => DEFAULT_DRAWER_WIDTH)
);
// Bumped whenever any workspace's wallpaper is set/cleared. DesktopWorkspace's
// $effect reads `desktopSession.wallpaperEpoch` so re-setting the SAME
// workspace's wallpaper (same currentWorkspace) still triggers a reload.
let wallpaperEpoch = $state(0);
// Bumped whenever any note's background is set/cleared. A NoteWindow reads
// `desktopSession.noteChromeEpoch` so a background change made from another
// component (the image right-click menu) makes the target window reload its
// background. Opacity is set from the window's own menu, so it doesn't need this.
let noteChromeEpoch = $state(0);
// Incrementing token consumed by NoteWindow to grab keyboard focus + play
// the opened/refocus flash animation. Using a counter (instead of a guid)
// means two consecutive requests for the same window still re-trigger.
let focusRequest = $state<{ guid: string; token: number } | null>(null);
let focusRequestCounter = 0;
// Session-only stack of guids closed via closeWindow, most-recent last.
// Alt+Esc pops this to undo an accidental Esc close. Not persisted (a
// "recently" stack only makes sense within the live session) and not a
// `$state` (no UI renders it). Reopen happens in the current workspace.
const closedStack: string[] = [];
const CLOSED_STACK_LIMIT = 50;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const flushHooks = new Map<string, () => Promise<void> | void>();
const reloadHooks = new Map<string, () => Promise<void> | void>();
const editorRegistry = new Map<string, Editor>();

/** Read-only snapshot descriptor a window exposes for 펼쳐보기 (spread view). */
export interface SpreadSnapshot {
	/** Note title for the card header. */
	title: string;
	/** Live content element to clone into the read-only card, or null. */
	el: HTMLElement | null;
}

const snapshotSources = new Map<string, () => SpreadSnapshot | null>();

/**
 * A note window registers a snapshot source so 펼쳐보기 can build a read-only
 * card from the window's live content (the ProseMirror DOM for editor notes, or
 * the window body for terminal/loading windows). Returns an unregister fn.
 */
export function registerSnapshotSource(
	guid: string,
	fn: () => SpreadSnapshot | null
): () => void {
	snapshotSources.set(guid, fn);
	return () => {
		if (snapshotSources.get(guid) === fn) snapshotSources.delete(guid);
	};
}

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

// --- Reload hooks --------------------------------------------------------

/**
 * A window registers a reload hook so cross-window operations (slip-note
 * chain splicing is the motivating case) can force it to discard any
 * pending editor state and re-read the note from IDB. Without this, a
 * stale pendingDoc in another window would overwrite the op's update to
 * a neighbor note on its next debounced save.
 */
export function registerReloadHook(
	guid: string,
	fn: () => Promise<void> | void
): () => void {
	reloadHooks.set(guid, fn);
	return () => {
		if (reloadHooks.get(guid) === fn) reloadHooks.delete(guid);
	};
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
	const sanitizedWorkspaces = workspaces.map((ws) => ({
		...ws,
		windows: ws.windows.filter((w) => w.kind !== 'history')
	}));
	const snapshot: PersistedV3 = $state.snapshot({
		version: VERSION,
		currentWorkspace: currentWorkspaceIndex,
		workspaces: sanitizedWorkspaces
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

function defaultGeometry(kind: DesktopWindowKind): GeometrySnapshot {
	if (kind === 'settings') {
		return centeredFor(DEFAULT_SETTINGS_WIDTH, DEFAULT_SETTINGS_HEIGHT);
	}
	if (kind === 'admin') {
		return centeredFor(DEFAULT_ADMIN_WIDTH, DEFAULT_ADMIN_HEIGHT);
	}
	return centeredFor(DEFAULT_WIDTH, DEFAULT_HEIGHT);
}

/**
 * Default geometry for a freshly-opened window with no cached pose: centered
 * within the canvas (viewport minus the side rail). When the viewport is
 * narrower than the requested size, the window pins to the canvas's top-left
 * so we don't return negative coordinates.
 */
function centeredFor(width: number, height: number): GeometrySnapshot {
	const viewportW = typeof window !== 'undefined' ? window.innerWidth - railWidth() : 1200;
	const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
	const x = Math.max(0, Math.round((viewportW - width) / 2));
	const y = Math.max(0, Math.round((viewportH - height) / 2));
	return { x, y, width, height };
}

function bumpZ(ws: WorkspaceState, win: DesktopWindowState): void {
	win.z = ++ws.nextZ;
}

function clampDrawerWidth(px: number): number {
	if (!Number.isFinite(px)) return DEFAULT_DRAWER_WIDTH;
	return Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.round(px)));
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
		windows.push({
			guid: w.guid,
			kind,
			...geom,
			z: w.z,
			pinned: w.pinned ?? false,
			minimized: w.minimized ?? false
		});
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

	/**
	 * Every (workspaceIndex, window) pair across all workspaces. The
	 * DesktopWorkspace renders the union and hides non-active workspaces
	 * via CSS — keeping editor instances, TipTap state, and terminal WS
	 * connections alive across workspace switches. Per-window
	 * Firebase attach + global editor registration are gated on
	 * `active` so only the visible workspace is "live".
	 */
	get allWorkspaceWindows(): Array<{ workspaceIndex: number; window: DesktopWindowState }> {
		const out: Array<{ workspaceIndex: number; window: DesktopWindowState }> = [];
		for (let i = 0; i < workspaces.length; i++) {
			for (const w of workspaces[i].windows) {
				out.push({ workspaceIndex: i, window: w });
			}
		}
		return out;
	},

	get currentWorkspace(): number {
		return currentWorkspaceIndex;
	},

	get activeDrawer(): number | null {
		return activeDrawer;
	},

	get drawerCount(): number {
		return DRAWER_COUNT;
	},

	isDrawerOpen(index: number): boolean {
		return activeDrawer === index;
	},

	/** Windows in drawer `index` (empty for an out-of-range index). */
	drawerWindows(index: number): DesktopWindowState[] {
		return drawers[index]?.windows ?? [];
	},

	getDrawerWidth(index: number): number {
		return drawerWidths[index] ?? DEFAULT_DRAWER_WIDTH;
	},

	setDrawerWidth(index: number, px: number): void {
		if (index < 0 || index >= DRAWER_COUNT) return;
		const next = clampDrawerWidth(px);
		if (next === drawerWidths[index]) return;
		drawerWidths[index] = next;
		schedulePersist();
	},

	/**
	 * Open drawer `index` if closed, close it if it's the open one, or switch to
	 * it if the OTHER drawer is open. Only one drawer is visible at a time.
	 * Opening makes it the live surface (canvas goes inactive but stays mounted).
	 */
	toggleDrawer(index: number): void {
		if (index < 0 || index >= DRAWER_COUNT) return;
		activeDrawer = activeDrawer === index ? null : index;
	},

	closeDrawer(): void {
		activeDrawer = null;
	},

	get wallpaperEpoch(): number {
		return wallpaperEpoch;
	},

	get noteChromeEpoch(): number {
		return noteChromeEpoch;
	},

	/** Set the wallpaper (and optionally its display mode) for the currently-active workspace. */
	async setWallpaperForCurrent(blob: Blob, mode?: WallpaperMode): Promise<void> {
		await setWallpaper(blob, currentWorkspaceIndex, mode);
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
	 * Guid of the topmost note window on the ACTIVE surface (highest raw z
	 * among kind==='note', non-minimized). When a drawer is open it is the
	 * live surface; otherwise the current workspace canvas. Used by NoteWindow
	 * to show its toolbar only on the focused note — unfocused notes reclaim
	 * the toolbar row for editor content.
	 */
	get focusedNoteGuid(): string | null {
		const ws = activeDrawer !== null ? drawers[activeDrawer] : current();
		let top: DesktopWindowState | null = null;
		for (const w of ws.windows) {
			if (w.kind !== 'note') continue;
			if (w.minimized) continue;
			if (!top || w.z > top.z) top = w;
		}
		return top?.guid ?? null;
	},

	/**
	 * Minimized note windows in the current workspace, most-recently-minimized
	 * first. Ordering is z-descending: clicking the minimize button raises the
	 * window (handleWindowPointerDown → onfocus) before minimizing, so the
	 * just-minimized note holds the highest z and sorts to the top — the
	 * 제일 상단 the SidePanel 최소화됨 list wants. Per-workspace by construction.
	 */
	get minimizedWindows(): DesktopWindowState[] {
		return current()
			.windows.filter((w) => w.kind === 'note' && w.minimized)
			.slice()
			.sort((a, b) => b.z - a.z);
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		await Promise.all([loadPersisted(), recentOpens.load(), sidePanelLayout.load()]);
		if (current().windows.length === 0) {
			const home = await getHomeNote();
			if (home) this.openWindow(home.guid);
		}
	},

	openWindow(guid: string): void {
		const ws = current();
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			// Re-opening a minimized note restores it (otherwise it would stay
			// hidden yet receive focus). Common path: clicking the note in the
			// SidePanel main list while it's minimized.
			existing.minimized = false;
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			recentOpens.record(guid);
			schedulePersist();
			return;
		}
		const cached = ws.geometryByGuid[guid];
		const geom = cached ?? defaultGeometry('note');
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
		recentOpens.record(guid);
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
			// Re-opening a minimized note restores it (otherwise it would stay
			// hidden yet receive focus). Common path: clicking the note in the
			// SidePanel main list while it's minimized.
			existing.minimized = false;
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			recentOpens.record(guid);
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
		recentOpens.record(guid);
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
		const geom = cached ?? defaultGeometry('settings');
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

	openAdmin(): void {
		const ws = current();
		const guid = ADMIN_WINDOW_GUID;
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			schedulePersist();
			return;
		}
		const cached = ws.geometryByGuid[guid];
		const geom = cached ?? defaultGeometry('admin');
		const win: DesktopWindowState = {
			guid,
			kind: 'admin',
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

	/**
	 * Open an ephemeral revision-history window for `sourceGuid`, placed
	 * directly to the right of the source window at the SAME size. Singleton
	 * per source note; reopening just focuses. No-ops if the source isn't open.
	 */
	openHistory(sourceGuid: string): void {
		const ws = current();
		const source = ws.windows.find((w) => w.guid === sourceGuid);
		if (!source) return;
		const guid = `${HISTORY_GUID_PREFIX}${sourceGuid}`;
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			schedulePersist();
			return;
		}
		const width = source.width;
		const height = source.height;
		const viewportW =
			typeof window !== 'undefined' ? window.innerWidth - railWidth() : 1200;
		const maxX = Math.max(0, viewportW - width);
		const x = Math.max(0, Math.min(source.x + source.width, maxX));
		const y = Math.max(0, source.y);
		const win: DesktopWindowState = {
			guid,
			kind: 'history',
			x: Math.round(x),
			y: Math.round(y),
			width,
			height,
			z: ++ws.nextZ
		};
		ws.windows.push(win);
		// Intentionally NOT cacheGeometry'd / recorded in recents: ephemeral.
		focusRequest = { guid, token: ++focusRequestCounter };
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

	/**
	 * Open (or move) the note with the given title so it sits directly to the
	 * LEFT of the source window — mirror of `openRightOf`, used by the
	 * date-arrow "이전" button so prev/next navigation produces a symmetric
	 * cascade. Clamps to the viewport's left edge (x ≥ 0) when the desired
	 * x would overflow. Applies to already-open windows too (repositioned
	 * and raised).
	 */
	async openLeftOf(fromGuid: string, targetTitle: string): Promise<void> {
		const trimmed = targetTitle.trim();
		if (!trimmed) return;
		const linked = await findNoteByTitle(trimmed);
		if (!linked || linked.deleted) {
			pushToast(`'${trimmed}' 노트를 찾을 수 없습니다.`, { kind: 'error' });
			return;
		}
		const ws = current();
		const source = ws.windows.find((w) => w.guid === fromGuid);
		if (!source) {
			this.openWindow(linked.guid);
			return;
		}
		const existing = ws.windows.find((w) => w.guid === linked.guid);
		const cached = ws.geometryByGuid[linked.guid];
		const width = existing?.width ?? cached?.width ?? DEFAULT_WIDTH;
		const height = existing?.height ?? cached?.height ?? DEFAULT_HEIGHT;
		const x = Math.max(0, source.x - width);
		const y = Math.max(0, source.y);

		if (existing) {
			existing.minimized = false;
			existing.x = Math.round(x);
			existing.y = Math.round(y);
			cacheGeometry(ws, existing);
			bumpZ(ws, existing);
		} else {
			const win: DesktopWindowState = {
				guid: linked.guid,
				kind: 'note',
				x: Math.round(x),
				y: Math.round(y),
				width,
				height,
				z: ++ws.nextZ
			};
			ws.windows.push(win);
			cacheGeometry(ws, win);
		}
		focusRequest = { guid: linked.guid, token: ++focusRequestCounter };
		recentOpens.record(linked.guid);
		schedulePersist();
	},

	/**
	 * Replace the source window with the target note: open the target at
	 * the source's top-left and close the source. Used by Ctrl+click on a
	 * slip-note / date-note arrow (and Ctrl+,/Ctrl+. shortcuts) so the user
	 * can step through a chain without piling up windows. The new note keeps
	 * its own preferred size (cached or default); the alignment is top-left
	 * with the source.
	 */
	async openReplacing(fromGuid: string, targetTitle: string): Promise<void> {
		const trimmed = targetTitle.trim();
		if (!trimmed) return;
		const linked = await findNoteByTitle(trimmed);
		if (!linked || linked.deleted) {
			pushToast(`'${trimmed}' 노트를 찾을 수 없습니다.`, { kind: 'error' });
			return;
		}
		if (linked.guid === fromGuid) return;
		const ws = current();
		const source = ws.windows.find((w) => w.guid === fromGuid);
		if (!source) {
			this.openWindow(linked.guid);
			return;
		}
		const x = Math.max(0, Math.round(source.x));
		const y = Math.max(0, Math.round(source.y));

		const existing = ws.windows.find((w) => w.guid === linked.guid);
		if (existing) {
			existing.minimized = false;
			existing.x = x;
			existing.y = y;
			cacheGeometry(ws, existing);
			bumpZ(ws, existing);
		} else {
			const cached = ws.geometryByGuid[linked.guid];
			const width = cached?.width ?? DEFAULT_WIDTH;
			const height = cached?.height ?? DEFAULT_HEIGHT;
			const win: DesktopWindowState = {
				guid: linked.guid,
				kind: 'note',
				x,
				y,
				width,
				height,
				z: ++ws.nextZ
			};
			ws.windows.push(win);
			cacheGeometry(ws, win);
		}
		focusRequest = { guid: linked.guid, token: ++focusRequestCounter };
		recentOpens.record(linked.guid);

		// Close the source window after the target is placed. Flush its
		// pending edits first (mirrors closeWindow) so we never lose typed
		// content. Geometry is already cached on the source's previous
		// move/resize, so reopening it later restores its pose.
		await runFlushHook(fromGuid);
		const idx = ws.windows.findIndex((w) => w.guid === fromGuid);
		if (idx >= 0) {
			cacheGeometry(ws, ws.windows[idx]);
			ws.windows.splice(idx, 1);
		}
		schedulePersist();
	},

	/**
	 * Open (or move) the note with the given title so it sits directly to the
	 * right of the source window — used by the slip-note "다음" arrow so a
	 * chain of notes cascades left-to-right without overlap. Clamps to the
	 * viewport's right edge when the desired x would overflow. Applies to
	 * already-open windows too (they are repositioned and raised).
	 */
	async openRightOf(fromGuid: string, targetTitle: string): Promise<void> {
		const trimmed = targetTitle.trim();
		if (!trimmed) return;
		const linked = await findNoteByTitle(trimmed);
		if (!linked || linked.deleted) {
			pushToast(`'${trimmed}' 노트를 찾을 수 없습니다.`, { kind: 'error' });
			return;
		}
		const ws = current();
		const source = ws.windows.find((w) => w.guid === fromGuid);
		if (!source) {
			this.openWindow(linked.guid);
			return;
		}
		const existing = ws.windows.find((w) => w.guid === linked.guid);
		const cached = ws.geometryByGuid[linked.guid];
		const width = existing?.width ?? cached?.width ?? DEFAULT_WIDTH;
		const height = existing?.height ?? cached?.height ?? DEFAULT_HEIGHT;
		const viewportW =
			typeof window !== 'undefined' ? window.innerWidth - railWidth() : 1200;
		const maxX = Math.max(0, viewportW - width);
		const x = Math.max(0, Math.min(source.x + source.width, maxX));
		const y = Math.max(0, source.y);

		if (existing) {
			existing.minimized = false;
			existing.x = Math.round(x);
			existing.y = Math.round(y);
			cacheGeometry(ws, existing);
			bumpZ(ws, existing);
		} else {
			const win: DesktopWindowState = {
				guid: linked.guid,
				kind: 'note',
				x: Math.round(x),
				y: Math.round(y),
				width,
				height,
				z: ++ws.nextZ
			};
			ws.windows.push(win);
			cacheGeometry(ws, win);
		}
		focusRequest = { guid: linked.guid, token: ++focusRequestCounter };
		recentOpens.record(linked.guid);
		schedulePersist();
	},

	focusWindow(guid: string): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		// Recents track every focus on a note window — clicking an already
		// raised note still bumps it to the top of the SidePanel list. Done
		// before the already-on-top early return so the timestamp updates
		// even when no z-bump is needed.
		if (win.kind === 'note') recentOpens.record(guid);
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
		const closedKind = ws.windows[idx].kind;
		ws.windows.splice(idx, 1);
		// Close any ephemeral history window bound to this note — it would
		// otherwise float with no source.
		if (closedKind === 'note') {
			const histGuid = `${HISTORY_GUID_PREFIX}${guid}`;
			const hidx = ws.windows.findIndex((w) => w.guid === histGuid);
			if (hidx >= 0) ws.windows.splice(hidx, 1);
		}
		// Remember note closes so Alt+Esc can reopen the last one. Settings /
		// admin are singletons reopened from the rail, so they're skipped.
		// De-dupe to keep the most recent position when a guid is closed twice.
		if (closedKind === 'note') {
			const dup = closedStack.indexOf(guid);
			if (dup >= 0) closedStack.splice(dup, 1);
			closedStack.push(guid);
			if (closedStack.length > CLOSED_STACK_LIMIT) closedStack.shift();
		}
		// Chain focus to the most-recently-focused remaining note so ESC can
		// cascade closes. Raw z is already the focus-history stack (bumped by
		// open/focus). Settings is skipped — it doesn't consume focusRequest.
		let next: DesktopWindowState | null = null;
		for (const w of ws.windows) {
			if (w.kind !== 'note' || w.minimized) continue;
			if (!next || w.z > next.z) next = w;
		}
		if (next) focusRequest = { guid: next.guid, token: ++focusRequestCounter };
		schedulePersist();
	},

	/**
	 * Reopen the most recently closed note (Alt+Esc — undo an accidental Esc
	 * close). Pops the closed-stack, skipping guids that are already open in
	 * the current workspace or whose note has since been deleted, until a
	 * reopenable one is found. No-op when the stack is exhausted.
	 */
	async reopenLastClosed(): Promise<void> {
		while (closedStack.length > 0) {
			const guid = closedStack.pop();
			if (!guid) continue;
			if (current().windows.some((w) => w.guid === guid)) continue;
			const note = await getNote(guid);
			if (!note || note.deleted) continue;
			this.openWindow(guid);
			return;
		}
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

	isMinimized(guid: string): boolean {
		const win = current().windows.find((w) => w.guid === guid);
		return win?.minimized ?? false;
	},

	/**
	 * Hide a note window without closing it. It stays in `windows[]` (still part
	 * of the workspace → F4 spread still shows it) but renders `display:none`,
	 * keeping its editor / terminal / Firebase / snapshot alive. If it was the
	 * focused note, focus chains to the next topmost non-minimized note (mirror
	 * of closeWindow) so Esc / keyboard targets a visible window. No flush hook
	 * needed — nothing is torn down. Only note windows minimize.
	 */
	minimizeWindow(guid: string): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win || win.kind !== 'note' || win.minimized) return;
		win.minimized = true;
		// Chain focus to the most-recently-focused remaining visible note.
		let next: DesktopWindowState | null = null;
		for (const w of ws.windows) {
			if (w.kind !== 'note' || w.minimized) continue;
			if (!next || w.z > next.z) next = w;
		}
		if (next) focusRequest = { guid: next.guid, token: ++focusRequestCounter };
		schedulePersist();
	},

	/**
	 * Bring a minimized window back: clear the flag, raise it, focus + flash.
	 * Superset of focusWindow, so it also serves the F4-spread-card click on a
	 * non-minimized note (just raises + focuses, the clear is a no-op).
	 */
	restoreWindow(guid: string): void {
		const ws = current();
		const win = ws.windows.find((w) => w.guid === guid);
		if (!win) return;
		win.minimized = false;
		bumpZ(ws, win);
		if (win.kind === 'note') recentOpens.record(guid);
		focusRequest = { guid, token: ++focusRequestCounter };
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

	/**
	 * Drain every registered flush hook. Used before a multi-note IDB
	 * mutation (slip-note chain op) so any window's pending edits land
	 * first and the op reads fresh state. A hook that throws — sync or
	 * async — cannot block the others; a broken window must never stall
	 * a chain op.
	 */
	async flushAll(): Promise<void> {
		const tasks: Array<Promise<void>> = [];
		for (const fn of flushHooks.values()) {
			tasks.push(
				(async () => fn())().catch(() => {})
			);
		}
		await Promise.all(tasks);
	},

	/**
	 * Force reload the given guids' open windows from IDB. Windows whose
	 * guid isn't currently open are silently skipped.
	 */
	async reloadWindows(guids: Iterable<string>): Promise<void> {
		const tasks: Array<Promise<void>> = [];
		for (const guid of guids) {
			const fn = reloadHooks.get(guid);
			if (!fn) continue;
			tasks.push(
				(async () => fn())().catch(() => {})
			);
		}
		await Promise.all(tasks);
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

	/** Resolve the snapshot (title + clonable element) for an open window. */
	getSnapshotSource(guid: string): SpreadSnapshot | null {
		return snapshotSources.get(guid)?.() ?? null;
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
		drawers = Array.from({ length: DRAWER_COUNT }, () => emptyWorkspace());
		activeDrawer = null;
		drawerWidths = Array.from({ length: DRAWER_COUNT }, () => DEFAULT_DRAWER_WIDTH);
		focusRequest = null;
		focusRequestCounter = 0;
		closedStack.length = 0;
		loaded = false;
		flushHooks.clear();
		reloadHooks.clear();
		editorRegistry.clear();
		snapshotSources.clear();
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};

// --- Wallpaper -----------------------------------------------------------

/**
 * Load workspace `i`'s wallpaper. Falls back to the legacy global
 * `desktop:wallpaper` key (pre-per-workspace) when the workspace has none,
 * so existing users keep their wallpaper on every workspace until they set
 * a per-workspace one.
 */
export async function loadWallpaper(i: number): Promise<Blob | null> {
	const own = await getSetting<Blob>(`${WALLPAPER_KEY}:${i}`);
	if (own) return own;
	const legacy = await getSetting<Blob>(WALLPAPER_KEY);
	return legacy ?? null;
}

export async function setWallpaper(blob: Blob, i: number, mode?: WallpaperMode): Promise<void> {
	await setSetting(`${WALLPAPER_KEY}:${i}`, blob);
	if (mode) await setSetting(`${WALLPAPER_MODE_KEY}:${i}`, mode);
	wallpaperEpoch += 1;
}

export async function clearWallpaper(i: number): Promise<void> {
	await deleteSetting(`${WALLPAPER_KEY}:${i}`);
	await deleteSetting(`${WALLPAPER_MODE_KEY}:${i}`);
	wallpaperEpoch += 1;
}

/**
 * Load workspace `i`'s wallpaper display mode. Unlike the wallpaper blob, the
 * mode does NOT fall back to a legacy global — there was none — so an unset or
 * unrecognized value resolves to {@link DEFAULT_WALLPAPER_MODE} (`contain`),
 * preserving the original render for wallpapers set before modes existed.
 */
export async function loadWallpaperMode(i: number): Promise<WallpaperMode> {
	const stored = await getSetting<WallpaperMode>(`${WALLPAPER_MODE_KEY}:${i}`);
	return stored && WALLPAPER_MODES.includes(stored) ? stored : DEFAULT_WALLPAPER_MODE;
}

// --- Per-note background + opacity (desktop, local-only) -----------------

export async function loadNoteBg(guid: string): Promise<Blob | null> {
	return (await getSetting<Blob>(`${NOTE_BG_KEY}:${guid}`)) ?? null;
}

export async function loadNoteBgMode(guid: string): Promise<WallpaperMode> {
	const stored = await getSetting<WallpaperMode>(`${NOTE_BG_MODE_KEY}:${guid}`);
	return stored && WALLPAPER_MODES.includes(stored) ? stored : DEFAULT_WALLPAPER_MODE;
}

export async function setNoteBg(guid: string, blob: Blob, mode: WallpaperMode): Promise<void> {
	await setSetting(`${NOTE_BG_KEY}:${guid}`, blob);
	await setSetting(`${NOTE_BG_MODE_KEY}:${guid}`, mode);
	noteChromeEpoch += 1;
}

export async function clearNoteBg(guid: string): Promise<void> {
	await deleteSetting(`${NOTE_BG_KEY}:${guid}`);
	await deleteSetting(`${NOTE_BG_MODE_KEY}:${guid}`);
	noteChromeEpoch += 1;
}

/** Per-note window opacity, clamped to [MIN_NOTE_OPACITY, 1]. Defaults to 1 (opaque). */
export async function loadNoteOpacity(guid: string): Promise<number> {
	const v = await getSetting<number>(`${NOTE_OPACITY_KEY}:${guid}`);
	if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
	return Math.min(1, Math.max(MIN_NOTE_OPACITY, v));
}

export async function setNoteOpacity(guid: string, value: number): Promise<void> {
	const clamped = Math.min(1, Math.max(MIN_NOTE_OPACITY, value));
	await setSetting(`${NOTE_OPACITY_KEY}:${guid}`, clamped);
}

export const DESKTOP_WINDOW_MIN_WIDTH = MIN_WIDTH;
export const DESKTOP_WINDOW_MIN_HEIGHT = MIN_HEIGHT;
