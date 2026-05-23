import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: (ev: { data: string }) => void;
}

describe('TerminalWsClient image', () => {
	let fake: FakeState;
	let client: TerminalWsClient;
	let results: Array<{ ok: boolean; info: { path?: string; message?: string } }>;

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };
		results = [];

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() { return fake.readyState; }
			send(s: string) { fake.sent.push(s); }
			close() {}
			set onopen(fn: (() => void) | undefined) { fake.onopen = fn; }
			set onmessage(fn: ((ev: { data: string }) => void) | undefined) { fake.onmessage = fn; }
			set onclose(_fn: unknown) {}
			set onerror(_fn: unknown) {}
			static OPEN = 1;
		};

		client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://localhost',
			token: 't',
			cols: 80,
			rows: 24,
			onData: () => {},
			onStatus: () => {},
			onImageResult: (ok, info) => results.push({ ok, info })
		});
		client.connect();
		fake.onopen?.();
		fake.sent.length = 0;
	});

	it('sendImage sends an image frame', () => {
		client.sendImage({ mime: 'image/png', data: 'AQID' });
		expect(fake.sent).toEqual([
			JSON.stringify({ type: 'image', mime: 'image/png', data: 'AQID' })
		]);
	});

	it('throws when ws is CLOSED so caller sees a real error', () => {
		fake.readyState = 3; // CLOSED
		expect(() => client.sendImage({ mime: 'image/png', data: 'AQID' })).toThrow(/CLOSED/);
		expect(fake.sent).toEqual([]);
	});

	it('throws when ws is CONNECTING (avoid silent drop)', () => {
		fake.readyState = 0; // CONNECTING
		expect(() => client.sendImage({ mime: 'image/png', data: 'AQID' })).toThrow(/CONNECTING/);
		expect(fake.sent).toEqual([]);
	});

	it('image-ok message → onImageResult(true, {path})', () => {
		fake.onmessage?.({
			data: JSON.stringify({ type: 'image-ok', path: '/tmp/tomboy-images/x.png' })
		});
		expect(results).toEqual([{ ok: true, info: { path: '/tmp/tomboy-images/x.png' } }]);
	});

	it('image-error message → onImageResult(false, {message})', () => {
		fake.onmessage?.({ data: JSON.stringify({ type: 'image-error', message: 'boom' }) });
		expect(results).toEqual([{ ok: false, info: { message: 'boom' } }]);
	});
});
