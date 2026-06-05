# 음악추출 노트 (`음악추출::`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `음악추출::` 작업대 노트에서 YouTube 영상을 데스크탑 yt-dlp로 mp3 추출해 브릿지 `/files`에 저장하고, 결과 URL을 노트 항목에 채워(멱등) 기존 백그라운드 엔진으로 풀버전 재생할 수 있게 한다.

**Architecture:** 노트 ⟳ 버튼 → 브릿지 `/music/extract` relay(`automation.ts` 복제) → 데스크탑 `music-service`(yt-dlp + ffmpeg) → mp3를 브릿지 기존 `POST /files`에 업로드(공개 `{url}` 반환) → 앱이 결과 URL을 해당 항목의 자식 리스트에 write-back. 저장·서빙·Range·mp3 MIME·무토큰 다운로드는 기존 `bridge/src/files.ts` 재사용(신규 저장 코드 0줄). 멱등: 자식에 `/files/<uuid>/` URL이 있으면 완료(skip), 없으면 처리.

**Tech Stack:** SvelteKit + Svelte5 runes, TipTap3/ProseMirror, vitest + @testing-library/svelte (app & music-service), `node --test` (bridge), Fastify + Node (music-service), yt-dlp + ffmpeg, systemd --user.

스펙: `docs/superpowers/specs/2026-06-05-music-extract-design.md`

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `app/src/lib/musicExtract/parseExtractNote.ts` | 노트 doc → 항목(소스/결과/위치), `pendingItems` | 1 |
| `app/src/lib/musicExtract/extractClient.ts` | `POST /music/extract` fetch + 에러 매핑 | 2 |
| `app/src/lib/musicExtract/writeExtractResult.ts` | 라이브 view에 결과 자식 write-back | 3 |
| `app/src/lib/editor/musicExtractNote/musicExtractNotePlugin.ts` | ⟳ 진행 버튼 위젯 데코 | 4 |
| `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts` | 대기 항목 순차 추출 루프 | 4 |
| `app/src/lib/editor/musicExtractNote/index.ts` | TipTap Extension 래퍼 | 4 |
| `app/src/lib/editor/TomboyEditor.svelte` | Extension 등록 + 버튼 CSS | 4 |
| `bridge/src/music.ts` | `/music/extract` relay | 5 |
| `bridge/src/server.ts` | 라우트 + `MUSIC_SERVICE_URL` env | 5 |
| `music-service/src/validate.ts` | source 검증(allowlist) + `ytsearch1:` | 6 |
| `music-service/src/runner.ts` | yt-dlp spawn + 브릿지 업로드 | 6 |
| `music-service/src/auth.ts` | Bearer 검증(automation-service 복제) | 6 |
| `music-service/src/server.ts` | Fastify `/extract` + boot | 7 |
| `music-service/{package.json,tsconfig.json,deploy/*}` | 패키징 + systemd 배포 | 7 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 | 8 |
| `.claude/skills/tomboy-musicextract/SKILL.md`, `CLAUDE.md` | 스킬 + 색인 | 8 |

App 단위 테스트는 `app/tests/unit/musicExtract/` 와 `app/tests/unit/editor/musicExtractNote/` 에 둔다(기존 `app/tests/unit/` 미러).

---

### Task 1: `parseExtractNote` 파서

**Goal:** `음악추출::` 노트 doc(PMNode)을 항목 리스트(소스/결과/위치)로 파싱하고 미완료 항목을 골라내는 순수 함수를 만든다.

**Files:**
- Create: `app/src/lib/musicExtract/parseExtractNote.ts`
- Test: `app/tests/unit/musicExtract/parseExtractNote.test.ts`

**Acceptance Criteria:**
- [ ] 제목이 `음악추출::`로 시작하면 `isExtract:true`, 아니면 `false` + 빈 items.
- [ ] top-level 리스트의 각 listItem → `{ source, result, liPos }`. source = head 단락의 링크 href 우선, 없으면 head 텍스트(검색어 포함).
- [ ] 자식 리스트에 `/files/<uuid>/` URL → `result.kind==='done'`(url, title), `❌`로 시작하는 자식만 → `'error'`(message), 자식 없음/그 외 → `'pending'`.
- [ ] `pendingItems(note)` 는 `result.kind !== 'done'` 항목만 반환(신규 + 실패).
- [ ] `isExtractNoteDoc(json)` 는 JSONContent 첫 단락만 보고 boolean.

**Verify:** `cd app && npm run test -- parseExtractNote` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/musicExtract/parseExtractNote.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { parseExtractNote, pendingItems, isExtractNoteDoc } from '$lib/musicExtract/parseExtractNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';

function docFrom(html: string) {
	const ed = new Editor({ extensions: [StarterKit], content: html });
	const doc = ed.state.doc;
	ed.destroy();
	return doc;
}

const NOTE = `
<p>음악추출::내 라이브러리</p>
<ul>
  <li><p>https://www.youtube.com/watch?v=aaa</p>
    <ul><li><p>https://bridge.example/files/${UUID}/Some%20Song.mp3</p></li></ul>
  </li>
  <li><p>Artist - Title</p><ul><li><p>❌ 실패: 추출 불가</p></li></ul></li>
  <li><p>https://www.youtube.com/watch?v=ccc</p></li>
</ul>`;

describe('parseExtractNote', () => {
	it('비음악추출 노트는 isExtract=false', () => {
		const note = parseExtractNote(docFrom('<p>그냥 노트</p><ul><li><p>x</p></li></ul>'));
		expect(note.isExtract).toBe(false);
		expect(note.items).toEqual([]);
	});

	it('항목을 소스/결과로 분류한다', () => {
		const note = parseExtractNote(docFrom(NOTE));
		expect(note.isExtract).toBe(true);
		expect(note.items).toHaveLength(3);
		expect(note.items[0].source).toBe('https://www.youtube.com/watch?v=aaa');
		expect(note.items[0].result).toMatchObject({ kind: 'done', title: 'Some Song' });
		expect(note.items[0].result).toHaveProperty('url');
		expect(note.items[1]).toMatchObject({ source: 'Artist - Title' });
		expect(note.items[1].result).toMatchObject({ kind: 'error', message: '실패: 추출 불가' });
		expect(note.items[2].result).toEqual({ kind: 'pending' });
	});

	it('pendingItems는 done 아닌 항목만(신규+실패)', () => {
		const note = parseExtractNote(docFrom(NOTE));
		const pend = pendingItems(note);
		expect(pend.map((p) => p.source)).toEqual(['Artist - Title', 'https://www.youtube.com/watch?v=ccc']);
	});

	it('isExtractNoteDoc는 JSON 첫 단락만 본다', () => {
		expect(isExtractNoteDoc({ content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악추출::x' }] }] })).toBe(true);
		expect(isExtractNoteDoc({ content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악::x' }] }] })).toBe(false);
		expect(isExtractNoteDoc(null)).toBe(false);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인** — `cd app && npm run test -- parseExtractNote` → FAIL ("Cannot find module parseExtractNote").

- [ ] **Step 3: 구현** — `app/src/lib/musicExtract/parseExtractNote.ts`

```ts
import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const PREFIX = '음악추출::';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/;

export type ExtractResult =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string }
	| { kind: 'pending' };

export interface ExtractItem {
	source: string;
	result: ExtractResult;
	liPos: number; // top-level listItem 시작 pos (데코 anchor)
}
export interface ExtractNote {
	isExtract: boolean;
	items: ExtractItem[];
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}
function nestedListOf(li: PMNode): PMNode | null {
	let found: PMNode | null = null;
	li.forEach((child) => { if (!found && isListNode(child)) found = child; });
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
			if (typeof href === 'string' && HTTP_URL_RE.test(href)) { out = { url: href, text: n.text ?? '' }; return false; }
		}
		return true;
	});
	if (out) return out;
	const m = HTTP_URL_RE.exec(node.textContent);
	return m ? { url: m[0], text: '' } : null;
}
function headText(li: PMNode): string {
	const first = li.firstChild;
	return first ? first.textContent.trim() : '';
}
function headSource(li: PMNode): string {
	const first = li.firstChild;
	if (first) { const u = firstUrlAndText(first); if (u) return u.url; }
	return headText(li);
}
function deriveTitle(url: string, linkText: string): string {
	if (linkText && !HTTP_URL_RE.test(linkText)) return linkText;
	try {
		const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
		return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '') || url;
	} catch { return url; }
}
function resultOf(li: PMNode): ExtractResult {
	const nested = nestedListOf(li);
	if (!nested) return { kind: 'pending' };
	let result: ExtractResult = { kind: 'pending' };
	nested.forEach((child) => {
		if (result.kind === 'done') return;
		const u = firstUrlAndText(child);
		if (u && RESULT_URL_RE.test(u.url)) { result = { kind: 'done', url: u.url, title: deriveTitle(u.url, u.text) }; return; }
		const txt = child.textContent.trim();
		if (result.kind === 'pending' && txt.startsWith('❌')) result = { kind: 'error', message: txt.replace(/^❌\s*/, '') };
	});
	return result;
}

export function parseExtractNote(doc: PMNode): ExtractNote {
	const title = doc.firstChild?.textContent.trim() ?? '';
	const isExtract = title.startsWith(PREFIX);
	if (!isExtract) return { isExtract, items: [] };
	const items: ExtractItem[] = [];
	doc.forEach((block, offset) => {
		if (!isListNode(block)) return;
		block.forEach((li, liOffset) => {
			if (li.type.name !== 'listItem') return;
			const source = headSource(li);
			if (!source) return;
			items.push({ source, result: resultOf(li), liPos: offset + 1 + liOffset });
		});
	});
	return { isExtract, items };
}

export function pendingItems(note: ExtractNote): ExtractItem[] {
	return note.items.filter((it) => it.result.kind !== 'done');
}

/** 라우트 마운트 게이트용 — JSON doc 첫 단락만 보고 음악추출 노트인지. */
export function isExtractNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(PREFIX);
}
```

- [ ] **Step 4: 테스트 통과 확인** — `cd app && npm run test -- parseExtractNote` → PASS (4 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/musicExtract/parseExtractNote.ts app/tests/unit/musicExtract/parseExtractNote.test.ts
git commit -m "feat(musicExtract): 음악추출:: 노트 파서 + pendingItems"
```

---

### Task 2: `extractClient` (앱 → 브릿지 호출)

**Goal:** `POST /music/extract`로 소스 1건을 보내 `{url,title}`를 받고, 상태코드를 에러 종류로 매핑하는 클라이언트를 만든다.

**Files:**
- Create: `app/src/lib/musicExtract/extractClient.ts`
- Test: `app/tests/unit/musicExtract/extractClient.test.ts`

**Acceptance Criteria:**
- [ ] 브릿지/토큰 미설정 → `ExtractError('not_configured')` throw, fetch 미호출.
- [ ] 성공 응답 `{url,title}` 파싱 반환. url 없으면 `upstream_error`.
- [ ] 401→`unauthorized`, 503→`service_unavailable`, ≥500→`upstream_error`, 그 외 비-2xx→`bad_request`.
- [ ] 네트워크 throw → `network`. `signal` 전달.

**Verify:** `cd app && npm run test -- extractClient` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/musicExtract/extractClient.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractOne, ExtractError } from '$lib/musicExtract/extractClient.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'https://bridge.example'),
	getTerminalBridgeToken: vi.fn(async () => 'tok'),
	bridgeToHttpBase: (b: string) => b.replace(/\/$/, '')
}));
import * as bs from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => {
	(bs.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('https://bridge.example');
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});

it('미설정이면 not_configured throw + fetch 미호출', async () => {
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	const spy = vi.fn();
	globalThis.fetch = spy as unknown as typeof fetch;
	await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	expect(spy).not.toHaveBeenCalled();
});

it('성공 응답을 파싱한다 + Bearer/본문 전송', async () => {
	let calledUrl = '', auth = '', body = '';
	globalThis.fetch = (async (u: string, init: RequestInit) => {
		calledUrl = String(u); auth = (init.headers as Record<string, string>).Authorization; body = String(init.body);
		return new Response(JSON.stringify({ url: 'https://bridge.example/files/x/y.mp3', title: 'Y' }), { status: 200 });
	}) as unknown as typeof fetch;
	const out = await extractOne({ source: 'https://yt/abc' });
	expect(out).toEqual({ url: 'https://bridge.example/files/x/y.mp3', title: 'Y' });
	expect(calledUrl).toBe('https://bridge.example/music/extract');
	expect(auth).toBe('Bearer tok');
	expect(JSON.parse(body)).toEqual({ source: 'https://yt/abc' });
});

it.each([[401, 'unauthorized'], [503, 'service_unavailable'], [500, 'upstream_error'], [400, 'bad_request']])(
	'상태 %i → %s', async (status, kind) => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'e' }), { status })) as unknown as typeof fetch;
		await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind });
	}
);

it('네트워크 오류 → network', async () => {
	globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
	await expect(extractOne({ source: 'x' })).rejects.toBeInstanceOf(ExtractError);
	await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind: 'network' });
});
```

- [ ] **Step 2: 테스트 실패 확인** — `cd app && npm run test -- extractClient` → FAIL.

- [ ] **Step 3: 구현** — `app/src/lib/musicExtract/extractClient.ts` (`runAutomation.ts` 미러)

```ts
import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type ExtractErrorKind =
	| 'not_configured' | 'unauthorized' | 'service_unavailable'
	| 'bad_request' | 'upstream_error' | 'network';

export class ExtractError extends Error {
	constructor(public kind: ExtractErrorKind, public detail?: string) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}
export interface ExtractOk { url: string; title: string; }

const STATUS_TO_KIND: Record<number, ExtractErrorKind> = { 401: 'unauthorized', 503: 'service_unavailable' };

export async function extractOne(opts: { source: string; signal?: AbortSignal }): Promise<ExtractOk> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new ExtractError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/music/extract`;

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
		try { const j = (await res.json()) as { error?: string }; bodyErr = typeof j?.error === 'string' ? j.error : ''; } catch { /* ignore */ }
		const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
		throw new ExtractError(kind, bodyErr || undefined);
	}

	const data = (await res.json()) as Partial<ExtractOk>;
	if (!data.url) throw new ExtractError('upstream_error', 'no_url');
	return { url: data.url, title: data.title ?? '' };
}
```

- [ ] **Step 4: 테스트 통과 확인** — `cd app && npm run test -- extractClient` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/musicExtract/extractClient.ts app/tests/unit/musicExtract/extractClient.test.ts
git commit -m "feat(musicExtract): /music/extract 클라이언트 + 에러 매핑"
```

---

### Task 3: `writeExtractResult` (라이브 write-back)

**Goal:** 열린 에디터에서 주어진 source 헤드를 가진 첫 미완료 top-level listItem 밑에 결과(성공 링크 또는 `❌` 텍스트)를 자식으로 기록한다.

**Files:**
- Create: `app/src/lib/musicExtract/writeExtractResult.ts`
- Test: `app/tests/unit/musicExtract/writeExtractResult.test.ts`

**Acceptance Criteria:**
- [ ] 자식 없던 항목에 성공 결과 → `/files/<uuid>/` URL 링크 자식 추가, 링크 텍스트 = title.
- [ ] 같은 항목에 실패 결과 → `❌ 실패: <message>` 텍스트 자식 추가.
- [ ] 기존 `❌` 자식이 있는 항목에 성공 → 자식 리스트가 성공 링크로 **교체**.
- [ ] 이미 `/files` URL(done) 자식이 있는 항목은 source가 같아도 건드리지 않음(다음 동일 source로 넘어감).
- [ ] `view.isDestroyed` → no-op.

**Verify:** `cd app && npm run test -- writeExtractResult` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/musicExtract/writeExtractResult.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
function makeEditor(html: string) {
	return new Editor({ extensions: [StarterKit], content: html });
}

describe('writeExtractResult', () => {
	it('대기 항목에 성공 링크 자식을 추가한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>https://yt/aaa</p></li></ul>');
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/Song.mp3`, title: 'Song' });
		const note = parseExtractNote(ed.state.doc);
		expect(note.items[0].result).toMatchObject({ kind: 'done', title: 'Song' });
		ed.destroy();
	});

	it('대기 항목에 실패 자식을 추가한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>검색어</p></li></ul>');
		writeExtractResult(ed.view, '검색어', { kind: 'error', message: '추출 불가' });
		const note = parseExtractNote(ed.state.doc);
		expect(note.items[0].result).toMatchObject({ kind: 'error', message: '실패: 추출 불가' });
		ed.destroy();
	});

	it('기존 실패 자식을 성공으로 교체한다', () => {
		const ed = makeEditor('<p>음악추출::x</p><ul><li><p>https://yt/aaa</p><ul><li><p>❌ 실패: 추출 불가</p></li></ul></li></ul>');
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/Song.mp3`, title: 'Song' });
		const note = parseExtractNote(ed.state.doc);
		expect(note.items[0].result.kind).toBe('done');
		ed.destroy();
	});

	it('이미 done인 항목은 건드리지 않는다', () => {
		const ed = makeEditor(`<p>음악추출::x</p><ul><li><p>https://yt/aaa</p><ul><li><p>https://b.ex/files/${UUID}/Old.mp3</p></li></ul></li></ul>`);
		writeExtractResult(ed.view, 'https://yt/aaa', { kind: 'done', url: `https://b.ex/files/${UUID}/New.mp3`, title: 'New' });
		const note = parseExtractNote(ed.state.doc);
		expect((note.items[0].result as { title: string }).title).toBe('Old');
		ed.destroy();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인** — `cd app && npm run test -- writeExtractResult` → FAIL.

- [ ] **Step 3: 구현** — `app/src/lib/musicExtract/writeExtractResult.ts` (`appendRunHistory.ts` 미러)

```ts
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

export type ResultPayload =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');

function isList(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}
function liIsDone(li: PMNode): boolean {
	let done = false;
	li.descendants((n) => {
		if (done) return false;
		if (n.isText) {
			const link = n.marks.find((m) => m.type.name === 'tomboyUrlLink' || m.type.name === 'link');
			const href = (link?.attrs?.href as string) ?? '';
			if (RESULT_URL_RE.test(href) || RESULT_URL_RE.test(n.text ?? '')) { done = true; return false; }
		}
		return true;
	});
	return done;
}
function linkText(schema: Schema, text: string, href: string) {
	const markType = schema.marks.tomboyUrlLink ?? schema.marks.link;
	if (markType) return schema.text(text, [markType.create({ href })]);
	// 마크 없으면 텍스트+URL 둘 다(파서가 URL 인식 가능)
	return schema.text(`${text} ${href}`);
}

/** source 헤드를 가진 첫 '미완료' top-level listItem 밑에 결과 자식을 기록(라이브 dispatch). */
export function writeExtractResult(view: EditorView, source: string, payload: ResultPayload): void {
	if (view.isDestroyed) return;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return;
	const want = source.trim();

	let target: { liPos: number; node: PMNode } | null = null;
	doc.forEach((block, blockOffset) => {
		if (target || !isList(block)) return;
		block.forEach((li, liOffset) => {
			if (target || li.type.name !== 'listItem') return;
			const head = li.firstChild?.textContent.trim() ?? '';
			if (head === want && !liIsDone(li)) target = { liPos: blockOffset + 1 + liOffset, node: li };
		});
	});
	if (!target) return;

	const childPara = payload.kind === 'done'
		? paragraph.create(null, linkText(schema, payload.title || payload.url, payload.url))
		: paragraph.create(null, schema.text(`❌ 실패: ${payload.message}`));
	const childItem = listItem.create(null, childPara);

	const li = target.node;
	let nested: { pos: number; node: PMNode } | null = null;
	li.forEach((child, childOffset) => {
		if (!nested && isList(child)) nested = { pos: target!.liPos + 1 + childOffset, node: child };
	});

	const tr = state.tr;
	if (nested) {
		tr.replaceWith(nested.pos, nested.pos + nested.node.nodeSize, bulletList.create(nested.node.attrs, childItem));
	} else {
		const headSize = li.firstChild?.nodeSize ?? 0;
		tr.insert(target.liPos + 1 + headSize, bulletList.create(null, childItem));
	}
	view.dispatch(tr);
}
```

- [ ] **Step 4: 테스트 통과 확인** — `cd app && npm run test -- writeExtractResult` → PASS (4 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/musicExtract/writeExtractResult.ts app/tests/unit/musicExtract/writeExtractResult.test.ts
git commit -m "feat(musicExtract): 결과 자식 write-back (라이브 dispatch)"
```

---

### Task 4: 에디터 플러그인 + ⟳ 진행 버튼 + 클릭 루프

**Goal:** `음악추출::` 노트를 감지해 제목 아래 ⟳ 진행 버튼을 띄우고, 클릭 시 대기 항목을 순차 추출해 결과를 노트에 채운 뒤, Extension을 TomboyEditor에 등록한다.

**Files:**
- Create: `app/src/lib/editor/musicExtractNote/musicExtractNotePlugin.ts`
- Create: `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts`
- Create: `app/src/lib/editor/musicExtractNote/index.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import + extensions 배열 + 버튼 CSS)
- Test: `app/tests/unit/editor/musicExtractNote/musicExtractNotePlugin.test.ts`
- Test: `app/tests/unit/editor/musicExtractNote/runExtractButtonClick.test.ts`

**Acceptance Criteria:**
- [ ] `음악추출::` 노트 → 제목 단락 끝에 `⟳ 진행` 버튼 위젯 1개. 비음악추출 노트 → 위젯 0개.
- [ ] 클릭 핸들러가 `pendingItems`만 순차 호출하고 각 결과를 `writeExtractResult`로 기록.
- [ ] 부분 실패 시 성공/실패 카운트 토스트(`N곡 추출, M곡 실패`).
- [ ] 대기 0건 → "추출할 항목이 없습니다" 토스트.
- [ ] `TomboyMusicExtractNote` 가 TomboyEditor extensions에 등록됨.

**Verify:** `cd app && npm run test -- musicExtractNote && npm run check` → 테스트 PASS, 0 type errors

**Steps:**

- [ ] **Step 1: 플러그인 실패 테스트** — `app/tests/unit/editor/musicExtractNote/musicExtractNotePlugin.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyMusicExtractNote } from '$lib/editor/musicExtractNote/index.js';

function mount(html: string) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({ element: el, extensions: [StarterKit, TomboyMusicExtractNote], content: html });
}

describe('musicExtractNotePlugin', () => {
	it('음악추출 노트에 ⟳ 진행 버튼을 렌더한다', () => {
		const ed = mount('<p>음악추출::x</p><ul><li><p>https://yt/a</p></li></ul>');
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-run')).toHaveLength(1);
		ed.destroy();
	});
	it('일반 노트에는 버튼이 없다', () => {
		const ed = mount('<p>그냥</p>');
		expect(ed.view.dom.querySelectorAll('button.tomboy-music-extract-run')).toHaveLength(0);
		ed.destroy();
	});
});
```

- [ ] **Step 2: 클릭 핸들러 실패 테스트** — `app/tests/unit/editor/musicExtractNote/runExtractButtonClick.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const toastSpy = vi.fn();
vi.mock('$lib/stores/toast.js', () => ({ pushToast: (...a: unknown[]) => toastSpy(...a) }));
const extractSpy = vi.fn();
vi.mock('$lib/musicExtract/extractClient.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/musicExtract/extractClient.js')>('$lib/musicExtract/extractClient.js');
	return { ...actual, extractOne: (...a: unknown[]) => extractSpy(...a) };
});
import { runExtractButtonClick } from '$lib/editor/musicExtractNote/runExtractButtonClick.js';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';
import { ExtractError } from '$lib/musicExtract/extractClient.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
afterEach(() => { toastSpy.mockReset(); extractSpy.mockReset(); });

it('대기 항목만 순차 추출하고 결과를 기록한다', async () => {
	const ed = new Editor({
		extensions: [StarterKit],
		content: `<p>음악추출::x</p><ul>
			<li><p>https://yt/done</p><ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li>
			<li><p>https://yt/ok</p></li>
			<li><p>https://yt/bad</p></li></ul>`
	});
	extractSpy.mockImplementation(async ({ source }: { source: string }) => {
		if (source === 'https://yt/ok') return { url: `https://b.ex/files/${UUID}/Ok.mp3`, title: 'Ok' };
		throw new ExtractError('upstream_error', 'x');
	});
	await runExtractButtonClick(ed.view);
	// done 항목은 호출 안 함 → 2건만.
	expect(extractSpy).toHaveBeenCalledTimes(2);
	const note = parseExtractNote(ed.state.doc);
	expect(note.items[1].result).toMatchObject({ kind: 'done', title: 'Ok' });
	expect(note.items[2].result.kind).toBe('error');
	expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('1곡 추출'), expect.anything());
	ed.destroy();
});

it('대기 0건이면 안내 토스트', async () => {
	const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><ul><li><p>https://yt/d</p><ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li></ul>` });
	await runExtractButtonClick(ed.view);
	expect(extractSpy).not.toHaveBeenCalled();
	expect(toastSpy).toHaveBeenCalledWith('추출할 항목이 없습니다', expect.anything());
	ed.destroy();
});
```

- [ ] **Step 3: 테스트 실패 확인** — `cd app && npm run test -- musicExtractNote` → FAIL.

- [ ] **Step 4: 클릭 핸들러 구현** — `app/src/lib/editor/musicExtractNote/runExtractButtonClick.ts`

```ts
import type { EditorView } from '@tiptap/pm/view';
import { parseExtractNote, pendingItems } from '$lib/musicExtract/parseExtractNote.js';
import { extractOne, ExtractError, type ExtractErrorKind } from '$lib/musicExtract/extractClient.js';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<ExtractErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	network: '음악 추출 서비스에 연결할 수 없습니다',
	service_unavailable: '음악 추출 서비스에 연결할 수 없습니다',
	unauthorized: '브릿지 인증이 필요합니다',
	bad_request: '잘못된 소스',
	upstream_error: '음악 추출 서비스 오류'
};

/** ⟳ 진행: 대기(신규+실패) 항목을 순차 추출해 결과를 노트에 기록. */
export async function runExtractButtonClick(view: EditorView): Promise<void> {
	const pending = pendingItems(parseExtractNote(view.state.doc));
	if (pending.length === 0) { pushToast('추출할 항목이 없습니다', { kind: 'info' }); return; }
	let ok = 0; let fail = 0;
	for (const item of pending) {
		if (view.isDestroyed) break;
		try {
			const { url, title } = await extractOne({ source: item.source });
			writeExtractResult(view, item.source, { kind: 'done', url, title });
			ok++;
		} catch (err) {
			const kind: ExtractErrorKind = err instanceof ExtractError ? err.kind : 'network';
			writeExtractResult(view, item.source, { kind: 'error', message: KIND_MESSAGES[kind] ?? '추출 실패' });
			fail++;
		}
	}
	if (view.isDestroyed) return;
	const summary = `${ok}곡 추출${fail ? `, ${fail}곡 실패` : ''}`;
	pushToast(summary, { kind: fail && !ok ? 'error' : 'info' });
}
```

- [ ] **Step 5: 플러그인 구현** — `app/src/lib/editor/musicExtractNote/musicExtractNotePlugin.ts` (`automationNotePlugin.ts` 미러)

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';
import { runExtractButtonClick } from './runExtractButtonClick.js';

export const musicExtractNotePluginKey = new PluginKey<DecorationSet>('tomboyMusicExtractNote');

function renderButton(view: EditorView): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-music-extract-run';
	btn.contentEditable = 'false';
	btn.textContent = '⟳ 진행';
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		if (btn.disabled) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '⟳ 진행 중…';
		try { await runExtractButtonClick(view); }
		finally { btn.disabled = false; btn.textContent = orig; }
	});
	return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const first = doc.firstChild;
	if (!first || !parseExtractNote(doc).isExtract) return DecorationSet.empty;
	const headerEndPos = first.nodeSize - 1;
	const widget = Decoration.widget(headerEndPos, (view) => renderButton(view), { side: 1, key: 'music-extract-run' });
	return DecorationSet.create(doc, [widget]);
}

export function createMusicExtractNotePlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: musicExtractNotePluginKey,
		state: {
			init(_, { doc }): DecorationSet { return buildDecorations(doc); },
			apply(tr, old): DecorationSet { return tr.docChanged ? buildDecorations(tr.doc) : old.map(tr.mapping, tr.doc); }
		},
		props: { decorations(state): DecorationSet | undefined { return musicExtractNotePluginKey.getState(state); } }
	});
}
```

- [ ] **Step 6: Extension 래퍼** — `app/src/lib/editor/musicExtractNote/index.ts` (`musicNote/index.ts` 미러)

```ts
import { Extension } from '@tiptap/core';
import { createMusicExtractNotePlugin } from './musicExtractNotePlugin.js';

export const TomboyMusicExtractNote = Extension.create({
	name: 'tomboyMusicExtractNote',
	addProseMirrorPlugins() { return [createMusicExtractNotePlugin()]; }
});
export { createMusicExtractNotePlugin, musicExtractNotePluginKey } from './musicExtractNotePlugin.js';
```

- [ ] **Step 7: TomboyEditor 등록 + CSS** — `app/src/lib/editor/TomboyEditor.svelte`
  - import 추가(line 43 `TomboyMusicNote` import 부근):
    ```ts
    import { TomboyMusicExtractNote } from "./musicExtractNote/index.js";
    ```
  - extensions 배열에 추가(line 494 `TomboyMusicNote.configure(...)` 다음 줄):
    ```ts
    TomboyMusicExtractNote,
    ```
  - `<style>`에 버튼 규칙 추가(automation 버튼과 동일 톤):
    ```css
    :global(.tomboy-music-extract-run) {
    	display: inline-flex;
    	align-items: center;
    	gap: 0.3em;
    	margin: 0.2rem 0 0.4rem;
    	padding: 0.25rem 0.7rem;
    	font-size: 0.85rem;
    	border: 1px solid var(--border, #ddd);
    	border-radius: 6px;
    	background: var(--surface, #fff);
    	color: var(--accent, #a05);
    	cursor: pointer;
    }
    :global(.tomboy-music-extract-run:disabled) { opacity: 0.6; cursor: default; }
    ```

- [ ] **Step 8: 테스트 통과 + 타입 확인** — `cd app && npm run test -- musicExtractNote && npm run check` → 모든 테스트 PASS, 0 type errors.

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/musicExtractNote/ app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/musicExtractNote/
git commit -m "feat(musicExtract): ⟳ 진행 버튼 플러그인 + 순차 추출 루프 + 에디터 등록"
```

---

### Task 5: 브릿지 `/music/extract` relay

**Goal:** 앱의 `POST /music/extract`를 Bearer 검증 후 데스크탑 `music-service`로 재프록시하는 비스트리밍 relay를 추가한다.

**Files:**
- Create: `bridge/src/music.ts`
- Modify: `bridge/src/server.ts` (import + `MUSIC_SERVICE_URL` env + 라우트)
- Test: `bridge/src/music.test.ts`

**Acceptance Criteria:**
- [ ] Bearer 없음 → 401, fetch 미호출.
- [ ] `source` 없음 → 400, fetch 미호출.
- [ ] `MUSIC_SERVICE_URL` 빈 문자열 → 503 `music_service_not_configured`.
- [ ] 정상 → `{musicServiceUrl}/extract`로 `Bearer <SECRET>` + `{source}` 전송, 업스트림 status/body 패스스루.
- [ ] 업스트림 네트워크 오류 → 503 `music_service_unavailable`.

**Verify:** `cd bridge && npm test` → music.test.ts 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/music.test.ts` (`automation.test.ts` 미러)

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleMusicExtract } from './music.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const URL_ = 'http://music.test';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	return r;
}
function mockRes() {
	const writes: string[] = []; let status = 0; let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => { status = s; headers = { ...headers, ...(h ?? {}) }; return res; },
		end: (b?: string) => { if (b) writes.push(b); }
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({}, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 401);
});

test('400 on missing source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('503 when service url not configured', async () => {
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, '');
	assert.equal(get().status, 503);
	assert.match(get().body, /not_configured/);
});

test('forwards to upstream with re-Bearer and pipes response', async () => {
	let calledUrl = '', calledAuth = '', calledBody = '';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(url);
		calledAuth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		calledBody = typeof init?.body === 'string' ? init.body : '';
		return new Response(JSON.stringify({ url: 'http://b/files/x/y.mp3', title: 'Y' }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'https://yt/abc' }), res, SECRET, URL_);
	assert.equal(get().status, 200);
	assert.equal(calledUrl, 'http://music.test/extract');
	assert.equal(calledAuth, `Bearer ${SECRET}`);
	assert.deepEqual(JSON.parse(calledBody), { source: 'https://yt/abc' });
	assert.match(get().body, /y\.mp3/);
});

test('503 on upstream network error', async () => {
	globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 503);
	assert.match(get().body, /unavailable/);
});
```

- [ ] **Step 2: 테스트 실패 확인** — `cd bridge && npm test` → FAIL ("Cannot find module './music.js'").

- [ ] **Step 3: 구현** — `bridge/src/music.ts` (`automation.ts` 복제, command→source)

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface ExtractBody { source?: unknown; }

/**
 * Proxy POST /music/extract → desktop music-service /extract.
 * Auth mirrors /automation/run: client Bearer verified here, then re-Bearer
 * with BRIDGE_SECRET upstream. No artificial timeout — yt-dlp can be slow;
 * the music-service self-limits and we just relay its response.
 */
export async function handleMusicExtract(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	musicServiceUrl: string
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
		upstream = await fetch(`${musicServiceUrl}/extract`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
			body: JSON.stringify({ source })
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

- [ ] **Step 4: server.ts 라우트 등록** — `bridge/src/server.ts`
  - import(line 19 `handleAutomationRun` import 부근): `import { handleMusicExtract } from './music.js';`
  - env(line 50 `AUTOMATION_SERVICE_URL` 부근): `const MUSIC_SERVICE_URL = process.env.MUSIC_SERVICE_URL ?? '';`
  - 라우트(line 157 `/automation/run` 블록 다음):
    ```ts
    if (url === '/music/extract' && req.method === 'POST') {
    	await handleMusicExtract(req, res, SECRET, MUSIC_SERVICE_URL);
    	return;
    }
    ```

- [ ] **Step 5: 테스트 통과 확인** — `cd bridge && npm test` → music.test.ts 5 tests PASS (기존 테스트도 그대로 통과).

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/music.ts bridge/src/music.test.ts bridge/src/server.ts
git commit -m "feat(bridge): /music/extract relay → music-service"
```

---

### Task 6: `music-service` 소스 검증 + 러너

**Goal:** source를 검증(allowlist + `ytsearch1:`)하고 yt-dlp로 mp3를 추출해 브릿지 `/files`에 업로드한 뒤 `{url,title}`를 반환하는 코어 로직을 만든다(spawn·업로드 주입 가능).

**Files:**
- Create: `music-service/src/validate.ts`
- Create: `music-service/src/runner.ts`
- Create: `music-service/src/auth.ts` (automation-service 복제)
- Create: `music-service/tests/validate.test.ts`
- Create: `music-service/tests/runner.test.ts`
- Create: `music-service/package.json`, `music-service/tsconfig.json`

**Acceptance Criteria:**
- [ ] `resolveSource`: `http(s)://…` → `{kind:'url'}`; 일반 텍스트 → `{kind:'search', value:'ytsearch1:<term>'}`; 빈 값/`-`시작/`file:` → `{kind:'reject'}`.
- [ ] `extract`: 주입 spawn이 `--paths <dir>`에 mp3를 떨구고 종료(0) → mp3를 업로드(주입 `uploadFn`)하고 `{url, title}`(title = 파일명에서 `.mp3` 제거) 반환.
- [ ] spawn 종료코드 ≠ 0 → throw; mp3 없음 → `no_output` throw; 타임아웃 → throw.
- [ ] 실제 `uploadToBridge`는 `POST {base}/files`에 `Bearer`, `Content-Type: audio/mpeg`, `X-Filename` 전송하고 응답 `{url}` 반환.

**Verify:** `cd music-service && npm test` → validate/runner 테스트 PASS

**Steps:**

- [ ] **Step 1: 패키지 스캐폴드** — `music-service/package.json` (automation-service 미러)

```json
{
  "name": "music-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "test": "vitest --run"
  },
  "dependencies": {
    "fastify": "^4.28.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

  `music-service/tsconfig.json` (automation-service의 tsconfig 복사 — `cp ../automation-service/tsconfig.json music-service/tsconfig.json`). 그리고 `cd music-service && npm install`.

- [ ] **Step 2: auth 복제** — `music-service/src/auth.ts` = `automation-service/src/auth.ts` 내용 그대로(`cp ../automation-service/src/auth.ts music-service/src/auth.ts`). (`extractBearer`, `verifyToken` 제공.)

- [ ] **Step 3: validate 실패 테스트** — `music-service/tests/validate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolveSource } from '../src/validate.js';

describe('resolveSource', () => {
	it('http(s) URL은 url', () => {
		expect(resolveSource('https://www.youtube.com/watch?v=abc')).toEqual({ kind: 'url', value: 'https://www.youtube.com/watch?v=abc' });
	});
	it('일반 텍스트는 ytsearch1', () => {
		expect(resolveSource('Artist - Title')).toEqual({ kind: 'search', value: 'ytsearch1:Artist - Title' });
	});
	it('빈/대시시작/file:은 reject', () => {
		expect(resolveSource('').kind).toBe('reject');
		expect(resolveSource('   ').kind).toBe('reject');
		expect(resolveSource('-x --rm').kind).toBe('reject');
		expect(resolveSource('file:///etc/passwd').kind).toBe('reject');
	});
});
```

- [ ] **Step 4: validate 구현** — `music-service/src/validate.ts`

```ts
const SCHEME_RE = /^https?:\/\//i;

export type Resolved =
	| { kind: 'url'; value: string }
	| { kind: 'search'; value: string }
	| { kind: 'reject'; reason: string };

/**
 * source 검증. shell 미경유로 spawn 하므로 셸 인젝션은 무관 — 핵심 위협은
 * (1) yt-dlp 옵션 주입(선두 '-'), (2) 비-http 스킴(file: 등). 둘을 차단하고
 * 검색어는 ytsearch1: 접두로 강제해 옵션으로 해석될 여지를 없앤다.
 */
export function resolveSource(raw: string): Resolved {
	const s = (raw ?? '').trim();
	if (!s) return { kind: 'reject', reason: 'empty' };
	if (s.startsWith('-')) return { kind: 'reject', reason: 'leading_dash' };
	if (SCHEME_RE.test(s)) return { kind: 'url', value: s };
	if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { kind: 'reject', reason: 'bad_scheme' }; // file:, data: 등
	return { kind: 'search', value: `ytsearch1:${s}` };
}
```

- [ ] **Step 5: runner 실패 테스트** — `music-service/tests/runner.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract } from '../src/runner.js';

// args에서 --paths <dir>를 찾아 그 디렉토리에 mp3를 떨구고 종료코드로 닫는 가짜 spawn.
function fakeSpawn(exitCode: number, title = 'Song') {
	return (_cmd: string, args: string[]) => {
		const i = args.indexOf('--paths');
		const dir = i >= 0 ? args[i + 1] : '.';
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => {
			if (exitCode === 0) writeFileSync(join(dir, `${title}.mp3`), 'ID3DATA');
			child.emit('close', exitCode);
		});
		return child as never;
	};
}

const deps = (over: Partial<Parameters<typeof extract>[1]> = {}) => ({
	spawn: fakeSpawn(0) as never,
	bridgeFilesUrl: 'http://bridge',
	sharedToken: 'tok',
	uploadFn: vi.fn(async () => 'http://bridge/files/uuid/Song.mp3'),
	...over
});

describe('extract', () => {
	it('mp3 추출→업로드→{url,title}', async () => {
		const d = deps();
		const out = await extract('https://yt/abc', d);
		expect(out).toEqual({ url: 'http://bridge/files/uuid/Song.mp3', title: 'Song' });
		expect(d.uploadFn).toHaveBeenCalledOnce();
	});
	it('reject 소스는 bad_source throw', async () => {
		await expect(extract('-x', deps())).rejects.toThrow(/bad_source/);
	});
	it('yt-dlp 비정상 종료 → throw', async () => {
		await expect(extract('https://yt/abc', deps({ spawn: fakeSpawn(1) as never }))).rejects.toThrow();
	});
});
```

- [ ] **Step 6: runner 구현** — `music-service/src/runner.ts`

```ts
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSource } from './validate.js';

export interface ExtractOk { url: string; title: string; }
export interface RunnerDeps {
	spawn?: typeof nodeSpawn;
	bridgeFilesUrl: string;
	sharedToken: string;
	ytdlpPath?: string;
	timeoutMs?: number;
	maxFilesize?: string;
	uploadFn?: (mp3: Buffer, filename: string) => Promise<string>;
}

export async function extract(source: string, deps: RunnerDeps): Promise<ExtractOk> {
	const resolved = resolveSource(source);
	if (resolved.kind === 'reject') throw new Error(`bad_source:${resolved.reason}`);

	const dir = await mkdtemp(join(tmpdir(), 'music-'));
	try {
		await runYtdlp(resolved.value, dir, deps);
		const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.mp3'));
		if (files.length === 0) throw new Error('no_output');
		const filename = files[0];
		const mp3 = await readFile(join(dir, filename));
		const title = filename.replace(/\.mp3$/i, '');
		const upload = deps.uploadFn ?? ((b, fn) => uploadToBridge(b, fn, deps.bridgeFilesUrl, deps.sharedToken));
		const url = await upload(mp3, filename);
		return { url, title };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runYtdlp(arg: string, dir: string, deps: RunnerDeps): Promise<void> {
	const spawn = deps.spawn ?? nodeSpawn;
	const bin = deps.ytdlpPath ?? 'yt-dlp';
	const timeoutMs = deps.timeoutMs ?? 180_000;
	const maxFilesize = deps.maxFilesize ?? '40M';
	const args = [
		'-x', '--audio-format', 'mp3', '--embed-metadata', '--embed-thumbnail',
		'--no-playlist', '--no-exec', '--socket-timeout', '30',
		'--max-filesize', maxFilesize, '-o', '%(title)s.%(ext)s', '--paths', dir, arg
	];
	return new Promise((resolve, reject) => {
		const opts: SpawnOptions = { cwd: process.env.HOME, stdio: ['ignore', 'pipe', 'pipe'] };
		const child = spawn(bin, args, opts);
		let errOut = '';
		let settled = false;
		const fail = (msg: string) => {
			if (settled) return; settled = true; clearTimeout(timer);
			try { child.kill('SIGTERM'); } catch { /* gone */ }
			reject(new Error(msg));
		};
		const timer = setTimeout(() => fail('타임아웃'), timeoutMs);
		child.stderr?.on('data', (d: Buffer) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
		child.on('error', (e: Error) => fail(e.message));
		child.on('close', (code: number | null) => {
			if (settled) return; settled = true; clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
		});
	});
}

async function uploadToBridge(mp3: Buffer, filename: string, base: string, token: string): Promise<string> {
	const res = await fetch(`${base.replace(/\/$/, '')}/files`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'audio/mpeg',
			'X-Filename': encodeURIComponent(filename)
		},
		body: mp3
	});
	if (!res.ok) throw new Error(`upload_failed:${res.status}`);
	const j = (await res.json()) as { url?: string };
	if (!j.url) throw new Error('upload_no_url');
	return j.url;
}
```

- [ ] **Step 7: 테스트 통과 확인** — `cd music-service && npm test` → validate(3) + runner(3) PASS.

- [ ] **Step 8: 커밋**

```bash
git add music-service/package.json music-service/tsconfig.json music-service/src/validate.ts music-service/src/runner.ts music-service/src/auth.ts music-service/tests/
git commit -m "feat(music-service): source 검증 + yt-dlp 추출/업로드 러너"
```

---

### Task 7: `music-service` 서버 + 패키징 + 배포

**Goal:** `/extract` Fastify 엔드포인트(인증 + 에러 코드 매핑)와 boot, systemd 배포 파일을 추가해 서비스를 실행 가능하게 만든다.

**Files:**
- Create: `music-service/src/server.ts`
- Create: `music-service/deploy/music-service.service`
- Create: `music-service/deploy/README.md`
- Test: `music-service/tests/server.test.ts`

**Acceptance Criteria:**
- [ ] `POST /extract` Bearer 없음 → 401; `source` 없음 → 400; 정상 → 주입 `extractFn` 결과 200 `{url,title}`.
- [ ] `extractFn`이 `bad_source:*` throw → 400; `no_output`/기타 → 502; `타임아웃` → 504.
- [ ] boot 블록은 `BRIDGE_SHARED_TOKEN`·`BRIDGE_FILES_URL` 없으면 종료(automation server 미러).
- [ ] deploy `.service` + README가 systemd --user + env + canonical 경로 함정을 명시.

**Verify:** `cd music-service && npm test && npm run build` → 서버 테스트 PASS, tsc 0 errors

**Steps:**

- [ ] **Step 1: 서버 실패 테스트** — `music-service/tests/server.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { mintToken } from '../src/auth.js';

function app(extractFn: (s: string) => Promise<{ url: string; title: string }>) {
	return buildServer({ sharedToken: 'tok', bridgeFilesUrl: 'http://b', extractFn });
}
const auth = { authorization: `Bearer ${mintToken('tok')}` };

describe('POST /extract', () => {
	it('401 without bearer', async () => {
		const res = await app(async () => ({ url: 'u', title: 't' })).inject({ method: 'POST', url: '/extract', payload: { source: 'x' } });
		expect(res.statusCode).toBe(401);
	});
	it('400 on missing source', async () => {
		const res = await app(async () => ({ url: 'u', title: 't' })).inject({ method: 'POST', url: '/extract', headers: auth, payload: {} });
		expect(res.statusCode).toBe(400);
	});
	it('200 with {url,title}', async () => {
		const fn = vi.fn(async () => ({ url: 'http://b/files/x/y.mp3', title: 'Y' }));
		const res = await app(fn).inject({ method: 'POST', url: '/extract', headers: auth, payload: { source: 'https://yt/a' } });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ url: 'http://b/files/x/y.mp3', title: 'Y' });
		expect(fn).toHaveBeenCalledWith('https://yt/a');
	});
	it('400 on bad_source, 504 on 타임아웃, 502 otherwise', async () => {
		const mk = (msg: string) => app(async () => { throw new Error(msg); }).inject({ method: 'POST', url: '/extract', headers: auth, payload: { source: 'x' } });
		expect((await mk('bad_source:leading_dash')).statusCode).toBe(400);
		expect((await mk('타임아웃')).statusCode).toBe(504);
		expect((await mk('no_output')).statusCode).toBe(502);
	});
});
```

- [ ] **Step 2: 서버 실패 확인** — `cd music-service && npm test` → FAIL.

- [ ] **Step 3: 서버 구현** — `music-service/src/server.ts` (`automation-service/src/server.ts` 미러)

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { extractBearer, verifyToken } from './auth.js';
import { extract as defaultExtract, type RunnerDeps } from './runner.js';

const MAX_BYTES = Number(process.env.MUSIC_MAX_REQUEST_BYTES ?? 64 * 1024);

export interface BuildServerOpts {
	sharedToken: string;
	bridgeFilesUrl: string;
	runnerOpts?: Partial<RunnerDeps>;
	// 테스트 주입용. 미지정 시 실제 yt-dlp 러너.
	extractFn?: (source: string) => Promise<{ url: string; title: string }>;
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
	const app = Fastify({ logger: true, bodyLimit: MAX_BYTES });
	const runExtract = opts.extractFn
		?? ((source: string) => defaultExtract(source, {
			bridgeFilesUrl: opts.bridgeFilesUrl,
			sharedToken: opts.sharedToken,
			...opts.runnerOpts
		}));

	app.post('/extract', async (req, reply) => {
		const token = extractBearer(req.headers.authorization);
		if (!verifyToken(opts.sharedToken, token)) return reply.code(401).send({ error: 'unauthorized' });
		const body = req.body as { source?: unknown } | undefined;
		if (!body || typeof body.source !== 'string' || !body.source) {
			return reply.code(400).send({ error: 'bad_request', detail: 'source required' });
		}
		try {
			const out = await runExtract(body.source);
			return reply.code(200).send(out);
		} catch (err) {
			const msg = (err as Error).message;
			const code = msg.startsWith('bad_source') ? 400 : msg === '타임아웃' ? 504 : 502;
			return reply.code(code).send({ error: code === 400 ? 'bad_source' : 'extract_failed', detail: msg });
		}
	});

	return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
	if (!sharedToken) { console.error('BRIDGE_SHARED_TOKEN is required'); process.exit(1); }
	const bridgeFilesUrl = process.env.BRIDGE_FILES_URL;
	if (!bridgeFilesUrl) { console.error('BRIDGE_FILES_URL is required'); process.exit(1); }
	const runnerOpts: Partial<RunnerDeps> = {
		ytdlpPath: process.env.YTDLP_PATH,
		maxFilesize: process.env.MUSIC_MAX_FILESIZE ?? '40M',
		timeoutMs: Number(process.env.MUSIC_TIMEOUT_MS ?? 180_000)
	};
	const port = Number(process.env.MUSIC_SERVICE_PORT ?? 7844);
	const app = buildServer({ sharedToken, bridgeFilesUrl, runnerOpts });
	app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`music-service on :${port}`));
}
```

- [ ] **Step 4: 배포 파일** — `music-service/deploy/music-service.service` (automation-service.service 미러; canonical 경로 — `/home`→`/var/home` 심볼릭링크 함정 회피)

```ini
[Unit]
Description=tomboy music-service (yt-dlp → mp3 → bridge)
After=network-online.target

[Service]
Type=simple
# canonical 경로 필수: /home → /var/home 심볼릭링크가 entry 가드(import.meta.url)를
# 깨뜨리므로 fnm node + dist/server.js 모두 실제(/var/home) 경로로 지정.
EnvironmentFile=%h/.config/music-service.env
ExecStart=/var/home/umayloveme/.local/share/fnm/aliases/default/bin/node /var/home/umayloveme/workspace/tomboy-web/music-service/dist/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

  `music-service/deploy/README.md` — 핵심만:
  ```markdown
  # music-service 배포 (데스크탑 전용)

  yt-dlp 영상 → mp3 추출 후 브릿지 `/files`에 업로드. **개인·자기 호스팅, 권리 보유 콘텐츠 전제.**

  ## 선행
  - 호스트에 `yt-dlp`, `ffmpeg` 설치 (`yt-dlp --version`, `ffmpeg -version`).
  - `~/.config/music-service.env`:
    ```
    BRIDGE_SHARED_TOKEN=<= BRIDGE_SECRET 와 동일>
    BRIDGE_FILES_URL=https://<bridge-public-host>
    MUSIC_SERVICE_PORT=7844
    YTDLP_PATH=/usr/local/bin/yt-dlp   # PATH에 있으면 생략
    MUSIC_MAX_FILESIZE=40M
    MUSIC_TIMEOUT_MS=180000
    ```
  - 브릿지(Pi) `~/.config/term-bridge.env`에 `MUSIC_SERVICE_URL=http://<desktop-LAN-IP>:7844` 추가 후 브릿지 재기동.

  ## 빌드·기동
  ```bash
  cd music-service && npm install && npm run build
  cp deploy/music-service.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now music-service.service
  systemctl --user status music-service.service
  ```

  ## 함정 (automation-service와 동일)
  - **canonical 경로**: `/home`→`/var/home` 심볼릭링크 때문에 `.service`의 node·dist 경로는
    반드시 `/var/home/...` 실제 경로. 심볼릭 경로면 `import.meta.url` entry 가드가 깨져 서버가
    안 뜬다.
  - **fnm node**: 시스템 node가 아니라 fnm default alias의 node 절대경로 사용.
  ```

- [ ] **Step 5: 테스트 + 빌드 확인** — `cd music-service && npm test && npm run build` → 서버 테스트 PASS(4), tsc 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add music-service/src/server.ts music-service/tests/server.test.ts music-service/deploy/
git commit -m "feat(music-service): /extract 서버 + systemd 배포"
```

---

### Task 8: 가이드 카드 + 스킬 + CLAUDE.md 색인

**Goal:** 사용자 발견 surface(설정→가이드)에 `음악추출::` 카드를 추가하고, `tomboy-musicextract` 스킬과 CLAUDE.md 색인을 등록한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`notes` 서브탭에 guide-card 추가)
- Create: `.claude/skills/tomboy-musicextract/SKILL.md`
- Modify: `CLAUDE.md` (스킬 색인 표에 한 줄)

**Acceptance Criteria:**
- [ ] 설정→가이드(notes)에 `<details class="guide-card">` 추가: `음악추출::` 사용법, 멱등 규칙, 선행조건(music-service + `MUSIC_SERVICE_URL`), 권리 보유 전제, 재생은 `음악::`로 수동 구성.
- [ ] `.claude/skills/tomboy-musicextract/SKILL.md` 생성(불변식: 멱등=`/files` URL, 보안 경계, 배포 함정).
- [ ] `CLAUDE.md` 스킬 색인 표에 `tomboy-musicextract` 행 추가.
- [ ] `cd app && npm run check` → 0 errors(가이드 마크업 추가가 타입/컴파일 깨지 않음).

**Verify:** `cd app && npm run check` → 0 errors; `npm run dev`로 설정→가이드(notes)에서 카드 육안 확인.

**Steps:**

- [ ] **Step 1: 가이드 카드 추가** — `app/src/routes/settings/+page.svelte`. `guideSubTab === 'notes'` 영역에서 `음악::` 카드(있다면) 인접 또는 notes 카드 목록 끝에 삽입. 기존 카드 패턴(짧은 `<summary>`, `<p class="info-text">`, `<pre class="snippet">`, `<ul class="guide-list">`) 미러:

```svelte
<details class="guide-card">
	<summary>음악추출:: — YouTube를 mp3로 모으기</summary>
	<p class="info-text">
		<code>음악추출::</code> 로 시작하는 노트는 작업대예요. 영상 URL이나 검색어를 리스트로
		적고 <b>⟳ 진행</b>을 누르면, 데스크탑에서 mp3로 추출해 브릿지에 저장하고 그 주소를 항목
		밑에 채워 줍니다. 추출된 곡은 일반 음악처럼 백그라운드·잠금화면 재생이 돼요.
	</p>
	<pre class="snippet">음악추출::내 라이브러리

- https://www.youtube.com/watch?v=…
- Artist - Title          (검색어도 가능)</pre>
	<ul class="guide-list">
		<li>⟳ 는 <b>결과가 아직 없는 항목만</b> 처리해요. 소스를 더 추가하고 다시 눌러도
			이미 받은 곡은 건너뜁니다.</li>
		<li>재생하려면 채워진 링크를 <code>음악::</code> 노트로 복사해 구성하세요(수동).</li>
		<li>선행: 데스크탑 <code>music-service</code> 실행 + 브릿지 <code>MUSIC_SERVICE_URL</code>
			설정. 미설정이면 "연결할 수 없습니다" 안내가 떠요.</li>
		<li>개인·자기 호스팅 도구입니다. <b>본인이 권리를 가진 콘텐츠</b>(내 업로드/CC/퍼블릭
			도메인)에만 사용하세요.</li>
	</ul>
</details>
```

- [ ] **Step 2: 스킬 생성** — `.claude/skills/tomboy-musicextract/SKILL.md`

```markdown
---
name: tomboy-musicextract
description: 음악추출:: 노트 — YouTube 영상을 데스크탑 yt-dlp로 mp3 추출, 브릿지 /files 저장, 멱등 채움
---

# tomboy-musicextract

`음악추출::` 작업대 노트. 영상 URL/검색어 리스트 → ⟳ → 데스크탑 yt-dlp → mp3 → 브릿지 `/files` →
결과 URL을 항목 자식에 기록. 재생은 `음악::` 노트로 수동 구성.

## 경로
- 앱: `app/src/lib/musicExtract/{parseExtractNote,extractClient,writeExtractResult}.ts`,
  `app/src/lib/editor/musicExtractNote/{musicExtractNotePlugin,runExtractButtonClick,index}.ts`
- 브릿지: `bridge/src/music.ts` (`/music/extract` relay)
- 데스크탑: `music-service/` (yt-dlp + Fastify `/extract`)

## 불변식
- **멱등 판정 = `/files/<uuid>/` URL 결과 자식의 유무.** 있으면 done(skip), 없으면(신규/실패)
  ⟳ 때 재시도. 실패는 `❌ …` 텍스트 자식이라 URL이 없어 자동 재시도된다.
- **저장·서빙은 기존 브릿지 `/files` 재사용** — Range·`audio/mpeg` MIME·무토큰(추측 불가 UUID)
  다운로드가 이미 있어 `<audio src>`로 직접 재생. 새 저장 코드 없음.
- **보안 경계는 automation보다 약하다** — 소스 문자열을 노트가 직접 보냄. `music-service`가
  shell 미경유 spawn + `resolveSource` allowlist(선두 `-`/비-http 스킴 거부, 검색어 `ytsearch1:`
  강제) + `--no-playlist`/`--max-filesize`/타임아웃으로 완화.
- **데스크탑 전용·개인용.** Vercel 함수 금지. 권리 보유 콘텐츠 전제.
- **항목별 동기**: 앱이 대기 항목을 하나씩 `extractOne` → `writeExtractResult`. 다운로드가 길어
  배치 대신 순차(진행 가시성 + 부분 실패 격리).

## 배포 함정
- `/home`→`/var/home` 심볼릭링크가 `import.meta.url` entry 가드를 깨뜨림 → `.service`의 node·dist
  경로는 canonical `/var/home/...`. fnm default alias node 절대경로 사용. (automation-service 동일.)
- 브릿지 `MUSIC_SERVICE_URL`, 서비스 `BRIDGE_FILES_URL`/`BRIDGE_SHARED_TOKEN` 정렬 필수.

스펙: `docs/superpowers/specs/2026-06-05-music-extract-design.md`
```

- [ ] **Step 3: CLAUDE.md 색인** — `CLAUDE.md`(루트)의 스킬 색인 표에서 `tomboy-dataautomation` 행 다음에 추가:

```markdown
| `tomboy-musicextract` | `음악추출::` 노트 ⟳ → 데스크탑 yt-dlp → mp3 → 브릿지 `/files` 저장·재생 | `lib/musicExtract/`, `lib/editor/musicExtractNote/`, `bridge/src/music.ts`, `music-service/` |
```

- [ ] **Step 4: 타입 확인** — `cd app && npm run check` → 0 errors.

- [ ] **Step 5: 커밋**

```bash
git add app/src/routes/settings/+page.svelte .claude/skills/tomboy-musicextract/SKILL.md CLAUDE.md
git commit -m "docs(musicExtract): 가이드 카드 + tomboy-musicextract 스킬 + 색인"
```

---

## Self-Review

**Spec coverage:** 결정사항 1–10 매핑 — 노트포맷/한줄=한소스/결과자식링크/멱등(1–4)=Task1·3; 항목별동기(5)=Task4; `/files`재사용(6)=Task6·설계; relay(7)=Task5; music-service(8)=Task6·7; 자동생성없음(9)=전반(미생성); 운영/법적(10)=Task7 README·Task8 가이드/스킬. 컴포넌트 A–F = Task6·7(A), 5(B), 1·2·3(C), 4(D), 8(E·F). 갭 없음.

**Placeholder scan:** 모든 step에 실제 코드/명령/기대출력 포함. "적절히"/"TBD"/"등" 미사용. `cp` 복제는 대상 파일을 명시.

**Type consistency:** `ExtractResult`/`ExtractItem`/`ExtractNote`(Task1) ↔ `pendingItems`(Task1·4) ↔ `ResultPayload`(Task3) ↔ `ExtractOk`/`ExtractError`/`ExtractErrorKind`(Task2·4) ↔ `RunnerDeps`/`extract`(Task6·7) ↔ `handleMusicExtract`(Task5) 시그니처 일치. `RESULT_URL_RE`(`/files/<uuid>/`)는 Task1·3에서 동일. 브릿지 `MUSIC_SERVICE_URL`·서비스 `BRIDGE_FILES_URL`·`MUSIC_SERVICE_PORT 7844` 전 Task 일관.

## 비목표 (스펙과 동일)
Spotify·플레이리스트 자동확장·자동 재생노트 생성·진행률 바/SSE·mp3 자동 정리·dedupe·검색 다건 선택은 명시적 후속.
