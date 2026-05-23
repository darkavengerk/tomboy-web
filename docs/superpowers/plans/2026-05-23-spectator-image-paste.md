# 관전 모드 이미지 붙여넣기 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 셸 모드에서만 동작하던 터미널 노트의 이미지 붙여넣기 패스를 관전 모드까지 확장한다.

**Architecture:** 셸 모드의 ControlMaster 패턴(이미 검증된 `imageTransfer` 모듈)을 관전 모드 ssh 프로세스에도 적용하고, 경로 주입을 `pty.write` 대신 `SpectatorSession.sendInput`(`tmux send-keys -H`)으로 분기한다. UI는 데스크탑 관전 모드의 기존 가드 4개를 풀어 셸 모드와 동일한 트리거를 활성화하고, 모바일은 보내기 팝업에 두 버튼 + textarea `onpaste` 핸들러를 추가한다.

**Tech Stack:** Node.js (node-pty, ssh ControlMaster), TypeScript, Svelte 5 runes, SvelteKit, vitest (app), node:test (bridge), tmux 3.0+ (`send-keys -H`).

**Spec:** [`docs/superpowers/specs/2026-05-23-spectator-image-paste-design.md`](../specs/2026-05-23-spectator-image-paste-design.md)

---

## 파일 맵

| 파일 | 변경 종류 | 책임 |
|------|----------|------|
| `bridge/src/pty.ts` | Modify | `controlMasterArgs(controlPath)` 헬퍼 추출. `buildSshArgs`는 헬퍼 호출로 변경(동작 불변). |
| `bridge/src/pty.test.ts` | Modify | 새 헬퍼 단위 테스트 추가. 기존 buildSshArgs 회귀 테스트 유지. |
| `bridge/src/spectatorSession.ts` | Modify | 생성자에 `controlPath?: string` 옵션 추가. ssh 인자 구성에 `controlMasterArgs(controlPath)` 끼움. `hasActivePane()` 메서드 신규. |
| `bridge/src/spectatorSession.test.ts` | Create | ssh 인자가 controlPath 옵션을 반영하는지 + hasActivePane 동작. |
| `bridge/src/server.ts` | Modify | `startSpectator`에서 `sessionTarget`/`controlPath` 세팅, SpectatorSession 옵션에 controlPath 전달. `handleImageMessage`에 spectator 분기 추가. |
| `app/src/lib/editor/terminal/TerminalView.svelte` | Modify | (a) 4개 `if (isSpectator) return;` 가드 제거, (b) 헤더 "이미지" 버튼을 양 모드에서 표시, (c) 보내기 팝업에 이미지 행 2버튼 + textarea `onpaste`, (d) 신규 핸들러 `onSendPopupPaste`, `onClickPasteImage`. |
| `app/tests/unit/editor/sendPopupImageButtons.test.ts` | Create | 두 신규 핸들러 단위 테스트. |
| `CLAUDE.md` | Modify | 터미널 노트 섹션 — 관전 모드도 이미지 지원함 1줄. |
| `.claude/skills/tomboy-terminal/SKILL.md` | Modify | 관전 모드 이미지 입구 두 곳 명시 + Quick map 갱신. |

---

## 태스크 의존성

```
Task 1 (사전 검증, user-gate)  ← 모든 임플 이전에 한 번
   │
   ▼
Task 2 (controlMasterArgs 추출)
   │
   ▼
Task 3 (SpectatorSession + controlPath + hasActivePane)
   │
   ▼
Task 4 (server.ts: startSpectator + handleImageMessage)
   │
Task 5 (UI: 데스크탑 관전 가드 풀기) ←── 독립
   │
   ▼
Task 6 (UI: 보내기 팝업 이미지 행)
   │
   ▼ (Task 4도 같이)
Task 7 (E2E 수동 검증, user-gate)
   │
   ▼
Task 8 (문서 갱신)
```

---

### Task 1: 사전 검증 — 셸 모드 이미지 붙여넣기 실제 동작 확인 (수동)

**Goal:** 본 작업 시작 전에, 셸 모드의 ControlMaster 이미지 전송 패스가 실제 원격 호스트에서 동작함을 한 번 검증한다.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**왜 (rationale):** 이전 "잘 됨" 검증은 데스크탑 + 로컬 호스트 조합에서 우리 패스가 아닌 클로드 코드의 OS 클립보드 직접 접근이 동작한 것이었다. 원격 호스트에서 우리 patch(transferImage → pty.write(bracketedPaste))가 실제로 작동하는지는 아직 검증된 적 없다. 만약 셸 모드 자체가 망가져 있으면, 동일 패턴을 관전 모드에 복제하기 전에 발견하는 것이 비용이 가장 싸다.

**Files:** 없음 (수동 검증).

**Acceptance Criteria:**

- [ ] 원격 (non-localhost, 즉 `ssh://user@<remote-host>` 형식) ssh 노트에 클로드 코드가 실행 중인 상태로 데스크탑 브라우저에서 접속.
- [ ] OS 클립보드에 이미지 한 장 복사 (예: 스크린샷 도구).
- [ ] 노트 화면에서 Ctrl+V를 눌러 이미지 붙여넣기.
- [ ] 클로드 코드 출력에 bracketed-paste된 경로(예: `/tmp/tomboy-images/tomboy-<unix-ms>-<hex>.png`)가 표시되며, 클로드 코드가 그 경로를 첨부 파일로 인식함(첨부 indicator / "Image attached" 등)을 직접 확인.
- [ ] 헤더 "이미지" 버튼으로도 동일하게 작동함을 확인 (파일 선택 → 동일한 경로 주입 + 인식).
- [ ] 검증 결과(성공/실패 + 관찰한 출력) 기록 후 다음 태스크로 진행.

**실패 시:** 본 플랜 진행 중단하고 셸 모드 결함부터 디버깅. 관전 모드 구현은 셸 모드 패스가 동작한다는 전제 위에 서 있음.

**Verify:** (수동) — 위 acceptance criteria 6개 항목 직접 확인.

```json:metadata
{"files": [], "verifyCommand": "", "acceptanceCriteria": ["원격 ssh 노트에서 Ctrl+V 이미지 → 클로드 코드가 /tmp/tomboy-images/ 경로 인식", "헤더 이미지 버튼 → 동일 인식", "관찰 결과 기록"], "userGate": true, "tags": ["user-gate"]}
```

---

### Task 2: `controlMasterArgs(controlPath)` 헬퍼 추출

**Goal:** `buildSshArgs`에 내장된 ControlMaster 플래그 구성을 별도 `export` 함수로 빼서 `SpectatorSession`이 같은 헬퍼를 재사용할 수 있게 한다.

**Files:**
- Modify: `bridge/src/pty.ts`
- Modify: `bridge/src/pty.test.ts`

**Acceptance Criteria:**

- [ ] `controlMasterArgs(controlPath: string): string[]`를 export. 반환값은 정확히 `['-o', 'ControlMaster=auto', '-o', \`ControlPath=${controlPath}\`]`.
- [ ] `buildSshArgs`가 내부적으로 `controlMasterArgs`를 호출. 기존 동작(인자 순서, 반환값) 불변.
- [ ] 기존 `buildSshArgs` 테스트 4개 모두 그대로 통과.
- [ ] 신규 `controlMasterArgs` 테스트 통과.

**Verify:** `cd bridge && npm run build && npm test -- --test-name-pattern="controlMasterArgs|buildSshArgs"` → 모든 테스트 PASS.

**Steps:**

- [ ] **Step 1: 새 테스트 작성 (실패 확인)**

`bridge/src/pty.test.ts`에 추가:

```ts
import { buildSshArgs, controlMasterArgs, isLocalTarget } from './pty.js';

// ... 기존 테스트 유지 ...

test('controlMasterArgs: returns ControlMaster + ControlPath flags', () => {
	assert.deepEqual(controlMasterArgs('/tmp/tomboy-ctl/abc.sock'), [
		'-o',
		'ControlMaster=auto',
		'-o',
		'ControlPath=/tmp/tomboy-ctl/abc.sock'
	]);
});
```

import 라인의 추가 import는 `controlMasterArgs` — 아직 export 안 되어 있으므로 컴파일 실패할 것.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npm run build`
Expected: `error TS2305: Module ... has no exported member 'controlMasterArgs'.`

- [ ] **Step 3: 헬퍼 추출 + buildSshArgs 변경**

`bridge/src/pty.ts`의 `buildSshArgs`를 다음과 같이 변경:

```ts
/**
 * `ssh -o ControlMaster=auto -o ControlPath=<path>` 두 옵션 페어를 생성.
 * spectatorSession도 같은 헬퍼를 써서 ControlMaster 마스터를 띄운다.
 */
export function controlMasterArgs(controlPath: string): string[] {
	return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`];
}

export function buildSshArgs(t: SshTarget, controlPath?: string): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	if (controlPath) args.push(...controlMasterArgs(controlPath));
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	return args;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && npm run build && npm test -- --test-name-pattern="controlMasterArgs|buildSshArgs"`
Expected: 5 PASS (기존 4 + 신규 1).

- [ ] **Step 5: 전체 브릿지 테스트 회귀 확인**

Run: `cd bridge && npm test`
Expected: 모든 테스트 PASS (변경 전과 동일 개수, 추가된 것은 1개 신규 테스트만).

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/pty.ts bridge/src/pty.test.ts
git commit -m "refactor(terminal-bridge): controlMasterArgs 헬퍼 추출

buildSshArgs에 내장된 ControlMaster 플래그를 export 함수로 분리.
SpectatorSession이 동일 헬퍼를 재사용해 ssh를 마스터로 띄울 수 있게.
동작 불변(buildSshArgs 회귀 테스트 4개 그대로 통과).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["bridge/src/pty.ts", "bridge/src/pty.test.ts"], "verifyCommand": "cd bridge && npm run build && npm test", "acceptanceCriteria": ["controlMasterArgs export됨", "buildSshArgs 동작 불변 (4개 회귀 테스트 통과)", "신규 헬퍼 테스트 1개 PASS"]}
```

---

### Task 3: `SpectatorSession` — `controlPath` 옵션 + `hasActivePane()`

**Goal:** `SpectatorSession`이 생성 시 `controlPath?: string`를 받아 자기 ssh를 ControlMaster 마스터로 띄우고, 활성 패널이 결정되었는지 외부에서 확인할 수 있는 메서드를 노출한다.

**Files:**
- Modify: `bridge/src/spectatorSession.ts`
- Create: `bridge/src/spectatorSession.test.ts`

**Acceptance Criteria:**

- [ ] `SpectatorOptions` 인터페이스에 `controlPath?: string` 필드 추가.
- [ ] `controlPath`가 주어지면 spawn된 ssh의 argv에 `controlMasterArgs(controlPath)`의 결과가 호스트 인자 *앞에* 포함된다.
- [ ] `controlPath`가 없으면 기존 argv와 동일.
- [ ] 신규 메서드 `hasActivePane(): boolean` — `this.activePaneId != null && !this.closed`.
- [ ] 기존 `sendInput`, `tmuxNav`, 콜백, 라이프사이클 동작 불변.
- [ ] ssh argv 단위 테스트 + hasActivePane 단위 테스트 통과.

**Verify:** `cd bridge && npm run build && npm test -- --test-name-pattern="SpectatorSession"` → PASS.

**Steps:**

- [ ] **Step 1: ssh argv를 순수 함수로 추출**

현재 `spectatorSession.ts:125-133`이 인라인으로 `args`를 만든다. 단위 테스트 가능하도록 pure helper로 추출:

`bridge/src/spectatorSession.ts` 상단에 추가:

```ts
import { controlMasterArgs } from './pty.js';

// ... 기존 imports ...

/**
 * Spectator용 ssh argv를 순수 함수로 구성한다. 단위 테스트 가능.
 * `controlPath` 주어지면 ControlMaster 마스터 모드.
 */
export function buildSpectatorSshArgs(
	target: SshTarget,
	session: string,
	controlPath?: string
): string[] {
	const args: string[] = ['-tt'];
	if (target.port) args.push('-p', String(target.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	if (controlPath) args.push(...controlMasterArgs(controlPath));
	args.push(target.user ? `${target.user}@${target.host}` : target.host);
	args.push(
		`stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t ${session}`
	);
	return args;
}
```

(SshTarget이 spectatorSession에 import되어 있어야 함 — 이미 `import type { SshTarget } from './pty.js'` 있는지 확인. 없으면 추가.)

- [ ] **Step 2: 생성자 옵션 + 호출부 변경**

`SpectatorOptions` 인터페이스에 추가 (찾기: `interface SpectatorOptions`):

```ts
interface SpectatorOptions {
	target: SshTarget;
	session: string;
	controlPath?: string;   // ← 신규
	callbacks: SpectatorCallbacks;
}
```

생성자 본문의 `const args: string[] = ['-tt']; ...` 블록을 모두 한 줄 호출로 교체:

```ts
// 기존 ('args' 빌드 블록 전체 — 보통 ~10줄):
//   const args: string[] = ['-tt'];
//   if (opts.target.port) args.push('-p', String(opts.target.port));
//   args.push('-o', 'StrictHostKeyChecking=accept-new');
//   args.push(opts.target.user ? `${opts.target.user}@${opts.target.host}` : opts.target.host);
//   args.push(`stty cols 500 rows 200 ...`);
//
// 교체:
const args = buildSpectatorSshArgs(opts.target, opts.session, opts.controlPath);
```

- [ ] **Step 3: `hasActivePane()` 메서드 추가**

`SpectatorSession` 클래스에 추가 (`sendInput` 근처에 두는 게 자연스러움):

```ts
/**
 * 활성 패널을 알고 있는지 (= sendInput이 의미 있는지). pane-switch 프레임이
 * 한 번이라도 와서 activePaneId가 채워졌고, 세션이 안 닫혔으면 true.
 */
hasActivePane(): boolean {
	return this.activePaneId != null && !this.closed;
}
```

- [ ] **Step 4: 테스트 파일 작성**

`bridge/src/spectatorSession.test.ts` 신규:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpectatorSshArgs } from './spectatorSession.js';

test('buildSpectatorSshArgs: basic remote, no controlPath', () => {
	const args = buildSpectatorSshArgs({ host: 'h', user: 'u' }, 'work');
	assert.deepEqual(args, [
		'-tt',
		'-o', 'StrictHostKeyChecking=accept-new',
		'u@h',
		'stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t work'
	]);
});

test('buildSpectatorSshArgs: includes port before -o flags', () => {
	const args = buildSpectatorSshArgs({ host: 'h', user: 'u', port: 2222 }, 'work');
	assert.equal(args[0], '-tt');
	assert.equal(args[1], '-p');
	assert.equal(args[2], '2222');
});

test('buildSpectatorSshArgs: controlPath inserts ControlMaster flags before host', () => {
	const args = buildSpectatorSshArgs(
		{ host: 'h', user: 'u' },
		'work',
		'/tmp/tomboy-ctl/xyz.sock'
	);
	assert.ok(args.includes('ControlMaster=auto'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/xyz.sock'));
	// 호스트는 항상 stty 명령 직전 — 옵션들이 호스트 뒤로 새지 않아야 한다.
	const hostIdx = args.indexOf('u@h');
	const sttyIdx = args.findIndex((a) => a.startsWith('stty '));
	assert.equal(sttyIdx, hostIdx + 1);
});

test('buildSpectatorSshArgs: host-only when no user', () => {
	const args = buildSpectatorSshArgs({ host: 'h' }, 'work');
	assert.ok(args.includes('h'));
	assert.ok(!args.some((a) => a.endsWith('@h')));
});
```

`hasActivePane()` 자체는 closure private 필드(`activePaneId`)를 다루므로 단위 테스트가 까다롭다 — 충분한 보장은 spec-reviewer + Task 7 E2E가 한다. 기능적으로 한 줄 메서드라 단위 테스트 누락이 위험하지 않음.

- [ ] **Step 5: 테스트 실행**

Run: `cd bridge && npm run build && npm test -- --test-name-pattern="buildSpectatorSshArgs|spectator"`
Expected: 4 신규 + 기존 spectator 테스트 (없으면 4) PASS.

- [ ] **Step 6: 전체 회귀**

Run: `cd bridge && npm test`
Expected: 모든 테스트 PASS, 카운트가 4만큼 증가.

- [ ] **Step 7: 커밋**

```bash
git add bridge/src/spectatorSession.ts bridge/src/spectatorSession.test.ts
git commit -m "feat(terminal-bridge): SpectatorSession이 ControlMaster 마스터로 띄울 수 있게

생성자에 controlPath?: string 옵션 추가. 자기 ssh가 마스터 역할을 해서
imageTransfer가 같은 ControlPath로 멀티플렉싱 가능 — 셸 모드와 동일.
buildSpectatorSshArgs를 순수 함수로 추출해 ssh argv를 단위 테스트.
hasActivePane() 메서드로 외부에서 sendInput 호출 안전성 확인 가능.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["bridge/src/spectatorSession.ts", "bridge/src/spectatorSession.test.ts"], "verifyCommand": "cd bridge && npm run build && npm test", "acceptanceCriteria": ["buildSpectatorSshArgs 순수 함수 + 테스트 4개 PASS", "controlPath 시 ControlMaster 플래그 포함 + 호스트 뒤로 안 샘", "hasActivePane() 메서드 노출", "기존 spectator 동작 회귀 없음"]}
```

---

### Task 4: 브릿지 server.ts — `startSpectator` 배선 + `handleImageMessage` 분기

**Goal:** WS 핸들러가 spectator 세션을 열 때 sessionTarget/controlPath를 셸 모드와 동일하게 세팅하고, `handleImageMessage`가 spectator 분기로도 들어갈 수 있게 한다.

**Files:**
- Modify: `bridge/src/server.ts`

**Acceptance Criteria:**

- [ ] `startSpectator(target, session)` 진입 시 `sessionTarget = target` 세팅.
- [ ] `!isLocalTarget(target)`이면 `controlPath = \`${CTRL_DIR}/${randomUUID().slice(0,8)}.sock\`` 생성 (셸 모드 `startSession`과 동일 패턴).
- [ ] `new SpectatorSession({...})` 호출에 `controlPath: controlPath ?? undefined` 전달.
- [ ] `handleImageMessage` 가드를 재작성: `sessionTarget` 없으면 `image-error: '세션 준비 안 됨'`. base64 디코드 후 `transferImage({target, controlPath, mime, bytes})` 호출. 결과 경로를 `pty` 있으면 `pty.write(bracketedPaste(path) + ' ')`로, `spectator?.hasActivePane()`이면 `spectator.sendInput(bracketedPaste(path) + ' ')`로 주입. 둘 다 아니면 `image-error: '주입할 곳 없음'`.
- [ ] `bridge && npm run build && npm test` 모두 통과 (변경한 자체 단위 테스트 없음 — Task 7에서 E2E).

**Verify:** `cd bridge && npm run build && npm test` → 모든 테스트 PASS (카운트 증가 없음).

**Steps:**

- [ ] **Step 1: `startSpectator` 수정**

현재 `bridge/src/server.ts:329-374`의 `startSpectator`를 다음과 같이 변경 (앞부분):

```ts
async function startSpectator(target: SshTarget, session: string): Promise<void> {
	sessionTarget = target;                                          // 신규
	if (!isLocalTarget(target)) {                                    // 신규
		controlPath = `${CTRL_DIR}/${randomUUID().slice(0, 8)}.sock`;  // 신규
	}
	const wol = lookupWolTarget(target.host);
	console.log(
		`[term-bridge] spectate target=${target.user ?? ''}@${target.host}:${target.port ?? 22} session=${session}`
	);
	// ... (기존 WOL 로직 그대로) ...
	if (abortCtrl.signal.aborted) return;
	try {
		spectator = new SpectatorSession({
			target,
			session,
			controlPath: controlPath ?? undefined,                       // 신규
			callbacks: {
				paneSwitch: (info) => send({ type: 'pane-switch', ...info }),
				data: (d) => send({ type: 'data', d }),
				paneResize: (info) => send({ type: 'pane-resize', ...info }),
				error: (message) => send({ type: 'error', message }),
				exit: (reason) => {
					send({ type: 'exit', code: 0, reason });
					try { ws.close(1000, reason ?? 'spectator exit'); } catch { /* ignore */ }
				}
			}
		});
	} catch (err) {
		send({ type: 'error', message: `spectator spawn failed: ${(err as Error).message}` });
		try { ws.close(1011, 'spectator spawn failed'); } catch { /* ignore */ }
		return;
	}
	// ... (기존 나머지 그대로) ...
}
```

확인 필요: `isLocalTarget`이 이미 import되어 있는지 (server.ts 상단 imports 확인). 셸 모드 `startSession`도 같은 함수를 쓰므로 이미 import되어 있을 가능성 높음. 없으면 추가.

- [ ] **Step 2: `handleImageMessage` 재작성**

현재 `bridge/src/server.ts:423-444`를 다음으로 교체:

```ts
/**
 * `image` 메시지 처리 — base64 디코딩 → 타깃 호스트로 전송 → PTY 또는
 * spectator 활성 패널에 경로를 bracketed-paste로 주입.
 *
 * - 셸 모드: pty.write(bracketedPaste(path) + ' ').
 * - 관전 모드: spectator.sendInput(bracketedPaste(path) + ' ') → tmux send-keys -H.
 * - 어느 쪽도 준비 안 된 race 상황: image-error 회신.
 *
 * 경로 뒤 공백 한 칸은 이미지를 연달아 붙여넣을 때 경로가 서로 붙지 않게 한다.
 */
async function handleImageMessage(mime: string, dataB64: string): Promise<void> {
	if (!sessionTarget) {
		send({ type: 'image-error', message: '세션 준비 안 됨' });
		return;
	}
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
		const paste = bracketedPaste(remotePath) + ' ';
		if (pty) {
			pty.write(paste);
		} else if (spectator?.hasActivePane()) {
			spectator.sendInput(paste);
		} else {
			send({ type: 'image-error', message: '주입할 곳이 없습니다.' });
			return;
		}
		send({ type: 'image-ok', path: remotePath });
	} catch (err) {
		send({ type: 'image-error', message: (err as Error).message });
	}
}
```

- [ ] **Step 3: 빌드 + 회귀 테스트**

Run: `cd bridge && npm run build`
Expected: 컴파일 통과.

Run: `cd bridge && npm test`
Expected: 모든 기존 테스트 PASS. 카운트 변동 없음 (이 태스크는 신규 테스트 없음 — server.ts에 단위 테스트 패턴이 없어서 E2E로 검증).

- [ ] **Step 4: 커밋**

```bash
git add bridge/src/server.ts
git commit -m "feat(terminal-bridge): 관전 모드 이미지 전송 지원

startSpectator에서 sessionTarget/controlPath를 셸 모드와 동일하게 세팅하고
SpectatorSession에 controlPath 전달. handleImageMessage에 spectator 분기
추가 — spectator.sendInput(bracketedPaste(path))로 활성 패널에 경로 주입.
pty/spectator 둘 다 없는 race는 image-error로 알림.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["bridge/src/server.ts"], "verifyCommand": "cd bridge && npm run build && npm test", "acceptanceCriteria": ["startSpectator에서 sessionTarget/controlPath 세팅", "SpectatorSession에 controlPath 전달", "handleImageMessage에 spectator 분기 + hasActivePane 가드", "기존 테스트 회귀 없음"]}
```

---

### Task 5: 프론트엔드 — 데스크탑 관전 모드 이미지 트리거 활성화

**Goal:** `TerminalView.svelte`의 4개 `if (isSpectator) return;` 가드를 제거하고, 헤더 "이미지" 버튼을 양 모드에서 모두 표시한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**

- [ ] `handleImagePaste`의 `if (isSpectator) return;` 제거.
- [ ] `handleImageDragOver`의 `if (isSpectator) return;` 제거.
- [ ] `handleImageDrop`의 `if (isSpectator) return;` 제거.
- [ ] (네 번째 가드 — 그것이 어디 있는지 코드 확인. 후술하는 Step 1에서 정확한 위치 찾기.)
- [ ] 헤더의 `{#if !isSpectator}` 블록에서 "이미지" 버튼만 밖으로 빼내어 양 모드에서 표시. 히스토리 버튼은 셸 모드 전용으로 유지.
- [ ] `cd app && npm run check && npm run build` 통과.
- [ ] 기존 셸 모드 동작 회귀 없음 (`npm test`).

**Verify:** `cd app && npm run check && npm run build && npm run test -- --run` → 모두 통과.

**Steps:**

- [ ] **Step 1: 현재 가드 위치 확인**

다음 명령으로 정확한 위치 파악:

```bash
grep -n "if (isSpectator) return" app/src/lib/editor/terminal/TerminalView.svelte
```

예상 결과:
```
230:	if (isSpectator) return;   ← handleImagePaste
240:	if (isSpectator) return;   ← handleImageDragOver
246:	if (isSpectator) return;   ← handleImageDrop
```

만약 4번째 가드가 있다면 (예: connectAutoRun 트리거 등) 그것이 *이미지* 관련인지 확인. 이미지 무관이면 건드리지 말 것. 본 acceptance criteria의 "네 번째 가드"는 이미지 트리거 한정이며, 현재 코드에 3개만 있을 수 있음 — 그 경우 acceptance criteria의 네 번째 항목은 자동 만족(존재하지 않으므로).

- [ ] **Step 2: 3개 (또는 4개) 이미지 가드 제거**

각 함수의 첫 줄 `if (isSpectator) return;`만 삭제:

```ts
// 변경 전 (handleImagePaste)
function handleImagePaste(e: ClipboardEvent): void {
	if (isSpectator) return;
	const file = extractImageFile(e.clipboardData);
	// ...
}

// 변경 후
function handleImagePaste(e: ClipboardEvent): void {
	const file = extractImageFile(e.clipboardData);
	// ...
}
```

`handleImageDragOver`, `handleImageDrop`도 동일하게 첫 줄만 삭제. 다른 코드 건드리지 말 것.

- [ ] **Step 3: 헤더 "이미지" 버튼 게이트 풀기**

현재 (`TerminalView.svelte:787-800` 근처):

```svelte
<div class="actions">
	{#if !isSpectator}
		<button type="button" class="toggle" onclick={togglePanel}>
			히스토리 ({currentItems.length})
		</button>
		<button
			type="button"
			class="toggle"
			onclick={openImagePicker}
			disabled={status !== 'open' || imageUploadCount > 0}
		>
			{imageUploadCount > 0 ? '업로드 중…' : '이미지'}
		</button>
	{/if}
	<!-- ... status, 재연결, 편집 모드 버튼 ... -->
</div>
```

변경 후 (이미지 버튼만 밖으로):

```svelte
<div class="actions">
	{#if !isSpectator}
		<button type="button" class="toggle" onclick={togglePanel}>
			히스토리 ({currentItems.length})
		</button>
	{/if}
	<button
		type="button"
		class="toggle"
		onclick={openImagePicker}
		disabled={status !== 'open' || imageUploadCount > 0}
	>
		{imageUploadCount > 0 ? '업로드 중…' : '이미지'}
	</button>
	<!-- ... status, 재연결, 편집 모드 버튼 ... -->
</div>
```

- [ ] **Step 4: 타입체크 + 빌드 + 테스트**

```bash
cd app && npm run check
```
Expected: 0 errors.

```bash
cd app && npm run build
```
Expected: success.

```bash
cd app && npm run test -- --run
```
Expected: 모든 테스트 PASS (기존 회귀 없음).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 데스크탑 관전 모드 이미지 트리거 활성화

paste/dragover/drop 핸들러의 isSpectator 가드 제거 + 헤더 이미지 버튼을
양 모드에서 표시. 백엔드 분기는 이미 Task 4에서 추가됨.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/TerminalView.svelte"], "verifyCommand": "cd app && npm run check && npm run build && npm run test -- --run", "acceptanceCriteria": ["3개 이미지 가드 제거 (handleImagePaste/DragOver/Drop)", "헤더 이미지 버튼이 spectator에서도 표시", "히스토리 버튼은 셸 모드 전용 유지", "check/build/test 회귀 없음"]}
```

---

### Task 6: 프론트엔드 — 보내기 팝업 이미지 행 + 핸들러 + 테스트

**Goal:** 모바일 관전 모드의 보내기 팝업에 "📋 이미지 붙여넣기"와 "📷 이미지 불러오기" 버튼을 추가하고, textarea에 paste된 이미지를 가로채는 `onpaste` 핸들러를 단다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`
- Create: `app/tests/unit/editor/sendPopupImageButtons.test.ts`

**Acceptance Criteria:**

- [ ] 보내기 팝업의 input/textarea에 `onpaste={onSendPopupPaste}` 핸들러 연결.
- [ ] 팝업 내에 새 행 — 두 버튼 `📋 이미지 붙여넣기`, `📷 이미지 불러오기`. `imageUploadCount > 0 || status !== 'open'`이면 disabled.
- [ ] `onSendPopupPaste(e)`: `extractImageFile(e.clipboardData)`로 이미지 추출 → 있으면 `preventDefault` + `sendImageFile(file)`, 없으면 fall-through(이벤트 그대로).
- [ ] `onClickPasteImage()`: `navigator.clipboard.read()` 시도 → 이미지 ClipboardItem 찾으면 File로 만들어 `sendImageFile` 호출. 권한 거부 시 한국어 토스트, 이미지 없음 시 한국어 토스트.
- [ ] "📷 이미지 불러오기" 버튼은 기존 `openImagePicker`(`imageFileInput.click()`) 재사용 — 다중 선택 + 검증 + 전송 흐름이 그대로.
- [ ] 두 신규 핸들러에 대한 vitest 테스트 통과.

**Verify:** `cd app && npm run check && npm run build && npm run test -- --run sendPopupImageButtons` → PASS.

**Steps:**

- [ ] **Step 1: 핸들러 함수 추가**

`TerminalView.svelte`의 `<script>` 부분, 기존 `sendImageFile`/`openImagePicker` 근처에 추가:

```ts
/** 보내기 팝업의 textarea/input에 paste된 이미지를 가로챈다. */
function onSendPopupPaste(e: ClipboardEvent): void {
	const file = extractImageFile(e.clipboardData);
	if (!file) return; // 이미지 없음 → 평문 paste fall-through
	e.preventDefault();
	void sendImageFile(file);
}

/** "📋 이미지 붙여넣기" 버튼 — navigator.clipboard.read() 시도. */
async function onClickPasteImage(): Promise<void> {
	if (!navigator.clipboard || !navigator.clipboard.read) {
		pushToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다.', { kind: 'error' });
		return;
	}
	try {
		const items = await navigator.clipboard.read();
		for (const item of items) {
			for (const type of item.types) {
				if (type.startsWith('image/')) {
					const blob = await item.getType(type);
					const file = new File([blob], 'pasted', { type });
					void sendImageFile(file);
					return;
				}
			}
		}
		pushToast('클립보드에 이미지가 없습니다.', { kind: 'error' });
	} catch (err) {
		const name = (err as Error).name;
		pushToast(
			name === 'NotAllowedError'
				? '클립보드 접근 권한이 거부되었습니다.'
				: '클립보드를 읽을 수 없습니다.',
			{ kind: 'error' }
		);
	}
}
```

- [ ] **Step 2: 팝업 마크업 변경**

현재 팝업 (TerminalView.svelte:940-990 근처):

```svelte
{#if sendPopupOpen}
	<div class="send-popup">
		<input
			type="text"
			bind:this={sendPopupInput}
			bind:value={sendPopupText}
			placeholder="..."
			onkeydown={(e) => { /* Enter/Esc 처리 */ }}
		/>
		<div class="quick-keys">
			<!-- y/n/1/Enter/Esc/^C/PgUp/PgDn -->
		</div>
		<div class="actions">
			<button type="button" onclick={closeSendPopup}>닫기</button>
			<button type="button" onclick={() => sendPopupSubmit(false)}>타이핑만</button>
			<button type="button" class="primary" onclick={() => sendPopupSubmit(true)}>
				전송
			</button>
		</div>
	</div>
{/if}
```

변경:

```svelte
{#if sendPopupOpen}
	<div class="send-popup">
		<input
			type="text"
			bind:this={sendPopupInput}
			bind:value={sendPopupText}
			placeholder="..."
			onkeydown={(e) => { /* Enter/Esc 처리 */ }}
			onpaste={onSendPopupPaste}
		/>
		<div class="quick-keys">
			<!-- 기존 유지 -->
		</div>
		<div class="image-row">
			<button
				type="button"
				onclick={onClickPasteImage}
				disabled={imageUploadCount > 0 || status !== 'open'}
			>
				{imageUploadCount > 0 ? '업로드 중…' : '📋 이미지 붙여넣기'}
			</button>
			<button
				type="button"
				onclick={openImagePicker}
				disabled={imageUploadCount > 0 || status !== 'open'}
			>
				📷 이미지 불러오기
			</button>
		</div>
		<div class="actions">
			<button type="button" onclick={closeSendPopup}>닫기</button>
			<button type="button" onclick={() => sendPopupSubmit(false)}>타이핑만</button>
			<button type="button" class="primary" onclick={() => sendPopupSubmit(true)}>
				전송
			</button>
		</div>
	</div>
{/if}
```

CSS (같은 컴포넌트의 `<style>` 블록 안, `.send-popup .actions` 근처):

```css
.send-popup .image-row {
	display: flex;
	gap: clamp(0.25rem, 1.5vw, 0.5rem);
	margin-top: clamp(0.25rem, 1.5vw, 0.5rem);
}
.send-popup .image-row button {
	flex: 1;
	padding: clamp(0.4rem, 2vw, 0.6rem);
	font-size: clamp(0.75rem, 3vw, 0.85rem);
}
```

(`clamp` 패턴은 프로젝트 컨벤션 — `CLAUDE.md`의 "Responsive spacing" 섹션 참고.)

- [ ] **Step 3: 단위 테스트 작성**

`app/tests/unit/editor/sendPopupImageButtons.test.ts` 신규:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 두 핸들러는 TerminalView.svelte 내부 함수라 직접 import이 어렵다.
 * 대신 동일 로직을 검증할 수 있는 형태로 추출해서 테스트 — 또는
 * 핸들러를 별도 모듈로 빼서 import.
 *
 * 이 태스크에서는 핸들러 로직을 검증 가능한 단위로 끌어내기 위해 작은
 * 헬퍼 모듈을 만든다.
 */

import { extractImageFromClipboardItems } from '../../../src/lib/editor/terminal/clipboardImage';

describe('extractImageFromClipboardItems', () => {
	it('이미지 타입 ClipboardItem이 있으면 첫 번째를 반환', async () => {
		const blob = new Blob(['fake-png-bytes'], { type: 'image/png' });
		const item = {
			types: ['text/plain', 'image/png'],
			getType: vi.fn(async (t: string) => {
				if (t === 'image/png') return blob;
				throw new Error('not found');
			})
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item]);
		expect(result).not.toBeNull();
		expect(result?.type).toBe('image/png');
		expect(result?.name).toBe('pasted');
	});

	it('이미지 타입이 없으면 null', async () => {
		const item = {
			types: ['text/plain'],
			getType: vi.fn()
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item]);
		expect(result).toBeNull();
	});

	it('빈 리스트면 null', async () => {
		const result = await extractImageFromClipboardItems([]);
		expect(result).toBeNull();
	});

	it('여러 이미지 타입 중 첫 번째만 반환', async () => {
		const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
		const jpgBlob = new Blob(['jpg-bytes'], { type: 'image/jpeg' });
		const item1 = {
			types: ['image/png'],
			getType: vi.fn(async () => pngBlob)
		} as unknown as ClipboardItem;
		const item2 = {
			types: ['image/jpeg'],
			getType: vi.fn(async () => jpgBlob)
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item1, item2]);
		expect(result?.type).toBe('image/png');
	});
});
```

- [ ] **Step 4: 헬퍼 모듈 추가**

`app/src/lib/editor/terminal/clipboardImage.ts` 신규:

```ts
/**
 * `navigator.clipboard.read()`가 반환하는 ClipboardItem 배열에서 첫 번째
 * 이미지 항목을 추출해 `File`로 만들어 반환. 이미지 없으면 null.
 *
 * TerminalView의 `onClickPasteImage`가 이 헬퍼를 호출 — 헬퍼를 분리해
 * 단위 테스트 가능하게 한다.
 */
export async function extractImageFromClipboardItems(
	items: ClipboardItem[]
): Promise<File | null> {
	for (const item of items) {
		for (const type of item.types) {
			if (type.startsWith('image/')) {
				const blob = await item.getType(type);
				return new File([blob], 'pasted', { type });
			}
		}
	}
	return null;
}
```

`TerminalView.svelte`의 `onClickPasteImage`를 헬퍼 사용으로 단순화:

```ts
import { extractImageFromClipboardItems } from './clipboardImage';

// ...

async function onClickPasteImage(): Promise<void> {
	if (!navigator.clipboard || !navigator.clipboard.read) {
		pushToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다.', { kind: 'error' });
		return;
	}
	try {
		const items = await navigator.clipboard.read();
		const file = await extractImageFromClipboardItems(items);
		if (file) {
			void sendImageFile(file);
		} else {
			pushToast('클립보드에 이미지가 없습니다.', { kind: 'error' });
		}
	} catch (err) {
		const name = (err as Error).name;
		pushToast(
			name === 'NotAllowedError'
				? '클립보드 접근 권한이 거부되었습니다.'
				: '클립보드를 읽을 수 없습니다.',
			{ kind: 'error' }
		);
	}
}
```

`onSendPopupPaste`는 `extractImageFile`(기존 `imagePasteClient`에서 export)을 그대로 쓴다 — 신규 헬퍼는 paste의 `ClipboardEvent.clipboardData` 케이스가 아닌 `clipboard.read()` 케이스만 다룬다.

- [ ] **Step 5: 검증**

```bash
cd app && npm run check
```
Expected: 0 errors.

```bash
cd app && npm run test -- --run sendPopupImageButtons
```
Expected: 4 PASS.

```bash
cd app && npm run test -- --run
```
Expected: 모든 테스트 PASS (기존 회귀 없음, 4 신규 + 기존).

```bash
cd app && npm run build
```
Expected: success.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte \
        app/src/lib/editor/terminal/clipboardImage.ts \
        app/tests/unit/editor/sendPopupImageButtons.test.ts
git commit -m "feat(terminal): 보내기 팝업 이미지 행 + paste 가로채기

모바일 관전 모드에서 이미지 전송 입구 신설.
- textarea onpaste: 이미지 ClipboardItem이면 가로채 sendImageFile
- 📋 이미지 붙여넣기 버튼: navigator.clipboard.read() → 이미지 추출
- 📷 이미지 불러오기 버튼: 기존 openImagePicker 재사용
extractImageFromClipboardItems 순수 헬퍼로 분리해 단위 테스트 가능.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/TerminalView.svelte", "app/src/lib/editor/terminal/clipboardImage.ts", "app/tests/unit/editor/sendPopupImageButtons.test.ts"], "verifyCommand": "cd app && npm run check && npm run build && npm run test -- --run", "acceptanceCriteria": ["보내기 팝업에 두 이미지 버튼 + onpaste", "extractImageFromClipboardItems 헬퍼 + 4 테스트 PASS", "권한 거부/이미지 없음 토스트 안내", "check/build/test 회귀 없음"]}
```

---

### Task 7: E2E 수동 검증 — 셸 + 관전 모드, 모바일 + 데스크탑

**Goal:** 실제 원격 호스트에서 클로드 코드에 이미지가 전달되는 4가지 시나리오 모두 동작함을 확인.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** 없음 (수동 검증).

**Acceptance Criteria:**

준비:
- [ ] 원격 호스트(`ssh://user@<host>`)에 클로드 코드가 실행 중인 상태.
- [ ] 같은 호스트에서 `tmux -CC attach` 가능한 세션 — 관전 모드용 (`spectate: <session>`).
- [ ] 모바일 + 데스크탑 둘 다 같은 노트(들)에 접속 가능.

시나리오:
- [ ] **셸 + 데스크탑**: ssh:// 노트에서 Ctrl+V로 이미지 → 경로 주입 → 클로드 코드 인식 (Task 1과 동일 — 회귀 확인).
- [ ] **셸 + 모바일**: ssh:// 노트에서 헤더 "이미지" 버튼 → 파일 선택 → 경로 주입 → 클로드 코드 인식.
- [ ] **관전 + 데스크탑**: spectate: 노트에서 Ctrl+V → 경로 주입 → 활성 패널의 클로드 코드 인식.
- [ ] **관전 + 모바일**: spectate: 노트에서 보내기 팝업 → "📷 이미지 불러오기" → 파일 선택 → 경로 주입 → 활성 패널의 클로드 코드 인식.
- [ ] **관전 + 모바일 (붙여넣기)**: 보내기 팝업의 textarea에 모바일 키보드의 "이미지 삽입" 또는 "📋 이미지 붙여넣기" 버튼으로 시도 — 동작하면 인식 확인, 동작 안 하면 (브라우저 권한/지원 한계) 토스트 안내가 정상적으로 뜨는지 확인.

각 시나리오에서 관찰한 출력(경로 + 클로드 코드의 첨부 인식 표시) 기록.

**실패 시:** 해당 분기에 맞춰 디버깅. server.ts 로그(`[term-bridge]`)와 클라이언트 콘솔로 image 메시지가 어디서 막혔는지 추적.

**Verify:** (수동) — 위 5개 시나리오 직접 확인.

```json:metadata
{"files": [], "verifyCommand": "", "acceptanceCriteria": ["셸 데스크탑 회귀 확인", "셸 모바일 헤더 버튼 동작", "관전 데스크탑 Ctrl+V 동작", "관전 모바일 파일 선택 동작", "관전 모바일 클립보드 붙여넣기 동작 또는 정상 토스트 안내"], "userGate": true, "tags": ["user-gate"]}
```

---

### Task 8: 문서 갱신

**Goal:** 관전 모드 이미지 지원 사실과 신규 핸들러 위치를 `CLAUDE.md`와 `tomboy-terminal` 스킬 문서에 반영.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/tomboy-terminal/SKILL.md`

**Acceptance Criteria:**

- [ ] `CLAUDE.md` 터미널 노트 섹션에서 "이미지 붙여넣기" 줄에 "관전 모드 포함 (모바일 보내기 팝업 + 데스크탑 동일 트리거)" 한 줄 추가.
- [ ] `.claude/skills/tomboy-terminal/SKILL.md`의 이미지 붙여넣기 섹션에 관전 모드 추가 — 데스크탑 가드 해제 + 모바일 팝업 행 두 가지 입구 명시.
- [ ] SKILL.md Quick map에 신규 파일 `app/src/lib/editor/terminal/clipboardImage.ts` 추가.
- [ ] SKILL.md cross-cutting invariants에 "관전 모드 이미지는 SpectatorSession 자체 ssh를 ControlMaster 마스터로 띄워 imageTransfer가 재사용" 한 줄 추가 (셸 모드 invariant와 대칭).

**Verify:** (자체 검토) — `git diff CLAUDE.md` + `git diff .claude/skills/tomboy-terminal/SKILL.md` 두 파일이 위 acceptance 항목을 모두 반영하는지 확인.

**Steps:**

- [ ] **Step 1: 현재 두 문서의 이미지 붙여넣기 관련 문장 찾기**

```bash
grep -n "이미지 붙여넣기\|이미지 paste\|ControlMaster" CLAUDE.md .claude/skills/tomboy-terminal/SKILL.md
```

- [ ] **Step 2: `CLAUDE.md` 갱신**

기존 (CLAUDE.md "터미널 노트" 섹션 안):

> See the **`tomboy-terminal`** skill for ... **이미지 붙여넣기** (ControlMaster 멀티플렉싱 + 원격 경로 PTY 주입, 셸 모드 전용), and **터미널 벨** ...

변경:

> See the **`tomboy-terminal`** skill for ... **이미지 붙여넣기** (ControlMaster 멀티플렉싱 + 원격 경로 주입; 셸 모드는 PTY로, 관전 모드는 `tmux send-keys -H`로 활성 패널에 — 모바일 보내기 팝업 + 데스크탑 동일 트리거), and **터미널 벨** ...

(정확한 문자열은 grep으로 찾은 실제 본문에 맞춰 Edit.)

- [ ] **Step 3: `.claude/skills/tomboy-terminal/SKILL.md` 갱신**

이미지 붙여넣기 설명 섹션에 다음을 추가/병합:

```markdown
**이미지 붙여넣기** — 셸 모드와 관전 모드 모두 지원.

- **셸 모드**: Ctrl+V / 드래그앤드롭 / 헤더 "이미지" 버튼. 브릿지가
  ssh PTY를 ControlMaster 마스터로 띄우고, 같은 소켓을 통해 별도
  `ssh -o ControlPath=... cat > /tmp/tomboy-images/X`로 파일 업로드 후
  PTY에 bracketed-paste로 경로 주입.
- **관전 모드 데스크탑**: 동일한 Ctrl+V / 드롭 / 헤더 버튼 — 브릿지가
  spectator ssh도 ControlMaster 마스터로 띄우고, 경로 주입은
  `pty.write` 대신 `SpectatorSession.sendInput`을 통해
  `tmux send-keys -t <activePane> -H <hex>`로 활성 패널에 주입.
- **관전 모드 모바일**: 보내기 팝업에 두 버튼 — "📋 이미지 붙여넣기"
  (`navigator.clipboard.read()`) + "📷 이미지 불러오기"(파일 선택기).
  팝업의 텍스트 입력 필드는 `onpaste`로도 이미지를 가로챈다.
- **활성 패널 가드**: spectator 분기에서 `spectator.hasActivePane()`이
  false면 (첫 pane-switch 프레임 전 race) `image-error` 회신. 클라이언트는
  토스트로 안내.
- **로컬 호스트 케이스**: `isLocalTarget`이면 ControlMaster 안 만들고
  `imageTransfer`가 로컬 분기로 진행 — 셸/관전 동일.
```

Quick map에 신규 파일 추가:

```markdown
- `app/src/lib/editor/terminal/clipboardImage.ts` — `navigator.clipboard.read()`
  ClipboardItem 배열에서 첫 이미지를 File로 추출 (보내기 팝업의
  "📋 이미지 붙여넣기" 버튼이 사용).
```

Cross-cutting invariants에 추가:

```markdown
- **이미지 전송 경로 분기**: 셸 모드는 `pty.write(bracketedPaste(path))`,
  관전 모드는 `SpectatorSession.sendInput(bracketedPaste(path))` →
  `tmux send-keys -H <hex>`. 두 경로 모두 ControlMaster 멀티플렉싱으로
  재인증 없이 업로드.
```

- [ ] **Step 4: 검증**

```bash
git diff CLAUDE.md .claude/skills/tomboy-terminal/SKILL.md
```

직접 읽어 acceptance 4개 항목 모두 만족하는지 확인.

- [ ] **Step 5: graphify 갱신 (있으면)**

```bash
graphify update . 2>/dev/null || echo "graphify not available, skipping"
```

- [ ] **Step 6: 커밋**

```bash
git add CLAUDE.md .claude/skills/tomboy-terminal/SKILL.md graphify-out 2>/dev/null
git commit -m "docs(terminal): 관전 모드 이미지 붙여넣기 문서화

CLAUDE.md와 tomboy-terminal 스킬에 관전 모드 지원 명시.
- 데스크탑: 셸 모드와 동일 트리거 (Ctrl+V/드롭/헤더)
- 모바일: 보내기 팝업에 두 버튼 + textarea onpaste
- 경로 주입 채널: pty.write (셸) / SpectatorSession.sendInput (관전)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```json:metadata
{"files": ["CLAUDE.md", ".claude/skills/tomboy-terminal/SKILL.md"], "verifyCommand": "", "acceptanceCriteria": ["CLAUDE.md에 관전 모드 이미지 한 줄", "SKILL.md에 셸/관전 데스크탑/관전 모바일 세 입구 설명", "Quick map에 clipboardImage.ts 추가", "Cross-cutting invariants에 분기 채널 한 줄"]}
```

---

## 자체 리뷰 (Plan author checklist)

**1. Spec 커버리지:**

| Spec 섹션 | 구현 태스크 |
|----------|-------------|
| `pty.ts` controlMasterArgs 추출 | Task 2 |
| `spectatorSession.ts` controlPath + hasActivePane | Task 3 |
| `server.ts` startSpectator + handleImageMessage 분기 | Task 4 |
| `TerminalView.svelte` 4개 가드 제거 + 헤더 게이트 | Task 5 |
| `TerminalView.svelte` 보내기 팝업 두 버튼 + onpaste | Task 6 |
| 신규 테스트 파일 (spectator/popup) | Task 3, 6 |
| `CLAUDE.md`, `SKILL.md` 갱신 | Task 8 |
| 에러 처리 — `세션 준비 안 됨`/`주입할 곳 없음`/권한 거부 등 | Task 4, 6 |
| E2E 회귀 검증 | Task 1 (pre) + Task 7 (post) |

빠진 spec 요구사항: 없음.

**2. 플레이스홀더 스캔:** "TBD"/"TODO"/"비슷하게"/"적절한 에러 처리" 등 — 없음. 모든 step에 실제 코드 또는 명령 포함.

**3. 타입/이름 일관성:**

- `controlMasterArgs(controlPath: string): string[]` — Task 2 정의, Task 3에서 사용 (시그니처 일치).
- `buildSpectatorSshArgs(target, session, controlPath?)` — Task 3 정의, 외부에서 사용 없음 (내부 + 테스트).
- `hasActivePane(): boolean` — Task 3 정의, Task 4에서 사용 (시그니처 일치).
- `extractImageFromClipboardItems(items: ClipboardItem[]): Promise<File | null>` — Task 6 정의, Task 6에서 사용.
- 이미지 경로 주입 문자열: 모든 태스크에서 `bracketedPaste(path) + ' '` (Task 4 server.ts와 일치).
- 에러 메시지: `'세션 준비 안 됨'` (Task 4 server.ts) + `'주입할 곳이 없습니다.'` (Task 4) + 권한/지원 안내 (Task 6) — 모두 한국어, 일관됨.

수정 사항: 없음.
