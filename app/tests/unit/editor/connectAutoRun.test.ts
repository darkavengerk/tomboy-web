import { describe, it, expect, vi } from 'vitest';
import { runConnectScript } from '$lib/editor/terminal/connectAutoRun.js';

describe('runConnectScript', () => {
	it('emits each line with trailing \\r', async () => {
		const sent: string[] = [];
		await runConnectScript(['ls -la', 'cd /tmp'], (s) => sent.push(s), 0);
		expect(sent).toEqual(['ls -la\r', 'cd /tmp\r']);
	});

	it('preserves order', async () => {
		const sent: string[] = [];
		await runConnectScript(['a', 'b', 'c'], (s) => sent.push(s), 0);
		expect(sent).toEqual(['a\r', 'b\r', 'c\r']);
	});

	it('skips empty and whitespace-only lines', async () => {
		const sent: string[] = [];
		await runConnectScript(['first', '', '   ', 'last'], (s) => sent.push(s), 0);
		expect(sent).toEqual(['first\r', 'last\r']);
	});

	it('continues if send throws on one line', async () => {
		const sent: string[] = [];
		const throwingSend = (s: string) => {
			if (s === 'bad\r') throw new Error('send failed');
			sent.push(s);
		};
		await runConnectScript(['good1', 'bad', 'good2'], throwingSend, 0);
		expect(sent).toEqual(['good1\r', 'good2\r']);
	});

	it('0-line input is a no-op', async () => {
		const sent: string[] = [];
		await runConnectScript([], (s) => sent.push(s), 0);
		expect(sent).toEqual([]);
	});
});
