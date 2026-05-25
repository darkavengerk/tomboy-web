import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SpectatorHub, SpectatorSubscription, SpectatorHubRegistry, HubRegistry, hubKey } from './spectatorHub.js';
import type { SpectatorCallbacks } from './spectatorSession.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Mock TmuxControlClient — emits events, stubs command() */
class MockTmux extends EventEmitter {
	commands: string[] = [];
	command(cmd: string): Promise<string[]> {
		this.commands.push(cmd);
		return Promise.resolve([]);
	}
	close(): void { this.emit('exit'); }
	feed(_b: Buffer): void {}
}

/** Mock ssh ChildProcess */
class MockSsh extends EventEmitter {
	killed = false;
	stdin = { write: () => {} };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(): void { this.killed = true; }
}

function makeCallbacks(): SpectatorCallbacks & { events: string[] } {
	const events: string[] = [];
	return {
		events,
		paneSwitch: (info) => events.push(`paneSwitch:${info.paneId}`),
		data: (text) => events.push(`data:${text.length}`),
		paneResize: (info) => events.push(`resize:${info.cols}x${info.rows}`),
		paneUnavailable: (info) => events.push(`unavail:${info.pinnedOrdinal}/${info.paneCount}`),
		error: (msg) => events.push(`error:${msg}`),
		exit: (reason) => events.push(`exit:${reason ?? 'none'}`)
	};
}

function makeHub(key = 'u@h:22|s'): { hub: SpectatorHub; ssh: MockSsh; tmux: MockTmux; destroyed: boolean[] } {
	const ssh = new MockSsh();
	const tmux = new MockTmux();
	const destroyed: boolean[] = [];
	const hub = new SpectatorHub({
		ssh: ssh as any,
		tmux: tmux as any,
		hubKey: key,
		sessionName: 's',
		onDestroy: () => destroyed.push(true)
	});
	return { hub, ssh, tmux, destroyed };
}

// ---------------------------------------------------------------------------
// hubKey pure function tests
// ---------------------------------------------------------------------------

test('hubKey: builds canonical key from target + session', () => {
	assert.equal(
		hubKey({ host: 'h', user: 'u', port: 22 }, 'work'),
		'u@h:22|work'
	);
	assert.equal(
		hubKey({ host: 'h' }, 'work'),
		'@h:22|work'  // user empty, port defaults to 22
	);
});

test('hubKey: same target + session → identical key', () => {
	assert.equal(
		hubKey({ host: 'h', user: 'u' }, 's'),
		hubKey({ host: 'h', user: 'u' }, 's')
	);
});

test('hubKey: different session → different key', () => {
	assert.notEqual(
		hubKey({ host: 'h', user: 'u' }, 's1'),
		hubKey({ host: 'h', user: 'u' }, 's2')
	);
});

test('hubKey: different host → different key', () => {
	assert.notEqual(
		hubKey({ host: 'h1', user: 'u' }, 's'),
		hubKey({ host: 'h2', user: 'u' }, 's')
	);
});

test('hubKey: port included in key', () => {
	assert.notEqual(
		hubKey({ host: 'h', user: 'u', port: 22 }, 's'),
		hubKey({ host: 'h', user: 'u', port: 2222 }, 's')
	);
	// Explicit 22 and default 22 must be the same
	assert.equal(
		hubKey({ host: 'h', user: 'u', port: 22 }, 's'),
		hubKey({ host: 'h', user: 'u' }, 's')
	);
});

// ---------------------------------------------------------------------------
// SpectatorHub lifecycle tests
// ---------------------------------------------------------------------------

test('SpectatorHub: last subscription unsubscribe → destroy fires', () => {
	const { hub, ssh, destroyed } = makeHub();
	const sub1 = new SpectatorSubscription(hub, makeCallbacks());
	const sub2 = new SpectatorSubscription(hub, makeCallbacks());
	sub1.close();
	assert.equal(destroyed.length, 0, 'still has sub2');
	sub2.close();
	assert.equal(destroyed.length, 1, 'destroy fired after last sub closes');
	assert.equal(ssh.killed, true, 'ssh was killed');
});

test('SpectatorHub: ssh exit → all subs get exit callback + hub destroyed', () => {
	const { hub, ssh, destroyed } = makeHub();
	const cb1 = makeCallbacks();
	const cb2 = makeCallbacks();
	new SpectatorSubscription(hub, cb1);
	new SpectatorSubscription(hub, cb2);
	ssh.emit('exit', 1, null);
	assert.ok(cb1.events.some((e) => e.startsWith('exit:')), 'cb1 got exit');
	assert.ok(cb2.events.some((e) => e.startsWith('exit:')), 'cb2 got exit');
	assert.equal(destroyed.length, 1, 'hub was destroyed');
});

test('SpectatorHub: ssh stderr tail included in exit reason', () => {
	const { hub, ssh } = makeHub();
	const cb = makeCallbacks();
	new SpectatorSubscription(hub, cb);
	ssh.stderr.emit('data', Buffer.from('Permission denied (publickey).\n'));
	ssh.emit('exit', 255, null);
	const exitEvent = cb.events.find((e) => e.startsWith('exit:'));
	assert.ok(exitEvent, 'exit event present');
	assert.ok(exitEvent?.includes('Permission denied'), `exit reason should include stderr: ${exitEvent}`);
});

test('SpectatorHub: ssh exit with signal → reason contains signal', () => {
	const { hub, ssh } = makeHub();
	const cb = makeCallbacks();
	new SpectatorSubscription(hub, cb);
	ssh.emit('exit', null, 'SIGKILL');
	const exitEvent = cb.events.find((e) => e.startsWith('exit:'));
	assert.ok(exitEvent?.includes('SIGKILL'), `should include signal name: ${exitEvent}`);
});

test('SpectatorHub: double destroy is a no-op (idempotent)', () => {
	const { hub, destroyed } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close();
	assert.equal(destroyed.length, 1);
	// A second close on an already-closed sub should not double-destroy
	sub.close();
	assert.equal(destroyed.length, 1, 'onDestroy called only once');
});

test('SpectatorHub: ssh exit after manual close does not double-destroy', () => {
	const { hub, ssh, destroyed } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close();  // triggers destroy (last sub)
	assert.equal(destroyed.length, 1);
	// ssh kill emits exit; destroy is already done, should be ignored
	ssh.emit('exit', 0, null);
	assert.equal(destroyed.length, 1, 'no double destroy on ssh exit after close');
});

// ---------------------------------------------------------------------------
// SpectatorHubRegistry tests
// ---------------------------------------------------------------------------

test('SpectatorHubRegistry: subscribe with spawnFn — first call creates hub', () => {
	const reg = buildIsolatedRegistry();
	const spawnCalls: string[][] = [];
	const mockSsh = buildMockSshFactory(spawnCalls);

	const cb = makeCallbacks();
	reg.subscribe({ host: 'h', user: 'u' }, 'main', cb, { spawnFn: mockSsh });

	assert.equal(spawnCalls.length, 1, 'spawn called once');
	assert.equal(reg.size(), 1, 'one hub in registry');
});

test('SpectatorHubRegistry: second subscribe with same key reuses hub (no second spawn)', () => {
	const reg = buildIsolatedRegistry();
	const spawnCalls: string[][] = [];
	const mockSsh = buildMockSshFactory(spawnCalls);

	const cb1 = makeCallbacks();
	const cb2 = makeCallbacks();
	reg.subscribe({ host: 'h', user: 'u' }, 'main', cb1, { spawnFn: mockSsh });
	reg.subscribe({ host: 'h', user: 'u' }, 'main', cb2, { spawnFn: mockSsh });

	assert.equal(spawnCalls.length, 1, 'spawn called only once for same key');
	assert.equal(reg.size(), 1, 'still one hub');
});

test('SpectatorHubRegistry: different session → different hub', () => {
	const reg = buildIsolatedRegistry();
	const spawnCalls: string[][] = [];
	const mockSsh = buildMockSshFactory(spawnCalls);

	const cb1 = makeCallbacks();
	const cb2 = makeCallbacks();
	reg.subscribe({ host: 'h', user: 'u' }, 'main', cb1, { spawnFn: mockSsh });
	reg.subscribe({ host: 'h', user: 'u' }, 'other', cb2, { spawnFn: mockSsh });

	assert.equal(spawnCalls.length, 2, 'spawn called twice for different sessions');
	assert.equal(reg.size(), 2, 'two hubs in registry');
});

test('SpectatorHubRegistry: last subscription close → hub removed from registry', () => {
	const reg = buildIsolatedRegistry();
	const mockSsh = buildMockSshFactory([]);

	const cb = makeCallbacks();
	const sub = reg.subscribe({ host: 'h', user: 'u' }, 'main', cb, { spawnFn: mockSsh });

	assert.equal(reg.size(), 1);
	sub.close();
	assert.equal(reg.size(), 0, 'hub removed from registry after last sub closes');
});

test('SpectatorHubRegistry: ssh exit → hub removed from registry', () => {
	const reg = buildIsolatedRegistry();
	const sshInstances: MockSsh[] = [];
	const mockSsh = buildMockSshFactoryCapture(sshInstances);

	const cb = makeCallbacks();
	reg.subscribe({ host: 'h', user: 'u' }, 'main', cb, { spawnFn: mockSsh });

	assert.equal(reg.size(), 1);
	sshInstances[0].emit('exit', 1, null);
	assert.equal(reg.size(), 0, 'hub removed from registry after ssh exit');
});

// ---------------------------------------------------------------------------
// Test helpers for isolated registry instances
// ---------------------------------------------------------------------------

/** Build a registry isolated from the module-level singleton. */
function buildIsolatedRegistry() {
	return new HubRegistry();
}

function buildMockSshFactory(callLog: string[][]): (...args: any[]) => any {
	return (_prog: string, args: string[], _opts: any) => {
		callLog.push(args);
		return new MockSsh();
	};
}

function buildMockSshFactoryCapture(instances: MockSsh[]): (...args: any[]) => any {
	return (_prog: string, _args: string[], _opts: any) => {
		const ssh = new MockSsh();
		instances.push(ssh);
		return ssh;
	};
}
