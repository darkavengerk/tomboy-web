# 폰 키 이벤트 노트 (`keys://phone`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 특수 노트 `keys://phone`을 열면 볼륨 ±버튼 패드가 뜨고, 누르면 검증된 ssh 역터널을 타고 폰에 `su -c 'input keyevent N'`이 주입된다.

**Architecture:** 프론트는 `keys://`를 파싱해 KeysView를 띄우고, 와이어로는 `ssh://phone` + `mode:'keys'`로 기존 `/ws` 브리지에 붙는다 → bridge의 SSH 파싱·별칭·터널 probe를 무수정 재사용. bridge는 keys 모드에서 PTY 대신 ControlMaster ssh 세션을 프리웜하고, 키 입력마다 정수 화이트리스트 검증 후 일회성 ssh exec를 실행한다.

**Tech Stack:** SvelteKit(Svelte 5 runes) + vitest / Node `ws` bridge(TypeScript) + `node --test` / OpenSSH ControlMaster.

설계 근거: `docs/superpowers/specs/2026-05-29-phone-key-events-design.md`. 핵심 기제 검증됨: `su -c 'input keyevent 24'` rc=0 (Magisk root).

---

## File Structure

**bridge/** (Node, `node --test`):
- `bridge/src/keyEvents.ts` (신규) — 순수: 화이트리스트 + 명령 빌더.
- `bridge/src/keyEvents.test.ts` (신규).
- `bridge/src/pty.ts` (수정) — `buildSshExecArgs` 추가.
- `bridge/src/pty.test.ts` (수정) — `buildSshExecArgs` 테스트 추가.
- `bridge/src/server.ts` (수정) — keys 모드 connect/key 핸들러 + `runSshExec`.

**app/** (SvelteKit, vitest):
- `app/src/lib/editor/keyRemote/parseKeysNote.ts` (신규).
- `app/src/lib/editor/keyRemote/keysClient.ts` (신규).
- `app/src/lib/editor/keyRemote/KeysView.svelte` (신규).
- `app/src/lib/editor/terminal/wsClient.ts` (수정) — `bridgeToWsUrl` export.
- `app/src/routes/note/[id]/+page.svelte` (수정) — 디스패치 배선.
- `app/tests/unit/editor/keyRemote/parseKeysNote.test.ts` (신규).
- `app/tests/unit/editor/keyRemote/keysClient.test.ts` (신규).

빌드/테스트: bridge `cd bridge && npx tsc -p . && node --test dist/*.test.js` (또는 `npm run test`). app `cd app && npm run test` + `npm run check`.

---

### Task 1: bridge `keyEvents.ts` — 화이트리스트 + 명령 빌더 (순수)

**Goal:** 정수 keycode 화이트리스트와 고정 템플릿 명령 빌더를 순수 함수로 만들어 셸 인젝션을 원천 차단한다.

**Files:**
- Create: `bridge/src/keyEvents.ts`
- Test: `bridge/src/keyEvents.test.ts`

**Acceptance Criteria:**
- [ ] `isAllowedKeyCode(24)`/`(25)` true; `(26)`/`(99)`/`(0)` false.
- [ ] `isAllowedKeyCode`가 비정수/문자열/음수/NaN/null/undefined를 모두 false로 거부.
- [ ] `buildKeyCommand(24) === "su -c 'input keyevent 24'"`.
- [ ] `KEY_WHITELIST[24] === 'VOLUME_UP'`, `[25] === 'VOLUME_DOWN'`.

**Verify:** `cd bridge && npx tsc -p . && node --test dist/keyEvents.test.js` → 모든 테스트 pass.

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/keyEvents.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_WHITELIST, isAllowedKeyCode, buildKeyCommand } from './keyEvents.js';

test('volume keys are whitelisted', () => {
	assert.equal(isAllowedKeyCode(24), true);
	assert.equal(isAllowedKeyCode(25), true);
});

test('non-whitelisted codes rejected', () => {
	assert.equal(isAllowedKeyCode(0), false);
	assert.equal(isAllowedKeyCode(26), false); // POWER — 의도적 미포함
	assert.equal(isAllowedKeyCode(99), false);
});

test('non-integers rejected', () => {
	assert.equal(isAllowedKeyCode('24'), false);
	assert.equal(isAllowedKeyCode(24.5), false);
	assert.equal(isAllowedKeyCode(-1), false);
	assert.equal(isAllowedKeyCode(null), false);
	assert.equal(isAllowedKeyCode(undefined), false);
	assert.equal(isAllowedKeyCode(NaN), false);
});

test('buildKeyCommand uses fixed su template', () => {
	assert.equal(buildKeyCommand(24), "su -c 'input keyevent 24'");
	assert.equal(buildKeyCommand(25), "su -c 'input keyevent 25'");
});

test('whitelist maps codes to readable names', () => {
	assert.equal(KEY_WHITELIST[24], 'VOLUME_UP');
	assert.equal(KEY_WHITELIST[25], 'VOLUME_DOWN');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/keyEvents.test.js`
Expected: 컴파일 실패 또는 "Cannot find module './keyEvents.js'".

- [ ] **Step 3: 구현** — `bridge/src/keyEvents.ts`

```ts
/**
 * 폰에 주입 가능한 키의 화이트리스트. 와이어로 들어오는 건 정수 keycode뿐이고,
 * 원격 명령은 검증된 정수만 고정 템플릿에 보간하므로 셸 인젝션이 불가능하다.
 * 키를 추가하려면 여기 한 줄만 늘리면 된다 (예: 26:'POWER').
 */
export const KEY_WHITELIST: Record<number, string> = {
	24: 'VOLUME_UP',
	25: 'VOLUME_DOWN'
};

/** 정수이면서 화이트리스트에 있는 keycode일 때만 true. */
export function isAllowedKeyCode(code: unknown): code is number {
	return typeof code === 'number' && Number.isInteger(code) && code in KEY_WHITELIST;
}

/**
 * 원격에서 실행할 명령 문자열. `isAllowedKeyCode(code) === true` 를 전제한다 —
 * 호출 전 반드시 검증할 것. 정수만 보간하므로 셸 메타문자가 끼어들 여지가 없다.
 * Termux 앱 uid엔 INJECT_EVENTS 권한이 없어 `su -c` 경유가 필수.
 */
export function buildKeyCommand(code: number): string {
	return `su -c 'input keyevent ${code}'`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/keyEvents.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/keyEvents.ts bridge/src/keyEvents.test.ts
git commit -m "feat(bridge): keyEvents 화이트리스트 + 명령 빌더"
```

---

### Task 2: bridge `buildSshExecArgs` — 일회성 ssh exec argv (pty.ts)

**Goal:** PTY가 아닌 일회성 원격 명령 실행용 ssh argv 빌더를 만들어 keys 세션이 ControlMaster를 재사용하게 한다.

**Files:**
- Modify: `bridge/src/pty.ts` (`buildSshArgs`/`controlMasterArgs` 옆에 추가)
- Test: `bridge/src/pty.test.ts` (테스트 추가)

**Acceptance Criteria:**
- [ ] 원격 명령이 항상 마지막 인자, 그 앞이 `user@host`.
- [ ] `controlPath` 주어지면 `ControlMaster=auto`/`ControlPath=`/`ControlPersist=60` 포함.
- [ ] `controlPath` 없으면 멀티플렉싱 옵션 없음.
- [ ] `BatchMode=yes` 항상 포함(비대화형 — 비번 프롬프트에 안 매달림).
- [ ] `port` 있으면 `-p <port>` 포함.

**Verify:** `cd bridge && npx tsc -p . && node --test dist/pty.test.js` → pass.

**Steps:**

- [ ] **Step 1: 실패 테스트 추가** — `bridge/src/pty.test.ts` 끝에 추가 (파일 상단 import에 `buildSshExecArgs` 추가)

```ts
import { buildSshExecArgs } from './pty.js';

test('buildSshExecArgs: command last, host before it', () => {
	const args = buildSshExecArgs(
		{ host: 'localhost', port: 18022, user: 'u0_a186' },
		'/tmp/x.sock',
		"su -c 'input keyevent 24'"
	);
	assert.equal(args[args.length - 1], "su -c 'input keyevent 24'");
	assert.equal(args[args.length - 2], 'u0_a186@localhost');
	assert.ok(args.includes('-p') && args.includes('18022'));
	assert.ok(args.includes('BatchMode=yes'));
	assert.ok(args.some((a) => a.startsWith('ControlPath=')));
	assert.ok(args.includes('ControlPersist=60'));
});

test('buildSshExecArgs: no controlPath → no multiplexing opts', () => {
	const args = buildSshExecArgs({ host: 'h' }, undefined, 'true');
	assert.ok(!args.some((a) => a.startsWith('ControlPath=')));
	assert.ok(!args.includes('ControlPersist=60'));
	assert.equal(args[args.length - 1], 'true');
	assert.equal(args[args.length - 2], 'h');
});
```

> 주의: `pty.test.ts`에 이미 `import { test }`/`assert`가 있으면 중복 import 금지 — `buildSshExecArgs`만 기존 import 줄에 추가.

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/pty.test.js`
Expected: 컴파일 실패 ("buildSshExecArgs is not exported").

- [ ] **Step 3: 구현** — `bridge/src/pty.ts`의 `buildSshArgs` 함수 바로 아래 추가

```ts
/**
 * 일회성 원격 명령 실행용 ssh argv. PTY가 아니라 `child_process`로 띄워
 * exit code/stderr를 수확하는 용도(키 이벤트 주입). `buildSshArgs`와 달리:
 *  - `BatchMode=yes` — 비대화형이라 비밀번호 프롬프트에 매달리지 않는다.
 *  - `ControlPersist=60` — 프리웜으로 띄운 마스터를 60초 유지해 다음 키부터
 *    재인증 없이 재사용한다.
 * 원격 명령은 항상 마지막 인자 — OpenSSH는 호스트 뒤 토큰을 원격 명령으로 본다.
 */
export function buildSshExecArgs(
	t: SshTarget,
	controlPath: string | undefined,
	remoteCommand: string
): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes');
	if (controlPath) args.push(...controlMasterArgs(controlPath), '-o', 'ControlPersist=60');
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	args.push(remoteCommand);
	return args;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/pty.test.js`
Expected: PASS (기존 + 신규 2 tests).

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/pty.ts bridge/src/pty.test.ts
git commit -m "feat(bridge): buildSshExecArgs — 일회성 ssh exec argv(ControlPersist)"
```

---

### Task 3: bridge `server.ts` — keys 모드 (connect 프리웜 + key 핸들러)

**Goal:** WS connect에 `mode:'keys'`를 추가해 ControlMaster를 프리웜하고, `{type:'key',code}` 메시지를 화이트리스트 검증 후 일회성 ssh exec로 폰에 주입한다.

**Files:**
- Modify: `bridge/src/server.ts`

**Acceptance Criteria:**
- [ ] `ClientMsg`에 `'key'` 타입 + `mode:'keys'` + `code?: number` 추가; `tsc` 컴파일 통과.
- [ ] `mode:'keys'` connect → 로컬 타깃이면 error+close; 별칭이면 터널 probe; 프리웜(`ssh … true`) 성공 시 `{type:'ready'}`, 실패 시 `{type:'error'}`+close.
- [ ] `{type:'key',code}` (keys 모드, ready 후): `isAllowedKeyCode` 거짓 → `{type:'key-error'}` (연결 유지); 참 → ssh exec → exit0이면 `{type:'key-ok',code}`, 아니면 `{type:'key-error',code,message:<stderr>}`.
- [ ] WS close 시 keys 마스터 `ssh -O exit` best-effort + 소켓 unlink.
- [ ] 기존 bridge 테스트 전부 그대로 pass(회귀 없음).

**Verify:** `cd bridge && npx tsc -p . && node --test dist/*.test.js` → 전부 pass (신규 server 동작은 Task 8 E2E로 검증).

**Steps:**

- [ ] **Step 1: import 추가** — `bridge/src/server.ts` 상단

`pty.js` import 줄을 다음으로 교체:
```ts
import { parseSshTarget, spawnForTarget, isLocalTarget, buildSshExecArgs, type SshTarget } from './pty.js';
```
새 import 두 줄 추가 (기존 import 블록 끝, `imageTransfer` import 뒤):
```ts
import { spawn } from 'node:child_process';
import { isAllowedKeyCode, buildKeyCommand } from './keyEvents.js';
```

- [ ] **Step 2: `ClientMsg` 인터페이스 확장** (현재 195–209행)

`type` 유니온에 `'key'` 추가, `mode`에 `'keys'` 추가, `code` 필드 추가:
```ts
interface ClientMsg {
	type: 'connect' | 'data' | 'resize' | 'tmux-nav' | 'image' | 'subscribe-pane' | 'key';
	target?: string;
	token?: string;
	cols?: number;
	rows?: number;
	d?: string;
	mode?: 'shell' | 'spectate' | 'keys';
	session?: string;
	action?: 'next-pane' | 'prev-pane' | 'next-window' | 'prev-window' | 'select-pane';
	index?: number;
	ordinal?: number;
	mime?: string;
	data?: string;
	code?: number;
}
```

- [ ] **Step 3: keys 세션 상태 플래그 추가** (`handleWs` 내부, `let connectAlias` 선언 바로 아래, 현재 224행 뒤)

```ts
	let keysMode = false;
	let keysReady = false;
```

- [ ] **Step 4: connect 핸들러에 keys 분기 추가** (spectate `if` 블록 닫힘 직후, 현재 278행과 279행 사이)

```ts
			if (msg.mode === 'keys') {
				void startKeys(target);
				return;
			}
```

- [ ] **Step 5: `key` 메시지 핸들러 추가** (`image` 블록 직후, 현재 296행과 298행 주석 사이 — spectator/pty 분기보다 먼저)

```ts
			if (msg.type === 'key') {
				if (!keysReady || !controlPath || !sessionTarget) return;
				if (!isAllowedKeyCode(msg.code)) {
					send({
						type: 'key-error',
						code: typeof msg.code === 'number' ? msg.code : -1,
						message: '허용되지 않은 키코드'
					});
					return;
				}
				const code = msg.code;
				const target = sessionTarget;
				const sock = controlPath;
				void (async () => {
					const r = await runSshExec(target, sock, buildKeyCommand(code));
					if (r.code === 0) send({ type: 'key-ok', code });
					else send({ type: 'key-error', code, message: r.stderr || `ssh exit ${r.code}` });
				})();
				return;
			}
```

- [ ] **Step 6: `startKeys` 함수 추가** (`startSession` 함수 정의 바로 뒤, 현재 478행 뒤)

```ts
		async function startKeys(target: SshTarget): Promise<void> {
			keysMode = true;
			sessionTarget = target;
			// keys 모드는 원격 폰 타깃 전용 — 로컬 셸엔 input keyevent가 의미 없다.
			if (isLocalTarget(target)) {
				send({ type: 'error', message: 'keys 모드는 원격 폰 타깃 전용입니다' });
				try { ws.close(1008, 'keys local'); } catch { /* ignore */ }
				return;
			}
			controlPath = `${CTRL_DIR}/${randomUUID().slice(0, 8)}.sock`;
			console.log(
				`[term-bridge] keys target=${target.user ?? ''}@${target.host}:${target.port ?? 22} alias=${connectAlias ?? 'none'}`
			);
			// 별칭(역터널) 타깃 도달성 — 터널 끊김 시 raw 에러 대신 한국어 안내.
			if (connectAlias) {
				const reachable = await probePort(target.host, target.port ?? 22, {
					timeoutMs: 1000,
					signal: abortCtrl.signal
				});
				if (!reachable) {
					if (!abortCtrl.signal.aborted) {
						send({
							type: 'error',
							message: `'${connectAlias}' 터널이 연결되어 있지 않습니다 (폰이 깨어 있고 네트워크에 연결됐는지 확인하세요)`
						});
						try { ws.close(1011, 'tunnel down'); } catch { /* ignore */ }
					}
					return;
				}
			}
			if (abortCtrl.signal.aborted) return;
			// 프리웜: ControlMaster 마스터를 띄우고 인증을 미리 끝낸다 → 첫 키부터 저지연.
			const warm = await runSshExec(target, controlPath, 'true');
			if (abortCtrl.signal.aborted) return;
			if (warm.code !== 0) {
				send({ type: 'error', message: `폰 연결 실패: ${warm.stderr || 'ssh exit ' + warm.code}` });
				try { ws.close(1011, 'keys prewarm failed'); } catch { /* ignore */ }
				return;
			}
			keysReady = true;
			send({ type: 'ready' });
		}
```

> `probePort`는 이미 import됨(`./wol.js`). `randomUUID`/`CTRL_DIR`/`abortCtrl`/`connectAlias`/`sessionTarget`/`controlPath`도 모두 스코프 내 기존 심볼.

- [ ] **Step 7: `runSshExec` 모듈 헬퍼 추가** (`handleWs` 함수 밖, `wakeIfNeeded` 함수 정의 뒤, 현재 567행 뒤)

```ts
/**
 * 일회성 ssh exec — exit code와 stderr를 수확한다(키 이벤트 주입용).
 * stdin 없음, stdout 무시, stderr만 캡처(상한 2KB). `error` 이벤트(ssh 미설치
 * 등)는 code:-1로 정규화.
 */
function runSshExec(
	target: SshTarget,
	controlPath: string,
	remoteCommand: string
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('ssh', buildSshExecArgs(target, controlPath, remoteCommand), {
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let stderr = '';
		child.stderr.on('data', (d: Buffer) => {
			if (stderr.length < 2000) stderr += d.toString();
		});
		child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
		child.on('close', (code) => resolve({ code: code ?? -1, stderr: stderr.trim() }));
	});
}
```

- [ ] **Step 8: WS close 시 keys 마스터 정리** (현재 366–370행 `if (controlPath)` 블록 교체)

```ts
		if (controlPath) {
			// keys 모드는 ControlPersist 마스터가 떠 있으므로 명시적으로 종료한다.
			// (PTY 경로는 ControlPersist가 없어 PTY 종료 시 마스터도 사라진다.)
			if (keysMode && sessionTarget) {
				const host = sessionTarget.user
					? `${sessionTarget.user}@${sessionTarget.host}`
					: sessionTarget.host;
				try {
					spawn('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', host], {
						stdio: 'ignore'
					});
				} catch { /* best-effort */ }
			}
			// ssh 마스터가 죽으면 소켓도 사라지지만 best-effort로 정리.
			unlink(controlPath).catch(() => { /* 이미 없음 */ });
			controlPath = null;
		}
```

- [ ] **Step 9: 컴파일 + 전체 회귀 테스트**

Run: `cd bridge && npx tsc -p . && node --test dist/*.test.js`
Expected: 컴파일 통과 + 모든 기존 테스트 PASS.

- [ ] **Step 10: 커밋**

```bash
git add bridge/src/server.ts
git commit -m "feat(bridge): keys 모드 — connect 프리웜 + key 이벤트 ssh exec"
```

---

### Task 4: 프론트 `parseKeysNote.ts` — keys:// 노트 파서 (vitest)

**Goal:** 노트 본문 첫 줄 `keys://[user@]host[:port]`을 인식해 `KeysNoteSpec`(와이어용 `ssh://` 타깃 포함)을 반환한다.

**Files:**
- Create: `app/src/lib/editor/keyRemote/parseKeysNote.ts`
- Test: `app/tests/unit/editor/keyRemote/parseKeysNote.test.ts`

**Acceptance Criteria:**
- [ ] `keys://phone` → `{raw:'keys://phone', host:'phone', user:undefined, port:undefined, sshTarget:'ssh://phone'}`.
- [ ] `keys://u0_a186@localhost:18022` → user/host/port + `sshTarget:'ssh://u0_a186@localhost:18022'`.
- [ ] 제목 다음 빈 줄들은 건너뜀.
- [ ] 포트 범위 밖(99999) → null.
- [ ] `ssh://phone`/평문/본문 없음 → null.

**Verify:** `cd app && npm run test -- parseKeysNote` → pass.

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/keyRemote/parseKeysNote.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseKeysNote } from '$lib/editor/keyRemote/parseKeysNote.js';
import type { JSONContent } from '@tiptap/core';

function doc(...lines: (string | null)[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((l) =>
			l === null ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: l }] }
		)
	};
}

describe('parseKeysNote', () => {
	it('matches keys://phone', () => {
		expect(parseKeysNote(doc('제목', 'keys://phone'))).toEqual({
			raw: 'keys://phone',
			host: 'phone',
			user: undefined,
			port: undefined,
			sshTarget: 'ssh://phone'
		});
	});

	it('matches keys://user@host:port', () => {
		expect(parseKeysNote(doc('t', 'keys://u0_a186@localhost:18022'))).toMatchObject({
			user: 'u0_a186',
			host: 'localhost',
			port: 18022,
			sshTarget: 'ssh://u0_a186@localhost:18022'
		});
	});

	it('skips empty lines after title', () => {
		expect(parseKeysNote(doc('t', '', 'keys://phone'))).toMatchObject({ host: 'phone' });
	});

	it('rejects out-of-range port', () => {
		expect(parseKeysNote(doc('t', 'keys://phone:99999'))).toBeNull();
	});

	it('returns null for ssh:// note', () => {
		expect(parseKeysNote(doc('t', 'ssh://phone'))).toBeNull();
	});

	it('returns null for plain note', () => {
		expect(parseKeysNote(doc('t', 'hello world'))).toBeNull();
	});

	it('returns null when no body line', () => {
		expect(parseKeysNote(doc('only-title'))).toBeNull();
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- parseKeysNote`
Expected: FAIL ("Cannot find module .../parseKeysNote.js").

- [ ] **Step 3: 구현** — `app/src/lib/editor/keyRemote/parseKeysNote.ts`

```ts
import type { JSONContent } from '@tiptap/core';

export interface KeysNoteSpec {
	/** 원본 `keys://...` 라인 (트림됨). */
	raw: string;
	host: string;
	user?: string;
	port?: number;
	/** 브리지로 보낼 와이어 타깃 — bridge는 ssh:// 스킴만 파싱하므로 변환해 둔다. */
	sshTarget: string;
}

const KEYS_RE = /^keys:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;

function paragraphText(block: JSONContent | undefined): string | null {
	if (!block || block.type !== 'paragraph') return null;
	if (!block.content) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') out += child.text ?? '';
		else return null;
	}
	return out;
}

/**
 * 노트가 키 이벤트 노트인지 판정. 터미널 노트와 동일하게 첫 블록은 제목,
 * 그 다음 첫 비어있지 않은 본문 블록이 `keys://...` 메타 라인이어야 한다.
 */
export function parseKeysNote(doc: JSONContent | null | undefined): KeysNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;
	let i = 1;
	while (i < blocks.length && paragraphText(blocks[i]) === '') i++;
	const line = paragraphText(blocks[i]);
	if (line === null) return null;
	const m = KEYS_RE.exec(line.trim());
	if (!m) return null;
	const user = m[1] || undefined;
	const host = m[2];
	const portRaw = m[3];
	const port = portRaw ? Number(portRaw) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
	const sshTarget = `ssh://${user ? user + '@' : ''}${host}${port ? ':' + port : ''}`;
	return { raw: line.trim(), host, user, port, sshTarget };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm run test -- parseKeysNote`
Expected: PASS (7 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/keyRemote/parseKeysNote.ts app/tests/unit/editor/keyRemote/parseKeysNote.test.ts
git commit -m "feat(app): parseKeysNote — keys:// 노트 파서"
```

---

### Task 5: 프론트 `keysClient.ts` — 경량 WS 클라이언트 (vitest)

**Goal:** keys 모드 WS 클라이언트(connect/sendKey + 콜백)를 주입가능 소켓으로 테스트가능하게 만들고, `bridgeToWsUrl`을 wsClient에서 재사용한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/wsClient.ts` (`bridgeToWsUrl` export)
- Create: `app/src/lib/editor/keyRemote/keysClient.ts`
- Test: `app/tests/unit/editor/keyRemote/keysClient.test.ts`

**Acceptance Criteria:**
- [ ] open 시 `{type:'connect', target, mode:'keys', token}` 프레임 전송.
- [ ] `{type:'ready'}` 수신 → `onStatus('ready')`.
- [ ] `sendKey(24)` → `{type:'key', code:24}` 전송.
- [ ] `key-ok`/`key-error` 수신 → 각 콜백 호출(코드/메시지 전달).
- [ ] `bridgeToWsUrl`이 wsClient.ts에서 export됨(기존 터미널 동작 회귀 없음).

**Verify:** `cd app && npm run test -- keysClient` → pass; `cd app && npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: `bridgeToWsUrl` export** — `app/src/lib/editor/terminal/wsClient.ts` (현재 314행)

`function bridgeToWsUrl(bridge: string): string {` → `export function bridgeToWsUrl(bridge: string): string {`

- [ ] **Step 2: 실패 테스트 작성** — `app/tests/unit/editor/keyRemote/keysClient.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { KeysWsClient, type WsLike } from '$lib/editor/keyRemote/keysClient.js';

function fakeSocket(): { ws: WsLike; sent: string[] } {
	const sent: string[] = [];
	const ws: WsLike = {
		send: (d) => sent.push(d),
		close: () => {},
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null
	};
	return { ws, sent };
}

function makeClient(ws: WsLike, cbOverrides = {}) {
	return new KeysWsClient({
		bridge: 'wss://b.example/',
		target: 'ssh://phone',
		token: 'T',
		callbacks: { onStatus: () => {}, onKeyOk: () => {}, onKeyError: () => {}, ...cbOverrides },
		socketFactory: () => ws
	});
}

describe('KeysWsClient', () => {
	it('sends connect frame with mode:keys on open', () => {
		const { ws, sent } = fakeSocket();
		makeClient(ws).connect();
		ws.onopen!();
		expect(JSON.parse(sent[0])).toEqual({ type: 'connect', target: 'ssh://phone', mode: 'keys', token: 'T' });
	});

	it('fires onStatus(ready) on ready msg', () => {
		const { ws } = fakeSocket();
		const onStatus = vi.fn();
		makeClient(ws, { onStatus }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'ready' }) });
		expect(onStatus).toHaveBeenCalledWith('ready');
	});

	it('sendKey emits key frame', () => {
		const { ws, sent } = fakeSocket();
		const c = makeClient(ws);
		c.connect();
		ws.onopen!();
		c.sendKey(24);
		expect(JSON.parse(sent[1])).toEqual({ type: 'key', code: 24 });
	});

	it('routes key-ok / key-error', () => {
		const { ws } = fakeSocket();
		const onKeyOk = vi.fn();
		const onKeyError = vi.fn();
		makeClient(ws, { onKeyOk, onKeyError }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'key-ok', code: 24 }) });
		ws.onmessage!({ data: JSON.stringify({ type: 'key-error', code: 25, message: 'nope' }) });
		expect(onKeyOk).toHaveBeenCalledWith(24);
		expect(onKeyError).toHaveBeenCalledWith(25, 'nope');
	});

	it('routes error msg to onStatus(error)', () => {
		const { ws } = fakeSocket();
		const onStatus = vi.fn();
		makeClient(ws, { onStatus }).connect();
		ws.onmessage!({ data: JSON.stringify({ type: 'error', message: '터널 끊김' }) });
		expect(onStatus).toHaveBeenCalledWith('error', { message: '터널 끊김' });
	});
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd app && npm run test -- keysClient`
Expected: FAIL ("Cannot find module .../keysClient.js").

- [ ] **Step 4: 구현** — `app/src/lib/editor/keyRemote/keysClient.ts`

```ts
import { bridgeToWsUrl } from '$lib/editor/terminal/wsClient.js';

export type KeysClientStatus = 'connecting' | 'ready' | 'closed' | 'error';

export interface KeysClientCallbacks {
	onStatus: (status: KeysClientStatus, info?: { message?: string }) => void;
	onKeyOk: (code: number) => void;
	onKeyError: (code: number, message: string) => void;
}

/** 테스트 주입용 최소 WebSocket 인터페이스. */
export interface WsLike {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}

interface KeysClientOptions {
	bridge: string;
	/** `ssh://...` 형식의 와이어 타깃. */
	target: string;
	token: string;
	callbacks: KeysClientCallbacks;
	/** 기본은 브라우저 WebSocket. 테스트에서 가짜 소켓 주입. */
	socketFactory?: (url: string) => WsLike;
}

/**
 * keys 모드 전용 얇은 WS 클라이언트. 터미널 wsClient는 PTY data 프레임/관전
 * 모드 전용이라 재사용하지 않고, connect + sendKey + 콜백만 갖는 최소 구현.
 */
export class KeysWsClient {
	private ws: WsLike | null = null;
	private opts: KeysClientOptions;
	private closed = false;

	constructor(opts: KeysClientOptions) {
		this.opts = opts;
	}

	connect(): void {
		this.opts.callbacks.onStatus('connecting');
		let url: string;
		try {
			url = bridgeToWsUrl(this.opts.bridge);
		} catch (err) {
			this.opts.callbacks.onStatus('error', { message: (err as Error).message });
			return;
		}
		const factory =
			this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
		const ws = factory(url);
		this.ws = ws;
		ws.onopen = () => {
			ws.send(
				JSON.stringify({ type: 'connect', target: this.opts.target, mode: 'keys', token: this.opts.token })
			);
		};
		ws.onmessage = (ev) => {
			let msg: { type?: string; code?: number; message?: string };
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.type === 'ready') this.opts.callbacks.onStatus('ready');
			else if (msg.type === 'key-ok' && typeof msg.code === 'number')
				this.opts.callbacks.onKeyOk(msg.code);
			else if (msg.type === 'key-error')
				this.opts.callbacks.onKeyError(
					typeof msg.code === 'number' ? msg.code : -1,
					msg.message ?? '키 전송 실패'
				);
			else if (msg.type === 'error')
				this.opts.callbacks.onStatus('error', { message: msg.message ?? '연결 오류' });
		};
		ws.onerror = () => {
			if (!this.closed) this.opts.callbacks.onStatus('error', { message: '연결 오류' });
		};
		ws.onclose = () => {
			if (!this.closed) this.opts.callbacks.onStatus('closed');
		};
	}

	sendKey(code: number): void {
		if (!this.ws) return;
		this.ws.send(JSON.stringify({ type: 'key', code }));
	}

	close(): void {
		this.closed = true;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
	}
}
```

- [ ] **Step 5: 통과 + 타입 확인**

Run: `cd app && npm run test -- keysClient && npm run check`
Expected: 테스트 5 PASS, check 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/terminal/wsClient.ts app/src/lib/editor/keyRemote/keysClient.ts app/tests/unit/editor/keyRemote/keysClient.test.ts
git commit -m "feat(app): keysClient + bridgeToWsUrl export"
```

---

### Task 6: 프론트 `KeysView.svelte` — 볼륨 버튼 패드

**Goal:** `KeysNoteSpec`를 받아 볼륨 ±버튼 패드를 렌더하고, 브릿지에 연결해 버튼 누름마다 키를 전송하고 ✓/✗ 피드백을 표시한다.

**Files:**
- Create: `app/src/lib/editor/keyRemote/KeysView.svelte`

**Acceptance Criteria:**
- [ ] 두 버튼(🔊 볼륨 업 / 🔉 볼륨 다운) 렌더; `status !== 'ready'`면 disabled.
- [ ] 마운트 시 bridge URL/token 미설정이면 한국어 에러 배너.
- [ ] 버튼 누름 → `client.sendKey(code)`; key-ok → 일시 ✓, key-error → 일시 ✗ + 메시지.
- [ ] 편집 버튼 → `onedit()` 콜백.
- [ ] `npm run check` 0 errors.

**Verify:** `cd app && npm run check` → 0 errors (UI 동작은 Task 8 E2E로 확인).

**Steps:**

- [ ] **Step 1: 컴포넌트 작성** — `app/src/lib/editor/keyRemote/KeysView.svelte`

```svelte
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { KeysNoteSpec } from './parseKeysNote.js';
	import { KeysWsClient, type KeysClientStatus } from './keysClient.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';

	type Props = { spec: KeysNoteSpec; guid: string; onedit: () => void };
	let { spec, guid, onedit }: Props = $props();

	const KEYS = [
		{ label: '🔊 볼륨 업', code: 24 },
		{ label: '🔉 볼륨 다운', code: 25 }
	];

	let status: KeysClientStatus = $state('connecting');
	let statusMessage = $state('');
	// code → 'ok' | 'err' 일시 피드백.
	let feedback: Record<number, 'ok' | 'err'> = $state({});
	let feedbackMsg = $state('');
	let client: KeysWsClient | null = null;
	const feedbackTimers = new Map<number, ReturnType<typeof setTimeout>>();

	function flash(code: number, kind: 'ok' | 'err', msg = ''): void {
		feedback = { ...feedback, [code]: kind };
		feedbackMsg = msg;
		const prev = feedbackTimers.get(code);
		if (prev) clearTimeout(prev);
		feedbackTimers.set(
			code,
			setTimeout(() => {
				const next = { ...feedback };
				delete next[code];
				feedback = next;
			}, 800)
		);
	}

	onMount(async () => {
		const bridge = await getDefaultTerminalBridge();
		if (!bridge) {
			status = 'error';
			statusMessage = '브릿지 URL이 설정되지 않았습니다. 설정에서 기본 브릿지를 입력하세요.';
			return;
		}
		const token = await getTerminalBridgeToken();
		if (!token) {
			status = 'error';
			statusMessage = '브릿지에 로그인하지 않았습니다. 설정 → 동기화 설정 → 터미널 브릿지에서 로그인하세요.';
			return;
		}
		client = new KeysWsClient({
			bridge,
			target: spec.sshTarget,
			token,
			callbacks: {
				onStatus: (s, info) => {
					status = s;
					if (info?.message) statusMessage = info.message;
				},
				onKeyOk: (code) => flash(code, 'ok'),
				onKeyError: (code, message) => flash(code, 'err', message)
			}
		});
		client.connect();
	});

	onDestroy(() => {
		for (const t of feedbackTimers.values()) clearTimeout(t);
		feedbackTimers.clear();
		client?.close();
		client = null;
	});

	function press(code: number): void {
		if (status !== 'ready' || !client) return;
		client.sendKey(code);
	}
</script>

<div class="keys-view">
	<div class="keys-header">
		<code class="target">{spec.raw}</code>
		<button class="edit-btn" onclick={onedit} title="편집 모드">✎ 편집</button>
	</div>

	{#if status !== 'ready'}
		<div class="banner" class:error={status === 'error'}>
			{statusMessage ||
				(status === 'connecting' ? '연결 중...' : status === 'closed' ? '연결 종료됨' : '')}
		</div>
	{/if}

	<div class="pad">
		{#each KEYS as k (k.code)}
			<button
				class="key-btn"
				class:ok={feedback[k.code] === 'ok'}
				class:err={feedback[k.code] === 'err'}
				disabled={status !== 'ready'}
				onclick={() => press(k.code)}
			>
				<span>{k.label}</span>
				{#if feedback[k.code] === 'ok'}<span class="mark">✓</span>{/if}
				{#if feedback[k.code] === 'err'}<span class="mark">✗</span>{/if}
			</button>
		{/each}
	</div>

	{#if feedbackMsg}<div class="feedback-msg">{feedbackMsg}</div>{/if}
</div>

<style>
	.keys-view {
		display: flex;
		flex-direction: column;
		gap: clamp(0.75rem, 3vw, 1.25rem);
		padding: clamp(1rem, 4vw, 2rem);
	}
	.keys-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.target {
		font-size: clamp(0.8rem, 3vw, 1rem);
		color: #666;
		word-break: break-all;
	}
	.edit-btn {
		background: none;
		border: 1px solid #ccc;
		border-radius: 6px;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
	}
	.banner {
		padding: 0.6rem 0.8rem;
		border-radius: 8px;
		background: #f0f0f0;
		color: #444;
		font-size: 0.9rem;
	}
	.banner.error {
		background: #fdecea;
		color: #b3261e;
	}
	.pad {
		display: grid;
		grid-template-columns: 1fr;
		gap: clamp(0.75rem, 3vw, 1.25rem);
	}
	.key-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: clamp(3.5rem, 14vw, 5rem);
		font-size: clamp(1.1rem, 4.5vw, 1.5rem);
		border: 2px solid #ccc;
		border-radius: 14px;
		background: #fff;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.key-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.key-btn.ok {
		border-color: #2e7d32;
		background: #e8f5e9;
	}
	.key-btn.err {
		border-color: #b3261e;
		background: #fdecea;
	}
	.mark {
		font-weight: 700;
	}
	.feedback-msg {
		font-size: 0.85rem;
		color: #b3261e;
		text-align: center;
	}
</style>
```

> `guid` prop은 TerminalView와 시그니처를 맞추기 위해 받되 현재 미사용 — `{#key noteId}`로 재마운트하므로 내부에서 쓸 일이 없다. svelte-check가 미사용 prop을 경고하지 않으므로 그대로 둔다.

- [ ] **Step 2: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add app/src/lib/editor/keyRemote/KeysView.svelte
git commit -m "feat(app): KeysView 볼륨 버튼 패드"
```

---

### Task 7: 프론트 노트 페이지 디스패치 배선

**Goal:** `note/[id]/+page.svelte`가 `keys://` 노트를 인식해 "키" FAB → KeysView를 띄우게 한다(터미널 노트 패턴 미러).

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte`

**Acceptance Criteria:**
- [ ] `keys://` 노트에서 "키" FAB가 보이고, 누르면 KeysView가 마운트됨.
- [ ] keys 접속 모드에서 툴바 숨김, 편집 버튼으로 빠져나오면 복귀.
- [ ] 일반/터미널 노트 동작 회귀 없음.
- [ ] `npm run check` 0 errors.

**Verify:** `cd app && npm run check` → 0 errors (동작은 Task 8 E2E로 확인).

**Steps:**

- [ ] **Step 1: import 추가** — TerminalView import(23행)와 parseTerminalNote import(24–27행) 블록 뒤에 추가

```ts
	import KeysView from '$lib/editor/keyRemote/KeysView.svelte';
	import { parseKeysNote, type KeysNoteSpec } from '$lib/editor/keyRemote/parseKeysNote.js';
```

- [ ] **Step 2: 상태 추가** — terminalSpec 상태 블록(86–88행) 바로 뒤

```ts
	let keysSpec: KeysNoteSpec | null = $state.raw(null);
	let keysConnectMode = $state(false);
	const showKeys = $derived(!!keysSpec && keysConnectMode);
```

- [ ] **Step 3: 파싱 지점 3곳에 keysSpec 추가**

(a) 194–195행 (reload bus) 뒤:
```ts
				keysSpec = parseKeysNote(editorContent);
				if (!keysSpec) keysConnectMode = false;
```
(b) 255–256행 (route 변경 로드) 뒤:
```ts
				keysSpec = parseKeysNote(editorContent);
				keysConnectMode = false;
```
(c) 470–471행 (초기 로드) 뒤:
```ts
		keysSpec = parseKeysNote(editorContent);
		if (!keysSpec) keysConnectMode = false;
```

> 각 지점의 들여쓰기는 바로 위 `terminalSpec = parseTerminalNote(...)` 줄과 동일하게 맞출 것.

- [ ] **Step 4: 컨테이너/에디터 클래스에 keys 반영**

657행 `<div class="editor-page" class:terminal-connected={showTerminal}>` →
```svelte
<div class="editor-page" class:terminal-connected={showTerminal || showKeys}>
```
691행 `class:terminal-edit={!!terminalSpec && !showTerminal}` →
```svelte
		class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}
```

- [ ] **Step 5: 렌더 분기 추가** — 터미널 블록(697–704행)의 닫는 부분과 `{:else}`(705행) 사이에 삽입

```svelte
			{:else if showKeys && keysSpec}
				{#key noteId}
					<KeysView
						spec={keysSpec}
						guid={noteId ?? ''}
						onedit={() => (keysConnectMode = false)}
					/>
				{/key}
```

- [ ] **Step 6: 툴바 가드** — 756행 `{#if !showTerminal}` →

```svelte
	{#if !showTerminal && !showKeys}
```

- [ ] **Step 7: 키 FAB 추가** — 터미널 FAB 블록(772–779행) 바로 뒤

```svelte
	{#if keysSpec && !showKeys}
		<button
			class="fab-terminal-connect"
			onclick={() => (keysConnectMode = true)}
			aria-label="키 패드"
			title="키 이벤트 — {keysSpec.raw}"
		>키</button>
	{/if}
```

> 기존 `.fab-terminal-connect` 스타일을 재사용(별도 CSS 불필요).

- [ ] **Step 8: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 9: 커밋**

```bash
git add app/src/routes/note/[id]/+page.svelte
git commit -m "feat(app): note 페이지 keys:// 디스패치 배선"
```

---

### Task 8: E2E 검증 — `keys://phone` 노트에서 볼륨 ±버튼이 실제로 폰 볼륨을 바꾼다

**Goal:** 앱에서 `keys://phone` 노트를 열고 ▲/▼ 버튼을 눌러 폰 볼륨이 실제로 변하는지 사용자가 직접 확인한다.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** (없음 — 검증 전용. 필요 시 RPi `ssh-hosts.json`에 `phone` 별칭이 이미 있는지 확인. 1탄에서 등록됨.)

**Acceptance Criteria:**
- [ ] 사전조건: bridge가 keys 코드 포함해 RPi에 재배포됨(`npm run build` 후 Quadlet 재시작); 폰 역터널 LISTEN(`ssh -p 2222 umayloveme@192.168.219.110 'ss -tln | grep 18022'` → LISTEN); 폰 잠금 해제.
- [ ] 앱에서 본문 `keys://phone` 노트 생성/열기 → "키" FAB 표시 → 누르면 KeysView가 "연결 중..." 후 버튼 활성화(ready).
- [ ] 🔊 볼륨 업 누름 → 폰 볼륨 OSD가 올라감 + 버튼에 ✓.
- [ ] 🔉 볼륨 다운 누름 → 폰 볼륨 OSD가 내려감 + 버튼에 ✓.
- [ ] (리스크 확인) 역터널 로그인 uid `u0_a186`에서 `su -c`가 통과함 — 첫 키가 ✓면 grant OK. ✗(stderr에 권한 거부)면 폰 Magisk에서 Termux/shell su grant 후 재시도.

**Verify:** 앱에서 ▲/▼ 각각 눌러 폰 볼륨 OSD 변화 + 버튼 ✓ 육안 확인 (사용자 게이트).

**Steps:**

- [ ] **Step 1: bridge 재배포** — RPi에서 keys 코드 포함 빌드 + 재시작

```bash
# RPi(bridge)에서, 또는 Bazzite→RPi ssh로:
cd ~/term-bridge   # bridge 소스 위치(브랜치 phone-key-events 반영)
npm run build
systemctl --user restart term-bridge   # 또는 podman restart, deploy/README 참조
```
(배포 경로는 `bridge/deploy/`/1탄 런북 참조. bridge 로그에 `listening on :3000` 확인.)

- [ ] **Step 2: 역터널 LISTEN 확인**

```bash
ssh -p 2222 umayloveme@192.168.219.110 'ss -tln | grep 18022'
```
Expected: `LISTEN ... 127.0.0.1:18022`. 없으면 폰 깨우고 Termux:Boot 터널 확인(1탄).

- [ ] **Step 3: 노트 생성** — 앱에서 새 노트, 제목 한 줄 + 본문 첫 줄 `keys://phone`.

- [ ] **Step 4: 접속 + 키 전송** — "키" FAB 클릭 → ready 후 🔊/🔉 각각 눌러 폰 볼륨 OSD 변화 확인.

- [ ] **Step 5: 결과 기록** — ▲/▼ 동작 + 첫 키 ✓(su grant OK) 사용자 확인 시 게이트 통과.

---

## Self-Review

**1. Spec coverage:**
- 새 프로토콜 `keys://` 파싱 → Task 4 ✓. 볼륨 ± 빌트인 패드 → Task 1(코드)/Task 6(버튼) ✓. ssh 역터널 재사용 + mode:'keys' → Task 3 ✓. keycode 화이트리스트 셸주입 차단 → Task 1/Task 3 ✓. ControlMaster 프리웜 → Task 2/Task 3 ✓. 친절 에러(터널 끊김/미인증) → Task 3/Task 6 ✓. 테스트(bridge node--test, 프론트 vitest) → Task 1/2/4/5 ✓. E2E 게이트 + su grant 리스크 → Task 8 ✓. NoteWindow 패리티 비범위 — 의도적 제외(spec §1) ✓.
- 갭 없음.

**2. Placeholder scan:** TBD/TODO/"적절히" 없음. 모든 코드 스텝에 실제 코드 포함. 배포 경로(Step 1)는 1탄 런북 참조로 명시 — 환경 의존이라 정확한 경로는 사용자 환경값.

**3. Type consistency:** `KeysNoteSpec{raw,host,user?,port?,sshTarget}` — parseKeysNote(Task4) 정의 ↔ KeysView(Task6: `spec.sshTarget`,`spec.raw`) ↔ page(Task7) 일치. `KeysWsClient`/`WsLike`/`KeysClientStatus`/`KeysClientCallbacks`(Task5) ↔ KeysView 사용 일치. bridge `buildSshExecArgs(t,controlPath,cmd)`(Task2) ↔ server `runSshExec`/`startKeys`(Task3) 일치. `isAllowedKeyCode`/`buildKeyCommand`(Task1) ↔ server(Task3) 일치. 와이어 메시지 `{type:'connect',mode:'keys'}`/`{type:'key',code}`/`{key-ok}`/`{key-error}`/`{ready}`/`{error}` — keysClient(Task5) ↔ server(Task3) 양쪽 일치.
