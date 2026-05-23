import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpectatorSshArgs } from './spectatorSession.js';

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
