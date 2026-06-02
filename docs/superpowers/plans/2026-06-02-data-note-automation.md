# 데이터 노트 자동화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `자동화::<command-id>` 노트의 버튼을 누르면 브릿지를 거쳐 데스크탑 automation-service가 등록된 스크립트를 실행하고, `{프로젝트명: CSV}` 결과로 `DATA::<프로젝트명>` 노트의 CSV 블록을 자동 갱신(없으면 생성)하며 실행 내역을 자동화 노트에 기록한다.

**Architecture:** 기존 `claude://` 경로(앱→브릿지→데스크탑 spawn)와 footnote `claudeFill`(브릿지 결과를 `view.dispatch`로 노트에 써넣기)을 미러링한다. 데스크탑에 새 systemd --user 서비스(automation-service)를 추가하고, 브릿지에 비스트리밍 프록시 라우트(`ocr.ts` 패턴)를 더하며, 앱에 `lib/automation/` 모듈 + `lib/editor/automationNote/` 플러그인을 추가한다. 데이터 노트 갱신은 `noteManager`의 JSONContent 경로(`getNoteEditorContent`→splice→`updateNoteFromEditor`→`emitNoteReload`), 자동화 노트 로그는 라이브 `view.dispatch`.

**Tech Stack:** Node + Fastify(데스크탑 서비스, vitest), Node http(브릿지 프록시, `node --test`), SvelteKit + Svelte 5 runes + TipTap/ProseMirror(앱, vitest + @testing-library/svelte). 기존 브릿지 Bearer 토큰 체인 재사용.

**Spec deviation (확정):** automation-service는 컨테이너가 아니라 **systemd --user 서비스**로 호스트에서 직접 돌린다 — 호스트 `python3`/`git`을 호스트 git 저장소에 대해 실행하는 게 본질이라 컨테이너화는 brittle. (스펙 (A) 배포 절도 이에 맞게 수정됨.)

---

## File Structure

신규/수정 파일과 책임:

**데스크탑 서비스 (신규 패키지 `automation-service/`)**
- `automation-service/package.json`, `tsconfig.json` — 패키지 스캐폴드(claude-service 미러).
- `automation-service/src/auth.ts` — Bearer 추출 + 상수시간 비교(claude-service 복제).
- `automation-service/src/registry.ts` — `~/.config/tomboy-automation.json` 파싱/검증 + 명령 조회.
- `automation-service/src/runner.ts` — 명령 entry들을 `spawn`(셸 미경유)으로 실행, 타임아웃/출력 상한, `{results, errors}` 집계.
- `automation-service/src/server.ts` — Fastify `POST /run`(Bearer→registry→runner).
- `automation-service/tests/*.test.ts` — registry/runner/server vitest.
- `automation-service/deploy/automation-service.service` — systemd --user 유닛.
- `automation-service/deploy/README.md` — 빌드/설치/registry 작성 안내.

**브릿지 (수정)**
- `bridge/src/automation.ts` (신규) — `handleAutomationRun` 프록시(`ocr.ts` 복제).
- `bridge/src/automation.test.ts` (신규) — `node --test`.
- `bridge/src/server.ts` (수정) — 라우트 등록 + `AUTOMATION_SERVICE_URL` env.

**앱 (신규 `app/src/lib/automation/` + 플러그인 + 가이드)**
- `app/src/lib/automation/parseAutomationNote.ts` — 자동화 노트 감지 + commandId 추출.
- `app/src/lib/automation/runAutomation.ts` — 브릿지 `/automation/run` 클라이언트 + 에러 모델.
- `app/src/lib/automation/findDataBlockRegion.ts` — JSONContent에서 첫 csv/tsv 블록 인덱스 + `csvToParagraphs`.
- `app/src/lib/automation/applyDataNoteCsv.ts` — DATA:: 노트 찾기/생성 + CSV 블록 교체/추가 + 저장.
- `app/src/lib/automation/appendRunHistory.ts` — 자동화 노트 로그 리스트에 항목 prepend(라이브 view).
- `app/src/lib/editor/automationNote/automationNotePlugin.ts` — 버튼 위젯 데코레이션.
- `app/src/lib/editor/automationNote/runAutomationButtonClick.ts` — 클릭 오케스트레이션(runAutomation→applyDataNoteCsv→appendRunHistory+토스트).
- `app/src/lib/editor/TomboyEditor.svelte` (수정) — 플러그인 등록.
- `app/src/routes/settings/+page.svelte` (수정) — 가이드 카드.
- `app/tests/unit/automation/*.test.ts` — 앱 단위 테스트.

---

### Task 1: automation-service 스캐폴드 + registry 로더

**Goal:** 새 데스크탑 서비스 패키지를 만들고, registry 설정 파일을 파싱·검증·조회하는 순수 모듈을 구현한다.

**Files:**
- Create: `automation-service/package.json`
- Create: `automation-service/tsconfig.json`
- Create: `automation-service/src/auth.ts`
- Create: `automation-service/src/registry.ts`
- Test: `automation-service/tests/registry.test.ts`

**Acceptance Criteria:**
- [ ] `npm install` 후 `npm test`가 registry 테스트를 통과한다.
- [ ] 올바른 config는 `{commands}`로 파싱되고, `commands` 누락/엔트리 형식 오류는 명확한 에러를 던진다.
- [ ] `lookupCommand`가 등록된 id는 entry 배열을, 미등록 id는 null을 반환한다.

**Verify:** `cd automation-service && npm install && npm test` → registry 테스트 PASS

**Steps:**

- [ ] **Step 1: 패키지 스캐폴드 생성**

`automation-service/package.json`:
```json
{
  "name": "automation-service",
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

`automation-service/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false
  },
  "include": ["src/**/*"]
}
```

`automation-service/src/auth.ts` (claude-service/src/auth.ts 그대로 복제):
```ts
export function extractBearer(authHeader?: string): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : '';
}

export function verifyToken(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  if (secret.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 2: registry 테스트 작성 (실패 확인용)**

`automation-service/tests/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseRegistry, lookupCommand } from '../src/registry.js';

const VALID = JSON.stringify({
  commands: {
    'loc-history': [
      { project: 'tomboy', exec: ['python3', '/home/u/loc-history.py', '/repo', '--csv-only'] },
      { project: 'robotC', exec: ['python3', '/home/u/loc-history.py', '/repo2', '--csv-only'] }
    ]
  }
});

describe('parseRegistry', () => {
  it('parses a valid registry', () => {
    const reg = parseRegistry(VALID);
    expect(Object.keys(reg.commands)).toEqual(['loc-history']);
    expect(reg.commands['loc-history']).toHaveLength(2);
    expect(reg.commands['loc-history'][0]).toEqual({
      project: 'tomboy',
      exec: ['python3', '/home/u/loc-history.py', '/repo', '--csv-only']
    });
  });

  it('throws when commands key is missing', () => {
    expect(() => parseRegistry('{}')).toThrow(/commands/);
  });

  it('throws when an entry is missing project', () => {
    const bad = JSON.stringify({ commands: { x: [{ exec: ['ls'] }] } });
    expect(() => parseRegistry(bad)).toThrow(/project/);
  });

  it('throws when exec is empty or non-string', () => {
    const bad = JSON.stringify({ commands: { x: [{ project: 'p', exec: [] }] } });
    expect(() => parseRegistry(bad)).toThrow(/exec/);
  });
});

describe('lookupCommand', () => {
  it('returns entries for a known command and null for unknown', () => {
    const reg = parseRegistry(VALID);
    expect(lookupCommand(reg, 'loc-history')).toHaveLength(2);
    expect(lookupCommand(reg, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd automation-service && npm install && npm test`
Expected: FAIL — `Cannot find module '../src/registry.js'`

- [ ] **Step 4: registry.ts 구현**

`automation-service/src/registry.ts`:
```ts
import { readFileSync } from 'node:fs';

export interface CommandEntry {
  project: string;
  exec: string[];
}
export interface Registry {
  commands: Record<string, CommandEntry[]>;
}

export function parseRegistry(raw: string): Registry {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== 'object' || !('commands' in data)) {
    throw new Error('registry: missing "commands"');
  }
  const commandsIn = (data as { commands: unknown }).commands;
  if (!commandsIn || typeof commandsIn !== 'object') {
    throw new Error('registry: "commands" must be an object');
  }
  const commands: Record<string, CommandEntry[]> = {};
  for (const [id, entriesIn] of Object.entries(commandsIn as Record<string, unknown>)) {
    if (!Array.isArray(entriesIn)) {
      throw new Error(`registry: command "${id}" must be an array`);
    }
    commands[id] = entriesIn.map((e, i) => {
      const entry = e as { project?: unknown; exec?: unknown };
      if (typeof entry.project !== 'string' || !entry.project) {
        throw new Error(`registry: ${id}[${i}] missing project`);
      }
      if (
        !Array.isArray(entry.exec) ||
        entry.exec.length === 0 ||
        !entry.exec.every((x) => typeof x === 'string')
      ) {
        throw new Error(`registry: ${id}[${i}] exec must be a non-empty string[]`);
      }
      return { project: entry.project, exec: entry.exec as string[] };
    });
  }
  return { commands };
}

export function loadRegistry(path: string): Registry {
  return parseRegistry(readFileSync(path, 'utf8'));
}

export function lookupCommand(reg: Registry, command: string): CommandEntry[] | null {
  return Object.prototype.hasOwnProperty.call(reg.commands, command)
    ? reg.commands[command]
    : null;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd automation-service && npm test`
Expected: PASS (registry 5 tests)

- [ ] **Step 6: 커밋**

```bash
git add automation-service/package.json automation-service/tsconfig.json automation-service/src/auth.ts automation-service/src/registry.ts automation-service/tests/registry.test.ts
git commit -m "feat(automation-service): 스캐폴드 + registry 로더"
```

---

### Task 2: automation-service runner

**Goal:** 명령 entry 배열을 `spawn`(셸 미경유)으로 순차 실행하고, 타임아웃·출력 상한·종료코드를 처리해 `{results:{project:stdout}, errors:{project:msg}}`로 집계한다.

**Files:**
- Create: `automation-service/src/runner.ts`
- Test: `automation-service/tests/runner.test.ts`

**Acceptance Criteria:**
- [ ] 정상 종료(code 0) entry는 stdout이 `results[project]`에 들어간다.
- [ ] 비정상 종료/타임아웃/출력 초과 entry는 `errors[project]`에 들어가고, 다른 entry는 계속 처리된다.
- [ ] `spawn`은 인자 배열로 호출되어 셸을 거치지 않는다(주입된 fake spawn으로 검증).

**Verify:** `cd automation-service && npm test` → runner 테스트 PASS

**Steps:**

- [ ] **Step 1: runner 테스트 작성**

`automation-service/tests/runner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runEntries } from '../src/runner.js';
import type { CommandEntry } from '../src/registry.js';

// Fake child process: emits the configured stdout then closes with `code`.
function fakeChild(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable; stderr: Readable; kill: () => void;
  };
  child.stdout = Readable.from([Buffer.from(stdout, 'utf8')]);
  child.stderr = Readable.from([]);
  child.kill = () => {};
  // close after the stdout has been consumed on next tick
  setImmediate(() => child.emit('close', code));
  return child;
}

function fakeSpawn(map: Record<string, { stdout: string; code: number }>) {
  // key by the 3rd arg (repo path) so two entries differ
  return ((_cmd: string, args: string[]) => {
    const key = args[1] ?? '';
    const cfg = map[key] ?? { stdout: '', code: 0 };
    return fakeChild(cfg.stdout, cfg.code);
  }) as unknown as typeof import('node:child_process').spawn;
}

const ENTRIES: CommandEntry[] = [
  { project: 'tomboy', exec: ['python3', 'loc.py', '/repoA', '--csv-only'] },
  { project: 'robotC', exec: ['python3', 'loc.py', '/repoB', '--csv-only'] }
];

describe('runEntries', () => {
  it('collects stdout per project on success', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: 'a,b\n1,2\n', code: 0 }, '/repoB': { stdout: 'c\n3\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn });
    expect(out.results).toEqual({ tomboy: 'a,b\n1,2\n', robotC: 'c\n3\n' });
    expect(out.errors).toEqual({});
  });

  it('records errors for non-zero exit but keeps other projects', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: '', code: 1 }, '/repoB': { stdout: 'ok\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn });
    expect(out.results).toEqual({ robotC: 'ok\n' });
    expect(Object.keys(out.errors)).toEqual(['tomboy']);
  });

  it('errors a project whose output exceeds the size cap', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: 'x'.repeat(100), code: 0 }, '/repoB': { stdout: 'ok\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn, maxOutputBytes: 10 });
    expect(out.results).toEqual({ robotC: 'ok\n' });
    expect(out.errors.tomboy).toMatch(/너무 큽/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd automation-service && npm test`
Expected: FAIL — `Cannot find module '../src/runner.js'`

- [ ] **Step 3: runner.ts 구현**

`automation-service/src/runner.ts`:
```ts
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { CommandEntry } from './registry.js';

export type SpawnFn = typeof nodeSpawn;

export interface RunResult {
  results: Record<string, string>;
  errors: Record<string, string>;
}

export interface RunnerOpts {
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
  cwd?: string;
}

export async function runEntries(entries: CommandEntry[], opts: RunnerOpts = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 5 * 1024 * 1024;
  const spawn = opts.spawn ?? nodeSpawn;
  const cwd = opts.cwd ?? process.env.HOME;

  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const entry of entries) {
    try {
      results[entry.project] = await runOne(entry, { timeoutMs, maxOutputBytes, spawn, cwd });
    } catch (err) {
      errors[entry.project] = (err as Error).message;
    }
  }
  return { results, errors };
}

function runOne(
  entry: CommandEntry,
  o: { timeoutMs: number; maxOutputBytes: number; spawn: SpawnFn; cwd?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = entry.exec;
    const spawnOpts: SpawnOptions = { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = o.spawn(cmd, args, spawnOpts);
    let out = '';
    let errOut = '';
    let size = 0;
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('타임아웃'), o.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size > o.maxOutputBytes) { fail('출력이 너무 큽니다'); return; }
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => { errOut += d.toString('utf8'); });
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

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd automation-service && npm test`
Expected: PASS (registry + runner)

- [ ] **Step 5: 커밋**

```bash
git add automation-service/src/runner.ts automation-service/tests/runner.test.ts
git commit -m "feat(automation-service): spawn 러너(타임아웃/출력상한/부분실패 집계)"
```

---

### Task 3: automation-service 서버 + 배포 유닛

**Goal:** Fastify `POST /run`을 만들어 Bearer 인증 → registry 조회 → runner 실행을 연결하고, systemd --user 배포 유닛과 README를 작성한다.

**Files:**
- Create: `automation-service/src/server.ts`
- Test: `automation-service/tests/server.test.ts`
- Create: `automation-service/deploy/automation-service.service`
- Create: `automation-service/deploy/README.md`

**Acceptance Criteria:**
- [ ] Bearer 없음/오류 → 401. `command` 누락 → 400. 미등록 command → 400 `unknown_command`.
- [ ] 정상 → 200 `{results, errors}` (주입된 fake spawn으로 검증).
- [ ] 배포 유닛은 `node dist/server.js`를 호스트에서 실행하고 `~/.config/automation-service.env`를 읽는다.

**Verify:** `cd automation-service && npm test` → server 테스트 PASS

**Steps:**

- [ ] **Step 1: server 테스트 작성**

`automation-service/tests/server.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { buildServer } from '../src/server.js';
import { parseRegistry } from '../src/registry.js';

const TOKEN = 'shared-secret';
const REGISTRY = parseRegistry(
  JSON.stringify({ commands: { 'loc-history': [{ project: 'tomboy', exec: ['echo', 'x', '/repo'] }] } })
);

function fakeSpawn() {
  return ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
    child.stdout = Readable.from([Buffer.from('a,b\n1,2\n', 'utf8')]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

function app() {
  return buildServer({ sharedToken: TOKEN, registry: REGISTRY, runnerOpts: { spawn: fakeSpawn() } });
}

describe('POST /run', () => {
  it('401 without Bearer', async () => {
    const res = await app().inject({ method: 'POST', url: '/run', payload: { command: 'loc-history' } });
    expect(res.statusCode).toBe(401);
  });

  it('400 when command missing', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 unknown_command for unregistered id', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { command: 'nope' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_command');
  });

  it('200 with results on success', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { command: 'loc-history' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: { tomboy: 'a,b\n1,2\n' }, errors: {} });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd automation-service && npm test`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: server.ts 구현**

`automation-service/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { extractBearer, verifyToken } from './auth.js';
import { loadRegistry, lookupCommand, type Registry } from './registry.js';
import { runEntries, type RunnerOpts } from './runner.js';

const MAX_BYTES = Number(process.env.AUTOMATION_MAX_REQUEST_BYTES ?? 64 * 1024);

export interface BuildServerOpts {
  sharedToken: string;
  registry: Registry;
  runnerOpts?: RunnerOpts;
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: MAX_BYTES });

  app.post('/run', async (req, reply) => {
    const token = extractBearer(req.headers.authorization);
    if (!verifyToken(opts.sharedToken, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as { command?: unknown } | undefined;
    if (!body || typeof body.command !== 'string' || !body.command) {
      return reply.code(400).send({ error: 'bad_request', detail: 'command required' });
    }
    const entries = lookupCommand(opts.registry, body.command);
    if (!entries) {
      return reply.code(400).send({ error: 'unknown_command', detail: body.command });
    }
    const out = await runEntries(entries, opts.runnerOpts);
    return reply.code(200).send(out);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
  if (!sharedToken) { console.error('BRIDGE_SHARED_TOKEN is required'); process.exit(1); }
  const configPath = process.env.AUTOMATION_CONFIG ?? `${process.env.HOME}/.config/tomboy-automation.json`;
  const registry = loadRegistry(configPath);
  const runnerOpts: RunnerOpts = {
    timeoutMs: Number(process.env.AUTOMATION_TIMEOUT_MS ?? 30_000),
    maxOutputBytes: Number(process.env.AUTOMATION_MAX_OUTPUT_BYTES ?? 5 * 1024 * 1024)
  };
  const port = Number(process.env.AUTOMATION_SERVICE_PORT ?? 7843);
  const app = buildServer({ sharedToken, registry, runnerOpts });
  app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`automation-service on :${port}`));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd automation-service && npm test`
Expected: PASS (registry + runner + server)

- [ ] **Step 5: 배포 유닛 + README 작성**

`automation-service/deploy/automation-service.service`:
```ini
# tomboy-web automation-service — systemd --user unit (DESKTOP only).
# NOT a container: runs host node so it can spawn host python3/git against
# host git repos and ~/loc-history.py.
#
# Install (on the DESKTOP):
#   1. cd automation-service && npm install && npm run build
#   2. Create ~/.config/automation-service.env (see README).
#   3. Create ~/.config/tomboy-automation.json registry (see README).
#   4. cp deploy/automation-service.service ~/.config/systemd/user/
#   5. systemctl --user daemon-reload && systemctl --user enable --now automation-service
#   6. loginctl enable-linger $USER
#
# Listens on 0.0.0.0:7843 LAN ONLY. Bearer is the only auth; do not expose publicly.

[Unit]
Description=tomboy-web automation-service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/workspace/tomboy-web/automation-service
ExecStart=/usr/bin/node %h/workspace/tomboy-web/automation-service/dist/server.js
EnvironmentFile=%h/.config/automation-service.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`automation-service/deploy/README.md`:
```markdown
# automation-service deploy (desktop only)

브릿지(`/automation/run`)가 호출하는 데스크탑 서비스. 등록된 명령을 호스트에서
`spawn`으로 실행하고 `{results:{project:csv}, errors:{project:msg}}`를 반환한다.

## 빌드
    cd automation-service
    npm install
    npm run build   # → dist/server.js

## 환경파일 `~/.config/automation-service.env`
    BRIDGE_SHARED_TOKEN=<브릿지 BRIDGE_SECRET과 동일>
    AUTOMATION_SERVICE_PORT=7843
    AUTOMATION_CONFIG=%h/.config/tomboy-automation.json
    AUTOMATION_TIMEOUT_MS=30000
    AUTOMATION_MAX_OUTPUT_BYTES=5242880

## registry `~/.config/tomboy-automation.json`
    {
      "commands": {
        "loc-history": [
          { "project": "tomboy",
            "exec": ["python3", "/home/<you>/loc-history.py",
                     "/var/home/<you>/workspace/tomboy-web", "--csv-only", "--exclude", "graphify-out/"] }
        ]
      }
    }
`exec`는 셸을 거치지 않고 인자 배열로 실행된다. 경로/인자는 여기에만 존재(노트는 command id만 전달).

## 설치
    cp deploy/automation-service.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now automation-service
    loginctl enable-linger $USER

## 브릿지 연결
브릿지의 `~/.config/term-bridge.env`에:
    AUTOMATION_SERVICE_URL=http://<desktop-LAN-IP>:7843
```

- [ ] **Step 6: 커밋**

```bash
git add automation-service/src/server.ts automation-service/tests/server.test.ts automation-service/deploy/
git commit -m "feat(automation-service): Fastify /run + systemd 배포 유닛"
```

---

### Task 4: 브릿지 `/automation/run` 프록시

**Goal:** 브릿지에 비스트리밍 프록시 라우트를 추가해, 클라이언트 Bearer를 검증하고 `BRIDGE_SECRET` 재-Bearer로 automation-service에 포워딩한다.

**Files:**
- Create: `bridge/src/automation.ts`
- Test: `bridge/src/automation.test.ts`
- Modify: `bridge/src/server.ts` (import + 라우트 + env)

**Acceptance Criteria:**
- [ ] Bearer 없음/오류 → 401. 잘못된 JSON → 400. `command` 누락 → 400.
- [ ] `AUTOMATION_SERVICE_URL` 미설정 → 503 `automation_service_not_configured`.
- [ ] 정상 → `${url}/run`에 `Bearer ${SECRET}`로 포워딩, 업스트림 status/body 그대로 전달. 네트워크 오류 → 503 `automation_service_unavailable`.

**Verify:** `cd bridge && npm test` → automation 테스트 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`bridge/src/automation.test.ts`:
```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleAutomationRun } from './automation.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const URL_ = 'http://automation.test';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = headers;
  (r as { method: string }).method = 'POST';
  return r;
}

function mockRes() {
  const writes: string[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
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
  await handleAutomationRun(mockReq({}, { command: 'x' }), res, SECRET, URL_);
  assert.equal(get().status, 401);
});

test('400 on missing command (no upstream call)', async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  const { res, get } = mockRes();
  await handleAutomationRun(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET, URL_);
  assert.equal(get().status, 400);
  assert.equal(called, false);
});

test('503 when service url not configured', async () => {
  const { res, get } = mockRes();
  await handleAutomationRun(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { command: 'x' }), res, SECRET, '');
  assert.equal(get().status, 503);
  assert.match(get().body, /not_configured/);
});

test('forwards to upstream with re-Bearer and pipes response', async () => {
  let calledUrl = '', calledAuth = '', calledBody = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calledAuth = h['Authorization'] ?? '';
    calledBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify({ results: { tomboy: 'a\n1\n' }, errors: {} }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { res, get } = mockRes();
  await handleAutomationRun(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { command: 'loc-history' }), res, SECRET, URL_);
  assert.equal(get().status, 200);
  assert.equal(calledUrl, 'http://automation.test/run');
  assert.equal(calledAuth, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(calledBody), { command: 'loc-history' });
  assert.match(get().body, /tomboy/);
});

test('503 on upstream network error', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  const { res, get } = mockRes();
  await handleAutomationRun(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { command: 'x' }), res, SECRET, URL_);
  assert.equal(get().status, 503);
  assert.match(get().body, /unavailable/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd bridge && npm test`
Expected: FAIL — `Cannot find module './automation.js'`

- [ ] **Step 3: automation.ts 구현**

`bridge/src/automation.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface RunBody {
  command?: unknown;
}

/**
 * Proxy POST /automation/run → desktop automation-service.
 * Auth mirrors /ocr: client Bearer (minted by /login) verified here, then
 * re-Bearer with BRIDGE_SECRET (== service BRIDGE_SHARED_TOKEN) upstream.
 */
export async function handleAutomationRun(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  automationServiceUrl: string
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!verifyToken(secret, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!automationServiceUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'automation_service_not_configured' }));
    return;
  }
  let body: RunBody;
  try {
    body = (await readJson(req)) as RunBody;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_json' }));
    return;
  }
  const command = typeof body.command === 'string' ? body.command : '';
  if (!command) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_command' }));
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${automationServiceUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ command })
    });
  } catch (err) {
    console.warn(`[term-bridge automation] upstream error: ${(err as Error).message}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'automation_service_unavailable' }));
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json'
  });
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

- [ ] **Step 4: server.ts에 라우트 등록**

`bridge/src/server.ts` — import 블록에 추가(`import { handleClaudeChat } ...` 아래):
```ts
import { handleAutomationRun } from './automation.js';
```
env 선언에 추가(`const CLAUDE_SERVICE_URL = process.env.CLAUDE_SERVICE_URL ?? '';` 아래):
```ts
// Optional — bridge boots without it and returns 503.
const AUTOMATION_SERVICE_URL = process.env.AUTOMATION_SERVICE_URL ?? '';
```
라우트 등록(`/claude/chat` 블록 바로 뒤):
```ts
	if (url === '/automation/run' && req.method === 'POST') {
		await handleAutomationRun(req, res, SECRET, AUTOMATION_SERVICE_URL);
		return;
	}
```

- [ ] **Step 5: 테스트 통과 + 타입체크**

Run: `cd bridge && npm test`
Expected: PASS (automation 5 tests)
Run: `cd bridge && npm run build`
Expected: tsc 성공(에러 없음)

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/automation.ts bridge/src/automation.test.ts bridge/src/server.ts
git commit -m "feat(bridge): /automation/run 프록시 라우트"
```

---

### Task 5: 앱 — parseAutomationNote

**Goal:** 노트의 첫 줄(제목)이 `자동화::`로 시작하면 command id를 추출하는 순수 함수를 만든다.

**Files:**
- Create: `app/src/lib/automation/parseAutomationNote.ts`
- Test: `app/tests/unit/automation/parseAutomationNote.test.ts`

**Acceptance Criteria:**
- [ ] `자동화::loc-history` → `{ commandId: 'loc-history' }`.
- [ ] `자동화::loc-history 코드 갱신`(라벨 포함) → `{ commandId: 'loc-history' }`(첫 토큰).
- [ ] `DATA::x`/`자동화::`(빈 id)/일반 텍스트 → `null`.

**Verify:** `cd app && npm test -- automation/parseAutomationNote` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/automation/parseAutomationNote.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseAutomationNote, parseAutomationTitle } from '$lib/automation/parseAutomationNote.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('parseAutomationTitle', () => {
  it('extracts the command id', () => {
    expect(parseAutomationTitle('자동화::loc-history')).toBe('loc-history');
  });
  it('takes the first token when a label follows', () => {
    expect(parseAutomationTitle('자동화::loc-history 코드 갱신')).toBe('loc-history');
  });
  it('returns null for non-automation / empty id', () => {
    expect(parseAutomationTitle('DATA::tomboy')).toBeNull();
    expect(parseAutomationTitle('자동화::')).toBeNull();
    expect(parseAutomationTitle('그냥 노트')).toBeNull();
  });
});

describe('parseAutomationNote', () => {
  it('reads the first paragraph as the title', () => {
    expect(parseAutomationNote(doc(['자동화::loc-history', '', '- 로그']))).toEqual({ commandId: 'loc-history' });
  });
  it('returns null when the first line is not an automation title', () => {
    expect(parseAutomationNote(doc(['DATA::tomboy', '```csv']))).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/parseAutomationNote`
Expected: FAIL — cannot find module

- [ ] **Step 3: 구현**

`app/src/lib/automation/parseAutomationNote.ts`:
```ts
import type { JSONContent } from '@tiptap/core';

const PREFIX = '자동화::';

/** 제목 문자열에서 command id 추출. 자동화 노트가 아니거나 id가 비면 null. */
export function parseAutomationTitle(titleText: string): string | null {
  const text = titleText.trim();
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length).trim();
  if (!rest) return null;
  return rest.split(/\s+/)[0];
}

function paragraphText(node: JSONContent | undefined): string {
  if (!node?.content) return '';
  return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

export interface AutomationNoteSpec {
  commandId: string;
}

/** 노트 doc의 첫 단락(제목)을 보고 자동화 노트면 commandId 반환, 아니면 null. */
export function parseAutomationNote(doc: JSONContent): AutomationNoteSpec | null {
  const commandId = parseAutomationTitle(paragraphText(doc.content?.[0]));
  return commandId ? { commandId } : null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm test -- automation/parseAutomationNote`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/automation/parseAutomationNote.ts app/tests/unit/automation/parseAutomationNote.test.ts
git commit -m "feat(automation): 자동화 노트 제목 파서"
```

---

### Task 6: 앱 — runAutomation 클라이언트

**Goal:** 브릿지 `/automation/run`을 호출해 `{results, errors}`를 받고, 상태코드를 에러 종류로 매핑하는 클라이언트를 만든다.

**Files:**
- Create: `app/src/lib/automation/runAutomation.ts`
- Test: `app/tests/unit/automation/runAutomation.test.ts`

**Acceptance Criteria:**
- [ ] 브릿지/토큰 미설정 → `AutomationError('not_configured')`.
- [ ] 200 → `{results, errors}` 반환.
- [ ] 401→unauthorized, 503→service_unavailable, 400 `unknown_command`→unknown_command, 그 외 ≥500→upstream_error.

**Verify:** `cd app && npm test -- automation/runAutomation` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/automation/runAutomation.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
  getDefaultTerminalBridge: vi.fn(),
  getTerminalBridgeToken: vi.fn(),
  bridgeToHttpBase: (b: string) => `https://${b.replace(/^wss?:\/\//, '')}`
}));

import { runAutomation, AutomationError } from '$lib/automation/runAutomation.js';
import { getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  (getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://host/ws');
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});
afterEach(() => { globalThis.fetch = realFetch; vi.clearAllMocks(); });

it('throws not_configured when bridge or token missing', async () => {
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
});

it('returns results+errors on 200', async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ results: { tomboy: 'a\n1\n' }, errors: { robotC: '타임아웃' } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )) as typeof fetch;
  const out = await runAutomation({ command: 'loc-history' });
  expect(out).toEqual({ results: { tomboy: 'a\n1\n' }, errors: { robotC: '타임아웃' } });
});

it('maps 401 to unauthorized', async () => {
  globalThis.fetch = (async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'unauthorized' });
});

it('maps 400 unknown_command', async () => {
  globalThis.fetch = (async () => new Response('{"error":"unknown_command"}', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'unknown_command' });
});

it('maps 503 to service_unavailable', async () => {
  globalThis.fetch = (async () => new Response('{"error":"automation_service_unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'service_unavailable' });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/runAutomation`
Expected: FAIL — cannot find module

- [ ] **Step 3: 구현**

`app/src/lib/automation/runAutomation.ts`:
```ts
import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken,
  bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type AutomationErrorKind =
  | 'not_configured'
  | 'unauthorized'
  | 'service_unavailable'
  | 'unknown_command'
  | 'bad_request'
  | 'upstream_error'
  | 'network';

export class AutomationError extends Error {
  constructor(public kind: AutomationErrorKind, public detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}

export interface AutomationResult {
  results: Record<string, string>;
  errors: Record<string, string>;
}

const STATUS_TO_KIND: Record<number, AutomationErrorKind> = {
  401: 'unauthorized',
  503: 'service_unavailable'
};

export async function runAutomation(opts: {
  command: string;
  signal?: AbortSignal;
}): Promise<AutomationResult> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) {
    throw new AutomationError('not_configured', '브릿지 설정이 필요합니다');
  }
  const url = `${bridgeToHttpBase(bridge)}/automation/run`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: opts.command }),
      signal: opts.signal
    });
  } catch (err) {
    throw new AutomationError('network', (err as Error).message);
  }

  if (!res.ok) {
    let bodyErr = '';
    try {
      const j = (await res.json()) as { error?: string };
      bodyErr = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    if (res.status === 400 && bodyErr === 'unknown_command') {
      throw new AutomationError('unknown_command', bodyErr);
    }
    const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
    throw new AutomationError(kind, bodyErr || undefined);
  }

  const data = (await res.json()) as Partial<AutomationResult>;
  return { results: data.results ?? {}, errors: data.errors ?? {} };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm test -- automation/runAutomation`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/automation/runAutomation.ts app/tests/unit/automation/runAutomation.test.ts
git commit -m "feat(automation): 브릿지 /automation/run 클라이언트"
```

---

### Task 7: 앱 — findDataBlockRegion + csvToParagraphs

**Goal:** 노트 JSONContent에서 첫 csv/tsv 코드펜스 블록의 열기/닫기 단락 인덱스를 찾고, CSV 문자열을 단락 노드 배열로 변환하는 순수 함수를 만든다.

**Files:**
- Create: `app/src/lib/automation/findDataBlockRegion.ts`
- Test: `app/tests/unit/automation/findDataBlockRegion.test.ts`

**Acceptance Criteria:**
- [ ] csv/tsv 블록이 있으면 `{openIdx, closeIdx, format}` 반환.
- [ ] 열렸지만 닫히지 않음 / 블록 없음 → `null`.
- [ ] `csvToParagraphs('a,b\n1,2\n')` → 단락 2개(빈 줄은 빈 단락).

**Verify:** `cd app && npm test -- automation/findDataBlockRegion` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/automation/findDataBlockRegion.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { findDataBlockRegion, csvToParagraphs } from '$lib/automation/findDataBlockRegion.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('findDataBlockRegion', () => {
  it('finds the first csv block', () => {
    const d = doc(['DATA::x', '', '```csv', 'a,b', '1,2', '```']);
    expect(findDataBlockRegion(d)).toEqual({ openIdx: 2, closeIdx: 5, format: 'csv' });
  });
  it('finds a tsv block', () => {
    const d = doc(['```tsv', 'a\tb', '```']);
    expect(findDataBlockRegion(d)).toEqual({ openIdx: 0, closeIdx: 2, format: 'tsv' });
  });
  it('returns null when unclosed', () => {
    expect(findDataBlockRegion(doc(['```csv', 'a,b']))).toBeNull();
  });
  it('returns null when no block', () => {
    expect(findDataBlockRegion(doc(['DATA::x', '본문']))).toBeNull();
  });
});

describe('csvToParagraphs', () => {
  it('splits lines into paragraphs, trimming trailing newline', () => {
    expect(csvToParagraphs('a,b\n1,2\n')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a,b' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '1,2' }] }
    ]);
  });
  it('emits an empty paragraph for blank lines', () => {
    expect(csvToParagraphs('a\n\nb')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }
    ]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/findDataBlockRegion`
Expected: FAIL — cannot find module

- [ ] **Step 3: 구현**

`app/src/lib/automation/findDataBlockRegion.ts`:
```ts
import type { JSONContent } from '@tiptap/core';
import { detectFenceFormat, isFenceClose, type TableFormat } from '$lib/editor/tableBlock/parseTable.js';

function paragraphText(node: JSONContent | undefined): string {
  if (!node?.content) return '';
  return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

export interface DataBlockRegion {
  openIdx: number;
  closeIdx: number;
  format: TableFormat;
}

/** 노트 doc.content에서 첫 csv/tsv 펜스 블록의 인덱스. 없거나 안 닫혔으면 null. */
export function findDataBlockRegion(doc: JSONContent): DataBlockRegion | null {
  const nodes = doc.content ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const fmt = detectFenceFormat(paragraphText(nodes[i]));
    if (!fmt) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (isFenceClose(paragraphText(nodes[j]))) {
        return { openIdx: i, closeIdx: j, format: fmt };
      }
    }
    return null; // opened but never closed
  }
  return null;
}

/** CSV 문자열을 단락 노드 배열로(한 줄 = 한 단락, 끝 개행 제거). */
export function csvToParagraphs(csv: string): JSONContent[] {
  return csv
    .replace(/\n$/, '')
    .split('\n')
    .map((line) =>
      line === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm test -- automation/findDataBlockRegion`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/automation/findDataBlockRegion.ts app/tests/unit/automation/findDataBlockRegion.test.ts
git commit -m "feat(automation): 데이터 블록 위치 탐색 + csv→단락 변환"
```

---

### Task 8: 앱 — applyDataNoteCsv

**Goal:** `DATA::<project>` 노트를 찾아(없으면 생성) CSV 블록을 교체(없으면 추가)하고 저장한 뒤 reload를 알린다. blockedBy: Task 7.

**Files:**
- Create: `app/src/lib/automation/applyDataNoteCsv.ts`
- Test: `app/tests/unit/automation/applyDataNoteCsv.test.ts`

**Acceptance Criteria:**
- [ ] 기존 DATA:: 노트의 첫 csv 블록 본문이 새 CSV로 교체되고 `'updated'` 반환.
- [ ] 노트가 없으면 `createNote('DATA::'+project)` 후 CSV 블록 추가 + `'created'` 반환.
- [ ] csv 블록이 없는 노트는 제목 아래에 새 ```` ```csv ```` 블록이 추가된다(`buildUpdatedDoc` 순수 함수로 검증).

**Verify:** `cd app && npm test -- automation/applyDataNoteCsv` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/automation/applyDataNoteCsv.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { JSONContent } from '@tiptap/core';
import { buildUpdatedDoc, applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { createNote, findNoteByTitle, getNoteEditorContent } from '$lib/core/noteManager.js';
import { parseDataNote } from '$lib/chart/parseDataNote.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('buildUpdatedDoc', () => {
  it('replaces the body of an existing csv block', () => {
    const d = doc(['DATA::x', '```csv', 'old', '```']);
    const out = buildUpdatedDoc(d, 'a,b\n1,2\n');
    const texts = (out.content ?? []).map((p) => (p.content?.[0] as { text?: string })?.text ?? '');
    expect(texts).toEqual(['DATA::x', '```csv', 'a,b', '1,2', '```']);
  });
  it('appends a new csv block after the title when none exists', () => {
    const d = doc(['DATA::x']);
    const out = buildUpdatedDoc(d, 'a\n1\n');
    const texts = (out.content ?? []).map((p) => (p.content?.[0] as { text?: string })?.text ?? '');
    expect(texts).toEqual(['DATA::x', '```csv', 'a', '1', '```']);
  });
});

describe('applyDataNoteCsv', () => {
  beforeEach(async () => {
    // fresh fake-indexeddb per test
    indexedDB = new IDBFactory();
  });

  it('creates a DATA:: note when missing', async () => {
    const outcome = await applyDataNoteCsv('tomboy', 'a,b\n1,2\n');
    expect(outcome).toBe('created');
    const note = await findNoteByTitle('DATA::tomboy');
    expect(note).toBeTruthy();
    const tables = parseDataNote(getNoteEditorContent(note!));
    expect(tables[0].columns).toEqual(['a', 'b']);
    expect(tables[0].rows).toEqual([['1', '2']]);
  });

  it('updates an existing DATA:: note in place', async () => {
    await createNote('DATA::tomboy');
    await applyDataNoteCsv('tomboy', 'x\n9\n'); // first run adds block
    const outcome = await applyDataNoteCsv('tomboy', 'a,b\n1,2\n'); // second replaces
    expect(outcome).toBe('updated');
    const note = await findNoteByTitle('DATA::tomboy');
    const tables = parseDataNote(getNoteEditorContent(note!));
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([['1', '2']]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/applyDataNoteCsv`
Expected: FAIL — cannot find module

- [ ] **Step 3: 구현**

`app/src/lib/automation/applyDataNoteCsv.ts`:
```ts
import type { JSONContent } from '@tiptap/core';
import {
  findNoteByTitle,
  createNote,
  getNoteEditorContent,
  updateNoteFromEditor
} from '$lib/core/noteManager.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import { findDataBlockRegion, csvToParagraphs } from './findDataBlockRegion.js';

export type ApplyOutcome = 'updated' | 'created';

const DATA_PREFIX = 'DATA::';

/** 노트 doc의 첫 csv 블록 본문을 새 CSV로 교체. 블록이 없으면 제목 아래에 새 블록 추가. */
export function buildUpdatedDoc(doc: JSONContent, csv: string): JSONContent {
  const content = [...(doc.content ?? [])];
  const region = findDataBlockRegion(doc);
  const body = csvToParagraphs(csv);
  if (region) {
    content.splice(region.openIdx + 1, region.closeIdx - region.openIdx - 1, ...body);
  } else {
    const fence: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '```csv' }] };
    const close: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '```' }] };
    const insertAt = content.length > 0 ? 1 : 0; // after the title line
    content.splice(insertAt, 0, fence, ...body, close);
  }
  return { ...doc, content };
}

/** DATA::<project> 노트를 찾아(없으면 생성) CSV 블록을 갱신하고 저장. */
export async function applyDataNoteCsv(project: string, csv: string): Promise<ApplyOutcome> {
  const title = DATA_PREFIX + project;
  let note = await findNoteByTitle(title);
  let outcome: ApplyOutcome = 'updated';
  if (!note) {
    note = await createNote(title);
    outcome = 'created';
  }
  const newDoc = buildUpdatedDoc(getNoteEditorContent(note), csv);
  await updateNoteFromEditor(note.guid, newDoc);
  // Open editors (mobile/core via bus; desktop windows via session) drop stale
  // in-memory docs and reload — mirrors the rename-cascade cross-window pattern.
  await emitNoteReload([note.guid]);
  await desktopSession.reloadWindows([note.guid]);
  return outcome;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm test -- automation/applyDataNoteCsv`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/automation/applyDataNoteCsv.ts app/tests/unit/automation/applyDataNoteCsv.test.ts
git commit -m "feat(automation): DATA:: 노트 CSV 블록 갱신/생성"
```

---

### Task 9: 앱 — appendRunHistory

**Goal:** 자동화 노트(열린 에디터)의 로그 리스트 맨 앞에 실행 항목을 추가하고, 없으면 제목 아래에 리스트를 만들며, 최근 N개로 제한하는 함수를 라이브 `view.dispatch`로 구현한다.

**Files:**
- Create: `app/src/lib/automation/appendRunHistory.ts`
- Test: `app/tests/unit/automation/appendRunHistory.test.ts`

**Acceptance Criteria:**
- [ ] 리스트가 없는 노트 → 제목 아래 bulletList 생성 + 항목 1개.
- [ ] 기존 리스트 → 새 항목이 맨 앞(최신)에 prepend.
- [ ] 항목이 cap 초과 시 가장 오래된 것이 잘려 정확히 cap개 유지.

**Verify:** `cd app && npm test -- automation/appendRunHistory` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

`app/tests/unit/automation/appendRunHistory.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import type { JSONContent } from '@tiptap/core';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });

function makeEditor(content: JSONContent): Editor {
  ed = new Editor({
    extensions: [
      StarterKit.configure({ paragraph: false, listItem: false }),
      TomboyParagraph,
      TomboyListItem
    ],
    content
  });
  return ed;
}

/** Collect the first-paragraph text of each listItem in the first bulletList. */
function logTexts(doc: JSONContent): string[] {
  const list = (doc.content ?? []).find((n) => n.type === 'bulletList');
  if (!list) return [];
  return (list.content ?? []).map((li) => {
    const p = (li.content ?? []).find((c) => c.type === 'paragraph');
    return (p?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
  });
}

const titleOnly: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '자동화::loc-history' }] }] };

function withList(items: string[]): JSONContent {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '자동화::loc-history' }] },
      {
        type: 'bulletList',
        content: items.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }))
      }
    ]
  };
}

describe('appendRunHistory', () => {
  it('creates a list when none exists', () => {
    const editor = makeEditor(titleOnly);
    appendRunHistory(editor.view, 'E1');
    expect(logTexts(editor.getJSON())).toEqual(['E1']);
  });

  it('prepends newest first', () => {
    const editor = makeEditor(withList(['old1', 'old2']));
    appendRunHistory(editor.view, 'NEW');
    expect(logTexts(editor.getJSON())).toEqual(['NEW', 'old1', 'old2']);
  });

  it('caps to N items, dropping the oldest', () => {
    const editor = makeEditor(withList(['a', 'b', 'c']));
    appendRunHistory(editor.view, 'NEW', 3);
    expect(logTexts(editor.getJSON())).toEqual(['NEW', 'a', 'b']);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/appendRunHistory`
Expected: FAIL — cannot find module

- [ ] **Step 3: 구현**

`app/src/lib/automation/appendRunHistory.ts`:
```ts
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

const DEFAULT_CAP = 50;

/**
 * 자동화 노트(열린 에디터)의 로그 리스트 맨 앞에 entry를 추가한다.
 * - 첫 top-level bulletList를 로그로 본다. 없으면 제목(첫 단락) 아래에 생성.
 * - 항목 수를 cap으로 제한(오래된 것부터 제거). claudeFill처럼 라이브 dispatch.
 */
export function appendRunHistory(view: EditorView, entry: string, cap = DEFAULT_CAP): void {
  if (view.isDestroyed) return;
  const { state } = view;
  const { schema, doc } = state;
  const bulletList = schema.nodes.bulletList;
  const listItem = schema.nodes.listItem;
  const paragraph = schema.nodes.paragraph;
  if (!bulletList || !listItem || !paragraph) return;

  const para = paragraph.create(null, entry ? schema.text(entry) : null);
  const item = listItem.create(null, para);

  let listPos = -1;
  let listSize = 0;
  let listAttrs: Record<string, unknown> | null = null;
  const listChildren: PMNode[] = [];
  doc.forEach((node, offset) => {
    if (listPos === -1 && node.type.name === 'bulletList') {
      listPos = offset;
      listSize = node.nodeSize;
      listAttrs = node.attrs;
      node.forEach((c) => listChildren.push(c));
    }
  });

  const tr = state.tr;
  if (listPos !== -1) {
    const items = [item, ...listChildren].slice(0, cap);
    tr.replaceWith(listPos, listPos + listSize, bulletList.create(listAttrs, items));
  } else {
    const first = doc.firstChild;
    const insertPos = first ? first.nodeSize : 0;
    tr.insert(insertPos, bulletList.create(null, item));
  }
  view.dispatch(tr);
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm test -- automation/appendRunHistory`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/automation/appendRunHistory.ts app/tests/unit/automation/appendRunHistory.test.ts
git commit -m "feat(automation): 실행 내역 로그 prepend(+cap)"
```

---

### Task 10: 앱 — 자동화 노트 플러그인 + 클릭 오케스트레이션 + 등록

**Goal:** 자동화 노트 제목 아래에 `⟳ 실행` 버튼을 위젯으로 렌더하고, 클릭 시 runAutomation → 각 결과 applyDataNoteCsv → appendRunHistory + 토스트를 수행하는 오케스트레이션을 붙인 뒤 에디터에 등록한다. blockedBy: Task 5, 6, 8, 9.

**Files:**
- Create: `app/src/lib/editor/automationNote/runAutomationButtonClick.ts`
- Create: `app/src/lib/editor/automationNote/automationNotePlugin.ts`
- Test: `app/tests/unit/automation/runAutomationButtonClick.test.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import + Extension 등록)

**Acceptance Criteria:**
- [ ] runAutomation 성공 시 results 각 항목이 applyDataNoteCsv로 적용되고, 요약 항목이 로그에 추가된다.
- [ ] runAutomation 실패(AutomationError) 시 에러 토스트 + `실패: …` 로그 항목.
- [ ] `errors`가 있는 부분 실패는 토스트와 로그 요약에 반영되고, 성공분은 그대로 적용된다.
- [ ] 자동화 노트를 열면 제목 아래 `⟳ 실행` 버튼이 보인다(플러그인 등록).

**Verify:** `cd app && npm test -- automation/runAutomationButtonClick` → PASS, 그리고 `cd app && npm run check`(svelte-check) 통과.

**Steps:**

- [ ] **Step 1: 오케스트레이션 테스트 작성**

`app/tests/unit/automation/runAutomationButtonClick.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/automation/runAutomation.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/automation/runAutomation.js')>(
    '$lib/automation/runAutomation.js'
  );
  return { ...actual, runAutomation: vi.fn() };
});
vi.mock('$lib/automation/applyDataNoteCsv.js', () => ({ applyDataNoteCsv: vi.fn() }));
vi.mock('$lib/automation/appendRunHistory.js', () => ({ appendRunHistory: vi.fn() }));
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

import { runAutomationButtonClick } from '$lib/editor/automationNote/runAutomationButtonClick.js';
import { runAutomation, AutomationError } from '$lib/automation/runAutomation.js';
import { applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';
import { pushToast } from '$lib/stores/toast.js';

const view = { isDestroyed: false } as never; // appendRunHistory is mocked, view unused
const m = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('runAutomationButtonClick', () => {
  it('applies each result and logs a summary on success', async () => {
    m(runAutomation).mockResolvedValue({ results: { tomboy: 'csvA', robotC: 'csvB' }, errors: {} });
    m(applyDataNoteCsv).mockResolvedValueOnce('updated').mockResolvedValueOnce('created');
    await runAutomationButtonClick(view, 'loc-history');
    expect(m(applyDataNoteCsv).mock.calls.map((c) => c[0])).toEqual(['tomboy', 'robotC']);
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/DATA::robotC 생성/);
    expect(logged).toMatch(/tomboy 갱신/);
    expect(pushToast).toHaveBeenCalled();
  });

  it('on AutomationError shows error toast and logs 실패', async () => {
    m(runAutomation).mockRejectedValue(new AutomationError('service_unavailable'));
    await runAutomationButtonClick(view, 'loc-history');
    expect(applyDataNoteCsv).not.toHaveBeenCalled();
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/실패/);
    expect(m(pushToast).mock.calls[0][1]).toMatchObject({ kind: 'error' });
  });

  it('reflects per-project errors in the summary', async () => {
    m(runAutomation).mockResolvedValue({ results: { tomboy: 'csvA' }, errors: { robotC: '타임아웃' } });
    m(applyDataNoteCsv).mockResolvedValue('updated');
    await runAutomationButtonClick(view, 'loc-history');
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/tomboy 갱신/);
    expect(logged).toMatch(/robotC 실패\(타임아웃\)/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm test -- automation/runAutomationButtonClick`
Expected: FAIL — cannot find module

- [ ] **Step 3: 오케스트레이션 구현**

`app/src/lib/editor/automationNote/runAutomationButtonClick.ts`:
```ts
import type { EditorView } from '@tiptap/pm/view';
import { runAutomation, AutomationError, type AutomationErrorKind } from '$lib/automation/runAutomation.js';
import { applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';
import { pushToast } from '$lib/stores/toast.js';

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const KIND_MESSAGES: Record<AutomationErrorKind, string> = {
  not_configured: '브릿지 설정이 필요합니다',
  network: '자동화 서비스에 연결할 수 없습니다',
  service_unavailable: '자동화 서비스에 연결할 수 없습니다',
  unauthorized: '브릿지 인증이 필요합니다',
  unknown_command: '등록되지 않은 명령입니다',
  bad_request: '요청이 거부되었습니다',
  upstream_error: '자동화 서비스 오류'
};

/** ⟳ 실행 버튼 클릭 처리: 자동화 실행 → DATA:: 노트 갱신 → 로그/토스트. */
export async function runAutomationButtonClick(view: EditorView, commandId: string): Promise<void> {
  let res: { results: Record<string, string>; errors: Record<string, string> };
  try {
    res = await runAutomation({ command: commandId });
  } catch (err) {
    const kind: AutomationErrorKind = err instanceof AutomationError ? err.kind : 'network';
    const msg = KIND_MESSAGES[kind] ?? '자동화 실패';
    pushToast(msg, { kind: 'error' });
    appendRunHistory(view, `${nowStamp()} — 실패: ${msg}`);
    return;
  }

  const updated: string[] = [];
  const created: string[] = [];
  const failed: string[] = [];
  for (const [project, csv] of Object.entries(res.results)) {
    try {
      const outcome = await applyDataNoteCsv(project, csv);
      (outcome === 'created' ? created : updated).push(project);
    } catch {
      failed.push(`${project}(저장 실패)`);
    }
  }
  for (const [project, message] of Object.entries(res.errors)) {
    failed.push(`${project} 실패(${message})`);
  }

  const parts: string[] = [];
  if (created.length) parts.push(`${created.map((p) => `DATA::${p}`).join(', ')} 생성`);
  if (updated.length) parts.push(`${updated.join(', ')} 갱신`);
  if (failed.length) parts.push(failed.join(', '));
  const summary = parts.join(', ') || '변경 없음';

  appendRunHistory(view, `${nowStamp()} — ${summary}`);

  const allFailed = failed.length > 0 && created.length === 0 && updated.length === 0;
  pushToast(summary, { kind: allFailed ? 'error' : 'info' });
}
```

- [ ] **Step 4: 오케스트레이션 통과 확인**

Run: `cd app && npm test -- automation/runAutomationButtonClick`
Expected: PASS

- [ ] **Step 5: 플러그인 구현**

`app/src/lib/editor/automationNote/automationNotePlugin.ts`:
```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseAutomationTitle } from '$lib/automation/parseAutomationNote.js';
import { runAutomationButtonClick } from './runAutomationButtonClick.js';

export const automationNotePluginKey = new PluginKey<DecorationSet>('tomboyAutomationNote');

function renderButton(view: EditorView, commandId: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tomboy-automation-run';
  btn.contentEditable = 'false';
  btn.textContent = '⟳ 실행';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⟳ 실행 중…';
    try {
      await runAutomationButtonClick(view, commandId);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const first = doc.firstChild;
  const commandId = parseAutomationTitle(first?.textContent ?? '');
  if (!first || !commandId) return DecorationSet.empty;
  // Anchor just inside the end of the title paragraph (mirrors chartBlock).
  const headerEndPos = first.nodeSize - 1;
  const widget = Decoration.widget(headerEndPos, (view) => renderButton(view, commandId), {
    side: 1,
    key: `automation:${commandId}`
  });
  return DecorationSet.create(doc, [widget]);
}

export function createAutomationNotePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: automationNotePluginKey,
    state: {
      init(_, { doc }): DecorationSet {
        return buildDecorations(doc);
      },
      apply(tr, old): DecorationSet {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildDecorations(tr.doc);
      }
    },
    props: {
      decorations(state): DecorationSet | undefined {
        return automationNotePluginKey.getState(state);
      }
    }
  });
}
```

- [ ] **Step 6: TomboyEditor.svelte에 등록**

`app/src/lib/editor/TomboyEditor.svelte` — import 추가(다른 plugin import 근처, line ~40):
```ts
import { createAutomationNotePlugin } from "./automationNote/automationNotePlugin.js";
```
`tomboyChartBlock` Extension 바로 뒤에 추가(line ~464):
```ts
				Extension.create({
					name: "tomboyAutomationNote",
					addProseMirrorPlugins() {
						return [createAutomationNotePlugin()];
					},
				}),
```

- [ ] **Step 7: 타입체크 + 전체 테스트**

Run: `cd app && npm run check`
Expected: svelte-check 0 errors
Run: `cd app && npm test -- automation/`
Expected: 모든 automation 테스트 PASS

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/editor/automationNote/ app/tests/unit/automation/runAutomationButtonClick.test.ts app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(automation): 자동화 노트 실행 버튼 플러그인 + 오케스트레이션"
```

---

### Task 11: 가이드 카드

**Goal:** 설정 → 가이드(notes 서브탭)에 자동화 노트 사용법 카드를 추가한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] notes 서브탭에 `자동화::` 노트를 설명하는 `<details class="guide-card">`가 DATA:: 차트 카드 근처에 추가된다.
- [ ] 예시(`자동화::loc-history`), 동작(버튼→DATA:: 갱신/생성, 로그 누적), 선행조건(브릿지 + 데스크탑 automation-service registry)을 담는다.

**Verify:** `cd app && npm run check` 통과 + `npm run dev`로 설정 → 가이드 → 노트 탭에서 카드 육안 확인.

**Steps:**

- [ ] **Step 1: 기존 DATA:: 차트 가이드 카드 위치 확인**

Run: `grep -n "DATA::\|guide-card\|guideSubTab" app/src/routes/settings/+page.svelte | head`
Expected: notes 서브탭의 `DATA::` 차트 카드(`<details class="guide-card">`) 위치 파악.

- [ ] **Step 2: 자동화 카드 추가**

`app/src/routes/settings/+page.svelte` — notes 서브탭의 DATA:: 차트 카드 바로 뒤에 삽입:
```svelte
<details class="guide-card">
  <summary>자동화 노트 (자동화::)</summary>
  <p class="info-text">
    제목이 <code>자동화::&lt;명령&gt;</code> 인 노트는 「⟳ 실행」 버튼을 띄웁니다. 누르면
    데스크탑에 등록된 스크립트가 실행되고, 결과(<code>{`{프로젝트명: CSV}`}</code>)로
    <code>DATA::&lt;프로젝트명&gt;</code> 노트의 CSV 블록이 갱신됩니다(없으면 생성). 실행 내역은
    이 노트에 리스트로 쌓입니다.
  </p>
  <pre class="snippet">자동화::loc-history

⟳ 실행

- 2026-06-02 15:30 — tomboy·robotC 갱신
- 2026-06-01 09:12 — tomboy 갱신, robotC 실패(타임아웃)</pre>
  <ul class="guide-list">
    <li>실행할 스크립트·경로는 <strong>데스크탑 automation-service의 registry</strong>(<code>~/.config/tomboy-automation.json</code>)에만 정의됩니다. 노트는 명령 id만 보냅니다.</li>
    <li>선행조건: 터미널 브릿지 설정 + 데스크탑 automation-service 실행(자세히는 <code>automation-service/deploy/README.md</code>).</li>
    <li>결과의 각 프로젝트명마다 <code>DATA::</code> 노트를 찾아 갱신하므로, 한 번에 여러 데이터 노트를 갱신할 수 있습니다.</li>
  </ul>
</details>
```

- [ ] **Step 3: 타입체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 4: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(automation): 설정 가이드에 자동화 노트 카드 추가"
```

---

## Self-Review

- **Spec coverage:** (A)automation-service→T1-3, (B)bridge proxy→T4, (C)parseAutomationNote/runAutomation/findDataBlockRegion/applyDataNoteCsv/appendRunHistory→T5-9, (D)automationNote 플러그인→T10, (E)가이드→T11. 보안(registry-only exec, spawn 인자배열, Bearer 체인)→T1-4. 에러처리/로그 형식→T6,T10. 노트 없으면 생성→T8. 팬아웃→T10. 모두 태스크 보유.
- **Placeholder scan:** 모든 step에 실제 코드/명령/예상출력 포함. TBD/“적절히” 없음.
- **Type consistency:** `CommandEntry{project,exec}`(T1)→runner/server(T2,3) 일치. `AutomationResult{results,errors}`(T6)=서비스 응답(T3)=브릿지 패스스루(T4)=오케스트레이션 소비(T10) 일치. `ApplyOutcome 'updated'|'created'`(T8)→오케스트레이션(T10) 일치. `parseAutomationTitle`(T5)→플러그인(T10) 재사용. `findDataBlockRegion`/`csvToParagraphs`(T7)→`buildUpdatedDoc`(T8) 일치.
