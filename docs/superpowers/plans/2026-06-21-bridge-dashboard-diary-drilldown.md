# 브릿지 대시보드 일기 드릴다운 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `브릿지::` 대시보드에서 `📓 일기` 버튼을 눌러 일기 파이프라인의 최근 처리(push 신선도·폴더별 backlog·마지막 OCR 실행/로그 꼬리)를 읽기전용 오버레이로 본다.

**Architecture:** 브릿지 허브(A안) — 앱은 브릿지 `GET /status/diary` 하고만 통신, 브릿지가 마운트된 inbox를 직접 glob(push/backlog) + desktop `trigger_server /status` 를 프록시(OCR). 앱은 렌더러 레지스트리 + 온디맨드 마운트 오버레이로 표시. 이 골격에 후속 서비스는 렌더러+브릿지 분기만 추가.

**Tech Stack:** Node(브릿지, `node --test`+tsx), SvelteKit + Svelte 5 runes, vitest + @testing-library/svelte, ProseMirror 위젯 데코.

설계 스펙: `docs/superpowers/specs/2026-06-21-bridge-dashboard-service-drilldown-design.md`

---

### Task 1: 브릿지 `GET /status/diary` 엔드포인트

**Goal:** inbox glob 집계 + OCR trigger 프록시로 `DiaryDetail` 을 반환하는 인증된 엔드포인트.

**Files:**
- Create: `bridge/src/status_diary.ts`
- Create: `bridge/src/status_diary.test.ts`
- Modify: `bridge/src/server.ts` (env 상수 추가 ~line 65, 라우트 등록 ~line 227)

**Acceptance Criteria:**
- [ ] `gatherDiaryInbox(dir, now)` 가 `.rm` 개수·최신 mtime·`sourceFolder` 별 버킷·`stale_minutes` 를 반환, 디렉터리 부재 시 `error` 채우고 0 폴백(throw 안 함).
- [ ] `gatherDiaryOcr` 가 `triggerUrl` 비면 `unconfigured`, fetch throw 시 `unreachable`, 성공 시 exitCode→result + stdout 요약 + 로그 꼬리.
- [ ] `handleDiaryStatus` 가 Bearer 불일치 시 401, 일치 시 200 + `DiaryDetail` JSON.
- [ ] `GET /status/diary` 라우트가 server.ts 에 등록됨.

**Verify:** `cd bridge && npm test` → status_diary 테스트 통과(기존 테스트 무영향).

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/status_diary.test.ts`

```ts
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `Cannot find module './status_diary.js'`

- [ ] **Step 3: 구현** — `bridge/src/status_diary.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBearer, verifyToken } from './auth.js';

/**
 * GET /status/diary — 일기 파이프라인 상세(브릿지 대시보드 드릴다운).
 *
 *  - inbox: 마운트된 diary inbox 를 직접 glob → push 신선도 + 폴더별 backlog.
 *           (index.json 은 0600 diary-sync 라 못 읽으므로 glob 으로 동일 정보 산출.)
 *  - ocr:   desktop trigger_server GET /status 를 프록시 → 마지막 OCR 실행/로그 꼬리.
 *
 * best-effort: 한쪽이 실패해도 200 + 부분 데이터. 인증 실패만 401.
 */

const PROBE_TIMEOUT_MS = 2500;
const LOG_TAIL_LINES = 12;

export interface DiaryStatusConfig {
	secret: string;
	inboxDir: string; // DIARY_INBOX_DIR (마운트 경로)
	triggerUrl: string; // DIARY_TRIGGER_URL ('' = unconfigured)
	triggerToken: string; // DIARY_TRIGGER_TOKEN
}

export interface DiaryFolderInfo {
	folder: string;
	count: number;
	newest_mtime: string | null;
}

export interface DiaryInbox {
	count: number;
	newest_mtime: string | null;
	stale_minutes: number | null;
	per_folder: DiaryFolderInfo[];
	error?: string;
}

export interface DiaryOcr {
	status: 'ok' | 'unconfigured' | 'unreachable';
	running?: boolean;
	last_run_at?: string | null;
	exit_code?: number | null;
	result?: 'success' | 'failed' | 'running' | 'unknown';
	summary?: string | null;
	log_tail?: string;
}

export interface DiaryDetail {
	fetched_at: string;
	inbox: DiaryInbox;
	ocr: DiaryOcr;
}

export interface DiaryStatusDeps {
	fetchTrigger?: (url: string, token: string) => Promise<unknown>;
	now?: number;
}

export function gatherDiaryInbox(inboxDir: string, now: number): DiaryInbox {
	let entries: string[];
	try {
		entries = readdirSync(inboxDir);
	} catch {
		return { count: 0, newest_mtime: null, stale_minutes: null, per_folder: [], error: 'inbox 미마운트/읽기 실패' };
	}
	const buckets = new Map<string, { count: number; newest: number }>();
	let count = 0;
	let newest = 0;
	for (const name of entries) {
		if (!name.endsWith('.rm')) continue;
		const uuid = name.slice(0, -3);
		let mtime = 0;
		try {
			mtime = statSync(join(inboxDir, name)).mtimeMs;
		} catch {
			continue;
		}
		count++;
		if (mtime > newest) newest = mtime;
		let folder = '기타';
		try {
			const meta = JSON.parse(readFileSync(join(inboxDir, `${uuid}.metadata`), 'utf8'));
			if (typeof meta.sourceFolder === 'string' && meta.sourceFolder) folder = meta.sourceFolder;
		} catch {
			/* sourceFolder 없으면 기타 */
		}
		const b = buckets.get(folder) ?? { count: 0, newest: 0 };
		b.count++;
		if (mtime > b.newest) b.newest = mtime;
		buckets.set(folder, b);
	}
	const per_folder: DiaryFolderInfo[] = [...buckets.entries()]
		.map(([folder, b]) => ({
			folder,
			count: b.count,
			newest_mtime: b.newest ? new Date(b.newest).toISOString() : null
		}))
		.sort((a, b) => b.count - a.count);
	return {
		count,
		newest_mtime: newest ? new Date(newest).toISOString() : null,
		stale_minutes: newest ? Math.round((now - newest) / 60000) : null,
		per_folder
	};
}

async function defaultFetchTrigger(url: string, token: string): Promise<unknown> {
	const res = await fetch(url.replace(/\/$/, '') + '/status', {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
	});
	return res.json();
}

function summarizeStdout(tail: string): string | null {
	const lines = tail
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const priority = /Push complete|page\(s\)|Wrote|OCR|Error|Traceback|skip/i;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (priority.test(lines[i])) return lines[i];
	}
	return lines.length ? lines[lines.length - 1] : null;
}

function tailLines(s: string, n: number): string {
	return s
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.slice(-n)
		.join('\n');
}

export async function gatherDiaryOcr(config: DiaryStatusConfig, deps: DiaryStatusDeps): Promise<DiaryOcr> {
	if (!config.triggerUrl) return { status: 'unconfigured' };
	const fetchTrigger = deps.fetchTrigger ?? defaultFetchTrigger;
	let raw: Record<string, unknown>;
	try {
		raw = (await fetchTrigger(config.triggerUrl, config.triggerToken)) as Record<string, unknown>;
	} catch {
		return { status: 'unreachable' };
	}
	if (!raw || typeof raw !== 'object') return { status: 'unreachable' };
	const running = !!raw.running;
	const stdout = typeof raw.stdoutTail === 'string' ? raw.stdoutTail : '';
	const stderr = typeof raw.stderrTail === 'string' ? raw.stderrTail : '';
	const exit = typeof raw.exitCode === 'number' ? raw.exitCode : null;
	let result: DiaryOcr['result'] = 'unknown';
	if (running) result = 'running';
	else if (exit === 0) result = 'success';
	else if (typeof exit === 'number') result = 'failed';
	const finishedAt = typeof raw.finishedAt === 'string' ? raw.finishedAt : null;
	const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
	return {
		status: 'ok',
		running,
		last_run_at: finishedAt ?? startedAt,
		exit_code: exit,
		result,
		summary: summarizeStdout(stdout),
		log_tail: tailLines([stdout, stderr].filter(Boolean).join('\n'), LOG_TAIL_LINES)
	};
}

export async function buildDiaryStatus(config: DiaryStatusConfig, deps: DiaryStatusDeps = {}): Promise<DiaryDetail> {
	const now = deps.now ?? Date.now();
	const [inbox, ocr] = await Promise.all([
		Promise.resolve(gatherDiaryInbox(config.inboxDir, now)),
		gatherDiaryOcr(config, deps)
	]);
	return { fetched_at: new Date(now).toISOString(), inbox, ocr };
}

export async function handleDiaryStatus(
	req: IncomingMessage,
	res: ServerResponse,
	config: DiaryStatusConfig,
	deps?: DiaryStatusDeps
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(config.secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	const detail = await buildDiaryStatus(config, deps);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(detail));
}
```

- [ ] **Step 4: server.ts 라우트 등록**

`bridge/src/server.ts` — 상단 import에 추가:
```ts
import { handleDiaryStatus } from './status_diary.js';
```
RAG_SEARCH_URL 정의(line ~66) 바로 아래에 env 상수 추가:
```ts
const DIARY_INBOX_DIR = process.env.DIARY_INBOX_DIR || '/var/lib/diary-inbox';
const DIARY_TRIGGER_URL = process.env.DIARY_TRIGGER_URL || '';
const DIARY_TRIGGER_TOKEN = process.env.DIARY_TRIGGER_TOKEN || '';
```
`/status` 라우트 블록(line ~227, `return;` 직후) 다음에 추가:
```ts
	if (url === '/status/diary' && req.method === 'GET') {
		await handleDiaryStatus(req, res, {
			secret: SECRET,
			inboxDir: DIARY_INBOX_DIR,
			triggerUrl: DIARY_TRIGGER_URL,
			triggerToken: DIARY_TRIGGER_TOKEN
		});
		return;
	}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS (status_diary 6 테스트 + 기존 전부)

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/status_diary.ts bridge/src/status_diary.test.ts bridge/src/server.ts
git commit -m "feat(bridge): GET /status/diary 일기 파이프라인 상세 엔드포인트"
```

---

### Task 2: 브릿지 배포 — inbox 마운트 + 일기 env

**Goal:** `term-bridge.container` 가 diary inbox 를 읽기전용 마운트하고 trigger env 를 받도록 한다(재배포 전제).

**Files:**
- Modify: `bridge/deploy/term-bridge.container`
- Modify: `bridge/README.md` (env 표에 3개 추가)

**Acceptance Criteria:**
- [ ] 컨테이너 유닛에 `Volume=/home/diary-sync/diary/inbox:/var/lib/diary-inbox:ro` (공유 디렉터리라 `z`/`Z` 리라벨 없음).
- [ ] `Environment=DIARY_INBOX_DIR=/var/lib/diary-inbox` + `DIARY_TRIGGER_URL` 주석 가이드. 토큰은 `term-bridge.env` 패턴 안내.
- [ ] README env 표에 `DIARY_INBOX_DIR` / `DIARY_TRIGGER_URL` / `DIARY_TRIGGER_TOKEN` 행 추가.

**Verify:** `grep -n 'diary-inbox\|DIARY_' bridge/deploy/term-bridge.container` → 마운트 + env 라인 출력. (실제 활성화는 Pi 재빌드+재배포 — 운영 단계, 코드 테스트 아님.)

**Steps:**

- [ ] **Step 1: 마운트 + env 추가** — `bridge/deploy/term-bridge.container`

기존 `Volume=...files...` + `Environment=BRIDGE_FILES_DIR=...` 블록(파일 내 line ~103-104) 다음에 추가:
```ini
# 일기 파이프라인 드릴다운(GET /status/diary)용 — diary-sync inbox 읽기전용.
# 공유 디렉터리이므로 z/Z 리라벨 금지(diary-sync 접근 보존). 호스트 유저가
# inbox 를 읽을 수 있어야 함(ACL traverse + inbox drwxr-xr-x — 2026-06-21 확인).
Volume=/home/diary-sync/diary/inbox:/var/lib/diary-inbox:ro
Environment=DIARY_INBOX_DIR=/var/lib/diary-inbox
# desktop trigger_server 도달 가능하면 OCR 섹션 활성(없으면 unconfigured 로 생략).
# Environment=DIARY_TRIGGER_URL=http://<desktop-host>:8765
# DIARY_TRIGGER_TOKEN 은 시크릿이므로 term-bridge.env 에 둔다.
```

- [ ] **Step 2: README env 표 갱신** — `bridge/README.md` env 표에 행 추가:
```markdown
| `DIARY_INBOX_DIR`      | `GET /status/diary` 가 glob 할 마운트된 diary inbox 경로. 기본 `/var/lib/diary-inbox`. |
| `DIARY_TRIGGER_URL`    | desktop `trigger_server` 베이스 URL. 비면 OCR 섹션은 `unconfigured`. |
| `DIARY_TRIGGER_TOKEN`  | trigger_server Bearer 토큰(`term-bridge.env`). |
```

- [ ] **Step 3: 확인 + 커밋**

Run: `grep -n 'diary-inbox\|DIARY_' bridge/deploy/term-bridge.container`
Expected: Volume + Environment 라인 출력
```bash
git add bridge/deploy/term-bridge.container bridge/README.md
git commit -m "deploy(bridge): diary inbox 읽기전용 마운트 + trigger env"
```

---

### Task 3: 앱 statusClient `fetchBridgeDetail` + `DiaryDetail`

**Goal:** 브릿지 `GET /status/diary` 를 받아오는 클라이언트 + 타입(브릿지 shape 미러).

**Files:**
- Modify: `app/src/lib/bridgeStatus/statusClient.ts`
- Create: `app/tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts`

**Acceptance Criteria:**
- [ ] `DiaryDetail`/`DiaryInbox`/`DiaryOcr`/`DiaryFolderInfo` 타입 export(브릿지 shape 일치).
- [ ] `fetchBridgeDetail('diary')` 가 `{base}/status/diary` 로 Bearer GET, 미설정/네트워크/4xx/5xx 를 `BridgeStatusError` 로 분류.

**Verify:** `cd app && npx vitest run tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'wss://bridge.test/ws'),
	getTerminalBridgeToken: vi.fn(async () => 'tok'),
	bridgeToHttpBase: (b: string) => b.replace(/^wss:/, 'https:').replace(/\/ws$/, '')
}));

import { fetchBridgeDetail, BridgeStatusError } from '$lib/bridgeStatus/statusClient.js';
import { getDefaultTerminalBridge } from '$lib/editor/terminal/bridgeSettings.js';

const sample = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: { count: 2, newest_mtime: '2026-06-21T04:44:00Z', stale_minutes: 1, per_folder: [] },
	ocr: { status: 'unconfigured' }
};

beforeEach(() => {
	vi.restoreAllMocks();
	(getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://bridge.test/ws');
});

describe('fetchBridgeDetail', () => {
	it('GETs /status/diary with Bearer and returns parsed detail', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const r = await fetchBridgeDetail('diary');
		expect(r.inbox.count).toBe(2);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://bridge.test/status/diary');
		expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
	});

	it('maps 401 → unauthorized', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
		await expect(fetchBridgeDetail('diary')).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('not_configured when bridge unset', async () => {
		(getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('');
		await expect(fetchBridgeDetail('diary')).rejects.toBeInstanceOf(BridgeStatusError);
	});

	it('network error when fetch throws', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
		await expect(fetchBridgeDetail('diary')).rejects.toMatchObject({ kind: 'network' });
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts`
Expected: FAIL — `fetchBridgeDetail is not exported`

- [ ] **Step 3: 구현** — `app/src/lib/bridgeStatus/statusClient.ts` 끝에 추가

```ts
export interface DiaryFolderInfo {
	folder: string;
	count: number;
	newest_mtime: string | null;
}

export interface DiaryInbox {
	count: number;
	newest_mtime: string | null;
	stale_minutes: number | null;
	per_folder: DiaryFolderInfo[];
	error?: string;
}

export interface DiaryOcr {
	status: 'ok' | 'unconfigured' | 'unreachable';
	running?: boolean;
	last_run_at?: string | null;
	exit_code?: number | null;
	result?: 'success' | 'failed' | 'running' | 'unknown';
	summary?: string | null;
	log_tail?: string;
}

export interface DiaryDetail {
	fetched_at: string;
	inbox: DiaryInbox;
	ocr: DiaryOcr;
}

/** GET /status/<key> — 서비스 상세. Phase 1 은 'diary' 만. */
export async function fetchBridgeDetail(
	key: 'diary',
	opts?: { signal?: AbortSignal }
): Promise<DiaryDetail> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new BridgeStatusError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/status/${key}`;

	let res: Response;
	try {
		res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: opts?.signal });
	} catch (err) {
		throw new BridgeStatusError('network', (err as Error).message);
	}
	if (!res.ok) {
		const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
		throw new BridgeStatusError(kind);
	}
	let data: unknown;
	try {
		data = await res.json();
	} catch (err) {
		throw new BridgeStatusError('upstream_error', (err as Error).message);
	}
	if (!data || typeof data !== 'object') throw new BridgeStatusError('upstream_error', 'bad_shape');
	return data as DiaryDetail;
}
```

- [ ] **Step 4: 테스트 통과 + 커밋**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts`
Expected: PASS
```bash
git add app/src/lib/bridgeStatus/statusClient.ts app/tests/unit/lib/bridgeStatus/fetchBridgeDetail.test.ts
git commit -m "feat(app): fetchBridgeDetail + DiaryDetail 타입"
```

---

### Task 4: 앱 `DiaryDetailView.svelte`

**Goal:** `DiaryDetail` 을 push 신선도 배지 + 폴더별 backlog 막대 + 마지막 OCR 표로 렌더(읽기전용).

**Files:**
- Create: `app/src/lib/bridgeStatus/detail/DiaryDetailView.svelte`
- Create: `app/tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts`

**Acceptance Criteria:**
- [ ] `stale_minutes` 임계로 배지 클래스(`ok`<30, `warn`<180, `crit`≥180; null→`idle`).
- [ ] `per_folder` 각 항목이 개수 비례 막대 폭 + 폴더명/개수 표시.
- [ ] OCR 섹션: `unconfigured`/`unreachable` 는 회색 안내, `ok` 는 결과/시각/요약 + 로그 꼬리 `<details>`.

**Verify:** `cd app && npx vitest run tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DiaryDetailView from '$lib/bridgeStatus/detail/DiaryDetailView.svelte';
import type { DiaryDetail } from '$lib/bridgeStatus/statusClient.js';

afterEach(() => cleanup());

const base: DiaryDetail = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: {
		count: 3,
		newest_mtime: '2026-06-21T04:44:00Z',
		stale_minutes: 5,
		per_folder: [
			{ folder: 'Diary', count: 2, newest_mtime: '2026-06-21T04:44:00Z' },
			{ folder: 'Slip-Notes', count: 1, newest_mtime: '2026-06-21T04:40:00Z' }
		]
	},
	ocr: { status: 'unconfigured' }
};

describe('DiaryDetailView', () => {
	it('renders folder backlog rows and counts', () => {
		const { getByText, container } = render(DiaryDetailView, { detail: base });
		expect(getByText('Diary')).toBeTruthy();
		expect(getByText('Slip-Notes')).toBeTruthy();
		expect(container.querySelectorAll('.folder-bar').length).toBe(2);
	});

	it('marks stale badge ok when fresh', () => {
		const { container } = render(DiaryDetailView, { detail: base });
		expect(container.querySelector('.stale-badge.ok')).toBeTruthy();
	});

	it('marks stale badge crit when very stale', () => {
		const d = { ...base, inbox: { ...base.inbox, stale_minutes: 300 } };
		const { container } = render(DiaryDetailView, { detail: d });
		expect(container.querySelector('.stale-badge.crit')).toBeTruthy();
	});

	it('shows ok OCR result with summary', () => {
		const d: DiaryDetail = {
			...base,
			ocr: {
				status: 'ok',
				result: 'success',
				last_run_at: '2026-06-21T04:45:00Z',
				exit_code: 0,
				summary: 'Push complete: 2 page(s) sent',
				log_tail: 'line1\nline2'
			}
		};
		const { getByText } = render(DiaryDetailView, { detail: d });
		expect(getByText(/Push complete: 2/)).toBeTruthy();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts`
Expected: FAIL — cannot resolve DiaryDetailView.svelte

- [ ] **Step 3: 구현** — `app/src/lib/bridgeStatus/detail/DiaryDetailView.svelte`

```svelte
<script lang="ts">
	import type { DiaryDetail } from '$lib/bridgeStatus/statusClient.js';

	let { detail }: { detail: DiaryDetail } = $props();

	const STALE_WARN = 30;
	const STALE_CRIT = 180;

	let staleClass = $derived.by(() => {
		const m = detail.inbox.stale_minutes;
		if (m == null) return 'idle';
		if (m >= STALE_CRIT) return 'crit';
		if (m >= STALE_WARN) return 'warn';
		return 'ok';
	});

	let maxFolder = $derived(Math.max(1, ...detail.inbox.per_folder.map((f) => f.count)));

	function fmtAgo(min: number | null): string {
		if (min == null) return '데이터 없음';
		if (min < 60) return `${min}분 전`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}시간 ${min % 60}분 전`;
		return `${Math.floor(h / 24)}일 전`;
	}
	function fmtDateTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return String(iso);
		const p = (n: number) => String(n).padStart(2, '0');
		return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	const RESULT_LABEL: Record<string, string> = {
		success: '✅ 성공',
		failed: '❌ 실패',
		running: '⏳ 실행 중',
		unknown: '· 알 수 없음'
	};
</script>

<div class="diary-detail">
	<section>
		<h3>📥 Push 신선도</h3>
		<div class="stale-badge {staleClass}">
			마지막 도착 {fmtAgo(detail.inbox.stale_minutes)}
			{#if staleClass === 'crit'}· ⚠ 정체 의심{/if}
			{#if staleClass === 'warn'}· 지연{/if}
		</div>
		<p class="sub">
			inbox {detail.inbox.count}개 · 최근 {fmtDateTime(detail.inbox.newest_mtime)}
		</p>
		{#if detail.inbox.error}<p class="muted">{detail.inbox.error}</p>{/if}
	</section>

	<section>
		<h3>🗂 폴더별 backlog</h3>
		{#if detail.inbox.per_folder.length === 0}
			<p class="muted">대기 페이지 없음</p>
		{:else}
			<ul class="bars">
				{#each detail.inbox.per_folder as f (f.folder)}
					<li>
						<span class="flabel">{f.folder}</span>
						<span class="track">
							<span class="folder-bar" style="width: {(f.count / maxFolder) * 100}%"></span>
						</span>
						<span class="fcount">{f.count}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h3>🧠 마지막 OCR 실행</h3>
		{#if detail.ocr.status === 'unconfigured'}
			<p class="muted">trigger 서버 미설정 — inbox 신선도만 표시됩니다.</p>
		{:else if detail.ocr.status === 'unreachable'}
			<p class="muted">trigger 서버에 연결할 수 없습니다.</p>
		{:else}
			<table class="ocr">
				<tbody>
					<tr><th>결과</th><td>{RESULT_LABEL[detail.ocr.result ?? 'unknown']}</td></tr>
					<tr><th>시각</th><td>{fmtDateTime(detail.ocr.last_run_at)}</td></tr>
					<tr><th>exit</th><td>{detail.ocr.exit_code ?? '—'}</td></tr>
					{#if detail.ocr.summary}<tr><th>요약</th><td>{detail.ocr.summary}</td></tr>{/if}
				</tbody>
			</table>
			{#if detail.ocr.log_tail}
				<details><summary>로그 꼬리</summary><pre>{detail.ocr.log_tail}</pre></details>
			{/if}
		{/if}
	</section>
</div>

<style>
	.diary-detail { display: flex; flex-direction: column; gap: 1.1rem; }
	section h3 { margin: 0 0 0.4rem; font-size: 0.95rem; }
	.stale-badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 0.5rem; font-weight: 600; }
	.stale-badge.ok { background: #1f7a3f22; color: #1f7a3f; }
	.stale-badge.warn { background: #b9770022; color: #b97700; }
	.stale-badge.crit { background: #b3261e22; color: #b3261e; }
	.stale-badge.idle { background: #8884; color: #666; }
	.sub { margin: 0.35rem 0 0; font-size: 0.85rem; color: #555; }
	.muted { color: #888; font-size: 0.85rem; }
	.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
	.bars li { display: grid; grid-template-columns: 5.5rem 1fr 2rem; align-items: center; gap: 0.5rem; }
	.flabel { font-size: 0.85rem; }
	.track { background: #8882; border-radius: 0.4rem; height: 0.9rem; overflow: hidden; }
	.folder-bar { display: block; height: 100%; background: #3b6cb7; border-radius: 0.4rem; min-width: 2px; }
	.fcount { text-align: right; font-variant-numeric: tabular-nums; }
	table.ocr { border-collapse: collapse; font-size: 0.85rem; }
	table.ocr th { text-align: left; color: #666; padding: 0.15rem 0.8rem 0.15rem 0; font-weight: 500; }
	details pre { background: #1112; padding: 0.5rem; border-radius: 0.4rem; overflow: auto; font-size: 0.78rem; max-height: 12rem; }
</style>
```

- [ ] **Step 4: 테스트 통과 + 커밋**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts`
Expected: PASS
```bash
git add app/src/lib/bridgeStatus/detail/DiaryDetailView.svelte app/tests/unit/lib/bridgeStatus/DiaryDetailView.test.ts
git commit -m "feat(app): DiaryDetailView 일기 상세 렌더(배지/막대/OCR표)"
```

---

### Task 5: 앱 오버레이 셸 + 레지스트리 + 온디맨드 마운트

**Goal:** 서비스키로 상세를 fetch 해 모달로 띄우는 읽기전용 오버레이 + 키→뷰 레지스트리 + body 마운트 헬퍼.

**Files:**
- Create: `app/src/lib/bridgeStatus/detail/registry.ts`
- Create: `app/src/lib/bridgeStatus/detail/BridgeDetailOverlay.svelte`
- Create: `app/src/lib/bridgeStatus/detail/openBridgeDetail.ts`
- Create: `app/tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts`

**Acceptance Criteria:**
- [ ] `DETAIL_REGISTRY.diary` = `{ title:'📓 일기 파이프라인', component: DiaryDetailView }`.
- [ ] 오버레이가 mount 시 `fetchBridgeDetail(key)` → 로딩→성공(레지스트리 컴포넌트 렌더)/에러(한국어) 전이.
- [ ] `--z-modal` + body 풀스크린 백드롭, 백드롭 클릭/Esc → `onclose`.
- [ ] `openBridgeDetail(key)` 가 body 에 1개만 마운트(중복 무시), 닫을 때 unmount + DOM 정리.

**Verify:** `cd app && npx vitest run tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/svelte';

vi.mock('$lib/bridgeStatus/statusClient.js', async (orig) => {
	const actual = (await orig()) as object;
	return { ...actual, fetchBridgeDetail: vi.fn() };
});

import BridgeDetailOverlay from '$lib/bridgeStatus/detail/BridgeDetailOverlay.svelte';
import { fetchBridgeDetail } from '$lib/bridgeStatus/statusClient.js';

afterEach(() => cleanup());

const sample = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: { count: 1, newest_mtime: '2026-06-21T04:44:00Z', stale_minutes: 1, per_folder: [{ folder: 'Diary', count: 1, newest_mtime: null }] },
	ocr: { status: 'unconfigured' }
};

describe('BridgeDetailOverlay', () => {
	it('fetches and renders the registered view; title shown', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockResolvedValue(sample);
		const { getByText } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose: () => {} });
		await waitFor(() => expect(getByText('📓 일기 파이프라인')).toBeTruthy());
		expect(getByText('Diary')).toBeTruthy();
	});

	it('shows korean error on failure', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error('x'), { kind: 'network' })
		);
		const { getByText } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose: () => {} });
		await waitFor(() => expect(getByText('브릿지에 연결할 수 없습니다')).toBeTruthy());
	});

	it('backdrop click calls onclose', async () => {
		(fetchBridgeDetail as ReturnType<typeof vi.fn>).mockResolvedValue(sample);
		const onclose = vi.fn();
		const { container } = render(BridgeDetailOverlay, { serviceKey: 'diary', onclose });
		const backdrop = container.querySelector('.bridge-detail-backdrop')!;
		await fireEvent.click(backdrop);
		expect(onclose).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts`
Expected: FAIL — cannot resolve overlay

- [ ] **Step 3: 레지스트리** — `app/src/lib/bridgeStatus/detail/registry.ts`

```ts
import type { Component } from 'svelte';
import DiaryDetailView from './DiaryDetailView.svelte';

export interface DetailEntry {
	title: string;
	// 각 뷰는 `detail` prop(서비스별 shape)을 받는다.
	component: Component<{ detail: any }>;
}

/** 서비스키 → 상세 뷰. 후속 서비스는 여기 엔트리만 추가. */
export const DETAIL_REGISTRY: Record<string, DetailEntry> = {
	diary: { title: '📓 일기 파이프라인', component: DiaryDetailView }
};

/** 플러그인 버튼용 경량 목록(Svelte 컴포넌트 import 없이 키/라벨만). */
export const DETAIL_BUTTONS: Array<{ key: string; label: string }> = [
	{ key: 'diary', label: '📓 일기' }
];
```

- [ ] **Step 4: 오버레이 셸** — `app/src/lib/bridgeStatus/detail/BridgeDetailOverlay.svelte`

```svelte
<script lang="ts">
	import { fetchBridgeDetail, BridgeStatusError, type StatusErrorKind } from '$lib/bridgeStatus/statusClient.js';
	import { DETAIL_REGISTRY } from './registry.js';

	let { serviceKey, onclose }: { serviceKey: string; onclose: () => void } = $props();

	const KIND_MESSAGES: Record<StatusErrorKind, string> = {
		not_configured: '브릿지 설정이 필요합니다',
		network: '브릿지에 연결할 수 없습니다',
		service_unavailable: '브릿지에 연결할 수 없습니다',
		unauthorized: '브릿지 인증이 필요합니다',
		bad_request: '잘못된 요청',
		upstream_error: '브릿지 상태 응답 오류'
	};

	const entry = $derived(DETAIL_REGISTRY[serviceKey]);

	let loading = $state(true);
	let errorMsg = $state<string | null>(null);
	let detail = $state<unknown>(null);

	$effect(() => {
		let alive = true;
		loading = true;
		errorMsg = null;
		fetchBridgeDetail(serviceKey as 'diary')
			.then((d) => {
				if (alive) detail = d;
			})
			.catch((err) => {
				if (!alive) return;
				const kind: StatusErrorKind = err instanceof BridgeStatusError ? err.kind : (err?.kind ?? 'network');
				errorMsg = KIND_MESSAGES[kind] ?? '브릿지 상세 조회 실패';
			})
			.finally(() => {
				if (alive) loading = false;
			});
		return () => {
			alive = false;
		};
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="bridge-detail-backdrop"
	role="button"
	tabindex="-1"
	onclick={onclose}
	onkeydown={(e) => { if (e.key === 'Enter') onclose(); }}
>
	<div class="bridge-detail-panel" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
		<header>
			<strong>{entry?.title ?? serviceKey}</strong>
			<button type="button" class="close" onclick={onclose} aria-label="닫기">✕</button>
		</header>
		<div class="body">
			{#if loading}
				<p class="muted">불러오는 중…</p>
			{:else if errorMsg}
				<p class="err">{errorMsg}</p>
			{:else if entry && detail}
				{@const Comp = entry.component}
				<Comp {detail} />
			{:else}
				<p class="muted">알 수 없는 서비스</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.bridge-detail-backdrop {
		position: fixed;
		inset: 0;
		background: #0007;
		z-index: var(--z-modal);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
	.bridge-detail-panel {
		background: var(--surface, #fff);
		color: inherit;
		border-radius: 0.8rem;
		max-width: 32rem;
		width: 100%;
		max-height: 85vh;
		overflow: auto;
		box-shadow: 0 10px 40px #0006;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid #8883;
		position: sticky;
		top: 0;
		background: inherit;
	}
	.close { border: none; background: none; font-size: 1rem; cursor: pointer; color: inherit; }
	.body { padding: 1rem; }
	.muted { color: #888; }
	.err { color: #b3261e; }
</style>
```

- [ ] **Step 5: 마운트 헬퍼** — `app/src/lib/bridgeStatus/detail/openBridgeDetail.ts`

```ts
import { mount, unmount } from 'svelte';
import BridgeDetailOverlay from './BridgeDetailOverlay.svelte';

let current: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

/** 서비스 상세 오버레이를 body 에 1개만 띄운다(읽기전용, 닫으면 정리). */
export function openBridgeDetail(serviceKey: string): void {
	if (current) return;
	host = document.createElement('div');
	document.body.appendChild(host);
	const close = () => {
		if (current) {
			unmount(current);
			current = null;
		}
		host?.remove();
		host = null;
	};
	current = mount(BridgeDetailOverlay, { target: host, props: { serviceKey, onclose: close } });
}
```

- [ ] **Step 6: 테스트 통과 + 커밋**

Run: `cd app && npx vitest run tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts`
Expected: PASS
```bash
git add app/src/lib/bridgeStatus/detail/
git add app/tests/unit/lib/bridgeStatus/BridgeDetailOverlay.test.ts
git commit -m "feat(app): 브릿지 상세 오버레이 + 레지스트리 + 온디맨드 마운트"
```

---

### Task 6: 대시보드 일기 버튼(클릭→오버레이)

**Goal:** `브릿지::` 노트 제목 아래 ⟳ 버튼 옆에 레지스트리 기반 상세 버튼(📓 일기)을 띄우고 클릭 시 오버레이를 연다.

**Files:**
- Modify: `app/src/lib/editor/bridgeNote/bridgeNotePlugin.ts`
- Create: `app/tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts`

**Acceptance Criteria:**
- [ ] 제목 뒤 위젯에 `DETAIL_BUTTONS` 각 항목당 `.tomboy-bridge-detail` 버튼(라벨 표시).
- [ ] 버튼 클릭 → `openBridgeDetail(key)` 호출.
- [ ] 비-브릿지 노트(제목 미일치)는 위젯 없음(기존 동작 유지).

**Verify:** `cd app && npx vitest run tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createBridgeNotePlugin } from '$lib/editor/bridgeNote/bridgeNotePlugin.js';

const openSpy = vi.fn();
vi.mock('$lib/bridgeStatus/detail/openBridgeDetail.js', () => ({
	openBridgeDetail: (k: string) => openSpy(k)
}));

function makeEditor(title: string): Editor {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({
		element: el,
		extensions: [
			StarterKit,
			{ name: 'bridgeNoteExt', addProseMirrorPlugins: () => [createBridgeNotePlugin()] } as any
		],
		content: `<p>${title}</p><p>body</p>`
	});
}

afterEach(() => {
	openSpy.mockReset();
	document.body.innerHTML = '';
});

describe('bridge detail buttons', () => {
	it('renders 일기 detail button on a 브릿지:: note and wires click', async () => {
		const ed = makeEditor('브릿지::라즈베리파이');
		const btn = ed.view.dom.querySelector('.tomboy-bridge-detail') as HTMLButtonElement;
		expect(btn).toBeTruthy();
		expect(btn.textContent).toContain('📓 일기');
		btn.click();
		expect(openSpy).toHaveBeenCalledWith('diary');
		ed.destroy();
	});

	it('no widget on a non-bridge note', () => {
		const ed = makeEditor('그냥 노트');
		expect(ed.view.dom.querySelector('.tomboy-bridge-detail')).toBeNull();
		ed.destroy();
	});
});
```

> 주의(테스트 격리): `new Editor(...)` 는 반드시 `ed.destroy()` 로 정리한다(프로젝트 메모리: 미정리 시 teardown 후 DOMObserver "document is not defined" flake).

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts`
Expected: FAIL — `.tomboy-bridge-detail` 없음

- [ ] **Step 3: 구현** — `app/src/lib/editor/bridgeNote/bridgeNotePlugin.ts`

기존 import에 추가:
```ts
import { DETAIL_BUTTONS } from '$lib/bridgeStatus/detail/registry.js';
import { openBridgeDetail } from '$lib/bridgeStatus/detail/openBridgeDetail.js';
```

`renderButton` 다음에 상세 버튼 묶음 렌더 함수 추가:
```ts
function renderDetailButtons(): HTMLElement {
	const wrap = document.createElement('span');
	wrap.className = 'tomboy-bridge-detail-row';
	wrap.contentEditable = 'false';
	for (const b of DETAIL_BUTTONS) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'tomboy-bridge-detail';
		btn.contentEditable = 'false';
		btn.textContent = b.label;
		btn.addEventListener('mousedown', (e) => e.preventDefault());
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			openBridgeDetail(b.key);
		});
		wrap.appendChild(btn);
	}
	return wrap;
}
```

`buildDecorations` 에서 ⟳ 위젯 다음에 상세 위젯도 추가:
```ts
function buildDecorations(doc: PMNode): DecorationSet {
	const first = doc.firstChild;
	if (!first || !isBridgeTitle(first.textContent)) return DecorationSet.empty;
	const afterTitlePos = first.nodeSize;
	const runWidget = Decoration.widget(afterTitlePos, (view) => renderButton(view), {
		side: 1,
		key: 'bridge-run'
	});
	const detailWidget = Decoration.widget(afterTitlePos, () => renderDetailButtons(), {
		side: 1,
		key: 'bridge-detail'
	});
	return DecorationSet.create(doc, [runWidget, detailWidget]);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts`
Expected: PASS

- [ ] **Step 5: 타입체크 + 커밋**

Run: `cd app && npm run check`
Expected: 신규 파일 타입 에러 0
```bash
git add app/src/lib/editor/bridgeNote/bridgeNotePlugin.ts app/tests/unit/lib/editor/bridgeNote/bridgeDetailButtons.test.ts
git commit -m "feat(app): 브릿지 노트에 일기 상세 버튼(클릭→오버레이)"
```

---

### Task 7: 가이드 카드 + 스킬 노트

**Goal:** 설정 → 가이드에 일기 드릴다운 카드 추가(프로젝트 불변식: 사용자 대면 기능은 가이드 탭에 문서화) + 스킬 갱신.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab` notes 또는 env 서브탭)
- Modify: `.claude/skills/tomboy-bridgedash/SKILL.md`

**Acceptance Criteria:**
- [ ] 가이드에 `<details class="guide-card">` 추가 — 짧은 `<summary>` + `<p class="info-text">` 소개 + `<ul class="guide-list">` 로 신호 설명(push 신선도/폴더별 backlog/마지막 OCR).
- [ ] 기존 가이드 카드 패턴(클래스명) 일치.
- [ ] 스킬 본문에 `GET /status/diary` + 드릴다운 오버레이/레지스트리 골격 한 문단 추가.

**Verify:** `cd app && npm run check && npm run build` → 빌드 성공(가이드 마크업 유효).

**Steps:**

- [ ] **Step 1: 가이드 카드 추가** — `app/src/routes/settings/+page.svelte` 의 브릿지 관련 가이드 위치(없으면 `env` 서브탭)에 삽입:

```svelte
<details class="guide-card">
	<summary>브릿지 노트 — 서비스 상세 보기</summary>
	<p class="info-text">
		<code>브릿지::</code> 노트 제목 아래 <strong>📓 일기</strong> 버튼을 누르면 일기
		파이프라인의 최근 처리 상태가 읽기전용으로 뜹니다.
	</p>
	<ul class="guide-list">
		<li><strong>Push 신선도</strong> — reMarkable→Pi 로 마지막 페이지가 도착한 시각. 지연/정체를 색으로 표시.</li>
		<li><strong>폴더별 backlog</strong> — Diary/Notes/Slip-Notes 별 대기 페이지 수(막대).</li>
		<li><strong>마지막 OCR 실행</strong> — 데스크탑 OCR 의 최근 실행 결과·시각·로그 꼬리(설정된 경우).</li>
	</ul>
</details>
```

- [ ] **Step 2: 스킬 노트** — `.claude/skills/tomboy-bridgedash/SKILL.md` 에 한 문단 추가(경로/흐름 섹션 근처):

```markdown
## 서비스 드릴다운 (Phase 1: 일기)
- 제목 뒤 위젯에 상세 버튼(`DETAIL_BUTTONS`) — 클릭 시 `openBridgeDetail(key)` →
  `BridgeDetailOverlay`(body 온디맨드 마운트, `--z-modal`) → `fetchBridgeDetail(key)` →
  `DETAIL_REGISTRY[key].component`.
- 브릿지 `GET /status/diary`(`status_diary.ts`): 마운트된 inbox glob(push 신선도/폴더별
  backlog) + desktop `trigger_server /status` 프록시(OCR). inbox 마운트는
  `term-bridge.container`(`/var/lib/diary-inbox:ro`), trigger 는 `DIARY_TRIGGER_URL/TOKEN`.
- 후속 서비스 = `registry.ts` 엔트리 + 브릿지 `/status/<key>` 분기 추가.
```

- [ ] **Step 3: 빌드 확인 + 커밋**

Run: `cd app && npm run check && npm run build`
Expected: 성공
```bash
git add app/src/routes/settings/+page.svelte .claude/skills/tomboy-bridgedash/SKILL.md
git commit -m "docs(bridgedash): 가이드 카드 + 스킬 일기 드릴다운 노트"
```

---

## 통합 검증 (전체 완료 후)

- [ ] `cd bridge && npm test` — status_diary 포함 전체 green.
- [ ] `cd app && npx vitest run tests/unit/lib/bridgeStatus tests/unit/lib/editor/bridgeNote` — 전체 green.
- [ ] `cd app && npm run check` — 타입 0.
- [ ] 수동: 브릿지 재배포 후 `브릿지::` 노트에서 📓 일기 클릭 → 오버레이가 push 신선도/backlog 표시. (trigger 미설정이면 OCR 섹션 회색 안내.)

## 메모

- **gatherFiles 중복**: `status.ts:gatherFiles` 와 `gatherDiaryInbox` 는 glob 패턴이 비슷하나
  버킷팅/stale 계산이 달라 공유 추출은 YAGNI — Phase 2 에서 서비스가 늘면 그때 판단.
- **trigger 도달성**: `DIARY_TRIGGER_URL` 없이도 inbox 섹션만으로 출하 가능(우아한 폴백).
  Pi→desktop 도달 경로는 배포 시 확인(스펙 미해결 항목).
