import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpectatorSshArgs, panePosition } from './spectatorSession.js';

test('buildSpectatorSshArgs: basic remote, no controlPath', () => {
	const args = buildSpectatorSshArgs({ host: 'h', user: 'u' }, 'work');
	assert.deepEqual(args, [
		'-tt',
		'-o', 'StrictHostKeyChecking=accept-new',
		'u@h',
		'stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t work'
	]);
});

test('buildSpectatorSshArgs: includes port before -o flags', () => {
	const args = buildSpectatorSshArgs({ host: 'h', user: 'u', port: 2222 }, 'work');
	assert.equal(args[0], '-tt');
	assert.equal(args[1], '-p');
	assert.equal(args[2], '2222');
});

test('buildSpectatorSshArgs: controlPath inserts ControlMaster flags before host', () => {
	const args = buildSpectatorSshArgs(
		{ host: 'h', user: 'u' },
		'work',
		'/tmp/tomboy-ctl/xyz.sock'
	);
	assert.ok(args.includes('ControlMaster=auto'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/xyz.sock'));
	// 호스트는 항상 stty 명령 직전 — 옵션들이 호스트 뒤로 새지 않아야 한다.
	const hostIdx = args.indexOf('u@h');
	const sttyIdx = args.findIndex((a) => a.startsWith('stty '));
	assert.equal(sttyIdx, hostIdx + 1);
});

test('buildSpectatorSshArgs: host-only when no user', () => {
	const args = buildSpectatorSshArgs({ host: 'h' }, 'work');
	assert.ok(args.includes('h'));
	assert.ok(!args.some((a) => a.endsWith('@h')));
});

test('panePosition: active pane is the 2nd of 4', () => {
	const r = panePosition(['%1', '%2', '%3', '%4'], '%2');
	assert.deepEqual(r, { ordinal: 2, count: 4 });
});

test('panePosition: active pane id absent → ordinal 0, count kept', () => {
	const r = panePosition(['%1', '%2'], '%9');
	assert.deepEqual(r, { ordinal: 0, count: 2 });
});

test('panePosition: empty pane list → ordinal 0, count 0', () => {
	const r = panePosition([], '%1');
	assert.deepEqual(r, { ordinal: 0, count: 0 });
});

test('panePosition: first pane → ordinal 1', () => {
	const r = panePosition(['%7', '%8'], '%7');
	assert.deepEqual(r, { ordinal: 1, count: 2 });
});
