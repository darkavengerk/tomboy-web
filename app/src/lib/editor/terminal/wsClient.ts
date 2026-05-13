export type WsClientStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface PaneSwitchInfo {
	paneId: string;
	cols: number;
	rows: number;
	altScreen: boolean;
}

interface ClientOptions {
	bridge: string;
	target: string;
	token: string;
	cols: number;
	rows: number;
	/**
	 * Spectator-mode connect: when set, the bridge will attach `tmux -CC` to
	 * this session on the target and stream only the active pane's bytes.
	 * The client must NOT call `send()` / `resize()` in this mode.
	 */
	spectate?: string;
	onData: (chunk: string) => void;
	onStatus: (status: WsClientStatus, info?: { code?: number; message?: string }) => void;
	/** Called when the bridge switches the spectated pane (focus follow). */
	onPaneSwitch?: (info: PaneSwitchInfo) => void;
	/** Called when the spectated pane's size changes in place. */
	onPaneResize?: (info: { cols: number; rows: number }) => void;
}

interface ServerMsg {
	type: 'data' | 'exit' | 'error' | 'ready' | 'pane-switch' | 'pane-resize';
	d?: string;
	code?: number;
	message?: string;
	paneId?: string;
	cols?: number;
	rows?: number;
	altScreen?: boolean;
}

/**
 * Fallback delay for marking the session 'open' if the bridge never emits
 * `{type:'ready'}`. Older bridges (pre-PTY-ready signal) keep working — the
 * timer fires after the bridge has had ample time to spawn ssh.
 */
const READY_FALLBACK_MS = 3000;

/**
 * Thin WebSocket wrapper for the term-bridge protocol.
 *
 *   client  -> server : {type:'connect', target, cols, rows}
 *                       {type:'data',    d}
 *                       {type:'resize',  cols, rows}
 *
 *   server  -> client : {type:'data',  d}
 *                       {type:'exit',  code}
 *                       {type:'error', message}
 *
 * The cookie set by `/login` rides on the upgrade request automatically
 * (browsers always include cookies on WebSocket handshakes for the same
 * origin). The bridge enforces it.
 */
export class TerminalWsClient {
	private ws: WebSocket | null = null;
	private opts: ClientOptions;
	private closed = false;
	private readyFired = false;
	private readyFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: ClientOptions) {
		this.opts = opts;
	}

	private markOpen(): void {
		if (this.readyFired || this.closed) return;
		this.readyFired = true;
		if (this.readyFallbackTimer) {
			clearTimeout(this.readyFallbackTimer);
			this.readyFallbackTimer = null;
		}
		this.opts.onStatus('open');
	}

	connect(): void {
		this.opts.onStatus('connecting');
		const url = bridgeToWsUrl(this.opts.bridge);
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			this.opts.onStatus('error', { message: (err as Error).message });
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			const connectMsg: Record<string, unknown> = {
				type: 'connect',
				target: this.opts.target,
				token: this.opts.token,
				cols: this.opts.cols,
				rows: this.opts.rows
			};
			if (this.opts.spectate) {
				connectMsg.mode = 'spectate';
				connectMsg.session = this.opts.spectate;
			}
			ws.send(JSON.stringify(connectMsg));
			// Defer 'open' until the bridge confirms PTY ready (see READY_FALLBACK_MS
			// for older-bridge fallback).
			this.readyFallbackTimer = setTimeout(() => {
				this.readyFallbackTimer = null;
				this.markOpen();
			}, READY_FALLBACK_MS);
		};

		ws.onmessage = (ev) => {
			let msg: ServerMsg;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
			} catch {
				return;
			}
			if (msg.type === 'ready') {
				this.markOpen();
			} else if (msg.type === 'data' && typeof msg.d === 'string') {
				this.opts.onData(msg.d);
			} else if (msg.type === 'pane-switch') {
				if (
					this.opts.onPaneSwitch &&
					typeof msg.paneId === 'string' &&
					typeof msg.cols === 'number' &&
					typeof msg.rows === 'number'
				) {
					this.opts.onPaneSwitch({
						paneId: msg.paneId,
						cols: msg.cols,
						rows: msg.rows,
						altScreen: !!msg.altScreen
					});
				}
			} else if (msg.type === 'pane-resize') {
				if (
					this.opts.onPaneResize &&
					typeof msg.cols === 'number' &&
					typeof msg.rows === 'number'
				) {
					this.opts.onPaneResize({ cols: msg.cols, rows: msg.rows });
				}
			} else if (msg.type === 'exit') {
				this.opts.onStatus('closed', { code: msg.code });
			} else if (msg.type === 'error') {
				this.opts.onStatus('error', { message: msg.message });
			}
		};

		ws.onclose = (ev) => {
			if (this.closed) return;
			this.opts.onStatus('closed', { code: ev.code, message: ev.reason });
		};

		ws.onerror = () => {
			if (this.closed) return;
			this.opts.onStatus('error');
		};
	}

	send(data: string): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'data', d: data }));
		}
	}

	/**
	 * Re-input helper used by the history panel. `autoExecute=false` types
	 * the text into the prompt without pressing Enter; `autoExecute=true`
	 * appends `\r` so the shell runs it immediately.
	 */
	sendCommand(text: string, autoExecute: boolean): void {
		this.send(autoExecute ? text + '\r' : text);
	}

	resize(cols: number, rows: number): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
		}
	}


	close(): void {
		this.closed = true;
		if (this.readyFallbackTimer) {
			clearTimeout(this.readyFallbackTimer);
			this.readyFallbackTimer = null;
		}
		if (this.ws) {
			try { this.ws.close(); } catch { /* ignore */ }
			this.ws = null;
		}
	}
}

/**
 * Accept either an `https://`/`http://` form or a `wss://`/`ws://` form for
 * the bridge URL — UX is friendlier when the user can paste either.
 */
function bridgeToWsUrl(bridge: string): string {
	const trimmed = bridge.trim();
	if (/^wss?:\/\//i.test(trimmed)) {
		return appendWsPath(trimmed);
	}
	if (/^https:\/\//i.test(trimmed)) return appendWsPath('wss://' + trimmed.slice('https://'.length));
	if (/^http:\/\//i.test(trimmed)) return appendWsPath('ws://' + trimmed.slice('http://'.length));
	throw new Error(`bridge URL must start with wss:// or https:// (got "${bridge}")`);
}

function appendWsPath(url: string): string {
	try {
		const u = new URL(url);
		if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
		return u.toString();
	} catch {
		return url.replace(/\/?$/, '/ws');
	}
}
