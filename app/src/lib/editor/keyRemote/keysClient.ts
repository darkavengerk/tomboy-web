import { bridgeToWsUrl } from '$lib/editor/terminal/wsClient.js';

export type KeysClientStatus = 'connecting' | 'ready' | 'closed' | 'error';

export interface KeysClientCallbacks {
	onStatus: (status: KeysClientStatus, info?: { message?: string }) => void;
	onKeyOk: (code: number) => void;
	onKeyError: (code: number, message: string) => void;
}

/** 테스트 주입용 최소 WebSocket 인터페이스. */
export interface WsLike {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}

interface KeysClientOptions {
	bridge: string;
	/** `ssh://...` 형식의 와이어 타깃. */
	target: string;
	token: string;
	callbacks: KeysClientCallbacks;
	/** 기본은 브라우저 WebSocket. 테스트에서 가짜 소켓 주입. */
	socketFactory?: (url: string) => WsLike;
}

/**
 * keys 모드 전용 얇은 WS 클라이언트. 터미널 wsClient는 PTY data 프레임/관전
 * 모드 전용이라 재사용하지 않고, connect + sendKey + 콜백만 갖는 최소 구현.
 */
export class KeysWsClient {
	private ws: WsLike | null = null;
	private opts: KeysClientOptions;
	private closed = false;

	constructor(opts: KeysClientOptions) {
		this.opts = opts;
	}

	connect(): void {
		this.opts.callbacks.onStatus('connecting');
		let url: string;
		try {
			url = bridgeToWsUrl(this.opts.bridge);
		} catch (err) {
			this.opts.callbacks.onStatus('error', { message: (err as Error).message });
			return;
		}
		const factory =
			this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
		const ws = factory(url);
		this.ws = ws;
		ws.onopen = () => {
			ws.send(
				JSON.stringify({ type: 'connect', target: this.opts.target, mode: 'keys', token: this.opts.token })
			);
		};
		ws.onmessage = (ev) => {
			let msg: { type?: string; code?: number; message?: string };
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.type === 'ready') this.opts.callbacks.onStatus('ready');
			else if (msg.type === 'key-ok' && typeof msg.code === 'number')
				this.opts.callbacks.onKeyOk(msg.code);
			else if (msg.type === 'key-error')
				this.opts.callbacks.onKeyError(
					typeof msg.code === 'number' ? msg.code : -1,
					msg.message ?? '키 전송 실패'
				);
			else if (msg.type === 'error')
				this.opts.callbacks.onStatus('error', { message: msg.message ?? '연결 오류' });
		};
		ws.onerror = () => {
			if (!this.closed) this.opts.callbacks.onStatus('error', { message: '연결 오류' });
		};
		ws.onclose = () => {
			if (!this.closed) this.opts.callbacks.onStatus('closed');
		};
	}

	sendKey(code: number): void {
		if (!this.ws) return;
		this.ws.send(JSON.stringify({ type: 'key', code }));
	}

	close(): void {
		this.closed = true;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
	}
}
