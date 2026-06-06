# 음악추출 재생목록 지원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `음악추출::` 노트에서 유튜브 재생목록/믹스 URL 한 줄을 ⟳로 전체 mp3 추출하고, 결과를 소스 줄 아래에 `음악::` 노트로 복사 가능한 `[ ]플레이리스트:` 블록으로 기록한다.

**Architecture:** "열거만 신규" — music-service에 `yt-dlp -J --flat-playlist` 열거 엔드포인트(`/enumerate`)를 추가하고 브릿지가 `/music/enumerate`로 릴레이한다. 곡별 다운로드/업로드/HMAC 토큰/멱등/타임아웃은 기존 단일 추출 경로(`extractOne` → `/music/extract`)를 그대로 재사용한다. 앱은 노트의 일반 텍스트 줄(재생목록)과 불릿(단일 곡)을 구분 파싱하고, 성공한 트랙 URL을 `음악::` 호환 플레이리스트 블록으로 삽입한다.

**Tech Stack:** music-service(Fastify+vitest), bridge(node:http+`node --test`), app(SvelteKit/TipTap3/ProseMirror+vitest). 스펙: `docs/superpowers/specs/2026-06-06-music-playlist-extract-design.md`.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `music-service/src/runner.ts` | yt-dlp 실행 | `enumerate()` + `EnumerateDeps`/`EnumerateOk`/`PlaylistEntry` 추가 (기존 `extract`/`runYtdlp` 불변) |
| `music-service/src/server.ts` | HTTP 라우트 | `enumerateFn`/`enumerateOpts` + `POST /enumerate` + 부트 와이어링 |
| `music-service/tests/runner.test.ts` | 러너 테스트 | `enumerate` 케이스 추가 |
| `music-service/tests/server.test.ts` | 서버 테스트 | `/enumerate` 케이스 추가 |
| `bridge/src/music.ts` | 음악 릴레이 | 공통 `proxyMusic` 추출 + `handleMusicEnumerate` 추가 |
| `bridge/src/server.ts` | 라우팅 | `POST /music/enumerate` 라우트 |
| `bridge/src/music.test.ts` | 릴레이 테스트 | `handleMusicEnumerate` 케이스 추가 |
| `app/src/lib/musicExtract/extractClient.ts` | 브릿지 클라이언트 | `enumeratePlaylist()` + `PlaylistEntry`/`EnumerateOk` 추가 |
| `app/src/lib/musicExtract/parseExtractNote.ts` | 노트 파서 | 블록 순회 리팩터 + `ExtractItem` 판별 유니온 + `playlistSourceOf`/`isPlaylistHeaderText` export |
| `app/src/lib/musicExtract/writeExtractResult.ts` | 단일 결과 기록 | `urlChild` export 화 (그 외 불변) |
| `app/src/lib/musicExtract/writePlaylistBlock.ts` | **신규** 플레이리스트 블록 삽입 | 신규 |
| `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts` | ⟳ 진행 | `kind` 분기 + 재생목록 흐름 + 요약 토스트 |
| `app/src/routes/settings/+page.svelte` | 가이드 | 음악추출 카드에 재생목록 사용법 추가 |
| `.claude/skills/tomboy-musicextract/SKILL.md` | 스킬 | 열거/릴레이/블록 포맷/멱등 규칙 추가 |

신규 테스트: `app/tests/unit/musicExtract/writePlaylistBlock.test.ts`, `app/tests/unit/musicExtract/playlistBlockRoundtrip.test.ts`.

---

### Task 1: music-service `enumerate()` 러너

**Goal:** `yt-dlp -J --flat-playlist`로 재생목록을 열거해 `{label, entries, total, truncated}`를 반환하는 `enumerate()`를 추가한다.

**Files:**
- Modify: `music-service/src/runner.ts` (기존 `extract`/`runYtdlp`/`uploadToBridge` 불변, 끝에 추가)
- Test: `music-service/tests/runner.test.ts`

**Acceptance Criteria:**
- [ ] `enumerate()`가 정상 JSON에서 `label`(title 없으면 `'재생목록'`)과 `entries[{url,title}]`를 파싱한다 (id→`https://www.youtube.com/watch?v=<id>`).
- [ ] `maxPlaylist` 상한으로 `entries`를 자르고 `total`/`truncated`를 정확히 보고한다.
- [ ] 엔트리 0개 → `bad_source:empty_playlist` throw; stdout 파싱 실패 → `bad_source:enumerate_parse` throw; reject 소스 → `bad_source:*` throw; 비정상 종료 → throw.
- [ ] stdout을 끝까지 소비한다(`stdio:['ignore','pipe','pipe']`).

**Verify:** `cd music-service && npm test -- runner` → 신규 enumerate 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `music-service/tests/runner.test.ts` 끝에 추가 (파일 상단 import에 `enumerate` 추가: `import { extract, enumerate } from '../src/runner.js';`)

```ts
// stdout 으로 JSON 을 흘리고 종료코드로 닫는 가짜 spawn.
function fakeSpawnJson(exitCode: number, stdout: string) {
	return (_cmd: string, _args: string[]) => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => {
			if (exitCode === 0 && stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
			child.emit('close', exitCode);
		});
		return child as never;
	};
}
const PL_JSON = JSON.stringify({
	title: '가수A 믹스',
	entries: [
		{ id: 'aaa', title: 'Song A' },
		{ id: 'bbb', title: 'Song B' },
		{ id: 'ccc', title: 'Song C' }
	]
});

describe('enumerate', () => {
	it('정상 JSON → label + entries(id→watch url)', async () => {
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, PL_JSON) as never });
		expect(out.label).toBe('가수A 믹스');
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(false);
		expect(out.entries).toEqual([
			{ url: 'https://www.youtube.com/watch?v=aaa', title: 'Song A' },
			{ url: 'https://www.youtube.com/watch?v=bbb', title: 'Song B' },
			{ url: 'https://www.youtube.com/watch?v=ccc', title: 'Song C' }
		]);
	});
	it('maxPlaylist 상한으로 자르고 truncated=true', async () => {
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, PL_JSON) as never, maxPlaylist: 2 });
		expect(out.entries).toHaveLength(2);
		expect(out.total).toBe(3);
		expect(out.truncated).toBe(true);
	});
	it('title 없으면 재생목록, url 폴백', async () => {
		const j = JSON.stringify({ entries: [{ url: 'https://www.youtube.com/watch?v=zzz' }] });
		const out = await enumerate('https://yt/list?list=PL1', { spawn: fakeSpawnJson(0, j) as never });
		expect(out.label).toBe('재생목록');
		expect(out.entries[0]).toEqual({ url: 'https://www.youtube.com/watch?v=zzz', title: 'zzz' });
	});
	it('0 엔트리 → bad_source:empty_playlist', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(0, JSON.stringify({ entries: [] })) as never }))
			.rejects.toThrow(/bad_source:empty_playlist/);
	});
	it('stdout 파싱 실패 → bad_source:enumerate_parse', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(0, 'not json') as never }))
			.rejects.toThrow(/bad_source:enumerate_parse/);
	});
	it('reject 소스 → bad_source', async () => {
		await expect(enumerate('-x', { spawn: fakeSpawnJson(0, PL_JSON) as never })).rejects.toThrow(/bad_source/);
	});
	it('비정상 종료 → throw', async () => {
		await expect(enumerate('https://yt/x?list=PL', { spawn: fakeSpawnJson(1, '') as never })).rejects.toThrow();
	});
});
```

- [ ] **Step 2: 실패 확인** — `cd music-service && npm test -- runner` → `enumerate` is not exported / 미정의로 FAIL

- [ ] **Step 3: 구현** — `music-service/src/runner.ts` 끝에 추가:

```ts
export interface PlaylistEntry { url: string; title: string; }
export interface EnumerateOk { label: string; entries: PlaylistEntry[]; total: number; truncated: boolean; }
export interface EnumerateDeps {
	spawn?: typeof nodeSpawn;
	ytdlpPath?: string;
	timeoutMs?: number;
	maxPlaylist?: number;
}

interface RawEntry { id?: unknown; url?: unknown; title?: unknown; }
interface PlaylistJson { title?: unknown; entries?: unknown; }

function entryToTrack(e: unknown): PlaylistEntry | null {
	if (!e || typeof e !== 'object') return null;
	const r = e as RawEntry;
	const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : '';
	const id = typeof r.id === 'string' && r.id ? r.id : '';
	if (id) return { url: `https://www.youtube.com/watch?v=${id}`, title: title || id };
	if (typeof r.url === 'string' && r.url) {
		const full = /^https?:\/\//i.test(r.url) ? r.url : `https://www.youtube.com/watch?v=${r.url}`;
		return { url: full, title: title || r.url };
	}
	return null;
}

export async function enumerate(source: string, deps: EnumerateDeps): Promise<EnumerateOk> {
	const resolved = resolveSource(source);
	if (resolved.kind === 'reject') throw new Error(`bad_source:${resolved.reason}`);
	const max = deps.maxPlaylist ?? 50;
	const json = await runYtdlpJson(resolved.value, deps);
	let parsed: PlaylistJson;
	try {
		parsed = JSON.parse(json) as PlaylistJson;
	} catch {
		throw new Error('bad_source:enumerate_parse');
	}
	const label = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '재생목록';
	const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
	const all = raw.map(entryToTrack).filter((e): e is PlaylistEntry => e !== null);
	if (all.length === 0) throw new Error('bad_source:empty_playlist');
	const total = all.length;
	const entries = all.slice(0, max);
	return { label, entries, total, truncated: total > max };
}

function runYtdlpJson(arg: string, deps: EnumerateDeps): Promise<string> {
	const spawn = deps.spawn ?? nodeSpawn;
	const bin = deps.ytdlpPath ?? 'yt-dlp';
	const timeoutMs = deps.timeoutMs ?? 60_000;
	const args = ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', '--socket-timeout', '30', arg];
	return new Promise((resolve, reject) => {
		const opts: SpawnOptions = { cwd: process.env.HOME, stdio: ['ignore', 'pipe', 'pipe'] };
		const child = spawn(bin, args, opts);
		let out = '';
		let errOut = '';
		let settled = false;
		const fail = (msg: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { child.kill('SIGTERM'); } catch { /* gone */ }
			reject(new Error(msg));
		};
		const timer = setTimeout(() => fail('타임아웃'), timeoutMs);
		// stdout 은 반드시 끝까지 소비(flat-playlist JSON; 50곡이면 수십 KB 수준).
		child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
		child.stderr?.on('data', (d: Buffer) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
		child.on('error', (e: Error) => fail(e.message));
		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
		});
	});
}
```

- [ ] **Step 4: 통과 확인** — `cd music-service && npm test -- runner` → PASS

- [ ] **Step 5: 커밋**

```bash
git add music-service/src/runner.ts music-service/tests/runner.test.ts
git commit -m "feat(music-service): enumerate() playlist runner (yt-dlp --flat-playlist)"
```

---

### Task 2: music-service `POST /enumerate` 엔드포인트

**Goal:** `/extract`와 동일한 인증·에러 규약으로 열거를 노출하는 `POST /enumerate`를 추가하고 부트에서 env를 와이어링한다.

**Files:**
- Modify: `music-service/src/server.ts`
- Test: `music-service/tests/server.test.ts`

**Acceptance Criteria:**
- [ ] `POST /enumerate`: Bearer 없으면 401, source 없으면 400, 성공 시 200 + `{label,entries,total,truncated}`.
- [ ] 에러 코드 매핑: `bad_source*`→400, `타임아웃`→504, 그 외→502.
- [ ] `enumerateFn` 주입으로 테스트 가능; 부트에서 `MUSIC_MAX_PLAYLIST`(기본 50)·`MUSIC_ENUMERATE_TIMEOUT_MS`(기본 60000)·`YTDLP_PATH` 와이어링.

**Verify:** `cd music-service && npm test -- server` → 신규 `/enumerate` 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `music-service/tests/server.test.ts` 끝에 추가 (`app()` 헬퍼는 extract 전용이므로 enumerate 전용 헬퍼 추가):

```ts
import type { EnumerateOk } from '../src/runner.js';

function appEnum(enumerateFn: (s: string) => Promise<EnumerateOk>) {
	return buildServer({ sharedToken: 'tok', bridgeFilesUrl: 'http://b', enumerateFn });
}
const okEnum: EnumerateOk = { label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false };

describe('POST /enumerate', () => {
	it('401 without bearer', async () => {
		const res = await appEnum(async () => okEnum).inject({ method: 'POST', url: '/enumerate', payload: { source: 'x' } });
		expect(res.statusCode).toBe(401);
	});
	it('400 on missing source', async () => {
		const res = await appEnum(async () => okEnum).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: {} });
		expect(res.statusCode).toBe(400);
	});
	it('200 with enumerate result', async () => {
		const fn = vi.fn(async () => okEnum);
		const res = await appEnum(fn).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: { source: 'https://yt/p?list=PL' } });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual(okEnum);
		expect(fn).toHaveBeenCalledWith('https://yt/p?list=PL');
	});
	it('400 bad_source, 504 타임아웃, 502 otherwise', async () => {
		const mk = (msg: string) => appEnum(async () => { throw new Error(msg); }).inject({ method: 'POST', url: '/enumerate', headers: auth, payload: { source: 'x' } });
		expect((await mk('bad_source:empty_playlist')).statusCode).toBe(400);
		expect((await mk('타임아웃')).statusCode).toBe(504);
		expect((await mk('boom')).statusCode).toBe(502);
	});
});
```

- [ ] **Step 2: 실패 확인** — `cd music-service && npm test -- server` → `/enumerate` 404/타입 에러로 FAIL

- [ ] **Step 3: 구현** — `music-service/src/server.ts`:
  - import 교체: `import { extract as defaultExtract, enumerate as defaultEnumerate, type RunnerDeps, type EnumerateDeps, type EnumerateOk } from './runner.js';`
  - `BuildServerOpts`에 추가:

```ts
	enumerateOpts?: Partial<EnumerateDeps>;
	enumerateFn?: (source: string) => Promise<EnumerateOk>;
```

  - `runExtract` 정의 아래에 추가:

```ts
	const runEnumerate =
		opts.enumerateFn ?? ((source: string) => defaultEnumerate(source, { ...opts.enumerateOpts }));
```

  - `app.post('/extract', ...)` 블록 뒤에 추가:

```ts
	app.post('/enumerate', async (req, reply) => {
		const token = extractBearer(req.headers.authorization);
		if (!verifyToken(opts.sharedToken, token)) return reply.code(401).send({ error: 'unauthorized' });
		const body = req.body as { source?: unknown } | undefined;
		if (!body || typeof body.source !== 'string' || !body.source) {
			return reply.code(400).send({ error: 'bad_request', detail: 'source required' });
		}
		try {
			const out = await runEnumerate(body.source);
			return reply.code(200).send(out);
		} catch (err) {
			const msg = (err as Error).message;
			const code = msg.startsWith('bad_source') ? 400 : msg === '타임아웃' ? 504 : 502;
			return reply.code(code).send({ error: code === 400 ? 'bad_source' : 'enumerate_failed', detail: msg });
		}
	});
```

  - 부트 가드(`if (import.meta.url === ...)`) 안, `const port =` 줄 앞에 추가:

```ts
	const enumerateOpts: Partial<EnumerateDeps> = {
		ytdlpPath: process.env.YTDLP_PATH,
		maxPlaylist: Number(process.env.MUSIC_MAX_PLAYLIST ?? 50),
		timeoutMs: Number(process.env.MUSIC_ENUMERATE_TIMEOUT_MS ?? 60_000)
	};
```

  - `buildServer({ ... })` 호출에 `enumerateOpts` 추가: `const app = buildServer({ sharedToken, bridgeFilesUrl, runnerOpts, enumerateOpts });`

- [ ] **Step 4: 통과 확인** — `cd music-service && npm test` → 전체 PASS (`tsc` 빌드도: `npm run build`)

- [ ] **Step 5: 커밋**

```bash
git add music-service/src/server.ts music-service/tests/server.test.ts
git commit -m "feat(music-service): POST /enumerate endpoint + boot wiring"
```

---

### Task 3: bridge `/music/enumerate` 릴레이

**Goal:** 브릿지에 `POST /music/enumerate`를 추가해 데스크탑 music-service `/enumerate`로 재-Bearer 릴레이한다. 기존 `/music/extract`와 공통 로직을 공유한다.

**Files:**
- Modify: `bridge/src/music.ts` (공통 `proxyMusic` 추출, `handleMusicExtract` 위임화, `handleMusicEnumerate` 추가)
- Modify: `bridge/src/server.ts` (라우트 + import)
- Test: `bridge/src/music.test.ts`

**Acceptance Criteria:**
- [ ] `handleMusicEnumerate`: Bearer 없으면 401, source 없으면/JSON 깨지면 400, `musicServiceUrl` 비면 503-not_configured, 업스트림 네트워크 오류 시 503-unavailable.
- [ ] 업스트림 URL이 `${musicServiceUrl}/enumerate`이고 `Authorization: Bearer ${secret}`로 재-Bearer, body `{source}` 전달, 응답 그대로 파이프.
- [ ] 기존 `handleMusicExtract` 동작·테스트 전부 그대로 통과(`/extract`로 릴레이 유지).

**Verify:** `cd bridge && node --test` → music.test.ts 전체(기존+신규) PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/music.test.ts`: import에 `handleMusicEnumerate` 추가(`import { handleMusicExtract, handleMusicEnumerate } from './music.js';`), 끝에 추가:

```ts
test('enumerate: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({}, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 401);
});

test('enumerate: 503 when service url not configured', async () => {
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, '');
	assert.equal(get().status, 503);
	assert.match(get().body, /not_configured/);
});

test('enumerate: forwards to /enumerate with re-Bearer and pipes response', async () => {
	let calledUrl = '', calledAuth = '', calledBody = '';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(url);
		calledAuth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		calledBody = typeof init?.body === 'string' ? init.body : '';
		return new Response(JSON.stringify({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'https://yt/p?list=PL' }), res, SECRET, URL_);
	assert.equal(get().status, 200);
	assert.equal(calledUrl, 'http://music.test/enumerate');
	assert.equal(calledAuth, `Bearer ${SECRET}`);
	assert.deepEqual(JSON.parse(calledBody), { source: 'https://yt/p?list=PL' });
	assert.match(get().body, /entries/);
});

test('enumerate: 503 on upstream network error', async () => {
	globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 503);
	assert.match(get().body, /unavailable/);
});

test('enumerate: 400 on missing source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});
```

- [ ] **Step 2: 실패 확인** — `cd bridge && node --test src/music.test.ts` → `handleMusicEnumerate` 미export로 FAIL

- [ ] **Step 3: 구현** — `bridge/src/music.ts` 전체를 아래로 교체 (공통 `proxyMusic` 추출, 두 핸들러는 경로/타임아웃만 다름):

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface ExtractBody { source?: unknown; }

/** POST /music/extract → desktop music-service /extract (yt-dlp 다운로드, 느림). */
export async function handleMusicExtract(req: IncomingMessage, res: ServerResponse, secret: string, musicServiceUrl: string): Promise<void> {
	// 백스톱 타임아웃 — music-service 자체 한도(MUSIC_TIMEOUT_MS)보다 넉넉히 위로.
	return proxyMusic(req, res, secret, musicServiceUrl, '/extract', 600_000);
}

/** POST /music/enumerate → desktop music-service /enumerate (열거만, 빠름). */
export async function handleMusicEnumerate(req: IncomingMessage, res: ServerResponse, secret: string, musicServiceUrl: string): Promise<void> {
	return proxyMusic(req, res, secret, musicServiceUrl, '/enumerate', 120_000);
}

/**
 * 음악 서비스 공통 프록시. 클라 Bearer 검증 후 BRIDGE_SECRET 으로 재-Bearer 하여
 * upstream path 로 릴레이하고 응답을 그대로 파이프. /automation/run 패턴과 동일.
 */
async function proxyMusic(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	musicServiceUrl: string,
	path: string,
	timeoutMs: number
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	if (!musicServiceUrl) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'music_service_not_configured' }));
		return;
	}
	let body: ExtractBody;
	try {
		body = (await readJson(req)) as ExtractBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const source = typeof body.source === 'string' ? body.source.trim() : '';
	if (!source) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_source' }));
		return;
	}
	let upstream: Response;
	try {
		upstream = await fetch(`${musicServiceUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
			body: JSON.stringify({ source }),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		console.warn(`[term-bridge music] upstream error: ${(err as Error).message}`);
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'music_service_unavailable' }));
		return;
	}
	const text = await upstream.text();
	res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 64 * 1024;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX) throw new Error('body too large');
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}
```

- [ ] **Step 4: 라우트 추가** — `bridge/src/server.ts`:
  - import 교체: `import { handleMusicExtract, handleMusicEnumerate } from './music.js';`
  - `/music/extract` 블록 바로 뒤에 추가:

```ts
		if (url === '/music/enumerate' && req.method === 'POST') {
			await handleMusicEnumerate(req, res, SECRET, MUSIC_SERVICE_URL);
			return;
		}
```

- [ ] **Step 5: 통과 확인** — `cd bridge && node --test` → 전체 PASS (빌드: `npm run build`)

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/music.ts bridge/src/music.test.ts bridge/src/server.ts
git commit -m "feat(bridge): POST /music/enumerate relay (shared proxyMusic)"
```

---

### Task 4: app `enumeratePlaylist()` 클라이언트

**Goal:** 앱에서 브릿지 `/music/enumerate`를 호출하는 `enumeratePlaylist()`를 `extractClient.ts`에 추가한다. 기존 `ExtractError`/`STATUS_TO_KIND`를 재사용한다.

**Files:**
- Modify: `app/src/lib/musicExtract/extractClient.ts`
- Test: `app/tests/unit/musicExtract/extractClient.test.ts`

**Acceptance Criteria:**
- [ ] 브릿지 미설정 → `not_configured` throw + fetch 미호출.
- [ ] 성공 응답 `{label,entries,total,truncated}`을 파싱; URL은 `${base}/music/enumerate`, Bearer/`{source}` 전송, signal 전달.
- [ ] 401→unauthorized, 503→service_unavailable, 5xx→upstream_error, 4xx→bad_request, fetch throw→network.
- [ ] 빈 entries 응답 → `upstream_error` throw.

**Verify:** `cd app && npm run test -- extractClient` → 신규 enumerate 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/musicExtract/extractClient.test.ts`: import에 `enumeratePlaylist` 추가, 끝에 추가:

```ts
it('enumeratePlaylist: 미설정이면 not_configured + fetch 미호출', async () => {
	(bs.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	const spy = vi.fn();
	globalThis.fetch = spy as unknown as typeof fetch;
	await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	expect(spy).not.toHaveBeenCalled();
});

it('enumeratePlaylist: 성공 응답 파싱 + Bearer/본문/URL/signal', async () => {
	let url = '', auth = '', body = '';
	let sig: AbortSignal | undefined;
	globalThis.fetch = (async (u: string, init: RequestInit) => {
		url = String(u); auth = (init.headers as Record<string, string>).Authorization; body = String(init.body); sig = init.signal as AbortSignal | undefined;
		return new Response(JSON.stringify({ label: '가수A', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false }), { status: 200 });
	}) as unknown as typeof fetch;
	const ctrl = new AbortController();
	const out = await enumeratePlaylist({ source: 'https://yt/p?list=PL', signal: ctrl.signal });
	expect(out.label).toBe('가수A');
	expect(out.entries).toHaveLength(2);
	expect(out.total).toBe(2);
	expect(url).toBe('https://bridge.example/music/enumerate');
	expect(auth).toBe('Bearer tok');
	expect(JSON.parse(body)).toEqual({ source: 'https://yt/p?list=PL' });
	expect(sig).toBe(ctrl.signal);
});

it.each([[401, 'unauthorized'], [503, 'service_unavailable'], [500, 'upstream_error'], [400, 'bad_request']])(
	'enumeratePlaylist 상태 %i → %s', async (status, kind) => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'e' }), { status })) as unknown as typeof fetch;
		await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind });
	}
);

it('enumeratePlaylist: 빈 entries → upstream_error', async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ label: 'L', entries: [], total: 0, truncated: false }), { status: 200 })) as unknown as typeof fetch;
	await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind: 'upstream_error' });
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npm run test -- extractClient` → `enumeratePlaylist` 미export로 FAIL

- [ ] **Step 3: 구현** — `app/src/lib/musicExtract/extractClient.ts` 끝에 추가:

```ts
export interface PlaylistEntry {
	url: string;
	title: string;
}
export interface EnumerateOk {
	label: string;
	entries: PlaylistEntry[];
	total: number;
	truncated: boolean;
}

export async function enumeratePlaylist(opts: { source: string; signal?: AbortSignal }): Promise<EnumerateOk> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new ExtractError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/music/enumerate`;

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ source: opts.source }),
			signal: opts.signal
		});
	} catch (err) {
		throw new ExtractError('network', (err as Error).message);
	}

	if (!res.ok) {
		let bodyErr = '';
		try {
			const j = (await res.json()) as { error?: string };
			bodyErr = typeof j?.error === 'string' ? j.error : '';
		} catch {
			/* ignore */
		}
		const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
		throw new ExtractError(kind, bodyErr || undefined);
	}

	const data = (await res.json()) as Partial<EnumerateOk>;
	const entries = Array.isArray(data.entries)
		? data.entries.filter((e): e is PlaylistEntry => !!e && typeof e.url === 'string' && e.url.length > 0)
		: [];
	if (entries.length === 0) throw new ExtractError('upstream_error', 'empty_playlist');
	return {
		label: typeof data.label === 'string' && data.label ? data.label : '재생목록',
		entries,
		total: typeof data.total === 'number' ? data.total : entries.length,
		truncated: data.truncated === true
	};
}
```

- [ ] **Step 4: 통과 확인** — `cd app && npm run test -- extractClient` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/musicExtract/extractClient.ts app/tests/unit/musicExtract/extractClient.test.ts
git commit -m "feat(app): enumeratePlaylist bridge client"
```

---

### Task 5: app `parseExtractNote` 블록 순회 리팩터

**Goal:** `parseExtractNote`를 블록 순서대로 순회하도록 리팩터해, 일반 텍스트 줄의 재생목록 소스와 불릿의 단일 곡을 판별 유니온(`ExtractItem`)으로 분류한다.

**Files:**
- Modify: `app/src/lib/musicExtract/parseExtractNote.ts`
- Test: `app/tests/unit/musicExtract/parseExtractNote.test.ts`

**Acceptance Criteria:**
- [ ] `ExtractItem`이 `{kind:'single',source,result,liPos}` | `{kind:'playlist',source,done,paraPos}` 유니온.
- [ ] 일반 텍스트 줄에 `list=`/`/playlist?` URL → `playlist` 항목; 바로 다음 블록이 `플레이리스트:` 헤더면 `done:true`.
- [ ] 불릿/번호 리스트의 각 listItem → `single` 항목(`/files/<uuid>/` URL 항목은 제외).
- [ ] `플레이리스트:` 헤더 문단과 그 다음 결과 리스트는 소스로 잡히지 않음.
- [ ] 기존 단일-곡 노트 동작·테스트 그대로 통과; `pendingItems`가 유니온 처리; `itemSource`/`resultOf`/`isExtractTitle`/`isExtractNoteDoc` 유지; `playlistSourceOf`/`isPlaylistHeaderText` export 추가.

**Verify:** `cd app && npm run test -- parseExtractNote` → 기존+신규 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/musicExtract/parseExtractNote.test.ts` 끝에 `describe` 추가:

```ts
describe('parseExtractNote — 재생목록(혼합)', () => {
	const MIXED = `
	<p>음악추출::혼합</p>
	<p>https://www.youtube.com/watch?v=v1&list=PLaaa</p>
	<ul>
	  <li><p>https://www.youtube.com/watch?v=single1</p></li>
	  <li><p>https://www.youtube.com/watch?v=done1</p>
	    <ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li>
	</ul>`;

	it('일반 줄의 list= URL은 playlist 항목', () => {
		const note = parseExtractNote(docFrom(MIXED));
		const pl = note.items.filter((i) => i.kind === 'playlist');
		expect(pl).toHaveLength(1);
		expect(pl[0]).toMatchObject({ kind: 'playlist', source: 'https://www.youtube.com/watch?v=v1&list=PLaaa', done: false });
	});

	it('불릿은 single 항목으로 유지', () => {
		const note = parseExtractNote(docFrom(MIXED));
		const singles = note.items.filter((i) => i.kind === 'single');
		expect(singles.map((s) => s.source)).toEqual([
			'https://www.youtube.com/watch?v=single1',
			'https://www.youtube.com/watch?v=done1'
		]);
	});

	it('직후 플레이리스트: 헤더가 있으면 done', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLbbb</p>` +
			`<p>플레이리스트: 가수A</p><ul><li><p>https://b.ex/files/${UUID}/T.mp3</p></li></ul>`
		));
		const pl = note.items.filter((i) => i.kind === 'playlist');
		expect(pl[0].kind === 'playlist' && pl[0].done).toBe(true);
		// 결과 리스트의 mp3 줄은 single 소스로 오인되지 않음
		expect(note.items.some((i) => i.source.includes('/files/'))).toBe(false);
	});

	it('pendingItems: done 재생목록·done single 제외', () => {
		const note = parseExtractNote(docFrom(
			`<p>음악추출::x</p>` +
			`<p>https://www.youtube.com/watch?v=a&list=PLc</p><p>플레이리스트: 라벨</p><ul><li><p>https://b.ex/files/${UUID}/A.mp3</p></li></ul>` +
			`<p>https://www.youtube.com/watch?v=b&list=PLd</p>`
		));
		const pend = pendingItems(note);
		expect(pend).toHaveLength(1);
		expect(pend[0].source).toBe('https://www.youtube.com/watch?v=b&list=PLd');
	});

	it('list= 없는 일반 줄/제목은 무시', () => {
		const note = parseExtractNote(docFrom('<p>음악추출::x</p><p>그냥 메모</p><p>https://example.com/page</p>'));
		expect(note.items).toEqual([]);
	});
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npm run test -- parseExtractNote` → playlist 분류 미구현으로 FAIL

- [ ] **Step 3: 구현** — `app/src/lib/musicExtract/parseExtractNote.ts` 전체를 아래로 교체:

```ts
import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const PREFIX = '음악추출::';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/;
// 재생목록 URL: youtube list= 또는 /playlist? 포함.
const PLAYLIST_URL_RE = /[?&]list=|\/playlist\?/i;
// 생성된 결과 헤더 '플레이리스트:'. inlineCheckbox atom 은 textContent 에 안 나오므로
// 보통 '플레이리스트:'로 시작하지만, atom 미등록(테스트)·수기 입력 대비 선두 [ ]/[x] 허용.
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

/** prose 끝에 붙은 구두점 제거 — 마크 href 가 아닌 텍스트 매칭에만 적용. */
function trimTrailingPunct(url: string): string {
	return url.replace(/[.,;:!?)\]}'"]+$/, '');
}

export type ExtractResult =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string }
	| { kind: 'pending' };

export interface SingleItem {
	kind: 'single';
	source: string;
	result: ExtractResult;
	liPos: number; // top-level listItem 시작 pos (데코 anchor)
}
export interface PlaylistItem {
	kind: 'playlist';
	source: string; // 재생목록 URL
	done: boolean; // 바로 다음 블록이 '플레이리스트:' 결과 헤더이면 true
	paraPos: number; // 소스 문단 시작 pos
}
export type ExtractItem = SingleItem | PlaylistItem;

export interface ExtractNote {
	isExtract: boolean;
	items: ExtractItem[];
}

/** 제목 텍스트가 음악추출 노트 접두사로 시작하는지(싼 게이트). */
export function isExtractTitle(titleText: string): boolean {
	return titleText.trim().startsWith(PREFIX);
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

function nestedListOf(li: PMNode): PMNode | null {
	let found: PMNode | null = null;
	li.forEach((child) => {
		if (!found && isListNode(child)) found = child;
	});
	return found;
}

/** node 안 첫 http URL — tomboyUrlLink/link 마크 href 우선, 없으면 본문 정규식. 링크 텍스트 동반. */
function firstUrlAndText(node: PMNode): { url: string; text: string } | null {
	let out: { url: string; text: string } | null = null;
	node.descendants((n) => {
		if (out) return false;
		if (n.isText) {
			const link = n.marks.find((m) => m.type.name === 'tomboyUrlLink' || m.type.name === 'link');
			const href = link?.attrs?.href;
			if (typeof href === 'string' && HTTP_URL_RE.test(href)) {
				out = { url: href, text: n.text ?? '' };
				return false;
			}
		}
		return true;
	});
	if (out) return out;
	const m = HTTP_URL_RE.exec(node.textContent);
	return m ? { url: trimTrailingPunct(m[0]), text: '' } : null;
}

function headText(li: PMNode): string {
	const first = li.firstChild;
	return first ? first.textContent.trim() : '';
}

/**
 * 항목의 소스 식별자 = head 단락의 링크 href 우선, 없으면 head 텍스트(검색어).
 * 이 값이 (1) yt-dlp 로 보내는 추출 대상이자 (2) writeExtractResult 의 매칭 키다.
 */
export function itemSource(li: PMNode): string {
	const first = li.firstChild;
	if (first) {
		const u = firstUrlAndText(first);
		if (u) return u.url;
	}
	return headText(li);
}

/** 최상위 문단이 재생목록 소스인지 — http URL 이면서 list=/playlist? 포함, /files 결과 아님. */
export function playlistSourceOf(block: PMNode): string | null {
	const u = firstUrlAndText(block);
	if (!u) return null;
	if (RESULT_URL_RE.test(u.url)) return null;
	if (!PLAYLIST_URL_RE.test(u.url)) return null;
	return u.url;
}

/** 텍스트가 생성된 '플레이리스트:' 결과 헤더인지(선두 [ ]/[x] 허용). */
export function isPlaylistHeaderText(text: string): boolean {
	return PLAYLIST_HEADER_RE.test(text.trim());
}

function deriveTitle(url: string, linkText: string): string {
	if (linkText && !HTTP_URL_RE.test(linkText)) return linkText;
	try {
		const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
		return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '') || url;
	} catch {
		return url;
	}
}

export function resultOf(li: PMNode): ExtractResult {
	const nested = nestedListOf(li);
	if (!nested) return { kind: 'pending' };
	let result: ExtractResult = { kind: 'pending' };
	nested.forEach((child) => {
		if (result.kind === 'done') return;
		const u = firstUrlAndText(child);
		if (u && RESULT_URL_RE.test(u.url)) {
			result = { kind: 'done', url: u.url, title: deriveTitle(u.url, u.text) };
			return;
		}
		const txt = child.textContent.trim();
		if (result.kind === 'pending' && txt.startsWith('❌')) {
			result = { kind: 'error', message: txt.replace(/^❌\s*/, '') };
		}
	});
	return result;
}

export function parseExtractNote(doc: PMNode): ExtractNote {
	const title = doc.firstChild?.textContent.trim() ?? '';
	const isExtract = isExtractTitle(title);
	if (!isExtract) return { isExtract, items: [] };
	const items: ExtractItem[] = [];
	let idx = 0;
	let prevPlaylist: PlaylistItem | null = null; // 직전에 본 미완료 재생목록 소스
	let skipNextList = false; // 직전 블록이 결과 헤더 → 다음 리스트는 결과(스킵)
	doc.forEach((block, offset) => {
		const i = idx++;
		if (i === 0) return; // 제목
		const type = block.type.name;
		if (type === 'paragraph') {
			const t = block.textContent.trim();
			if (isPlaylistHeaderText(t)) {
				if (prevPlaylist) prevPlaylist.done = true; // 소스의 결과 블록 존재 = 완료
				prevPlaylist = null;
				skipNextList = true;
				return;
			}
			const url = playlistSourceOf(block);
			if (url) {
				const item: PlaylistItem = { kind: 'playlist', source: url, done: false, paraPos: offset };
				items.push(item);
				prevPlaylist = item;
			} else {
				prevPlaylist = null;
			}
			skipNextList = false;
			return;
		}
		if (isListNode(block)) {
			if (skipNextList) {
				skipNextList = false;
				prevPlaylist = null;
				return; // 생성된 결과 리스트
			}
			block.forEach((li, liOffset) => {
				if (li.type.name !== 'listItem') return;
				const source = itemSource(li);
				if (!source || RESULT_URL_RE.test(source)) return; // 결과 mp3 줄은 소스 아님
				items.push({ kind: 'single', source, result: resultOf(li), liPos: offset + 1 + liOffset });
			});
			prevPlaylist = null;
			return;
		}
		prevPlaylist = null;
		skipNextList = false;
	});
	return { isExtract, items };
}

export function pendingItems(note: ExtractNote): ExtractItem[] {
	return note.items.filter((it) => (it.kind === 'single' ? it.result.kind !== 'done' : !it.done));
}

/** 라우트 마운트 게이트용 — JSON doc 첫 단락만 보고 음악추출 노트인지. */
export function isExtractNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(PREFIX);
}
```

- [ ] **Step 4: 통과 확인** — `cd app && npm run test -- parseExtractNote` → 기존+신규 PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/musicExtract/parseExtractNote.ts app/tests/unit/musicExtract/parseExtractNote.test.ts
git commit -m "feat(app): parseExtractNote block-walk — playlist vs single discriminated union"
```

---

### Task 6: app `writePlaylistBlock`

**Goal:** 성공한 트랙 URL들을 소스 줄 아래에 `음악::` 호환 `[ ]플레이리스트:` 헤더 + mp3 불릿 블록으로 삽입하는 `writePlaylistBlock`을 추가한다.

**Files:**
- Create: `app/src/lib/musicExtract/writePlaylistBlock.ts`
- Modify: `app/src/lib/musicExtract/writeExtractResult.ts` (`urlChild` export 화만)
- Test: `app/tests/unit/musicExtract/writePlaylistBlock.test.ts`

**Acceptance Criteria:**
- [ ] 소스 문단 바로 아래에 헤더(미체크 `inlineCheckbox` + `플레이리스트: <label>`)와 mp3 불릿(맨 URL, text===href) 블록을 삽입한다.
- [ ] `inlineCheckbox` 노드가 스키마에 없으면 헤더 텍스트 `[ ]플레이리스트: <label>`로 폴백.
- [ ] 이미 결과 헤더가 뒤따르는 소스(완료) 또는 매칭 소스 없음 → 미삽입(false).
- [ ] 삽입 후 `parseMusicNote`가 해당 블록을(체크 시) 트랙으로 인식하는 byte-호환 구조.

**Verify:** `cd app && npm run test -- writePlaylistBlock` → PASS

**Steps:**

- [ ] **Step 1: `urlChild` export 화** — `app/src/lib/musicExtract/writeExtractResult.ts`에서 `function urlChild(` → `export function urlChild(` (한 단어 추가, 그 외 불변).

- [ ] **Step 2: 실패 테스트 작성** — `app/tests/unit/musicExtract/writePlaylistBlock.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writePlaylistBlock } from '$lib/musicExtract/writePlaylistBlock.js';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const SRC = 'https://www.youtube.com/watch?v=v1&list=PLaaa';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

function fullEditor(html: string) {
	return new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: html });
}

describe('writePlaylistBlock', () => {
	it('소스 줄 아래에 [ ]헤더+mp3 불릿을 삽입하고 재생목록을 done 처리', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p>`);
		const wrote = writePlaylistBlock(ed.view, { source: SRC, label: '가수A 믹스', urls: [U1, U2] });
		expect(wrote).toBe(true);
		const note = parseExtractNote(ed.state.doc);
		const pl = note.items.find((i) => i.kind === 'playlist');
		expect(pl && pl.kind === 'playlist' && pl.done).toBe(true);
		ed.destroy();
	});

	it('삽입 블록은 체크 시 parseMusicNote 트랙으로 인식되는 구조 (제목만 음악:: 로 바꿔 검증)', () => {
		// writePlaylistBlock 은 미체크(off)로 넣으므로, 같은 구조를 음악:: 노트에 두고
		// 체크박스를 켜 트랙 인식되는지 별도 검증(라운드트립 호환).
		const ed = fullEditor(`<p>음악::라이브러리</p><p>${SRC}</p>`);
		writePlaylistBlock(ed.view, { source: SRC, label: '가수A', urls: [U1, U2] });
		// 헤더 체크박스를 켠다(첫 inlineCheckbox 노드를 찾아 checked=true)
		let cbPos = -1;
		ed.state.doc.descendants((n, pos) => {
			if (cbPos < 0 && n.type.name === 'inlineCheckbox') cbPos = pos;
		});
		expect(cbPos).toBeGreaterThan(0);
		ed.view.dispatch(ed.state.tr.setNodeAttribute(cbPos, 'checked', true));
		const music = parseMusicNote(ed.state.doc);
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
		expect(music.playlists[0].label).toBe('가수A');
		ed.destroy();
	});

	it('이미 결과 헤더가 있는 소스는 미삽입', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p><p>플레이리스트: 기존</p><ul><li><p>${U1}</p></li></ul>`);
		const wrote = writePlaylistBlock(ed.view, { source: SRC, label: '새로', urls: [U2] });
		expect(wrote).toBe(false);
		ed.destroy();
	});

	it('빈 urls/파괴된 view → false (no-op)', () => {
		const ed = fullEditor(`<p>음악추출::x</p><p>${SRC}</p>`);
		expect(writePlaylistBlock(ed.view, { source: SRC, label: 'L', urls: [] })).toBe(false);
		const view = ed.view;
		ed.destroy();
		expect(writePlaylistBlock(view, { source: SRC, label: 'L', urls: [U1] })).toBe(false);
	});

	it('inlineCheckbox 미등록 스키마 → [ ] 텍스트 폴백', () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>${SRC}</p>` });
		writePlaylistBlock(ed.view, { source: SRC, label: '폴백', urls: [U1] });
		const text = ed.state.doc.textContent;
		expect(text).toContain('[ ]플레이리스트: 폴백');
		ed.destroy();
	});
});
```

- [ ] **Step 3: 실패 확인** — `cd app && npm run test -- writePlaylistBlock` → 모듈 없음으로 FAIL

- [ ] **Step 4: 구현** — `app/src/lib/musicExtract/writePlaylistBlock.ts` 신규:

```ts
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { urlChild } from '$lib/musicExtract/writeExtractResult.js';
import { playlistSourceOf, isPlaylistHeaderText } from '$lib/musicExtract/parseExtractNote.js';

const PLAYLIST_HEADER_PREFIX = '플레이리스트:';

export interface PlaylistBlockInput {
	source: string;
	label: string;
	urls: string[];
}

/** source 문단(미완료=다음 블록이 결과 헤더 아님) 뒤 삽입 위치를 라이브 재탐색. */
function findInsertPos(doc: PMNode, source: string): number | null {
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	for (let i = 1; i < blocks.length; i++) {
		const { node, offset } = blocks[i];
		if (node.type.name !== 'paragraph') continue;
		if (playlistSourceOf(node) !== source) continue;
		const next = blocks[i + 1]?.node;
		if (next && next.type.name === 'paragraph' && isPlaylistHeaderText(next.textContent)) continue; // 이미 결과 있음
		return offset + node.nodeSize;
	}
	return null;
}

/** 소스 줄 아래에 음악:: 호환 플레이리스트 블록([ ]헤더 + mp3 불릿)을 삽입. 작성 시 true. */
export function writePlaylistBlock(view: EditorView, input: PlaylistBlockInput): boolean {
	if (view.isDestroyed || input.urls.length === 0) return false;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return false;

	const pos = findInsertPos(doc, input.source);
	if (pos == null) return false;

	const cb = schema.nodes.inlineCheckbox;
	const header = cb
		? paragraph.create(null, [cb.create({ checked: false }), schema.text(`${PLAYLIST_HEADER_PREFIX} ${input.label}`)])
		: paragraph.create(null, schema.text(`[ ]${PLAYLIST_HEADER_PREFIX} ${input.label}`));
	const list = bulletList.create(
		null,
		input.urls.map((u) => listItem.create(null, paragraph.create(null, urlChild(schema, u))))
	);

	view.dispatch(state.tr.insert(pos, [header, list]));
	return true;
}
```

- [ ] **Step 5: 통과 확인** — `cd app && npm run test -- writePlaylistBlock` → PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/musicExtract/writePlaylistBlock.ts app/src/lib/musicExtract/writeExtractResult.ts app/tests/unit/musicExtract/writePlaylistBlock.test.ts
git commit -m "feat(app): writePlaylistBlock — insert 음악:: compatible playlist block"
```

---

### Task 7: app 플레이리스트 블록 `.note` 라운드트립 테스트

**Goal:** 생성된 플레이리스트 블록이 `.note` 직렬화→역직렬화 후에도 mp3 href·`[ ]플레이리스트:` 헤더·체크박스를 보존하고, 체크 시 `parseMusicNote`가 트랙으로 인식함을 검증한다(`tomboyUrlLink` href 유실 함정 방지).

**Files:**
- Create: `app/tests/unit/musicExtract/playlistBlockRoundtrip.test.ts`

**Acceptance Criteria:**
- [ ] 미체크 블록을 `serializeContent→deserializeContent` 후 각 mp3 href와 `플레이리스트:` 헤더 텍스트, `inlineCheckbox` 노드가 보존된다.
- [ ] 체크(`checked:true`) 블록을 라운드트립 후 `parseMusicNote`가 라벨·트랙 URL을 그대로 복원한다.

**Verify:** `cd app && npm run test -- playlistBlockRoundtrip` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/musicExtract/playlistBlockRoundtrip.test.ts` 신규:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
const U1 = `https://b.ex/files/${UUID}/Song1.mp3`;
const U2 = `https://b.ex/files/${UUID}/Song2.mp3`;

// writePlaylistBlock 이 만드는 형태를 JSON 으로 직접 구성(checked 가변).
const trackLi = (u: string) => ({
	type: 'listItem',
	content: [{ type: 'paragraph', content: [{ type: 'text', text: u, marks: [{ type: 'tomboyUrlLink', attrs: { href: u } }] }] }]
});
const docOf = (checked: boolean) => ({
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: '음악::라이브러리' }] },
		{ type: 'paragraph', content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text: '플레이리스트: 가수A 믹스' }] },
		{ type: 'bulletList', content: [trackLi(U1), trackLi(U2)] }
	]
});

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });

describe('플레이리스트 블록 .note 라운드트립', () => {
	it('미체크 블록: mp3 href·헤더·체크박스 보존', () => {
		const restored = deserializeContent(serializeContent(docOf(false)));
		const json = JSON.stringify(restored);
		expect(json).toContain(`/files/${UUID}/Song1.mp3`);
		expect(json).toContain(`/files/${UUID}/Song2.mp3`);
		expect(json).toContain('플레이리스트: 가수A 믹스');
		expect(json).toContain('inlineCheckbox');
	});

	it('체크 블록: 라운드트립 후 parseMusicNote 가 트랙 복원', () => {
		const restored = deserializeContent(serializeContent(docOf(true)));
		ed = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: restored });
		const music = parseMusicNote(ed.state.doc);
		expect(music.playlists[0]?.label).toBe('가수A 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([U1, U2]);
	});
});
```

- [ ] **Step 2: 통과 확인** — `cd app && npm run test -- playlistBlockRoundtrip` → PASS. (실패 시 = 라운드트립에서 href/헤더/체크박스가 유실되는 실제 버그 → Task 6 또는 archiver 수정 필요.)

- [ ] **Step 3: 커밋**

```bash
git add app/tests/unit/musicExtract/playlistBlockRoundtrip.test.ts
git commit -m "test(app): playlist block .note round-trip preserves hrefs + parseMusicNote compat"
```

---

### Task 8: app `runExtractButtonClick` 재생목록 분기

**Goal:** ⟳ 진행에서 `single`/`playlist` 항목을 분기 처리해, 재생목록은 열거→곡별 추출→블록 삽입하고 요약 토스트에 곡 수·재생목록 수·잘림을 반영한다.

**Files:**
- Modify: `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts`
- Test: `app/tests/unit/editor/musicExtractNote/runExtractButtonClick.test.ts`

**Acceptance Criteria:**
- [ ] `single` 항목은 기존 흐름(extractOne→writeExtractResult, systemic→토스트+중단, 항목별→❌ 기록).
- [ ] `playlist` 항목: `enumeratePlaylist`(systemic→중단, 그 외 열거 실패→토스트+다음), `entries` 순차 `extractOne`(곡별 실패는 카운트만, systemic→중단), 성공 ≥1 → `writePlaylistBlock`. 0이면 미작성(소스 pending 유지).
- [ ] 요약 토스트에 `재생목록 N개(M곡)`·`X곡 추출`·`Y곡 실패`·잘림 경고 반영.
- [ ] 기존 단일-곡 테스트 전부 그대로 통과.

**Verify:** `cd app && npm run test -- runExtractButtonClick` → 기존+신규 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/musicExtractNote/runExtractButtonClick.test.ts`: mock에 `enumeratePlaylist` 추가, describe 끝에 케이스 추가.
  - mock 블록 교체:

```ts
const extractSpy = vi.fn();
const enumSpy = vi.fn();
vi.mock('$lib/musicExtract/extractClient.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/musicExtract/extractClient.js')>('$lib/musicExtract/extractClient.js');
	return { ...actual, extractOne: (...a: unknown[]) => extractSpy(...a), enumeratePlaylist: (...a: unknown[]) => enumSpy(...a) };
});
```

  - `afterEach` 교체: `afterEach(() => { toastSpy.mockReset(); extractSpy.mockReset(); enumSpy.mockReset(); });`
  - 케이스 추가:

```ts
it('재생목록: 열거→곡별 추출→블록 삽입 + 요약 토스트', async () => {
	const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
	enumSpy.mockResolvedValue({ label: '가수A', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false });
	extractSpy.mockImplementation(async ({ source }: { source: string }) => ({ url: `https://b.ex/files/${UUID}/${source.endsWith('1') ? 'A' : 'B'}.mp3`, title: 'x' }));
	await runExtractButtonClick(ed.view);
	expect(enumSpy).toHaveBeenCalledTimes(1);
	expect(extractSpy).toHaveBeenCalledTimes(2);
	const note = parseExtractNote(ed.state.doc);
	const pl = note.items.find((i) => i.kind === 'playlist');
	expect(pl && pl.kind === 'playlist' && pl.done).toBe(true);
	expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('재생목록 1개(2곡)'), expect.anything());
	ed.destroy();
});

it('재생목록 부분 실패: 성공곡만 블록, 토스트 표기', async () => {
	const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
	enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false });
	extractSpy.mockImplementation(async ({ source }: { source: string }) => {
		if (source === 'https://yt/2') throw new ExtractError('upstream_error', 'x');
		return { url: `https://b.ex/files/${UUID}/A.mp3`, title: 'a' };
	});
	await runExtractButtonClick(ed.view);
	expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('재생목록 1개(1곡)'), expect.anything());
	ed.destroy();
});

it('재생목록 systemic 열거 실패 → 토스트+중단(곡 추출 없음)', async () => {
	const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
	enumSpy.mockRejectedValue(new ExtractError('not_configured', 'x'));
	await runExtractButtonClick(ed.view);
	expect(extractSpy).not.toHaveBeenCalled();
	expect(toastSpy).toHaveBeenCalledWith('브릿지 설정이 필요합니다', { kind: 'error' });
	ed.destroy();
});

it('재생목록 잘림 → 상한 초과 경고', async () => {
	const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
	enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 80, truncated: true });
	extractSpy.mockResolvedValue({ url: `https://b.ex/files/${UUID}/A.mp3`, title: 'a' });
	await runExtractButtonClick(ed.view);
	expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('상한 초과'), expect.anything());
	ed.destroy();
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npm run test -- runExtractButtonClick` → playlist 분기 미구현으로 FAIL

- [ ] **Step 3: 구현** — `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts` 전체 교체:

```ts
import type { EditorView } from '@tiptap/pm/view';
import { parseExtractNote, pendingItems, type ExtractItem } from '$lib/musicExtract/parseExtractNote.js';
import { extractOne, enumeratePlaylist, ExtractError, type ExtractErrorKind } from '$lib/musicExtract/extractClient.js';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { writePlaylistBlock } from '$lib/musicExtract/writePlaylistBlock.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<ExtractErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	network: '음악 추출 서비스에 연결할 수 없습니다',
	service_unavailable: '음악 추출 서비스에 연결할 수 없습니다',
	unauthorized: '브릿지 인증이 필요합니다',
	bad_request: '잘못된 소스',
	upstream_error: '음악 추출 서비스 오류'
};

// 시스템 오류(브릿지/서비스 전체 문제) — 한 항목에서 나면 나머지도 같으므로 토스트만 띄우고 중단.
const SYSTEMIC: ReadonlySet<ExtractErrorKind> = new Set<ExtractErrorKind>([
	'not_configured',
	'unauthorized',
	'service_unavailable',
	'network'
]);

function kindOf(err: unknown): ExtractErrorKind {
	return err instanceof ExtractError ? err.kind : 'network';
}

interface Tally {
	singleOk: number;
	singleFail: number;
	playlistDone: number;
	playlistTracks: number;
	truncated: number;
}

/** ⟳ 진행: 대기(신규+실패) 항목을 순차 처리. systemic 오류면 'stop' 반환(전체 중단). */
async function processSingle(view: EditorView, source: string, t: Tally): Promise<'ok' | 'stop'> {
	try {
		const { url, title } = await extractOne({ source });
		writeExtractResult(view, source, { kind: 'done', url, title });
		t.singleOk++;
	} catch (err) {
		const kind = kindOf(err);
		if (SYSTEMIC.has(kind)) {
			if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
			return 'stop';
		}
		writeExtractResult(view, source, { kind: 'error', message: KIND_MESSAGES[kind] ?? '추출 실패' });
		t.singleFail++;
	}
	return 'ok';
}

async function processPlaylist(view: EditorView, source: string, t: Tally): Promise<'ok' | 'stop'> {
	let enumerated;
	try {
		enumerated = await enumeratePlaylist({ source });
	} catch (err) {
		const kind = kindOf(err);
		if (SYSTEMIC.has(kind)) {
			if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
			return 'stop';
		}
		if (!view.isDestroyed) pushToast(`재생목록 열거 실패: ${KIND_MESSAGES[kind] ?? ''}`, { kind: 'error' });
		return 'ok'; // 다음 항목으로
	}
	if (enumerated.truncated) t.truncated++;
	const urls: string[] = [];
	for (const entry of enumerated.entries) {
		if (view.isDestroyed) return 'stop';
		try {
			const { url } = await extractOne({ source: entry.url });
			urls.push(url);
		} catch (err) {
			const kind = kindOf(err);
			if (SYSTEMIC.has(kind)) {
				if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
				return 'stop';
			}
			// 곡별 실패는 카운트하지 않고 건너뜀(블록엔 성공곡만 — 부분 성공 허용).
		}
	}
	if (urls.length > 0 && writePlaylistBlock(view, { source, label: enumerated.label, urls })) {
		t.playlistDone++;
		t.playlistTracks += urls.length;
	}
	return 'ok';
}

export async function runExtractButtonClick(view: EditorView): Promise<void> {
	const pending = pendingItems(parseExtractNote(view.state.doc));
	if (pending.length === 0) {
		pushToast('추출할 항목이 없습니다', { kind: 'info' });
		return;
	}
	const t: Tally = { singleOk: 0, singleFail: 0, playlistDone: 0, playlistTracks: 0, truncated: 0 };
	for (const item of pending as ExtractItem[]) {
		if (view.isDestroyed) break;
		const outcome = item.kind === 'single' ? await processSingle(view, item.source, t) : await processPlaylist(view, item.source, t);
		if (outcome === 'stop') return;
	}
	if (view.isDestroyed) return;
	const parts: string[] = [];
	if (t.playlistDone) parts.push(`재생목록 ${t.playlistDone}개(${t.playlistTracks}곡)`);
	if (t.singleOk) parts.push(`${t.singleOk}곡 추출`);
	if (t.singleFail) parts.push(`${t.singleFail}곡 실패`);
	if (t.truncated) parts.push(`상한 초과 ${t.truncated}개 일부만`);
	const summary = parts.join(', ') || '변경 없음';
	const isError = t.singleFail > 0 && t.singleOk === 0 && t.playlistDone === 0;
	pushToast(summary, { kind: isError ? 'error' : 'info' });
}
```

- [ ] **Step 4: 통과 확인** — `cd app && npm run test -- runExtractButtonClick` → 기존+신규 PASS

- [ ] **Step 5: 전체 타입체크/테스트** — `cd app && npm run check && npm run test -- musicExtract`

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts app/tests/unit/editor/musicExtractNote/runExtractButtonClick.test.ts
git commit -m "feat(app): runExtractButtonClick playlist branch (enumerate→extract→block)"
```

---

### Task 9: 설정 가이드 카드 갱신

**Goal:** 설정 → 가이드(notes 서브탭)의 음악추출 카드에 재생목록 사용법(텍스트 줄 vs 불릿, 결과 블록 복사, 상한 50, RD 믹스 동적성)을 추가한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (음악추출 카드, ~1744–1764행)

**Acceptance Criteria:**
- [ ] 음악추출 카드에 "재생목록/믹스는 일반 줄, 단일 곡은 불릿" 규칙과 결과 `[ ]플레이리스트:` 블록을 `음악::` 노트로 복사하는 안내가 추가된다.
- [ ] 상한 50곡(초과 시 일부만), RD 믹스는 동적(매번 다름·개수 제한)이라 정규 `list=PL…`/`OLAK5uy…`가 안정적임을 명시한다.
- [ ] 기존 카드 패턴(`<summary>`/`info-text`/`snippet`/`guide-list`) 유지.

**Verify:** `cd app && npm run check` (타입/구문 OK), 그리고 `grep -n "재생목록" app/src/routes/settings/+page.svelte` 로 추가 확인

**Steps:**

- [ ] **Step 1: snippet 갱신** — 음악추출 카드의 `<pre class="snippet">` 블록(현재 `음악추출::내 라이브러리` … `Artist - Title (검색어도 가능)`)을 아래로 교체:

```svelte
					<pre class="snippet">음악추출::내 라이브러리

- https://www.youtube.com/watch?v=…      (단일 곡: 불릿)
- Artist - Title                         (검색어도 가능)
https://www.youtube.com/playlist?list=…  (재생목록: 일반 줄)</pre>
```

- [ ] **Step 2: guide-list 항목 추가** — 같은 카드 `<ul class="guide-list">` 안, "재생하려면 채워진 링크를…" `<li>` 바로 뒤에 추가:

```svelte
						<li><b>재생목록/믹스</b>는 <b>불릿이 아닌 일반 텍스트 줄</b>에 URL을 적으세요. ⟳ 를 누르면
							전체 곡을 추출해 그 줄 <b>바로 아래</b>에 <code>[ ]플레이리스트: …</code> 블록(헤더+곡 목록)을
							만들어 줍니다. 그 블록을 통째로 복사해 <code>음악::</code> 노트에 붙이고 체크박스를 켜면 재생돼요.</li>
						<li>재생목록은 한 번에 <b>최대 50곡</b>까지 받고, 초과하면 앞 50곡만 받은 뒤 안내해요.</li>
						<li>유튜브 자동 <b>믹스(<code>RD…</code>)</b>는 접속할 때마다 곡이 조금씩 바뀌고 개수도 제한적이에요.
							한 가수 곡을 확실히 모으려면 정규 재생목록(<code>list=PL…</code> 또는 앨범
							<code>OLAK5uy…</code>)이 안정적입니다.</li>
```

- [ ] **Step 3: 확인** — `cd app && npm run check` → 에러 없음. `grep -n "재생목록" app/src/routes/settings/+page.svelte` → 신규 줄 출력.

- [ ] **Step 4: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): playlist usage in 음악추출 guide card"
```

---

### Task 10: 스킬 문서 갱신

**Goal:** `tomboy-musicextract` 스킬에 재생목록 열거 흐름·`/music/enumerate` 릴레이·블록 출력 포맷·상한·멱등 규칙을 추가한다.

**Files:**
- Modify: `.claude/skills/tomboy-musicextract/SKILL.md` (경로는 Step 1에서 확인)

**Acceptance Criteria:**
- [ ] 데이터 흐름에 `enumeratePlaylist → /music/enumerate → music-service /enumerate → yt-dlp --flat-playlist` 단계가 문서화된다.
- [ ] 출력 포맷(`[ ]플레이리스트: label` + mp3 불릿, text===href), 상한(`MUSIC_MAX_PLAYLIST` 기본 50), 멱등(블록 있으면 건너뜀), 텍스트줄=재생목록/불릿=단일 규칙이 명시된다.
- [ ] 재배포 필요(브릿지 `/music/enumerate`, music-service `/enumerate`)가 적힌다.

**Verify:** `grep -n "enumerate\|플레이리스트\|MUSIC_MAX_PLAYLIST" .claude/skills/tomboy-musicextract/SKILL.md` → 신규 내용 출력

**Steps:**

- [ ] **Step 1: 스킬 파일 찾기** — `find .claude -iname 'SKILL.md' -path '*musicextract*'` (또는 `*music*`). 정확 경로 확인 후 Read.

- [ ] **Step 2: 재생목록 섹션 추가** — 기존 데이터 흐름/엔드포인트 설명 뒤에, 스킬의 기존 포맷/톤에 맞춰 아래 내용을 산문으로 추가:
  - 흐름: `음악추출::` 노트의 **일반 텍스트 줄**에 재생목록 URL → ⟳ → `enumeratePlaylist({source})` → 브릿지 `POST /music/enumerate` (재-Bearer) → music-service `POST /enumerate` → `yt-dlp -J --flat-playlist --yes-playlist` → `{label, entries:[{url,title}], total, truncated}` (상한 `MUSIC_MAX_PLAYLIST`, 기본 50). 각 `entry.url`은 기존 단일 경로 `extractOne → /music/extract → runner.extract` 로 추출.
  - 출력: 소스 줄 바로 아래에 `writePlaylistBlock` 이 미체크 `inlineCheckbox` + `플레이리스트: <label>` 헤더와 mp3 불릿(맨 URL, **text===href** — `.note` href 보존)을 삽입. `음악::` 노트로 통째 복사 → 체크 시 재생.
  - 규칙: **재생목록=일반 줄, 단일 곡=불릿**. 블록이 이미 있으면(다음 블록이 `플레이리스트:` 헤더) **건너뜀**(스냅샷 1회). 곡별 실패는 성공곡만 블록에 담고 요약 토스트에 표기. 상한 초과 시 앞 50곡만 + 토스트 경고.
  - 배포: 새 라우트라 **브릿지·music-service 재배포 필요**.

- [ ] **Step 3: 확인** — `grep -n "enumerate\|MUSIC_MAX_PLAYLIST\|플레이리스트" .claude/skills/tomboy-musicextract/SKILL.md`

- [ ] **Step 4: 커밋**

```bash
git add .claude/skills/tomboy-musicextract/SKILL.md
git commit -m "docs(skill): tomboy-musicextract playlist enumerate flow"
```

---

### Task 11: 배포 (coordinator/수동 ops)

**Goal:** music-service와 브릿지를 재배포해 `/enumerate`·`/music/enumerate`를 라이브에 올린다. (코드 작성이 아닌 운영 단계 — 서브에이전트가 아니라 coordinator가 사용자와 함께 실행. 절차는 메모리 [[reference_desktop_bridge_network]].)

**Files:** (없음 — 배포 명령)

**Acceptance Criteria:**
- [ ] music-service가 데스크탑 canonical 경로에서 빌드되고 `systemctl --user restart music-service` 후 `:7844`에서 `active (running)`.
- [ ] `main`이 GitHub에 푸시된 뒤(브릿지가 origin에서 pull) 브릿지가 재빌드·재기동되어 `POST /music/enumerate`가 응답한다.
- [ ] 상태 점검: 토큰을 mint 해 `-noop` 등 안전한 가짜 소스로 `/music/enumerate` 호출 → `400 bad_source`/`bad_json` 류로 라우트·인증·릴레이 동작 확인(권리 콘텐츠 미다운로드).

**Verify:** `systemctl --user status music-service` → active; 브릿지 `POST /music/enumerate` 가 (가짜 소스에) 4xx 로 응답(404 아님).

**Steps:**

- [ ] **Step 1: main 푸시 게이트** — 브릿지는 GitHub `origin`에서 pull 하므로 먼저 `main`이 푸시돼 있어야 한다. 푸시는 사용자 권한 — coordinator는 **사용자에게 푸시를 요청/확인**한다(임의 푸시 금지).

- [ ] **Step 2: music-service 재배포 (데스크탑, 이 기기)**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/music-service
git pull --ff-only
npm ci && npm run build
systemctl --user restart music-service
systemctl --user status music-service --no-pager | tail -5
```

- [ ] **Step 3: 브릿지 재배포 (.110, SSH)**

```bash
ssh -p 2222 192.168.219.110 'cd ~/tomboy-web/bridge && git pull --ff-only && podman build -t term-bridge:latest . && systemctl --user restart term-bridge.service; systemctl --user status term-bridge.service --no-pager | tail -5'
```
  - 재기동이 start-job timeout 을 보고해도 컨테이너는 `active (running)`일 수 있음(Quadlet sd_notify 쿼크, 무해 — 메모리 참조). 상태로 확인.

- [ ] **Step 4: 릴레이 상태 점검(안전 소스)** — 브릿지 토큰으로 `/music/enumerate`에 `{"source":"-noop"}` POST → `400` (bad_source/leading_dash 류) 또는 라우트 존재 확인(404가 아니어야 함). music-service 로그에 enumerate 도달 확인.

- [ ] **Step 5: 사용자 수동 검증 위임** — 실제 재생목록 추출은 **권리 보유 콘텐츠로 사용자가 앱 ⟳ 버튼**으로 확인(coordinator는 콘텐츠를 다운로드하지 않음).

---

## Self-Review

**1. Spec coverage:**
- 음악-service enumerate 엔드포인트(spec §1) → Task 1, 2 ✓
- bridge 릴레이(spec §2) → Task 3 ✓
- app extractClient(spec §3) → Task 4 ✓
- parseExtractNote 블록 순회 리팩터(spec §4) → Task 5 ✓
- writePlaylistBlock(spec §5) → Task 6 ✓
- runExtractButtonClick 분기(spec §6) → Task 8 ✓
- 설정 가이드(spec §7) → Task 9 ✓
- 스킬(spec §8) → Task 10 ✓
- 라운드트립 테스트(spec 테스트 §) → Task 7 ✓
- 배포(spec 배포 §) → Task 11 ✓
- 모든 불변식(열거만 신규/text===href/자동 음악노트 없음/토큰 동일/상한 명시) → Task 1·6·7·8·10 에 반영 ✓

**2. Placeholder scan:** 모든 Step에 실제 코드/명령/기대출력 포함. "적절히 처리" 류 없음. ✓

**3. Type consistency:**
- `EnumerateOk{label,entries,total,truncated}` / `PlaylistEntry{url,title}` — runner(T1)·server(T2)·extractClient(T4) 동일 형태 ✓
- `ExtractItem` 유니온 `single`/`playlist` — parseExtractNote(T5)·runExtractButtonClick(T8) 일치, `pendingItems` 유니온 처리 ✓
- `playlistSourceOf`/`isPlaylistHeaderText` — parseExtractNote(T5) export, writePlaylistBlock(T6) import ✓
- `urlChild` — writeExtractResult export(T6), writePlaylistBlock import(T6) ✓
- `writePlaylistBlock(view, {source,label,urls})` — T6 정의, T8 호출 시그니처 일치 ✓
- 헤더 텍스트 `플레이리스트: <label>` + atom → archiver `[ ]플레이리스트: <label>` → `parseMusicNote` slice 호환(T6·T7) ✓

이슈 없음.

## 비고: subagent 모델 선택 가이드

- T1·T2·T3·T4 (격리된 함수, 명확한 스펙, 1–2 파일) → 빠른/저비용 모델.
- T5·T8 (다중 통합·ProseMirror 위치 계산·판별 유니온) → 표준 모델.
- T6·T7 (라운드트립 함정 = `tomboyUrlLink` href 유실 이력) → 표준 모델, 리뷰 주의.
- T9·T10 (문서) → 저비용 모델.
- T11 (운영) → coordinator 직접 + 사용자 푸시 게이트.
