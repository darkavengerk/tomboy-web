# Spectator 패널 구독 모델 (SpectatorHub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여러 spectator 노트가 같은 tmux 세션의 서로 다른 패널을 동시에 라이브로 관전하도록 `SpectatorSession` per-WS 구조를 `SpectatorHub` (per-session 공유 ssh+tmux -CC) + `SpectatorSubscription` (per-WS 가벼운 필터)로 분리.

**Architecture:** `bridge/src/spectatorHub.ts`에 모듈 레벨 `Map<hubKey, SpectatorHub>`. Hub는 ssh+tmux+상태 캐시를 소유, Subscription은 callbacks + `subscribedPaneId`만 들고 hub 이벤트를 필터링. `%output paneId bytes` → hub fan-out → 매칭 sub의 callbacks.data. follow-active 모드와 pinned 모드 모두 subscription 레벨 mode flag로 처리. ssh.exit가 hub destroy 트리거 (별도 유예 타이머 없음).

**Tech Stack:** TypeScript, node:test, vitest (클라이언트), Svelte 5, tmux -CC control protocol.

**Spec:** `docs/superpowers/specs/2026-05-25-spectator-pane-subscribe-design.md`

---

## File Structure

**브릿지 (Node, node:test)**
- `bridge/src/spectatorHub.ts` (NEW) — `SpectatorHub` 클래스 + `SpectatorSubscription` 클래스 + `SpectatorHubRegistry` (모듈 레벨 Map) + 순수 헬퍼 `resolveOrdinal`, `buildSeed`
- `bridge/src/spectatorHub.test.ts` (NEW) — 위 클래스/헬퍼 테스트
- `bridge/src/spectatorSession.ts` (MODIFY) — `SpectatorSession` 클래스 삭제, `SpectatorCallbacks` 인터페이스에 `paneUnavailable` 추가, `buildSpectatorSshArgs` / `panePosition` / `SpectatorNavAction` 유지
- `bridge/src/spectatorSession.test.ts` (UNCHANGED) — pure helper 테스트 유지
- `bridge/src/server.ts` (MODIFY) — `handleWs`에서 `new SpectatorSession(...)` → `SpectatorHubRegistry.subscribe(...)`, `subscribe-pane` 프레임 라우팅, `controlPath`는 hub 소유 자원 참조

**클라이언트 (Svelte, vitest)**
- `app/src/lib/editor/terminal/wsClient.ts` (MODIFY) — `subscribePane(ordinal: number)` 메서드 추가, `pane-unavailable` 메시지 핸들러 + `onPaneUnavailable` 콜백
- `app/tests/unit/editor/wsClientSubscribePane.test.ts` (NEW) — 위 신규 동작 테스트
- `app/src/lib/editor/terminal/TerminalView.svelte` (MODIFY) — `pinDetached` 상태/배너/`reattachIfPinned` 제거, `pinUnavailable` 상태/배너 추가, 자물쇠 토글 시 `subscribePane` 송신

**문서**
- `CLAUDE.md` (MODIFY) — tomboy-terminal 섹션의 spectator/pin 문단 갱신

---

## Task Dependencies

```
T1 (Hub skeleton + Registry)
  └─ T2 (Hub state caching)
       └─ T3 (Subscription follow-active)
            └─ T4 (Subscription pin/unpin)
                 └─ T5 (Hub desktop-mut methods)
                      └─ T6 (server.ts integration)

T7 (Client wsClient.ts) — independent of bridge tasks
  └─ T8 (Client TerminalView cleanup + banner)

T6 + T8 → T9 (Delete old + CLAUDE.md + final regression)
```

---

### Task 1: Hub skeleton + Registry + lifecycle

**Goal:** `SpectatorHub` 클래스 + 모듈 레벨 `SpectatorHubRegistry` Map. ssh+tmux 소유, refcount, ssh.exit 시 destroy. 아직 output 라우팅이나 상태 캐시는 없음.

**Files:**
- Create: `bridge/src/spectatorHub.ts`
- Create: `bridge/src/spectatorHub.test.ts`

**Acceptance Criteria:**
- [ ] `SpectatorHub` 클래스 존재. 생성자는 `{ssh, tmux, hubKey, controlPath, onDestroy}` 주입 (테스트 가능성)
- [ ] `SpectatorHubRegistry.subscribe(target, session, callbacks)` 첫 호출 → `ssh.spawn` 호출 + hub Map에 등록 + subscription 반환
- [ ] 같은 (target, session) 두 번째 `subscribe` → `ssh.spawn` 호출 0번, 같은 hub 재사용
- [ ] `subscription.close()` 마지막 → ssh.kill + tmux.close + Map에서 제거 + controlPath unlink (유예 타이머 없음)
- [ ] ssh.on('exit') → 모든 subscription에 `callbacks.exit(reason)` 발사, Map에서 제거

**Verify:** `cd bridge && npm test -- --test-name-pattern=spectatorHub` → 모든 새 테스트 통과

**Steps:**

- [ ] **Step 1: 테스트 파일 셸 + 모킹 헬퍼**

`bridge/src/spectatorHub.test.ts` 생성:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SpectatorHub, SpectatorHubRegistry, hubKey } from './spectatorHub.js';
import type { SpectatorCallbacks } from './spectatorSession.js';

// Mock TmuxControlClient — emits events, stubs command()
class MockTmux extends EventEmitter {
  commands: string[] = [];
  command(cmd: string): Promise<string[]> {
    this.commands.push(cmd);
    return Promise.resolve([]);
  }
  close(): void { this.emit('exit'); }
  feed(_b: Buffer): void {}
}

// Mock ssh ChildProcess
class MockSsh extends EventEmitter {
  killed = false;
  stdin = { write: () => {} };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void { this.killed = true; this.emit('exit', 0, null); }
}

function makeCallbacks(): SpectatorCallbacks & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    paneSwitch: (info) => events.push(`paneSwitch:${info.paneId}`),
    data: (text) => events.push(`data:${text.length}`),
    paneResize: (info) => events.push(`resize:${info.cols}x${info.rows}`),
    paneUnavailable: (info) => events.push(`unavail:${info.pinnedOrdinal}/${info.paneCount}`),
    error: (msg) => events.push(`error:${msg}`),
    exit: (reason) => events.push(`exit:${reason ?? 'none'}`)
  };
}

test('hubKey: builds canonical key from target + session', () => {
  assert.equal(
    hubKey({ host: 'h', user: 'u', port: 22 }, 'work'),
    'u@h:22|work'
  );
  assert.equal(
    hubKey({ host: 'h' }, 'work'),
    '@h:22|work'  // user empty, port default
  );
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd bridge && npm test -- --test-name-pattern=spectatorHub`
Expected: FAIL — `spectatorHub.ts` does not exist.

- [ ] **Step 3: `SpectatorHub` 최소 구현**

`bridge/src/spectatorHub.ts` 생성:

```typescript
/**
 * SpectatorHub: shared ssh + tmux -CC client per (target, session). Multiple
 * SpectatorSubscriptions (one per WS) can attach to the same hub and each
 * subscribe to a different pane independently. tmux -CC already streams
 * %output for all panes in the session — this hub fans those out to
 * matching subscriptions instead of dropping non-active pane bytes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TmuxControlClient } from './tmuxControlClient.js';
import { controlMasterArgs } from './pty.js';
import { buildSpectatorSshArgs, type SpectatorCallbacks } from './spectatorSession.js';
import type { SshTarget } from './pty.js';

export function hubKey(target: SshTarget, session: string): string {
  return `${target.user ?? ''}@${target.host}:${target.port ?? 22}|${session}`;
}

export interface SpectatorHubDeps {
  ssh: ChildProcess | { kill(): void; on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void; stderr: { on(event: 'data', cb: (buf: Buffer) => void): void } };
  tmux: { close(): void; on(event: string, cb: (...args: any[]) => void): void; command(cmd: string): Promise<string[]> };
  hubKey: string;
  controlPath?: string;
  onDestroy: () => void;
}

export class SpectatorHub {
  readonly hubKey: string;
  readonly controlPath?: string;
  private ssh: SpectatorHubDeps['ssh'];
  private tmux: SpectatorHubDeps['tmux'];
  private onDestroy: () => void;
  private subscriptions: Set<SpectatorSubscription> = new Set();
  private destroyed = false;
  private stderrTail = '';

  constructor(deps: SpectatorHubDeps) {
    this.ssh = deps.ssh;
    this.tmux = deps.tmux;
    this.hubKey = deps.hubKey;
    this.controlPath = deps.controlPath;
    this.onDestroy = deps.onDestroy;

    this.ssh.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-1024);
    });
    this.ssh.on('exit', (code, signal) => this.handleSshExit(code, signal));
  }

  addSubscription(sub: SpectatorSubscription): void {
    this.subscriptions.add(sub);
  }

  removeSubscription(sub: SpectatorSubscription): void {
    this.subscriptions.delete(sub);
    if (this.subscriptions.size === 0 && !this.destroyed) {
      this.destroy();
    }
  }

  private handleSshExit(code: number | null, signal: string | null): void {
    if (this.destroyed) return;
    const tail = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    let reason: string;
    if (signal) reason = `ssh signal=${signal}`;
    else if (code !== 0 && code !== null) reason = `ssh exit code=${code}`;
    else reason = 'ssh exit';
    if (tail) reason += `: ${tail.slice(0, 240)}`;
    for (const sub of this.subscriptions) sub.callbacks.exit(reason);
    this.destroy();
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.tmux.close(); } catch { /* ignore */ }
    try { this.ssh.kill(); } catch { /* ignore */ }
    if (this.controlPath) {
      unlink(this.controlPath).catch(() => { /* ignore */ });
    }
    this.onDestroy();
  }
}

/**
 * SpectatorSubscription is the per-WS handle. Skeleton — filled in T3/T4.
 */
export class SpectatorSubscription {
  callbacks: SpectatorCallbacks;
  private hub: SpectatorHub;

  constructor(hub: SpectatorHub, callbacks: SpectatorCallbacks) {
    this.hub = hub;
    this.callbacks = callbacks;
    hub.addSubscription(this);
  }

  close(): void {
    this.hub.removeSubscription(this);
  }
}

/** Module-level registry — singleton across the bridge process. */
class HubRegistry {
  private hubs: Map<string, SpectatorHub> = new Map();

  subscribe(
    target: SshTarget,
    session: string,
    callbacks: SpectatorCallbacks,
    opts: { ctrlDir?: string; spawnFn?: typeof spawn } = {}
  ): SpectatorSubscription {
    const key = hubKey(target, session);
    let hub = this.hubs.get(key);
    if (!hub) {
      const spawnFn = opts.spawnFn ?? spawn;
      const controlPath = opts.ctrlDir
        ? `${opts.ctrlDir}/${randomUUID().slice(0, 8)}.sock`
        : undefined;
      const args = buildSpectatorSshArgs(target, session, controlPath);
      const ssh = spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
      if (!ssh.stdin || !ssh.stdout || !ssh.stderr) {
        throw new Error('ssh stdio not available');
      }
      const tmux = new TmuxControlClient(ssh.stdin);
      ssh.stdout.on('data', (chunk: Buffer) => tmux.feed(chunk));
      hub = new SpectatorHub({
        ssh, tmux, hubKey: key, controlPath,
        onDestroy: () => this.hubs.delete(key)
      });
      this.hubs.set(key, hub);
    }
    return new SpectatorSubscription(hub, callbacks);
  }

  /** Test helper — directly inject a constructed hub. */
  _injectHub(hub: SpectatorHub): SpectatorSubscription {
    if (!this.hubs.has(hub.hubKey)) {
      this.hubs.set(hub.hubKey, hub);
    }
    return new SpectatorSubscription(hub, {} as SpectatorCallbacks);
  }

  get(key: string): SpectatorHub | undefined {
    return this.hubs.get(key);
  }

  size(): number {
    return this.hubs.size;
  }
}

export const SpectatorHubRegistry = new HubRegistry();
```

**참고**: 이 단계의 `SpectatorHub`는 hub 자체의 라이프사이클만 갖춤 — 패널 상태 캐시, output fan-out, subscription 모드 (follow/pinned)는 T2~T4에서 추가. `paneUnavailable` 콜백 시그니처는 `SpectatorCallbacks`에 미리 추가되어 있어야 함 → 이 태스크 안에서 함께 추가.

- [ ] **Step 4: `SpectatorCallbacks`에 `paneUnavailable` 추가**

`bridge/src/spectatorSession.ts`에서 `SpectatorCallbacks` 인터페이스 확장:

```typescript
export interface SpectatorCallbacks {
  paneSwitch(info: {
    paneId: string;
    cols: number;
    rows: number;
    altScreen: boolean;
    windowIndex: string;
    windowName: string;
    paneOrdinal: number;
    paneCount: number;
  }): void;
  data(text: string): void;
  paneResize(info: { cols: number; rows: number }): void;
  /** Pinned ordinal exceeds current window's pane count. */
  paneUnavailable(info: { pinnedOrdinal: number; paneCount: number }): void;
  error(message: string): void;
  exit(reason?: string): void;
}
```

- [ ] **Step 5: 라이프사이클 테스트 추가**

`bridge/src/spectatorHub.test.ts`에 추가:

```typescript
function makeHub(key = 'u@h:22|s'): { hub: SpectatorHub; ssh: MockSsh; tmux: MockTmux; destroyed: boolean[] } {
  const ssh = new MockSsh();
  const tmux = new MockTmux();
  const destroyed: boolean[] = [];
  const hub = new SpectatorHub({
    ssh: ssh as any, tmux: tmux as any, hubKey: key,
    onDestroy: () => destroyed.push(true)
  });
  return { hub, ssh, tmux, destroyed };
}

test('SpectatorHub: last subscription unsubscribe → destroy fires', () => {
  const { hub, ssh, tmux, destroyed } = makeHub();
  const sub1 = new SpectatorSubscription(hub, makeCallbacks());
  const sub2 = new SpectatorSubscription(hub, makeCallbacks());
  sub1.close();
  assert.equal(destroyed.length, 0, 'still has sub2');
  sub2.close();
  assert.equal(destroyed.length, 1);
  assert.equal(ssh.killed, true);
});

test('SpectatorHub: ssh exit → all subs get exit callback + hub destroyed', () => {
  const { hub, ssh, destroyed } = makeHub();
  const cb1 = makeCallbacks();
  const cb2 = makeCallbacks();
  new SpectatorSubscription(hub, cb1);
  new SpectatorSubscription(hub, cb2);
  ssh.emit('exit', 1, null);
  assert.ok(cb1.events.some((e) => e.startsWith('exit:')));
  assert.ok(cb2.events.some((e) => e.startsWith('exit:')));
  assert.equal(destroyed.length, 1);
});

test('SpectatorHub: ssh stderr tail included in exit reason', () => {
  const { hub, ssh } = makeHub();
  const cb = makeCallbacks();
  new SpectatorSubscription(hub, cb);
  ssh.stderr.emit('data', Buffer.from('Permission denied (publickey).\n'));
  ssh.emit('exit', 255, null);
  const exitEvent = cb.events.find((e) => e.startsWith('exit:'));
  assert.ok(exitEvent?.includes('Permission denied'));
});

test('hubKey: same target + session → identical key', () => {
  assert.equal(
    hubKey({ host: 'h', user: 'u' }, 's'),
    hubKey({ host: 'h', user: 'u' }, 's')
  );
});

test('hubKey: different session → different key', () => {
  assert.notEqual(
    hubKey({ host: 'h', user: 'u' }, 's1'),
    hubKey({ host: 'h', user: 'u' }, 's2')
  );
});
```

- [ ] **Step 6: 테스트 실행 — 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS — 모든 신규 테스트 통과, 기존 테스트도 통과 (`SpectatorCallbacks`에 `paneUnavailable` 추가만 했으므로 SpectatorSession 클래스 사용처가 메서드 호출 안 함 → 컴파일만 통과하면 됨)

- [ ] **Step 7: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add bridge/src/spectatorHub.ts bridge/src/spectatorHub.test.ts bridge/src/spectatorSession.ts
git commit -m "feat(spectator): SpectatorHub skeleton + registry + lifecycle"
```

```json:metadata
{"files": ["bridge/src/spectatorHub.ts", "bridge/src/spectatorHub.test.ts", "bridge/src/spectatorSession.ts"], "verifyCommand": "cd bridge && npm test", "acceptanceCriteria": ["SpectatorHub class with constructor injection", "SpectatorHubRegistry.subscribe: first call spawns ssh + creates hub", "second subscribe to same key reuses hub (no extra spawn)", "last subscription close → destroy fires + ssh killed + controlPath unlinked", "ssh exit → all subscriptions get exit callback + hub removed from Map", "SpectatorCallbacks.paneUnavailable added"]}
```

---

### Task 2: Hub state caching

**Goal:** Hub가 bootstrap 시 sessionId/windowId/activePaneId/paneStates/currentWindowPaneOrder를 캐시하고, tmux 알림 (`%window-pane-changed`, `%session-window-changed`, `%layout-change`)에 반응해 캐시를 갱신한다. Subscription에 fan-out하는 이벤트 채널 (`onPaneOutput`, `onActivePaneChanged`, `onWindowPaneOrderChanged`)을 노출.

**Files:**
- Modify: `bridge/src/spectatorHub.ts`
- Modify: `bridge/src/spectatorHub.test.ts`

**Acceptance Criteria:**
- [ ] `hub.bootstrap(session)` async — `refresh-client -C 500x200` + `display-message` 쿼리 → `sessionId`, `windowId`, `activePaneId`, `paneStates.get(activePaneId)` 채움. `bootPromise: Promise<void>` 노출
- [ ] `hub.currentWindowPaneOrder: string[]` 채워짐 (bootstrap 시 + `%session-window-changed` / `%layout-change` 시)
- [ ] `%window-pane-changed wid pid` 수신 → `activePaneId` 갱신 → `hub.onActivePaneChanged` 리스너 호출 (debounce 100ms)
- [ ] `%session-window-changed sid wid` 수신 → `windowId` 갱신 → `currentWindowPaneOrder` 재조회 → `hub.onWindowPaneOrderChanged` 리스너 호출
- [ ] `%layout-change wid` 수신 → 같은 윈도우면 `currentWindowPaneOrder` 재조회 + 영향 받은 paneStates 재조회
- [ ] `%output paneId bytes` 수신 → `hub.onPaneOutput` 리스너에 fan-out (subscription이 자기 paneId 필터링)

**Verify:** `cd bridge && npm test` → 모든 hub 테스트 통과

**Steps:**

- [ ] **Step 1: bootstrap 테스트**

`bridge/src/spectatorHub.test.ts`에 추가:

```typescript
test('SpectatorHub.bootstrap: queries display-message and populates state', async () => {
  const { hub, tmux } = makeHub();
  // 첫 command: refresh-client -C 500x200
  // 둘째 command: display-message ...
  const displayLine = '$1|@1|%2|80|24|0|0|0|0|main';
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
    if (cmd.startsWith('display-message')) return Promise.resolve([displayLine]);
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  assert.equal(hub.sessionId, '$1');
  assert.equal(hub.windowId, '@1');
  assert.equal(hub.activePaneId, '%2');
  assert.deepEqual(hub.currentWindowPaneOrder, ['%2', '%3', '%4']);
  const state = hub.paneStates.get('%2');
  assert.equal(state?.cols, 80);
  assert.equal(state?.rows, 24);
});

test('SpectatorHub: %window-pane-changed updates activePaneId + fires listener', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = () => Promise.resolve([]);
  hub.windowId = '@1';
  hub.activePaneId = '%2';
  let fired: string | null = null;
  hub.onActivePaneChanged = (newId) => { fired = newId; };
  tmux.emit('windowPaneChanged', '@1', '%3');
  // debounce 100ms — wait it out
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hub.activePaneId, '%3');
  assert.equal(fired, '%3');
});

test('SpectatorHub: %session-window-changed updates windowId + refreshes pane order', async () => {
  const { hub, tmux } = makeHub();
  hub.sessionId = '$1';
  tmux.command = (cmd: string) => {
    if (cmd.includes('list-panes')) return Promise.resolve(['%5', '%6']);
    return Promise.resolve([]);
  };
  let firedOrder: string[] | null = null;
  hub.onWindowPaneOrderChanged = (order) => { firedOrder = order; };
  tmux.emit('sessionWindowChanged', '$1', '@2');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hub.windowId, '@2');
  assert.deepEqual(hub.currentWindowPaneOrder, ['%5', '%6']);
  assert.deepEqual(firedOrder, ['%5', '%6']);
});

test('SpectatorHub: %output fans out to onPaneOutput listener', () => {
  const { hub, tmux } = makeHub();
  const received: Array<[string, string]> = [];
  hub.onPaneOutput = (paneId, bytes) => received.push([paneId, bytes.toString()]);
  tmux.emit('output', '%2', Buffer.from('hello'));
  tmux.emit('output', '%3', Buffer.from('world'));
  assert.deepEqual(received, [['%2', 'hello'], ['%3', 'world']]);
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd bridge && npm test -- --test-name-pattern=spectatorHub`
Expected: FAIL — `hub.bootstrap`, `hub.paneStates`, listener fields don't exist yet.

- [ ] **Step 3: 상태 캐시 + 이벤트 핸들러 추가**

`bridge/src/spectatorHub.ts`의 `SpectatorHub` 클래스 확장. 다음 필드/메서드 추가:

```typescript
const SWITCH_DEBOUNCE_MS = 100;

export interface PaneState {
  cols: number;
  rows: number;
  altScreen: boolean;
  cursorX: number;
  cursorY: number;
  windowIndex: string;
  windowName: string;
}

export class SpectatorHub {
  // ... 기존 필드 ...

  // 상태 캐시
  sessionId: string | null = null;
  windowId: string | null = null;
  activePaneId: string | null = null;
  paneStates: Map<string, PaneState> = new Map();
  currentWindowPaneOrder: string[] = [];

  // 외부 리스너 (Subscription이 구독)
  onPaneOutput?: (paneId: string, bytes: Buffer) => void;
  onActivePaneChanged?: (paneId: string) => void;
  onWindowPaneOrderChanged?: (order: string[]) => void;
  onLayoutChange?: (windowId: string) => void;

  bootPromise: Promise<void> | null = null;

  // bootstrap을 별도로 노출 (Registry.subscribe가 호출)
  bootstrap(session: string): Promise<void> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this._bootstrap(session);
    return this.bootPromise;
  }

  private async _bootstrap(session: string): Promise<void> {
    // tmux 이벤트 핸들러 등록 (constructor 대신 bootstrap에서 — 테스트에서 캐시 조작 후 emit하기 쉽게)
    this.tmux.on('output', (paneId: string, bytes: Buffer) => {
      this.onPaneOutput?.(paneId, bytes);
    });
    this.tmux.on('windowPaneChanged', (winId: string, paneId: string) => {
      if (winId === this.windowId) this.scheduleActiveChange(paneId);
    });
    this.tmux.on('sessionWindowChanged', (sessId: string, winId: string) => {
      if (sessId === this.sessionId) this.scheduleWindowChange(winId);
    });
    this.tmux.on('layoutChange', (winId: string) => {
      if (winId === this.windowId) {
        this.onLayoutChange?.(winId);
        void this.refreshPaneOrder();
      }
    });

    try {
      try { await this.tmux.command('refresh-client -C 500x200'); } catch { /* tmux < 2.4 */ }
      const lines = await this.tmux.command(
        `display-message -p -t ${session} -F ` +
          "'#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}'"
      );
      const parts = (lines[0] ?? '').split('|');
      if (parts.length < 10) throw new Error('bootstrap: unexpected display-message format');
      this.sessionId = parts[0];
      this.windowId = parts[1];
      this.activePaneId = parts[2];
      this.paneStates.set(parts[2], {
        cols: parseInt(parts[3], 10),
        rows: parseInt(parts[4], 10),
        altScreen: parts[5] === '1',
        cursorX: parseInt(parts[6], 10),
        cursorY: parseInt(parts[7], 10),
        windowIndex: parts[8],
        windowName: parts.slice(9).join('|')
      });
      await this.refreshPaneOrder();
    } catch (err) {
      for (const sub of this.subscriptions) sub.callbacks.error(`bootstrap: ${(err as Error).message}`);
      throw err;
    }
  }

  private switchTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleActiveChange(paneId: string): void {
    if (this.switchTimer) clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(() => {
      this.switchTimer = null;
      this.activePaneId = paneId;
      void this.ensurePaneState(paneId).then(() => {
        this.onActivePaneChanged?.(paneId);
      });
    }, SWITCH_DEBOUNCE_MS);
  }

  private scheduleWindowChange(winId: string): void {
    if (this.switchTimer) clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(async () => {
      this.switchTimer = null;
      this.windowId = winId;
      await this.refreshPaneOrder();
      // 새 윈도우의 활성 패널을 active로 설정
      try {
        const lines = await this.tmux.command(
          `display-message -p -t ${winId} -F '#{pane_id}'`
        );
        const newActive = (lines[0] ?? '').trim();
        if (newActive) {
          this.activePaneId = newActive;
          await this.ensurePaneState(newActive);
          this.onActivePaneChanged?.(newActive);
        }
      } catch { /* swallow */ }
      this.onWindowPaneOrderChanged?.(this.currentWindowPaneOrder);
    }, SWITCH_DEBOUNCE_MS);
  }

  private async refreshPaneOrder(): Promise<void> {
    if (!this.windowId) return;
    try {
      const lines = await this.tmux.command(
        `list-panes -t ${this.windowId} -F '#{pane_id}'`
      );
      this.currentWindowPaneOrder = lines.map((l) => l.trim()).filter(Boolean);
    } catch { /* swallow */ }
  }

  private async ensurePaneState(paneId: string): Promise<PaneState | null> {
    if (this.paneStates.has(paneId)) return this.paneStates.get(paneId)!;
    try {
      const lines = await this.tmux.command(
        `display-message -p -t ${paneId} -F ` +
          "'#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}'"
      );
      const parts = (lines[0] ?? '').split('|');
      if (parts.length < 7) return null;
      const state: PaneState = {
        cols: parseInt(parts[0], 10),
        rows: parseInt(parts[1], 10),
        altScreen: parts[2] === '1',
        cursorX: parseInt(parts[3], 10),
        cursorY: parseInt(parts[4], 10),
        windowIndex: parts[5],
        windowName: parts.slice(6).join('|')
      };
      this.paneStates.set(paneId, state);
      return state;
    } catch {
      return null;
    }
  }

  /** Subscription이 시드용으로 호출 — 캐시된 상태 위에 capture-pane만 추가로 가져옴. */
  async captureSeed(paneId: string, scrollback: number): Promise<string[]> {
    try {
      return await this.tmux.command(`capture-pane -epJ -S -${scrollback} -t ${paneId}`);
    } catch {
      return [];
    }
  }
}
```

기존 destroy 메서드에 timer cleanup 추가:

```typescript
private destroy(): void {
  if (this.destroyed) return;
  this.destroyed = true;
  if (this.switchTimer) { clearTimeout(this.switchTimer); this.switchTimer = null; }
  // ... 나머지 동일 ...
}
```

`Registry.subscribe`도 hub 생성 후 `void hub.bootstrap(session)` 호출 추가:

```typescript
if (!hub) {
  // ... 기존 spawn / TmuxControlClient 셋업 ...
  hub = new SpectatorHub({ ssh, tmux, hubKey: key, controlPath, onDestroy: () => this.hubs.delete(key) });
  this.hubs.set(key, hub);
  void hub.bootstrap(session); // bootPromise 시작 (Subscription은 await할 수 있음)
}
return new SpectatorSubscription(hub, callbacks);
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/spectatorHub.ts bridge/src/spectatorHub.test.ts
git commit -m "feat(spectator): Hub 상태 캐시 + tmux 이벤트 핸들러"
```

```json:metadata
{"files": ["bridge/src/spectatorHub.ts", "bridge/src/spectatorHub.test.ts"], "verifyCommand": "cd bridge && npm test", "acceptanceCriteria": ["hub.bootstrap populates sessionId/windowId/activePaneId/paneStates", "hub.currentWindowPaneOrder populated by refreshPaneOrder", "%window-pane-changed (debounced) updates activePaneId and fires onActivePaneChanged", "%session-window-changed updates windowId, refreshes pane order, fires onWindowPaneOrderChanged", "%layout-change refreshes pane order + onLayoutChange", "%output fans to onPaneOutput listener"]}
```

---

### Task 3: SpectatorSubscription (follow-active mode)

**Goal:** Subscription이 hub 이벤트를 listen하고 자기 paneId만 필터링해 callbacks로 전달. 디폴트는 follow-active 모드 — hub의 `activePaneId`를 추적, 변경 시 capture-pane으로 시드. seed 중 도착한 같은-pane output은 큐잉.

**Files:**
- Modify: `bridge/src/spectatorHub.ts`
- Modify: `bridge/src/spectatorHub.test.ts`

**Acceptance Criteria:**
- [ ] Subscription 생성 시 mode = 'follow-active'; `subscribedPaneId = hub.activePaneId`
- [ ] hub의 `onPaneOutput(paneId, bytes)` 호출 → subscribedPaneId 일치 시 callbacks.data로 emit (UTF-8 디코딩)
- [ ] hub의 `onActivePaneChanged(newId)` 호출 → follow-active 구독자만 paneSwitch + 시드
- [ ] paneSwitch 페이로드: paneId, cols, rows, altScreen, windowIndex, windowName, paneOrdinal (currentWindowPaneOrder 기반), paneCount
- [ ] seed 흐름: paneStates 캐시 + captureSeed → reset+alt-screen+content+cursor 합성 → callbacks.data
- [ ] seeding 중 도착한 같은-pane bytes는 pendingOutput 큐, seed 후 flush
- [ ] 같은 hub의 다른 subscription seeding 중에도 영향 없음

**Verify:** `cd bridge && npm test`

**Steps:**

- [ ] **Step 1: 테스트**

```typescript
test('SpectatorSubscription: follow-active default + receives output for active pane only', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
    if (cmd.startsWith('display-message')) {
      return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    }
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
    if (cmd.startsWith('capture-pane')) return Promise.resolve(['line1', 'line2']);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach(); // 초기 seed 발사 (paneSwitch + data)

  tmux.emit('output', '%2', Buffer.from('to-active'));
  tmux.emit('output', '%3', Buffer.from('to-other'));

  // %2 (subscribedPaneId)만 받음
  const dataEvents = cb.events.filter((e) => e.startsWith('data:'));
  // 초기 seed의 data + 'to-active' 9바이트 → 최소 2개
  assert.ok(dataEvents.length >= 2);
  // %3 bytes는 안 받음 → 'data:9' 가 정확히 한 번만 (to-active만)
  const nineByteData = dataEvents.filter((e) => e === 'data:9');
  assert.equal(nineByteData.length, 1, '%3 bytes should be ignored');
});

test('SpectatorSubscription: onActivePaneChanged → paneSwitch + new seed', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
    if (cmd.startsWith('display-message')) {
      // 첫 호출 (bootstrap): %2, 후속 (%3 ensurePaneState): pane %3 state
      if (cmd.includes(`-t work`)) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
      if (cmd.includes(`-t %3`)) return Promise.resolve(['100|30|0|0|0|0|main']);
      return Promise.resolve([]);
    }
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3']);
    if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  cb.events.length = 0; // initial seed 비움

  tmux.emit('windowPaneChanged', '@1', '%3');
  await new Promise((r) => setTimeout(r, 150)); // debounce

  // sub가 paneSwitch + 시드 받았어야 함
  assert.ok(cb.events.some((e) => e === 'paneSwitch:%3'));
});

test('SpectatorSubscription: bytes during seed are queued + flushed in order', async () => {
  const { hub, tmux } = makeHub();
  let captureResolve: (() => void) | null = null;
  const capturePromise = new Promise<string[]>((r) => {
    captureResolve = () => r(['seed-content']);
  });
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('refresh-client')) return Promise.resolve([]);
    if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
    if (cmd.startsWith('capture-pane')) return capturePromise;
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  const attachPromise = sub.attach();
  // attach 미완료 (capture 응답 대기 중) — output 발사
  tmux.emit('output', '%2', Buffer.from('during-seed'));
  // capture 응답 → seed 완료 → 큐 flush
  captureResolve!();
  await attachPromise;
  // seed 다음에 'during-seed'가 와야 함 (순서 보장)
  const dataEvents = cb.events.filter((e) => e.startsWith('data:'));
  assert.ok(dataEvents.length >= 2);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `sub.attach` not defined, no output filtering.

- [ ] **Step 3: Subscription 채우기**

`bridge/src/spectatorHub.ts`의 `SpectatorSubscription` 클래스를 확장:

```typescript
const SCROLLBACK_SEED_LINES = 1000;

export type SubscriptionMode = { kind: 'follow-active' } | { kind: 'pinned'; ordinal: number };

export class SpectatorSubscription {
  callbacks: SpectatorCallbacks;
  private hub: SpectatorHub;
  mode: SubscriptionMode = { kind: 'follow-active' };
  subscribedPaneId: string | null = null;
  private seeding = false;
  private pendingOutput: Buffer[] = [];
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private closed = false;
  // bound listeners — for hub event dispatch
  private listenerPaneOutput = (paneId: string, bytes: Buffer) => this.onHubPaneOutput(paneId, bytes);
  private listenerActiveChanged = (paneId: string) => this.onHubActivePaneChanged(paneId);
  private listenerWindowOrderChanged = (order: string[]) => this.onHubWindowPaneOrderChanged(order);

  constructor(hub: SpectatorHub, callbacks: SpectatorCallbacks) {
    this.hub = hub;
    this.callbacks = callbacks;
    hub.addSubscription(this);
    hub.addOutputListener(this.listenerPaneOutput);
    hub.addActivePaneListener(this.listenerActiveChanged);
    hub.addWindowOrderListener(this.listenerWindowOrderChanged);
  }

  /** 호출자가 await — bootstrap 완료 후 첫 시드 발사. */
  async attach(): Promise<void> {
    if (this.hub.bootPromise) await this.hub.bootPromise;
    if (this.mode.kind === 'follow-active' && this.hub.activePaneId) {
      await this.switchTo(this.hub.activePaneId);
    }
  }

  private onHubPaneOutput(paneId: string, bytes: Buffer): void {
    if (this.closed) return;
    if (paneId !== this.subscribedPaneId) return;
    if (this.seeding) {
      this.pendingOutput.push(bytes);
      return;
    }
    this.emitBytes(bytes);
  }

  private async onHubActivePaneChanged(paneId: string): Promise<void> {
    if (this.closed) return;
    if (this.mode.kind !== 'follow-active') return; // pinned는 무시
    await this.switchTo(paneId);
  }

  private async onHubWindowPaneOrderChanged(order: string[]): Promise<void> {
    // T4에서 채움 (pinned 재해석). follow-active는 무관.
  }

  private async switchTo(paneId: string): Promise<void> {
    this.seeding = true;
    this.pendingOutput = [];
    this.subscribedPaneId = paneId;
    this.decoder = new TextDecoder('utf-8', { fatal: false });

    const state = this.hub.paneStates.get(paneId);
    if (!state) {
      this.seeding = false;
      return;
    }
    const ordinal = this.hub.currentWindowPaneOrder.indexOf(paneId) + 1;
    const count = this.hub.currentWindowPaneOrder.length;
    this.callbacks.paneSwitch({
      paneId,
      cols: state.cols,
      rows: state.rows,
      altScreen: state.altScreen,
      windowIndex: state.windowIndex,
      windowName: state.windowName,
      paneOrdinal: ordinal,
      paneCount: count
    });

    const capture = await this.hub.captureSeed(paneId, SCROLLBACK_SEED_LINES);
    let seed = '\x1b[?1049l\x1bc';
    if (state.altScreen) seed += '\x1b[?1049h';
    seed += capture.join('\r\n');
    if (Number.isFinite(state.cursorY) && Number.isFinite(state.cursorX)) {
      seed += `\x1b[${state.cursorY + 1};${state.cursorX + 1}H`;
    }
    this.callbacks.data(seed);

    const drain = this.pendingOutput;
    this.pendingOutput = [];
    this.seeding = false;
    for (const b of drain) this.emitBytes(b);
  }

  private emitBytes(bytes: Buffer): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (text) this.callbacks.data(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.removeOutputListener(this.listenerPaneOutput);
    this.hub.removeActivePaneListener(this.listenerActiveChanged);
    this.hub.removeWindowOrderListener(this.listenerWindowOrderChanged);
    this.hub.removeSubscription(this);
  }
}
```

`SpectatorHub`에 listener 등록/해제 API 추가 (단일 리스너 → 다중 리스너 Set으로 전환):

```typescript
// 기존 onPaneOutput?: (paneId, bytes) => void 단일 필드 대신 Set 사용
private paneOutputListeners: Set<(paneId: string, bytes: Buffer) => void> = new Set();
private activePaneListeners: Set<(paneId: string) => void> = new Set();
private windowOrderListeners: Set<(order: string[]) => void> = new Set();

addOutputListener(fn: (paneId: string, bytes: Buffer) => void): void { this.paneOutputListeners.add(fn); }
removeOutputListener(fn: (paneId: string, bytes: Buffer) => void): void { this.paneOutputListeners.delete(fn); }
addActivePaneListener(fn: (paneId: string) => void): void { this.activePaneListeners.add(fn); }
removeActivePaneListener(fn: (paneId: string) => void): void { this.activePaneListeners.delete(fn); }
addWindowOrderListener(fn: (order: string[]) => void): void { this.windowOrderListeners.add(fn); }
removeWindowOrderListener(fn: (order: string[]) => void): void { this.windowOrderListeners.delete(fn); }

// 호출 지점: bootstrap에서 등록한 tmux.on 핸들러에서
// → this.onPaneOutput?.(...) 대신 → for (const fn of this.paneOutputListeners) fn(...);
// 동일하게 activePane / windowOrder도.
```

기존 T2 테스트의 `hub.onPaneOutput = ...` 직접 할당 패턴은 깨질 수 있음 — 단일 리스너 setter도 호환성으로 유지하거나 테스트를 `hub.addOutputListener(...)`로 마이그레이션. 후자를 선택 (deprecate 안 함, 깔끔하게 신규 API만 사용):

T2 테스트 수정:
```typescript
// 기존: hub.onPaneOutput = (paneId, bytes) => received.push(...)
// 신규: hub.addOutputListener((paneId, bytes) => received.push(...))
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd bridge && npm test`

- [ ] **Step 5: Commit**

```bash
git add bridge/src/spectatorHub.ts bridge/src/spectatorHub.test.ts
git commit -m "feat(spectator): SpectatorSubscription follow-active 모드 + 시드 큐잉"
```

```json:metadata
{"files": ["bridge/src/spectatorHub.ts", "bridge/src/spectatorHub.test.ts"], "verifyCommand": "cd bridge && npm test", "acceptanceCriteria": ["Subscription default mode = follow-active", "subscribedPaneId tracks hub.activePaneId", "onPaneOutput filtered by subscribedPaneId", "paneSwitch payload populated with ordinal + count from hub.currentWindowPaneOrder", "seed sent as data after paneSwitch", "bytes during seed buffered + flushed in order", "other subscriptions unaffected by one's seeding"]}
```

---

### Task 4: SpectatorSubscription pin/unpin

**Goal:** `pinOrdinal(n)` / `unpin()` 메서드. ordinal → paneId 해석. `hub.currentWindowPaneOrder` 변경 시 (윈도우 이동, 패널 추가/제거) 재해석. 무효 시 `paneUnavailable` 콜백 발사.

**Files:**
- Modify: `bridge/src/spectatorHub.ts`
- Modify: `bridge/src/spectatorHub.test.ts`

**Acceptance Criteria:**
- [ ] `sub.pinOrdinal(n)` (n ≥ 1) → mode = `{kind: 'pinned', ordinal: n}`, `subscribedPaneId` 해석, 유효면 paneSwitch + 시드, 무효면 `paneUnavailable({pinnedOrdinal: n, paneCount: currentWindowPaneOrder.length})`
- [ ] `sub.unpin()` → mode = 'follow-active', `subscribedPaneId = hub.activePaneId`, 시드
- [ ] pinned 모드에서 `onActivePaneChanged` 무시
- [ ] `onWindowPaneOrderChanged` 발사 시 pinned 모드면 재해석: 유효 → paneSwitch (paneId 다르면) + 시드, 무효 → paneUnavailable
- [ ] 순수 함수 `resolveOrdinal(order: string[], ordinal: number): string | null` export 가능

**Verify:** `cd bridge && npm test`

**Steps:**

- [ ] **Step 1: 테스트**

```typescript
import { resolveOrdinal } from './spectatorHub.js';

test('resolveOrdinal: 유효한 ordinal', () => {
  assert.equal(resolveOrdinal(['%1', '%2', '%3'], 2), '%2');
});

test('resolveOrdinal: 범위 밖 → null', () => {
  assert.equal(resolveOrdinal(['%1', '%2'], 3), null);
  assert.equal(resolveOrdinal(['%1', '%2'], 0), null);
  assert.equal(resolveOrdinal([], 1), null);
});

test('SpectatorSubscription.pinOrdinal: 유효 → subscribedPaneId 갱신 + paneSwitch', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
    if (cmd.startsWith('capture-pane')) return Promise.resolve(['seed']);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  cb.events.length = 0;
  await sub.pinOrdinal(2); // → %3
  assert.equal(sub.subscribedPaneId, '%3');
  assert.ok(cb.events.includes('paneSwitch:%3'));
});

test('SpectatorSubscription.pinOrdinal: 범위 밖 → paneUnavailable', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('display-message')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2']);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  cb.events.length = 0;
  await sub.pinOrdinal(5);
  assert.ok(cb.events.includes('unavail:5/1'));
  assert.equal(sub.subscribedPaneId, null);
});

test('pinned subscription ignores onActivePaneChanged', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %4')) return Promise.resolve(['80|24|0|0|0|0|main']);
    if (cmd.startsWith('list-panes')) return Promise.resolve(['%2', '%3', '%4']);
    if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  await sub.pinOrdinal(2); // %3
  cb.events.length = 0;

  // desktop active 변경 — pinned는 무시
  tmux.emit('windowPaneChanged', '@1', '%4');
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(sub.subscribedPaneId, '%3', 'still %3');
  assert.equal(cb.events.filter((e) => e.startsWith('paneSwitch:')).length, 0);
});

test('pinned subscription: window change → re-resolve ordinal', async () => {
  const { hub, tmux } = makeHub();
  let listPanesCallCount = 0;
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %8')) return Promise.resolve(['80|24|0|0|0|0|other']);
    if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%7']);
    if (cmd.startsWith('list-panes')) {
      listPanesCallCount++;
      if (listPanesCallCount === 1) return Promise.resolve(['%2', '%3', '%4']); // bootstrap
      return Promise.resolve(['%7', '%8']);                                      // new window
    }
    if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  await sub.pinOrdinal(2); // %3
  cb.events.length = 0;

  // 윈도우 이동 (@1 → @2)
  tmux.emit('sessionWindowChanged', '$1', '@2');
  await new Promise((r) => setTimeout(r, 150));

  // 새 윈도우는 %7, %8 — ordinal 2 = %8
  assert.equal(sub.subscribedPaneId, '%8');
  assert.ok(cb.events.includes('paneSwitch:%8'));
});

test('pinned subscription: window change with insufficient panes → paneUnavailable', async () => {
  const { hub, tmux } = makeHub();
  let listPanesCallCount = 0;
  tmux.command = (cmd: string) => {
    if (cmd.startsWith('display-message') && cmd.includes('-t work')) return Promise.resolve(['$1|@1|%2|80|24|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t %3')) return Promise.resolve(['100|30|0|0|0|0|main']);
    if (cmd.startsWith('display-message') && cmd.includes('-t @2')) return Promise.resolve(['%7']);
    if (cmd.startsWith('list-panes')) {
      listPanesCallCount++;
      if (listPanesCallCount === 1) return Promise.resolve(['%2', '%3', '%4']);
      return Promise.resolve(['%7']); // 새 윈도우는 1개 패널만
    }
    if (cmd.startsWith('capture-pane')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  await hub.bootstrap('work');
  const cb = makeCallbacks();
  const sub = new SpectatorSubscription(hub, cb);
  await sub.attach();
  await sub.pinOrdinal(2); // %3
  cb.events.length = 0;

  tmux.emit('sessionWindowChanged', '$1', '@2');
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(cb.events.includes('unavail:2/1'));
  assert.equal(sub.subscribedPaneId, null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && npm test`

- [ ] **Step 3: 구현 추가**

`spectatorHub.ts`에 추가:

```typescript
export function resolveOrdinal(order: string[], ordinal: number): string | null {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > order.length) return null;
  return order[ordinal - 1] ?? null;
}
```

`SpectatorSubscription`에 메서드 추가:

```typescript
async pinOrdinal(n: number): Promise<void> {
  this.mode = { kind: 'pinned', ordinal: n };
  await this.resolveAndApply();
}

async unpin(): Promise<void> {
  this.mode = { kind: 'follow-active' };
  if (this.hub.activePaneId) {
    await this.switchTo(this.hub.activePaneId);
  }
}

/** pinned 모드 한정 — currentWindowPaneOrder 기반으로 해석 후 적용. */
private async resolveAndApply(): Promise<void> {
  if (this.mode.kind !== 'pinned') return;
  const order = this.hub.currentWindowPaneOrder;
  const resolved = resolveOrdinal(order, this.mode.ordinal);
  if (!resolved) {
    this.subscribedPaneId = null;
    this.callbacks.paneUnavailable({
      pinnedOrdinal: this.mode.ordinal,
      paneCount: order.length
    });
    return;
  }
  if (resolved === this.subscribedPaneId) return; // 변화 없음
  // 새 paneId의 상태 캐시 보장
  await this.hub.ensurePaneState(resolved);
  await this.switchTo(resolved);
}
```

`onHubWindowPaneOrderChanged`에 pinned 처리 추가:

```typescript
private async onHubWindowPaneOrderChanged(_order: string[]): Promise<void> {
  if (this.closed) return;
  if (this.mode.kind === 'pinned') {
    await this.resolveAndApply();
  }
}
```

`hub.ensurePaneState`는 private이라 sub에서 접근 불가. public으로 노출:
```typescript
async ensurePaneState(paneId: string): Promise<PaneState | null> { /* 기존 본문 */ }
```

또한 layout change 시 same-window라면 currentWindowPaneOrder 변경되었을 가능성이 있으므로 windowOrder 리스너도 fire:

`SpectatorHub.refreshPaneOrder` 끝에:
```typescript
private async refreshPaneOrder(): Promise<void> {
  if (!this.windowId) return;
  try {
    const lines = await this.tmux.command(
      `list-panes -t ${this.windowId} -F '#{pane_id}'`
    );
    const newOrder = lines.map((l) => l.trim()).filter(Boolean);
    const changed = newOrder.length !== this.currentWindowPaneOrder.length
      || newOrder.some((id, i) => id !== this.currentWindowPaneOrder[i]);
    this.currentWindowPaneOrder = newOrder;
    if (changed) {
      for (const fn of this.windowOrderListeners) fn(newOrder);
    }
  } catch { /* swallow */ }
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd bridge && npm test`

- [ ] **Step 5: Commit**

```bash
git add bridge/src/spectatorHub.ts bridge/src/spectatorHub.test.ts
git commit -m "feat(spectator): Subscription pin/unpin + ordinal 재해석"
```

```json:metadata
{"files": ["bridge/src/spectatorHub.ts", "bridge/src/spectatorHub.test.ts"], "verifyCommand": "cd bridge && npm test", "acceptanceCriteria": ["resolveOrdinal pure helper exported", "pinOrdinal(n) valid → subscribedPaneId updated + paneSwitch", "pinOrdinal(n) invalid → paneUnavailable callback", "unpin → follow-active mode + activePaneId switch", "pinned ignores onActivePaneChanged", "pinned re-resolves on onWindowPaneOrderChanged", "window change with insufficient panes → paneUnavailable"]}
```

---

### Task 5: Hub desktop-mutating methods

**Goal:** `hub.selectPane(ordinal)`, `hub.tmuxNav(action)`, `hub.sendInput(text)` 구현. Subscription에서 위임 호출 가능하게 메서드 노출. 이전 SpectatorSession의 동명 메서드와 동일한 tmux 명령 사용.

**Files:**
- Modify: `bridge/src/spectatorHub.ts`
- Modify: `bridge/src/spectatorHub.test.ts`

**Acceptance Criteria:**
- [ ] `hub.selectPane(n)` → `list-panes` 후 (n-1)번째 paneId로 `select-pane -t <paneId>` 송신
- [ ] `hub.tmuxNav('next-pane' | 'prev-pane' | 'next-window' | 'prev-window')` → 해당 tmux 명령 송신
- [ ] `hub.sendInput(text)` → 현재 activePaneId에 `send-keys -H <hex>` 송신 (text 빈 문자열이면 no-op)
- [ ] Subscription에 위임 메서드: `sub.selectPane(n)`, `sub.tmuxNav(a)`, `sub.sendInput(t)` → hub로 transparent forward
- [ ] `sub.hasActivePane()` → `hub.activePaneId != null && !hub.destroyed`

**Verify:** `cd bridge && npm test`

**Steps:**

- [ ] **Step 1: 테스트**

```typescript
import type { SpectatorNavAction } from './spectatorSession.js';

test('hub.selectPane: list-panes 후 select-pane', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = async (cmd: string) => {
    if (cmd.startsWith('list-panes')) return ['%5', '%6', '%7'];
    return [];
  };
  await hub.selectPane(2);
  // 두 번째 명령은 select-pane -t %6
  assert.ok(tmux.commands.some((c) => c === 'select-pane -t %6'));
});

test('hub.selectPane: ordinal 초과 → no-op', async () => {
  const { hub, tmux } = makeHub();
  tmux.command = async (cmd: string) => {
    if (cmd.startsWith('list-panes')) return ['%5'];
    return [];
  };
  await hub.selectPane(5);
  assert.equal(tmux.commands.filter((c) => c.startsWith('select-pane')).length, 0);
});

test('hub.tmuxNav: action별 정확한 명령', async () => {
  const { hub, tmux } = makeHub();
  hub.sessionId = '$1';
  // sessionName이 hub에 캐시되지 않음 → spectator session name을 hub에 추가해야 함
  // (이전 SpectatorSession은 sessionName 필드를 가졌음. hub도 마찬가지로 필요.)
  (hub as any).sessionName = 'work';
  await hub.tmuxNav('next-pane');
  await hub.tmuxNav('prev-pane');
  await hub.tmuxNav('next-window');
  await hub.tmuxNav('prev-window');
  assert.deepEqual(tmux.commands, [
    'select-pane -t work:.+',
    'select-pane -t work:.-',
    'select-window -t work:+',
    'select-window -t work:-'
  ]);
});

test('hub.sendInput: hex-encoded send-keys to activePaneId', async () => {
  const { hub, tmux } = makeHub();
  hub.activePaneId = '%2';
  await hub.sendInput('y');
  assert.deepEqual(tmux.commands, ['send-keys -t %2 -H 79']);
});

test('hub.sendInput: empty / no activePaneId → no-op', async () => {
  const { hub, tmux } = makeHub();
  await hub.sendInput('y');
  assert.equal(tmux.commands.length, 0);
  hub.activePaneId = '%2';
  await hub.sendInput('');
  assert.equal(tmux.commands.length, 0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && npm test`

- [ ] **Step 3: 구현**

`SpectatorHub`에 `sessionName` 필드 + 메서드 추가:

```typescript
// 생성자에서 sessionName 받기
sessionName: string;

// SpectatorHubDeps에 추가:
//   sessionName: string;
//
// constructor(deps): ... this.sessionName = deps.sessionName ...
//
// Registry.subscribe에서 hub 생성 시 sessionName: session 전달
```

```typescript
async selectPane(ordinal: number): Promise<void> {
  if (this.destroyed || !Number.isInteger(ordinal) || ordinal < 1) return;
  try {
    const lines = await this.tmux.command(`list-panes -t ${this.sessionName} -F '#{pane_id}'`);
    const paneId = (lines[ordinal - 1] ?? '').trim();
    if (!paneId) return;
    await this.tmux.command(`select-pane -t ${paneId}`);
  } catch (err) {
    console.error('[spectator-hub] selectPane failed:', (err as Error).message);
  }
}

async tmuxNav(action: SpectatorNavAction): Promise<void> {
  if (this.destroyed) return;
  const s = this.sessionName;
  let cmd: string;
  switch (action) {
    case 'next-pane': cmd = `select-pane -t ${s}:.+`; break;
    case 'prev-pane': cmd = `select-pane -t ${s}:.-`; break;
    case 'next-window': cmd = `select-window -t ${s}:+`; break;
    case 'prev-window': cmd = `select-window -t ${s}:-`; break;
    default: return;
  }
  try { await this.tmux.command(cmd); } catch (err) {
    console.error('[spectator-hub] tmuxNav failed:', (err as Error).message);
  }
}

async sendInput(text: string): Promise<void> {
  if (this.destroyed || !this.activePaneId || !text) return;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  try {
    await this.tmux.command(`send-keys -t ${this.activePaneId} -H ${hex.join(' ')}`);
  } catch (err) {
    console.error('[spectator-hub] sendInput failed:', (err as Error).message);
  }
}
```

`SpectatorSubscription`에 위임 메서드:

```typescript
selectPane(n: number): void { void this.hub.selectPane(n); }
tmuxNav(action: SpectatorNavAction): void { void this.hub.tmuxNav(action); }
sendInput(text: string): void { void this.hub.sendInput(text); }
hasActivePane(): boolean { return this.hub.activePaneId != null && !this.closed; }
```

- [ ] **Step 4: 테스트 — 통과 확인**

Run: `cd bridge && npm test`

- [ ] **Step 5: Commit**

```bash
git add bridge/src/spectatorHub.ts bridge/src/spectatorHub.test.ts
git commit -m "feat(spectator): Hub desktop-mut 메서드 (selectPane / tmuxNav / sendInput)"
```

```json:metadata
{"files": ["bridge/src/spectatorHub.ts", "bridge/src/spectatorHub.test.ts"], "verifyCommand": "cd bridge && npm test", "acceptanceCriteria": ["hub.selectPane resolves ordinal via list-panes + select-pane", "hub.tmuxNav emits correct tmux command per action", "hub.sendInput hex-encodes to send-keys on activePaneId", "Subscription delegates selectPane / tmuxNav / sendInput to hub", "sub.hasActivePane reflects hub state"]}
```

---

### Task 6: server.ts integration

**Goal:** `handleWs`에서 `new SpectatorSession(...)` 호출을 `SpectatorHubRegistry.subscribe(...)`로 교체. `subscribe-pane` 프레임을 라우팅 (`ordinal=0` → unpin, `ordinal>=1` → pinOrdinal). `imageTransfer`에 hub.controlPath 전달.

**Files:**
- Modify: `bridge/src/server.ts`
- Modify: `bridge/src/spectatorSession.ts` (SpectatorSession 클래스 import 제거하지만 클래스 자체 삭제는 T9에서)

**Acceptance Criteria:**
- [ ] `handleWs`: `spectator: SpectatorSession | null` → `subscription: SpectatorSubscription | null` 타입 교체
- [ ] `mode: 'spectate'` connect → `SpectatorHubRegistry.subscribe(target, session, callbacks)` → `subscription = ...` + `await subscription.attach()`
- [ ] WS msg `{type: 'subscribe-pane', ordinal: N}` → N>=1이면 `subscription.pinOrdinal(N)`, N==0이면 `subscription.unpin()`
- [ ] WS msg `{type: 'data', d}` → `subscription.sendInput(d)` (기존 동작)
- [ ] WS msg `{type: 'tmux-nav', action}` → `subscription.tmuxNav(action)` 또는 `subscription.selectPane(index)` (기존)
- [ ] WS close → `subscription.close()` (이는 hub의 마지막 sub일 때 ssh도 정리)
- [ ] `handleImageMessage` spectator 분기: hub.controlPath로 imageTransfer 호출
- [ ] callbacks의 `paneUnavailable` → `send({type: 'pane-unavailable', pinnedOrdinal, paneCount})` 송신

**Verify:** `cd bridge && npm test && npm run build 2>&1 | grep -v 'node_modules' || echo "OK"`

**Steps:**

- [ ] **Step 1: server.ts 수정**

`bridge/src/server.ts` 수정:

```typescript
// import 교체
import { SpectatorHubRegistry, type SpectatorSubscription } from './spectatorHub.js';

// ClientMsg에 'subscribe-pane' 추가
interface ClientMsg {
  type: 'connect' | 'data' | 'resize' | 'tmux-nav' | 'image' | 'subscribe-pane';
  // ... 기존 필드 ...
  ordinal?: number;  // for subscribe-pane
}

// handleWs 내부
let subscription: SpectatorSubscription | null = null;
// spectator 변수는 모두 subscription으로 rename

// connect spectate 분기
if (msg.mode === 'spectate') {
  const session = typeof msg.session === 'string' ? msg.session : '';
  if (!session) {
    send({ type: 'error', message: 'missing session' });
    ws.close(1008, 'missing session');
    return;
  }
  void startSpectator(target, session);
  return;
}

// startSpectator 함수 본문
async function startSpectator(target: SshTarget, session: string): Promise<void> {
  sessionTarget = target;
  const wol = lookupWolTarget(target.host);
  console.log(`[term-bridge] spectate target=${target.user ?? ''}@${target.host}:${target.port ?? 22} session=${session}`);
  if (wol) {
    const ok = await wakeIfNeeded(target, wol, abortCtrl.signal, send);
    if (!ok) {
      if (!abortCtrl.signal.aborted) {
        send({ type: 'error', message: 'wake_timeout' });
        try { ws.close(1011, 'wake timeout'); } catch { /* ignore */ }
      }
      return;
    }
  }
  if (abortCtrl.signal.aborted) return;
  try {
    subscription = SpectatorHubRegistry.subscribe(target, session, {
      paneSwitch: (info) => send({ type: 'pane-switch', ...info }),
      data: (d) => send({ type: 'data', d }),
      paneResize: (info) => send({ type: 'pane-resize', ...info }),
      paneUnavailable: (info) => send({ type: 'pane-unavailable', ...info }),
      error: (message) => send({ type: 'error', message }),
      exit: (reason) => {
        send({ type: 'exit', code: 0, reason });
        try { ws.close(1000, reason ?? 'spectator exit'); } catch { /* ignore */ }
      }
    }, { ctrlDir: CTRL_DIR });
    // hub의 controlPath를 controlPath 변수로 동기화 (이미지 라우팅용)
    controlPath = subscription.controlPath ?? null;
  } catch (err) {
    send({ type: 'error', message: `spectator spawn failed: ${(err as Error).message}` });
    try { ws.close(1011, 'spectator spawn failed'); } catch { /* ignore */ }
    return;
  }
  if (abortCtrl.signal.aborted) {
    subscription.close();
    subscription = null;
    return;
  }
  try {
    await subscription.attach();
  } catch { /* bootstrap 실패는 이미 error 콜백으로 통지됨 */ }
  send({ type: 'ready' });
}

// 메시지 라우팅 — spectator 분기
if (subscription) {
  if (msg.type === 'data' && typeof msg.d === 'string') {
    subscription.sendInput(msg.d);
  } else if (msg.type === 'tmux-nav' && typeof msg.action === 'string') {
    if (msg.action === 'select-pane') {
      if (typeof msg.index === 'number' && Number.isInteger(msg.index) && msg.index >= 1) {
        subscription.selectPane(msg.index);
      }
    } else if (TMUX_NAV_ACTIONS.has(msg.action)) {
      subscription.tmuxNav(msg.action as SpectatorNavAction);
    }
  } else if (msg.type === 'subscribe-pane' && typeof msg.ordinal === 'number') {
    if (msg.ordinal === 0) void subscription.unpin();
    else if (Number.isInteger(msg.ordinal) && msg.ordinal >= 1) void subscription.pinOrdinal(msg.ordinal);
  }
  return;
}

// ws close
if (subscription) {
  try { subscription.close(); } catch { /* ignore */ }
  subscription = null;
}
```

`SpectatorSubscription`에 `controlPath` getter 추가:

```typescript
get controlPath(): string | undefined { return this.hub.controlPath; }
```

- [ ] **Step 2: 빌드 + 테스트**

Run: `cd bridge && npm test && npm run build`
Expected: PASS — 모든 테스트 통과, TypeScript 컴파일 성공

- [ ] **Step 3: Commit**

```bash
git add bridge/src/server.ts bridge/src/spectatorHub.ts
git commit -m "feat(spectator): server.ts → SpectatorHubRegistry + subscribe-pane 라우팅"
```

```json:metadata
{"files": ["bridge/src/server.ts", "bridge/src/spectatorHub.ts"], "verifyCommand": "cd bridge && npm test && npm run build", "acceptanceCriteria": ["handleWs uses SpectatorSubscription", "subscribe-pane frame routes to pinOrdinal/unpin", "controlPath flows from hub for image transfer", "paneUnavailable callback emits WS frame", "data/tmux-nav messages still routed correctly"]}
```

---

### Task 7: Client wsClient.ts — subscribePane + pane-unavailable

**Goal:** `TerminalWsClient`에 `subscribePane(ordinal: number)` 메서드 추가, `pane-unavailable` 메시지 수신 처리 + `onPaneUnavailable` 콜백 노출.

**Files:**
- Modify: `app/src/lib/editor/terminal/wsClient.ts`
- Create: `app/tests/unit/editor/wsClientSubscribePane.test.ts`

**Acceptance Criteria:**
- [ ] `ClientOptions`에 `onPaneUnavailable?: (info: {pinnedOrdinal: number, paneCount: number}) => void` 추가
- [ ] `ServerMsg` type union에 `'pane-unavailable'` 추가, `pinnedOrdinal` / `paneCount` 필드 추가
- [ ] `TerminalWsClient.subscribePane(ordinal: number): void` — `{type:'subscribe-pane', ordinal}` 송신
- [ ] 메시지 핸들러에서 `pane-unavailable` 수신 시 `onPaneUnavailable` 호출 (number 타입 검증 후)
- [ ] 단위 테스트: subscribePane이 올바른 프레임 전송, pane-unavailable 수신이 콜백 호출

**Verify:** `cd app && npx vitest run tests/unit/editor/wsClientSubscribePane.test.ts`

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/editor/wsClientSubscribePane.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

// 기존 wsClient 테스트의 mock WebSocket 패턴 따라가기
class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(s: string): void { this.sent.push(s); }
  close(): void {}
  _open(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  _msg(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

describe('TerminalWsClient.subscribePane', () => {
  let originalWs: typeof globalThis.WebSocket;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    originalWs = globalThis.WebSocket;
    mockWs = new MockWebSocket();
    (globalThis as any).WebSocket = vi.fn(() => mockWs);
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWs;
  });

  it('subscribePane(3) sends {type:subscribe-pane, ordinal:3}', () => {
    const client = new TerminalWsClient({
      bridge: 'http://b',
      target: 't',
      token: 'tk',
      cols: 80,
      rows: 24,
      onStatus: () => {},
      onData: () => {}
    });
    client.connect();
    mockWs._open();
    const before = mockWs.sent.length;
    client.subscribePane(3);
    expect(mockWs.sent.length).toBe(before + 1);
    const frame = JSON.parse(mockWs.sent[mockWs.sent.length - 1]);
    expect(frame).toEqual({ type: 'subscribe-pane', ordinal: 3 });
  });

  it('subscribePane(0) for unpin', () => {
    const client = new TerminalWsClient({
      bridge: 'http://b', target: 't', token: 'tk', cols: 80, rows: 24,
      onStatus: () => {}, onData: () => {}
    });
    client.connect();
    mockWs._open();
    client.subscribePane(0);
    const frame = JSON.parse(mockWs.sent[mockWs.sent.length - 1]);
    expect(frame).toEqual({ type: 'subscribe-pane', ordinal: 0 });
  });

  it('pane-unavailable message → onPaneUnavailable callback', () => {
    const received: Array<{ pinnedOrdinal: number; paneCount: number }> = [];
    const client = new TerminalWsClient({
      bridge: 'http://b', target: 't', token: 'tk', cols: 80, rows: 24,
      onStatus: () => {}, onData: () => {},
      onPaneUnavailable: (info) => received.push(info)
    });
    client.connect();
    mockWs._open();
    mockWs._msg({ type: 'pane-unavailable', pinnedOrdinal: 5, paneCount: 2 });
    expect(received).toEqual([{ pinnedOrdinal: 5, paneCount: 2 }]);
  });

  it('pane-unavailable with invalid types → callback NOT called', () => {
    const received: unknown[] = [];
    const client = new TerminalWsClient({
      bridge: 'http://b', target: 't', token: 'tk', cols: 80, rows: 24,
      onStatus: () => {}, onData: () => {},
      onPaneUnavailable: (info) => received.push(info)
    });
    client.connect();
    mockWs._open();
    mockWs._msg({ type: 'pane-unavailable', pinnedOrdinal: 'x', paneCount: 2 });
    expect(received).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/wsClientSubscribePane.test.ts`
Expected: FAIL — `subscribePane` not defined, `onPaneUnavailable` not in options.

- [ ] **Step 3: wsClient.ts 수정**

```typescript
// ClientOptions 인터페이스에 추가
onPaneUnavailable?: (info: { pinnedOrdinal: number; paneCount: number }) => void;

// ServerMsg type 추가
interface ServerMsg {
  type:
    | 'data' | 'exit' | 'error' | 'ready'
    | 'pane-switch' | 'pane-resize'
    | 'pane-unavailable'   // 추가
    | 'image-ok' | 'image-error';
  // ... 기존 필드 ...
  pinnedOrdinal?: number;
  paneCount?: number;
}

// 메시지 핸들러 분기 추가
} else if (msg.type === 'pane-unavailable') {
  if (
    this.opts.onPaneUnavailable &&
    typeof msg.pinnedOrdinal === 'number' &&
    typeof msg.paneCount === 'number'
  ) {
    this.opts.onPaneUnavailable({
      pinnedOrdinal: msg.pinnedOrdinal,
      paneCount: msg.paneCount
    });
  }
}

// subscribePane 메서드
/**
 * Tell the bridge which pane this subscription wants to follow.
 * ordinal >= 1 → pin to that pane (1-based, in current window).
 * ordinal === 0 → unpin (back to follow-active).
 */
subscribePane(ordinal: number): void {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify({ type: 'subscribe-pane', ordinal }));
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/wsClientSubscribePane.test.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/terminal/wsClient.ts app/tests/unit/editor/wsClientSubscribePane.test.ts
git commit -m "feat(terminal): wsClient subscribePane + pane-unavailable 콜백"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/wsClient.ts", "app/tests/unit/editor/wsClientSubscribePane.test.ts"], "verifyCommand": "cd app && npx vitest run tests/unit/editor/wsClientSubscribePane.test.ts && npm run check", "acceptanceCriteria": ["ClientOptions.onPaneUnavailable callback added", "ServerMsg type union includes pane-unavailable", "subscribePane(n) sends correct frame", "pane-unavailable message dispatches to callback with type check"]}
```

---

### Task 8: Client TerminalView 정리 + 새 배너

**Goal:** `pinDetached` 상태/배너/`reattachIfPinned` 헬퍼 모두 제거. `pinUnavailable: boolean` + 노란 배너 추가. 자물쇠 토글 시 `client.subscribePane(N or 0)` 송신. WS open 시 `spec.pinnedPane` 있으면 `subscribePane(N)` 호출.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`

**Acceptance Criteria:**
- [ ] `pinDetached` 상태 변수 + 관련 `{#if pinDetached}` 배너 + `.banner-pin-detached` CSS 모두 삭제
- [ ] `reattachIfPinned` 함수 + 모든 호출 지점 (handlePageClick, term.onData, sendPopupSubmit, sendQuickKey, sendImageFile) 삭제
- [ ] WS open 시 (mount + reconnect 양쪽) 핀이면 `client.selectPane(N)` 자동 호출 로직 삭제 — 대신 `client.subscribePane(N)` 호출
- [ ] `onPaneSwitch` 분기에서 `pinDetached = true`/`false` 설정 로직 삭제 — 그냥 paneId/cols/rows만 처리
- [ ] 신규 상태: `let pinUnavailable = $state(false)` + `let pinUnavailableInfo = $state<{pinnedOrdinal: number, paneCount: number} | null>(null)`
- [ ] `onPaneUnavailable` 콜백 → `pinUnavailable = true; pinUnavailableInfo = info`
- [ ] `onPaneSwitch` 콜백 → `pinUnavailable = false; pinUnavailableInfo = null` (배너 자동 해제)
- [ ] 신규 배너: `{#if pinUnavailable && pinUnavailableInfo}` "패널 {N}번 없음 (현재 윈도우 패널 {M}개)" — `.banner-pin-unavailable` 노란 톤
- [ ] `onPaneNumClick` 자물쇠 토글 시 `client?.subscribePane(N or 0)` 호출 + `persistPinToNote` 호출 (기존 그대로)
- [ ] 클릭/타이핑 시 핀 패널 활성화는 그대로 (`client?.selectPane(pinnedOrdinal)`) — 단 reattachIfPinned 래퍼 제거하고 직접 호출

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: TerminalView.svelte 수정**

전체 파일을 한 번에 수정 (Edit 도구로 여러 부분 변경).

**제거할 코드 패턴**:
- `let pinDetached = $state(false);` → 삭제
- `function reattachIfPinned(): void { ... }` → 삭제
- 모든 `reattachIfPinned();` 호출 지점 → 삭제 (handlePageClick 안, term.onData 안, sendPopupSubmit 안, sendQuickKey 안, sendImageFile 안)
- `client?.send({ type: 'tmux-nav', action: 'select-pane', index: pinnedOrdinal })` 자동 호출 (WS open 시) → 삭제 후 `client?.subscribePane(pinnedOrdinal)`로 교체
- `onPaneSwitch` 콜백 분기:
  - `if (pinnedOrdinal !== null) { if (paneOrdinal === pinnedOrdinal) pinDetached = false; else pinDetached = true; }` → 삭제
- `{#if pinDetached}` 블록 + 내부 div → 삭제
- `.banner-pin-detached` CSS → 삭제

**추가할 코드**:

```svelte
<script lang="ts">
  // ... 기존 imports ...
  // 신규 state
  let pinUnavailable = $state(false);
  let pinUnavailableInfo = $state<{ pinnedOrdinal: number; paneCount: number } | null>(null);

  // wsClient 생성 시 onPaneUnavailable 콜백 추가
  client = new TerminalWsClient({
    // ... 기존 필드 ...
    onPaneUnavailable: (info) => {
      pinUnavailable = true;
      pinUnavailableInfo = info;
    },
    onPaneSwitch: (info) => {
      pinUnavailable = false;
      pinUnavailableInfo = null;
      // ... 기존 paneSwitch 처리 (paneId, cols, rows, paneOrdinal, paneCount 등) ...
    }
  });

  // onPaneNumClick 토글 분기 — subscribePane 호출 추가
  async function onPaneNumClick(n: number): Promise<void> {
    if (pinnedOrdinal === n) {
      // unpin
      pinnedOrdinal = null;
      client?.subscribePane(0);
      await persistPinToNote(null);
      return;
    }
    if (pinnedOrdinal === null && n === spectatorPaneOrdinal) {
      // pin to current active
      pinnedOrdinal = n;
      client?.subscribePane(n);
      await persistPinToNote(n);
      return;
    }
    // 다른 번호 클릭 — 핀 중이면 disabled (현재 정책 유지), 비핀이면 select-pane
    client?.selectPane(n);
  }

  // 핀 상태로 WS 열린 직후 (mount + reconnect 모두)
  // 기존: client.send({ type:'tmux-nav', action:'select-pane', index: pinnedOrdinal });
  // 신규:
  // if (pinnedOrdinal !== null) client?.subscribePane(pinnedOrdinal);

  // 클릭/타이핑 시 핀 패널 활성화 — reattachIfPinned 래퍼 제거
  function handlePageClick(): void {
    if (pinnedOrdinal !== null) {
      client?.selectPane(pinnedOrdinal);
    }
    // ... 기존 xterm.focus 등 ...
  }
  // term.onData, sendPopupSubmit, sendQuickKey, sendImageFile 안의
  // reattachIfPinned() 호출도 동일하게 인라인:
  //   if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);
</script>

{#if pinUnavailable && pinUnavailableInfo}
  <div class="banner banner-pin-unavailable">
    패널 {pinUnavailableInfo.pinnedOrdinal}번 없음 (현재 윈도우 패널 {pinUnavailableInfo.paneCount}개)
  </div>
{/if}

<style>
  .banner-pin-unavailable {
    background: #fff8e1;
    color: #6b5b00;
    border-left: 3px solid #f0c000;
    padding: 6px 10px;
    font-size: 0.85em;
  }
</style>
```

(정확한 수정 위치는 현재 TerminalView.svelte 코드를 읽고 Edit 도구로 부분 치환. 너무 큰 파일이라 한 번에 Write는 불가 — Edit으로 부분 치환 권장.)

- [ ] **Step 2: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors (기존 warnings는 무관)

- [ ] **Step 3: 단위 테스트 영향 확인**

Run: `cd app && npm test`
Expected: 모든 기존 테스트 통과 (TerminalView 자체 단위 테스트는 없음 — 수동 검증은 T9에서)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): TerminalView 정리 — pinDetached 제거, pinUnavailable 추가, subscribePane 사용"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/TerminalView.svelte"], "verifyCommand": "cd app && npm run check && npm test", "acceptanceCriteria": ["pinDetached state and red banner removed", "reattachIfPinned helper + all call sites removed", "WS open auto-selectPane replaced with subscribePane", "pinUnavailable state + yellow banner added", "onPaneUnavailable callback wired", "onPaneSwitch clears pinUnavailable", "onPaneNumClick sends subscribePane(N or 0)"]}
```

---

### Task 9: 옛 SpectatorSession 삭제 + CLAUDE.md 갱신 + 최종 회귀

**Goal:** `bridge/src/spectatorSession.ts`에서 `SpectatorSession` 클래스 본문 삭제 (순수 함수와 인터페이스만 남김). CLAUDE.md의 tomboy-terminal 섹션 spectator 부분 갱신. 전체 테스트 + 수동 회귀 8개 시나리오 검증.

**Files:**
- Modify: `bridge/src/spectatorSession.ts`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `bridge/src/spectatorSession.ts`에서 `SpectatorSession` 클래스 본문 모두 삭제, `SpectatorOptions` 인터페이스도 삭제
- [ ] 유지되는 것: `SpectatorCallbacks` (paneUnavailable 포함), `SpectatorNavAction`, `buildSpectatorSshArgs`, `panePosition`
- [ ] `import { SpectatorSession }`를 사용하는 곳 0개 (grep 검증)
- [ ] CLAUDE.md tomboy-terminal 섹션: spectator 다중-구독 모델 + pinned 동작 (라이브 + ordinal-based) 1~2단락 추가, 기존 pin 문단 갱신
- [ ] `cd bridge && npm test` → 모든 테스트 통과
- [ ] `cd app && npm test && npm run check` → 모든 테스트 통과 + 0 errors
- [ ] 수동 회귀 8개 시나리오 (아래) 통과

**Verify:** `cd bridge && npm test && cd ../app && npm test && npm run check`

**Steps:**

- [ ] **Step 1: SpectatorSession 클래스 삭제**

`bridge/src/spectatorSession.ts`에서 다음 삭제:
- `import { spawn, type ChildProcess } from 'node:child_process';`
- `import { TmuxControlClient } from './tmuxControlClient.js';`
- `import { controlMasterArgs } from './pty.js';` (단, buildSpectatorSshArgs가 controlMasterArgs를 쓰면 유지)
- `const SWITCH_DEBOUNCE_MS`, `const SCROLLBACK_SEED_LINES` 상수 — 더 이상 안 쓰면 삭제
- `class SpectatorSession { ... }` 전체 본문 삭제
- `interface SpectatorOptions` 삭제

유지:
- `interface SpectatorCallbacks` (paneUnavailable 포함)
- `export type SpectatorNavAction = ...`
- `export function buildSpectatorSshArgs(...)` (controlMasterArgs 의존 유지 — 같은 함수에서 임포트)
- `export function panePosition(...)` (테스트 의존)
- `const SAFE_SESSION_RE` (buildSpectatorSshArgs에서 사용)

- [ ] **Step 2: 의존성 검사**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
grep -rn 'SpectatorSession\b' bridge/src/ app/src/ || echo "no references"
```

Expected: `no references` 또는 `SpectatorSessionRegistry` 류만 (있으면 안 됨 — 사실 hub 코드에선 SpectatorHub만 쓰므로 0개여야 정상)

- [ ] **Step 3: 빌드 + 테스트**

```bash
cd bridge && npm run build && npm test
cd ../app && npm run check && npm test
```

Expected: PASS, 0 errors

- [ ] **Step 4: CLAUDE.md 갱신**

`CLAUDE.md`의 tomboy-terminal 섹션에서 spectator 관련 문단을 찾아 다음으로 교체/추가:

```markdown
Spectator (mobile-side observer of the desktop's currently-focused tmux
pane): add `spectate: <session>` next to `ssh://`. **여러 노트가 같은
세션을 동시에 관전할 때 각 노트는 독립적인 패널을 라이브로 받을 수
있다** — 브릿지는 (target, session)당 단일 ssh + tmux -CC 클라이언트를
공유 hub로 유지하고, 각 노트(WS)는 자기가 보고 싶은 패널만 필터링하는
subscription을 갖는다. tmux -CC가 이미 모든 패널의 %output을 emit하므로
새 데이터 채널 없이 fan-out으로 처리. 핀이 활성이면 desktop active와
무관하게 라이브 스트림이 계속 흐른다.

핀 동작 (자물쇠 🔒): 활성 패널 버튼을 한 번 더 클릭하면 그 ordinal로
구독을 고정. 노트 본문의 `spectate: <s>:<N>`에 영속화. **ordinal 기반**
— 윈도우 이동 시 새 윈도우의 N번 패널로 재해석되고, 패널 수가 부족하면
"패널 N번 없음" 노란 배너 표시 후 다시 N개 이상 되면 자동 재구독.
핀 중 다른 footer 번호 버튼은 disabled (해제 후 재핀 패턴). 노트
클릭/타이핑 시 핀 패널이 desktop active로 끌어올려진다 (`select-pane`).
모바일 보내기 popup의 기존 quick-keys/이미지 전송도 그대로 활성.

(... 기존 attach 메커니즘, stty 500x200, window-size smallest 등의
설명은 유지 ...)
```

기존 "Spectator (mobile-side observer..." 문단과 그 뒤의 핀 관련 단락 (이전에 추가된 거)을 위 내용으로 교체.

`bridge/` 파일 맵에서 `spectatorSession.ts` → `spectatorHub.ts, spectatorSession.ts` 로 갱신:

```markdown
- `bridge/` — `src/{server,auth,pty,hosts,wol,tmuxControlClient,spectatorHub,spectatorSession,imageTransfer}.ts`, ...
```

- [ ] **Step 5: 수동 회귀 시나리오 실행**

체크리스트 (사용자가 수동 검증):

1. **단일 노트, follow-active**: 데스크탑 패널 전환 따라감
2. **단일 노트, 핀 ordinal 3**: desktop이 다른 패널로 가도 라이브 계속 (process가 출력하면 보임)
3. **다중 노트, 다른 ordinal 핀**: 노트1 = 핀 1, 노트2 = 핀 3. 각각 독립적으로 자기 패널의 라이브 받음 (←← 핵심)
4. **다중 노트, 한 노트 종료**: 나머지 노트 영향 없음 (`ps aux | grep ssh` 1회 유지)
5. **모든 노트 종료**: ssh 즉시 cleanup (`ps aux | grep ssh` 0회)
6. **데스크탑 슬립 후 깨어남**: ssh stale → 노트들 에러 표시 → 새 노트 오픈 시 새 hub로 정상 동작
7. **핀 ordinal 무효**: 핀 3 상태에서 desktop이 패널 2개짜리 윈도우로 이동 → "패널 3번 없음 (현재 윈도우 패널 2개)" 노란 배너 → 패널 추가하면 자동 배너 해제 + 스트림 복귀
8. **두 노트 동시 image-paste**: 둘 다 같은 ControlMaster socket 경유로 전송 성공

- [ ] **Step 6: 최종 commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add bridge/src/spectatorSession.ts CLAUDE.md
git commit -m "refactor(spectator): SpectatorSession 클래스 삭제 + CLAUDE.md 갱신"
```

```json:metadata
{"files": ["bridge/src/spectatorSession.ts", "CLAUDE.md"], "verifyCommand": "cd bridge && npm test && cd ../app && npm test && npm run check", "acceptanceCriteria": ["SpectatorSession class removed", "Pure functions + Callbacks interface preserved", "no SpectatorSession references remain (grep)", "CLAUDE.md tomboy-terminal section updated", "all bridge tests pass", "all app tests pass + 0 typecheck errors", "manual scenario 1-8 all pass"]}
```

---

## Self-Review

Spec 대비 커버리지:
- ✅ 아키텍처 (Hub + Subscription 분리, registry Map, lifecycle) → T1
- ✅ 상태 캐싱 (paneStates, currentWindowPaneOrder, tmux 이벤트 핸들러) → T2
- ✅ Subscription follow-active + 시드 → T3
- ✅ Subscription pin/unpin + ordinal 재해석 + paneUnavailable → T4
- ✅ Hub desktop-mut 메서드 → T5
- ✅ WS 프로토콜 (subscribe-pane 신규 + pane-unavailable 신규) → T7 (클라) + T6 (서버)
- ✅ server.ts 통합 + imageTransfer controlPath → T6
- ✅ 클라이언트 사이드 정리 (pinDetached/reattach 제거, pinUnavailable 추가) → T8
- ✅ 옛 SpectatorSession 삭제 + CLAUDE.md → T9

엣지 케이스 모두 covered (paneUnavailable 처리 = T4 + T7 + T8; ssh.exit fan-out = T1; bootstrap 실패 = T1+T2; ControlMaster 공유 = T6).

타입 일관성: SpectatorCallbacks (T1에서 paneUnavailable 추가) 전반에 일관. `pinOrdinal` / `unpin` / `selectPane` / `tmuxNav` 시그니처 T4-T6-T8 사이 일관.

플레이스홀더 없음. 모든 step에 실제 code 또는 정확한 command.
