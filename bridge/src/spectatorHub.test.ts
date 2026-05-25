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
// Task 2: Hub state caching + tmux event fan-out tests
// ---------------------------------------------------------------------------

test('SpectatorHub.bootstrap: populates sessionId/windowId/activePaneId/paneStates/order', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|5|3|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	assert.equal(hub.sessionId, '$1');
	assert.equal(hub.windowId, '@1');
	assert.equal(hub.activePaneId, '%2');
	assert.deepEqual(hub.currentWindowPaneOrder, ['%2', '%3', '%4']);
	const state = hub.paneStates.get('%2');
	assert.ok(state, 'paneState for active pane populated');
	assert.equal(state?.cols, 80);
	assert.equal(state?.rows, 24);
	assert.equal(state?.altScreen, false);
	assert.equal(state?.cursorX, 5);
	assert.equal(state?.cursorY, 3);
	assert.equal(state?.windowIndex, '0');
	assert.equal(state?.windowName, 'main');
});

test('SpectatorHub.bootstrap: concurrent callers share same bootPromise', async () => {
	const { hub, tmux } = makeHub();
	let callCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) { callCount++; return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']); }
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	const p1 = hub.bootstrap('work');
	const p2 = hub.bootstrap('work');
	assert.equal(p1, p2, 'same Promise reference');
	await p1;
	assert.equal(callCount, 1, 'display-message called once despite two bootstrap() calls');
});

test('SpectatorHub: %window-pane-changed → debounced activePaneId update + listener fire', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const fired: string[] = [];
	hub.addActivePaneListener((id) => fired.push(id));

	tmux.emit('windowPaneChanged', '@1', '%3');
	// Before debounce fires
	assert.equal(hub.activePaneId, '%2', 'activePaneId not yet changed before debounce');
	assert.equal(fired.length, 0, 'listener not yet called before debounce');

	await new Promise((r) => setTimeout(r, 150));
	assert.equal(hub.activePaneId, '%3', 'activePaneId updated after debounce');
	assert.deepEqual(fired, ['%3'], 'listener called with new paneId');
});

test('SpectatorHub: %window-pane-changed for wrong window is ignored', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const fired: string[] = [];
	hub.addActivePaneListener((id) => fired.push(id));

	// Emit event for a DIFFERENT window
	tmux.emit('windowPaneChanged', '@99', '%9');
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(hub.activePaneId, '%2', 'activePaneId unchanged for wrong window');
	assert.equal(fired.length, 0, 'listener not called for wrong window');
});

test('SpectatorHub: %session-window-changed → windowId update + pane order refresh + listeners', async () => {
	const { hub, tmux } = makeHub();
	let listPaneTarget = '@1';
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%5']);
		if (cmd.startsWith('list-panes')) {
			listPaneTarget = cmd.includes('@2') ? '@2' : '@1';
			return listPaneTarget === '@2'
				? Promise.resolve(['%5', '%6'])
				: Promise.resolve(['%2', '%3']);
		}
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const orderFired: string[][] = [];
	const activeFired: string[] = [];
	hub.addWindowOrderListener((order) => orderFired.push([...order]));
	hub.addActivePaneListener((id) => activeFired.push(id));

	tmux.emit('sessionWindowChanged', '$1', '@2');
	await new Promise((r) => setTimeout(r, 150));

	assert.equal(hub.windowId, '@2');
	assert.deepEqual(hub.currentWindowPaneOrder, ['%5', '%6']);
	assert.equal(hub.activePaneId, '%5');
	// windowOrderListeners fired
	assert.ok(orderFired.length > 0, 'windowOrderListeners fired');
	assert.deepEqual(orderFired[orderFired.length - 1], ['%5', '%6']);
	// activePaneListeners fired for new window's active pane
	assert.ok(activeFired.includes('%5'), 'activePaneListener fired for new active pane');
});

test('SpectatorHub: %session-window-changed for wrong session is ignored', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const orderFired: string[][] = [];
	hub.addWindowOrderListener((order) => orderFired.push(order));

	tmux.emit('sessionWindowChanged', '$99', '@9');
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(hub.windowId, '@1', 'windowId unchanged for wrong session');
	assert.equal(orderFired.length, 0, 'windowOrderListeners not called for wrong session');
});

test('SpectatorHub: %output fans out to all addOutputListener registrations', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const r1: Array<[string, string]> = [];
	const r2: Array<[string, string]> = [];
	hub.addOutputListener((paneId, bytes) => r1.push([paneId, bytes.toString()]));
	hub.addOutputListener((paneId, bytes) => r2.push([paneId, bytes.toString()]));
	tmux.emit('output', '%2', Buffer.from('hello'));
	tmux.emit('output', '%3', Buffer.from('world'));
	assert.deepEqual(r1, [['%2', 'hello'], ['%3', 'world']]);
	assert.deepEqual(r2, [['%2', 'hello'], ['%3', 'world']]);
});

test('SpectatorHub: %output fans out after bootstrap (separate, clean test)', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const received: Array<[string, string]> = [];
	hub.addOutputListener((paneId, bytes) => received.push([paneId, bytes.toString()]));

	tmux.emit('output', '%2', Buffer.from('hello'));
	tmux.emit('output', '%3', Buffer.from('world'));
	assert.deepEqual(received, [['%2', 'hello'], ['%3', 'world']]);
});

test('SpectatorHub: %layout-change fires layoutChangeListeners + refreshes order', async () => {
	const { hub, tmux } = makeHub();
	let listPanesCallCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) {
			listPanesCallCount++;
			// After first (bootstrap), subsequent layout-change adds a pane
			return listPanesCallCount === 1
				? Promise.resolve(['%2'])
				: Promise.resolve(['%2', '%9']);
		}
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	assert.deepEqual(hub.currentWindowPaneOrder, ['%2']);

	const layoutFired: string[] = [];
	const orderFired: string[][] = [];
	hub.addLayoutChangeListener((wid) => layoutFired.push(wid));
	hub.addWindowOrderListener((order) => orderFired.push([...order]));

	tmux.emit('layoutChange', '@1');
	// refreshPaneOrder is async — give it a tick
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(hub.currentWindowPaneOrder, ['%2', '%9'], 'pane order refreshed after layout change');
	assert.deepEqual(layoutFired, ['@1'], 'layoutChangeListener fired');
	// windowOrderListeners should also fire since order changed
	assert.ok(orderFired.length > 0, 'windowOrderListeners fired after order change');
});

test('SpectatorHub: %layout-change for wrong window is ignored', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const layoutFired: string[] = [];
	hub.addLayoutChangeListener((wid) => layoutFired.push(wid));

	tmux.emit('layoutChange', '@99');
	await new Promise((r) => setImmediate(r));
	assert.equal(layoutFired.length, 0, 'layoutChangeListener not called for wrong window');
});

test('SpectatorHub: removeOutputListener stops fan-out', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const received: string[] = [];
	const listener = (paneId: string) => received.push(paneId);
	hub.addOutputListener(listener);
	tmux.emit('output', '%2', Buffer.from('before'));
	hub.removeOutputListener(listener);
	tmux.emit('output', '%2', Buffer.from('after'));
	assert.deepEqual(received, ['%2'], 'listener only received before removal');
});

test('SpectatorHub: refreshPaneOrder only fires listeners when order changes', async () => {
	const { hub, tmux } = makeHub();
	let listCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) {
			listCount++;
			// Always return same order
			return Promise.resolve(['%2', '%3']);
		}
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	// Order is ['%2', '%3'] after bootstrap

	const orderFired: number[] = [];
	hub.addWindowOrderListener(() => orderFired.push(orderFired.length));

	// layout-change with same panes → no listener fire
	tmux.emit('layoutChange', '@1');
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

	assert.equal(orderFired.length, 0, 'windowOrderListeners NOT fired when order unchanged');
});

test('SpectatorHub.ensurePaneState: returns cached state without querying tmux', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const queriesBefore = tmux.commands.length;
	const state = await hub.ensurePaneState('%2');
	assert.ok(state, 'state returned');
	assert.equal(state?.cols, 80);
	assert.equal(tmux.commands.length, queriesBefore, 'no extra tmux command for cached pane');
});

test('SpectatorHub.ensurePaneState: queries tmux for unknown paneId and caches result', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %9')) return Promise.resolve(['100|30|1|5|10|1|bash']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const state = await hub.ensurePaneState('%9');
	assert.ok(state, 'state queried and returned');
	assert.equal(state?.cols, 100);
	assert.equal(state?.rows, 30);
	assert.equal(state?.altScreen, true);

	// Second call should use cache
	const queriesBefore = tmux.commands.length;
	const state2 = await hub.ensurePaneState('%9');
	assert.equal(state2?.cols, 100);
	assert.equal(tmux.commands.length, queriesBefore, 'second call uses cache');
});

test('SpectatorHub.captureSeed: returns lines from capture-pane', async () => {
	const { hub, tmux } = makeHub();
	const capturedCmds: string[] = [];
	tmux.command = (cmd: string) => {
		capturedCmds.push(cmd);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['line1', 'line2', 'line3']);
		return Promise.resolve([]);
	};
	const lines = await hub.captureSeed('%2', 1000);
	assert.deepEqual(lines, ['line1', 'line2', 'line3']);
	assert.ok(
		capturedCmds.some((c) => c.includes('capture-pane') && c.includes('%2') && c.includes('1000')),
		`expected capture-pane command with %2 and 1000, got: ${capturedCmds.join(', ')}`
	);
});

test('SpectatorHub.captureSeed: returns empty array on error', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('capture-pane')) return Promise.reject(new Error('pane gone'));
		return Promise.resolve([]);
	};
	const lines = await hub.captureSeed('%9', 500);
	assert.deepEqual(lines, []);
});

test('SpectatorHub.destroy: clears pending debounce timer', async () => {
	const { hub, tmux, destroyed } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const sub = new SpectatorSubscription(hub, makeCallbacks());
	// Trigger a debounce
	tmux.emit('windowPaneChanged', '@1', '%3');
	// Close before debounce fires
	sub.close(); // triggers destroy (last sub)
	assert.equal(destroyed.length, 1, 'hub destroyed');
	// Wait longer than debounce — should not throw or fire listeners
	await new Promise((r) => setTimeout(r, 200));
	// If the timer was not cleared, this would fire and potentially throw — test just verifies no crash
	assert.equal(hub.activePaneId, '%2', 'activePaneId unchanged (timer was cleared on destroy)');
});

test('HubRegistry.subscribe: calls bootstrap after creating hub', () => {
	const reg = buildIsolatedRegistry();
	const hubs: SpectatorHub[] = [];
	const mockSsh = buildMockSshFactory([]);
	// We can't easily intercept bootstrap, but we verify bootPromise is set
	const sub = reg.subscribe({ host: 'h', user: 'u' }, 'main', makeCallbacks(), { spawnFn: mockSsh });
	const hub = reg.get(hubKey({ host: 'h', user: 'u' }, 'main'));
	assert.ok(hub, 'hub in registry');
	assert.ok(hub?.bootPromise !== null, 'bootPromise set (bootstrap was called)');
	void hubs; // unused
	sub.close();
});

// ---------------------------------------------------------------------------
// Critical 1: separate pane-change + window-change timers
// ---------------------------------------------------------------------------

test('SpectatorHub: interleaved paneChange + windowChange both fire (separate timers)', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%5']);
		if (cmd.startsWith('list-panes')) {
			return cmd.includes('@2')
				? Promise.resolve(['%5', '%6'])
				: Promise.resolve(['%2', '%3']);
		}
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const activeFired: string[] = [];
	const orderFired: string[][] = [];
	hub.addActivePaneListener((id) => activeFired.push(id));
	hub.addWindowOrderListener((order) => orderFired.push([...order]));

	// Emit both events within 50ms of each other (well inside 100ms debounce)
	tmux.emit('windowPaneChanged', '@1', '%3');
	await new Promise((r) => setTimeout(r, 50));
	tmux.emit('sessionWindowChanged', '$1', '@2');

	// Wait for both debounces to fire
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(activeFired.includes('%3'), 'pane-change listener fired for %3');
	assert.ok(activeFired.includes('%5'), 'window-change listener fired for %5 (new window active pane)');
	assert.ok(orderFired.some((o) => o.includes('%5')), 'windowOrderListeners fired for new window');
});

// ---------------------------------------------------------------------------
// Critical 2: failed bootstrap removes hub from registry
// ---------------------------------------------------------------------------

test('SpectatorHub: bootstrap failure fires error callbacks and self-removes from registry', async () => {
	// Wire a hub directly to a registry so onDestroy removes it from the registry map.
	const hubs: Map<string, SpectatorHub> = new Map();
	const key = 'u3@h3:22|fail';

	const ssh = new MockSsh();
	const tmux = new MockTmux();
	const hub = new SpectatorHub({
		ssh: ssh as any,
		tmux: tmux as any,
		hubKey: key,
		sessionName: 'fail',
		onDestroy: () => hubs.delete(key)
	});
	hubs.set(key, hub);

	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		// Return malformed line (< 10 parts) → bootstrap throws
		if (cmd.startsWith('display-message')) return Promise.resolve(['bad-line']);
		return Promise.resolve([]);
	};

	const errors: string[] = [];
	const cb1 = makeCallbacks();
	cb1.error = (msg) => errors.push(msg);
	new SpectatorSubscription(hub, cb1);

	assert.equal(hubs.size, 1, 'hub in map before bootstrap');

	// Bootstrap — will fail, hub should self-remove
	try { await hub.bootstrap('fail'); } catch { /* expected */ }
	await new Promise((r) => setImmediate(r));

	assert.ok(errors.length > 0, 'error callback fired on bootstrap failure');
	assert.equal(hubs.size, 0, 'dead hub removed from map after bootstrap failure');

	// Verify a second hub with the same key can be inserted (registry would create a fresh one)
	const { hub: hub2, tmux: tmux2 } = makeHub(key);
	tmux2.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	hubs.set(key, hub2);
	assert.equal(hubs.size, 1, 'fresh hub can be registered under same key');
	assert.notEqual(hub, hub2, 'second hub is a different instance');
});

// ---------------------------------------------------------------------------
// Important 3: ensurePaneState concurrent inflight deduplication
// ---------------------------------------------------------------------------

test('SpectatorHub.ensurePaneState: concurrent calls for same unknown pane issue only one tmux command', async () => {
	const { hub, tmux } = makeHub();
	const pane9Calls: string[] = [];
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %9')) {
			pane9Calls.push(cmd);
			return Promise.resolve(['100|30|0|0|0|1|bash']);
		}
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// Launch two concurrent ensurePaneState calls for the same unknown pane
	const [s1, s2] = await Promise.all([
		hub.ensurePaneState('%9'),
		hub.ensurePaneState('%9')
	]);

	assert.equal(pane9Calls.length, 1, 'only one tmux command for concurrent ensurePaneState');
	assert.ok(s1, 'first caller got state');
	assert.ok(s2, 'second caller got state');
	assert.equal(s1?.cols, 100);
	assert.equal(s2?.cols, 100);
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
