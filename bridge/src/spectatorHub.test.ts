import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SpectatorHub, SpectatorSubscription, SpectatorHubRegistry, HubRegistry, hubKey, resolveOrdinal } from './spectatorHub.js';
import type { SpectatorCallbacks, SpectatorNavAction } from './spectatorSession.js';

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

// ---------------------------------------------------------------------------
// Task 3: SpectatorSubscription (follow-active mode)
// ---------------------------------------------------------------------------

test('SpectatorSubscription: default mode is follow-active, subscribedPaneId starts null', () => {
	const { hub } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	assert.equal(sub.mode.kind, 'follow-active');
	assert.equal(sub.subscribedPaneId, null);
	sub.close();
});

test('SpectatorSubscription: follow-active default + receives output for active pane only', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) {
			return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['line1', 'line2']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach(); // fires paneSwitch + seed for %2

	tmux.emit('output', '%2', Buffer.from('to-active'));
	tmux.emit('output', '%3', Buffer.from('to-other'));

	// %2 (subscribedPaneId) only
	const dataEvents = cb.events.filter((e) => e.startsWith('data:'));
	// at least: seed data + 'to-active' (9 bytes)
	assert.ok(dataEvents.length >= 2, `expected ≥ 2 data events, got: ${dataEvents.join(', ')}`);
	// 'to-active' = 9 bytes — exactly one such event (not from %3)
	const nineByteData = dataEvents.filter((e) => e === 'data:9');
	assert.equal(nineByteData.length, 1, `%3 bytes should be ignored; events: ${cb.events.join(', ')}`);
	sub.close();
});

test('SpectatorSubscription: attach fires paneSwitch with correct paneOrdinal/paneCount', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const paneSwitchEvents: any[] = [];
	const cb = makeCallbacks();
	cb.paneSwitch = (info) => paneSwitchEvents.push(info);
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();

	assert.equal(paneSwitchEvents.length, 1, 'one paneSwitch on attach');
	assert.equal(paneSwitchEvents[0].paneId, '%2');
	assert.equal(paneSwitchEvents[0].cols, 80);
	assert.equal(paneSwitchEvents[0].rows, 24);
	assert.equal(paneSwitchEvents[0].paneOrdinal, 1);
	assert.equal(paneSwitchEvents[0].paneCount, 3);
	sub.close();
});

test('SpectatorSubscription: seed = reset + captured content + cursor position', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|5|3|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['lineA', 'lineB']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const dataPayloads: string[] = [];
	const cb = makeCallbacks();
	cb.data = (text) => dataPayloads.push(text);
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();

	assert.equal(dataPayloads.length, 1, 'one data call for seed');
	const seed = dataPayloads[0];
	assert.ok(seed.startsWith('\x1b[?1049l\x1bc'), 'seed starts with reset+exit-alt');
	assert.ok(seed.includes('lineA\r\nlineB'), 'seed contains captured lines joined by CRLF');
	// cursor at x=5, y=3 → CSI 4;6H (1-based)
	assert.ok(seed.includes('\x1b[4;6H'), `seed should include cursor position, got: ${JSON.stringify(seed)}`);
	sub.close();
});

test('SpectatorSubscription: altScreen pane → seed includes \\x1b[?1049h', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|1|0|0|0|main']); // altScreen=1
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['alt-content']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const dataPayloads: string[] = [];
	const cb = makeCallbacks();
	cb.data = (text) => dataPayloads.push(text);
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();

	const seed = dataPayloads[0];
	assert.ok(seed.includes('\x1b[?1049h'), 'alt-screen seed includes enter-alt-screen escape');
	sub.close();
});

test('SpectatorSubscription: onActivePaneChanged → paneSwitch + new seed', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) {
			return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) {
			return Promise.resolve(['100|30|0|0|0|0|main']);
		}
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	cb.events.length = 0; // clear initial seed events

	tmux.emit('windowPaneChanged', '@1', '%3');
	await new Promise((r) => setTimeout(r, 150)); // wait for debounce + async

	assert.ok(cb.events.some((e) => e === 'paneSwitch:%3'), `expected paneSwitch:%3 in: ${cb.events.join(', ')}`);
	assert.equal(sub.subscribedPaneId, '%3', 'subscribedPaneId updated to %3');
	sub.close();
});

test('SpectatorSubscription: follow-active ignores windowOrderListener (no switchTo)', async () => {
	const { hub, tmux } = makeHub();
	let listPanesCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) {
			return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		}
		// scheduleWindowChange queries the new window for its active pane ID
		if (cmd.startsWith('display-message') && cmd.includes('-t @2')) {
			return Promise.resolve(['%5']);
		}
		// ensurePaneState('%5') — needed so switchTo('%5') doesn't bail early
		if (cmd.startsWith('display-message') && cmd.includes('-t %5')) {
			return Promise.resolve(['100|30|0|0|0|0|main']);
		}
		if (cmd.startsWith('list-panes')) {
			listPanesCount++;
			return cmd.includes('@2')
				? Promise.resolve(['%5', '%6'])
				: Promise.resolve(['%2', '%3']);
		}
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	cb.events.length = 0;

	// window switch triggers windowOrderListeners
	tmux.emit('sessionWindowChanged', '$1', '@2');
	await new Promise((r) => setTimeout(r, 200));

	// follow-active sub reacts to the activePaneListener (%5), not windowOrderListener
	// Either way it should have switched to %5 (via activePaneListener)
	assert.ok(cb.events.some((e) => e === 'paneSwitch:%5'), `follow-active should switch to new window active pane: ${cb.events.join(', ')}`);
	sub.close();
});

test('SpectatorSubscription: bytes during seed are queued + flushed in order', async () => {
	const { hub, tmux } = makeHub();
	let captureResolve: ((lines: string[]) => void) | null = null;
	const capturePromise = new Promise<string[]>((r) => {
		captureResolve = r;
	});
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return capturePromise;
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const dataPayloads: string[] = [];
	cb.data = (text) => dataPayloads.push(text);
	const sub = new SpectatorSubscription(hub, cb);
	const attachPromise = sub.attach();

	// Yield to microtasks so switchTo() runs past 'await bootPromise' and
	// sets subscribedPaneId + seeding=true before the output arrives.
	await new Promise((r) => setImmediate(r));

	// attach is in-flight (capture not resolved yet) — emit output
	tmux.emit('output', '%2', Buffer.from('during-seed'));

	// resolve capture → seed completes → queue flushed
	captureResolve!(['seed-content']);
	await attachPromise;

	// Must have: seed payload then 'during-seed'
	assert.ok(dataPayloads.length >= 2, `expected ≥ 2 data payloads, got: ${dataPayloads.join(', ')}`);
	// seed comes first (contains seed-content), queued output comes after
	assert.ok(dataPayloads[0].includes('seed-content'), `first payload should be seed, got: ${JSON.stringify(dataPayloads[0])}`);
	assert.equal(dataPayloads[dataPayloads.length - 1], 'during-seed', 'last payload is the queued bytes');
	sub.close();
});

test('SpectatorSubscription: two subs on same hub, seeding one does not delay the other', async () => {
	const { hub, tmux } = makeHub();
	let captureResolve1: ((lines: string[]) => void) | null = null;
	const capturePromise1 = new Promise<string[]>((r) => { captureResolve1 = r; });
	let captureCall = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) {
			captureCall++;
			// First capture (for sub1) hangs; second (sub2) resolves immediately
			return captureCall === 1 ? capturePromise1 : Promise.resolve(['sub2-seed']);
		}
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const data1: string[] = [];
	const data2: string[] = [];
	const cb1 = makeCallbacks(); cb1.data = (t) => data1.push(t);
	const cb2 = makeCallbacks(); cb2.data = (t) => data2.push(t);

	const sub1 = new SpectatorSubscription(hub, cb1);
	const sub2 = new SpectatorSubscription(hub, cb2);
	const attach1 = sub1.attach();
	await sub2.attach(); // sub2 resolves immediately

	// sub2 has its seed already; sub1 is still seeding
	assert.ok(data2.length > 0, 'sub2 got seed immediately');
	assert.equal(data1.length, 0, 'sub1 still seeding (capture not resolved)');

	// emit output for %2 — sub2 should get it immediately, sub1 queues it
	tmux.emit('output', '%2', Buffer.from('live-bytes'));
	assert.ok(data2.some((t) => t === 'live-bytes'), 'sub2 receives live bytes while sub1 still seeding');
	assert.equal(data1.length, 0, 'sub1 still blocked on seed');

	// resolve sub1's capture
	captureResolve1!(['sub1-seed']);
	await attach1;
	assert.ok(data1[0]?.includes('sub1-seed'), 'sub1 received seed first');
	assert.equal(data1[data1.length - 1], 'live-bytes', 'sub1 received queued bytes after seed');

	sub1.close();
	sub2.close();
});

test('SpectatorSubscription: close removes all listeners from hub', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// We need a second sub to prevent hub auto-destroy on close
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	const eventsBefore = cb.events.length;

	sub.close();

	// After close, output should not reach cb
	tmux.emit('output', '%2', Buffer.from('after-close'));
	tmux.emit('windowPaneChanged', '@1', '%2');
	await new Promise((r) => setTimeout(r, 150));

	assert.equal(cb.events.length, eventsBefore, 'no new events after close');
	keepAlive.close();
});

// ---------------------------------------------------------------------------
// Fix 1: switchTo — subscribedPaneId unchanged when paneState missing
// ---------------------------------------------------------------------------

test('SpectatorSubscription.switchTo: unknown paneId leaves subscribedPaneId unchanged', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		// Only bootstrap display-message succeeds; any other pane returns malformed (< 7 parts)
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) {
			return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('display-message')) return Promise.resolve([]); // unknown pane → null state
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// We need a second sub to keep the hub alive
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach(); // subscribedPaneId = '%2'

	const paneSwitchsBefore = cb.events.filter((e) => e.startsWith('paneSwitch:')).length;
	const prevPaneId = sub.subscribedPaneId;

	// Manually trigger a switch to a pane not in paneStates
	tmux.emit('windowPaneChanged', '@1', '%notInCache');
	await new Promise((r) => setTimeout(r, 200)); // wait past debounce

	// subscribedPaneId must remain the PREVIOUS value, not '%notInCache'
	assert.equal(sub.subscribedPaneId, prevPaneId, 'subscribedPaneId unchanged when paneState missing');
	// No new paneSwitch event should have fired
	const paneSwitchsAfter = cb.events.filter((e) => e.startsWith('paneSwitch:')).length;
	assert.equal(paneSwitchsAfter, paneSwitchsBefore, 'no paneSwitch fired for unknown pane');

	sub.close();
	keepAlive.close();
});

// ---------------------------------------------------------------------------
// Fix 2: attach() lifecycle guards
// ---------------------------------------------------------------------------

test('SpectatorSubscription.attach: called twice → second is no-op (one paneSwitch fires)', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);

	// Call attach twice concurrently
	await Promise.all([sub.attach(), sub.attach()]);

	const paneSwitchEvents = cb.events.filter((e) => e.startsWith('paneSwitch:'));
	assert.equal(paneSwitchEvents.length, 1, 'exactly one paneSwitch fires even when attach() called twice');

	sub.close();
});

test('SpectatorSubscription.attach: called after close() → no callbacks fire', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// We need a second sub to keep the hub alive after close
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	sub.close(); // close BEFORE attach

	await sub.attach(); // should be a no-op

	assert.equal(cb.events.length, 0, 'no callbacks fire when attach() called after close()');
	keepAlive.close();
});

// ---------------------------------------------------------------------------
// Fix 3: concurrent onHubActivePaneChanged — last paneId wins, no overlap
// ---------------------------------------------------------------------------

test('SpectatorSubscription: rapid pane switches — only final paneId subscribed', async () => {
	const { hub, tmux } = makeHub();
	// Populate pane states for %2, %3, %4 so none triggers the "paneState missing" bail
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) {
			return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) {
			return Promise.resolve(['80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('display-message') && cmd.includes('-t %4')) {
			return Promise.resolve(['80|24|0|0|0|0|main']);
		}
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// Pre-populate pane states for %3 and %4 so switchTo won't bail on missing state
	await hub.ensurePaneState('%3');
	await hub.ensurePaneState('%4');

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach(); // subscribedPaneId = '%2'
	cb.events.length = 0;

	// Emit two rapid windowPaneChanged events — before any debounce fires
	tmux.emit('windowPaneChanged', '@1', '%3');
	tmux.emit('windowPaneChanged', '@1', '%4');

	// Wait for debounces + all async work to settle
	await new Promise((r) => setTimeout(r, 300));

	// The final state: subscribedPaneId must be the LAST pane that was switched to
	assert.equal(sub.subscribedPaneId, '%4', 'subscribedPaneId is the last rapid-switch target');

	// paneSwitch events: the hub debounce coalesces the two events into one
	// activePaneListener call with '%4', so exactly one paneSwitch:%4 fires
	const paneSwitchEvents = cb.events.filter((e) => e.startsWith('paneSwitch:'));
	assert.ok(paneSwitchEvents.length >= 1, 'at least one paneSwitch fired');
	assert.equal(
		paneSwitchEvents[paneSwitchEvents.length - 1],
		'paneSwitch:%4',
		'last paneSwitch is for the final pane'
	);

	sub.close();
});

// ---------------------------------------------------------------------------
// Task 4: resolveOrdinal pure helper
// ---------------------------------------------------------------------------

test('resolveOrdinal: valid ordinal → paneId', () => {
	assert.equal(resolveOrdinal(['%1', '%2', '%3'], 1), '%1');
	assert.equal(resolveOrdinal(['%1', '%2', '%3'], 2), '%2');
	assert.equal(resolveOrdinal(['%1', '%2', '%3'], 3), '%3');
});

test('resolveOrdinal: out-of-range (<1, >length, 0) → null', () => {
	assert.equal(resolveOrdinal(['%1', '%2'], 0), null);
	assert.equal(resolveOrdinal(['%1', '%2'], 3), null);
	assert.equal(resolveOrdinal(['%1', '%2'], -1), null);
});

test('resolveOrdinal: empty array → null', () => {
	assert.equal(resolveOrdinal([], 1), null);
	assert.equal(resolveOrdinal([], 0), null);
});

test('resolveOrdinal: non-integer ordinal → null', () => {
	assert.equal(resolveOrdinal(['%1', '%2'], 1.5), null);
	assert.equal(resolveOrdinal(['%1', '%2'], NaN), null);
});

// ---------------------------------------------------------------------------
// Task 4: SpectatorSubscription.pinOrdinal / unpin
// ---------------------------------------------------------------------------

test('SpectatorSubscription.pinOrdinal: valid → subscribedPaneId updated + paneSwitch + seed', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	cb.events.length = 0;

	await sub.pinOrdinal(2); // ordinal 2 → %3

	assert.equal(sub.subscribedPaneId, '%3', 'subscribedPaneId = %3');
	assert.ok(cb.events.includes('paneSwitch:%3'), `expected paneSwitch:%3 in: ${cb.events.join(', ')}`);
	assert.equal(sub.mode.kind, 'pinned');
	assert.equal((sub.mode as any).ordinal, 2);
	sub.close();
});

test('SpectatorSubscription.pinOrdinal: invalid ordinal → paneUnavailable callback + subscribedPaneId = null', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	cb.events.length = 0;

	await sub.pinOrdinal(5); // only 1 pane, ordinal 5 invalid

	assert.ok(cb.events.includes('unavail:5/1'), `expected unavail:5/1 in: ${cb.events.join(', ')}`);
	assert.equal(sub.subscribedPaneId, null);
	sub.close();
});

test('pinned subscription ignores onHubActivePaneChanged', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %4')) return Promise.resolve(['80|24|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	await sub.pinOrdinal(2); // pin to %3
	cb.events.length = 0;

	// Desktop switches active pane — pinned should ignore
	tmux.emit('windowPaneChanged', '@1', '%4');
	await new Promise((r) => setTimeout(r, 150)); // wait for debounce

	assert.equal(sub.subscribedPaneId, '%3', 'still pinned to %3');
	assert.equal(cb.events.filter((e) => e.startsWith('paneSwitch:')).length, 0,
		`no paneSwitch should have fired; events: ${cb.events.join(', ')}`);
	sub.close();
});

test('pinned subscription: window switch re-resolves ordinal in new window', async () => {
	const { hub, tmux } = makeHub();
	let listPanesCallCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %8')) return Promise.resolve(['80|24|0|0|0|0|other']);
		if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%7']);
		if (cmd.startsWith('list-panes')) {
			listPanesCallCount++;
			if (listPanesCallCount === 1) return Promise.resolve(['%2', '%3', '%4']);
			return Promise.resolve(['%7', '%8']); // new window
		}
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	await sub.pinOrdinal(2); // pin to ordinal 2 (= %3 in original window)
	cb.events.length = 0;

	// Switch to a new window where panes are ['%7', '%8']
	tmux.emit('sessionWindowChanged', '$1', '@2');
	await new Promise((r) => setTimeout(r, 200)); // wait for debounce + async

	// ordinal 2 in new window = %8
	assert.equal(sub.subscribedPaneId, '%8', `expected %8, got: ${sub.subscribedPaneId}`);
	assert.ok(cb.events.includes('paneSwitch:%8'), `expected paneSwitch:%8 in: ${cb.events.join(', ')}`);
	sub.close();
});

test('pinned subscription: window switch with insufficient panes → paneUnavailable + subscribedPaneId = null', async () => {
	const { hub, tmux } = makeHub();
	let listPanesCallCount = 0;
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%7']);
		if (cmd.startsWith('list-panes')) {
			listPanesCallCount++;
			if (listPanesCallCount === 1) return Promise.resolve(['%2', '%3', '%4']);
			return Promise.resolve(['%7']); // new window has only 1 pane
		}
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');
	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	await sub.pinOrdinal(2); // pin to ordinal 2 (= %3 in original window)
	cb.events.length = 0;

	// Switch to new window with only 1 pane — ordinal 2 invalid
	tmux.emit('sessionWindowChanged', '$1', '@2');
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(cb.events.includes('unavail:2/1'), `expected unavail:2/1 in: ${cb.events.join(', ')}`);
	assert.equal(sub.subscribedPaneId, null);
	sub.close();
});

// ---------------------------------------------------------------------------
// Fix: pinOrdinal / unpin closed guard
// ---------------------------------------------------------------------------

test('SpectatorSubscription.pinOrdinal after close → no-op (no paneSwitch, no paneUnavailable)', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// keepAlive prevents hub destruction when sub closes
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	sub.close(); // subscription is now closed
	cb.events.length = 0;

	// pinOrdinal after close must be a no-op
	await sub.pinOrdinal(2);

	assert.equal(cb.events.filter((e) => e.startsWith('paneSwitch:')).length, 0,
		`no paneSwitch after close; events: ${cb.events.join(', ')}`);
	assert.equal(cb.events.filter((e) => e.startsWith('unavail:')).length, 0,
		`no paneUnavailable after close; events: ${cb.events.join(', ')}`);

	keepAlive.close();
});

test('SpectatorSubscription.unpin after close → no-op (no callbacks)', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	// keepAlive prevents hub destruction when sub closes
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();
	await sub.pinOrdinal(2); // pin to %3
	sub.close(); // subscription is now closed
	cb.events.length = 0;

	// unpin after close must be a no-op
	await sub.unpin();

	assert.equal(cb.events.length, 0, `no callbacks after close; events: ${cb.events.join(', ')}`);

	keepAlive.close();
});

// ---------------------------------------------------------------------------
// Fix: unpin when hub.activePaneId is null → mode=follow-active, subscribedPaneId=null
// ---------------------------------------------------------------------------

test('SpectatorSubscription.unpin when hub has no activePaneId → mode=follow-active, subscribedPaneId=null, no callbacks', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
		if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
		if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
		if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
		return Promise.resolve([]);
	};
	await hub.bootstrap('work');

	const cb = makeCallbacks();
	const sub = new SpectatorSubscription(hub, cb);
	await sub.attach();

	// Pin sub to ordinal 2 (%3) by setting state directly (bypass attach flow)
	// so subscribedPaneId is set to a known value
	hub.paneStates.set('%3', { cols: 100, rows: 30, altScreen: false, cursorX: 0, cursorY: 0, windowIndex: '0', windowName: 'main' });
	hub.currentWindowPaneOrder = ['%2', '%3'];
	await sub.pinOrdinal(2); // pins to %3
	assert.equal(sub.subscribedPaneId, '%3', 'pre-condition: pinned to %3');

	// Now null out hub.activePaneId to simulate "no active pane"
	hub.activePaneId = null;
	cb.events.length = 0;

	// unpin — hub.activePaneId is null, so subscribedPaneId should be cleared
	await sub.unpin();

	assert.equal(sub.mode.kind, 'follow-active', 'mode is follow-active after unpin');
	assert.equal(sub.subscribedPaneId, null, 'subscribedPaneId cleared to null when activePaneId is null');
	assert.equal(cb.events.length, 0, `no callbacks should fire; events: ${cb.events.join(', ')}`);

	sub.close();
});

// ---------------------------------------------------------------------------
// Task 5: SpectatorHub desktop-mutating methods
// ---------------------------------------------------------------------------

test('hub.selectPane: list-panes → select-pane for the correct ordinal', async () => {
	const { hub, tmux } = makeHub();
	const issued: string[] = [];
	tmux.command = async (cmd: string) => {
		issued.push(cmd);
		if (cmd.startsWith('list-panes')) return ['%5', '%6', '%7'];
		return [];
	};
	await hub.selectPane(2);
	assert.ok(issued.some((c) => c === 'select-pane -t %6'),
		`expected select-pane -t %6 in: ${issued.join(', ')}`);
});

test('hub.selectPane: ordinal exceeds list → no select-pane issued', async () => {
	const { hub, tmux } = makeHub();
	const issued: string[] = [];
	tmux.command = async (cmd: string) => {
		issued.push(cmd);
		if (cmd.startsWith('list-panes')) return ['%5', '%6'];
		return [];
	};
	await hub.selectPane(5);
	assert.ok(!issued.some((c) => c.startsWith('select-pane')),
		`no select-pane expected when ordinal out of range; commands: ${issued.join(', ')}`);
});

test('hub.selectPane: ordinal < 1 → no commands issued', async () => {
	const { hub, tmux } = makeHub();
	const cmdsBefore = tmux.commands.length;
	await hub.selectPane(0);
	assert.equal(tmux.commands.length, cmdsBefore, 'no commands for ordinal=0');
});

test('hub.selectPane: non-integer ordinal → no commands issued', async () => {
	const { hub, tmux } = makeHub();
	const cmdsBefore = tmux.commands.length;
	await hub.selectPane(1.5);
	assert.equal(tmux.commands.length, cmdsBefore, 'no commands for non-integer ordinal');
});

test('hub.selectPane: destroyed hub → no commands issued', async () => {
	const { hub, tmux } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close(); // triggers destroy (last sub)
	const cmdsBefore = tmux.commands.length;
	await hub.selectPane(1);
	assert.equal(tmux.commands.length, cmdsBefore, 'destroyed hub issues no commands');
});

test('hub.tmuxNav: next-pane emits correct select-pane command', async () => {
	const { hub, tmux } = makeHub();
	await hub.tmuxNav('next-pane');
	assert.ok(tmux.commands.some((c) => c === 'select-pane -t s:.+'),
		`expected select-pane -t s:.+ in: ${tmux.commands.join(', ')}`);
});

test('hub.tmuxNav: prev-pane emits correct select-pane command', async () => {
	const { hub, tmux } = makeHub();
	await hub.tmuxNav('prev-pane');
	assert.ok(tmux.commands.some((c) => c === 'select-pane -t s:.-'),
		`expected select-pane -t s:.- in: ${tmux.commands.join(', ')}`);
});

test('hub.tmuxNav: next-window emits correct select-window command', async () => {
	const { hub, tmux } = makeHub();
	await hub.tmuxNav('next-window');
	assert.ok(tmux.commands.some((c) => c === 'select-window -t s:+'),
		`expected select-window -t s:+ in: ${tmux.commands.join(', ')}`);
});

test('hub.tmuxNav: prev-window emits correct select-window command', async () => {
	const { hub, tmux } = makeHub();
	await hub.tmuxNav('prev-window');
	assert.ok(tmux.commands.some((c) => c === 'select-window -t s:-'),
		`expected select-window -t s:- in: ${tmux.commands.join(', ')}`);
});

test('hub.tmuxNav: destroyed hub → no commands issued', async () => {
	const { hub, tmux } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close();
	const cmdsBefore = tmux.commands.length;
	await hub.tmuxNav('next-pane');
	assert.equal(tmux.commands.length, cmdsBefore, 'destroyed hub issues no commands');
});

test('hub.sendInput: hex-encodes UTF-8 bytes and issues send-keys to activePaneId', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%3';
	await hub.sendInput('y');
	// 'y' = 0x79
	assert.ok(tmux.commands.some((c) => c === 'send-keys -t %3 -H 79'),
		`expected send-keys -t %3 -H 79 in: ${tmux.commands.join(', ')}`);
});

test('hub.sendInput: multi-byte UTF-8 → space-separated hex tokens', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%3';
	// 'ab' → 61 62
	await hub.sendInput('ab');
	assert.ok(tmux.commands.some((c) => c === 'send-keys -t %3 -H 61 62'),
		`expected send-keys -t %3 -H 61 62 in: ${tmux.commands.join(', ')}`);
});

test('hub.sendInput: empty text → no command issued', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%3';
	const cmdsBefore = tmux.commands.length;
	await hub.sendInput('');
	assert.equal(tmux.commands.length, cmdsBefore, 'empty text → no send-keys');
});

test('hub.sendInput: no activePaneId → no command issued', async () => {
	const { hub, tmux } = makeHub();
	// activePaneId is null by default
	const cmdsBefore = tmux.commands.length;
	await hub.sendInput('hello');
	assert.equal(tmux.commands.length, cmdsBefore, 'null activePaneId → no send-keys');
});

test('hub.sendInput: destroyed hub → no command issued', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%3';
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close();
	const cmdsBefore = tmux.commands.length;
	await hub.sendInput('y');
	assert.equal(tmux.commands.length, cmdsBefore, 'destroyed hub → no send-keys');
});

// ---------------------------------------------------------------------------
// Task 5: SpectatorSubscription delegation
// ---------------------------------------------------------------------------

test('sub.selectPane delegates to hub.selectPane', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%2';
	const issued: string[] = [];
	tmux.command = async (cmd: string) => {
		issued.push(cmd);
		if (cmd.startsWith('list-panes')) return ['%2', '%3'];
		return [];
	};
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.selectPane(2);
	// Give the fire-and-forget a tick to settle
	await new Promise((r) => setImmediate(r));
	assert.ok(issued.some((c) => c === 'select-pane -t %3'),
		`expected select-pane -t %3; commands: ${issued.join(', ')}`);
	sub.close();
});

test('sub.tmuxNav delegates to hub.tmuxNav', async () => {
	const { hub, tmux } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.tmuxNav('prev-window');
	await new Promise((r) => setImmediate(r));
	assert.ok(tmux.commands.some((c) => c === 'select-window -t s:-'),
		`expected select-window -t s:-; commands: ${tmux.commands.join(', ')}`);
	sub.close();
});

test('sub.sendInput delegates to hub.sendInput', async () => {
	const { hub, tmux } = makeHub();
	hub.activePaneId = '%5';
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.sendInput('n');
	// 'n' = 0x6e
	await new Promise((r) => setImmediate(r));
	assert.ok(tmux.commands.some((c) => c === 'send-keys -t %5 -H 6e'),
		`expected send-keys -t %5 -H 6e; commands: ${tmux.commands.join(', ')}`);
	sub.close();
});

test('sub.hasActivePane: true when hub.activePaneId set and sub is open', () => {
	const { hub } = makeHub();
	hub.activePaneId = '%2';
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	assert.equal(sub.hasActivePane(), true);
	sub.close();
});

test('sub.hasActivePane: false when hub.activePaneId is null', () => {
	const { hub } = makeHub();
	// activePaneId default null
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	assert.equal(sub.hasActivePane(), false);
	sub.close();
});

test('sub.hasActivePane: false after sub.close()', () => {
	const { hub } = makeHub();
	hub.activePaneId = '%2';
	// keepAlive prevents hub auto-destroy
	const keepAlive = new SpectatorSubscription(hub, makeCallbacks());
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	sub.close();
	assert.equal(sub.hasActivePane(), false, 'false after close');
	keepAlive.close();
});

test('sub.controlPath: returns hub.controlPath', () => {
	const ssh = new MockSsh();
	const tmux = new MockTmux();
	const hub = new SpectatorHub({
		ssh: ssh as any,
		tmux: tmux as any,
		hubKey: 'u@h:22|s',
		sessionName: 's',
		controlPath: '/tmp/test.sock',
		onDestroy: () => {}
	});
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	assert.equal(sub.controlPath, '/tmp/test.sock');
	sub.close();
});

test('sub.controlPath: returns undefined when hub has no controlPath', () => {
	const { hub } = makeHub();
	const sub = new SpectatorSubscription(hub, makeCallbacks());
	assert.equal(sub.controlPath, undefined);
	sub.close();
});

// ---------------------------------------------------------------------------
// Spec compliance fix: %layout-change invalidates paneStates cache
// ---------------------------------------------------------------------------

test('SpectatorHub: %layout-change invalidates paneStates cache', async () => {
	const { hub, tmux } = makeHub();
	tmux.command = async (cmd: string) => {
		if (cmd.startsWith('refresh-client')) return [];
		if (cmd.startsWith('display-message') && cmd.includes('-t work')) return ['$1|@1|%2|80|24|0|0|0|0|main'];
		if (cmd.startsWith('list-panes')) return ['%2'];
		return [];
	};
	await hub.bootstrap('work');
	assert.equal(hub.paneStates.size, 1, 'paneStates populated after bootstrap');
	tmux.emit('layoutChange', '@1');
	assert.equal(hub.paneStates.size, 0, 'paneStates cleared on layoutChange');
});
