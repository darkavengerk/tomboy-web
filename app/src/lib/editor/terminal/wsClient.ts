export type WsClientStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ClientOptions {
	bridge: string;
	target: string;
	token: string;
	cols: number;
	rows: number;
	onData: (chunk: string) => void;
	onStatus: (status: WsClientStatus, info?: { code?: number; message?: string }) => void;
}

interface ServerMsg {
	type: 'data' | 'exit' | 'error';
	d?: string;
	code?: number;
	message?: string;
}

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

	constructor(opts: ClientOptions) {
		this.opts = opts;
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
			ws.send(
				JSON.stringify({
					type: 'connect',
					target: this.opts.target,
					token: this.opts.token,
					cols: this.opts.cols,
					rows: this.opts.rows
				})
			);
			this.opts.onStatus('open');
		};

		ws.onmessage = (ev) => {
			let msg: ServerMsg;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
			} catch {
				return;
			}
			if (msg.type === 'data' && typeof msg.d === 'string') {
				this.opts.onData(msg.d);
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

	resize(cols: number, rows: number): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
		}
	}

	close(): void {
		this.closed = true;
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
