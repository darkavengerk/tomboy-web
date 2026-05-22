import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';
import type { PaneSwitchInfo } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: (ev: { data: string }) => void;
	onclose?: () => void;
	onerror?: () => void;
}

describe('TerminalWsClient pane-switch parsing', () => {
	let fake: FakeState;
	let switches: PaneSwitchInfo[];

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() { return fake.readyState; }
			send(s: string) { fake.sent.push(s); }
			close() {}
			set onopen(fn: (() => void) | undefined) { fake.onopen = fn; }
			set onmessage(fn: ((ev: { data: string }) => void) | undefined) { fake.onmessage = fn; }
			set onclose(fn: (() => void) | undefined) { fake.onclose = fn; }
			set onerror(fn: (() => void) | undefined) { fake.onerror = fn; }
			static OPEN = 1;
		};

		switches = [];
		const client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://you@desktop',
			token: 't',
			cols: 80,
			rows: 24,
			spectate: 'main',
			onData: () => {},
			onStatus: () => {},
			onPaneSwitch: (info) => switches.push(info)
		});
		client.connect();
		fake.onopen?.();
	});

	it('forwards paneOrdinal and paneCount from the frame', () => {
		fake.onmessage?.({
			data: JSON.stringify({
				type: 'pane-switch',
				paneId: '%3',
				cols: 80,
				rows: 24,
				altScreen: false,
				windowIndex: '1',
				windowName: 'main',
				paneOrdinal: 2,
				paneCount: 4
			})
		});
		expect(switches).toHaveLength(1);
		expect(switches[0].paneOrdinal).toBe(2);
		expect(switches[0].paneCount).toBe(4);
	});

	it('defaults paneOrdinal/paneCount to 0 when the frame omits them', () => {
		fake.onmessage?.({
			data: JSON.stringify({
				type: 'pane-switch',
				paneId: '%3',
				cols: 80,
				rows: 24,
				altScreen: false,
				windowIndex: '1',
				windowName: 'main'
			})
		});
		expect(switches).toHaveLength(1);
		expect(switches[0].paneOrdinal).toBe(0);
		expect(switches[0].paneCount).toBe(0);
	});
});
