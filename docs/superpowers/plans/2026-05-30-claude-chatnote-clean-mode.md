# Claude 채팅 노트 클린 모드 + 설정 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude://` 채팅 노트가 Claude Code의 코딩 에이전트 하네스를 항상 벗고(시스템 프롬프트 교체 + 도구 off + 머신별 섹션 제거 + effort 명시) 동작하도록 바꾸고, 기본값(시스템 프롬프트/모델/effort)을 설정 Claude 탭에서 코드 수정 없이 변경할 수 있게 한다.

**Architecture:** 값은 `설정(Claude 탭) → appSettings(IDB) → 자동 헤더(노트) → 요청 바디 → claude-service 런너` 로 흐른다. 우선순위는 **노트 헤더(명시값) > 설정 기본값 > 런너 하드코드 안전망**. 런너는 항상 `--system-prompt`/`--exclude-dynamic-system-prompt-sections`/`--disallowedTools '*'`/`--effort` 를 넘긴다. `cwd`/`allowedTools`(도구 게이트)는 제거한다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror 플러그인, IndexedDB(`idb`), Node + Fastify(claude-service), Node + ws(bridge), vitest(app·claude-service) / `node --test`(bridge).

**Spec:** `docs/superpowers/specs/2026-05-30-claude-chatnote-clean-mode-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `app/src/lib/chatNote/defaults.ts` | 시그니처/헤더 정규식·키·기본값·effort 검증 | 수정 |
| `app/src/lib/chatNote/parseChatNote.ts` | 노트 → `ChatNoteSpec` 파싱 | 수정 |
| `app/src/lib/storage/appSettings.ts` | IDB 설정 접근자 | 수정 |
| `app/src/lib/chatNote/backends/claude.ts` | `ClaudeChatBody` 타입 + SSE 클라이언트 | 수정 |
| `app/src/lib/editor/chatNote/ChatSendBar.svelte` | 전송 시 바디 구성 + 설정 폴백 | 수정 |
| `app/src/lib/editor/chatNote/chatNotePlugin.ts` | 시그니처 입력 시 헤더 자동 작성 | 재작성 |
| `app/src/lib/editor/TomboyEditor.svelte` | 플러그인에 설정 클로저 주입 | 수정 |
| `app/src/routes/settings/+page.svelte` | 설정 UI(Claude 탭 추가) | 수정 |
| `claude-service/src/runner.ts` | `claude -p` spawn 인자 구성 | 수정 |
| `claude-service/src/server.ts` | `/chat` 요청 검증/로그 | 수정 |
| `bridge/src/claude.ts` | `/claude/chat` 프록시 바디 타입 | 수정(타입만) |
| `CLAUDE.md` | 채팅 노트 불변식 문서 | 수정 |

테스트: `app/tests/unit/chatNote/parseChatNote.test.ts`, `app/tests/unit/editor/chatNotePlugin.test.ts`, `claude-service/tests/runner.test.ts`.

---

### Task 1: 채팅 노트 헤더 스키마 (effort 추가, cwd/allowedTools 제거)

**Goal:** claude 헤더를 `system`/`model`/`effort` 로 바꾸고, effort 검증·기본값 상수를 추가하고, 파서가 effort를 읽고 cwd/allowedTools를 무시하도록 한다.

**Files:**
- Modify: `app/src/lib/chatNote/defaults.ts:41-51` (헤더 정규식/키) + 파일 끝(상수 추가)
- Modify: `app/src/lib/chatNote/parseChatNote.ts:23-34` (`ChatNoteSpec.options`), `:153-170` (claude 분기), `:1-8` (import)
- Test: `app/tests/unit/chatNote/parseChatNote.test.ts`

**Acceptance Criteria:**
- [ ] `CLAUDE_HEADER_KEY_RE` 가 `^(system|model|effort):` 이고 `cwd`/`allowedTools` 를 매칭하지 않는다
- [ ] `effort: xhigh` 헤더가 `spec.options.effort === 'xhigh'` 로 파싱된다
- [ ] 잘못된 effort(`effort: bogus`)는 `spec.options.effort` 를 설정하지 않는다
- [ ] `cwd:`/`allowedTools:` 줄이 있어도 `spec.options` 에 cwd/allowedTools 키가 없다
- [ ] `CLAUDE_HEADER_DEFAULTS` + `CLAUDE_VALID_EFFORTS` + `normalizeEffort` 가 export 된다

**Verify:** `cd app && npm run test -- tests/unit/chatNote/parseChatNote.test.ts` → PASS, 그리고 `npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/chatNote/parseChatNote.test.ts` 에 추가 (기존 파일 끝, 마지막 `});` 앞 또는 새 describe 블록):

```ts
import { normalizeEffort, CLAUDE_HEADER_DEFAULTS } from '$lib/chatNote/defaults.js';

describe('parseChatNote — claude effort/clean headers', () => {
	function claudeDoc(headerLines: string[]) {
		return {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'claude://' }] },
				...headerLines.map((l) => ({
					type: 'paragraph',
					content: [{ type: 'text', text: l }]
				})),
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: 안녕' }] }
			]
		};
	}

	it('parses a valid effort header', () => {
		const spec = parseChatNote(claudeDoc(['effort: xhigh']));
		expect(spec?.options.effort).toBe('xhigh');
	});

	it('ignores an invalid effort header', () => {
		const spec = parseChatNote(claudeDoc(['effort: bogus']));
		expect(spec?.options.effort).toBeUndefined();
	});

	it('ignores legacy cwd / allowedTools headers (clean mode)', () => {
		const spec = parseChatNote(claudeDoc(['cwd: /tmp', 'allowedTools: Read,Bash']));
		expect(spec).not.toBeNull();
		expect('cwd' in (spec!.options as object)).toBe(false);
		expect('allowedTools' in (spec!.options as object)).toBe(false);
	});

	it('parses system + model + effort together', () => {
		const spec = parseChatNote(
			claudeDoc(['system: 번역기', 'model: opus', 'effort: high'])
		);
		expect(spec?.system).toBe('번역기');
		expect(spec?.model).toBe('opus');
		expect(spec?.options.effort).toBe('high');
	});

	it('normalizeEffort falls back to high', () => {
		expect(normalizeEffort('max')).toBe('max');
		expect(normalizeEffort('nonsense')).toBe('high');
		expect(normalizeEffort(undefined)).toBe('high');
		expect(CLAUDE_HEADER_DEFAULTS.effort).toBe('high');
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- tests/unit/chatNote/parseChatNote.test.ts`
Expected: FAIL (`normalizeEffort` / `CLAUDE_HEADER_DEFAULTS` 미존재, effort 미파싱)

- [ ] **Step 3: `defaults.ts` 수정** — `app/src/lib/chatNote/defaults.ts` 의 `41-51` 블록을 아래로 교체:

```ts
export const CLAUDE_HEADER_KEY_RE =
	/^(system|model|effort):\s*(.*)$/;

export const CLAUDE_RECOGNIZED_HEADER_KEYS = [
	'system',
	'model',
	'effort'
] as const;

export type ClaudeHeaderKey = (typeof CLAUDE_RECOGNIZED_HEADER_KEYS)[number];

/** Valid Claude reasoning effort levels (Opus 4.8 / 4.7 surface). */
export const CLAUDE_VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_VALID_EFFORTS)[number];

/** Return value if it is a valid effort level, else 'high'. */
export function normalizeEffort(value: string | undefined | null): ClaudeEffort {
	return (CLAUDE_VALID_EFFORTS as readonly string[]).includes(value ?? '')
		? (value as ClaudeEffort)
		: 'high';
}

/**
 * Hardcoded fallback for the claude backend. The user-editable source of
 * truth is 설정 → Claude (appSettings); these apply only before settings
 * load or when a setting is unset. `system` is intentionally minimal — the
 * coding-agent default prompt is ALWAYS replaced, so this is the whole persona.
 */
export const CLAUDE_HEADER_DEFAULTS = {
	system: '당신은 사용자를 돕는 어시스턴트입니다.',
	model: 'opus',
	effort: 'high' as ClaudeEffort
} as const;
```

- [ ] **Step 4: `parseChatNote.ts` import 추가** — `app/src/lib/chatNote/parseChatNote.ts:1-8` 의 import 블록에 `CLAUDE_VALID_EFFORTS` 추가:

```ts
import {
	CHAT_SIGNATURE_RE,
	OLLAMA_HEADER_KEY_RE,
	CLAUDE_HEADER_KEY_RE,
	CLAUDE_VALID_EFFORTS,
	type OllamaHeaderKey,
	type ClaudeHeaderKey
} from './defaults.js';
```

- [ ] **Step 5: `ChatNoteSpec.options` 수정** — `parseChatNote.ts:31-34` 의 claude-specific 주석/필드를 교체:

```ts
		// claude-specific
		effort?: string;
```

(즉 `cwd?: string;` 과 `allowedTools?: string[];` 두 줄을 위 한 줄로 대체)

- [ ] **Step 6: claude 파싱 분기 수정** — `parseChatNote.ts:153-170` 의 `else { // claude backend ... }` 블록을 교체:

```ts
		} else {
			// claude backend
			const key = currentKey as ClaudeHeaderKey;
			if (key === 'system') {
				result.system = value;
			} else if (key === 'model') {
				const trimmed = value.trim();
				if (trimmed !== '') result.model = trimmed;
			} else if (key === 'effort') {
				const trimmed = value.trim().toLowerCase();
				if ((CLAUDE_VALID_EFFORTS as readonly string[]).includes(trimmed)) {
					result.options.effort = trimmed;
				}
			}
		}
```

- [ ] **Step 7: 통과 확인**

Run: `cd app && npm run test -- tests/unit/chatNote/parseChatNote.test.ts`
Expected: PASS (신규 + 기존 테스트 모두)

- [ ] **Step 8: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors (cwd/allowedTools 참조처는 Task 5·6에서 정리 — 이 시점엔 backends/claude.ts·ChatSendBar.svelte가 아직 옛 필드를 참조하므로 **check는 Task 5 이후에 통과**. 이 태스크에서는 `tests/unit/chatNote/parseChatNote.test.ts` 통과만 확인하고 커밋)

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/chatNote/defaults.ts app/src/lib/chatNote/parseChatNote.ts app/tests/unit/chatNote/parseChatNote.test.ts
git commit -m "feat(chatNote): claude 헤더에 effort 추가, cwd/allowedTools 제거

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: appSettings — Claude 기본값 접근자

**Goal:** `claudeDefaultSystem`/`claudeDefaultModel`/`claudeDefaultEffort` 세 키의 get/set 접근자를 추가한다(`imageStorageToken` 패턴). 기본값은 `CLAUDE_HEADER_DEFAULTS` 단일 출처에서 가져온다.

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts` (파일 끝에 섹션 추가)
- Test: `app/tests/unit/storage/appSettingsClaude.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `getClaudeDefaultSystem()` 미설정 시 `'당신은 사용자를 돕는 어시스턴트입니다.'` 반환
- [ ] `getClaudeDefaultModel()` 미설정/빈값 시 `'opus'` 반환
- [ ] `getClaudeDefaultEffort()` 미설정/잘못된 값 시 `'high'`, 유효값은 그대로 반환
- [ ] set→get 라운드트립이 동작한다

**Verify:** `cd app && npm run test -- tests/unit/storage/appSettingsClaude.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/storage/appSettingsClaude.test.ts` 신규:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	getClaudeDefaultSystem,
	setClaudeDefaultSystem,
	getClaudeDefaultModel,
	setClaudeDefaultModel,
	getClaudeDefaultEffort,
	setClaudeDefaultEffort
} from '$lib/storage/appSettings.js';

describe('appSettings — claude defaults', () => {
	it('returns minimal default system when unset', async () => {
		expect(await getClaudeDefaultSystem()).toBe('당신은 사용자를 돕는 어시스턴트입니다.');
	});

	it('returns opus model default when unset', async () => {
		expect(await getClaudeDefaultModel()).toBe('opus');
	});

	it('returns high effort default when unset', async () => {
		expect(await getClaudeDefaultEffort()).toBe('high');
	});

	it('round-trips system + model', async () => {
		await setClaudeDefaultSystem('번역기 페르소나');
		await setClaudeDefaultModel('claude-opus-4-8');
		expect(await getClaudeDefaultSystem()).toBe('번역기 페르소나');
		expect(await getClaudeDefaultModel()).toBe('claude-opus-4-8');
	});

	it('rejects invalid effort, accepts valid', async () => {
		await setClaudeDefaultEffort('nonsense');
		expect(await getClaudeDefaultEffort()).toBe('high');
		await setClaudeDefaultEffort('max');
		expect(await getClaudeDefaultEffort()).toBe('max');
	});

	it('falls back to opus when model set to blank', async () => {
		await setClaudeDefaultModel('   ');
		expect(await getClaudeDefaultModel()).toBe('opus');
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- tests/unit/storage/appSettingsClaude.test.ts`
Expected: FAIL (접근자 미존재)

- [ ] **Step 3: 접근자 추가** — `app/src/lib/storage/appSettings.ts` 파일 끝에 추가. 먼저 상단 import 영역 첫 줄(`import { getDB } from './db.js';`) 아래에 추가:

```ts
import {
	CLAUDE_HEADER_DEFAULTS,
	CLAUDE_VALID_EFFORTS
} from '../chatNote/defaults.js';
```

그리고 파일 끝에:

```ts
// ── Claude chat-note default settings ─────────────────────────────────
//
// Injected into the auto-written header of new claude:// notes and used as
// the send-time fallback when a note omits a field. User-editable in
// 설정 → Claude. Single source of truth for the fallback values is
// CLAUDE_HEADER_DEFAULTS in chatNote/defaults.ts.

const CLAUDE_DEFAULT_SYSTEM = 'claudeDefaultSystem';
const CLAUDE_DEFAULT_MODEL = 'claudeDefaultModel';
const CLAUDE_DEFAULT_EFFORT = 'claudeDefaultEffort';

export async function getClaudeDefaultSystem(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_SYSTEM);
	return typeof v === 'string' ? v : CLAUDE_HEADER_DEFAULTS.system;
}

export async function setClaudeDefaultSystem(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_SYSTEM, value);
}

export async function getClaudeDefaultModel(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_MODEL);
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : CLAUDE_HEADER_DEFAULTS.model;
}

export async function setClaudeDefaultModel(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_MODEL, value);
}

export async function getClaudeDefaultEffort(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_EFFORT);
	return (CLAUDE_VALID_EFFORTS as readonly string[]).includes(v ?? '')
		? (v as string)
		: CLAUDE_HEADER_DEFAULTS.effort;
}

export async function setClaudeDefaultEffort(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_EFFORT, value);
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm run test -- tests/unit/storage/appSettingsClaude.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/storage/appSettings.ts app/tests/unit/storage/appSettingsClaude.test.ts
git commit -m "feat(appSettings): Claude 기본값(system/model/effort) 접근자

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: claude-service 런너 클린 모드

**Goal:** 런너가 `cwd`/`allowedTools` 분기와 `--append-system-prompt` 를 버리고, 항상 `--system-prompt`(없으면 기본)/`--exclude-dynamic-system-prompt-sections`/`--disallowedTools '*'`/`--effort`(없으면 high) 를 넘기도록 한다. spawn cwd는 항상 HOME. 서버의 cwd 검증/로그도 정리한다.

**Files:**
- Modify: `claude-service/src/runner.ts:23-29` (RunRequest), `:51-70` (args + spawn), 상단(상수)
- Modify: `claude-service/src/server.ts:36-40` (cwd 검증 제거), `:48` (로그)
- Test: `claude-service/tests/runner.test.ts:12-47` (교체)

**Acceptance Criteria:**
- [ ] args에 항상 `--system-prompt` 가 있고 값은 `req.system` 또는 기본 프롬프트
- [ ] args에 항상 `--exclude-dynamic-system-prompt-sections` 와 `--disallowedTools *` 가 있다
- [ ] args에 `--effort` 가 있고 `req.effort` 반영, 없거나 잘못되면 `high`
- [ ] args에 `--append-system-prompt`/`--allowedTools` 가 없다
- [ ] `ANTHROPIC_API_KEY=''` 유지, spawn cwd = `process.env.HOME`

**Verify:** `cd claude-service && npm run test -- tests/runner.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트로 교체** — `claude-service/tests/runner.test.ts:12-47` 의 세 테스트(`passes --disallowedTools * when no cwd`, `omits --disallowedTools when cwd present`, `passes --allowedTools when cwd + allowedTools`)를 아래로 교체:

```ts
  it('always passes --disallowedTools * (tools always off)', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    const i = fake.lastCall!.args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(fake.lastCall!.args[i + 1]).toBe('*');
    expect(fake.lastCall!.args).not.toContain('--allowedTools');
  });

  it('always replaces system prompt with --system-prompt (not --append)', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [], system: '번역기' },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    expect(fake.lastCall!.args).not.toContain('--append-system-prompt');
    const i = fake.lastCall!.args.indexOf('--system-prompt');
    expect(fake.lastCall!.args[i + 1]).toBe('번역기');
  });

  it('falls back to default system prompt when none given', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    const i = fake.lastCall!.args.indexOf('--system-prompt');
    expect(fake.lastCall!.args[i + 1]).toBe('당신은 사용자를 돕는 어시스턴트입니다.');
  });

  it('always passes --exclude-dynamic-system-prompt-sections', () => {
    const fake = makeFakeSpawn();
    void runClaude({ messages: [] }, new AbortController().signal, { spawn: fake.spawn });
    expect(fake.lastCall!.args).toContain('--exclude-dynamic-system-prompt-sections');
  });

  it('passes --effort from request', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [], effort: 'xhigh' },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    const i = fake.lastCall!.args.indexOf('--effort');
    expect(fake.lastCall!.args[i + 1]).toBe('xhigh');
  });

  it('defaults --effort to high when absent or invalid', () => {
    const fakeA = makeFakeSpawn();
    void runClaude({ messages: [] }, new AbortController().signal, { spawn: fakeA.spawn });
    const ia = fakeA.lastCall!.args.indexOf('--effort');
    expect(fakeA.lastCall!.args[ia + 1]).toBe('high');

    const fakeB = makeFakeSpawn();
    void runClaude({ messages: [], effort: 'bogus' }, new AbortController().signal, { spawn: fakeB.spawn });
    const ib = fakeB.lastCall!.args.indexOf('--effort');
    expect(fakeB.lastCall!.args[ib + 1]).toBe('high');
  });

  it('spawns with cwd = HOME', () => {
    const fake = makeFakeSpawn();
    void runClaude({ messages: [] }, new AbortController().signal, { spawn: fake.spawn });
    expect(fake.lastCall!.cwd).toBe(process.env.HOME ?? '');
  });
```

> 참고: `makeFakeSpawn` 은 spawn 옵션의 cwd를 `lastCall.cwd` 로 직접 캡처한다(`_fakes.ts:44`). `process.env.HOME` 미설정 환경 대비 `?? ''` 를 둔다.

- [ ] **Step 2: 실패 확인**

Run: `cd claude-service && npm run test -- tests/runner.test.ts`
Expected: FAIL (옛 동작)

- [ ] **Step 3: `runner.ts` RunRequest 수정** — `claude-service/src/runner.ts:23-29` 교체:

```ts
export interface RunRequest {
  messages: AnthropicMessage[];
  model?: string;
  system?: string;
  effort?: string;
}
```

- [ ] **Step 4: 상수 추가** — `runner.ts` 상단(예: `export interface RunRequest` 위)에:

```ts
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_SYSTEM = '당신은 사용자를 돕는 어시스턴트입니다.';

function normalizeEffort(v?: string): string {
  return v && VALID_EFFORTS.includes(v) ? v : 'high';
}
```

- [ ] **Step 5: args + spawn 수정** — `runner.ts:58-70` 교체:

```ts
  if (req.model) args.push('--model', req.model);
  args.push('--system-prompt', req.system || DEFAULT_SYSTEM);
  args.push('--exclude-dynamic-system-prompt-sections');
  args.push('--disallowedTools', '*');
  args.push('--effort', normalizeEffort(req.effort));

  const child = spawn('claude', args, {
    cwd: process.env.HOME,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
```

- [ ] **Step 6: `server.ts` cwd 검증 제거** — `claude-service/src/server.ts:36-40` 의 블록 삭제:

```ts
    if (body.cwd) {
      if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
        return reply.code(400).send({ error: 'bad_request', detail: 'cwd not a directory' });
      }
    }
```

→ 삭제. 더 이상 쓰지 않는 import 정리: `server.ts:2` 의 `import { existsSync, statSync } from 'node:fs';` 도 삭제.

- [ ] **Step 7: `server.ts` 로그에서 cwd 제거** — `server.ts:47-50` 의 로그 객체에서 `cwd: body.cwd ?? null` 을 `effort: body.effort ?? null` 로 교체:

```ts
    req.log.info(
      { messages: body.messages.length, shape, model: body.model, effort: body.effort ?? null },
      'chat request',
    );
```

- [ ] **Step 8: 통과 확인**

Run: `cd claude-service && npm run test`
Expected: PASS (runner + server + imageInline 전부)

- [ ] **Step 9: 빌드 확인**

Run: `cd claude-service && npm run build`
Expected: tsc 0 errors

- [ ] **Step 10: 커밋**

```bash
git add claude-service/src/runner.ts claude-service/src/server.ts claude-service/tests/runner.test.ts
git commit -m "feat(claude-service): 항상 클린 모드 — system-prompt 교체 + effort + 도구 off

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: bridge `/claude/chat` 프록시 바디 타입 정리

**Goal:** bridge 프록시의 `ClaudeBody` 인터페이스에서 `cwd`/`allowedTools` 를 제거하고 `effort` 를 추가한다. 바디는 그대로 포워딩되므로 동작 변화는 없고 타입 정합성만 맞춘다.

**Files:**
- Modify: `bridge/src/claude.ts:4-10` (ClaudeBody)

**Acceptance Criteria:**
- [ ] `ClaudeBody` 에 `cwd`/`allowedTools` 가 없고 `effort?: unknown` 이 있다
- [ ] `bridge/src/claude.test.ts` 가 그대로 통과한다(동작 무변)

**Verify:** `cd bridge && node --import tsx --test src/claude.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 인터페이스 수정** — `bridge/src/claude.ts:4-10` 교체:

```ts
interface ClaudeBody {
	messages?: unknown;
	model?: unknown;
	system?: unknown;
	effort?: unknown;
}
```

- [ ] **Step 2: 테스트 통과 확인 (동작 무변)**

Run: `cd bridge && node --import tsx --test src/claude.test.ts`
Expected: PASS (메시지 포워딩 검증 등 기존 테스트 그대로)

- [ ] **Step 3: 커밋**

```bash
git add bridge/src/claude.ts
git commit -m "refactor(bridge): claude 프록시 바디 타입 effort로 정리

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Claude 백엔드 바디 + ChatSendBar 전송 폴백

**Goal:** `ClaudeChatBody` 에서 cwd/allowedTools를 제거하고 effort를 추가하고, `ChatSendBar.runClaude` 가 노트 헤더에 없는 값은 설정 기본값으로 폴백해 바디를 구성하도록 한다.

**Files:**
- Modify: `app/src/lib/chatNote/backends/claude.ts:23-29` (ClaudeChatBody)
- Modify: `app/src/lib/editor/chatNote/ChatSendBar.svelte:230-236` (바디 구성), import 영역
- Test: `app/tests/unit/chatNote/sendClaude.test.ts` (필요 시 body 필드 갱신)

**Acceptance Criteria:**
- [ ] `ClaudeChatBody` 에 `cwd`/`allowedTools` 가 없고 `effort?: string` 이 있다
- [ ] `runClaude` 바디가 `effort` 를 포함하고, `spec.options.effort` 없으면 `getClaudeDefaultEffort()` 값을 쓴다
- [ ] system/model도 동일하게 헤더값 우선, 없으면 설정 기본값 폴백
- [ ] `npm run check` 0 errors (Task 1의 타입 변경이 여기서 정합)

**Verify:** `cd app && npm run check` → 0 errors, `npm run test -- tests/unit/chatNote/sendClaude.test.ts` → PASS

**Steps:**

- [ ] **Step 1: `ClaudeChatBody` 수정** — `app/src/lib/chatNote/backends/claude.ts:23-29` 교체:

```ts
export interface ClaudeChatBody {
  messages: AnthropicMessage[];
  model?: string;
  system?: string;
  effort?: string;
}
```

- [ ] **Step 2: ChatSendBar import 추가** — `ChatSendBar.svelte` 의 `<script>` import 영역에 추가:

```ts
import {
	getClaudeDefaultSystem,
	getClaudeDefaultModel,
	getClaudeDefaultEffort
} from '$lib/storage/appSettings.js';
```

- [ ] **Step 3: `runClaude` 바디 구성 교체** — `ChatSendBar.svelte:230-236` 의 `const body: ClaudeChatBody = {...}` 를 교체:

```ts
		const system = spec.system ?? (await getClaudeDefaultSystem());
		const model = spec.model || (await getClaudeDefaultModel());
		const effort = spec.options.effort ?? (await getClaudeDefaultEffort());
		const body: ClaudeChatBody = {
			messages,
			model: model || undefined,
			system,
			effort
		};
```

- [ ] **Step 4: sendClaude 테스트 점검** — `app/tests/unit/chatNote/sendClaude.test.ts` 가 `cwd`/`allowedTools` 를 바디로 단언하면 effort로 교체하거나 해당 단언 제거. (sendClaude 자체는 바디를 그대로 직렬화하므로 보통 영향 없음 — 실패 시에만 수정)

Run: `cd app && npm run test -- tests/unit/chatNote/sendClaude.test.ts`
Expected: PASS (필요 시 Step에서 수정 후)

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/chatNote/backends/claude.ts app/src/lib/editor/chatNote/ChatSendBar.svelte app/tests/unit/chatNote/sendClaude.test.ts
git commit -m "feat(chatNote): claude 전송 시 effort 포함 + 설정 기본값 폴백

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 자동 헤더 플러그인 (claude 지원) + TomboyEditor 연동

**Goal:** `chatNotePlugin` 을 `CHAT_SIGNATURE_RE` 기반으로 재작성해 backend를 구분하고, claude 시그니처 입력 시 `system`/`model`/`effort` 헤더를 설정 기본값으로 미리 채워 넣는다. `TomboyEditor` 가 설정을 로드해 클로저로 주입한다.

**Files:**
- Rewrite: `app/src/lib/editor/chatNote/chatNotePlugin.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte:220` 부근(상태), `:338` 부근(onMount 로드), `:446-451`(플러그인 생성), import 영역
- Test: `app/tests/unit/editor/chatNotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `llm://` 입력 시 기존처럼 system/temperature/num_ctx + 빈 줄 + `Q:` 삽입(회귀 없음)
- [ ] `claude://` 입력 시 `system: <기본>`/`model: <기본>`/`effort: <기본>` + 빈 줄 + `Q:` 삽입
- [ ] 클로저로 받은 claude 기본값이 헤더 값에 반영된다
- [ ] 이미 헤더가 있으면 재삽입하지 않는다(기존 동작 유지)

**Verify:** `cd app && npm run test -- tests/unit/editor/chatNotePlugin.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/chatNotePlugin.test.ts` 에, 테스트 에디터가 claude 기본값을 주입하도록 `createTestEditor` 를 옵션 받게 수정하고 claude 케이스 추가. 파일 상단 `createTestEditor` 를 교체:

```ts
function createTestEditor(claudeDefaults?: () => { system: string; model: string; effort: string }): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ undoRedo: false }),
			Extension.create({
				name: 'llmNoteExt',
				addProseMirrorPlugins() {
					return [createChatNotePlugin({ claudeDefaults })];
				}
			})
		],
		content: ''
	});
	return editor;
}
```

그리고 describe 블록 안에 추가:

```ts
	it('inserts claude headers (system/model/effort) with injected defaults', () => {
		const editor = createTestEditor(() => ({
			system: '번역기',
			model: 'opus',
			effort: 'xhigh'
		}));
		editor.commands.setContent('');
		editor.commands.insertContent('claude://');
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: 번역기');
		expect(paras).toContain('model: opus');
		expect(paras).toContain('effort: xhigh');
		expect(paras[paras.length - 1]).toBe('Q: ');
		const qIndex = paras.lastIndexOf('Q: ');
		expect(paras[qIndex - 1]).toBe('');
		editor.destroy();
	});

	it('falls back to hardcoded claude defaults when no closure given', () => {
		const editor = createTestEditor();
		editor.commands.setContent('');
		editor.commands.insertContent('claude://');
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: 당신은 사용자를 돕는 어시스턴트입니다.');
		expect(paras).toContain('model: opus');
		expect(paras).toContain('effort: high');
		editor.destroy();
	});
```

> 기존 ollama 테스트의 `createTestEditor()` 호출은 인자 없이 그대로 동작한다(옵션이 optional).

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- tests/unit/editor/chatNotePlugin.test.ts`
Expected: FAIL (claude 미지원 + `createChatNotePlugin` 인자 미지원)

- [ ] **Step 3: 플러그인 재작성** — `app/src/lib/editor/chatNote/chatNotePlugin.ts` 전체를 교체:

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
	CHAT_SIGNATURE_RE,
	LLM_HEADER_DEFAULTS,
	OLLAMA_RECOGNIZED_HEADER_KEYS,
	CLAUDE_RECOGNIZED_HEADER_KEYS,
	CLAUDE_HEADER_DEFAULTS,
	type ChatBackend
} from '$lib/chatNote/defaults.js';

export const chatNotePluginKey = new PluginKey<undefined>('llmNote');

export interface ClaudeAutoDefaults {
	system: string;
	model: string;
	effort: string;
}

export interface ChatNotePluginOptions {
	/** Read at scaffold time so 설정 changes apply without re-creating the plugin. */
	claudeDefaults?: () => ClaudeAutoDefaults;
}

interface SignatureLocation {
	paragraphIndex: number;
	backend: ChatBackend;
}

function backendOf(capture: string): ChatBackend {
	return capture === 'claude' ? 'claude' : 'ollama';
}

/** Find the signature line position + backend in the doc. Null if absent. */
function findSignature(doc: PMNode): SignatureLocation | null {
	if (doc.childCount === 0) return null;

	if (doc.childCount > 1) {
		const c1FirstLine = doc.child(1).textContent.split('\n')[0] ?? '';
		const m1 = CHAT_SIGNATURE_RE.exec(c1FirstLine);
		if (m1) return { paragraphIndex: 1, backend: backendOf(m1[1]) };
	}
	const c0FirstLine = doc.child(0).textContent.split('\n')[0] ?? '';
	const m0 = CHAT_SIGNATURE_RE.exec(c0FirstLine);
	if (m0) return { paragraphIndex: 0, backend: backendOf(m0[1]) };

	return null;
}

function headerKeyLineRe(backend: ChatBackend): RegExp {
	const keys =
		backend === 'claude' ? CLAUDE_RECOGNIZED_HEADER_KEYS : OLLAMA_RECOGNIZED_HEADER_KEYS;
	return new RegExp(`^(${keys.join('|')}):`);
}

function countRecognizedHeaderKeys(doc: PMNode, sigIndex: number, re: RegExp): number {
	let count = 0;
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			if (re.test(line)) count++;
		}
	}
	return count;
}

function existingHeaderKeysInDoc(doc: PMNode, sigIndex: number, re: RegExp): Set<string> {
	const out = new Set<string>();
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			const m = re.exec(line);
			if (m) out.add(m[1]);
		}
	}
	return out;
}

function buildOllamaParagraphs(schema: Schema, existing: Set<string>): PMNode[] {
	const paras: PMNode[] = [];
	if (!existing.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text('system: ')));
	}
	if (!existing.has('temperature')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`temperature: ${LLM_HEADER_DEFAULTS.temperature}`)
			)
		);
	}
	if (!existing.has('num_ctx')) {
		paras.push(
			schema.nodes.paragraph.create(null, schema.text(`num_ctx: ${LLM_HEADER_DEFAULTS.num_ctx}`))
		);
	}
	paras.push(schema.nodes.paragraph.create()); // blank boundary
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

function buildClaudeParagraphs(
	schema: Schema,
	existing: Set<string>,
	defaults: ClaudeAutoDefaults
): PMNode[] {
	const paras: PMNode[] = [];
	if (!existing.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`system: ${defaults.system}`)));
	}
	if (!existing.has('model')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`model: ${defaults.model}`)));
	}
	if (!existing.has('effort')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`effort: ${defaults.effort}`)));
	}
	paras.push(schema.nodes.paragraph.create()); // blank boundary
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

export function createChatNotePlugin(options: ChatNotePluginOptions = {}): Plugin {
	const getClaudeDefaults = options.claudeDefaults ?? (() => ({ ...CLAUDE_HEADER_DEFAULTS }));

	return new Plugin({
		key: chatNotePluginKey,
		appendTransaction(trs, oldState, newState) {
			const rescan = trs.some((tr) => tr.getMeta(chatNotePluginKey)?.rescan === true);
			const docChanged = trs.some((tr) => tr.docChanged);
			if (!rescan && !docChanged) return null;

			const { doc, schema } = newState;
			const sig = findSignature(doc);
			if (!sig) return null;

			const keyRe = headerKeyLineRe(sig.backend);

			let shouldComplete = false;
			if (rescan) {
				if (countRecognizedHeaderKeys(doc, sig.paragraphIndex, keyRe) === 0) shouldComplete = true;
			} else if (docChanged) {
				const oldSig = findSignature(oldState.doc);
				if (!oldSig) shouldComplete = true;
			}
			if (!shouldComplete) return null;

			const tr = newState.tr;
			let titleInserted = false;
			if (sig.paragraphIndex === 0) {
				tr.insert(0, schema.nodes.paragraph.create());
				titleInserted = true;
			}
			const effSigIndex = titleInserted ? sig.paragraphIndex + 1 : sig.paragraphIndex;

			const currentDoc = tr.doc;
			let endOfHeaderIndex = effSigIndex + 1;
			while (endOfHeaderIndex < currentDoc.childCount) {
				if (currentDoc.child(endOfHeaderIndex).textContent === '') break;
				endOfHeaderIndex++;
			}

			let insertPos = 0;
			for (let i = 0; i < endOfHeaderIndex; i++) insertPos += currentDoc.child(i).nodeSize;

			const existing = existingHeaderKeysInDoc(currentDoc, effSigIndex, keyRe);
			const hasTrailingBlankAndQ = endOfHeaderIndex < currentDoc.childCount;

			const allParas =
				sig.backend === 'claude'
					? buildClaudeParagraphs(schema, existing, getClaudeDefaults())
					: buildOllamaParagraphs(schema, existing);
			const parasToInsert = hasTrailingBlankAndQ
				? allParas.slice(0, allParas.length - 2) // drop blank + Q: when present
				: allParas;

			if (parasToInsert.length > 0) tr.insert(insertPos, parasToInsert);

			return tr;
		}
	});
}
```

- [ ] **Step 4: 플러그인 테스트 통과 확인**

Run: `cd app && npm run test -- tests/unit/editor/chatNotePlugin.test.ts`
Expected: PASS (ollama 회귀 + claude 신규)

- [ ] **Step 5: TomboyEditor — import 추가** — `TomboyEditor.svelte` import 영역(`:47` 부근, `createChatNotePlugin` import 아래)에:

```ts
import { CLAUDE_HEADER_DEFAULTS } from "$lib/chatNote/defaults.js";
import {
	getClaudeDefaultSystem,
	getClaudeDefaultModel,
	getClaudeDefaultEffort,
} from "$lib/storage/appSettings.js";
```

- [ ] **Step 6: TomboyEditor — 상태 추가** — `:220` 의 `let autoWeekdayEnabled = false;` 부근에:

```ts
	// Claude chat-note defaults, read by createChatNotePlugin via a closure so
	// 설정 changes apply to new notes without re-creating the editor. Seeded to
	// the hardcoded fallback; loaded from appSettings in onMount.
	let claudeDefSystem = CLAUDE_HEADER_DEFAULTS.system;
	let claudeDefModel = CLAUDE_HEADER_DEFAULTS.model;
	let claudeDefEffort: string = CLAUDE_HEADER_DEFAULTS.effort;
```

- [ ] **Step 7: TomboyEditor — onMount 로드** — `:338` 의 `onMount(() => {` 본문 안(예: `installModKeyListeners()` 호출 아래)에:

```ts
		void getClaudeDefaultSystem().then((v) => (claudeDefSystem = v));
		void getClaudeDefaultModel().then((v) => (claudeDefModel = v));
		void getClaudeDefaultEffort().then((v) => (claudeDefEffort = v));
```

- [ ] **Step 8: TomboyEditor — 플러그인 생성 교체** — `:449` 의 `return [createChatNotePlugin()];` 를 교체:

```ts
						return [
							createChatNotePlugin({
								claudeDefaults: () => ({
									system: claudeDefSystem,
									model: claudeDefModel,
									effort: claudeDefEffort,
								}),
							}),
						];
```

- [ ] **Step 9: 타입 체크 + 전체 app 테스트**

Run: `cd app && npm run check && npm run test -- tests/unit/editor/chatNotePlugin.test.ts tests/unit/chatNote/parseChatNote.test.ts`
Expected: 0 errors, PASS

- [ ] **Step 10: 커밋**

```bash
git add app/src/lib/editor/chatNote/chatNotePlugin.ts app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/chatNotePlugin.test.ts
git commit -m "feat(chatNote): claude 시그니처 자동 헤더 + 설정 기본값 주입

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 설정 Claude 탭 UI

**Goal:** 설정 페이지에 `Claude` 탭을 추가하고 기본 시스템 프롬프트(textarea)/기본 모델(text)/기본 effort(select) 3개 필드를 `imageStorageToken` 패턴으로 구현한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` — `:90`(Tab 타입), `:834-843`(tabs 배열), `:129`부근(상태), `:300`부근(저장 핸들러), `:630`부근(onMount 로드), `:1851`부근(탭 콘텐츠 블록), import 영역

**Acceptance Criteria:**
- [ ] 상단 탭에 `Claude` 가 보이고 클릭 시 3개 필드가 표시된다
- [ ] 각 필드 저장 시 appSettings에 반영되고 "저장됨"이 잠깐 표시된다
- [ ] effort는 select로 low/medium/high/xhigh/max 중 선택
- [ ] 페이지 진입 시 저장된 값이 로드되어 표시된다
- [ ] `npm run check` 0 errors

**Verify:** `cd app && npm run check` → 0 errors. 수동: `npm run dev` → 설정 → Claude 탭에서 값 저장/재진입 확인.

**Steps:**

- [ ] **Step 1: import 추가** — `+page.svelte` `<script>` import 영역에:

```ts
import {
	getClaudeDefaultSystem,
	setClaudeDefaultSystem,
	getClaudeDefaultModel,
	setClaudeDefaultModel,
	getClaudeDefaultEffort,
	setClaudeDefaultEffort
} from '$lib/storage/appSettings.js';
import { CLAUDE_VALID_EFFORTS } from '$lib/chatNote/defaults.js';
```

- [ ] **Step 2: Tab 타입에 'claude' 추가** — `:90`:

```ts
	type Tab = 'sync' | 'config' | 'share' | 'terminal' | 'notify' | 'guide' | 'shortcuts' | 'advanced' | 'claude';
```

- [ ] **Step 3: tabs 배열에 추가** — `:834-843` 배열에 항목 추가(`advanced` 뒤):

```ts
		{ id: 'advanced', label: '고급' },
		{ id: 'claude', label: 'Claude' }
```

(직전 `advanced` 줄 끝 콤마 추가에 유의)

- [ ] **Step 4: 상태 변수 추가** — `:129` 의 `let imageStorageToken = $state('');` 부근에:

```ts
	let claudeDefSystem = $state('');
	let claudeDefModel = $state('');
	let claudeDefEffort = $state('high');
	let claudeDefSaved = $state(false);
```

- [ ] **Step 5: 저장 핸들러 추가** — `:302` 의 `saveImageStorageToken` 함수 아래에:

```ts
	async function saveClaudeDefaults(): Promise<void> {
		await setClaudeDefaultSystem(claudeDefSystem);
		await setClaudeDefaultModel(claudeDefModel.trim());
		await setClaudeDefaultEffort(claudeDefEffort);
		claudeDefSaved = true;
		setTimeout(() => (claudeDefSaved = false), 1500);
	}
```

- [ ] **Step 6: onMount 로드 추가** — `:630` 의 `void getImageStorageToken().then(...)` 부근에:

```ts
		void getClaudeDefaultSystem().then((v) => (claudeDefSystem = v));
		void getClaudeDefaultModel().then((v) => (claudeDefModel = v));
		void getClaudeDefaultEffort().then((v) => (claudeDefEffort = v));
```

- [ ] **Step 7: 탭 콘텐츠 블록 추가** — `:1851` 의 활성탭 체인 마지막 `{/if}`(advanced 블록 닫힘) **앞**, 즉 `{:else if activeTab === 'advanced'}` 블록 끝과 체인 종료 `{/if}`(`:1852`) 사이에 추가:

```svelte
		{:else if activeTab === 'claude'}
			<!-- ── Claude 탭 ───────────────────────────────────────────────── -->
			<section class="section">
				<h2>Claude 채팅 기본값</h2>
				<p class="info-text">
					새 <code>claude://</code> 채팅 노트의 헤더에 자동으로 채워지는 기본값입니다.
					노트 헤더에 값이 없으면 전송 시 이 값으로 대체됩니다. Claude 채팅 노트는
					항상 코딩 에이전트 프롬프트를 교체하고 도구를 끈 "클린 모드"로 동작합니다.
				</p>

				<label class="field-label" for="claude-default-system">기본 시스템 프롬프트</label>
				<textarea
					id="claude-default-system"
					class="path-input"
					rows="3"
					bind:value={claudeDefSystem}
				></textarea>

				<label class="field-label" for="claude-default-model">기본 모델</label>
				<input
					id="claude-default-model"
					class="path-input"
					type="text"
					placeholder="opus"
					bind:value={claudeDefModel}
				/>

				<label class="field-label" for="claude-default-effort">기본 effort</label>
				<select id="claude-default-effort" class="path-input" bind:value={claudeDefEffort}>
					{#each CLAUDE_VALID_EFFORTS as lvl (lvl)}
						<option value={lvl}>{lvl}</option>
					{/each}
				</select>

				<div class="path-row" style="margin-top: 0.75rem;">
					<button class="btn-save" onclick={saveClaudeDefaults}>
						{claudeDefSaved ? '저장됨' : '저장'}
					</button>
				</div>
			</section>
```

> `field-label` 클래스가 페이지에 없으면, 인접 섹션에서 쓰는 라벨 클래스를 재사용하거나 `<h3>` 로 대체한다. 스타일은 기존 `.section`/`.path-input`/`.btn-save` 를 따른다.

- [ ] **Step 8: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 9: 수동 확인**

Run: `cd app && npm run dev` → 브라우저에서 설정 → Claude 탭 → 값 변경/저장 → 페이지 새로고침 후 값 유지 확인. 새 노트에 `claude://` 입력 시 헤더가 설정값으로 채워지는지 확인.

- [ ] **Step 10: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "feat(settings): Claude 탭 — 기본 시스템 프롬프트/모델/effort 설정

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 문서 갱신 (CLAUDE.md 채팅 노트 섹션)

**Goal:** `CLAUDE.md` 의 `채팅 노트 (llm:// + claude://)` 섹션을 새 동작에 맞춰 갱신한다(도구 게이트 불변식 제거, 항상 클린 모드 + effort + 설정 탭 명시).

**Files:**
- Modify: `CLAUDE.md` — 채팅 노트 섹션의 헤더 설명 + Invariants

**Acceptance Criteria:**
- [ ] claude 헤더 목록이 `system`/`model`/`effort` 로 기재됨(cwd/allowedTools 삭제)
- [ ] "Tool-enable gate = presence of `cwd:`" 불변식이 제거되고 "항상 클린 모드" 불변식으로 대체됨
- [ ] 기본값을 설정 Claude 탭에서 변경 가능함이 명시됨

**Verify:** `grep -n "effort\|cwd" CLAUDE.md` 로 해당 섹션이 새 내용 반영했는지 육안 확인.

**Steps:**

- [ ] **Step 1: 헤더 설명 갱신** — `CLAUDE.md` 채팅 노트 섹션의 "Headers — ... Claude: `cwd`...`allowedTools`...`model`; both: `system`" 문장을 교체:

```
Headers — Ollama: `temperature`/`num_ctx`/`top_p`/`seed`/`num_predict`/`rag`; Claude: `model`/`effort`(low|medium|high|xhigh|max); both: `system`. `parseChatNote` recognizes both signatures; cross-backend/legacy headers (구 `cwd`/`allowedTools` 포함) silently ignored.
```

- [ ] **Step 2: 불변식 교체** — 같은 섹션 Invariants에서 "Tool-enable gate = presence of `cwd:` header. ..." 항목을 삭제하고 아래로 교체:

```
- **Claude backend는 항상 클린 모드.** 런너(`claude-service/src/runner.ts`)가 항상 `--system-prompt`(코딩 에이전트 프롬프트 교체) + `--exclude-dynamic-system-prompt-sections` + `--disallowedTools '*'`(도구 off) + `--effort`(없으면 high)로 spawn. 노트로 코딩을 하지 않으므로 도구 게이트(`cwd`/`allowedTools`)는 제거됨. spawn cwd는 항상 `$HOME`.
- **기본값은 설정 Claude 탭에서 변경.** `system`/`model`/`effort` 기본값은 `appSettings`(`claudeDefault*`)에 저장되고 설정 Claude 탭에서 편집. 새 `claude://` 노트 헤더에 자동으로 채워지고(자동 헤더 플러그인), 헤더가 비면 전송 시 폴백. 우선순위: 노트 헤더 > 설정 기본값 > `CLAUDE_HEADER_DEFAULTS` 안전망.
```

- [ ] **Step 3: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs(chatNote): claude 백엔드 클린 모드 + effort + 설정 탭 불변식 갱신

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 최종 검증 (모든 태스크 후)

```bash
cd app && npm run check && npm run test
cd ../claude-service && npm run test && npm run build
cd ../bridge && npm test
```

모두 통과해야 한다. 이후 수동: `npm run dev` 로 새 `claude://` 노트 생성 → 헤더 자동 채움 → 번역 1건 전송 → 기존 대비 품질 A/B 확인.
