# SUNO 재생목록 가져오기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `음악::` 재생 노트의 `SUNO:<재생목록 URL>` 줄에 우측 `가져오기` 버튼을 달고, 클릭 시 브릿지가 Suno 공개 재생목록을 서버 사이드로 읽어 곡들의 직접 재생 가능한 `audio_url(.mp3)`을 `플레이리스트:` 블록으로 그 자리에 펼쳐 넣는다.

**Architecture:** 항상 켜진 Pi 브릿지에 신규 `POST /music/suno` 라우트를 추가 — Suno 내부 JSON API(1차)와 공개 HTML 임베드 JSON(2차 폴백)을 서버 사이드로 fetch(CORS 우회)해 `{ label, tracks }`를 반환한다. 데스크탑 `music-service`는 미사용. 앱은 `음악::` 노트에서 SUNO: 줄을 파싱(`parseSunoLine`)해 줄별 버튼 데코(`sunoImportPlugin`)를 띄우고, 클릭하면 `sunoClient`로 브릿지를 호출한 뒤 `writeSunoPlaylistBlock`이 패턴 A(제목 + 중첩 URL) `플레이리스트:` 블록을 삽입한다. 재생은 기존 `parseMusicNote`/`MusicPlayerBar`가 그대로 처리.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror 플러그인 + 데코레이션, Node `http` 브릿지(`node --test`), vitest + @testing-library, `.note` 아카이버 라운드트립.

**Spec:** `docs/superpowers/specs/2026-06-09-suno-playlist-import-design.md`

---

## File Structure

**신규**
- `bridge/src/suno.ts` — `fetchSunoPlaylist(url, deps)`: JSON API + HTML 폴백, 주입형 fetch.
- `bridge/src/suno.test.ts` — `node --test`.
- `app/src/lib/music/parseSunoLine.ts` — SUNO: 줄 탐지 + alreadyImported.
- `app/src/lib/music/writeSunoPlaylistBlock.ts` — 패턴 A 블록 삽입.
- `app/src/lib/music/sunoClient.ts` — 브릿지 `/music/suno` 클라이언트 + `SunoError`.
- `app/src/lib/editor/sunoNote/sunoImportPlugin.ts` — 줄별 `가져오기` 위젯 데코.
- `app/src/lib/editor/sunoNote/runSunoImportClick.ts` — 클릭 핸들러.
- `app/src/lib/editor/sunoNote/index.ts` — `TomboySunoImport` 확장.
- `app/tests/unit/music/parseSunoLine.test.ts`, `writeSunoPlaylistBlock.test.ts`, `sunoBlockRoundtrip.test.ts`, `sunoClient.test.ts`, `sunoImportPlugin.test.ts`.

**수정**
- `bridge/src/music.ts` — `handleSunoPlaylist` 추가.
- `bridge/src/server.ts` — `/music/suno` 라우트 + `SUNO_MAX_PLAYLIST` env.
- `app/src/lib/editor/TomboyEditor.svelte` — `TomboySunoImport` 등록 + `.tomboy-suno-import` CSS.
- `app/src/routes/settings/+page.svelte` — 음악 노트 가이드 카드 SUNO 항목 갱신.

---

### Task 1: 브릿지 Suno fetch + parse (`bridge/src/suno.ts`)

**Goal:** Suno 공개 재생목록 URL → `{ label, tracks:[{url,title}], total, truncated }`. JSON API 1차 + HTML 임베드 JSON 2차 폴백, 주입형 fetch 로 단위테스트 가능.

**Files:**
- Create: `bridge/src/suno.ts`
- Test: `bridge/src/suno.test.ts`

**Acceptance Criteria:**
- [ ] `suno.com/playlist/<id>` / `app.suno.ai/playlist/<id>` 에서 id 추출, 비-재생목록 URL 은 `bad_request:no_playlist_id` throw.
- [ ] JSON API 응답(`playlist_clips[].clip.audio_url/title`)을 트랙으로 매핑, `name` → label.
- [ ] JSON 이 비거나 non-OK 면 HTML 폴백으로 `audio_url`+`title` 추출(이스케이프된 따옴표 포함).
- [ ] `maxPlaylist` 초과 시 앞 N곡 + `truncated:true`.
- [ ] audio_url 이 http(s) 가 아닌 클립은 제외.

**Verify:** `cd bridge && npm test` → suno 테스트 통과 (기존 테스트 회귀 없음)

**Steps:**

- [ ] **Step 1: Write `bridge/src/suno.test.ts` (failing)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSunoPlaylist } from './suno.js';

const JSON_PAGE = JSON.stringify({
	name: '내 믹스',
	num_total_results: 2,
	playlist_clips: [
		{ clip: { id: 'c1', title: 'Song One', audio_url: 'https://cdn1.suno.ai/c1.mp3' } },
		{ clip: { id: 'c2', title: 'Song Two', audio_url: 'https://cdn1.suno.ai/c2.mp3' } }
	]
});

function fetchStub(map: Record<string, { ok: boolean; status?: number; body: string }>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		const hit = Object.entries(map).find(([k]) => url.includes(k));
		if (!hit) return new Response('', { status: 404 });
		const { ok, status, body } = hit[1];
		return new Response(body, { status: status ?? (ok ? 200 : 500) });
	}) as typeof fetch;
}

test('JSON API: 클립을 트랙으로 매핑하고 label/total 채움', async () => {
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-abc123', {
		fetch: fetchStub({ '/api/playlist/PL-abc123/?page=1': { ok: true, body: JSON_PAGE }, '?page=2': { ok: true, body: JSON.stringify({ playlist_clips: [] }) } })
	});
	assert.equal(res.label, '내 믹스');
	assert.deepEqual(res.tracks, [
		{ url: 'https://cdn1.suno.ai/c1.mp3', title: 'Song One' },
		{ url: 'https://cdn1.suno.ai/c2.mp3', title: 'Song Two' }
	]);
	assert.equal(res.truncated, false);
});

test('비-재생목록 URL → bad_request', async () => {
	await assert.rejects(
		() => fetchSunoPlaylist('https://suno.com/song/xyz', { fetch: fetchStub({}) }),
		/bad_request/
	);
});

test('JSON non-OK → HTML 폴백(이스케이프 따옴표 포함)에서 추출', async () => {
	const html = `<script>self.__next_f.push([1,"{\\"title\\":\\"H Song\\",\\"audio_url\\":\\"https://cdn1.suno.ai/h1.mp3\\"}"])</script>`;
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-html', {
		fetch: fetchStub({ '/api/playlist/PL-html/?page=1': { ok: false, status: 401, body: '{}' }, 'suno.com/playlist/PL-html': { ok: true, body: html } })
	});
	assert.equal(res.tracks.length, 1);
	assert.equal(res.tracks[0].url, 'https://cdn1.suno.ai/h1.mp3');
	assert.equal(res.tracks[0].title, 'H Song');
});

test('maxPlaylist 초과 시 잘림', async () => {
	const res = await fetchSunoPlaylist('https://suno.com/playlist/PL-abc123', {
		maxPlaylist: 1,
		fetch: fetchStub({ '/api/playlist/PL-abc123/?page=1': { ok: true, body: JSON_PAGE } })
	});
	assert.equal(res.tracks.length, 1);
	assert.equal(res.truncated, true);
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd bridge && node --test --experimental-strip-types src/suno.test.ts` (또는 `npm test`)
Expected: FAIL — `Cannot find module './suno.js'`

- [ ] **Step 3: Write `bridge/src/suno.ts`**

```ts
export interface SunoTrack { url: string; title: string; }
export interface SunoResult { label: string; tracks: SunoTrack[]; total: number; truncated: boolean; }
export interface SunoDeps { fetch?: typeof fetch; maxPlaylist?: number; userAgent?: string; pageCap?: number; }

const API_BASE = 'https://studio-api.prod.suno.com';
const DEFAULT_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTTP_RE = /^https?:\/\//i;

/** suno.com/playlist/<id> 또는 app.suno.ai/playlist/<id> 에서 id 추출. */
export function extractPlaylistId(playlistUrl: string): string | null {
	let u: URL;
	try { u = new URL(playlistUrl); } catch { return null; }
	if (!/(^|\.)suno\.(com|ai)$/i.test(u.hostname)) return null;
	const m = u.pathname.match(/\/playlist\/([A-Za-z0-9-]{6,})/);
	return m ? m[1] : null;
}

function clipToTrack(raw: unknown): SunoTrack | null {
	if (!raw || typeof raw !== 'object') return null;
	const clip = (raw as { clip?: unknown }).clip ?? raw;
	if (!clip || typeof clip !== 'object') return null;
	const c = clip as { audio_url?: unknown; title?: unknown };
	const url = typeof c.audio_url === 'string' ? c.audio_url : '';
	if (!HTTP_RE.test(url)) return null;
	const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : url;
	return { url, title };
}

async function fetchViaJson(id: string, doFetch: typeof fetch, ua: string, pageCap: number): Promise<{ label: string; tracks: SunoTrack[]; total: number } | null> {
	const tracks: SunoTrack[] = [];
	const seen = new Set<string>();
	let label = '재생목록';
	let total = 0;
	for (let page = 1; page <= pageCap; page++) {
		let res: Response;
		try {
			res = await doFetch(`${API_BASE}/api/playlist/${id}/?page=${page}`, {
				headers: { 'User-Agent': ua, Accept: 'application/json' }
			});
		} catch { return tracks.length ? { label, tracks, total: total || tracks.length } : null; }
		if (!res.ok) return tracks.length ? { label, tracks, total: total || tracks.length } : null;
		let json: { name?: unknown; num_total_results?: unknown; playlist_clips?: unknown };
		try { json = (await res.json()) as typeof json; } catch { break; }
		if (page === 1) {
			if (typeof json.name === 'string' && json.name.trim()) label = json.name.trim();
			if (typeof json.num_total_results === 'number') total = json.num_total_results;
		}
		const clips = Array.isArray(json.playlist_clips) ? json.playlist_clips : [];
		if (clips.length === 0) break;
		for (const pc of clips) {
			const t = clipToTrack(pc);
			if (t && !seen.has(t.url)) { seen.add(t.url); tracks.push(t); }
		}
	}
	return tracks.length ? { label, tracks, total: total || tracks.length } : null;
}

/** RSC/__NEXT_DATA__ HTML 에서 audio_url+title 쌍 추출. 이스케이프된 따옴표(\")를 먼저 펴서 평탄화. */
export function parseClipsFromHtml(html: string): SunoTrack[] {
	const flat = html.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"');
	const tracks: SunoTrack[] = [];
	const seen = new Set<string>();
	const re = /"audio_url"\s*:\s*"(https?:\/\/[^"]+?\.mp3[^"]*)"/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(flat)) !== null) {
		const url = m[1];
		if (seen.has(url)) continue;
		seen.add(url);
		// 같은 클립 객체 안의 title — audio_url 앞쪽 가까운 범위에서 마지막 title 채택.
		const windowStr = flat.slice(Math.max(0, m.index - 600), m.index);
		const tm = /"title"\s*:\s*"([^"]*)"/g;
		let title = '';
		let t: RegExpExecArray | null;
		while ((t = tm.exec(windowStr)) !== null) title = t[1];
		tracks.push({ url, title: title.trim() || url });
	}
	return tracks;
}

async function fetchViaHtml(id: string, doFetch: typeof fetch, ua: string): Promise<{ label: string; tracks: SunoTrack[]; total: number } | null> {
	let res: Response;
	try { res = await doFetch(`https://suno.com/playlist/${id}`, { headers: { 'User-Agent': ua } }); }
	catch { return null; }
	if (!res.ok) return null;
	const html = await res.text();
	const tracks = parseClipsFromHtml(html);
	if (tracks.length === 0) return null;
	const nameMatch = html.replace(/\\"/g, '"').match(/"playlist"[^{]*\{[^}]*"name"\s*:\s*"([^"]+)"/) ?? html.match(/<title>([^<]+)<\/title>/i);
	const label = nameMatch?.[1]?.trim() || '재생목록';
	return { label, tracks, total: tracks.length };
}

export async function fetchSunoPlaylist(playlistUrl: string, deps: SunoDeps = {}): Promise<SunoResult> {
	const id = extractPlaylistId(playlistUrl);
	if (!id) throw new Error('bad_request:no_playlist_id');
	const doFetch = deps.fetch ?? globalThis.fetch;
	const ua = deps.userAgent ?? DEFAULT_UA;
	const max = deps.maxPlaylist ?? 100;
	const pageCap = deps.pageCap ?? 20;

	let got = await fetchViaJson(id, doFetch, ua, pageCap);
	if (!got) got = await fetchViaHtml(id, doFetch, ua);
	if (!got) return { label: '재생목록', tracks: [], total: 0, truncated: false };

	const total = Math.max(got.total, got.tracks.length);
	const tracks = got.tracks.slice(0, max);
	return { label: got.label, tracks, total, truncated: total > tracks.length };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd bridge && npm test`
Expected: PASS (4 suno tests) + 기존 브릿지 테스트 회귀 없음

- [ ] **Step 5: Commit**

```bash
git add bridge/src/suno.ts bridge/src/suno.test.ts
git commit -m "feat(bridge): Suno playlist fetch+parse (JSON API + HTML fallback)"
```

---

### Task 2: 브릿지 `/music/suno` 라우트 + 핸들러

**Goal:** `POST /music/suno` (Bearer) → body `{ url }` 검증 후 `fetchSunoPlaylist` 호출, `{ label, tracks, total, truncated }` 200 응답. 데스크탑 서비스 미경유.

**Files:**
- Modify: `bridge/src/music.ts` (`handleSunoPlaylist` 추가)
- Modify: `bridge/src/server.ts` (라우트 + `SUNO_MAX_PLAYLIST`)
- Test: `bridge/src/music.test.ts` (suno 케이스 추가)

**Acceptance Criteria:**
- [ ] Bearer 없으면 401, body `url` 없으면 400(업스트림 미호출).
- [ ] 정상 url → `fetchSunoPlaylist` 결과를 200 JSON 으로 응답.
- [ ] `fetchSunoPlaylist` 가 `bad_request*` throw → 400, 그 외 throw → 502 `upstream_error`.

**Verify:** `cd bridge && npm test` → music 테스트 통과

**Steps:**

- [ ] **Step 1: Add tests to `bridge/src/music.test.ts` (failing)**

기존 파일 상단 import 에 추가:
```ts
import { handleMusicExtract, handleMusicEnumerate, handleSunoPlaylist } from './music.js';
```

파일 끝에 추가:
```ts
test('suno: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({}, { url: 'https://suno.com/playlist/x' }), res, SECRET);
	assert.equal(get().status, 401);
});

test('suno: 400 on missing url (no fetch)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('suno: 200 returns tracks from fetchSunoPlaylist', async () => {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const u = String(input);
		if (u.includes('/api/playlist/PL-ok/?page=1'))
			return new Response(JSON.stringify({ name: 'M', num_total_results: 1, playlist_clips: [{ clip: { audio_url: 'https://cdn1.suno.ai/a.mp3', title: 'A' } }] }), { status: 200 });
		return new Response(JSON.stringify({ playlist_clips: [] }), { status: 200 });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { url: 'https://suno.com/playlist/PL-ok' }), res, SECRET);
	assert.equal(get().status, 200);
	const body = JSON.parse(get().body);
	assert.equal(body.label, 'M');
	assert.deepEqual(body.tracks, [{ url: 'https://cdn1.suno.ai/a.mp3', title: 'A' }]);
});

test('suno: 400 on bad playlist url', async () => {
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { url: 'https://suno.com/song/x' }), res, SECRET);
	assert.equal(get().status, 400);
});
```

- [ ] **Step 2: Run — expect FAIL (`handleSunoPlaylist` not exported)**

Run: `cd bridge && npm test`
Expected: FAIL — `handleSunoPlaylist is not a function` / import error

- [ ] **Step 3: Add `handleSunoPlaylist` to `bridge/src/music.ts`**

파일 상단 import 에 추가:
```ts
import { fetchSunoPlaylist } from './suno.js';
```

`MusicBody` 인터페이스 아래에 추가:
```ts
interface SunoBody { url?: unknown; }

/** POST /music/suno → 브릿지가 직접 Suno 공개 재생목록을 읽어 트랙 목록 반환(데스크탑 미경유). */
export async function handleSunoPlaylist(req: IncomingMessage, res: ServerResponse, secret: string, maxPlaylist = 100): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	let body: SunoBody;
	try {
		body = (await readJson(req)) as SunoBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const url = typeof body.url === 'string' ? body.url.trim() : '';
	if (!url) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_url' }));
		return;
	}
	try {
		const result = await fetchSunoPlaylist(url, { maxPlaylist });
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.startsWith('bad_request')) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'bad_request' }));
			return;
		}
		console.warn(`[term-bridge suno] error: ${msg}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
	}
}
```

- [ ] **Step 4: Wire route in `bridge/src/server.ts`**

상단 import 수정(line 20 부근):
```ts
import { handleMusicExtract, handleMusicEnumerate, handleSunoPlaylist } from './music.js';
```

`MUSIC_SERVICE_URL` env 상수 정의 부근에 추가:
```ts
const SUNO_MAX_PLAYLIST = Number(process.env.SUNO_MAX_PLAYLIST) || 100;
```

`/music/enumerate` 라우트(line 170-173) 바로 아래에 추가:
```ts
	if (url === '/music/suno' && req.method === 'POST') {
		await handleSunoPlaylist(req, res, SECRET, SUNO_MAX_PLAYLIST);
		return;
	}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd bridge && npm test`
Expected: PASS (suno + music 기존 케이스). `cd bridge && npx tsc --noEmit` 타입 통과.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/music.ts bridge/src/server.ts bridge/src/music.test.ts
git commit -m "feat(bridge): POST /music/suno route + handler"
```

---

### Task 3: `parseSunoLine.ts` — SUNO: 줄 탐지

**Goal:** `음악::` 노트 doc 에서 `SUNO:<url>` 단락을 찾아 `{ url, paraPos, alreadyImported }` 반환. 바로 다음 블록이 `플레이리스트:` 헤더면 alreadyImported.

**Files:**
- Create: `app/src/lib/music/parseSunoLine.ts`
- Test: `app/tests/unit/music/parseSunoLine.test.ts`

**Acceptance Criteria:**
- [ ] `SUNO:https://suno.com/playlist/x` 단락의 url 추출(대소문자·선행 공백 허용).
- [ ] 다음 블록이 `플레이리스트:`(또는 `[ ]/[x]플레이리스트:`) 헤더면 `alreadyImported=true`.
- [ ] `음악::` 로 시작하지 않는 노트는 빈 배열.
- [ ] `matchSunoLine(node)` 가 단일 단락 매칭에 재사용 가능.

**Verify:** `cd app && npx vitest run tests/unit/music/parseSunoLine.test.ts`

**Steps:**

- [ ] **Step 1: Write `app/tests/unit/music/parseSunoLine.test.ts` (failing)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { parseSunoLines } from '$lib/music/parseSunoLine.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });
const make = (html: string) => (ed = new Editor({ extensions: [StarterKit, InlineCheckbox], content: html }));

const SUNO = 'https://suno.com/playlist/PL-abc123';

describe('parseSunoLines', () => {
	it('미가져온 SUNO: 줄 탐지', () => {
		make(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p>`);
		const lines = parseSunoLines(ed!.state.doc);
		expect(lines.length).toBe(1);
		expect(lines[0].url).toBe(SUNO);
		expect(lines[0].alreadyImported).toBe(false);
	});

	it('다음 블록이 플레이리스트 헤더면 alreadyImported', () => {
		make(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p><p>플레이리스트: 내 믹스</p><ul><li><p>t</p></li></ul>`);
		const lines = parseSunoLines(ed!.state.doc);
		expect(lines[0].alreadyImported).toBe(true);
	});

	it('음악:: 아닌 노트는 빈 배열', () => {
		make(`<p>그냥 노트</p><p>SUNO:${SUNO}</p>`);
		expect(parseSunoLines(ed!.state.doc)).toEqual([]);
	});

	it('대소문자·선행 공백 허용', () => {
		make(`<p>음악::x</p><p>suno:  ${SUNO}</p>`);
		expect(parseSunoLines(ed!.state.doc)[0].url).toBe(SUNO);
	});
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd app && npx vitest run tests/unit/music/parseSunoLine.test.ts`
Expected: FAIL — cannot resolve `$lib/music/parseSunoLine.js`

- [ ] **Step 3: Write `app/src/lib/music/parseSunoLine.ts`**

```ts
import type { Node as PMNode } from '@tiptap/pm/model';

const TITLE_PREFIX = '음악::';
const SUNO_RE = /^SUNO:\s*(https?:\/\/\S+)/i;
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

export interface SunoLine {
	url: string;
	paraPos: number; // 단락 시작 pos
	alreadyImported: boolean;
}

/** 단락 텍스트가 SUNO:<url> 형식이면 url 반환, 아니면 null. */
export function matchSunoLine(node: PMNode): string | null {
	if (node.type.name !== 'paragraph') return null;
	const m = SUNO_RE.exec(node.textContent.trim());
	return m ? m[1] : null;
}

function isPlaylistHeader(node: PMNode | undefined): boolean {
	return !!node && node.type.name === 'paragraph' && PLAYLIST_HEADER_RE.test(node.textContent.trim());
}

/** 음악:: 노트의 모든 SUNO: 줄. 바로 다음 블록이 플레이리스트 헤더면 alreadyImported. */
export function parseSunoLines(doc: PMNode): SunoLine[] {
	const title = doc.firstChild?.textContent.trim() ?? '';
	if (!title.startsWith(TITLE_PREFIX)) return [];
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	const lines: SunoLine[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const url = matchSunoLine(blocks[i].node);
		if (!url) continue;
		lines.push({ url, paraPos: blocks[i].offset, alreadyImported: isPlaylistHeader(blocks[i + 1]?.node) });
	}
	return lines;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd app && npx vitest run tests/unit/music/parseSunoLine.test.ts`
Expected: PASS (4)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/parseSunoLine.ts app/tests/unit/music/parseSunoLine.test.ts
git commit -m "feat(music): parseSunoLines — detect SUNO: lines in 음악:: notes"
```

---

### Task 4: `writeSunoPlaylistBlock.ts` — 패턴 A 블록 삽입

**Goal:** SUNO: 줄(url 로 라이브 재탐색) 바로 아래에 `[x]플레이리스트:` 헤더 + 패턴 A(제목 단락 + 중첩 URL) 트랙 리스트를 삽입. 이미 결과 헤더가 있으면 미삽입.

**Files:**
- Create: `app/src/lib/music/writeSunoPlaylistBlock.ts`
- Test: `app/tests/unit/music/writeSunoPlaylistBlock.test.ts`, `app/tests/unit/music/sunoBlockRoundtrip.test.ts`

**Acceptance Criteria:**
- [ ] 삽입 헤더는 `inlineCheckbox(checked:true)` + `플레이리스트: <label>`.
- [ ] 각 트랙 = `listItem(p(제목), bulletList(li(p(urlChild(audio_url)))))` (패턴 A).
- [ ] 삽입 직후 `parseMusicNote` 가 `display=제목`, `url=audio_url` 으로 트랙 복원.
- [ ] `.note` 직렬화→역직렬화 라운드트립 후에도 audio_url href 보존(메모리 `tomboyUrlLink round-trip href loss`).
- [ ] 빈 tracks / 파괴된 view / 이미 헤더 있는 줄 → false (no-op).

**Verify:** `cd app && npx vitest run tests/unit/music/writeSunoPlaylistBlock.test.ts tests/unit/music/sunoBlockRoundtrip.test.ts`

**Steps:**

- [ ] **Step 1: Write `app/tests/unit/music/writeSunoPlaylistBlock.test.ts` (failing)**

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const SUNO = 'https://suno.com/playlist/PL-abc123';
const A1 = 'https://cdn1.suno.ai/c1.mp3';
const A2 = 'https://cdn1.suno.ai/c2.mp3';
const full = (html: string) => new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: html });

describe('writeSunoPlaylistBlock', () => {
	it('SUNO: 줄 아래 패턴A 블록 삽입 → parseMusicNote 가 제목/URL 복원', () => {
		const ed = full(`<p>음악::내 음악</p><p>SUNO:${SUNO}</p>`);
		const wrote = writeSunoPlaylistBlock(ed.view, SUNO, { label: '내 믹스', tracks: [{ url: A1, title: 'Song One' }, { url: A2, title: 'Song Two' }] });
		expect(wrote).toBe(true);
		const music = parseMusicNote(ed.state.doc);
		expect(music.playlists[0].label).toBe('내 믹스');
		expect(music.flatQueue.map((t) => t.url)).toEqual([A1, A2]);
		expect(music.flatQueue.map((t) => t.display)).toEqual(['Song One', 'Song Two']);
		ed.destroy();
	});

	it('이미 헤더 있는 줄 → false', () => {
		const ed = full(`<p>음악::x</p><p>SUNO:${SUNO}</p><p>플레이리스트: 기존</p><ul><li><p>t</p></li></ul>`);
		expect(writeSunoPlaylistBlock(ed.view, SUNO, { label: 'L', tracks: [{ url: A1, title: 'X' }] })).toBe(false);
		ed.destroy();
	});

	it('빈 tracks / 파괴된 view → false', () => {
		const ed = full(`<p>음악::x</p><p>SUNO:${SUNO}</p>`);
		expect(writeSunoPlaylistBlock(ed.view, SUNO, { label: 'L', tracks: [] })).toBe(false);
		const view = ed.view; ed.destroy();
		expect(writeSunoPlaylistBlock(view, SUNO, { label: 'L', tracks: [{ url: A1, title: 'X' }] })).toBe(false);
	});
});
```

- [ ] **Step 2: Write `app/tests/unit/music/sunoBlockRoundtrip.test.ts` (failing)**

```ts
import { describe, it, expect } from 'vitest';
import { serializeContent, deserializeContent } from '$lib/core/noteContentArchiver.js';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

const SUNO = 'https://suno.com/playlist/PL-abc123';
const A1 = 'https://cdn1.suno.ai/c1.mp3';

describe('Suno 블록 .note 라운드트립', () => {
	it('직렬화→역직렬화 후 audio_url href 와 제목 보존', () => {
		const ed = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: `<p>음악::x</p><p>SUNO:${SUNO}</p>` });
		writeSunoPlaylistBlock(ed.view, SUNO, { label: '내 믹스', tracks: [{ url: A1, title: 'Song One' }] });
		const json = ed.getJSON();
		ed.destroy();

		const restored = deserializeContent(serializeContent(json));
		const ed2 = new Editor({ extensions: [StarterKit, TomboyUrlLink, InlineCheckbox], content: restored });
		const music = parseMusicNote(ed2.state.doc);
		expect(music.flatQueue.map((t) => t.url)).toEqual([A1]);
		expect(music.flatQueue[0].display).toBe('Song One');
		ed2.destroy();
	});
});
```

- [ ] **Step 3: Run — expect FAIL (module missing)**

Run: `cd app && npx vitest run tests/unit/music/writeSunoPlaylistBlock.test.ts`
Expected: FAIL — cannot resolve `$lib/music/writeSunoPlaylistBlock.js`

- [ ] **Step 4: Write `app/src/lib/music/writeSunoPlaylistBlock.ts`**

```ts
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { urlChild } from '$lib/musicExtract/writeExtractResult.js';
import { matchSunoLine } from '$lib/music/parseSunoLine.js';

const PLAYLIST_HEADER_PREFIX = '플레이리스트:';
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

export interface SunoBlockInput {
	label: string;
	tracks: { url: string; title: string }[];
}

/** url 과 일치하는 미가져온 SUNO: 단락 뒤 삽입 위치를 라이브 재탐색. */
function findInsertPos(doc: PMNode, sunoUrl: string): number | null {
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	for (let i = 0; i < blocks.length; i++) {
		const { node, offset } = blocks[i];
		if (matchSunoLine(node) !== sunoUrl) continue;
		const next = blocks[i + 1]?.node;
		if (next && next.type.name === 'paragraph' && PLAYLIST_HEADER_RE.test(next.textContent.trim())) continue; // 이미 결과
		return offset + node.nodeSize;
	}
	return null;
}

/** SUNO: 줄 아래에 음악:: 호환 패턴A 플레이리스트 블록([x]헤더 + 제목/URL 트랙)을 삽입. 작성 시 true. */
export function writeSunoPlaylistBlock(view: EditorView, sunoUrl: string, input: SunoBlockInput): boolean {
	if (view.isDestroyed || input.tracks.length === 0) return false;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return false;

	const pos = findInsertPos(doc, sunoUrl);
	if (pos == null) return false;

	const cb = schema.nodes.inlineCheckbox;
	const header = cb
		? paragraph.create(null, [cb.create({ checked: true }), schema.text(`${PLAYLIST_HEADER_PREFIX} ${input.label}`)])
		: paragraph.create(null, schema.text(`[x]${PLAYLIST_HEADER_PREFIX} ${input.label}`));

	// 패턴 A: <li><p>제목</p><ul><li><p>urlChild(audio_url)</p></li></ul></li>
	const list = bulletList.create(
		null,
		input.tracks.map((tk) =>
			listItem.create(null, [
				paragraph.create(null, schema.text(tk.title)),
				bulletList.create(null, listItem.create(null, paragraph.create(null, urlChild(schema, tk.url))))
			])
		)
	);

	view.dispatch(state.tr.insert(pos, [header, list]));
	return true;
}
```

- [ ] **Step 5: Run — expect PASS (both test files)**

Run: `cd app && npx vitest run tests/unit/music/writeSunoPlaylistBlock.test.ts tests/unit/music/sunoBlockRoundtrip.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/music/writeSunoPlaylistBlock.ts app/tests/unit/music/writeSunoPlaylistBlock.test.ts app/tests/unit/music/sunoBlockRoundtrip.test.ts
git commit -m "feat(music): writeSunoPlaylistBlock — pattern-A block with title+url, round-trip safe"
```

---

### Task 5: `sunoClient.ts` — 브릿지 `/music/suno` 클라이언트

**Goal:** `fetchSunoPlaylist({url})` 가 터미널 브릿지 설정으로 `POST /music/suno` 호출, `SunoError`(한국어 토스트용 kind) throw, 빈 tracks 는 `empty`.

**Files:**
- Create: `app/src/lib/music/sunoClient.ts`
- Test: `app/tests/unit/music/sunoClient.test.ts`

**Acceptance Criteria:**
- [ ] 브릿지/토큰 미설정 → `SunoError('not_configured')`.
- [ ] 401 → `unauthorized`, 503 → `service_unavailable`, 기타 4xx → `bad_request`, 5xx → `upstream_error`, fetch throw → `network`.
- [ ] 200 + tracks 비어있음 → `SunoError('empty')`.
- [ ] 정상 → `{ label, tracks, total, truncated }` (불량 항목 필터).

**Verify:** `cd app && npx vitest run tests/unit/music/sunoClient.test.ts`

**Steps:**

- [ ] **Step 1: Write `app/tests/unit/music/sunoClient.test.ts` (failing)**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as bridgeSettings from '$lib/editor/terminal/bridgeSettings.js';
import { fetchSunoPlaylist, SunoError } from '$lib/music/sunoClient.js';

const A1 = 'https://cdn1.suno.ai/c1.mp3';

beforeEach(() => {
	vi.spyOn(bridgeSettings, 'getDefaultTerminalBridge').mockResolvedValue('wss://bridge.example/ws');
	vi.spyOn(bridgeSettings, 'getTerminalBridgeToken').mockResolvedValue('tok');
	vi.spyOn(bridgeSettings, 'bridgeToHttpBase').mockReturnValue('https://bridge.example');
});
afterEach(() => vi.restoreAllMocks());

describe('fetchSunoPlaylist (client)', () => {
	it('정상 응답 매핑', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ label: 'M', tracks: [{ url: A1, title: 'A' }], total: 1, truncated: false }), { status: 200 }));
		const r = await fetchSunoPlaylist({ url: 'https://suno.com/playlist/x' });
		expect(r.label).toBe('M');
		expect(r.tracks).toEqual([{ url: A1, title: 'A' }]);
	});

	it('빈 tracks → empty', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ label: 'M', tracks: [] }), { status: 200 }));
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'empty' });
	});

	it('401 → unauthorized', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('브릿지 미설정 → not_configured', async () => {
		vi.spyOn(bridgeSettings, 'getDefaultTerminalBridge').mockResolvedValue('');
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	});
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd app && npx vitest run tests/unit/music/sunoClient.test.ts`
Expected: FAIL — cannot resolve `$lib/music/sunoClient.js`

- [ ] **Step 3: Write `app/src/lib/music/sunoClient.ts`**

```ts
import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type SunoErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'service_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network'
	| 'empty';

export class SunoError extends Error {
	constructor(public kind: SunoErrorKind, public detail?: string) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}

export interface SunoTrack { url: string; title: string; }
export interface SunoPlaylist {
	label: string;
	tracks: SunoTrack[];
	total: number;
	truncated: boolean;
}

const STATUS_TO_KIND: Record<number, SunoErrorKind> = { 401: 'unauthorized', 503: 'service_unavailable' };

export async function fetchSunoPlaylist(opts: { url: string; signal?: AbortSignal }): Promise<SunoPlaylist> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new SunoError('not_configured', '브릿지 설정이 필요합니다');
	const endpoint = `${bridgeToHttpBase(bridge)}/music/suno`;

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: opts.url }),
			signal: opts.signal
		});
	} catch (err) {
		throw new SunoError('network', (err as Error).message);
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
		throw new SunoError(kind, bodyErr || undefined);
	}

	const data = (await res.json()) as Partial<SunoPlaylist>;
	const tracks = Array.isArray(data.tracks)
		? data.tracks.filter((t): t is SunoTrack => !!t && typeof t.url === 'string' && t.url.length > 0 && typeof t.title === 'string')
		: [];
	if (tracks.length === 0) throw new SunoError('empty', 'empty_playlist');
	return {
		label: typeof data.label === 'string' && data.label ? data.label : '재생목록',
		tracks,
		total: typeof data.total === 'number' ? data.total : tracks.length,
		truncated: data.truncated === true
	};
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd app && npx vitest run tests/unit/music/sunoClient.test.ts`
Expected: PASS (4)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/sunoClient.ts app/tests/unit/music/sunoClient.test.ts
git commit -m "feat(music): sunoClient — bridge /music/suno call + SunoError kinds"
```

---

### Task 6: `sunoNote` 플러그인 + 클릭 핸들러 + 에디터 등록 + CSS

**Goal:** `음악::` 노트의 미가져온 SUNO: 줄 우측에 `가져오기` 위젯 버튼 표시, 클릭 시 `fetchSunoPlaylist` → `writeSunoPlaylistBlock` + 토스트. `TomboySunoImport` 확장을 에디터에 등록.

**Files:**
- Create: `app/src/lib/editor/sunoNote/sunoImportPlugin.ts`, `runSunoImportClick.ts`, `index.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (등록 + CSS)
- Test: `app/tests/unit/music/sunoImportPlugin.test.ts`

**Acceptance Criteria:**
- [ ] 미가져온 SUNO: 줄마다 `.tomboy-suno-import` 위젯 1개(side:1), 이미 가져온 줄/비-음악 노트엔 0개.
- [ ] `runSunoImportClick` 가 성공 시 `writeSunoPlaylistBlock` 호출, 에러 kind 별 한국어 토스트.
- [ ] `TomboySunoImport` 가 `TomboyMusicExtractNote` 옆에 등록됨.
- [ ] 버튼은 pointerdown/mousedown 을 삼켜 모바일 캐럿/키보드 진입 방지.

**Verify:** `cd app && npx vitest run tests/unit/music/sunoImportPlugin.test.ts && cd app && npm run check`

**Steps:**

- [ ] **Step 1: Write `app/tests/unit/music/sunoImportPlugin.test.ts` (failing)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/index.js';
import { TomboySunoImport } from '$lib/editor/sunoNote/index.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });
const make = (html: string) => (ed = new Editor({ extensions: [StarterKit, InlineCheckbox, TomboySunoImport], content: html }));
const btnCount = () => ed!.view.dom.querySelectorAll('.tomboy-suno-import').length;
const SUNO = 'https://suno.com/playlist/PL-abc123';

describe('sunoImportPlugin', () => {
	it('미가져온 SUNO: 줄에 가져오기 버튼 1개', () => {
		make(`<p>음악::x</p><p>SUNO:${SUNO}</p>`);
		expect(btnCount()).toBe(1);
	});
	it('이미 가져온 줄엔 버튼 없음', () => {
		make(`<p>음악::x</p><p>SUNO:${SUNO}</p><p>플레이리스트: m</p><ul><li><p>t</p></li></ul>`);
		expect(btnCount()).toBe(0);
	});
	it('음악:: 아닌 노트엔 버튼 없음', () => {
		make(`<p>딴 노트</p><p>SUNO:${SUNO}</p>`);
		expect(btnCount()).toBe(0);
	});
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd app && npx vitest run tests/unit/music/sunoImportPlugin.test.ts`
Expected: FAIL — cannot resolve `$lib/editor/sunoNote/index.js`

- [ ] **Step 3: Write `app/src/lib/editor/sunoNote/runSunoImportClick.ts`**

```ts
import type { EditorView } from '@tiptap/pm/view';
import { fetchSunoPlaylist, SunoError, type SunoErrorKind } from '$lib/music/sunoClient.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<SunoErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	unauthorized: '브릿지 인증이 필요합니다',
	service_unavailable: 'Suno 가져오기 서비스에 연결할 수 없습니다',
	network: 'Suno 가져오기 서비스에 연결할 수 없습니다',
	bad_request: '잘못된 Suno 재생목록 URL',
	upstream_error: 'Suno 재생목록을 읽을 수 없습니다',
	empty: '재생목록을 읽을 수 없습니다'
};

/** 한 SUNO: 줄 처리: 브릿지로 열거 → 패턴A 블록 삽입 → 토스트. */
export async function runSunoImportClick(view: EditorView, sunoUrl: string): Promise<void> {
	let result;
	try {
		result = await fetchSunoPlaylist({ url: sunoUrl });
	} catch (err) {
		const kind = err instanceof SunoError ? err.kind : 'network';
		if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? 'Suno 가져오기 실패', { kind: 'error' });
		return;
	}
	if (view.isDestroyed) return;
	const wrote = writeSunoPlaylistBlock(view, sunoUrl, { label: result.label, tracks: result.tracks });
	if (!wrote) {
		pushToast('가져오기 결과를 추가할 수 없습니다', { kind: 'error' });
		return;
	}
	const parts = [`${result.tracks.length}곡 가져옴`];
	if (result.truncated) parts.push('상한 초과 일부만');
	pushToast(parts.join(', '), { kind: 'info' });
}
```

- [ ] **Step 4: Write `app/src/lib/editor/sunoNote/sunoImportPlugin.ts`**

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseSunoLines } from '$lib/music/parseSunoLine.js';
import { runSunoImportClick } from './runSunoImportClick.js';

export const sunoImportPluginKey = new PluginKey<DecorationSet>('tomboySunoImport');

function renderButton(view: EditorView, sunoUrl: string): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-suno-import';
	btn.contentEditable = 'false';
	btn.textContent = '가져오기';
	// pointerdown/mousedown 을 삼켜 모바일에서 탭이 contenteditable 로 새어 캐럿/키보드가 뜨는 걸 막는다.
	const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
	btn.addEventListener('pointerdown', swallow);
	btn.addEventListener('mousedown', swallow);
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (btn.disabled) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '가져오는 중…';
		try {
			await runSunoImportClick(view, sunoUrl);
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
	return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const lines = parseSunoLines(doc).filter((l) => !l.alreadyImported);
	if (lines.length === 0) return DecorationSet.empty;
	const decos = lines.map((l) => {
		const node = doc.nodeAt(l.paraPos);
		const end = l.paraPos + (node?.nodeSize ?? 2) - 1; // 단락 textblock 내부 끝
		return Decoration.widget(end, (view) => renderButton(view, l.url), { side: 1, key: `suno-import:${l.url}` });
	});
	return DecorationSet.create(doc, decos);
}

export function createSunoImportPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: sunoImportPluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc);
			},
			apply(tr, old): DecorationSet {
				return tr.docChanged ? buildDecorations(tr.doc) : old.map(tr.mapping, tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return sunoImportPluginKey.getState(state);
			}
		}
	});
}
```

- [ ] **Step 5: Write `app/src/lib/editor/sunoNote/index.ts`**

```ts
import { Extension } from '@tiptap/core';
import { createSunoImportPlugin } from './sunoImportPlugin.js';

export const TomboySunoImport = Extension.create({
	name: 'tomboySunoImport',
	addProseMirrorPlugins() {
		return [createSunoImportPlugin()];
	}
});
export { createSunoImportPlugin, sunoImportPluginKey } from './sunoImportPlugin.js';
```

- [ ] **Step 6: Register in `app/src/lib/editor/TomboyEditor.svelte`**

import 블록(line 43 `TomboyMusicExtractNote` 아래)에 추가:
```ts
import { TomboySunoImport } from "./sunoNote/index.js";
```

extensions 배열(line 502 `TomboyMusicExtractNote,` 아래)에 추가:
```ts
				TomboySunoImport,
```

- [ ] **Step 7: Add CSS in `app/src/lib/editor/TomboyEditor.svelte`**

`.tomboy-music-extract-run:disabled` 블록(line 2160-2163) 바로 아래에 추가:
```css
	.tomboy-editor :global(.tomboy-suno-import) {
		display: inline-flex;
		align-items: center;
		gap: 0.3em;
		margin-left: 0.5em;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		vertical-align: middle;
		border: 1px solid var(--border, #ddd);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--accent, #a05);
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-suno-import:disabled) {
		opacity: 0.6;
		cursor: default;
	}
```

- [ ] **Step 8: Run — expect PASS + type check**

Run: `cd app && npx vitest run tests/unit/music/sunoImportPlugin.test.ts`
Expected: PASS (3)
Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/editor/sunoNote/ app/src/lib/editor/TomboyEditor.svelte app/tests/unit/music/sunoImportPlugin.test.ts
git commit -m "feat(editor): SUNO: import button plugin in 음악:: notes"
```

---

### Task 7: 설정 가이드 카드 갱신

**Goal:** 설정 → 가이드 → 노트의 "음악 노트" 카드에서 "SUNO 플레이리스트 자동 채움은 향후 추가 예정" 문구를 실제 사용법으로 교체. (CLAUDE.md 가이드 문서화 불변식 충족.)

**Files:**
- Modify: `app/src/routes/settings/+page.svelte:1806-1807`

**Acceptance Criteria:**
- [ ] `SUNO:<url>` + 우측 `가져오기` 버튼 사용법, 직접 링크(다운로드 없음) + Suno 삭제 시 재생 불가 주의가 가이드에 노출.
- [ ] 브릿지 설정 필요 안내 + 재가져오기(블록 삭제 후) 안내.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → 0 errors; 설정 페이지 가이드 노트 탭에 SUNO 항목 표시(수동 확인은 실행자 판단).

**Steps:**

- [ ] **Step 1: Replace the placeholder `<li>` in `app/src/routes/settings/+page.svelte`**

기존(line 1806-1807):
```svelte
						<li>현재는 <strong>직접 오디오 파일 URL</strong>(mp3 등 브라우저가 재생 가능한 링크)만
							지원합니다. SUNO 플레이리스트 자동 채움은 향후 추가 예정입니다.</li>
```

교체:
```svelte
						<li><strong>직접 오디오 파일 URL</strong>(mp3 등 브라우저가 재생 가능한 링크)을 재생합니다.</li>
						<li><strong>SUNO 재생목록 가져오기</strong>: <code>SUNO:&lt;재생목록 URL&gt;</code> 줄을 쓰면
							우측에 <b>가져오기</b> 버튼이 떠요. 누르면 Suno 공개 재생목록을 읽어 그 줄 <b>바로 아래</b>에
							<code>[x]플레이리스트: …</code> 블록(곡 제목 + 직접 재생 URL)을 만들어 바로 재생됩니다.</li>
```

`<pre class="snippet">` 의 마지막(`[ ]플레이리스트: 저녁 …` 줄 뒤)에 SUNO 예시 한 줄 추가:
```svelte

SUNO:https://suno.com/playlist/&lt;id&gt;  (가져오기 → 플레이리스트 블록)
```

- [ ] **Step 2: Add caveat list items**

위에서 교체한 SUNO `<li>` 뒤에 이어서 추가:
```svelte
						<li>Suno 곡은 <b>다운로드 없이 직접 링크</b>합니다 — 빠르고 데스크탑 서비스가 필요 없지만,
							Suno 에서 곡을 내리면 재생이 안 될 수 있어요. 선행: 브릿지 설정(터미널 탭).</li>
						<li>이미 가져온 줄은 버튼이 사라져요. <b>다시 가져오려면</b> 아래 플레이리스트 블록을 지우면
							버튼이 다시 뜹니다. 한 번에 최대 100곡.</li>
```

- [ ] **Step 3: Type check**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): document SUNO playlist import in 음악 노트 guide card"
```

---

## Self-Review

**Spec coverage:**
- 직접 링크 저장 → Task 1 (audio_url 그대로 매핑, 다운로드 없음) ✅
- 위치=음악:: 노트 → Task 3 (`음악::` 게이트), Task 6 (음악:: 노트에서만 버튼) ✅
- 줄별 가져오기 버튼 → Task 6 ✅
- 브릿지 단독 백엔드 → Task 1·2 (music-service 미경유) ✅
- 패턴 A + 라운드트립 → Task 4 + `sunoBlockRoundtrip.test.ts` ✅
- 체크박스 기본 체크 → Task 4 (`cb.create({ checked: true })`) ✅
- JSON API + HTML 폴백 → Task 1 ✅
- 에러/한국어 토스트/멱등/상한 → Task 5 (kind), Task 6 (토스트), Task 3·4 (alreadyImported), Task 1·2 (max) ✅
- 가이드 카드 → Task 7 ✅
- 테스트(parse/write/roundtrip/client/plugin/bridge) → 전 Task ✅

**Placeholder scan:** 모든 step 에 실제 코드/명령/기대출력 존재. TODO/TBD 없음.

**Type consistency:** `fetchSunoPlaylist`(브릿지: `(url, deps)` / 앱: `({url})`) — 의도적 동명이지만 다른 모듈(`bridge/src/suno.ts` vs `app/.../sunoClient.ts`). `SunoTrack {url,title}`, `SunoResult/SunoPlaylist {label,tracks,total,truncated}` 일관. `writeSunoPlaylistBlock(view, sunoUrl, {label, tracks})` Task 4·6 일치. `matchSunoLine`/`parseSunoLines` Task 3·4·6 일치.

**리스크:** Task 1 의 Suno 실제 API/HTML 형식은 실행 시 실제 공개 재생목록 1개로 검증하고 필요 시 필드 경로/정규식 미세조정 + 픽스처 캡처(스펙 "위험" 항목). 두 경로(JSON·HTML) 중 하나만 동작해도 기능 성립.
