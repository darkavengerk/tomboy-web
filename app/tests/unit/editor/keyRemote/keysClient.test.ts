import { describe, it, expect, vi } from 'vitest';
import { KeysWsClient, type WsLike } from '$lib/editor/keyRemote/keysClient.js';

function fakeSocket(): { ws: WsLike; sent: string[] } {
	const sent: string[] = [];
	const ws: WsLike = {
		send: (d) => sent.push(d),
		close: () => {},
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null
	};
	return { ws, sent };
}

function makeClient(ws: WsLike, cbOverrides = {}) {
	return new KeysWsClient({
		bridge: 'wss://b.example/',
		target: 'ssh://phone',
		token: 'T',
		callbacks: { onStatus: () => {}, onKeyOk: () => {}, onKeyError: () => {}, ...cbOverrides },
		socketFactory: () => ws
	});
}

describe('KeysWsClient', () => {
	it('sends connect frame with mode:keys on open', () => {
		const { ws, sent } = fakeSocket();
		makeClient(ws).connect();
		ws.onopen!();
		expect(JSON.parse(sent[0])).toEqual({ type: 'connect', target: 'ssh://phone', mode: 'keys', token: 'T' });
	});

	it('fires onStatus(ready) on ready msg', () => {
		const { ws } = fakeSocket();
		const onStatus = vi.fn();
		makeClient(ws, { onStatus }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'ready' }) });
		expect(onStatus).toHaveBeenCalledWith('ready');
	});

	it('sendKey emits key frame', () => {
		const { ws, sent } = fakeSocket();
		const c = makeClient(ws);
		c.connect();
		ws.onopen!();
		c.sendKey(24);
		expect(JSON.parse(sent[1])).toEqual({ type: 'key', code: 24 });
	});

	it('routes key-ok / key-error', () => {
		const { ws } = fakeSocket();
		const onKeyOk = vi.fn();
		const onKeyError = vi.fn();
		makeClient(ws, { onKeyOk, onKeyError }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'key-ok', code: 24 }) });
		ws.onmessage!({ data: JSON.stringify({ type: 'key-error', code: 25, message: 'nope' }) });
		expect(onKeyOk).toHaveBeenCalledWith(24);
		expect(onKeyError).toHaveBeenCalledWith(25, 'nope');
	});

	it('routes error msg to onStatus(error)', () => {
		const { ws } = fakeSocket();
		const onStatus = vi.fn();
		makeClient(ws, { onStatus }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'error', message: '터널 끊김' }) });
		expect(onStatus).toHaveBeenCalledWith('error', { message: '터널 끊김' });
	});
});
