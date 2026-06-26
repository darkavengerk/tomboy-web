# 관전 세션 피커 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빈 `spectate:` 노트를 세션 런처로 만들어, 버튼 탭 → 브릿지가 타겟의 tmux 세션 목록을 가져와 팝업으로 보여주고, 선택한 세션을 (휘발적으로) 관전한다.

**Architecture:** 파서가 값 없는 `spectate:`를 `spectatePicker` 플래그로 인식. 브릿지에 인증된 `POST /sessions` 추가 — ssh 1회로 `tmux list-panes -a -F` 실행 후 순수 함수로 세션별 집계. `TerminalView`는 피커 노트에서 초기 연결을 보류하고 "세션 선택" 버튼 → fetch → 모달 → 선택 시 기존 `reconnect()` 프리미티브로 그 세션에 연결. 선택은 런타임 상태일 뿐 노트 본문은 불변.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap JSON 파서, Node `ws`/`http` 브릿지, vitest(app) + `node --test`(bridge).

---

## File Structure

| File | 책임 |
|---|---|
| `app/src/lib/editor/terminal/parseTerminalNote.ts` | 빈 `spectate:` → `spectatePicker` 인식, 중복 가드 |
| `bridge/src/sessionList.ts` (신규) | `parseSessionList`(순수) + `coerceTarget`(보안) + `listSessions`(spawn) + `handleSessionList`(라우트) + `SessionInfo` |
| `bridge/src/server.ts` | `POST /sessions` 한 줄 라우트 |
| `app/src/lib/editor/terminal/bridgeSettings.ts` | `fetchSessions`(클라 HTTP) + `SessionInfo` 미러 타입 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | picker 분기/상태, 초기연결 보류, "세션 선택"/"세션 변경" 버튼, 모달 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드(notes 탭) |

---

### Task 1: 파서 — 빈 `spectate:` → `spectatePicker`

**Goal:** 값 없는 `spectate:` 라인을 picker 모드로 인식하고, 고정 세션/핀 동작은 100% 보존한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/parseTerminalNote.ts`
- Test: `app/tests/unit/editor/parseTerminalNote.test.ts`

**Acceptance Criteria:**
- [ ] 빈 `spectate:` (값 없음, 후행 공백 허용) → `spec.spectatePicker === true`, `spec.spectate === undefined`, `spec.pinnedPane === undefined`.
- [ ] `spectate: main` / `spectate: main:3` 기존 동작 불변 (`spectatePicker` 미설정/undefined).
- [ ] `spectate:` 라인 2개(둘 다 빈 값이든, 하나는 값이든) → 노트 거부(`null`).
- [ ] 기존 파서 테스트 전부 통과(회귀 없음).

**Verify:** `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 추가** — `app/tests/unit/editor/parseTerminalNote.test.ts` 끝에 추가. 파일 상단의 기존 헬퍼(doc/paragraph 빌더)를 재사용한다. 기존 테스트가 `parseTerminalNote(doc)` 에 어떤 doc 형태를 넘기는지 보고 동일 패턴으로 작성할 것. 본질은 아래 케이스:

```ts
import { describe, it, expect } from 'vitest';
import { parseTerminalNote } from '$lib/editor/terminal/parseTerminalNote';

// 헬퍼: 첫 블록은 제목(파서가 slice(1) 하므로 아무 단락), 이후 메타 단락들.
function p(text: string) {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined };
}
function termDoc(...lines: string[]) {
	return { type: 'doc', content: [p('제목'), ...lines.map(p)] };
}

describe('parseTerminalNote — spectate picker (empty spectate:)', () => {
	it('빈 spectate: → spectatePicker, spectate undefined', () => {
		const spec = parseTerminalNote(termDoc('ssh://you@desktop', 'spectate:'));
		expect(spec).not.toBeNull();
		expect(spec!.spectatePicker).toBe(true);
		expect(spec!.spectate).toBeUndefined();
		expect(spec!.pinnedPane).toBeUndefined();
	});

	it('빈 spectate: 후행 공백도 picker', () => {
		const spec = parseTerminalNote(termDoc('ssh://you@desktop', 'spectate:   '));
		expect(spec!.spectatePicker).toBe(true);
	});

	it('값 있는 spectate: 는 picker 아님', () => {
		const spec = parseTerminalNote(termDoc('ssh://you@desktop', 'spectate: main'));
		expect(spec!.spectate).toBe('main');
		expect(spec!.spectatePicker).toBeFalsy();
	});

	it('spectate: main:3 핀 동작 불변', () => {
		const spec = parseTerminalNote(termDoc('ssh://you@desktop', 'spectate: main:3'));
		expect(spec!.spectate).toBe('main');
		expect(spec!.pinnedPane).toBe(3);
		expect(spec!.spectatePicker).toBeFalsy();
	});

	it('spectate: 라인 2개는 거부', () => {
		expect(parseTerminalNote(termDoc('ssh://you@desktop', 'spectate:', 'spectate: main'))).toBeNull();
		expect(parseTerminalNote(termDoc('ssh://you@desktop', 'spectate:', 'spectate:'))).toBeNull();
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts` → 새 케이스 FAIL (현재 빈 `spectate:`는 노트를 reject 하므로 `spec` 이 null).

- [ ] **Step 3: 파서 수정** — `parseTerminalNote.ts`:

  (a) `SPECTATE_RE` 의 `+` → `*` (빈 값 허용):
```ts
const SPECTATE_RE = /^spectate:\s*([A-Za-z0-9_\-./@:]*)\s*$/;
```

  (b) `TerminalNoteSpec` 인터페이스에 필드 추가 (기존 `spectate?` 주석 근처):
```ts
	/**
	 * Picker(런처) 모드: 본문에 값 없는 `spectate:` 라인이 있을 때 true.
	 * `spectate` 는 undefined — 사용자가 런타임에 브릿지 세션 목록에서 고른다.
	 * 선택은 휘발적이라 노트 본문에 박히지 않는다.
	 */
	spectatePicker?: boolean;
```

  (c) 메타 루프의 spectate 처리 블록 교체. 기존:
```ts
		let bridge: string | undefined;
		let spectate: string | undefined;
		let pinnedPane: number | undefined;
```
  를 →
```ts
		let bridge: string | undefined;
		let spectate: string | undefined;
		let pinnedPane: number | undefined;
		let spectatePicker = false;
		let sawSpectate = false;
```
  그리고 spectate 매칭 블록 (기존 `if (spectate !== undefined) return null;` 으로 중복 판정하던 부분) 교체:
```ts
			const spectateMatch = SPECTATE_RE.exec(text);
			if (spectateMatch) {
				if (sawSpectate) return null; // 중복 spectate: 라인 거부 (값 유무 무관)
				sawSpectate = true;
				const raw = spectateMatch[1];
				if (raw === '') {
					spectatePicker = true;
				} else {
					const pinMatch = /^(.+):(\d+)$/.exec(raw);
					if (pinMatch) {
						const n = Number(pinMatch[2]);
						if (Number.isInteger(n) && n >= 1 && n <= 5) {
							spectate = pinMatch[1];
							pinnedPane = n;
						} else {
							spectate = pinMatch[1];
						}
					} else {
						spectate = raw;
					}
				}
				continue;
			}
```

  (d) return 객체에 필드 추가:
```ts
		return {
			target: line1.trim(),
			host,
			port,
			user,
			bridge,
			spectate,
			spectatePicker: spectatePicker || undefined,
			histories,
			history,
			connect: connect ?? [],
			pinneds,
			pinnedPane
		};
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npx vitest run tests/unit/editor/parseTerminalNote.test.ts` → PASS (신규 + 기존 전부).

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/terminal/parseTerminalNote.ts app/tests/unit/editor/parseTerminalNote.test.ts
git commit -m "feat(terminal): parse empty spectate: as picker mode"
```

---

### Task 2: 브릿지 — `parseSessionList` + `coerceTarget` + `listSessions` + `POST /sessions`

**Goal:** 인증된 `POST /sessions` 가 타겟의 tmux 세션 목록을 JSON 으로 반환한다. 파싱/검증은 순수 함수로 분리해 테스트한다.

**Files:**
- Create: `bridge/src/sessionList.ts`
- Create: `bridge/src/sessionList.test.ts`
- Modify: `bridge/src/server.ts` (import + 라우트 한 줄)

**Acceptance Criteria:**
- [ ] `parseSessionList(stdout)` — 멀티 세션/멀티 윈도우·패널 입력에서 세션당 1행 dedup, active-window+active-pane 행의 명령어를 `command` 로, `attached` boolean, 필드 부족 행 스킵.
- [ ] `coerceTarget` — 정상 `{host}`/`{user,host,port}` 통과, **leading-dash host/user 거부**, 공백·`/`·`@`·`:` 포함 거부, 범위 밖 포트 거부.
- [ ] `POST /sessions` — Bearer 검증(없거나 틀리면 401), 잘못된 body 400, `listSessions` 실패 시 502 `{error:'unreachable'}`, 성공 시 `{sessions:[...]}`.
- [ ] tmux 서버 미실행(stderr `no server running`) → 200 + 빈 배열.

**Verify:** `cd bridge && npm test` → PASS (전체 그린; 신규 sessionList.test.ts 포함)

**Steps:**

- [ ] **Step 1: 순수 함수 실패 테스트** — `bridge/src/sessionList.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionList, coerceTarget } from './sessionList.js';

const TAB = '\t';
function row(parts: string[]): string {
	return parts.join(TAB);
}

test('parseSessionList: single session, active pane command', () => {
	const out = [
		row(['claudesquad_fixauth', '2', '1', '1700000000', '1', '1', 'claude']),
		row(['claudesquad_fixauth', '2', '1', '1700000000', '0', '0', 'bash'])
	].join('\n');
	const sessions = parseSessionList(out);
	assert.equal(sessions.length, 1);
	assert.deepEqual(sessions[0], {
		name: 'claudesquad_fixauth',
		windows: 2,
		attached: true,
		activity: 1700000000,
		command: 'claude'
	});
});

test('parseSessionList: multiple sessions keep first-seen order', () => {
	const out = [
		row(['main', '3', '1', '10', '1', '1', 'vim']),
		row(['docs', '1', '0', '20', '1', '1', 'bash'])
	].join('\n');
	const sessions = parseSessionList(out);
	assert.deepEqual(sessions.map((s) => s.name), ['main', 'docs']);
	assert.equal(sessions[1].attached, false);
	assert.equal(sessions[1].command, 'bash');
});

test('parseSessionList: command only from active window+pane', () => {
	const out = [
		row(['s', '2', '0', '0', '0', '1', 'htop']), // inactive window, active pane → ignore
		row(['s', '2', '0', '0', '1', '0', 'less']), // active window, inactive pane → ignore
		row(['s', '2', '0', '0', '1', '1', 'claude']) // both active → use
	].join('\n');
	assert.equal(parseSessionList(out)[0].command, 'claude');
});

test('parseSessionList: malformed / short rows skipped', () => {
	const out = ['justname', 'a\tb\tc', '', row(['ok', '1', '1', '0', '1', '1', 'sh'])].join('\n');
	const sessions = parseSessionList(out);
	assert.deepEqual(sessions.map((s) => s.name), ['ok']);
});

test('parseSessionList: empty stdout → []', () => {
	assert.deepEqual(parseSessionList(''), []);
});

test('parseSessionList: strips trailing CR', () => {
	const out = row(['s', '1', '1', '0', '1', '1', 'sh']) + '\r';
	assert.equal(parseSessionList(out)[0].command, 'sh');
});

test('coerceTarget: valid host-only and full', () => {
	assert.deepEqual(coerceTarget({ host: 'desktop.lan' }), {
		host: 'desktop.lan',
		user: undefined,
		port: undefined
	});
	assert.deepEqual(coerceTarget({ user: 'you', host: '192.168.0.5', port: 2222 }), {
		user: 'you',
		host: '192.168.0.5',
		port: 2222
	});
});

test('coerceTarget: rejects leading-dash host (ssh flag injection)', () => {
	assert.equal(coerceTarget({ host: '-oProxyCommand=evil' }), null);
	assert.equal(coerceTarget({ user: '-x', host: 'h' }), null);
});

test('coerceTarget: rejects bad chars and bad port', () => {
	assert.equal(coerceTarget({ host: 'a b' }), null);
	assert.equal(coerceTarget({ host: 'a/b' }), null);
	assert.equal(coerceTarget({ host: 'h', port: 70000 }), null);
	assert.equal(coerceTarget({ host: '' }), null);
	assert.equal(coerceTarget(null), null);
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd bridge && npx tsx --test src/sessionList.test.ts` → FAIL (`sessionList.js` 없음).

- [ ] **Step 3: `bridge/src/sessionList.ts` 작성:**
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractBearer, verifyToken } from './auth.js';
import { isLocalTarget, buildSshExecArgs, type SshTarget } from './pty.js';

const execFileP = promisify(execFile);

export interface SessionInfo {
	name: string;
	windows: number;
	attached: boolean;
	activity: number;
	command: string;
}

// 탭 구분 7필드. window/pane active 플래그로 active 패널의 현재 명령어를 고른다.
const PANE_FMT =
	'#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{window_active}\t#{pane_active}\t#{pane_current_command}';

/** stdout(탭 구분) → 세션별 집계. 순수 함수. */
export function parseSessionList(stdout: string): SessionInfo[] {
	const bySession = new Map<string, SessionInfo>();
	const order: string[] = [];
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line) continue;
		const parts = line.split('\t');
		if (parts.length < 7) continue;
		const [name, winsRaw, attachedRaw, activityRaw, winActive, paneActive, command] = parts;
		if (!name) continue;
		if (!bySession.has(name)) {
			bySession.set(name, {
				name,
				windows: Number(winsRaw) || 0,
				attached: attachedRaw === '1',
				activity: Number(activityRaw) || 0,
				command: ''
			});
			order.push(name);
		}
		if (winActive === '1' && paneActive === '1') {
			bySession.get(name)!.command = command ?? '';
		}
	}
	return order.map((n) => bySession.get(n)!);
}

// host/user: 선두 대시 금지(ssh 플래그 인젝션 차단) + 공백/슬래시/@/콜론 금지.
const NAME_RE = /^[^-\s/@:][^\s/@:]*$/;

/** 신뢰 못 할 body.target → 검증된 SshTarget 또는 null. 보안 경계. */
export function coerceTarget(raw: unknown): SshTarget | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const host = typeof o.host === 'string' ? o.host : '';
	if (!NAME_RE.test(host)) return null;
	let user: string | undefined;
	if (o.user !== undefined && o.user !== null) {
		if (typeof o.user !== 'string' || !NAME_RE.test(o.user)) return null;
		user = o.user;
	}
	let port: number | undefined;
	if (o.port !== undefined && o.port !== null) {
		const p = Number(o.port);
		if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
		port = p;
	}
	return { host, user, port };
}

/** 타겟의 tmux 세션 목록. 로컬이면 tmux 직접, 원격이면 ssh 일회성 exec. */
export async function listSessions(t: SshTarget): Promise<SessionInfo[]> {
	const opts = { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 } as const;
	try {
		let stdout: string;
		if (isLocalTarget(t)) {
			({ stdout } = await execFileP('tmux', ['list-panes', '-a', '-F', PANE_FMT], opts));
		} else {
			const args = buildSshExecArgs(t, undefined, `tmux list-panes -a -F '${PANE_FMT}'`);
			({ stdout } = await execFileP('ssh', args, opts));
		}
		return parseSessionList(stdout);
	} catch (err) {
		const stderr = String((err as { stderr?: unknown }).stderr ?? '');
		if (/no server running/i.test(stderr)) return []; // tmux 미실행 = 빈 목록
		throw err; // ssh 도달 불가 등 → 호출 측 502
	}
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

/** POST /sessions — Bearer 검증 후 타겟의 tmux 세션 목록 반환. */
export async function handleSessionList(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	let body: { target?: unknown };
	try {
		body = (await readJson(req)) as { target?: unknown };
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const target = coerceTarget(body.target);
	if (!target) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'invalid_target' }));
		return;
	}
	try {
		const sessions = await listSessions(target);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ sessions }));
	} catch (err) {
		console.warn(`[term-bridge sessions] ${(err as Error).message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unreachable' }));
	}
}
```

- [ ] **Step 4: 라우트 배선** — `bridge/src/server.ts`:

  import 추가 (기존 import 그룹 근처, `./pty.js` import 아래):
```ts
import { handleSessionList } from './sessionList.js';
```
  `handleHttp` 안, `/automation/run` 분기 근처에 추가:
```ts
	if (url === '/sessions' && req.method === 'POST') {
		await handleSessionList(req, res, SECRET);
		return;
	}
```

- [ ] **Step 5: 통과 확인** — Run: `cd bridge && npm test` → PASS (전체). 빌드 확인: `cd bridge && npx tsc -p . --noEmit` → 에러 없음.

- [ ] **Step 6: 커밋**
```bash
git add bridge/src/sessionList.ts bridge/src/sessionList.test.ts bridge/src/server.ts
git commit -m "feat(bridge): POST /sessions — list tmux sessions on target"
```

---

### Task 3: 클라 — `fetchSessions` + `SessionInfo`

**Goal:** 앱에서 `POST /sessions` 를 호출해 세션 목록을 가져오는 얇은 HTTP 헬퍼.

**Files:**
- Modify: `app/src/lib/editor/terminal/bridgeSettings.ts`

**Acceptance Criteria:**
- [ ] `fetchSessions(bridge, token, target)` — `bridgeToHttpBase` 로 base 유도, `Authorization: Bearer`, `{target}` body POST, 200 → `sessions` 배열, 비-200 → throw, 배열 아니면 `[]`.
- [ ] `SessionInfo` 타입이 브릿지 형태(name/windows/attached/activity/command)와 일치.
- [ ] `npm run check` 통과(타입 OK).

**Verify:** `cd app && npm run check` → 신규 에러 0

**Steps:**

- [ ] **Step 1: `bridgeSettings.ts` 끝에 추가:**
```ts
export interface SessionInfo {
	name: string;
	windows: number;
	attached: boolean;
	activity: number;
	command: string;
}

/**
 * POST /sessions — 타겟의 tmux 세션 목록. 비-200 은 throw (호출 측이 한글
 * 에러 토스트). target 은 SSH_RE 로 이미 검증된 구조화 필드만 넘긴다.
 */
export async function fetchSessions(
	bridge: string,
	token: string,
	target: { user?: string; host: string; port?: number }
): Promise<SessionInfo[]> {
	const base = bridgeToHttpBase(bridge);
	const res = await fetch(base + '/sessions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ target })
	});
	if (!res.ok) throw new Error(`sessions_failed_${res.status}`);
	const data = (await res.json().catch(() => null)) as { sessions?: SessionInfo[] } | null;
	return Array.isArray(data?.sessions) ? data!.sessions : [];
}
```

- [ ] **Step 2: 타입 확인** — Run: `cd app && npm run check` → 신규 에러 없음.

- [ ] **Step 3: 커밋**
```bash
git add app/src/lib/editor/terminal/bridgeSettings.ts
git commit -m "feat(terminal): fetchSessions client helper for POST /sessions"
```

---

### Task 4: TerminalView — picker 분기 + "세션 선택"/"세션 변경" + 모달

**Goal:** 빈 `spectate:` 노트는 초기 연결을 보류하고 "세션 선택" 버튼만 보여준다. 탭 → 세션 목록 모달 → 선택 시 그 세션을 관전. "세션 변경" 으로 갈아타기. 선택은 휘발(노트 본문 불변). 고정 세션 노트 동작은 0 변경.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] `isSpectator` 가 `spectatePicker` 도 포함 → 빈 `spectate:` 노트가 셸 노트로 오인되지 않음.
- [ ] picker 노트 + 미선택 → 초기 WS 연결 안 함. 중앙 "세션 선택" 버튼 + 안내 배너.
- [ ] "세션 선택" 탭 → `fetchSessions` → 모달에 행(`name · N창 · ●붙음/○ · command`) 렌더. 로딩/에러/빈목록 한글 표시.
- [ ] 행 선택 → 그 세션 관전 시작. 헤더 라벨이 선택 세션명 표시.
- [ ] 관전 중 헤더 "세션 변경" → 모달 재오픈 → 재선택 시 기존 연결 teardown 후 새 세션 연결.
- [ ] 고정 세션 노트(`spec.spectate` 있음): "세션 선택"/"세션 변경"/모달 미노출, 기존과 동일.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → 신규 에러 0. (수동: `npm run dev` 로 빈 `spectate:` 노트 열어 버튼→모달→선택 확인.)

**Steps:**

- [ ] **Step 1: `isSpectator` 확장** — L88 근처:
```ts
	const isSpectator = $derived(!!spec.spectate || !!spec.spectatePicker);
```

- [ ] **Step 2: 상태 + 파생 추가** — 스크립트 상단 상태 선언부(예: `sendPopupOpen` 근처)에 추가:
```ts
	// 세션 피커(런처) — 빈 spectate: 노트. 선택은 휘발(노트 본문 불변).
	let selectedSession = $state<string | null>(null);
	const effectiveSession = $derived(spec.spectate ?? selectedSession ?? undefined);
	const awaitingPick = $derived(!!spec.spectatePicker && !selectedSession);
	let pickerOpen = $state(false);
	let pickerLoading = $state(false);
	let pickerError = $state('');
	let pickerSessions = $state<SessionInfo[]>([]);
```
  그리고 import 에 `SessionInfo` + `fetchSessions` 추가 (기존 `bridgeSettings` import 라인에 병합):
```ts
	import { /* 기존들, */ fetchSessions, type SessionInfo } from '$lib/editor/terminal/bridgeSettings.js';
```

- [ ] **Step 3: 라이브 세션명을 `effectiveSession` 으로 교체** — 아래 grep 으로 전 지점 확인 후 각각 `spec.spectate` → `effectiveSession`:

  Run: `grep -n "spec.spectate" app/src/lib/editor/terminal/TerminalView.svelte`

  교체 대상(라이브 세션값으로 쓰이는 곳):
  - onMount `TerminalWsClient({ … spectate: spec.spectate … })` → `spectate: effectiveSession`
  - reconnect `TerminalWsClient({ … spectate: spec.spectate … })` → `spectate: effectiveSession`
  - `const sessionName = spec.spectate` (있으면) → `const sessionName = effectiveSession`
  - 그 외 라이브 세션 참조 전부.

  **단, 분기 가드로서의 `spec.spectatePicker`/`spec.spectate` 구분이 필요한 곳(헤더 버튼 노출 조건 등)은 Step 6 에서 별도 처리** — 무지성 전체 치환 금지.

- [ ] **Step 4: 초기 연결 보류** — onMount 의 `client = new TerminalWsClient({…}); client.connect();` (L884–943 블록) 을 `awaitingPick` 가드로 감싼다:
```ts
		if (!awaitingPick) {
			client = new TerminalWsClient({
				// …기존 옵션 그대로 (spectate: effectiveSession)…
			});
			client.connect();
		}
```
  `awaitingPick` 가 true 면 client 를 만들지 않는다. term 생성/스크롤 와이어링은 그대로 둔다(term 은 한 번만 생성, reconnect 가 재사용). 또한 picker 미선택 상태의 status 표시를 위해, 이 가드 직후:
```ts
		if (awaitingPick) {
			status = 'closed';
			statusMessage = '';
		}
```
  (헤더/배너는 Step 6 에서 `awaitingPick` 분기로 "세션 미선택"/안내문 출력.)

- [ ] **Step 5: `selectSession` 함수 추가** — 스크립트에 추가(`reconnect` 근처):
```ts
	async function openPicker() {
		if (!resolvedBridge || !resolvedToken) return;
		pickerOpen = true;
		pickerError = '';
		pickerLoading = true;
		try {
			pickerSessions = await fetchSessions(resolvedBridge, resolvedToken, {
				user: spec.user,
				host: spec.host,
				port: spec.port
			});
		} catch {
			pickerError = '데스크탑에 연결할 수 없습니다 (꺼져 있거나 네트워크 문제).';
		} finally {
			pickerLoading = false;
		}
	}
	function closePicker() {
		pickerOpen = false;
	}
	function selectSession(name: string) {
		pickerOpen = false;
		selectedSession = name; // effectiveSession 갱신 → reconnect 가 그 세션에 연결
		reconnect(); // teardown(있으면) + 새 세션 연결. resolvedBridge/Token 은 onMount 에서 세팅됨.
	}
```
  주: `reconnect()` 는 `resolvedBridge && resolvedToken` 가 있어야 동작 — picker 노트도 onMount 에서 둘 다 세팅 후 보류했으므로 충족.

- [ ] **Step 6: 마크업** — 헤더 + 본문 오버레이 + 모달.

  (a) **헤더 라벨** (L1131–1134 spectator 헤더). `spec.spectate` 직접 출력을 `effectiveSession` 로 바꾸고 미선택 표시 + "세션 변경" 버튼:
```svelte
		{#if isSpectator}
			<div class="target">
				<span class="label">관전</span>
				<code>tmux {effectiveSession ?? '— 세션 미선택'}{spectatorPaneId ? ` · ${spectatorPaneId}` : ''}{spectatorCols ? ` · ${spectatorCols}×${spectatorRows}` : ''}</code>
				{#if spec.spectatePicker && selectedSession}
					<button type="button" class="picker-change" onclick={openPicker}>세션 변경</button>
				{/if}
			</div>
		{/if}
```

  (b) **본문 오버레이** — 본문 영역(xterm-host 래퍼) 안, `{#if awaitingPick}` 로 중앙 버튼. xterm 컨테이너 형제로 배치:
```svelte
	{#if awaitingPick}
		<div class="picker-empty">
			<p>관전할 tmux 세션을 선택하세요.</p>
			<button type="button" class="picker-pick" onclick={openPicker}>세션 선택</button>
		</div>
	{/if}
```

  (c) **모달** — 파일 끝 `{#if sendPopupOpen}` 모달 근처에 형제로 추가:
```svelte
{#if pickerOpen}
	<div class="picker-overlay" role="dialog" aria-modal="true" aria-label="tmux 세션 선택">
		<div class="picker-panel">
			<div class="picker-head">
				<span>tmux 세션</span>
				<button type="button" onclick={closePicker} aria-label="닫기">✕</button>
			</div>
			{#if pickerLoading}
				<div class="picker-msg">불러오는 중…</div>
			{:else if pickerError}
				<div class="picker-msg error">{pickerError}</div>
				<button type="button" class="picker-retry" onclick={openPicker}>다시 시도</button>
			{:else if pickerSessions.length === 0}
				<div class="picker-msg">실행 중인 tmux 세션이 없습니다.</div>
			{:else}
				<ul class="picker-list">
					{#each pickerSessions as s (s.name)}
						<li>
							<button type="button" onclick={() => selectSession(s.name)}>
								<span class="ps-name">{s.name}</span>
								<span class="ps-meta">{s.windows}창 · {s.attached ? '●붙음' : '○'}{s.command ? ` · ${s.command}` : ''}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}
```

  (d) **CSS** — `<style>` 끝에 추가:
```css
	.picker-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		background: #1e1e1e;
		color: #ddd;
		z-index: 5;
	}
	.picker-pick,
	.picker-change,
	.picker-retry {
		background: #2d6cdf;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 8px 16px;
		cursor: pointer;
		font-size: 14px;
	}
	.picker-change {
		padding: 2px 8px;
		font-size: 12px;
		margin-left: 8px;
	}
	.picker-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal);
	}
	.picker-panel {
		background: #252526;
		color: #ddd;
		border-radius: 8px;
		min-width: min(420px, 92vw);
		max-height: 70vh;
		overflow: auto;
		padding: 12px;
	}
	.picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
		font-weight: 600;
	}
	.picker-head button {
		background: none;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 16px;
	}
	.picker-msg {
		padding: 16px;
		text-align: center;
		color: #bbb;
	}
	.picker-msg.error {
		color: #f48771;
	}
	.picker-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.picker-list li button {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
		background: #2d2d30;
		border: 1px solid #3a3a3c;
		border-radius: 6px;
		padding: 8px 10px;
		margin-bottom: 6px;
		color: #eee;
		cursor: pointer;
	}
	.picker-list li button:hover {
		background: #37373a;
	}
	.ps-name {
		font-family: monospace;
		font-size: 14px;
	}
	.ps-meta {
		font-size: 12px;
		color: #9aa;
	}
```
  주: `.picker-empty` 는 본문 래퍼 안의 `position:absolute` 오버레이라 본문 래퍼가 `position:relative`/stacking context 여야 한다. xterm-host 래퍼가 이미 그러면 그대로, 아니면 래퍼에 `position: relative` 추가. `--z-modal` 토큰은 body-portal 아닌 in-window 모달이라도 충분(데스크탑 NoteWindow 안이면 창 내부에 갇히는 건 기존 보내기 팝업과 동일 한계 — 본 기능 스코프 밖).

- [ ] **Step 7: 타입/빌드 확인** — Run: `cd app && npm run check` → 신규 에러 0.

- [ ] **Step 8: 커밋**
```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): empty spectate: session picker UI + change-session"
```

---

### Task 5: 가이드 카드 (설정 → 가이드 → notes)

**Goal:** 빈 `spectate:` 런처 사용법을 설정 가이드에 문서화(CLAUDE.md 불변식).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] notes 서브탭(`guideSubTab === 'notes'`)에 `<details class="guide-card">` 추가.
- [ ] 기존 관전 노트 가이드 카드 패턴(summary + info-text + snippet + guide-list) 미러.
- [ ] 휘발(노트에 안 박힘), 버튼 흐름("세션 선택"/"세션 변경"), 데스크탑이 켜져 있어야 목록이 뜬다는 제약 포함.

**Verify:** `cd app && npm run check` → 에러 0. (수동: 설정 → 가이드 → notes 에서 카드 노출 확인.)

**Steps:**

- [ ] **Step 1: 카드 추가** — `settings/+page.svelte` 에서 관전(spectate) 관련 기존 guide-card 를 grep 으로 찾고(`grep -n "spectate\|관전" app/src/routes/settings/+page.svelte`) 그 근처에, 동일 클래스 패턴으로 추가:
```svelte
<details class="guide-card">
	<summary>관전 세션 피커 (이름 없이 고르기)</summary>
	<p class="info-text">
		본문에 값 없는 <code>spectate:</code> 한 줄만 두면 그 노트는 세션 런처가 됩니다.
		열고 “세션 선택”을 누르면 데스크탑의 tmux 세션 목록이 떠서, 골라서 바로 관전합니다.
		세션 이름을 미리 몰라도 됩니다 (예: Claude Squad 의 <code>claudesquad_*</code> 세션).
	</p>
	<pre class="snippet">ssh://you@desktop
spectate:
bridge: wss://b/ws</pre>
	<ul class="guide-list">
		<li>선택은 <strong>휘발</strong>입니다 — 노트 본문에 박히지 않아 열 때마다 다시 고를 수 있는 재사용 메뉴입니다.</li>
		<li>관전 중 헤더의 <strong>세션 변경</strong>으로 다른 세션으로 갈아탑니다.</li>
		<li>목록은 데스크탑이 <strong>켜져 있고</strong> 브릿지가 ssh 로 닿을 때만 뜹니다. 꺼져 있으면 에러가 표시됩니다.</li>
		<li>값을 적은 <code>spectate: main</code> 은 기존처럼 그 세션을 바로 관전합니다(피커 없음).</li>
	</ul>
</details>
```

- [ ] **Step 2: 확인** — Run: `cd app && npm run check` → 에러 0.

- [ ] **Step 3: 커밋**
```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(terminal): 가이드 카드 — 빈 spectate: 세션 피커"
```

---

### Task 6: 전체 검증

**Goal:** 앱/브릿지 타입·테스트 그린 확인.

**Files:** (없음 — 검증만)

**Acceptance Criteria:**
- [ ] `cd app && npm run check` → 0 errors.
- [ ] `cd app && npm run test` → 파서 테스트 포함 전부 PASS.
- [ ] `cd bridge && npm test` → sessionList 포함 전부 PASS.

**Verify:** 위 3개 명령 모두 그린.

**Steps:**

- [ ] **Step 1:** Run: `cd app && npm run check` → 0 errors. (실패 시 해당 Task 로 돌아가 수정.)
- [ ] **Step 2:** Run: `cd app && npm run test` → PASS.
- [ ] **Step 3:** Run: `cd bridge && npm test` → PASS.
- [ ] **Step 4:** 이상 없으면 종료. (이미 태스크별 커밋 완료.)

---

## Self-Review

- **Spec 커버리지:** 파서(§1)=Task1, 브릿지 엔드포인트+listSessions+parseSessionList+보안(§3,§8)=Task2, 클라 fetch(§4)=Task3, TerminalView picker/effectiveSession/버튼/모달/에러(§2,§5,§6,§7)=Task4, 가이드(§9)=Task5, 테스트(§테스트)=Task1/Task2/Task6. WOL-on-list·영속·검색박스는 비목표로 제외 — 일치.
- **플레이스홀더:** 없음. 모든 스텝에 실제 코드/명령/기대출력.
- **타입 일관성:** `SessionInfo`(name/windows/attached/activity/command) — 브릿지(sessionList.ts)·클라(bridgeSettings.ts) 동일. `effectiveSession: string|undefined` 일관. `coerceTarget`/`parseSessionList`/`fetchSessions` 시그니처 태스크 간 일치.
- **불변식:** picker 분기는 `spec.spectatePicker`(빈 spectate)에서만 발화 → 고정 세션 노트 0 변경. 선택은 휘발(rewriteSpectateLine 미호출). 세션명은 tmux 출력에서만, ssh 타겟은 coerceTarget 검증.
