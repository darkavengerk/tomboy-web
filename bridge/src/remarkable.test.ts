import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken } from './auth.js';
import {
	RM_SLOT_FILES,
	applyWallpapers,
	processWallpaperRequest,
	type WallpaperDeps,
	type RemarkableHost
} from './remarkable.js';

const SECRET = 'unit-test-secret';
const HOST: RemarkableHost = { host: '10.0.0.42', user: 'root' };

function makeFake(over: Partial<WallpaperDeps> = {}) {
	const calls = { pushed: [] as string[], restarts: 0 };
	const deps: WallpaperDeps = {
		hostsConfigured: () => true,
		resolveHost: () => HOST,
		fetchImage: async () => Buffer.from('rawbytes'),
		convertImage: async () => Buffer.from('PNGDATA'),
		pushFile: async (_h, file) => {
			calls.pushed.push(file);
		},
		restartXochitl: async () => {
			calls.restarts++;
		},
		...over
	};
	return { deps, calls };
}

test('RM_SLOT_FILES covers exactly the 5 known slot ids', () => {
	assert.deepEqual(
		Object.keys(RM_SLOT_FILES).sort(),
		['batteryempty', 'poweroff', 'rebooting', 'starting', 'suspended']
	);
	assert.equal(RM_SLOT_FILES.suspended.restart, true);
	assert.equal(RM_SLOT_FILES.starting.restart, false);
	// 파일명은 슬롯 id 와 일치해야 한다 — 복붙 실수 방어.
	for (const [id, def] of Object.entries(RM_SLOT_FILES)) {
		assert.equal(def.file, `${id}.png`);
	}
});

test('applyWallpapers: unknown host → 400', async () => {
	const { deps } = makeFake({ resolveHost: () => null });
	const out = await applyWallpapers(deps, 'nope', [{ slot: 'starting', imageUrl: 'https://x/i.png' }]);
	assert.equal(out.status, 400);
	assert.equal(out.body.error, 'unknown_host');
});

test('applyWallpapers: all slots ok', async () => {
	const { deps, calls } = makeFake();
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'starting', imageUrl: 'https://x/boot.png' },
		{ slot: 'poweroff', imageUrl: 'https://x/off.png' }
	]);
	assert.equal(out.status, 200);
	assert.deepEqual(out.body.results, [
		{ slot: 'starting', status: 'ok' },
		{ slot: 'poweroff', status: 'ok' }
	]);
	assert.deepEqual(calls.pushed, ['starting.png', 'poweroff.png']);
	assert.equal(calls.restarts, 0);
});

test('applyWallpapers: restart fires once when a restart slot succeeds', async () => {
	const { deps, calls } = makeFake();
	await applyWallpapers(deps, 'rm2', [
		{ slot: 'suspended', imageUrl: 'https://x/s.png' },
		{ slot: 'starting', imageUrl: 'https://x/b.png' }
	]);
	assert.equal(calls.restarts, 1);
});

test('applyWallpapers: restart does NOT fire when the restart slot fails', async () => {
	const { deps, calls } = makeFake({
		fetchImage: async () => {
			throw new Error('network');
		}
	});
	await applyWallpapers(deps, 'rm2', [{ slot: 'suspended', imageUrl: 'https://x/s.png' }]);
	assert.equal(calls.restarts, 0);
	assert.equal(calls.pushed.length, 0);
});

test('applyWallpapers: a fetch failure isolates to its slot', async () => {
	const { deps } = makeFake({
		fetchImage: async (url) => {
			if (url.includes('bad')) throw new Error('fetch 404');
			return Buffer.from('ok');
		}
	});
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'starting', imageUrl: 'https://x/bad.png' },
		{ slot: 'poweroff', imageUrl: 'https://x/good.png' }
	]);
	assert.equal(out.body.results![0].status, 'error');
	assert.match(out.body.results![0].message!, /fetch 404/);
	assert.equal(out.body.results![1].status, 'ok');
});

test('applyWallpapers: unknown slot id → slot error', async () => {
	const { deps } = makeFake();
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'bogus', imageUrl: 'https://x/i.png' }
	]);
	assert.equal(out.body.results![0].status, 'error');
	assert.equal(out.body.results![0].message, 'unknown_slot');
});

test('processWallpaperRequest: bad token → 401', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: 'garbage',
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 401);
});

test('processWallpaperRequest: hosts not configured → 503', async () => {
	const { deps } = makeFake({ hostsConfigured: () => false });
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 503);
});

test('processWallpaperRequest: bad body → 400', async () => {
	const { deps } = makeFake();
	for (const body of [{}, { host: 'rm2' }, { host: 'rm2', screens: [] }]) {
		const out = await processWallpaperRequest({ token: mintToken(SECRET), secret: SECRET, body, deps });
		assert.equal(out.status, 400);
	}
});

test('processWallpaperRequest: happy path → 200 results', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 200);
	assert.deepEqual(out.body.results, [{ slot: 'starting', status: 'ok' }]);
});

test('processWallpaperRequest: rejects non-http imageUrl → 400', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'file:///etc/passwd' }] },
		deps
	});
	assert.equal(out.status, 400);
});
