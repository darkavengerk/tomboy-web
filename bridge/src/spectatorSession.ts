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
	/**
	 * True while the active pane is in tmux copy-mode (i.e., the user
	 * triggered a scroll-up/scroll-down on mobile and we haven't exited
	 * yet). While in copy-mode we suppress `%output` forwarding because
	 * the user is looking at a scrolled-back capture — live bytes would
	 * jump them back to the bottom and overwrite the captured view.
	 *
	 * tmux's control protocol does NOT push copy-mode redraws as
	 * `%output` (copy-mode is a tmux-client overlay, not pane output),
	 * so the user only sees the scrolled view when we explicitly
	 * `capture-pane` + reseed after each scroll action.
	 */
	private inCopyMode = false;
	/**
	 * Rolling buffer of ssh stderr — surfaced in the exit reason so the user
	 * can see *why* the connection died (auth failure, missing tmux session,
	 * tmux not on PATH, etc).
	 */
	private stderrTail: string = '';

	constructor(opts: SpectatorOptions) {
		this.cb = opts.callbacks;

		if (!SAFE_SESSION_RE.test(opts.session)) {
			throw new Error(`unsafe session name: ${opts.session}`);
		}

		// `-tt` forces remote PTY allocation even though our stdin is a pipe.
		// tmux -CC calls tcgetattr() on its stdin at startup and exits with
		// "tcgetattr failed: Inappropriate ioctl for device" if there's no
		// tty — iTerm2 hits the same issue and uses the same workaround.
		//
		// `stty raw -echo` on the remote disables line-discipline munging
		// (ECHO, ICANON, ONLCR) so our binary control protocol passes
		// through unmodified. `exec` replaces the shell so signals + exit
		// codes propagate cleanly from tmux to ssh.
		//
		// Session name is gated by SAFE_SESSION_RE so it's safe to embed
		// unquoted in the shell command line.
		const args: string[] = ['-tt'];
		if (opts.target.port) args.push('-p', String(opts.target.port));
		args.push('-o', 'StrictHostKeyChecking=accept-new');
		args.push(
			opts.target.user ? `${opts.target.user}@${opts.target.host}` : opts.target.host
		);
		args.push(`stty raw -echo; exec tmux -CC attach -t ${opts.session}`);

		this.ssh = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		if (!this.ssh.stdin || !this.ssh.stdout || !this.ssh.stderr) {
			throw new Error('ssh stdio not available');
		}

		this.tmux = new TmuxControlClient(this.ssh.stdin);
		this.ssh.stdout.on('data', (chunk: Buffer) => this.tmux.feed(chunk));
		this.ssh.stderr.on('data', (chunk: Buffer) => {
			const msg = chunk.toString('utf8');
			if (msg) console.error('[spectator] ssh stderr:', msg.trimEnd());
			// Keep the last ~1 KB so we can include it in the exit reason.
			this.stderrTail = (this.stderrTail + msg).slice(-1024);
		});
		this.ssh.on('exit', (code, signal) => {
			const tail = this.stderrTail.trim();
			let reason: string;
			if (signal) reason = `ssh signal=${signal}`;
			else if (code !== 0 && code !== null) reason = `ssh exit code=${code}`;
			else reason = 'ssh exit';
			if (tail) {
				// Take just the last non-empty stderr line — usually the
				// actual error (e.g. "can't find session: main").
				const lastLine = tail.split(/\r?\n/).filter(Boolean).pop();
				if (lastLine) reason += `: ${lastLine.slice(0, 240)}`;
			}
			// Only escalate to `error` for genuinely abnormal exits — stderr
			// alone may just be benign .bashrc/.zshrc warnings (e.g. tools
			// that aren't on the non-interactive PATH).
			if ((code !== 0 && code !== null) || signal) {
				this.cb.error(reason);
			}
			this.finalize(reason);
		});
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
		// While the user is browsing scrollback (copy-mode), drop live
		// output instead of letting it overwrite their captured view.
		// Bytes are discarded; the next reseed-from-capture (on further
		// scroll, or on scroll-to-bottom to exit copy-mode) re-syncs the
		// view to whatever tmux currently shows.
		if (this.inCopyMode) return;
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

	/**
	 * Send keystrokes to whichever pane is currently active. Used by the
	 * mobile spectator's "보내기" popup — the spectator is normally
	 * read-only, but explicit user-triggered input (e.g., "y" to confirm a
	 * claude code prompt) is allowed through this method.
	 *
	 * Uses `send-keys -H <hex>` for binary-safe transport — every byte of
	 * the input becomes a two-char hex token, so no shell/tmux quoting
	 * issues regardless of the text (control chars, multibyte UTF-8, etc).
	 * Requires tmux 3.0+.
	 */
	sendInput(text: string): void {
		if (!this.activePaneId || this.closed || !text) return;
		const bytes = Buffer.from(text, 'utf8');
		if (bytes.length === 0) return;
		const hex: string[] = [];
		for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
		const cmd = `send-keys -t ${this.activePaneId} -H ${hex.join(' ')}`;
		this.tmux.command(cmd).catch((err) => {
			console.error('[spectator] send-keys failed:', (err as Error).message);
		});
	}

	/**
	 * Non-keystroke actions on the active pane.
	 *
	 *   scroll-up        → enter copy-mode + page-up    + reseed
	 *   scroll-down      → enter copy-mode + page-down  + reseed
	 *   scroll-lines     → enter copy-mode + cursor up/down × |count| + reseed
	 *                      (count < 0 = older content / cursor-up)
	 *   scroll-to-bottom → cancel copy-mode (back to live) + reseed
	 *
	 * `copy-mode -t <pane>` is idempotent. The reseed is REQUIRED — tmux's
	 * control protocol does NOT push copy-mode redraws as `%output` (it's
	 * a tmux-client overlay, not pane output), so without an explicit
	 * `capture-pane` + emit, the spectator's mobile screen stays frozen
	 * at the pre-scroll state even though the desktop sees the scroll.
	 *
	 * This DOES affect the desktop's view of the pane — entering copy-mode
	 * pauses live updates on the desktop too, until cancelled. The
	 * spectator workflow assumes the desktop is unattended; on return
	 * `prefix + q` (or pressing q in copy-mode) exits.
	 */
	async action(name: string, count?: number): Promise<void> {
		if (!this.activePaneId || this.closed) return;
		const pane = this.activePaneId;
		try {
			switch (name) {
				case 'scroll-up':
					await this.tmux.command(`copy-mode -t ${pane}`);
					this.inCopyMode = true;
					await this.tmux.command(`send-keys -t ${pane} -X page-up`);
					await this.reseedFromCapture();
					return;
				case 'scroll-down':
					await this.tmux.command(`copy-mode -t ${pane}`);
					this.inCopyMode = true;
					await this.tmux.command(`send-keys -t ${pane} -X page-down`);
					await this.reseedFromCapture();
					return;
				case 'scroll-lines': {
					const n =
						typeof count === 'number' && Number.isFinite(count)
							? Math.min(Math.abs(Math.trunc(count)), 500)
							: 0;
					if (n === 0) return;
					const dir = (count ?? 0) < 0 ? 'cursor-up' : 'cursor-down';
					await this.tmux.command(`copy-mode -t ${pane}`);
					this.inCopyMode = true;
					await this.tmux.command(`send-keys -t ${pane} -N ${n} -X ${dir}`);
					await this.reseedFromCapture();
					return;
				}
				case 'scroll-to-bottom':
					await this.tmux.command(`send-keys -t ${pane} -X cancel`);
					this.inCopyMode = false;
					// After cancel, live %output resumes naturally. Issue
					// one capture-pane redraw so the mobile transitions to
					// the live view cleanly without waiting for the next
					// app-driven output.
					await this.reseedFromCapture();
					return;
				default:
					console.warn('[spectator] unknown action:', name);
			}
		} catch (err) {
			this.cb.error(`action ${name}: ${(err as Error).message}`);
		}
	}

	/**
	 * Capture the current visible state of the active pane and emit it as
	 * a fresh screen seed. Used after scroll actions because copy-mode
	 * redraws don't go through `%output`. Uses a light reset (`CSI 2J +
	 * CSI H`) rather than full RIS so xterm's scrollback isn't wiped on
	 * every scroll tick.
	 */
	private async reseedFromCapture(): Promise<void> {
		if (!this.activePaneId || this.closed) return;
		const pane = this.activePaneId;
		// Suspend live forwarding while we assemble the seed — any %output
		// arriving between capture and emit would be applied on top of the
		// captured cursor position, garbling the view.
		this.seeding = true;
		this.pendingOutput = [];
		this.decoder = new TextDecoder('utf-8', { fatal: false });
		try {
			const meta = await this.tmux.command(
				`display-message -p -t ${pane} -F '#{alternate_on}|#{cursor_x}|#{cursor_y}'`
			);
			const parts = (meta[0] ?? '').split('|');
			const alt = parts[0] === '1';
			const cx = parseInt(parts[1], 10);
			const cy = parseInt(parts[2], 10);
			const captured = await this.tmux.command(`capture-pane -epJ -t ${pane}`);
			// Light reset: clear screen + home cursor. Avoids full RIS
			// (which would wipe xterm's scrollback on every reseed).
			let seed = '\x1b[H\x1b[2J';
			if (alt) seed += '\x1b[?1049h';
			else seed += '\x1b[?1049l';
			seed += captured.join('\r\n');
			if (Number.isFinite(cx) && Number.isFinite(cy)) {
				seed += `\x1b[${cy + 1};${cx + 1}H`;
			}
			this.cb.data(seed);
		} catch (err) {
			this.cb.error(`reseed: ${(err as Error).message}`);
		} finally {
			// Discard any %output that arrived while seeding — they're for
			// the live view, not the (possibly scrolled-back) captured view.
			// When we exit copy-mode, the next reseed-from-cancel re-syncs.
			this.pendingOutput = [];
			this.seeding = false;
		}
	}
}
