import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSshArgs, controlMasterArgs, isLocalTarget, buildSshExecArgs } from './pty.js';

test('buildSshArgs: basic remote, no controlPath', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com', user: 'me' }), [
		'-o',
		'StrictHostKeyChecking=accept-new',
		'me@example.com'
	]);
});

test('buildSshArgs: includes port before the host', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com', user: 'me', port: 2222 }), [
		'-p',
		'2222',
		'-o',
		'StrictHostKeyChecking=accept-new',
		'me@example.com'
	]);
});

test('buildSshArgs: host-only when no user', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com' }), [
		'-o',
		'StrictHostKeyChecking=accept-new',
		'example.com'
	]);
});

test('buildSshArgs: adds ControlMaster flags when controlPath given', () => {
	const args = buildSshArgs({ host: 'h', user: 'u' }, '/tmp/tomboy-ctl/abc.sock');
	assert.ok(args.includes('ControlMaster=auto'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/abc.sock'));
	// 호스트는 항상 마지막 — 옵션이 호스트 뒤로 새지 않아야 한다.
	assert.equal(args[args.length - 1], 'u@h');
});

test('controlMasterArgs: returns ControlMaster + ControlPath flags', () => {
	assert.deepEqual(controlMasterArgs('/tmp/tomboy-ctl/abc.sock'), [
		'-o',
		'ControlMaster=auto',
		'-o',
		'ControlPath=/tmp/tomboy-ctl/abc.sock'
	]);
});

test('isLocalTarget: localhost with no user is local', () => {
	assert.equal(isLocalTarget({ host: 'localhost' }), true);
	assert.equal(isLocalTarget({ host: '127.0.0.1' }), true);
});

test('isLocalTarget: user@localhost is NOT local (routes through host sshd)', () => {
	assert.equal(isLocalTarget({ host: 'localhost', user: 'me' }), false);
});

test('isLocalTarget: arbitrary remote is not local', () => {
	assert.equal(isLocalTarget({ host: 'example.com', user: 'me' }), false);
});

test('buildSshExecArgs: command last, host before it', () => {
	const args = buildSshExecArgs(
		{ host: 'localhost', port: 18022, user: 'u0_a186' },
		'/tmp/x.sock',
		"su -c 'input keyevent 24'"
	);
	assert.equal(args[args.length - 1], "su -c 'input keyevent 24'");
	assert.equal(args[args.length - 2], 'u0_a186@localhost');
	assert.ok(args.includes('-p') && args.includes('18022'));
	assert.ok(args.includes('BatchMode=yes'));
	assert.ok(args.some((a) => a.startsWith('ControlPath=')));
	assert.ok(args.includes('ControlPersist=60'));
});

test('buildSshExecArgs: no controlPath → no multiplexing opts', () => {
	const args = buildSshExecArgs({ host: 'h' }, undefined, 'true');
	assert.ok(!args.some((a) => a.startsWith('ControlPath=')));
	assert.ok(!args.includes('ControlPersist=60'));
	assert.equal(args[args.length - 1], 'true');
	assert.equal(args[args.length - 2], 'h');
});
