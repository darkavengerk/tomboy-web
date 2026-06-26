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
import { buildSpectatorSshArgs, SPECTATOR_VIRTUAL_COLS, SPECTATOR_VIRTUAL_ROWS, type SpectatorCallbacks, type SpectatorNavAction } from './spectatorSession.js';
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
				// Layout changes (split, resize, close) make cached cols/rows/cursor stale.
				// Clear the entire cache; next ensurePaneState re-fetches fresh geometry.
				this.paneStates.clear();
				for (const fn of this.layoutChangeListeners) fn(winId);
				void this.refreshPaneOrder();
			}
		});

		try {
			// refresh-client tolerates failure (tmux < 2.4 doesn't support -C flag)
			try { await this.tmux.command(`refresh-client -C ${SPECTATOR_VIRTUAL_COLS}x${SPECTATOR_VIRTUAL_ROWS}`); } catch { /* tolerate */ }

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

	// ── Desktop-mutating commands ─────────────────────────────────────────────

	/**
	 * Jump the session's active pane to the Nth pane (1-based). Resolves
	 * ordinal via `list-panes -t <sessionName>` so it is correct regardless of
	 * the target's pane-base-index. Fewer panes than ordinal → silent no-op.
	 */
	async selectPane(ordinal: number): Promise<void> {
		if (this.destroyed) return;
		if (!Number.isInteger(ordinal) || ordinal < 1) return;
		const s = this.sessionName;
		try {
			const lines = await this.tmux.command(`list-panes -t ${s} -F '#{pane_id}'`);
			if (this.destroyed) return;
			const paneId = (lines[ordinal - 1] ?? '').trim();
			if (!paneId) return;
			await this.tmux.command(`select-pane -t ${paneId}`);
		} catch (err) {
			console.error('[spectator-hub] selectPane failed:', (err as Error).message);
		}
	}

	/**
	 * Relative pane / window navigation. Issues a tmux command on the control
	 * channel; the resulting `%window-pane-changed` or `%session-window-changed`
	 * notification flows through the existing hub event path.
	 */
	async tmuxNav(action: SpectatorNavAction): Promise<void> {
		if (this.destroyed) return;
		const s = this.sessionName;
		let cmd: string;
		switch (action) {
			case 'next-pane':    cmd = `select-pane -t ${s}:.+`;    break;
			case 'prev-pane':    cmd = `select-pane -t ${s}:.-`;    break;
			case 'next-window':  cmd = `select-window -t ${s}:+`;   break;
			case 'prev-window':  cmd = `select-window -t ${s}:-`;   break;
			default: return;
		}
		try {
			await this.tmux.command(cmd);
		} catch (err) {
			console.error('[spectator-hub] tmuxNav failed:', (err as Error).message);
		}
	}

	/**
	 * Send keystrokes to the currently active pane via `send-keys -H <hex>`.
	 * Binary-safe (tmux 3.0+). Guards: destroyed, no activePaneId, empty text.
	 */
	async sendInput(text: string): Promise<void> {
		if (this.destroyed || !this.activePaneId || !text) return;
		const bytes = Buffer.from(text, 'utf8');
		if (bytes.length === 0) return;
		const hex: string[] = [];
		for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
		const cmd = `send-keys -t ${this.activePaneId} -H ${hex.join(' ')}`;
		try {
			await this.tmux.command(cmd);
		} catch (err) {
			console.error('[spectator-hub] sendInput failed:', (err as Error).message);
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
// resolveOrdinal — pure helper (T4)
// ---------------------------------------------------------------------------

/**
 * Maps a 1-based ordinal to the paneId at that position in the order array.
 * Returns null if ordinal is out of range, not an integer, or order is empty.
 */
export function resolveOrdinal(order: string[], ordinal: number): string | null {
	if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > order.length) return null;
	return order[ordinal - 1] ?? null;
}

// ---------------------------------------------------------------------------
// SpectatorSubscription — per-WS handle (T3: follow-active; T4: pinned)
// ---------------------------------------------------------------------------

const SCROLLBACK_SEED_LINES = 1000;

export type SubscriptionMode =
	| { kind: 'follow-active' }
	| { kind: 'pinned'; ordinal: number };

export class SpectatorSubscription {
	readonly callbacks: SpectatorCallbacks;
	private hub: SpectatorHub;

	mode: SubscriptionMode = { kind: 'follow-active' };
	subscribedPaneId: string | null = null;

	private seeding = false;
	private pendingOutput: Buffer[] = [];
	private decoder = new TextDecoder('utf-8', { fatal: false });
	private closed = false;
	private attached = false;

	// Concurrent switchTo coalescing: only one switchTo in flight at a time;
	// the latest requested paneId wins after the current one completes.
	private switchInflight: Promise<void> | null = null;
	private pendingSwitchPaneId: string | null = null;

	// Bound listener references — must be stored so remove*Listener actually
	// removes the same function reference that was added.
	private readonly boundPaneOutput = (paneId: string, bytes: Buffer) =>
		this.onHubPaneOutput(paneId, bytes);
	private readonly boundActiveChanged = (paneId: string) =>
		void this.onHubActivePaneChanged(paneId);
	private readonly boundWindowOrderChanged = (order: string[]) =>
		void this.onHubWindowPaneOrderChanged(order);

	constructor(hub: SpectatorHub, callbacks: SpectatorCallbacks) {
		this.hub = hub;
		this.callbacks = callbacks;
		hub.addSubscription(this);
		hub.addOutputListener(this.boundPaneOutput);
		hub.addActivePaneListener(this.boundActiveChanged);
		hub.addWindowOrderListener(this.boundWindowOrderChanged);
	}

	/** Await bootstrap, then fire initial paneSwitch + seed for the active pane. */
	async attach(): Promise<void> {
		if (this.closed) return;
		if (this.attached) return;
		this.attached = true;
		if (this.hub.bootPromise) await this.hub.bootPromise;
		if (this.closed) return;  // re-check after async gap
		if (this.mode.kind === 'follow-active' && this.hub.activePaneId) {
			await this.processSwitchQueue(this.hub.activePaneId);
		}
	}

	private onHubPaneOutput(paneId: string, bytes: Buffer): void {
		if (this.closed) return;
		if (paneId !== this.subscribedPaneId) return;
		if (this.seeding) {
			this.pendingOutput.push(bytes);
			return;
		}
		this.emitBytes(bytes);
	}

	private async onHubActivePaneChanged(paneId: string): Promise<void> {
		if (this.closed) return;
		if (this.mode.kind !== 'follow-active') return;
		await this.processSwitchQueue(paneId);
	}

	private async onHubWindowPaneOrderChanged(_order: string[]): Promise<void> {
		if (this.closed) return;
		if (this.mode.kind === 'pinned') {
			await this.resolveAndApply();
		}
		// follow-active ignores window order changes directly —
		// it reacts via activePaneListeners instead.
	}

	// ── Pin / unpin (T4) ─────────────────────────────────────────────────────

	/**
	 * Pin to a fixed ordinal. mode becomes { kind: 'pinned', ordinal: n }.
	 * Resolves immediately against currentWindowPaneOrder and fires either
	 * paneSwitch+seed (valid) or paneUnavailable (invalid).
	 */
	async pinOrdinal(n: number): Promise<void> {
		if (this.closed) return;
		this.mode = { kind: 'pinned', ordinal: n };
		await this.resolveAndApply();
	}

	/**
	 * Switch back to follow-active mode. If hub.activePaneId is known, routes
	 * through the switch queue so the caller can await the seed completing.
	 * If hub.activePaneId is null, clears subscribedPaneId so the output filter
	 * stops forwarding bytes from the previously-pinned pane.
	 */
	async unpin(): Promise<void> {
		if (this.closed) return;
		this.mode = { kind: 'follow-active' };
		if (this.hub.activePaneId) {
			await this.processSwitchQueue(this.hub.activePaneId);
		} else {
			this.subscribedPaneId = null;
		}
	}

	// ── Desktop-mutating delegation (hub pass-through) ───────────────────────

	/** Delegates to hub.selectPane. Fire-and-forget (errors logged by hub). */
	selectPane(ordinal: number): void {
		void this.hub.selectPane(ordinal);
	}

	/** Delegates to hub.tmuxNav. Fire-and-forget (errors logged by hub). */
	tmuxNav(action: SpectatorNavAction): void {
		void this.hub.tmuxNav(action);
	}

	/** Delegates to hub.sendInput. Fire-and-forget (errors logged by hub). */
	sendInput(text: string): void {
		void this.hub.sendInput(text);
	}

	/** True when the hub has a known active pane and this subscription is open. */
	hasActivePane(): boolean {
		return this.hub.activePaneId != null && !this.closed;
	}

	/** ControlMaster socket path from the hub (may be undefined). */
	get controlPath(): string | undefined {
		return this.hub.controlPath;
	}

	/**
	 * Only acts when mode is pinned. Resolves the ordinal against the current
	 * window pane order and either routes through the switch queue or fires
	 * paneUnavailable.
	 */
	private async resolveAndApply(): Promise<void> {
		if (this.mode.kind !== 'pinned') return;
		const { ordinal } = this.mode;
		const order = this.hub.currentWindowPaneOrder;
		const resolved = resolveOrdinal(order, ordinal);
		if (resolved === null) {
			this.subscribedPaneId = null;
			this.callbacks.paneUnavailable({ pinnedOrdinal: ordinal, paneCount: order.length });
			return;
		}
		if (resolved === this.subscribedPaneId) return; // no change
		await this.hub.ensurePaneState(resolved);
		await this.processSwitchQueue(resolved);
	}

	/**
	 * Coalescing switch queue: if a switchTo is already in flight, record the
	 * latest desired paneId and let the current flight pick it up on completion.
	 * This prevents two concurrent switchTo calls from racing and corrupting
	 * seeding/pendingOutput state.
	 */
	private async processSwitchQueue(paneId: string): Promise<void> {
		this.pendingSwitchPaneId = paneId;
		if (this.switchInflight) return;  // in-flight call will loop and pick up pendingSwitchPaneId
		while (this.pendingSwitchPaneId) {
			const next = this.pendingSwitchPaneId;
			this.pendingSwitchPaneId = null;
			this.switchInflight = this.switchTo(next);
			await this.switchInflight;
			this.switchInflight = null;
		}
	}

	private async switchTo(paneId: string): Promise<void> {
		// Look up cached pane state BEFORE mutating any subscription state.
		// If the pane is unknown we leave subscribedPaneId unchanged so the
		// client keeps receiving output for whatever it was watching before.
		const state = this.hub.paneStates.get(paneId);
		if (!state) {
			this.seeding = false;
			return;
		}

		this.seeding = true;
		this.pendingOutput = [];
		this.subscribedPaneId = paneId;
		// Fresh UTF-8 streaming decoder so we don't carry state from prior pane.
		this.decoder = new TextDecoder('utf-8', { fatal: false });

		const ordinal = this.hub.currentWindowPaneOrder.indexOf(paneId) + 1;
		const count = this.hub.currentWindowPaneOrder.length;

		this.callbacks.paneSwitch({
			paneId,
			cols: state.cols,
			rows: state.rows,
			altScreen: state.altScreen,
			windowIndex: state.windowIndex,
			windowName: state.windowName,
			paneOrdinal: ordinal,
			paneCount: count,
		});

		const captured = await this.hub.captureSeed(paneId, SCROLLBACK_SEED_LINES);

		// Build seed string:
		//   1. Always exit alt-screen + full reset (client starts clean)
		//   2. Re-enter alt-screen if the pane was in it
		//   3. Captured content lines joined by CRLF
		//   4. Restore cursor position if known
		let seed = '\x1b[?1049l\x1bc';
		if (state.altScreen) seed += '\x1b[?1049h';
		seed += captured.join('\r\n');
		if (Number.isFinite(state.cursorY) && Number.isFinite(state.cursorX)) {
			// CSI row;colH — both are 1-based
			seed += `\x1b[${state.cursorY + 1};${state.cursorX + 1}H`;
		}

		this.callbacks.data(seed);

		// Flush bytes that arrived during the async capture
		const queued = this.pendingOutput;
		this.pendingOutput = [];
		this.seeding = false;
		for (const buf of queued) {
			this.emitBytes(buf);
		}
	}

	/** Decode buf via streaming UTF-8 decoder and forward to callbacks.data. */
	private emitBytes(bytes: Buffer): void {
		const text = this.decoder.decode(bytes, { stream: true });
		if (text) this.callbacks.data(text);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.hub.removeOutputListener(this.boundPaneOutput);
		this.hub.removeActivePaneListener(this.boundActiveChanged);
		this.hub.removeWindowOrderListener(this.boundWindowOrderChanged);
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
