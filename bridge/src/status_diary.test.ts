import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	gatherDiaryInbox,
	gatherDiaryOcr,
	buildDiaryStatus,
	type DiaryStatusConfig
} from './status_diary.js';

function makeInbox(pages: Array<{ uuid: string; folder: string; ageSec: number }>): string {
	const dir = mkdtempSync(join(tmpdir(), 'diary-inbox-'));
	const nowSec = 1_700_000_000;
	for (const p of pages) {
		const rm = join(dir, `${p.uuid}.rm`);
		writeFileSync(rm, 'x');
		writeFileSync(
			join(dir, `${p.uuid}.metadata`),
			JSON.stringify({ lastModified: '1', sourceFolder: p.folder, type: 'PageType' })
		);
		const t = nowSec - p.ageSec;
		utimesSync(rm, t, t);
	}
	return dir;
}

test('gatherDiaryInbox: counts, buckets by sourceFolder, computes stale', () => {
	const now = 1_700_000_000 * 1000;
	const dir = makeInbox([
		{ uuid: 'a1', folder: 'Diary', ageSec: 120 },
		{ uuid: 'b2', folder: 'Diary', ageSec: 600 },
		{ uuid: 'c3', folder: 'Slip-Notes', ageSec: 300 }
	]);
	const r = gatherDiaryInbox(dir, now);
	assert.equal(r.count, 3);
	assert.equal(r.error, undefined);
	assert.equal(r.stale_minutes, 2); // newest = 120s ago
	const diary = r.per_folder.find((f) => f.folder === 'Diary');
	assert.equal(diary?.count, 2);
	assert.equal(r.per_folder.find((f) => f.folder === 'Slip-Notes')?.count, 1);
});

test('gatherDiaryInbox: missing dir → error + zeros, no throw', () => {
	const r = gatherDiaryInbox('/no/such/dir/xyz', Date.now());
	assert.equal(r.count, 0);
	assert.ok(r.error);
	assert.equal(r.stale_minutes, null);
});

test('gatherDiaryOcr: unconfigured when no triggerUrl', async () => {
	const cfg: DiaryStatusConfig = { secret: 's', inboxDir: '/x', triggerUrl: '', triggerToken: '' };
	const r = await gatherDiaryOcr(cfg, {});
	assert.equal(r.status, 'unconfigured');
});

test('gatherDiaryOcr: parses trigger /status (success)', async () => {
	const cfg: DiaryStatusConfig = { secret: 's', inboxDir: '/x', triggerUrl: 'http://t', triggerToken: 'k' };
	const r = await gatherDiaryOcr(cfg, {
		fetchTrigger: async () => ({
			running: false,
			finishedAt: '2026-06-21T04:45:00Z',
			exitCode: 0,
			stdoutTail: 'Staged 2 page(s)\nPush complete: 2 page(s) sent',
			stderrTail: ''
		})
	});
	assert.equal(r.status, 'ok');
	assert.equal(r.result, 'success');
	assert.equal(r.last_run_at, '2026-06-21T04:45:00Z');
	assert.match(r.summary ?? '', /Push complete: 2/);
});

test('gatherDiaryOcr: fetch throw → unreachable', async () => {
	const cfg: DiaryStatusConfig = { secret: 's', inboxDir: '/x', triggerUrl: 'http://t', triggerToken: 'k' };
	const r = await gatherDiaryOcr(cfg, {
		fetchTrigger: async () => {
			throw new Error('econnrefused');
		}
	});
	assert.equal(r.status, 'unreachable');
});

test('buildDiaryStatus: combines inbox + ocr', async () => {
	const dir = makeInbox([{ uuid: 'a1', folder: 'Notes', ageSec: 60 }]);
	const cfg: DiaryStatusConfig = { secret: 's', inboxDir: dir, triggerUrl: '', triggerToken: '' };
	const r = await buildDiaryStatus(cfg, { now: 1_700_000_000 * 1000 });
	assert.equal(r.inbox.count, 1);
	assert.equal(r.ocr.status, 'unconfigured');
	assert.ok(r.fetched_at);
});
