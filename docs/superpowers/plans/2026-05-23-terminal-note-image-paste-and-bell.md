# 터미널 노트 이미지 붙여넣기 & 벨 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 노트에서 ① 이미지를 원격 호스트로 전송해 클로드 코드 등에 붙여넣고, ② 터미널 벨(`\x07`)을 노트에서 소리/진동으로 알린다.

**Architecture:** 벨은 클라이언트 전용 — xterm의 `onBell` 이벤트에 Web Audio 비프음 + 진동을 연결. 이미지는 SSH ControlMaster 멀티플렉싱 — 브릿지가 PTY용 ssh를 마스터 연결로 띄우고, 이미지가 도착하면 같은 ControlPath를 재사용하는 `ssh ... 'cat > file'`로 재인증 없이 원격에 파일을 올린 뒤, 그 경로를 PTY에 bracketed-paste로 주입한다. 둘 다 shell 모드 한정.

**Tech Stack:** SvelteKit / Svelte 5 runes, `@xterm/xterm`, Web Audio API, node-pty + `ssh` (브릿지, Node `child_process`), vitest (앱) / `node:test` (브릿지).

설계 문서: `docs/superpowers/specs/2026-05-22-terminal-note-image-paste-and-bell-design.md`

---

### Task 1: 사전 검증 — 클로드 코드가 붙여넣은 이미지 경로를 인식하는지 확인 (수동)

**Goal:** 경로 주입 방식이 실제로 동작하는지 코드 작성 전에 수동으로 확인해 접근법을 de-risk 한다.

**Files:** 없음 (수동 검증).

**Acceptance Criteria:**
- [ ] 원격 호스트에서 `claude` 실행 중, 그 호스트에 미리 둔 이미지 파일의 절대 경로를 **붙여넣었을 때** 클로드 코드가 `[Image #N]` 등 첨부로 표시하는지 — 예/아니오가 기록됨
- [ ] 경로를 **타이핑**했을 때의 동작도 기록됨
- [ ] 붙여넣기·타이핑 모두 인식 실패 시, 진행을 멈추고 설계 문서의 주입 방식을 재검토한다는 점이 명시됨

**Verify:** 수동 관찰 — 클로드 코드 화면에서 첨부 표시 여부 확인.

**Steps:**

- [ ] **Step 1: 원격 호스트에 테스트 이미지 배치**

평소 클로드 코드를 쓰는 SSH 원격 호스트에 접속해 이미지 파일 하나를 둔다. 예:

```bash
ssh user@host
# 원격에서:
curl -fsSL https://via.placeholder.com/200.png -o ~/tomboy-test.png || \
  printf 'fallback: 아무 png나 ~/tomboy-test.png 로 복사' 
ls -l ~/tomboy-test.png
```

- [ ] **Step 2: 클로드 코드에서 경로 붙여넣기 테스트**

원격에서 `claude` 실행 → 프롬프트에 `/home/user/tomboy-test.png` (실제 절대 경로)를 **터미널 붙여넣기**(Ctrl+Shift+V 등)로 입력. 클로드 코드가 이미지 첨부(`[Image #1]` 류)로 인식하는지 관찰.

- [ ] **Step 3: 타이핑 입력도 테스트**

같은 경로를 한 글자씩 **타이핑**한 뒤 확인. 붙여넣기와 동작이 다른지 기록.

- [ ] **Step 4: 결과 기록**

관찰 결과를 이 태스크의 완료 코멘트로 남긴다. 둘 다 실패면 진행을 멈추고 설계 문서
`docs/superpowers/specs/2026-05-22-terminal-note-image-paste-and-bell-design.md`의
"검증 항목" 절을 근거로 주입 방식을 재논의한다. (붙여넣기만 동작하면 계획대로
진행 — Task 6은 bracketed-paste 주입을 쓴다.)

---

### Task 2: 터미널 벨 링어 모듈 (`terminalBell.ts`)

**Goal:** xterm `onBell`에 연결할 벨 링어를 만든다 — 짧은 비프음 합성 + 진동, 연타 스로틀.

**Files:**
- Create: `app/src/lib/editor/terminal/terminalBell.ts`
- Test: `app/tests/unit/editor/terminalBell.test.ts`

**Acceptance Criteria:**
- [ ] `shouldRing(lastAt, now)` 순수 함수가 첫 호출 허용, 300ms 이내 억제, 300ms 이후 허용
- [ ] `createBellRinger()`가 호출 가능한 함수를 반환하고 내부적으로 스로틀
- [ ] 벨 모듈 테스트 3개 통과

**Verify:** `cd app && npm run test -- terminalBell` → 3 tests pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/terminalBell.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldRing } from '$lib/editor/terminal/terminalBell.js';

describe('shouldRing', () => {
	it('rings the first time (no previous bell)', () => {
		expect(shouldRing(null, 1000)).toBe(true);
	});

	it('suppresses a bell within the throttle window', () => {
		expect(shouldRing(1000, 1100)).toBe(false); // 100ms < 300ms
	});

	it('allows a bell at and after the throttle window', () => {
		expect(shouldRing(1000, 1300)).toBe(true); // exactly 300ms
		expect(shouldRing(1000, 1500)).toBe(true);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- terminalBell`
Expected: FAIL — `shouldRing` is not exported / module not found.

- [ ] **Step 3: 모듈 구현**

`app/src/lib/editor/terminal/terminalBell.ts`:

```ts
/**
 * 터미널 벨 — 터미널이 BEL(\x07)을 보내면 짧은 합성 비프음 + (모바일) 진동.
 * xterm의 `onBell` 이벤트에 연결해서 쓴다. shell 모드 전용.
 */

/** 프로그램이 \x07를 연타해도 오디오가 스팸되지 않도록 하는 최소 간격. */
const BELL_THROTTLE_MS = 300;

/**
 * 순수 스로틀 판정: `lastAt`(직전 벨 시각, 벨이 없었으면 null)을 기준으로
 * `now` 시점의 벨을 울려야 하는지.
 */
export function shouldRing(lastAt: number | null, now: number): boolean {
	if (lastAt === null) return true;
	return now - lastAt >= BELL_THROTTLE_MS;
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	if (!audioCtx) audioCtx = new Ctor();
	return audioCtx;
}

/** ~150ms 사인파 비프음. 클릭음 방지용 attack/decay 엔벨로프. */
function playBeep(): void {
	const ctx = getAudioContext();
	if (!ctx) return;
	// 자동재생 정책상 suspended일 수 있음 — 사용자는 노트를 열고 타이핑하며
	// 이미 상호작용했으므로 resume()이 통과한다.
	void ctx.resume();
	const t0 = ctx.currentTime;
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = 880;
	gain.gain.setValueAtTime(0, t0);
	gain.gain.linearRampToValueAtTime(0.2, t0 + 0.01); // 10ms attack
	gain.gain.setValueAtTime(0.2, t0 + 0.09);
	gain.gain.linearRampToValueAtTime(0, t0 + 0.15); // 60ms release
	osc.connect(gain).connect(ctx.destination);
	osc.start(t0);
	osc.stop(t0 + 0.16);
}

/**
 * 벨 링어를 만든다. 반환된 함수를 `term.onBell`에 넘긴다. 내부에서
 * `shouldRing`으로 스로틀한다.
 */
export function createBellRinger(): () => void {
	let lastAt: number | null = null;
	return () => {
		const now = Date.now();
		if (!shouldRing(lastAt, now)) return;
		lastAt = now;
		playBeep();
		try {
			navigator.vibrate?.(200);
		} catch {
			/* 진동 미지원 — 데스크탑 등 */
		}
	};
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- terminalBell`
Expected: PASS — 3 tests.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/terminal/terminalBell.ts app/tests/unit/editor/terminalBell.test.ts
git commit -m "feat(terminal): 벨 링어 모듈 (비프음 합성 + 진동 + 스로틀)"
```

---

### Task 3: 벨 설정 + 설정 페이지 토글 + `onBell` 연결

**Goal:** 벨 on/off 설정(`appSettings`)을 추가하고, 설정 페이지에 토글을 두고, `TerminalView`에서 `onBell`을 벨 링어에 연결한다.

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts` (터미널 설정 블록 끝, `setTerminalShellIntegrationBannerDismissed` 다음)
- Modify: `app/src/routes/settings/+page.svelte`
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] `getTerminalBellEnabled()`가 미설정 시 `true`를 반환
- [ ] 설정 페이지 터미널 탭에 "터미널 벨" 토글이 보이고, 변경이 즉시 저장됨
- [ ] 벨 켜진 상태로 터미널 노트에서 `printf '\a'` 실행 시 비프음, 끄면 무음 (재진입 후)
- [ ] `npm run check` 타입 통과

**Verify:** `cd app && npm run check` → 0 errors; 수동 QA — 벨 토글 on/off 동작.

**Steps:**

- [ ] **Step 1: `appSettings.ts`에 getter/setter 추가**

`app/src/lib/storage/appSettings.ts` 끝(파일 마지막 줄 `setTerminalShellIntegrationBannerDismissed` 함수 다음)에 추가:

```ts

const TERM_BELL_ENABLED = 'terminalBellEnabled';

export async function getTerminalBellEnabled(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_BELL_ENABLED);
	return typeof v === 'boolean' ? v : true;
}

export async function setTerminalBellEnabled(value: boolean): Promise<void> {
	await setSetting(TERM_BELL_ENABLED, value);
}
```

- [ ] **Step 2: 설정 페이지 — import 추가**

`app/src/routes/settings/+page.svelte`에서 `getTerminalHistoryPanelOpenDesktop` 등을 가져오는 `$lib/storage/appSettings.js` import 목록에 두 항목 추가:

```ts
	getTerminalBellEnabled,
	setTerminalBellEnabled,
```

- [ ] **Step 3: 설정 페이지 — state + load + save 추가**

`let termHistOpenMobile = $state(false);` 줄 근처(터미널 히스토리 설정 state 블록)에 추가:

```ts
	let termBellEnabled = $state(true);
```

`loadTerminalHistorySettings` 함수 본문 끝에 추가:

```ts
		termBellEnabled = await getTerminalBellEnabled();
```

`saveTermHistOpenMobile` 함수 다음에 추가:

```ts
	async function saveTermBellEnabled(): Promise<void> {
		await setTerminalBellEnabled(termBellEnabled);
	}
```

- [ ] **Step 4: 설정 페이지 — 마크업 추가**

"명령어 히스토리" `<section>`이 끝나는 `</section>` 다음, "셸 통합 (OSC 133)" `<section>` 시작 앞에 새 섹션 삽입:

```svelte
				<section class="section">
					<h2>터미널 벨</h2>
					<p class="info-text">
						터미널이 벨(<code>{'\\x07'}</code>)을 울리면 — 예: 클로드 코드가
						작업을 마칠 때 — 노트에서 짧은 소리와 진동으로 알립니다. shell
						모드에서만 동작하며, 노트가 화면에 떠 있을 때만 인지됩니다.
					</p>
					<label class="profile-row">
						<input
							type="checkbox"
							bind:checked={termBellEnabled}
							onchange={saveTermBellEnabled}
						/>
						<span>터미널 벨 소리/진동 켜기</span>
					</label>
				</section>
```

- [ ] **Step 5: `TerminalView.svelte` — import 추가**

기존 `$lib/storage/appSettings.js` import 목록(`getTerminalHistoryBlocklist` 등이 있는 블록)에 추가:

```ts
		getTerminalBellEnabled,
```

스크립트 상단의 다른 terminal import 근처에 추가:

```ts
	import { createBellRinger } from './terminalBell.js';
```

- [ ] **Step 6: `TerminalView.svelte` — `onBell` 연결**

`onMount` 안에서, OSC 핸들러용 `!isSpectator` 블록이 끝나는 주석
`} // end !isSpectator gate for OSC + history + shell-banner setup` 바로 다음에 추가:

```ts
		// 터미널 벨 — shell 모드 + 설정 on일 때만. \x07은 이미 데이터 스트림으로
		// 도착하므로 onBell 연결만으로 충분하다. 설정은 마운트 시점 1회 읽음 —
		// 토글을 바꾸면 노트를 다시 열어야 반영된다(다른 터미널 설정과 동일).
		if (!isSpectator) {
			const bellEnabled = await getTerminalBellEnabled();
			if (bellEnabled) {
				const ringBell = createBellRinger();
				term.onBell(() => ringBell());
			}
		}
```

- [ ] **Step 7: 타입 체크 + 수동 QA**

Run: `cd app && npm run check`
Expected: 0 errors.

수동: 터미널 노트 접속 → 원격에서 `printf '\a'` → 비프음 + (모바일) 진동.
설정에서 벨 끄기 → 노트 재진입 → `printf '\a'` → 무음.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/storage/appSettings.ts app/src/routes/settings/+page.svelte app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 터미널 벨 설정 토글 + onBell 연결"
```

---

### Task 4: 브릿지 ControlMaster 배선 (`pty.ts`, `server.ts`)

**Goal:** PTY용 ssh를 ControlMaster 마스터 연결로 띄우고, 세션마다 고유 ControlPath 소켓을 생성·정리한다.

**Files:**
- Modify: `bridge/src/pty.ts`
- Modify: `bridge/src/server.ts`
- Test: `bridge/src/pty.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `buildSshArgs(target)` — 포트/StrictHostKeyChecking/호스트를 올바른 순서로 구성
- [ ] `buildSshArgs(target, controlPath)` — `ControlMaster=auto`, `ControlPath=<경로>` 포함
- [ ] `isLocalTarget` — `localhost`(user 없음) → true, `user@localhost` → false
- [ ] `pty.test.ts` 테스트 전부 통과, 기존 브릿지 테스트도 통과
- [ ] `npm run build` (브릿지 tsc) 통과

**Verify:** `cd bridge && npm run build && npm test` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`bridge/src/pty.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSshArgs, isLocalTarget } from './pty.js';

test('buildSshArgs: basic remote, no controlPath', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com', user: 'me' }), [
		'-o',
		'StrictHostKeyChecking=accept-new',
		'me@example.com'
	]);
});

test('buildSshArgs: includes port before the host', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com', user: 'me', port: 2222 }), [
		'-p',
		'2222',
		'-o',
		'StrictHostKeyChecking=accept-new',
		'me@example.com'
	]);
});

test('buildSshArgs: host-only when no user', () => {
	assert.deepEqual(buildSshArgs({ host: 'example.com' }), [
		'-o',
		'StrictHostKeyChecking=accept-new',
		'example.com'
	]);
});

test('buildSshArgs: adds ControlMaster flags when controlPath given', () => {
	const args = buildSshArgs({ host: 'h', user: 'u' }, '/tmp/tomboy-ctl/abc.sock');
	assert.ok(args.includes('ControlMaster=auto'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/abc.sock'));
	// 호스트는 항상 마지막 — 옵션이 호스트 뒤로 새지 않아야 한다.
	assert.equal(args[args.length - 1], 'u@h');
});

test('isLocalTarget: localhost with no user is local', () => {
	assert.equal(isLocalTarget({ host: 'localhost' }), true);
	assert.equal(isLocalTarget({ host: '127.0.0.1' }), true);
});

test('isLocalTarget: user@localhost is NOT local (routes through host sshd)', () => {
	assert.equal(isLocalTarget({ host: 'localhost', user: 'me' }), false);
});

test('isLocalTarget: arbitrary remote is not local', () => {
	assert.equal(isLocalTarget({ host: 'example.com', user: 'me' }), false);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `buildSshArgs` / `isLocalTarget` not exported.

- [ ] **Step 3: `pty.ts` 리팩터 — `isLocalTarget` + `buildSshArgs` 추출**

`bridge/src/pty.ts`에서 기존 `spawnForTarget` 함수 전체를 아래로 교체:

```ts
/**
 * 타깃이 "로컬"인지 — user 없는 localhost/127.0.0.1/::1 또는 브릿지 호스트명.
 * 로컬이면 ssh 없이 브릿지의 로그인 셸을 띄운다.
 */
export function isLocalTarget(t: SshTarget): boolean {
	return (
		!t.user &&
		(LOCAL_HOSTS.has(t.host) || t.host.toLowerCase() === hostname().toLowerCase())
	);
}

/**
 * `ssh` 명령의 argv(ssh 자신 뒤의 인자들)를 구성한다. 순수 함수.
 *
 * `controlPath`가 주어지면 이 연결을 멀티플렉싱 "마스터"로 설정한다 — 같은
 * ControlPath를 가리키는 이후의 `ssh` 호출(imageTransfer.ts)이 이미 인증된 이
 * 연결을 재사용한다. 호스트 인자는 항상 마지막 — OpenSSH는 호스트 뒤의 토큰을
 * 원격 명령으로 취급하므로 옵션은 모두 호스트 앞에 와야 한다.
 */
export function buildSshArgs(t: SshTarget, controlPath?: string): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	if (controlPath) {
		args.push('-o', 'ControlMaster=auto');
		args.push('-o', `ControlPath=${controlPath}`);
	}
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	return args;
}

/**
 * 타깃용 PTY를 띄운다.
 *  - 로컬 타깃 → 브릿지 호스트의 로그인 셸.
 *  - 그 외 → `ssh ...`. 인증(키/비번)은 PTY를 통해 직접 흐른다 —
 *    자격증명을 중개하지 않는다.
 *  - `controlPath`가 주어지면 ControlMaster 마스터로 띄운다(이미지 전송용).
 */
export function spawnForTarget(
	t: SshTarget,
	cols: number,
	rows: number,
	controlPath?: string
): IPty {
	const env = sanitizedEnv();
	if (isLocalTarget(t)) {
		const shell = process.env.SHELL || '/bin/bash';
		return spawn(shell, ['-l'], {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: process.env.HOME || '/',
			env
		});
	}
	return spawn('ssh', buildSshArgs(t, controlPath), {
		name: 'xterm-256color',
		cols,
		rows,
		cwd: process.env.HOME || '/',
		env
	});
}
```

> 주의: 기존 `spawnForTarget` 위에 있던 `isLocal` 관련 주석/로직은 위 코드로
> 완전히 대체된다. `LOCAL_HOSTS`, `sanitizedEnv`, `SshTarget`, `parseSshTarget`,
> import는 그대로 둔다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS — `pty.test.ts` 7개 + 기존 테스트 전부.

- [ ] **Step 5: `server.ts` — ControlPath 소켓 생성/정리 배선**

`bridge/src/server.ts` 상단 import 블록에서 `pty.js` import를 수정하고 모듈을 추가:

```ts
import { parseSshTarget, spawnForTarget, isLocalTarget, type SshTarget } from './pty.js';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
```

`loadHostsFile(HOSTS_FILE);` 줄 근처(모듈 로드 시점)에 추가:

```ts
// ControlMaster 소켓이 사는 디렉터리. Unix 소켓 경로 길이 제한 때문에 /tmp 아래.
const CTRL_DIR = '/tmp/tomboy-ctl';
mkdirSync(CTRL_DIR, { recursive: true });
```

`const wss = new WebSocketServer({ noServer: true });` 를 교체:

```ts
// maxPayload: 이미지 프레임 수용(10 MB 이미지의 base64 ≈ 13.3 MB). 일반 data
// 프레임은 작으므로 영향 없음.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
```

`handleWs` 함수 안, `let pty ...` / `let spectator ...` 선언 근처에 추가:

```ts
	let controlPath: string | null = null;
	let sessionTarget: SshTarget | null = null;
```

`startSession` 함수의 첫 줄들을 수정 — 기존:

```ts
	async function startSession(target: SshTarget, cols: number, rows: number): Promise<void> {
		const wol = lookupWolTarget(target.host);
```

을 아래로:

```ts
	async function startSession(target: SshTarget, cols: number, rows: number): Promise<void> {
		sessionTarget = target;
		// 원격 타깃만 ControlMaster — 로컬 셸 타깃은 ssh 자체가 없다.
		if (!isLocalTarget(target)) {
			controlPath = `${CTRL_DIR}/${randomUUID().slice(0, 8)}.sock`;
		}
		const wol = lookupWolTarget(target.host);
```

같은 함수 안 `pty = spawnForTarget(target, cols, rows);` 를 교체:

```ts
			pty = spawnForTarget(target, cols, rows, controlPath ?? undefined);
```

`ws.on('close', ...)` 핸들러 안, `if (pty) { ... }` 블록 다음에 추가:

```ts
		if (controlPath) {
			// ssh 마스터가 죽으면 소켓도 사라지지만 best-effort로 정리.
			unlink(controlPath).catch(() => { /* 이미 없음 */ });
			controlPath = null;
		}
```

- [ ] **Step 6: 빌드 확인**

Run: `cd bridge && npm run build`
Expected: tsc 0 errors. (`sessionTarget`은 다음 태스크에서 쓰임 — 이 시점엔
미사용 경고가 날 수 있으니, 빌드만 통과하면 된다. tsconfig가 noUnusedLocals를
켜뒀다면 Step 5에서 `sessionTarget`을 선언만 하지 말고 Task 6과 함께 진행하거나,
`void sessionTarget;` 임시 줄로 우회 후 Task 6에서 제거한다.)

- [ ] **Step 7: 커밋**

```bash
git add bridge/src/pty.ts bridge/src/pty.test.ts bridge/src/server.ts
git commit -m "feat(terminal-bridge): ssh PTY를 ControlMaster 마스터로 띄우고 소켓 관리"
```

---

### Task 5: 이미지 전송 모듈 (`imageTransfer.ts`)

**Goal:** 디코딩된 이미지 바이트를 타깃 호스트에 올리고 그 경로를 돌려주는 브릿지 모듈. 순수 헬퍼는 TDD.

**Files:**
- Create: `bridge/src/imageTransfer.ts`
- Test: `bridge/src/imageTransfer.test.ts`

**Acceptance Criteria:**
- [ ] `mimeToExt` — png/jpeg/webp/gif 매핑, 미지원은 null
- [ ] `safeImageName` — `tomboy-<숫자>-<hex8>.<ext>` 패턴, 호출마다 다름
- [ ] `bracketedPaste` — `\x1b[200~ … \x1b[201~`로 감쌈
- [ ] `buildRemoteCatArgs` — BatchMode, ControlPath, 호스트, `mkdir && cat` 명령 포함
- [ ] 테스트 전부 통과

**Verify:** `cd bridge && npm test` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`bridge/src/imageTransfer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	mimeToExt,
	safeImageName,
	bracketedPaste,
	buildRemoteCatArgs,
	REMOTE_IMAGE_DIR
} from './imageTransfer.js';

test('mimeToExt: known image types', () => {
	assert.equal(mimeToExt('image/png'), 'png');
	assert.equal(mimeToExt('image/jpeg'), 'jpg');
	assert.equal(mimeToExt('image/webp'), 'webp');
	assert.equal(mimeToExt('image/gif'), 'gif');
});

test('mimeToExt: unsupported type → null', () => {
	assert.equal(mimeToExt('image/svg+xml'), null);
	assert.equal(mimeToExt('text/plain'), null);
});

test('safeImageName: matches safe pattern with given ext', () => {
	assert.match(safeImageName('png'), /^tomboy-\d+-[0-9a-f]{8}\.png$/);
});

test('safeImageName: two calls differ', () => {
	assert.notEqual(safeImageName('png'), safeImageName('png'));
});

test('bracketedPaste: wraps in paste markers', () => {
	assert.equal(bracketedPaste('/tmp/x.png'), '\x1b[200~/tmp/x.png\x1b[201~');
});

test('buildRemoteCatArgs: BatchMode + ControlPath + cat command, host before command', () => {
	const remotePath = `${REMOTE_IMAGE_DIR}/tomboy-1-aabbccdd.png`;
	const args = buildRemoteCatArgs(
		{ host: 'h', user: 'u' },
		'/tmp/tomboy-ctl/abc.sock',
		remotePath
	);
	assert.ok(args.includes('BatchMode=yes'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/abc.sock'));
	assert.equal(args[args.length - 2], 'u@h');
	assert.equal(
		args[args.length - 1],
		`mkdir -p ${REMOTE_IMAGE_DIR} && cat > ${remotePath}`
	);
});

test('buildRemoteCatArgs: includes port when set', () => {
	const args = buildRemoteCatArgs(
		{ host: 'h', user: 'u', port: 2222 },
		'/s.sock',
		`${REMOTE_IMAGE_DIR}/x.png`
	);
	const pIdx = args.indexOf('-p');
	assert.ok(pIdx >= 0);
	assert.equal(args[pIdx + 1], '2222');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `imageTransfer.js` 모듈 없음.

- [ ] **Step 3: 모듈 구현**

`bridge/src/imageTransfer.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { SshTarget } from './pty.js';

/** 전송된 이미지가 타깃 호스트에 놓이는 디렉터리. */
export const REMOTE_IMAGE_DIR = '/tmp/tomboy-images';

const MIME_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

/** 이미지 MIME → 확장자. 미지원이면 null. */
export function mimeToExt(mime: string): string | null {
	return MIME_EXT[mime] ?? null;
}

/**
 * 충돌 없고 셸-안전한 이미지 파일명을 만든다. 클라이언트가 보낸 원본 파일명은
 * 의도적으로 쓰지 않는다 — [a-z0-9-.]만 쓰는 고정 패턴이라 셸 메타문자가
 * 원격 명령에 닿지 않는다.
 */
export function safeImageName(ext: string): string {
	return `tomboy-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
}

/** TUI 앱이 "붙여넣기"로 인식하도록 bracketed-paste 마커로 감싼다. */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/**
 * 이미지를 원격으로 흘려보내는 `ssh` 명령의 argv를 만든다. 이미지 바이트는
 * 자식 프로세스의 stdin으로 파이프되고, 원격 `cat`이 `remotePath`에 쓴다.
 * `controlPath`의 ControlMaster 연결을 재사용한다(재인증 없음).
 *
 * ControlMaster는 지정하지 않는다(기본 no) — 이 보조 연결은 마스터를 만들지
 * 않고 *사용*만 한다. `BatchMode=yes`라 마스터가 없으면 프롬프트 없이 즉시
 * 실패한다. `remotePath`의 파일명은 safeImageName() 산출물이라 셸 메타문자가
 * 없으므로 원격 명령에 그대로 끼워도 안전하다. 호스트는 명령보다 먼저 온다.
 */
export function buildRemoteCatArgs(
	t: SshTarget,
	controlPath: string,
	remotePath: string
): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	args.push('-o', 'BatchMode=yes');
	args.push('-o', `ControlPath=${controlPath}`);
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	args.push(`mkdir -p ${REMOTE_IMAGE_DIR} && cat > ${remotePath}`);
	return args;
}

export interface TransferRequest {
	target: SshTarget;
	/** ControlMaster 소켓 경로. null이면 로컬 셸 타깃 → 브릿지 fs에 직접 기록. */
	controlPath: string | null;
	mime: string;
	bytes: Buffer;
}

export interface TransferResult {
	remotePath: string;
}

/**
 * 이미지를 타깃 호스트 파일시스템에 놓고 경로를 반환한다.
 *  - 원격 타깃(controlPath 있음): 멀티플렉싱 ssh 연결로 바이트를 `cat`에 전송.
 *  - 로컬 셸 타깃(controlPath null): 브릿지 호스트가 곧 타깃 → 파일을 직접 기록.
 * 미지원 MIME / 전송 실패 시 throw.
 */
export async function transferImage(req: TransferRequest): Promise<TransferResult> {
	const ext = mimeToExt(req.mime);
	if (!ext) throw new Error(`지원하지 않는 이미지 형식입니다: ${req.mime}`);
	const remotePath = `${REMOTE_IMAGE_DIR}/${safeImageName(ext)}`;

	if (req.controlPath === null) {
		await mkdir(REMOTE_IMAGE_DIR, { recursive: true });
		await writeFile(remotePath, req.bytes);
		return { remotePath };
	}

	await streamToRemote(req.target, req.controlPath, remotePath, req.bytes);
	return { remotePath };
}

function streamToRemote(
	t: SshTarget,
	controlPath: string,
	remotePath: string,
	bytes: Buffer
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('ssh', buildRemoteCatArgs(t, controlPath, remotePath));
		let stderr = '';
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `ssh가 코드 ${code}로 종료됨`));
		});
		// 원격이 일찍 닫으면 stdin EPIPE — close 핸들러가 사유를 보고하므로 무시.
		child.stdin.on('error', () => { /* ignore */ });
		child.stdin.end(bytes);
	});
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS — `imageTransfer.test.ts` 8개 + 기존 전부.

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/imageTransfer.ts bridge/src/imageTransfer.test.ts
git commit -m "feat(terminal-bridge): 이미지 전송 모듈 (ControlMaster 재사용 + 경로 헬퍼)"
```

---

### Task 6: 브릿지 `image` 메시지 처리 + 경로 주입

**Goal:** 브릿지 WS 핸들러가 `image` 메시지를 받아 `transferImage`로 원격에 올리고, 결과 경로를 PTY에 bracketed-paste로 주입한 뒤 ack를 회신한다.

**Files:**
- Modify: `bridge/src/server.ts`

**Acceptance Criteria:**
- [ ] `ClientMsg`에 `image` 타입과 `mime`/`data` 필드 추가
- [ ] shell 모드에서 `image` 메시지 → `transferImage` → PTY에 `\x1b[200~경로\x1b[201~ ` 주입
- [ ] 성공 시 `image-ok`, 실패 시 `image-error` 회신
- [ ] 관전 모드에서는 `image` 메시지 무시
- [ ] `npm run build` + 기존 `npm test` 통과

**Verify:** `cd bridge && npm run build && npm test` → tsc 0 errors, 모든 테스트 pass. (WS 핸들러는 기존 브릿지 테스트 관행대로 단위 테스트 없음 — 통합 동작은 Task 9 수동 QA.)

**Steps:**

- [ ] **Step 1: import + 타입 확장**

`bridge/src/server.ts` 상단 import에 추가:

```ts
import { transferImage, bracketedPaste } from './imageTransfer.js';
```

`ClientMsg` 인터페이스를 교체:

```ts
interface ClientMsg {
	type: 'connect' | 'data' | 'resize' | 'tmux-nav' | 'image';
	target?: string;
	token?: string;
	cols?: number;
	rows?: number;
	d?: string;
	mode?: 'shell' | 'spectate';
	session?: string;
	action?: 'next-pane' | 'prev-pane' | 'next-window' | 'prev-window';
	mime?: string;
	data?: string;
}
```

- [ ] **Step 2: 이미지 처리 헬퍼 추가**

`handleWs` 함수 안, `startSession` 함수 정의 다음(같은 클로저 스코프, `wakeIfNeeded`보다 위)에 추가:

```ts
	/**
	 * `image` 메시지 처리 — base64 디코딩 → 타깃 호스트로 전송 → PTY에 경로를
	 * bracketed-paste로 주입. shell 모드 전용(pty 필요). 경로 뒤 공백 한 칸은
	 * 이미지를 연달아 붙여넣을 때 경로가 서로 붙지 않게 한다.
	 */
	async function handleImageMessage(mime: string, dataB64: string): Promise<void> {
		if (!pty || !sessionTarget) return;
		let bytes: Buffer;
		try {
			bytes = Buffer.from(dataB64, 'base64');
		} catch {
			send({ type: 'image-error', message: '이미지 데이터가 올바르지 않습니다.' });
			return;
		}
		try {
			const { remotePath } = await transferImage({
				target: sessionTarget,
				controlPath,
				mime,
				bytes
			});
			pty.write(bracketedPaste(remotePath) + ' ');
			send({ type: 'image-ok', path: remotePath });
		} catch (err) {
			send({ type: 'image-error', message: (err as Error).message });
		}
	}
```

- [ ] **Step 3: WS 메시지 핸들러에 `image` 분기 추가**

`ws.on('message', ...)` 안, shell 모드 섹션의 `if (msg.type === 'resize') { ... }` 블록 **다음**(같은 레벨, `}` 닫힌 직후)에 추가:

```ts
		if (msg.type === 'image') {
			if (typeof msg.mime === 'string' && typeof msg.data === 'string') {
				void handleImageMessage(msg.mime, msg.data);
			}
			return;
		}
```

> 참고: 관전(`spectator`) 모드 분기는 이 위에서 이미 `data`/`tmux-nav`만
> 처리하고 `return`하므로 `image`는 자동으로 무시된다 — 별도 작업 불필요.

- [ ] **Step 4: `sessionTarget` 미사용 경고 우회 줄 제거**

Task 4 Step 6에서 `void sessionTarget;` 임시 줄을 넣었다면 지금 제거한다(이제
`handleImageMessage`가 실제로 쓴다).

- [ ] **Step 5: 빌드 + 테스트**

Run: `cd bridge && npm run build && npm test`
Expected: tsc 0 errors, 모든 테스트 pass.

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/server.ts
git commit -m "feat(terminal-bridge): image 메시지 처리 — 전송 후 PTY에 경로 주입"
```

---

### Task 7: 클라이언트 이미지 헬퍼 (`imagePasteClient.ts`)

**Goal:** 파일 검증 / FileList 필터 / File→base64 페이로드 변환 순수 헬퍼. TDD.

**Files:**
- Create: `app/src/lib/editor/terminal/imagePasteClient.ts`
- Test: `app/tests/unit/editor/imagePasteClient.test.ts`

**Acceptance Criteria:**
- [ ] `validateImageFile` — 이미지/크기 검증, 한국어 오류 메시지
- [ ] `imageFilesFromList` — FileList/배열에서 이미지 파일만 추림
- [ ] `fileToImagePayload` — `data:` 프리픽스 제거한 base64 + mime 반환
- [ ] 테스트 전부 통과

**Verify:** `cd app && npm run test -- imagePasteClient` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/imagePasteClient.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	validateImageFile,
	imageFilesFromList,
	fileToImagePayload,
	MAX_IMAGE_BYTES
} from '$lib/editor/terminal/imagePasteClient.js';

function makeFile(bytes: number, type: string, name = 'x'): File {
	return new File([new Uint8Array(bytes)], name, { type });
}

describe('validateImageFile', () => {
	it('accepts a small png', () => {
		expect(validateImageFile(makeFile(10, 'image/png'))).toEqual({ ok: true });
	});
	it('rejects a non-image file', () => {
		const r = validateImageFile(makeFile(10, 'text/plain'));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/이미지 파일/);
	});
	it('rejects an oversized image', () => {
		const r = validateImageFile(makeFile(MAX_IMAGE_BYTES + 1, 'image/png'));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/너무 큽/);
	});
});

describe('imageFilesFromList', () => {
	it('keeps only image files', () => {
		const files = [
			makeFile(1, 'image/png', 'a'),
			makeFile(1, 'text/plain', 'b'),
			makeFile(1, 'image/jpeg', 'c')
		];
		expect(imageFilesFromList(files).map((f) => f.name)).toEqual(['a', 'c']);
	});
});

describe('fileToImagePayload', () => {
	it('reads a file into mime + base64 (no data: prefix)', async () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
		const payload = await fileToImagePayload(file);
		expect(payload.mime).toBe('image/png');
		// base64 of bytes [1,2,3] is "AQID"
		expect(payload.data).toBe('AQID');
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- imagePasteClient`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 모듈 구현**

`app/src/lib/editor/terminal/imagePasteClient.ts`:

```ts
import { extractImageFile } from '$lib/editor/imagePreview/extractImageFile.js';

/** 허용 최대 이미지 크기 — 브릿지의 16 MB WS 한도 아래로 유지. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImagePayload {
	mime: string;
	/** base64 인코딩 이미지 바이트. data: URI 프리픽스 없음. */
	data: string;
}

export interface ValidationResult {
	ok: boolean;
	error?: string;
}

/** 후보 이미지 파일 검증 — image/* 타입 + 크기 한도. */
export function validateImageFile(file: File): ValidationResult {
	if (!file.type.startsWith('image/')) {
		return { ok: false, error: '이미지 파일이 아닙니다.' };
	}
	if (file.size > MAX_IMAGE_BYTES) {
		const mb = Math.floor(MAX_IMAGE_BYTES / 1024 / 1024);
		return { ok: false, error: `이미지가 너무 큽니다 (최대 ${mb} MB).` };
	}
	return { ok: true };
}

/** FileList / File[]에서 이미지 파일만 추린다 (드롭 + 파일선택 경로용). */
export function imageFilesFromList(files: FileList | File[]): File[] {
	return Array.from(files).filter((f) => f.type.startsWith('image/'));
}

/**
 * File을 ImagePayload(base64)로 읽는다. FileReader가 만드는 `data:...;base64,`
 * 프리픽스는 잘라내고 순수 base64 본문만 담는다.
 */
export function fileToImagePayload(file: File): Promise<ImagePayload> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
		reader.onload = () => {
			const result = String(reader.result);
			const comma = result.indexOf(',');
			if (comma < 0) {
				reject(new Error('파일을 읽지 못했습니다.'));
				return;
			}
			resolve({ mime: file.type, data: result.slice(comma + 1) });
		};
		reader.readAsDataURL(file);
	});
}

/** 재노출: paste/drop DataTransfer에서 이미지 File 하나를 뽑는다. */
export { extractImageFile };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- imagePasteClient`
Expected: PASS — 5 tests.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/terminal/imagePasteClient.ts app/tests/unit/editor/imagePasteClient.test.ts
git commit -m "feat(terminal): 클라이언트 이미지 헬퍼 (검증/필터/base64 변환)"
```

---

### Task 8: `wsClient.ts` — `sendImage` + `onImageResult`

**Goal:** WS 클라이언트에 이미지 프레임 전송 메서드와 `image-ok`/`image-error` 수신 콜백을 추가한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/wsClient.ts`
- Test: `app/tests/unit/editor/wsClientSendImage.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `sendImage({mime, data})` — `{type:'image', mime, data}` 프레임 전송, ws 닫힘 시 no-op
- [ ] `image-ok` 메시지 → `onImageResult(true, {path})`
- [ ] `image-error` 메시지 → `onImageResult(false, {message})`
- [ ] 테스트 전부 통과

**Verify:** `cd app && npm run test -- wsClientSendImage` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/wsClientSendImage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

interface FakeState {
	readyState: number;
	sent: string[];
	onopen?: () => void;
	onmessage?: (ev: { data: string }) => void;
}

describe('TerminalWsClient image', () => {
	let fake: FakeState;
	let client: TerminalWsClient;
	let results: Array<{ ok: boolean; info: { path?: string; message?: string } }>;

	beforeEach(() => {
		fake = { readyState: 1, sent: [] };
		results = [];

		// @ts-expect-error patch global WebSocket
		globalThis.WebSocket = class {
			get readyState() { return fake.readyState; }
			send(s: string) { fake.sent.push(s); }
			close() {}
			set onopen(fn: (() => void) | undefined) { fake.onopen = fn; }
			set onmessage(fn: ((ev: { data: string }) => void) | undefined) { fake.onmessage = fn; }
			set onclose(_fn: unknown) {}
			set onerror(_fn: unknown) {}
			static OPEN = 1;
		};

		client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://localhost',
			token: 't',
			cols: 80,
			rows: 24,
			onData: () => {},
			onStatus: () => {},
			onImageResult: (ok, info) => results.push({ ok, info })
		});
		client.connect();
		fake.onopen?.();
		fake.sent.length = 0;
	});

	it('sendImage sends an image frame', () => {
		client.sendImage({ mime: 'image/png', data: 'AQID' });
		expect(fake.sent).toEqual([
			JSON.stringify({ type: 'image', mime: 'image/png', data: 'AQID' })
		]);
	});

	it('no-ops when ws is not open', () => {
		fake.readyState = 3; // CLOSED
		client.sendImage({ mime: 'image/png', data: 'AQID' });
		expect(fake.sent).toEqual([]);
	});

	it('image-ok message → onImageResult(true, {path})', () => {
		fake.onmessage?.({
			data: JSON.stringify({ type: 'image-ok', path: '/tmp/tomboy-images/x.png' })
		});
		expect(results).toEqual([{ ok: true, info: { path: '/tmp/tomboy-images/x.png' } }]);
	});

	it('image-error message → onImageResult(false, {message})', () => {
		fake.onmessage?.({ data: JSON.stringify({ type: 'image-error', message: 'boom' }) });
		expect(results).toEqual([{ ok: false, info: { message: 'boom' } }]);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- wsClientSendImage`
Expected: FAIL — `sendImage` / `onImageResult` 미정의.

- [ ] **Step 3: `wsClient.ts` 수정**

`ClientOptions` 인터페이스에 콜백 추가 (`onPaneResize` 줄 다음):

```ts
	/** Called when the bridge reports an image transfer result. */
	onImageResult?: (ok: boolean, info: { path?: string; message?: string }) => void;
```

`ServerMsg` 인터페이스의 `type` 유니온에 `'image-ok' | 'image-error'`를 추가하고
`path` 필드를 추가:

```ts
interface ServerMsg {
	type:
		| 'data'
		| 'exit'
		| 'error'
		| 'ready'
		| 'pane-switch'
		| 'pane-resize'
		| 'image-ok'
		| 'image-error';
	d?: string;
	code?: number;
	message?: string;
	paneId?: string;
	cols?: number;
	rows?: number;
	altScreen?: boolean;
	windowIndex?: string;
	windowName?: string;
	path?: string;
}
```

`onmessage` 핸들러 안, `else if (msg.type === 'exit')` 분기 **앞**에 추가:

```ts
			} else if (msg.type === 'image-ok') {
				this.opts.onImageResult?.(true, { path: msg.path });
			} else if (msg.type === 'image-error') {
				this.opts.onImageResult?.(false, { message: msg.message });
```

`sendCommand` 메서드 다음에 새 메서드 추가:

```ts
	/**
	 * Send an image to the bridge. The bridge places it on the target host
	 * and pastes its path into the PTY. `data` is base64 (no data: prefix).
	 */
	sendImage(payload: { mime: string; data: string }): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(
				JSON.stringify({ type: 'image', mime: payload.mime, data: payload.data })
			);
		}
	}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- wsClientSendImage`
Expected: PASS — 4 tests.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/terminal/wsClient.ts app/tests/unit/editor/wsClientSendImage.test.ts
git commit -m "feat(terminal): wsClient에 sendImage + onImageResult 추가"
```

---

### Task 9: `TerminalView.svelte` — 이미지 트리거 + UI

**Goal:** `TerminalView`에 Ctrl+V 붙여넣기 / 드래그앤드롭 / 헤더 버튼+파일선택 트리거를 달고, 업로드 상태와 결과 토스트를 표시한다. shell 모드 전용.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] 데스크탑에서 Ctrl+V로 클립보드 이미지 전송 (텍스트 붙여넣기는 기존대로)
- [ ] 드래그앤드롭으로 이미지 파일 전송
- [ ] 헤더 "이미지" 버튼 → 파일 선택(모바일 카메라/사진첩) → 전송
- [ ] 업로드 중 버튼이 "업로드 중…"으로 바뀌고 비활성화
- [ ] 전송 결과가 토스트로 표시 (성공/실패)
- [ ] 관전 모드에서는 이미지 버튼/트리거 없음
- [ ] `npm run check` 타입 통과, `npm run build` 성공

**Verify:** `cd app && npm run check && npm run build` → 0 errors; 수동 QA — 아래 Step 8.

**Steps:**

- [ ] **Step 1: import 추가**

`TerminalView.svelte` 스크립트 상단, 다른 terminal import 근처에 추가:

```ts
	import {
		extractImageFile,
		imageFilesFromList,
		fileToImagePayload,
		validateImageFile
	} from './imagePasteClient.js';
	import { pushToast } from '$lib/stores/toast.js';
```

- [ ] **Step 2: state + 파일 입력 ref 추가**

기존 `let sendPopupInput: HTMLInputElement | undefined = $state();` 근처에 추가:

```ts
	// 이미지 붙여넣기 (shell 모드 전용). imageUploadCount > 0 → "업로드 중" 표시.
	let imageUploadCount = $state(0);
	let imageFileInput: HTMLInputElement | undefined = $state();
```

- [ ] **Step 3: 이미지 전송 함수 추가**

`sendQuickKey` 함수 다음에 추가:

```ts
	/** 이미지 File 하나를 검증 후 브릿지로 전송. */
	async function sendImageFile(file: File): Promise<void> {
		const v = validateImageFile(file);
		if (!v.ok) {
			pushToast(v.error ?? '이미지를 보낼 수 없습니다.', { kind: 'error' });
			return;
		}
		if (!client || status !== 'open') {
			pushToast('터미널이 연결되어 있지 않습니다.', { kind: 'error' });
			return;
		}
		imageUploadCount += 1;
		try {
			const payload = await fileToImagePayload(file);
			client.sendImage(payload);
		} catch (err) {
			imageUploadCount = Math.max(0, imageUploadCount - 1);
			pushToast((err as Error).message, { kind: 'error' });
		}
	}

	/** 헤더 "이미지" 버튼 → 숨겨진 파일 입력 열기. */
	function openImagePicker(): void {
		imageFileInput?.click();
	}

	/** 파일 입력 onchange — 고른 이미지들을 모두 전송. */
	function onImageFilePicked(e: Event): void {
		const input = e.currentTarget as HTMLInputElement;
		for (const f of imageFilesFromList(input.files ?? [])) void sendImageFile(f);
		input.value = ''; // 같은 파일을 다시 고를 수 있게 리셋
	}

	/** Ctrl+V 등 붙여넣기 — 클립보드에 이미지가 있으면 가로채 전송. */
	function handleImagePaste(e: ClipboardEvent): void {
		if (isSpectator) return;
		const file = extractImageFile(e.clipboardData);
		if (!file) return; // 이미지 없음 → xterm의 기본 텍스트 붙여넣기에 맡김
		e.preventDefault();
		e.stopPropagation();
		void sendImageFile(file);
	}

	/** dragover — drop을 허용하려면 preventDefault 필요. */
	function handleImageDragOver(e: DragEvent): void {
		if (isSpectator) return;
		e.preventDefault();
	}

	/** drop — 드롭된 이미지 파일을 모두 전송. */
	function handleImageDrop(e: DragEvent): void {
		if (isSpectator) return;
		e.preventDefault();
		const files = imageFilesFromList(e.dataTransfer?.files ?? []);
		for (const f of files) void sendImageFile(f);
	}
```

- [ ] **Step 4: `onImageResult` 콜백을 양쪽 client 생성에 추가**

`onMount` 안의 `client = new TerminalWsClient({ ... })`와 `reconnect()` 안의
`client = new TerminalWsClient({ ... })` **둘 다**, `onPaneResize` 콜백 다음에
아래 콜백을 추가:

```ts
			onImageResult: (ok, info) => {
				imageUploadCount = Math.max(0, imageUploadCount - 1);
				if (ok) pushToast('이미지 전송됨', {});
				else pushToast(info.message ?? '이미지 전송 실패', { kind: 'error' });
			},
```

- [ ] **Step 5: paste/drop 리스너 등록 — `onMount`**

`onMount` 안, `window.addEventListener('keydown', handleWindowKeydown, true);` 다음에 추가:

```ts
		// 이미지 붙여넣기/드롭 — pageEl에 capture-phase로 등록해 xterm의 자체
		// textarea 핸들러보다 먼저 가로챈다. shell 모드에서만 의미가 있고,
		// 핸들러 내부에서 isSpectator를 다시 검사한다.
		if (pageEl) {
			pageEl.addEventListener('paste', handleImagePaste, true);
			pageEl.addEventListener('dragover', handleImageDragOver, true);
			pageEl.addEventListener('drop', handleImageDrop, true);
		}
```

- [ ] **Step 6: 리스너 해제 — `onDestroy`**

`onDestroy` 안, `window.removeEventListener('keydown', handleWindowKeydown, true);` 다음에 추가:

```ts
		if (pageEl) {
			pageEl.removeEventListener('paste', handleImagePaste, true);
			pageEl.removeEventListener('dragover', handleImageDragOver, true);
			pageEl.removeEventListener('drop', handleImageDrop, true);
		}
```

- [ ] **Step 7: 헤더 버튼 + 숨겨진 파일 입력 마크업**

`.actions` div 안, `{#if !isSpectator}` 블록 안의 히스토리 토글 버튼 다음에 추가
(즉 `히스토리 ({currentItems.length})` 버튼을 닫는 `</button>` 바로 뒤, 같은
`{#if !isSpectator}` 블록 내부):

```svelte
				<button
					type="button"
					class="toggle"
					onclick={openImagePicker}
					disabled={status !== 'open' || imageUploadCount > 0}
				>
					{imageUploadCount > 0 ? '업로드 중…' : '이미지'}
				</button>
```

그리고 `.terminal-page` 최상위 div이 닫히는 `</div>` 다음(파일 맨 끝의 `{#if sendPopupOpen}` 앞)에 숨겨진 파일 입력을 추가:

```svelte
<input
	type="file"
	accept="image/*"
	multiple
	bind:this={imageFileInput}
	onchange={onImageFilePicked}
	style="display: none"
/>
```

- [ ] **Step 8: 타입 체크 + 빌드 + 수동 QA**

Run: `cd app && npm run check && npm run build`
Expected: 0 errors, 빌드 성공.

수동 QA (실제 브릿지 + 클로드 코드 필요):
1. 데스크탑 노트창에서 터미널 노트 접속 → `claude` 실행 → 스크린샷 복사 후
   Ctrl+V → 토스트 "이미지 전송됨", 클로드 코드에 이미지 첨부 표시.
2. 이미지 파일을 터미널 영역에 드래그앤드롭 → 동일.
3. 모바일 노트에서 "이미지" 버튼 → 사진첩/카메라 선택 → 동일.
4. 텍스트만 복사 후 Ctrl+V → 기존대로 텍스트가 입력됨(이미지 경로 아님).
5. 관전 모드 노트 → "이미지" 버튼이 없음.

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 이미지 붙여넣기 UI — Ctrl+V/드롭/버튼 트리거"
```

---

### Task 10: 문서 갱신 (`tomboy-terminal` 스킬 + CLAUDE.md)

**Goal:** 새 기능을 `tomboy-terminal` 스킬과 CLAUDE.md의 터미널 노트 섹션에 반영한다.

**Files:**
- Modify: `.claude/skills/tomboy-terminal/SKILL.md`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `SKILL.md`에 이미지 붙여넣기(ControlMaster 전송 + 경로 주입)와 벨(onBell) 기능 설명 추가
- [ ] `SKILL.md` Quick map에 `terminalBell.ts`, `imagePasteClient.ts`, `imageTransfer.ts` 추가
- [ ] CLAUDE.md "터미널 노트" 섹션에 두 기능 한 줄 요약 + Quick map 갱신
- [ ] graphify 그래프 갱신

**Verify:** 두 파일 diff 검토 — 새 기능이 정확히 기술됐는지 육안 확인.

**Steps:**

- [ ] **Step 1: `SKILL.md` 갱신**

`.claude/skills/tomboy-terminal/SKILL.md`를 읽고:
- 이미지 붙여넣기 절 추가: shell 모드에서 Ctrl+V/드롭/버튼으로 이미지를 보내면
  브릿지가 ControlMaster 멀티플렉싱(`-o ControlMaster=auto -o ControlPath=...`)을
  통해 `ssh ... 'cat > /tmp/tomboy-images/...'`로 재인증 없이 원격에 올리고, 그
  경로를 PTY에 bracketed-paste로 주입한다는 점.
- 벨 절 추가: xterm `onBell` → 합성 비프음 + 진동, `terminalBellEnabled` 설정,
  shell 모드 전용.
- Quick map에 신규 파일 3개 추가.

- [ ] **Step 2: CLAUDE.md 갱신**

`CLAUDE.md`의 "터미널 노트" 섹션에:
- 이미지 붙여넣기 + 벨 한 줄 요약 추가.
- Quick map의 `app/src/lib/editor/terminal/` 목록에 `terminalBell.ts`,
  `imagePasteClient.ts` 추가, `bridge/` 목록에 `imageTransfer.ts` 추가.
- Cross-cutting invariants에 한 줄: "이미지 붙여넣기는 ControlMaster로
  재인증 없이 전송 — 브릿지는 여전히 자격증명을 중개하지 않는다."

- [ ] **Step 3: graphify 갱신**

```bash
graphify update .
```

- [ ] **Step 4: 커밋**

```bash
git add .claude/skills/tomboy-terminal/SKILL.md CLAUDE.md graphify-out
git commit -m "docs(terminal): 이미지 붙여넣기 + 벨 기능 문서화"
```

---

## 자기 검토 (작성자 체크리스트)

**스펙 커버리지** — 설계 문서 각 절을 태스크에 매핑:
- 벨 (onBell/비프음/진동/스로틀/설정) → Task 2, 3 ✓
- ControlMaster (pty.ts/server.ts 소켓) → Task 4 ✓
- `image` WS 메시지 + 전송 모듈 → Task 5, 6 ✓
- 경로 주입 (bracketed-paste, Enter 미입력) → Task 6 ✓
- 클라이언트 트리거 (Ctrl+V/드롭/버튼) + 피드백 → Task 7, 8, 9 ✓
- 오류 처리 (인증 전/과대/미지원 mime/인젝션) → Task 5(mime), 7(크기), 6(전송 실패) ✓
- 검증 항목 (경로 인식) → Task 1 ✓
- 후속 문서 → Task 10 ✓
- `maxPayload` → Task 4 Step 5 ✓
- 범위: 관전 모드 제외 → Task 3(벨), 6/9(이미지) 모두 명시 ✓

**플레이스홀더 스캔** — "TBD"/"적절히 처리" 등 없음. 모든 코드 스텝에 실제 코드 포함 ✓

**타입 일관성** — `ImagePayload`/`{mime,data}` 형태가 Task 5·7·8에서 일치;
`buildSshArgs`(Task 4)·`buildRemoteCatArgs`(Task 5) 시그니처 일관; `onImageResult`
콜백 시그니처가 Task 8 정의와 Task 9 사용에서 일치; `transferImage`의
`controlPath: string | null`이 Task 5 정의와 Task 6 호출에서 일치 ✓

**설계 대비 정제** — 설계 문서는 "브릿지 로컬 임시 파일 → scp"였으나, 계획은
원격 전송 시 임시 파일 없이 디코딩한 Buffer를 ssh stdin으로 직접 파이프한다
(`streamToRemote`). 더 단순하고 동등하며 설계 의도(ControlMaster 재사용)를
그대로 지킨다. 로컬 타깃은 설계대로 파일을 직접 기록.
