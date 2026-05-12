/**
 * Spectator session: ssh's into the target and attaches a `tmux -CC`
 * control-mode client, then forwards only the bytes from the currently-active
 * pane (of the session's currently-active window) to the WebSocket client.
 *
 * When the desktop user switches panes or windows, this module:
 *   1. Notices via `%window-pane-changed` / `%session-window-changed`.
 *   2. Issues `display-message` + `capture-pane -epJ` for the new pane.
 *   3. Sends a `pane-switch` control frame to the WS client carrying the
 *      new pane's size + alt-screen state, immediately followed by a
 *      seed: reset → optional alt-screen toggle → captured content →
 *      cursor positioning. After that, real-time `%output` for the new
 *      pane resumes streaming.
 *
 * Bytes that arrive for the new pane DURING the (async) seed are buffered
 * and flushed after the seed lands, so the client never sees seed-after-live
 * out-of-order rendering.
 *
 * Input frames from the WS client (data / resize) are NOT consumed here —
 * `server.ts` is responsible for refusing them in spectator mode.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { TmuxControlClient } from './tmuxControlClient.js';
import type { SshTarget } from './pty.js';

export interface SpectatorCallbacks {
	paneSwitch(info: { paneId: string; cols: number; rows: number; altScreen: boolean }): void;
	/** UTF-8 text to write into the client's xterm. */
	data(text: string): void;
	paneResize(info: { cols: number; rows: number }): void;
	error(message: string): void;
	exit(reason?: string): void;
}

export interface SpectatorOptions {
	target: SshTarget;
	session: string;
	callbacks: SpectatorCallbacks;
}

/**
 * Debounce window for pane-focus changes. If the user rapidly cycles through
 * panes A→B→C, we only seed the final one — avoids screen flicker.
 */
const SWITCH_DEBOUNCE_MS = 100;

const SAFE_SESSION_RE = /^[A-Za-z0-9_\-./@:]+$/;

export class SpectatorSession {
	private ssh: ChildProcess;
	private tmux: TmuxControlClient;
	private cb: SpectatorCallbacks;
	private decoder = new TextDecoder('utf-8', { fatal: false });

	private sessionId: string | null = null;
	private windowId: string | null = null;
	private activePaneId: string | null = null;
	private paneCols = 0;
	private paneRows = 0;

	private switchTimer: ReturnType<typeof setTimeout> | null = null;
	private seeding = false;
	/** Bytes for the active pane that arrived while a seed was in flight. */
	private pendingOutput: Buffer[] = [];
	private closed = false;

	constructor(opts: SpectatorOptions) {
		this.cb = opts.callbacks;

		if (!SAFE_SESSION_RE.test(opts.session)) {
			throw new Error(`unsafe session name: ${opts.session}`);
		}

		const args: string[] = ['-T']; // disable PTY allocation — control mode is binary stdio
		if (opts.target.port) args.push('-p', String(opts.target.port));
		args.push('-o', 'StrictHostKeyChecking=accept-new');
		args.push(
			opts.target.user ? `${opts.target.user}@${opts.target.host}` : opts.target.host
		);
		// session name is gated by SAFE_SESSION_RE so it's safe to embed unquoted.
		args.push('tmux', '-CC', 'attach', '-t', opts.session);

		this.ssh = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		if (!this.ssh.stdin || !this.ssh.stdout || !this.ssh.stderr) {
			throw new Error('ssh stdio not available');
		}

		this.tmux = new TmuxControlClient(this.ssh.stdin);
		this.ssh.stdout.on('data', (chunk: Buffer) => this.tmux.feed(chunk));
		this.ssh.stderr.on('data', (chunk: Buffer) => {
			// Surface tmux/ssh diagnostics but don't dim the channel.
			const msg = chunk.toString('utf8').trimEnd();
			if (msg) console.error('[spectator] ssh stderr:', msg);
		});
		this.ssh.on('exit', () => this.finalize('ssh exit'));
		this.ssh.on('error', (err) => this.cb.error(err.message));

		this.tmux.on('output', (paneId, bytes) => this.onPaneOutput(paneId, bytes));
		this.tmux.on('windowPaneChanged', (winId, paneId) => {
			if (winId === this.windowId) this.scheduleSwitch(paneId);
		});
		this.tmux.on('sessionWindowChanged', (sessId, winId) => {
			if (sessId === this.sessionId) {
				this.windowId = winId;
				this.scheduleSwitchToActiveOfWindow(winId);
			}
		});
		this.tmux.on('layoutChange', (winId) => {
			if (winId === this.windowId) void this.checkSizeChange();
		});
		this.tmux.on('exit', () => this.finalize('tmux exit'));

		void this.bootstrap(opts.session);
	}

	private async bootstrap(sessionName: string): Promise<void> {
		try {
			const lines = await this.tmux.command(
				`display-message -p -t ${sessionName} -F ` +
					"'#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}'"
			);
			const parts = (lines[0] ?? '').split('|');
			if (parts.length < 8) {
				this.cb.error('bootstrap: unexpected display-message format');
				return;
			}
			this.sessionId = parts[0];
			this.windowId = parts[1];
			await this.activateAndSeed({
				paneId: parts[2],
				cols: parseInt(parts[3], 10),
				rows: parseInt(parts[4], 10),
				altScreen: parts[5] === '1',
				cursorX: parseInt(parts[6], 10),
				cursorY: parseInt(parts[7], 10)
			});
		} catch (err) {
			this.cb.error(`bootstrap: ${(err as Error).message}`);
		}
	}

	private onPaneOutput(paneId: string, bytes: Buffer): void {
		if (paneId !== this.activePaneId) return;
		if (this.seeding) {
			this.pendingOutput.push(bytes);
			return;
		}
		this.emitBytes(bytes);
	}

	private emitBytes(bytes: Buffer): void {
		// `stream: true` buffers incomplete UTF-8 sequences across calls so
		// they're not surfaced as replacement chars.
		const text = this.decoder.decode(bytes, { stream: true });
		if (text) this.cb.data(text);
	}

	private scheduleSwitch(paneId: string): void {
		if (this.switchTimer) clearTimeout(this.switchTimer);
		this.switchTimer = setTimeout(() => {
			this.switchTimer = null;
			void this.switchTo(paneId);
		}, SWITCH_DEBOUNCE_MS);
	}

	private scheduleSwitchToActiveOfWindow(winId: string): void {
		if (this.switchTimer) clearTimeout(this.switchTimer);
		this.switchTimer = setTimeout(async () => {
			this.switchTimer = null;
			try {
				const lines = await this.tmux.command(
					`display-message -p -t ${winId} -F '#{pane_id}'`
				);
				const newPane = (lines[0] ?? '').trim();
				if (newPane) await this.switchTo(newPane);
			} catch (err) {
				this.cb.error(`switch-window: ${(err as Error).message}`);
			}
		}, SWITCH_DEBOUNCE_MS);
	}

	private async switchTo(paneId: string): Promise<void> {
		if (paneId === this.activePaneId || this.closed) return;
		try {
			const lines = await this.tmux.command(
				`display-message -p -t ${paneId} -F ` +
					"'#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}'"
			);
			const parts = (lines[0] ?? '').split('|');
			if (parts.length < 5) return;
			await this.activateAndSeed({
				paneId,
				cols: parseInt(parts[0], 10),
				rows: parseInt(parts[1], 10),
				altScreen: parts[2] === '1',
				cursorX: parseInt(parts[3], 10),
				cursorY: parseInt(parts[4], 10)
			});
		} catch (err) {
			this.cb.error(`switchTo: ${(err as Error).message}`);
		}
	}

	private async activateAndSeed(args: {
		paneId: string;
		cols: number;
		rows: number;
		altScreen: boolean;
		cursorX: number;
		cursorY: number;
	}): Promise<void> {
		const { paneId, cols, rows, altScreen, cursorX, cursorY } = args;

		this.seeding = true;
		this.pendingOutput = [];
		this.activePaneId = paneId;
		this.paneCols = cols;
		this.paneRows = rows;
		// Reset the streaming UTF-8 decoder between panes so partial leftover
		// bytes from the old pane can't corrupt the new pane's first chunk.
		this.decoder = new TextDecoder('utf-8', { fatal: false });

		this.cb.paneSwitch({ paneId, cols, rows, altScreen });

		// Build seed: reset → optional alt-screen → captured content → cursor.
		// '\x1bc' (RIS) clears scrollback + resets all attributes/modes.
		// '\x1b[?1049l' first to exit alt-screen if we were left in one.
		let seed = '\x1b[?1049l\x1bc';
		if (altScreen) seed += '\x1b[?1049h';

		try {
			const captured = await this.tmux.command(`capture-pane -epJ -t ${paneId}`);
			seed += captured.join('\r\n');
		} catch (err) {
			this.cb.error(`capture-pane: ${(err as Error).message}`);
		}

		// Cursor positioning: CSI row;col H is 1-indexed; tmux reports 0-indexed.
		if (Number.isFinite(cursorY) && Number.isFinite(cursorX)) {
			seed += `\x1b[${cursorY + 1};${cursorX + 1}H`;
		}

		this.cb.data(seed);

		const drain = this.pendingOutput;
		this.pendingOutput = [];
		this.seeding = false;
		for (const b of drain) this.emitBytes(b);
	}

	private async checkSizeChange(): Promise<void> {
		if (!this.activePaneId || this.closed) return;
		try {
			const lines = await this.tmux.command(
				`display-message -p -t ${this.activePaneId} -F '#{pane_width}|#{pane_height}'`
			);
			const parts = (lines[0] ?? '').split('|');
			if (parts.length < 2) return;
			const cols = parseInt(parts[0], 10);
			const rows = parseInt(parts[1], 10);
			if (cols !== this.paneCols || rows !== this.paneRows) {
				this.paneCols = cols;
				this.paneRows = rows;
				this.cb.paneResize({ cols, rows });
			}
		} catch {
			/* ignore — pane may have closed between event and query */
		}
	}

	private finalize(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		if (this.switchTimer) {
			clearTimeout(this.switchTimer);
			this.switchTimer = null;
		}
		this.cb.exit(reason);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.switchTimer) {
			clearTimeout(this.switchTimer);
			this.switchTimer = null;
		}
		this.tmux.close();
		try {
			this.ssh.kill();
		} catch {
			/* ignore */
		}
	}
}
