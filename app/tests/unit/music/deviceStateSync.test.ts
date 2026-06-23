import { describe, it, expect, beforeEach } from 'vitest';
import { createDeviceStateSync, type DeviceStateAdapter } from '$lib/music/deviceStateSync.js';

/** Drain all pending microtasks so async `doWrite` calls complete. */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function fakeAdapter() {
	const writes: { deviceId: string; position: number; trackUrl: string }[] = [];
	let readReturn: { position: number; trackUrl: string } | null = null;
	const adapter: DeviceStateAdapter = {
		async write(_uid, deviceId, doc) {
			writes.push({ deviceId, ...doc });
		},
		async read() {
			return readReturn;
		}
	};
	return { adapter, writes, setRead: (r: typeof readReturn) => (readReturn = r) };
}

function make(overrides: Partial<Parameters<typeof createDeviceStateSync>[0]> = {}) {
	const f = fakeAdapter();
	let nowMs = 0;
	// Wrap getUid with a call counter so tests can assert the gate short-circuits
	// BEFORE getUid() (which is ensureSignedIn() — a network sign-in) when disabled.
	const baseGetUid = overrides.getUid ?? (async () => 'uid1');
	let getUidCalls = 0;
	const getUid = async () => {
		getUidCalls++;
		return baseGetUid();
	};
	const sync = createDeviceStateSync({
		adapter: f.adapter,
		isEnabled: async () => true,
		getDeviceId: async () => 'dev1',
		now: () => nowMs,
		minIntervalMs: 10_000,
		...overrides,
		getUid
	});
	return {
		sync,
		...f,
		advance: (ms: number) => (nowMs += ms),
		setNow: (v: number) => (nowMs = v),
		getUidCalls: () => getUidCalls
	};
}

describe('deviceStateSync throttle + gate', () => {
	it('throttles writePosition to once per interval for the same track', async () => {
		const t = make();
		t.sync.writePosition(1, 'u');
		t.sync.writePosition(2, 'u'); // same instant — throttled
		await flushMicrotasks();
		expect(t.writes).toHaveLength(1);
		t.advance(10_000);
		t.sync.writePosition(3, 'u');
		await flushMicrotasks();
		expect(t.writes).toHaveLength(2);
		expect(t.writes[1].position).toBe(3);
	});

	it('writes immediately when the track changes', async () => {
		const t = make();
		t.sync.writePosition(1, 'a');
		t.sync.writePosition(0, 'b'); // different url — not throttled
		await flushMicrotasks();
		expect(t.writes.map((w) => w.trackUrl)).toEqual(['a', 'b']);
	});

	it('flushPosition bypasses the throttle', async () => {
		const t = make();
		t.sync.writePosition(1, 'u');
		t.sync.flushPosition(2, 'u');
		await flushMicrotasks();
		expect(t.writes).toHaveLength(2);
	});

	it('no-ops when disabled — and never calls getUid (no sign-in side-effect)', async () => {
		const t = make({ isEnabled: async () => false });
		t.sync.flushPosition(5, 'u');
		expect(await t.sync.readDeviceState('x')).toBeNull();
		await flushMicrotasks();
		expect(t.writes).toHaveLength(0);
		// getUid = ensureSignedIn (a Cloud Function sign-in); the disabled gate MUST
		// short-circuit before it, or a disabled device signs in every ~10s while playing.
		expect(t.getUidCalls()).toBe(0);
	});

	it('no-ops when signed out (uid null)', async () => {
		const t = make({ getUid: async () => null });
		t.sync.flushPosition(5, 'u');
		await flushMicrotasks();
		expect(t.writes).toHaveLength(0);
	});

	it('readDeviceState returns the adapter doc', async () => {
		const t = make();
		t.setRead({ position: 77, trackUrl: 'u' });
		expect(await t.sync.readDeviceState('dev2')).toEqual({ position: 77, trackUrl: 'u' });
	});
});
