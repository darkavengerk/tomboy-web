import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
	TmuxControlParser,
	TmuxControlClient,
	decodeTmuxOctal
} from './tmuxControlClient.js';

// ─── decodeTmuxOctal ───────────────────────────────────────────────────────

test('decodeTmuxOctal: passthrough for printable ASCII', () => {
	const out = decodeTmuxOctal(Buffer.from('hello world!'));
	assert.equal(out.toString('utf8'), 'hello world!');
});

test('decodeTmuxOctal: 3-digit octal escapes decode to bytes', () => {
	// ESC=0x1b=033, LF=0x0a=012, BS=0x5c=134.
	const out = decodeTmuxOctal(Buffer.from('\\033[1m\\012x\\134y'));
	assert.deepEqual([...out], [0x1b, 0x5b, 0x31, 0x6d, 0x0a, 0x78, 0x5c, 0x79]);
});

test('decodeTmuxOctal: non-octal after backslash passes through literally', () => {
	// Backslash followed by 'abc' — not octal digits — stays as-is.
	const out = decodeTmuxOctal(Buffer.from('\\abc'));
	assert.equal(out.toString('latin1'), '\\abc');
});

test('decodeTmuxOctal: trailing backslash without 3 chars stays', () => {
	const out = decodeTmuxOctal(Buffer.from('foo\\'));
	assert.equal(out.toString('utf8'), 'foo\\');
});

test('decodeTmuxOctal: high bytes (UTF-8 multibyte) round-trip via octal', () => {
	// '한' (U+D55C) in UTF-8 = ED 95 9C = \355 \225 \234.
	const out = decodeTmuxOctal(Buffer.from('\\355\\225\\234'));
	assert.equal(out.toString('utf8'), '한');
});

// ─── Parser: notifications ─────────────────────────────────────────────────

function makeParser(): {
	p: TmuxControlParser;
	events: Array<[string, ...unknown[]]>;
} {
	const p = new TmuxControlParser();
	const events: Array<[string, ...unknown[]]> = [];
	for (const ev of [
		'output',
		'windowPaneChanged',
		'sessionWindowChanged',
		'layoutChange',
		'clientDetached',
		'exit',
		'notification',
		'spontaneousBlock',
		'commandResponse'
	]) {
		p.on(ev as 'output', (...args: unknown[]) => events.push([ev, ...args]));
	}
	return { p, events };
}

test('parser: %output decodes payload to bytes', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%output %12 hello\\033[1mbold\\033[0m\r\n'));
	assert.equal(events.length, 1);
	const [tag, paneId, bytes] = events[0];
	assert.equal(tag, 'output');
	assert.equal(paneId, '%12');
	assert.equal(
		(bytes as Buffer).toString('utf8'),
		'hello\x1b[1mbold\x1b[0m'
	);
});

test('parser: %window-pane-changed yields (window, pane)', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%window-pane-changed @5 %42\r\n'));
	assert.deepEqual(events, [['windowPaneChanged', '@5', '%42']]);
});

test('parser: %session-window-changed yields (session, window)', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%session-window-changed $0 @3\r\n'));
	assert.deepEqual(events, [['sessionWindowChanged', '$0', '@3']]);
});

test('parser: %layout-change yields all parts', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%layout-change @1 c0c0,80x24,0,0,1 c0c0,80x24,0,0,1 *\r\n'));
	assert.deepEqual(events, [
		['layoutChange', '@1', 'c0c0,80x24,0,0,1', 'c0c0,80x24,0,0,1', '*']
	]);
});

test('parser: %exit with reason', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%exit detached\r\n'));
	assert.deepEqual(events, [['exit', 'detached']]);
});

test('parser: %exit with no reason', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%exit\r\n'));
	assert.deepEqual(events, [['exit', '']]);
});

test('parser: unknown notification → notification event', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%pane-mode-changed %3\r\n'));
	assert.equal(events.length, 1);
	assert.equal(events[0][0], 'notification');
	assert.equal(events[0][1], '%pane-mode-changed');
	assert.equal((events[0][2] as Buffer).toString('ascii'), '%3');
});

// ─── Parser: %begin..%end blocks ───────────────────────────────────────────

test('parser: %begin..%end yields commandResponse(ok=true)', () => {
	const { p, events } = makeParser();
	p.feed(
		Buffer.from(
			[
				'%begin 1700000000 1 0',
				'line one',
				'line two',
				'%end 1700000000 1 0',
				''
			].join('\r\n')
		)
	);
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], ['commandResponse', true, ['line one', 'line two']]);
});

test('parser: %begin..%error yields commandResponse(ok=false)', () => {
	const { p, events } = makeParser();
	p.feed(
		Buffer.from(
			[
				'%begin 1 2 0',
				'bad target',
				'%error 1 2 0',
				''
			].join('\r\n')
		)
	);
	assert.deepEqual(events, [['commandResponse', false, ['bad target']]]);
});

test('parser: lines starting with `%` inside a block are body, not new notifications', () => {
	const { p, events } = makeParser();
	p.feed(
		Buffer.from(
			[
				'%begin 1 1 0',
				'%output (this is body, not a notification)',
				'normal line',
				'%end 1 1 0',
				''
			].join('\r\n')
		)
	);
	// Only one event — the commandResponse. The %output-looking line is body.
	assert.equal(events.length, 1);
	assert.equal(events[0][0], 'commandResponse');
	assert.deepEqual(events[0][2], [
		'%output (this is body, not a notification)',
		'normal line'
	]);
});

test('parser: events interleave correctly around blocks', () => {
	const { p, events } = makeParser();
	p.feed(
		Buffer.from(
			[
				'%output %1 before\\012',
				'%begin 1 1 0',
				'response',
				'%end 1 1 0',
				'%output %1 after\\012',
				''
			].join('\r\n')
		)
	);
	assert.equal(events.length, 3);
	assert.equal(events[0][0], 'output');
	assert.equal((events[0][2] as Buffer).toString('utf8'), 'before\n');
	assert.equal(events[1][0], 'commandResponse');
	assert.equal(events[2][0], 'output');
	assert.equal((events[2][2] as Buffer).toString('utf8'), 'after\n');
});

// ─── Parser: chunked input handling ────────────────────────────────────────

test('parser: handles input chunked mid-line', () => {
	const { p, events } = makeParser();
	const full = '%output %1 hel\\033lo\r\n%window-pane-changed @2 %5\r\n';
	for (let i = 0; i < full.length; i += 3) {
		p.feed(Buffer.from(full.slice(i, i + 3)));
	}
	assert.equal(events.length, 2);
	assert.equal((events[0][2] as Buffer).toString('utf8'), 'hel\x1blo');
	assert.equal(events[1][0], 'windowPaneChanged');
});

test('parser: handles LF-only line endings', () => {
	const { p, events } = makeParser();
	p.feed(Buffer.from('%output %1 ok\n%exit\n'));
	assert.equal(events.length, 2);
	assert.equal(events[0][0], 'output');
	assert.equal((events[0][2] as Buffer).toString('utf8'), 'ok');
	assert.equal(events[1][0], 'exit');
});

// ─── Client: command queue ────────────────────────────────────────────────

test('client: command() resolves with response lines (FIFO)', async () => {
	const upstream = new PassThrough();
	const written: string[] = [];
	upstream.on('data', (b: Buffer) => written.push(b.toString('utf8')));

	const client = new TmuxControlClient(upstream);
	const p1 = client.command('display -p foo');
	const p2 = client.command('display -p bar');

	// Simulate tmux responding to both in order.
	client.feed(
		Buffer.from(
			[
				'%begin 1 1 0',
				'foo-result',
				'%end 1 1 0',
				'%begin 2 2 0',
				'bar-result',
				'%end 2 2 0',
				''
			].join('\r\n')
		)
	);

	const [r1, r2] = await Promise.all([p1, p2]);
	assert.deepEqual(r1, ['foo-result']);
	assert.deepEqual(r2, ['bar-result']);
	assert.deepEqual(written, ['display -p foo\n', 'display -p bar\n']);
});

test('client: %error rejects pending command', async () => {
	const upstream = new PassThrough();
	const client = new TmuxControlClient(upstream);
	const p = client.command('bogus');
	client.feed(
		Buffer.from(['%begin 1 1 0', 'unknown command', '%error 1 1 0', ''].join('\r\n'))
	);
	await assert.rejects(p, /unknown command/);
});

test('client: unmatched block surfaces as spontaneousBlock', () => {
	const upstream = new PassThrough();
	const client = new TmuxControlClient(upstream);
	const spontaneous: string[][] = [];
	client.on('spontaneousBlock', (lines) => spontaneous.push(lines));

	// No pending command — initial-state dump style.
	client.feed(
		Buffer.from(['%begin 1 0 0', 'initial', 'state', '%end 1 0 0', ''].join('\r\n'))
	);
	assert.deepEqual(spontaneous, [['initial', 'state']]);
});

test('client: close() rejects all pending commands', async () => {
	const upstream = new PassThrough();
	const client = new TmuxControlClient(upstream);
	const p = client.command('foo');
	client.close();
	await assert.rejects(p, /client closed/);
});
