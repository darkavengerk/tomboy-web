import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: (ev: { data: string }) => void;
	onclose?: (ev: { code: number; reason: string }) => void;
	onerror?: () => void;
}

describe('TerminalWsClient.subscribePane', () => {
	let fake: FakeState;

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() {
				return fake.readyState;
			}
			send(s: string) {
				fake.sent.push(s);
			}
			close() {}
			set onopen(fn: (() => void) | undefined) {
				fake.onopen = fn;
			}
			set onmessage(fn: ((ev: { data: string }) => void) | undefined) {
				fake.onmessage = fn;
			}
			set onclose(fn: ((ev: { code: number; reason: string }) => void) | undefined) {
				fake.onclose = fn;
			}
			set onerror(fn: (() => void) | undefined) {
				fake.onerror = fn;
			}
			static OPEN = 1;
		};
	});

	it('subscribePane(3) sends {type:subscribe-pane, ordinal:3}', () => {
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 't',
			token: 'tk',
			cols: 80,
			rows: 24,
			onStatus: () => {},
			onData: () => {}
		});
		client.connect();
		fake.onopen?.();
		const before = fake.sent.length;
		client.subscribePane(3);
		expect(fake.sent.length).toBe(before + 1);
		const frame = JSON.parse(fake.sent[fake.sent.length - 1]);
		expect(frame).toEqual({ type: 'subscribe-pane', ordinal: 3 });
	});

	it('subscribePane(0) sends {type:subscribe-pane, ordinal:0} for unpin', () => {
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 't',
			token: 'tk',
			cols: 80,
			rows: 24,
			onStatus: () => {},
			onData: () => {}
		});
		client.connect();
		fake.onopen?.();
		client.subscribePane(0);
		const frame = JSON.parse(fake.sent[fake.sent.length - 1]);
		expect(frame).toEqual({ type: 'subscribe-pane', ordinal: 0 });
	});

	it('pane-unavailable message with valid numbers dispatches to onPaneUnavailable callback', () => {
		const received: Array<{ pinnedOrdinal: number; paneCount: number }> = [];
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 't',
			token: 'tk',
			cols: 80,
			rows: 24,
			onStatus: () => {},
			onData: () => {},
			onPaneUnavailable: (info) => received.push(info)
		});
		client.connect();
		fake.onopen?.();
		fake.onmessage?.({ data: JSON.stringify({ type: 'pane-unavailable', pinnedOrdinal: 5, paneCount: 2 }) });
		expect(received).toEqual([{ pinnedOrdinal: 5, paneCount: 2 }]);
	});

	it('pane-unavailable with invalid types (string pinnedOrdinal) does NOT call the callback', () => {
		const received: unknown[] = [];
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 't',
			token: 'tk',
			cols: 80,
			rows: 24,
			onStatus: () => {},
			onData: () => {},
			onPaneUnavailable: (info) => received.push(info)
		});
		client.connect();
		fake.onopen?.();
		fake.onmessage?.({ data: JSON.stringify({ type: 'pane-unavailable', pinnedOrdinal: 'x', paneCount: 2 }) });
		expect(received).toEqual([]);
	});
});
