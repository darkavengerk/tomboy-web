import { describe, it, expect } from 'vitest';
import {
	parseOsc133Payload,
	extractCommand,
	shouldRecordCommand,
	Osc133State
} from '$lib/editor/terminal/oscCapture.js';

describe('parseOsc133Payload', () => {
	it('parses A/B/C with no params', () => {
		expect(parseOsc133Payload('A')).toEqual({ kind: 'A' });
		expect(parseOsc133Payload('B')).toEqual({ kind: 'B' });
		expect(parseOsc133Payload('C')).toEqual({ kind: 'C' });
	});

	it('parses D with exit code', () => {
		expect(parseOsc133Payload('D;0')).toEqual({ kind: 'D', exitCode: 0 });
		expect(parseOsc133Payload('D;130')).toEqual({ kind: 'D', exitCode: 130 });
	});

	it('parses bare D', () => {
		expect(parseOsc133Payload('D')).toEqual({ kind: 'D' });
	});

	it('returns null for unknown payloads', () => {
		expect(parseOsc133Payload('X')).toBeNull();
		expect(parseOsc133Payload('')).toBeNull();
		expect(parseOsc133Payload('AA')).toBeNull();
	});

	it('parses C with hex-encoded command text', () => {
		// 'ls -la' = 6c 73 20 2d 6c 61
		expect(parseOsc133Payload('C;6c73202d6c61')).toEqual({
			kind: 'C',
			commandText: 'ls -la'
		});
	});

	it('parses C with hex-encoded UTF-8 (Korean)', () => {
		// '안녕' = ec 95 88 eb 85 95
		expect(parseOsc133Payload('C;ec9588eb8595')).toEqual({
			kind: 'C',
			commandText: '안녕'
		});
	});

	it('falls back to plain C when hex is malformed', () => {
		expect(parseOsc133Payload('C;notHex')).toEqual({ kind: 'C' });
		expect(parseOsc133Payload('C;abc')).toEqual({ kind: 'C' }); // odd length
	});

	it('parses W with window id', () => {
		expect(parseOsc133Payload('W;@1')).toEqual({ kind: 'W', windowId: '@1' });
		expect(parseOsc133Payload('W;@42')).toEqual({ kind: 'W', windowId: '@42' });
	});

	it('rejects W without an id', () => {
		expect(parseOsc133Payload('W')).toBeNull();
		expect(parseOsc133Payload('W;')).toBeNull();
	});

	it('parses C with hex command and window id', () => {
		expect(parseOsc133Payload('C;6c73202d6c61;@1')).toEqual({
			kind: 'C',
			commandText: 'ls -la',
			windowId: '@1'
		});
	});

	it('preserves window id when hex is malformed', () => {
		expect(parseOsc133Payload('C;notHex;@1')).toEqual({
			kind: 'C',
			windowId: '@1'
		});
	});
});

describe('extractCommand', () => {
	// 'user@host:~$  ls -la...' — note the double space after '$' so that
	// promptCol 14 lands exactly on 'l' (0-indexed: u=0...$=12, sp=13, l=14).
	const lines: Record<number, string> = {
		3: 'user@host:~$  ls -la                                         ',
		4: '/very/long/path/that/wraps/here-and-here-and-here',
		5: ''
	};
	const getLine = (r: number) => lines[r] ?? '';

	it('single-row case', () => {
		const cmd = extractCommand({
			promptRow: 3,
			promptCol: 14, // start of 'ls -la'
			cursorRow: 3,
			cursorCol: 20, // after 'ls -la'
			getLine
		});
		expect(cmd).toBe('ls -la');
	});

	it('wrapped: command spans rows', () => {
		const cmd = extractCommand({
			promptRow: 3,
			promptCol: 14,
			cursorRow: 4,
			cursorCol: lines[4].length,
			getLine
		});
		// Trailing spaces of row 3 are stripped, row 4 is appended.
		expect(cmd).toBe('ls -la' + lines[4]);
	});

	it('cursor before prompt → empty', () => {
		expect(
			extractCommand({ promptRow: 5, promptCol: 0, cursorRow: 3, cursorCol: 0, getLine })
		).toBe('');
	});
});

describe('shouldRecordCommand', () => {
	const blocklist = ['ls', 'cd', 'pwd'];

	it('accepts a normal command', () => {
		expect(shouldRecordCommand('cat foo', blocklist)).toBe(true);
	});

	it('rejects empty', () => {
		expect(shouldRecordCommand('', blocklist)).toBe(false);
		expect(shouldRecordCommand('   ', blocklist)).toBe(false);
	});

	it('rejects whitespace-prefixed (ignorespace)', () => {
		expect(shouldRecordCommand(' echo hi', blocklist)).toBe(false);
		expect(shouldRecordCommand('\tcat foo', blocklist)).toBe(false);
	});

	it('rejects when first token is in blocklist', () => {
		expect(shouldRecordCommand('ls -la', blocklist)).toBe(false);
		expect(shouldRecordCommand('cd /etc', blocklist)).toBe(false);
		expect(shouldRecordCommand('pwd', blocklist)).toBe(false);
	});

	it('does not match blocklist on substring', () => {
		expect(shouldRecordCommand('lsblk', blocklist)).toBe(true); // first token 'lsblk' ≠ 'ls'
	});
});

describe('Osc133State', () => {
	it('hasDetected flips on first event', () => {
		const s = new Osc133State();
		expect(s.hasDetected).toBe(false);
		s.onPromptStart();
		expect(s.hasDetected).toBe(true);
	});

	it('command extraction uses recorded ;B coords', () => {
		const s = new Osc133State();
		s.onCommandStart(3, 14);
		const cmd = s.consumeCommandOnExecute(3, 20, (r) =>
			r === 3 ? 'user@host:~$  ls -la' : ''
		);
		expect(cmd).toBe('ls -la');
	});

	it('falls back to cursor row when ;B was missed', () => {
		const s = new Osc133State();
		const cmd = s.consumeCommandOnExecute(3, 6, (r) => (r === 3 ? 'pwd' : ''));
		expect(cmd).toBe('pwd');
	});

	it('clears prompt position after consume', () => {
		const s = new Osc133State();
		s.onCommandStart(3, 14);
		s.consumeCommandOnExecute(3, 20, () => 'user@host:~$ ls -la');
		const cmd = s.consumeCommandOnExecute(4, 5, (r) =>
			r === 4 ? 'echo' : ''
		);
		// Without a new ;B, the second extraction falls back to row start.
		expect(cmd).toBe('echo');
	});
});
