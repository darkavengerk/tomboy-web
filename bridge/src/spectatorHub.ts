/**
 * SpectatorHub: shared ssh + tmux -CC client per (target, session). Multiple
 * SpectatorSubscriptions (one per WS) can attach to the same hub and each
 * subscribe to a different pane independently. tmux -CC already streams
 * %output for all panes in the session — this hub fans those out to
 * matching subscriptions instead of dropping non-active pane bytes.
 *
 * Lifecycle:
 *   SpectatorHubRegistry.subscribe(target, session, callbacks)
 *     → first call: spawn ssh, create hub, register in Map, return subscription
 *     → subsequent calls with same hubKey: reuse existing hub
 *   subscription.close()
 *     → refcount--; when 0: hub.destroy() → ssh.kill + tmux.close + socket unlink
 *   ssh.on('exit')
 *     → all subscriptions get callbacks.exit(reason), hub destroyed
 *
 * State caching (Task 2): bootstrap() queries tmux and populates
 * sessionId/windowId/activePaneId/paneStates/currentWindowPaneOrder.
 * tmux events (%window-pane-changed, %session-window-changed, %layout-change,
 * %output) are handled after bootstrap and fan out to listener Sets.
 *
 * Pin/unpin and subscription modes are added in Tasks 3–4.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TmuxControlClient } from './tmuxControlClient.js';
import { buildSpectatorSshArgs, type SpectatorCallbacks } from './spectatorSession.js';
import type { SshTarget } from './pty.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWITCH_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// hubKey — pure helper
// ---------------------------------------------------------------------------

/**
 * Canonical registry key for a (target, session) pair.
 * Format: `"<user>@<host>:<port>|<sessionName>"`
 * User may be empty string (e.g. ssh://localhost), port defaults to 22.
 */
export function hubKey(target: SshTarget, session: string): string {
	return `${target.user ?? ''}@${target.host}:${target.port ?? 22}|${session}`;
}

// ---------------------------------------------------------------------------
// PaneState — cached per-pane dimensions + cursor
// ---------------------------------------------------------------------------

export interface PaneState {
	cols: number;
	rows: number;
	altScreen: boolean;
	cursorX: number;
	cursorY: number;
	windowIndex: string;
	windowName: string;
}

// ---------------------------------------------------------------------------
// Dependency-injection interfaces (enables unit testing without real ssh)
// ---------------------------------------------------------------------------

type SshLike = {
	kill(): void;
	on(event: 'exit', cb: (code: number | null, signal: string | null) => void): SshLike;
	stderr: { on(event: 'data', cb: (buf: Buffer) => void): void };
};

type TmuxLike = {
	close(): void;
	// TmuxLike.on stays loose (...args: any[]) — Task 2 uses it; future tasks may tighten.
	on(event: string, cb: (...args: any[]) => void): void;
	command(cmd: string): Promise<string[]>;
};

export interface SpectatorHubDeps {
	ssh: SshLike;
	tmux: TmuxLike;
	hubKey: string;
	sessionName: string;
	controlPath?: string;
	onDestroy: () => void;
}

// ---------------------------------------------------------------------------
// SpectatorHub
// ---------------------------------------------------------------------------

export class SpectatorHub {
	readonly hubKey: string;
	readonly sessionName: string;
	readonly controlPath?: string;

	private ssh: SshLike;
	/** Exposed for tests (read-only in prod code via ensurePaneState / bootstrap). */
	private tmux: TmuxLike;
	private onDestroyFn: () => void;
	private subscriptions: Set<SpectatorSubscription> = new Set();
	private destroyed = false;
	private stderrTail = '';

	// ── State cache (populated by bootstrap) ────────────────────────────────
	sessionId: string | null = null;
	windowId: string | null = null;
	activePaneId: string | null = null;
	paneStates: Map<string, PaneState> = new Map();
	currentWindowPaneOrder: string[] = [];

	// ── Boot promise ─────────────────────────────────────────────────────────
	bootPromise: Promise<void> | null = null;

	// ── Listener Sets (fan-out to all subscriptions) ─────────────────────────
	private paneOutputListeners: Set<(paneId: string, bytes: Buffer) => void> = new Set();
	private activePaneListeners: Set<(paneId: string) => void> = new Set();
	private windowOrderListeners: Set<(order: string[]) => void> = new Set();
	private layoutChangeListeners: Set<(windowId: string) => void> = new Set();

	// ── Debounce timers (separate so interleaved events don't cancel each other) ──
	private paneChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private windowChangeTimer: ReturnType<typeof setTimeout> | null = null;
	// ── Inflight pane-state queries (deduped per paneId) ────────────────────
	private paneStateInflight: Map<string, Promise<PaneState | null>> = new Map();

	constructor(deps: SpectatorHubDeps) {
		this.ssh = deps.ssh;
		this.tmux = deps.tmux;
		this.hubKey = deps.hubKey;
		this.sessionName = deps.sessionName;
		this.controlPath = deps.controlPath;
		this.onDestroyFn = deps.onDestroy;

		// Accumulate stderr for inclusion in exit reason
		this.ssh.stderr.on('data', (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-1024);
		});

		this.ssh.on('exit', (code, signal) => this.handleSshExit(code, signal));
	}

	// ── Listener registration API ────────────────────────────────────────────

	addOutputListener(fn: (paneId: string, bytes: Buffer) => void): void {
		this.paneOutputListeners.add(fn);
	}
	removeOutputListener(fn: (paneId: string, bytes: Buffer) => void): void {
		this.paneOutputListeners.delete(fn);
	}

	addActivePaneListener(fn: (paneId: string) => void): void {
		this.activePaneListeners.add(fn);
	}
	removeActivePaneListener(fn: (paneId: string) => void): void {
		this.activePaneListeners.delete(fn);
	}

	addWindowOrderListener(fn: (order: string[]) => void): void {
		this.windowOrderListeners.add(fn);
	}
	removeWindowOrderListener(fn: (order: string[]) => void): void {
		this.windowOrderListeners.delete(fn);
	}

	addLayoutChangeListener(fn: (windowId: string) => void): void {
		this.layoutChangeListeners.add(fn);
	}
	removeLayoutChangeListener(fn: (windowId: string) => void): void {
		this.layoutChangeListeners.delete(fn);
	}

	// ── Subscription management ───────────────────────────────────────────────

	addSubscription(sub: SpectatorSubscription): void {
		this.subscriptions.add(sub);
	}

	removeSubscription(sub: SpectatorSubscription): void {
		this.subscriptions.delete(sub);
		if (this.subscriptions.size === 0 && !this.destroyed) {
			this.destroy();
		}
	}

	// ── Bootstrap ────────────────────────────────────────────────────────────

	/**
	 * Idempotent bootstrap — concurrent callers share the same Promise.
	 * Called by HubRegistry.subscribe after creating a new hub.
	 */
	bootstrap(session: string): Promise<void> {
		if (this.bootPromise) return this.bootPromise;
		this.bootPromise = this._bootstrap(session);
		return this.bootPromise;
	}

	private async _bootstrap(session: string): Promise<void> {
		// Register tmux event handlers here (not in constructor) so tests can
		// manually set hub state fields before calling bootstrap/emitting events.
		this.tmux.on('output', (paneId: string, bytes: Buffer) => {
			for (const fn of this.paneOutputListeners) fn(paneId, bytes);
		});
		this.tmux.on('windowPaneChanged', (winId: string, paneId: string) => {
			if (winId === this.windowId) this.scheduleActiveChange(paneId);
		});
		this.tmux.on('sessionWindowChanged', (sessId: string, winId: string) => {
			if (sessId === this.sessionId) this.scheduleWindowChange(winId);
		});
		this.tmux.on('layoutChange', (winId: string) => {
			if (winId === this.windowId) {
				for (const fn of this.layoutChangeListeners) fn(winId);
				void this.refreshPaneOrder();
			}
		});

		try {
			// refresh-client tolerates failure (tmux < 2.4 doesn't support -C flag)
			try { await this.tmux.command('refresh-client -C 500x200'); } catch { /* tolerate */ }

			const lines = await this.tmux.command(
				`display-message -p -t ${session} -F ` +
				`'#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}'`
			);
			const parts = (lines[0] ?? '').split('|');
			if (parts.length < 10) throw new Error('bootstrap: unexpected display-message format');

			this.sessionId = parts[0];
			this.windowId = parts[1];
			this.activePaneId = parts[2];
			this.paneStates.set(parts[2], {
				cols: parseInt(parts[3], 10),
				rows: parseInt(parts[4], 10),
				altScreen: parts[5] === '1',
				cursorX: parseInt(parts[6], 10),
				cursorY: parseInt(parts[7], 10),
				windowIndex: parts[8],
				windowName: parts.slice(9).join('|')
			});

			await this.refreshPaneOrder();
		} catch (err) {
			for (const sub of this.subscriptions) {
				try { sub.callbacks.error(`bootstrap: ${(err as Error).message}`); } catch { /* swallow */ }
			}
			// Remove dead hub from registry so a subsequent subscribe() creates a fresh one.
			this.destroy();
			throw err;
		}
	}

	// ── Debounced pane / window switches ─────────────────────────────────────

	private scheduleActiveChange(paneId: string): void {
		if (this.paneChangeTimer) clearTimeout(this.paneChangeTimer);
		this.paneChangeTimer = setTimeout(() => {
			this.paneChangeTimer = null;
			this.activePaneId = paneId;
			void this.ensurePaneState(paneId).then(() => {
				for (const fn of this.activePaneListeners) fn(paneId);
			});
		}, SWITCH_DEBOUNCE_MS);
	}

	private scheduleWindowChange(winId: string): void {
		if (this.windowChangeTimer) clearTimeout(this.windowChangeTimer);
		this.windowChangeTimer = setTimeout(async () => {
			this.windowChangeTimer = null;
			this.windowId = winId;
			await this.refreshPaneOrder();
			// Query the new window's active pane
			try {
				const lines = await this.tmux.command(
					`display-message -p -t ${winId} -F '#{pane_id}'`
				);
				const newActive = (lines[0] ?? '').trim();
				if (newActive) {
					this.activePaneId = newActive;
					await this.ensurePaneState(newActive);
					for (const fn of this.activePaneListeners) fn(newActive);
				}
			} catch { /* swallow */ }
			// refreshPaneOrder already fired windowOrderListeners if order changed — no second fire here
		}, SWITCH_DEBOUNCE_MS);
	}

	// ── Pane order refresh ────────────────────────────────────────────────────

	/**
	 * Queries list-panes for the current window and updates currentWindowPaneOrder.
	 * Only fires windowOrderListeners if the order actually changed.
	 */
	private async refreshPaneOrder(): Promise<void> {
		if (!this.windowId) return;
		try {
			const lines = await this.tmux.command(
				`list-panes -t ${this.windowId} -F '#{pane_id}'`
			);
			const newOrder = lines.map((l) => l.trim()).filter(Boolean);
			// Only fire listeners if order changed
			const changed = newOrder.length !== this.currentWindowPaneOrder.length ||
				newOrder.some((id, i) => id !== this.currentWindowPaneOrder[i]);
			this.currentWindowPaneOrder = newOrder;
			if (changed) {
				for (const fn of this.windowOrderListeners) fn(newOrder);
			}
		} catch { /* swallow */ }
	}

	// ── Public state query helpers ────────────────────────────────────────────

	/**
	 * Returns cached PaneState if available. Otherwise queries tmux, caches,
	 * and returns. Returns null on error or if format is unexpected.
	 */
	async ensurePaneState(paneId: string): Promise<PaneState | null> {
		if (this.paneStates.has(paneId)) return this.paneStates.get(paneId)!;
		// Deduplicate concurrent queries for the same unknown paneId
		const existing = this.paneStateInflight.get(paneId);
		if (existing) return existing;
		const promise = (async (): Promise<PaneState | null> => {
			try {
				const lines = await this.tmux.command(
					`display-message -p -t ${paneId} -F ` +
					`'#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}'`
				);
				const parts = (lines[0] ?? '').split('|');
				if (parts.length < 7) return null;
				const state: PaneState = {
					cols: parseInt(parts[0], 10),
					rows: parseInt(parts[1], 10),
					altScreen: parts[2] === '1',
					cursorX: parseInt(parts[3], 10),
					cursorY: parseInt(parts[4], 10),
					windowIndex: parts[5],
					windowName: parts.slice(6).join('|')
				};
				this.paneStates.set(paneId, state);
				return state;
			} catch {
				return null;
			} finally {
				this.paneStateInflight.delete(paneId);
			}
		})();
		this.paneStateInflight.set(paneId, promise);
		return promise;
	}

	/**
	 * Runs capture-pane and returns lines. Returns empty array on error.
	 * Subscriptions call this to build the initial seed payload.
	 */
	async captureSeed(paneId: string, scrollback: number): Promise<string[]> {
		try {
			return await this.tmux.command(`capture-pane -epJ -S -${scrollback} -t ${paneId}`);
		} catch {
			return [];
		}
	}

	// ── SSH exit handling ─────────────────────────────────────────────────────

	private handleSshExit(code: number | null, signal: string | null): void {
		if (this.destroyed) return;
		const tail = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
		let reason: string;
		if (signal) reason = `ssh signal=${signal}`;
		else if (code !== 0 && code !== null) reason = `ssh exit code=${code}`;
		else reason = 'ssh exit';
		if (tail) reason += `: ${tail.slice(0, 240)}`;
		// Fan-out exit to all subscriptions before destroying
		for (const sub of this.subscriptions) {
			try { sub.callbacks.exit(reason); } catch { /* swallow per-sub errors */ }
		}
		this.destroy();
	}

	private destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.paneChangeTimer) {
			clearTimeout(this.paneChangeTimer);
			this.paneChangeTimer = null;
		}
		if (this.windowChangeTimer) {
			clearTimeout(this.windowChangeTimer);
			this.windowChangeTimer = null;
		}
		try { this.tmux.close(); } catch { /* ignore */ }
		try { this.ssh.kill(); } catch { /* ignore */ }
		if (this.controlPath) {
			unlink(this.controlPath).catch(() => { /* ignore */ });
		}
		this.onDestroyFn();
	}
}

// ---------------------------------------------------------------------------
// SpectatorSubscription — per-WS handle (skeleton; filled in T3/T4)
// ---------------------------------------------------------------------------

export class SpectatorSubscription {
	readonly callbacks: SpectatorCallbacks;
	private hub: SpectatorHub;
	private closed = false;

	constructor(hub: SpectatorHub, callbacks: SpectatorCallbacks) {
		this.hub = hub;
		this.callbacks = callbacks;
		hub.addSubscription(this);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.hub.removeSubscription(this);
	}
}

// ---------------------------------------------------------------------------
// HubRegistry — module-level singleton Map<hubKey, SpectatorHub>
// ---------------------------------------------------------------------------

export class HubRegistry {
	private hubs: Map<string, SpectatorHub> = new Map();

	subscribe(
		target: SshTarget,
		session: string,
		callbacks: SpectatorCallbacks,
		opts: { ctrlDir?: string; spawnFn?: typeof spawn } = {}
	): SpectatorSubscription {
		const key = hubKey(target, session);
		let hub = this.hubs.get(key);
		if (!hub) {
			const spawnFn = opts.spawnFn ?? spawn;
			const controlPath = opts.ctrlDir
				? `${opts.ctrlDir}/${randomUUID().slice(0, 8)}.sock`
				: undefined;
			const args = buildSpectatorSshArgs(target, session, controlPath);
			const ssh = spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
			if (!ssh.stdin || !ssh.stdout || !ssh.stderr) {
				throw new Error('ssh stdio not available');
			}
			const tmux = new TmuxControlClient(ssh.stdin);
			(ssh.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => tmux.feed(chunk));
			hub = new SpectatorHub({
				ssh: ssh as unknown as SshLike,
				tmux: tmux as unknown as TmuxLike,
				hubKey: key,
				sessionName: session,
				controlPath,
				onDestroy: () => this.hubs.delete(key)
			});
			this.hubs.set(key, hub);
			// Start bootstrap so subscriptions can await hub.bootPromise in T3.
			// Swallow the rejection here — if bootstrap fails, it fires callbacks.error
			// on all subscriptions and destroy() handles cleanup.
			hub.bootstrap(session).catch(() => { /* handled via callbacks.error in _bootstrap */ });
		}
		return new SpectatorSubscription(hub, callbacks);
	}

	/** Test helper — inject a pre-constructed hub and return a bare subscription. */
	_injectHub(hub: SpectatorHub, callbacks: SpectatorCallbacks): SpectatorSubscription {
		if (!this.hubs.has(hub.hubKey)) {
			this.hubs.set(hub.hubKey, hub);
		}
		return new SpectatorSubscription(hub, callbacks);
	}

	get(key: string): SpectatorHub | undefined {
		return this.hubs.get(key);
	}

	size(): number {
		return this.hubs.size;
	}
}

/** Module-level singleton — shared across the bridge process lifetime. */
export const SpectatorHubRegistry = new HubRegistry();
