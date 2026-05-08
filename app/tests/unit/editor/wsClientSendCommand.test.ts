import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: () => void;
	onclose?: () => void;
	onerror?: () => void;
}

describe('TerminalWsClient.sendCommand', () => {
	let fake: FakeState;
	let client: TerminalWsClient;

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() { return fake.readyState; }
			send(s: string) { fake.sent.push(s); }
			close() {}
			set onopen(fn: (() => void) | undefined) { fake.onopen = fn; }
			set onmessage(fn: (() => void) | undefined) { fake.onmessage = fn; }
			set onclose(fn: (() => void) | undefined) { fake.onclose = fn; }
			set onerror(fn: (() => void) | undefined) { fake.onerror = fn; }
			static OPEN = 1;
		};

		client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://localhost',
			token: 't',
			cols: 80,
			rows: 24,
			onData: () => {},
			onStatus: () => {}
		});
		client.connect();
		// Trigger onopen so the connect frame is sent and clear it from sent[].
		fake.onopen?.();
		fake.sent.length = 0;
	});

	it('sends plain text without trailing CR when autoExecute=false', () => {
		client.sendCommand('ls -la', false);
		expect(fake.sent).toEqual([JSON.stringify({ type: 'data', d: 'ls -la' })]);
	});

	it('appends \\r when autoExecute=true', () => {
		client.sendCommand('ls -la', true);
		expect(fake.sent).toEqual([JSON.stringify({ type: 'data', d: 'ls -la\r' })]);
	});

	it('no-ops when ws is not open', () => {
		fake.readyState = 3; // CLOSED
		client.sendCommand('whatever', true);
		expect(fake.sent).toEqual([]);
	});
});
