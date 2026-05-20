# 리마커블 배경화면 노트 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `remarkable://<별칭>` 시그니처 노트의 섹션별 이미지 링크를 모아, [적용] 버튼으로 브릿지를 거쳐 reMarkable의 시스템 스플래시 PNG(`/usr/share/remarkable/*.png`)를 동기 교체한다.

**Architecture:** 앱은 노트를 파싱(`parseRemarkableNote`)해 `{host, slots}`를 얻고, `RemarkableActionBar`가 브릿지 `POST /remarkable/wallpaper`로 보낸다. 브릿지는 별칭을 SSH 타겟으로 풀고, 이미지를 페치→`sharp`로 1404×1872 그레이스케일 PNG 변환→`ssh`로 기기에 기록한다. 슬롯별 독립 처리(부분 실패 허용), 동기 응답.

**Tech Stack:** SvelteKit + Svelte 5 runes / TipTap JSON / vitest (앱) · Node.js HTTP + `node:test` + `sharp` + `child_process` ssh (브릿지).

**기준 스펙:** `docs/superpowers/specs/2026-05-20-remarkable-wallpaper-design.md`

**계획 중 확정된 스펙 대비 정제 사항:**
- 모듈 위치는 `app/src/lib/remarkable/`(파서·슬롯·클라이언트) + `app/src/lib/editor/remarkable/`(Svelte 컴포넌트) — 기존 `llmNote` 분할 선례(`lib/llmNote/` + `lib/editor/llmNote/LlmSendBar.svelte`)를 그대로 따른다.
- 리마커블 SSH 인증은 별도 `keyPath`/`password`가 아니라 **브릿지 컨테이너에 이미 읽기전용 마운트된 `~/.ssh`**를 사용한다(`term-bridge.container`의 `Volume=%h/.ssh:...`). 따라서 호스트 설정 파일은 좌표만(`host`, `user`, `port?`, 선택적 `keyPath`) 담고 자격증명을 담지 않는다. `sshpass`/Containerfile 변경 불필요.
- `RemarkableActionBar`는 `editor` prop을 받아 스스로 `parseRemarkableNote(editor.getJSON())`를 파생한다(`LlmSendBar` 패턴). 리마커블 노트가 아니면 아무것도 렌더하지 않으므로 라우트 배선은 `LlmSendBar` 옆 1줄 삽입으로 끝난다.

---

### Task 1: 앱 — 노트 파서 + 슬롯 상수

**Goal:** TipTap JSON을 `RemarkableNoteSpec`으로 파싱하는 순수 함수와 섹션 라벨↔슬롯 매핑 상수.

**Files:**
- Create: `app/src/lib/remarkable/slots.ts`
- Create: `app/src/lib/remarkable/parseRemarkableNote.ts`
- Test: `app/tests/unit/remarkable/slots.test.ts`
- Test: `app/tests/unit/remarkable/parseRemarkableNote.test.ts`

**Acceptance Criteria:**
- [ ] `parseRemarkableNote`가 시그니처 없는 노트에 `null`을 반환한다
- [ ] 시그니처가 `content[0]` 또는 `content[1]`(제목 줄 위 1개 허용)에서 인식된다
- [ ] 섹션 라벨 아래 첫 `https?://` URL이 해당 슬롯으로 수집된다(평문/링크마크 무관)
- [ ] 미인식 라벨·단락은 무시되고, 중복 라벨은 첫 번째만 채택된다
- [ ] `matchSlotLabel`이 5개 한글 라벨(trailing `:` 허용)을 슬롯 id로 매핑한다
- [ ] `npx vitest run tests/unit/remarkable/` 전부 통과

**Verify:** `cd app && npx vitest run tests/unit/remarkable/` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 슬롯 상수 작성** — `app/src/lib/remarkable/slots.ts`

```ts
export type RmSlotId = 'suspended' | 'starting' | 'poweroff' | 'rebooting' | 'batteryempty';

export interface RmSlotLabel {
	/** 노트에 타이핑하는 한글 섹션 라벨 (trailing `:` 제외). */
	label: string;
	slot: RmSlotId;
}

/**
 * `remarkable://` 노트가 인식하는 섹션 라벨 — 표시 순서대로.
 * 각 `slot` id는 브릿지 `bridge/src/remarkable.ts`의 `RM_SLOT_FILES` 키와
 * 반드시 일치해야 한다(번들 분리상 복제 — 한쪽만 바꾸면 안 됨).
 */
export const RM_SLOT_LABELS: RmSlotLabel[] = [
	{ label: '절전 중', slot: 'suspended' },
	{ label: '부팅 중', slot: 'starting' },
	{ label: '전원 꺼짐', slot: 'poweroff' },
	{ label: '재부팅 중', slot: 'rebooting' },
	{ label: '배터리 없음', slot: 'batteryempty' }
];

/**
 * 트림된 단락 텍스트를 알려진 섹션 라벨과 매칭. 단일 trailing `:`은 허용·제거.
 * 매칭 실패 시 null.
 */
export function matchSlotLabel(trimmed: string): RmSlotId | null {
	const core = trimmed.replace(/:\s*$/, '').trim();
	for (const entry of RM_SLOT_LABELS) {
		if (entry.label === core) return entry.slot;
	}
	return null;
}
```

- [ ] **Step 2: 슬롯 테스트 작성** — `app/tests/unit/remarkable/slots.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { RM_SLOT_LABELS, matchSlotLabel } from '$lib/remarkable/slots.js';

describe('slots', () => {
	it('exposes exactly the 5 known slot ids', () => {
		const ids = RM_SLOT_LABELS.map((s) => s.slot).sort();
		expect(ids).toEqual(['batteryempty', 'poweroff', 'rebooting', 'starting', 'suspended']);
	});

	it('matchSlotLabel maps Korean labels', () => {
		expect(matchSlotLabel('절전 중')).toBe('suspended');
		expect(matchSlotLabel('부팅 중')).toBe('starting');
		expect(matchSlotLabel('전원 꺼짐')).toBe('poweroff');
	});

	it('matchSlotLabel tolerates a trailing colon', () => {
		expect(matchSlotLabel('절전 중:')).toBe('suspended');
		expect(matchSlotLabel('부팅 중 :')).toBe('starting');
	});

	it('matchSlotLabel returns null for unknown labels', () => {
		expect(matchSlotLabel('아무거나')).toBeNull();
		expect(matchSlotLabel('')).toBeNull();
	});
});
```

- [ ] **Step 3: 테스트 실행 — 실패 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/slots.test.ts`
Expected: FAIL — `Cannot find module '$lib/remarkable/slots.js'` 아님(Step 1에서 생성함) → 실제로는 PASS 가능. 이 경우 Step 1이 곧 구현이므로 바로 PASS여도 정상. 핵심은 Step 5의 파서.

- [ ] **Step 4: 파서 테스트 작성** — `app/tests/unit/remarkable/parseRemarkableNote.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseRemarkableNote } from '$lib/remarkable/parseRemarkableNote.js';
import type { JSONContent } from '@tiptap/core';

function doc(...paras: string[]): JSONContent {
	return {
		type: 'doc',
		content: paras.map((text) => ({
			type: 'paragraph',
			content: text === '' ? undefined : [{ type: 'text', text }]
		}))
	};
}

describe('parseRemarkableNote', () => {
	it('returns null for empty/null/undefined doc', () => {
		expect(parseRemarkableNote(undefined)).toBeNull();
		expect(parseRemarkableNote(null)).toBeNull();
		expect(parseRemarkableNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature is present', () => {
		expect(parseRemarkableNote(doc('hello', 'world'))).toBeNull();
	});

	it('recognizes signature at content[0]', () => {
		const r = parseRemarkableNote(doc('remarkable://rm2'));
		expect(r).not.toBeNull();
		expect(r!.host).toBe('rm2');
		expect(r!.slots).toEqual([]);
	});

	it('recognizes signature at content[1] (title line above)', () => {
		const r = parseRemarkableNote(doc('리마커블 배경', 'remarkable://rm2'));
		expect(r!.host).toBe('rm2');
	});

	it('collects an image URL under a section label', () => {
		const r = parseRemarkableNote(
			doc('remarkable://rm2', '절전 중:', 'https://example.com/sleep.png')
		);
		expect(r!.slots).toEqual([{ slot: 'suspended', imageUrl: 'https://example.com/sleep.png' }]);
	});

	it('collects multiple sections', () => {
		const r = parseRemarkableNote(
			doc(
				'remarkable://rm2',
				'절전 중:',
				'https://example.com/sleep.png',
				'부팅 중:',
				'https://example.com/boot.png'
			)
		);
		expect(r!.slots).toEqual([
			{ slot: 'suspended', imageUrl: 'https://example.com/sleep.png' },
			{ slot: 'starting', imageUrl: 'https://example.com/boot.png' }
		]);
	});

	it('ignores unrecognized labels and stray paragraphs', () => {
		const r = parseRemarkableNote(
			doc('remarkable://rm2', '메모', '아무 텍스트', '전원 꺼짐:', 'https://x.io/off.png')
		);
		expect(r!.slots).toEqual([{ slot: 'poweroff', imageUrl: 'https://x.io/off.png' }]);
	});

	it('keeps only the first URL / first occurrence per slot', () => {
		const r = parseRemarkableNote(
			doc(
				'remarkable://rm2',
				'절전 중:',
				'https://a.io/1.png',
				'https://a.io/2.png',
				'절전 중:',
				'https://a.io/3.png'
			)
		);
		expect(r!.slots).toEqual([{ slot: 'suspended', imageUrl: 'https://a.io/1.png' }]);
	});

	it('reads a URL carried inside a link mark', () => {
		const d: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'remarkable://rm2' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '부팅 중:' }] },
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'https://dropbox.com/s/x/boot.png?dl=1',
							marks: [{ type: 'link', attrs: { href: 'https://dropbox.com/s/x/boot.png?dl=1' } }]
						}
					]
				}
			]
		};
		const r = parseRemarkableNote(d);
		expect(r!.slots).toEqual([
			{ slot: 'starting', imageUrl: 'https://dropbox.com/s/x/boot.png?dl=1' }
		]);
	});

	it('returns null for a malformed signature', () => {
		expect(parseRemarkableNote(doc('remarkable://', '절전 중:'))).toBeNull();
		expect(parseRemarkableNote(doc('remarkable:/rm2'))).toBeNull();
	});
});
```

- [ ] **Step 5: 파서 구현** — `app/src/lib/remarkable/parseRemarkableNote.ts`

```ts
import type { JSONContent } from '@tiptap/core';
import { matchSlotLabel, type RmSlotId } from './slots.js';

export interface RemarkableSlotEntry {
	slot: RmSlotId;
	imageUrl: string;
}

export interface RemarkableNoteSpec {
	/** `remarkable://<alias>` 시그니처의 호스트 별칭. */
	host: string;
	/** 인식된 (슬롯, 이미지URL) 쌍 — 슬롯당 첫 등장만. */
	slots: RemarkableSlotEntry[];
}

const SIGNATURE_RE = /^remarkable:\/\/([A-Za-z0-9._-]+)\s*$/;
const URL_RE = /https?:\/\/[^\s]+/;

/**
 * 노트의 TipTap JSON을 리마커블 배경화면 스펙으로 파싱.
 *
 * 인식: `remarkable://<alias>` 시그니처가 content[0] 또는 content[1]의 첫
 * 줄이어야 한다(제목 줄 1개 허용 — parseOcrNote와 동형). 없으면 null = 평범한 노트.
 *
 * 섹션: 시그니처 이후, 트림 텍스트가 알려진 라벨인 단락이 섹션을 연다. 그
 * 아래(다음 라벨 또는 문서 끝까지) 단락들에서 발견되는 첫 http(s) URL이 그
 * 슬롯의 이미지. 미인식 라벨·단락은 무시.
 */
export function parseRemarkableNote(
	doc: JSONContent | null | undefined
): RemarkableNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length === 0) return null;

	let sigIndex = -1;
	let host = '';
	for (const idx of [0, 1]) {
		if (idx >= blocks.length) break;
		const firstLine = blockText(blocks[idx]).split('\n')[0].trim();
		const m = SIGNATURE_RE.exec(firstLine);
		if (m) {
			sigIndex = idx;
			host = m[1];
			break;
		}
	}
	if (sigIndex < 0) return null;

	const slots: RemarkableSlotEntry[] = [];
	const seen = new Set<RmSlotId>();
	let currentSlot: RmSlotId | null = null;

	for (let i = sigIndex + 1; i < blocks.length; i++) {
		const text = blockText(blocks[i]);
		const labelSlot = matchSlotLabel(text.trim());
		if (labelSlot) {
			currentSlot = labelSlot;
			continue;
		}
		if (currentSlot && !seen.has(currentSlot)) {
			const urlMatch = URL_RE.exec(text);
			if (urlMatch) {
				slots.push({ slot: currentSlot, imageUrl: urlMatch[0] });
				seen.add(currentSlot);
				currentSlot = null;
			}
		}
	}

	return { host, slots };
}

/** 단락/헤딩 블록의 인라인 텍스트를 이어붙임; hardBreak → '\n'. 마크는 무시. */
function blockText(block: JSONContent): string {
	if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) return '';
	if (!Array.isArray(block.content)) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') out += child.text ?? '';
		else if (child.type === 'hardBreak') out += '\n';
	}
	return out;
}
```

- [ ] **Step 6: 테스트 실행 — 통과 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/`
Expected: PASS — slots + parseRemarkableNote 전체 통과

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/remarkable/slots.ts app/src/lib/remarkable/parseRemarkableNote.ts app/tests/unit/remarkable/
git commit -m "feat(remarkable): 배경화면 노트 파서 + 슬롯 상수"
```

---

### Task 2: 브릿지 — 리마커블 호스트 설정 로더

**Goal:** `BRIDGE_REMARKABLE_HOSTS_FILE` JSON(`{별칭: {host,user,port?,keyPath?}}`)을 읽어 별칭→SSH 좌표로 해석하는 모듈.

**Files:**
- Create: `bridge/src/remarkableHosts.ts`
- Test: `bridge/src/remarkableHosts.test.ts`

**Acceptance Criteria:**
- [ ] 유효한 JSON 파일을 읽어 `lookupRemarkableHost(별칭)`이 좌표를 반환한다
- [ ] 파일 없음·잘못된 JSON·객체 아님 → 빈 테이블, 예외 없음
- [ ] `host` 누락 엔트리는 건너뛰고, `user` 미지정 시 기본 `'root'`
- [ ] `remarkableHostsConfigured()`가 로드된 엔트리 유무를 반영한다

**Verify:** `cd bridge && npx tsc -p . && node --test dist/remarkableHosts.test.js` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성** — `bridge/src/remarkableHosts.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	loadRemarkableHosts,
	lookupRemarkableHost,
	remarkableHostsConfigured
} from './remarkableHosts.js';

function writeHosts(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'rmhosts-'));
	const path = join(dir, 'remarkable.json');
	writeFileSync(path, JSON.stringify(obj), 'utf8');
	return path;
}

test('loads a valid hosts file', () => {
	const path = writeHosts({ rm2: { host: '10.0.0.42', user: 'root', port: 22 } });
	loadRemarkableHosts(path);
	assert.equal(remarkableHostsConfigured(), true);
	const h = lookupRemarkableHost('rm2');
	assert.deepEqual(h, { host: '10.0.0.42', user: 'root', port: 22 });
});

test('defaults user to root when omitted', () => {
	const path = writeHosts({ rm2: { host: '10.0.0.42' } });
	loadRemarkableHosts(path);
	assert.equal(lookupRemarkableHost('rm2')!.user, 'root');
});

test('missing file → empty table, no throw', () => {
	loadRemarkableHosts('/nonexistent/path/remarkable.json');
	assert.equal(remarkableHostsConfigured(), false);
	assert.equal(lookupRemarkableHost('rm2'), null);
});

test('undefined path → empty table', () => {
	loadRemarkableHosts(undefined);
	assert.equal(remarkableHostsConfigured(), false);
});

test('invalid JSON → empty table, no throw', () => {
	const dir = mkdtempSync(join(tmpdir(), 'rmhosts-'));
	const path = join(dir, 'remarkable.json');
	writeFileSync(path, '{not json', 'utf8');
	loadRemarkableHosts(path);
	assert.equal(remarkableHostsConfigured(), false);
});

test('entry without host is skipped', () => {
	const path = writeHosts({ good: { host: '1.2.3.4' }, bad: { user: 'root' } });
	loadRemarkableHosts(path);
	assert.notEqual(lookupRemarkableHost('good'), null);
	assert.equal(lookupRemarkableHost('bad'), null);
});
```

- [ ] **Step 2: 빌드 후 테스트 실행 — 실패 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/remarkableHosts.test.js`
Expected: FAIL — `tsc`가 `Cannot find module './remarkableHosts.js'`로 컴파일 에러

- [ ] **Step 3: 구현** — `bridge/src/remarkableHosts.ts`

```ts
import { readFileSync } from 'node:fs';

export interface RemarkableHost {
	/** 브릿지에서 닿는 IP 또는 DNS 이름. */
	host: string;
	/** SSH 사용자 (reMarkable은 'root'). */
	user: string;
	/** SSH 포트, 기본 22. */
	port?: number;
	/** 명시적 개인키 경로. 미지정 시 브릿지의 ~/.ssh 기본 키를 사용. */
	keyPath?: string;
}

let table = new Map<string, RemarkableHost>();

export function loadRemarkableHosts(path: string | undefined): void {
	table = new Map();
	if (!path) return;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			console.log(`[term-bridge] reMarkable hosts file not found, wallpaper disabled: ${path}`);
		} else {
			console.error(`[term-bridge] failed to read reMarkable hosts file ${path}:`, err);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error('[term-bridge] reMarkable hosts file is not valid JSON:', err);
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[term-bridge] reMarkable hosts file must be an object {alias: entry}');
		return;
	}
	for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = normalizeEntry(alias, value);
		if (entry) table.set(alias, entry);
	}
	console.log(`[term-bridge] loaded ${table.size} reMarkable host(s) from ${path}`);
}

function normalizeEntry(alias: string, value: unknown): RemarkableHost | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		console.warn(`[term-bridge] reMarkable hosts[${alias}] must be an object, skipped`);
		return null;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.host !== 'string' || !v.host.trim()) {
		console.warn(`[term-bridge] reMarkable hosts[${alias}].host required, skipped`);
		return null;
	}
	const user = typeof v.user === 'string' && v.user.trim() ? v.user.trim() : 'root';
	const out: RemarkableHost = { host: v.host.trim(), user };
	if (typeof v.port === 'number' && v.port >= 1 && v.port <= 65535) {
		out.port = Math.floor(v.port);
	}
	if (typeof v.keyPath === 'string' && v.keyPath.trim()) {
		out.keyPath = v.keyPath.trim();
	}
	return out;
}

export function lookupRemarkableHost(alias: string): RemarkableHost | null {
	return table.get(alias) ?? null;
}

export function remarkableHostsConfigured(): boolean {
	return table.size > 0;
}
```

- [ ] **Step 4: 빌드 후 테스트 실행 — 통과 확인**

Run: `cd bridge && npx tsc -p . && node --test dist/remarkableHosts.test.js`
Expected: PASS — 6개 테스트 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/remarkableHosts.ts bridge/src/remarkableHosts.test.ts
git commit -m "feat(bridge): 리마커블 호스트 설정 로더"
```

---

### Task 3: 브릿지 — 배경화면 적용 코어 로직

**Goal:** 슬롯 파일 매핑 + 의존성 주입형 `applyWallpapers`(슬롯별 독립 처리·부분 실패 허용) + 인증/검증을 묶은 `processWallpaperRequest` — I/O는 전부 주입, 페이크로 완전 테스트.

**Files:**
- Create: `bridge/src/remarkable.ts`
- Test: `bridge/src/remarkable.test.ts`
- Modify: `bridge/package.json` (test 스크립트 추가)

**Acceptance Criteria:**
- [ ] `RM_SLOT_FILES`가 5개 슬롯 id를 기기 파일명 + 재시작 플래그로 매핑한다
- [ ] `applyWallpapers`가 미정의 호스트에 `{status:400, error:'unknown_host'}`를 반환한다
- [ ] 한 슬롯의 페치/변환/전송 실패가 다른 슬롯을 막지 않는다(슬롯별 독립 결과)
- [ ] 재시작 필요 슬롯이 1개라도 성공하면 `restartXochitl`이 정확히 1회 호출된다
- [ ] `processWallpaperRequest`가 잘못된 토큰→401, 미구성→503, 잘못된 본문→400을 반환한다
- [ ] `node --test dist/remarkable.test.js` 전부 통과

**Verify:** `cd bridge && npx tsc -p . && node --test dist/remarkable.test.js` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성** — `bridge/src/remarkable.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken } from './auth.js';
import {
	RM_SLOT_FILES,
	applyWallpapers,
	processWallpaperRequest,
	type WallpaperDeps,
	type RemarkableHost
} from './remarkable.js';

const SECRET = 'unit-test-secret';
const HOST: RemarkableHost = { host: '10.0.0.42', user: 'root' };

function makeFake(over: Partial<WallpaperDeps> = {}) {
	const calls = { pushed: [] as string[], restarts: 0 };
	const deps: WallpaperDeps = {
		hostsConfigured: () => true,
		resolveHost: () => HOST,
		fetchImage: async () => Buffer.from('rawbytes'),
		convertImage: async () => Buffer.from('PNGDATA'),
		pushFile: async (_h, file) => {
			calls.pushed.push(file);
		},
		restartXochitl: async () => {
			calls.restarts++;
		},
		...over
	};
	return { deps, calls };
}

test('RM_SLOT_FILES covers exactly the 5 known slot ids', () => {
	assert.deepEqual(
		Object.keys(RM_SLOT_FILES).sort(),
		['batteryempty', 'poweroff', 'rebooting', 'starting', 'suspended']
	);
	assert.equal(RM_SLOT_FILES.suspended.restart, true);
	assert.equal(RM_SLOT_FILES.starting.restart, false);
});

test('applyWallpapers: unknown host → 400', async () => {
	const { deps } = makeFake({ resolveHost: () => null });
	const out = await applyWallpapers(deps, 'nope', [{ slot: 'starting', imageUrl: 'https://x/i.png' }]);
	assert.equal(out.status, 400);
	assert.equal(out.body.error, 'unknown_host');
});

test('applyWallpapers: all slots ok', async () => {
	const { deps, calls } = makeFake();
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'starting', imageUrl: 'https://x/boot.png' },
		{ slot: 'poweroff', imageUrl: 'https://x/off.png' }
	]);
	assert.equal(out.status, 200);
	assert.deepEqual(out.body.results, [
		{ slot: 'starting', status: 'ok' },
		{ slot: 'poweroff', status: 'ok' }
	]);
	assert.deepEqual(calls.pushed, ['starting.png', 'poweroff.png']);
	assert.equal(calls.restarts, 0);
});

test('applyWallpapers: restart fires once when a restart slot succeeds', async () => {
	const { deps, calls } = makeFake();
	await applyWallpapers(deps, 'rm2', [
		{ slot: 'suspended', imageUrl: 'https://x/s.png' },
		{ slot: 'starting', imageUrl: 'https://x/b.png' }
	]);
	assert.equal(calls.restarts, 1);
});

test('applyWallpapers: a fetch failure isolates to its slot', async () => {
	const { deps } = makeFake({
		fetchImage: async (url) => {
			if (url.includes('bad')) throw new Error('fetch 404');
			return Buffer.from('ok');
		}
	});
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'starting', imageUrl: 'https://x/bad.png' },
		{ slot: 'poweroff', imageUrl: 'https://x/good.png' }
	]);
	assert.equal(out.body.results![0].status, 'error');
	assert.match(out.body.results![0].message!, /fetch 404/);
	assert.equal(out.body.results![1].status, 'ok');
});

test('applyWallpapers: unknown slot id → slot error', async () => {
	const { deps } = makeFake();
	const out = await applyWallpapers(deps, 'rm2', [
		{ slot: 'bogus', imageUrl: 'https://x/i.png' }
	]);
	assert.equal(out.body.results![0].status, 'error');
	assert.equal(out.body.results![0].message, 'unknown_slot');
});

test('processWallpaperRequest: bad token → 401', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: 'garbage',
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 401);
});

test('processWallpaperRequest: hosts not configured → 503', async () => {
	const { deps } = makeFake({ hostsConfigured: () => false });
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 503);
});

test('processWallpaperRequest: bad body → 400', async () => {
	const { deps } = makeFake();
	for (const body of [{}, { host: 'rm2' }, { host: 'rm2', screens: [] }]) {
		const out = await processWallpaperRequest({ token: mintToken(SECRET), secret: SECRET, body, deps });
		assert.equal(out.status, 400);
	}
});

test('processWallpaperRequest: happy path → 200 results', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'https://x/i.png' }] },
		deps
	});
	assert.equal(out.status, 200);
	assert.deepEqual(out.body.results, [{ slot: 'starting', status: 'ok' }]);
});

test('processWallpaperRequest: rejects non-http imageUrl → 400', async () => {
	const { deps } = makeFake();
	const out = await processWallpaperRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		body: { host: 'rm2', screens: [{ slot: 'starting', imageUrl: 'file:///etc/passwd' }] },
		deps
	});
	assert.equal(out.status, 400);
});
```

- [ ] **Step 2: 코어 구현** — `bridge/src/remarkable.ts`

```ts
import { verifyToken } from './auth.js';
import type { RemarkableHost } from './remarkableHosts.js';

export type { RemarkableHost };

export interface RmSlotFile {
	file: string;
	restart: boolean;
}

/**
 * 슬롯 id → /usr/share/remarkable/ 아래 기기 파일 + xochitl 재시작 필요 여부.
 * id 문자열은 app/src/lib/remarkable/slots.ts 의 RM_SLOT_LABELS 와 동기화 필수.
 */
export const RM_SLOT_FILES: Record<string, RmSlotFile> = {
	suspended: { file: 'suspended.png', restart: true },
	starting: { file: 'starting.png', restart: false },
	poweroff: { file: 'poweroff.png', restart: false },
	rebooting: { file: 'rebooting.png', restart: false },
	batteryempty: { file: 'batteryempty.png', restart: false }
};

export interface WallpaperScreen {
	slot: string;
	imageUrl: string;
}

export interface WallpaperDeps {
	hostsConfigured(): boolean;
	resolveHost(alias: string): RemarkableHost | null;
	fetchImage(url: string): Promise<Buffer>;
	convertImage(input: Buffer): Promise<Buffer>;
	pushFile(host: RemarkableHost, deviceFile: string, data: Buffer): Promise<void>;
	restartXochitl(host: RemarkableHost): Promise<void>;
}

export interface SlotResult {
	slot: string;
	status: 'ok' | 'error';
	message?: string;
}

export interface WallpaperOutcome {
	status: number;
	body: { results?: SlotResult[]; error?: string };
}

/**
 * 슬롯별로 페치→변환→전송. 한 슬롯의 실패는 격리되어 나머지를 막지 않는다.
 * 재시작 필요 슬롯이 하나라도 성공하면 마지막에 1회 restartXochitl.
 */
export async function applyWallpapers(
	deps: WallpaperDeps,
	alias: string,
	screens: WallpaperScreen[]
): Promise<WallpaperOutcome> {
	const host = deps.resolveHost(alias);
	if (!host) {
		return { status: 400, body: { error: 'unknown_host' } };
	}
	const results: SlotResult[] = [];
	let needRestart = false;
	for (const screen of screens) {
		const def = RM_SLOT_FILES[screen.slot];
		if (!def) {
			results.push({ slot: screen.slot, status: 'error', message: 'unknown_slot' });
			continue;
		}
		try {
			const raw = await deps.fetchImage(screen.imageUrl);
			const png = await deps.convertImage(raw);
			await deps.pushFile(host, def.file, png);
			results.push({ slot: screen.slot, status: 'ok' });
			if (def.restart) needRestart = true;
		} catch (err) {
			results.push({
				slot: screen.slot,
				status: 'error',
				message: (err as Error).message || 'failed'
			});
		}
	}
	if (needRestart) {
		try {
			await deps.restartXochitl(host);
		} catch (err) {
			console.error('[term-bridge rm] xochitl restart failed:', (err as Error).message);
		}
	}
	return { status: 200, body: { results } };
}

export interface WallpaperRequestInput {
	token: string | undefined;
	secret: string;
	body: unknown;
	deps: WallpaperDeps;
}

/** 인증 → 구성 확인 → 본문 검증 → applyWallpapers. */
export async function processWallpaperRequest(
	input: WallpaperRequestInput
): Promise<WallpaperOutcome> {
	if (!verifyToken(input.secret, input.token)) {
		return { status: 401, body: { error: 'unauthorized' } };
	}
	if (!input.deps.hostsConfigured()) {
		return { status: 503, body: { error: 'remarkable_not_configured' } };
	}
	const parsed = parseBody(input.body);
	if (!parsed) {
		return { status: 400, body: { error: 'bad_request' } };
	}
	return applyWallpapers(input.deps, parsed.host, parsed.screens);
}

function parseBody(body: unknown): { host: string; screens: WallpaperScreen[] } | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	if (typeof b.host !== 'string' || !b.host.trim()) return null;
	if (!Array.isArray(b.screens) || b.screens.length === 0 || b.screens.length > 8) return null;
	const screens: WallpaperScreen[] = [];
	for (const s of b.screens) {
		if (!s || typeof s !== 'object') return null;
		const slot = (s as Record<string, unknown>).slot;
		const imageUrl = (s as Record<string, unknown>).imageUrl;
		if (typeof slot !== 'string' || typeof imageUrl !== 'string') return null;
		if (!/^https?:\/\//i.test(imageUrl)) return null;
		screens.push({ slot, imageUrl });
	}
	return { host: b.host.trim(), screens };
}
```

- [ ] **Step 3: package.json에 test 스크립트 추가** — `bridge/package.json`의 `scripts` 블록

기존:
```json
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "dev": "tsc -p . --watch & node --watch dist/server.js"
  },
```
변경 후:
```json
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "dev": "tsc -p . --watch & node --watch dist/server.js",
    "test": "tsc -p . && node --test \"dist/**/*.test.js\""
  },
```

- [ ] **Step 4: 빌드 후 테스트 실행 — 통과 확인**

Run: `cd bridge && npm test`
Expected: PASS — `remarkable.test.js` + `remarkableHosts.test.js` + 기존 `tmuxControlClient.test.js` 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/remarkable.ts bridge/src/remarkable.test.ts bridge/package.json
git commit -m "feat(bridge): 배경화면 적용 코어 로직 + 슬롯 매핑"
```

---

### Task 4: 브릿지 — 실 의존성 + HTTP 핸들러 + 서버 배선

**Goal:** `sharp`/`fetch`/`ssh`로 실제 I/O를 수행하는 의존성 + `POST /remarkable/wallpaper` 핸들러를 만들고 `server.ts`에 라우트·호스트 로드를 배선한다.

**Files:**
- Modify: `bridge/src/remarkable.ts` (실 의존성 + HTTP 핸들러 추가)
- Modify: `bridge/src/server.ts` (import, 호스트 로드, 라우트)
- Modify: `bridge/package.json` (`sharp` 의존성)

**Acceptance Criteria:**
- [ ] `realWallpaperDeps()`가 fetch(Dropbox URL 정규화·10MB 상한) + sharp(1404×1872 그레이스케일 PNG) + ssh push/재시작을 묶어 반환한다
- [ ] `handleRemarkableWallpaper`가 `processWallpaperRequest` 결과를 JSON으로 응답한다
- [ ] `server.ts`가 부팅 시 `loadRemarkableHosts`를 호출하고 `POST /remarkable/wallpaper`를 라우팅한다
- [ ] `npm run build`가 타입 에러 없이 통과한다
- [ ] Task 3의 `node --test`가 여전히 전부 통과한다(코어 회귀 없음)

**Verify:** `cd bridge && npm install && npm test` → 빌드 + 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: `sharp` 의존성 추가** — `bridge/package.json`의 `dependencies`

기존:
```json
  "dependencies": {
    "@types/node": "^22.0.0",
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  },
```
변경 후:
```json
  "dependencies": {
    "@types/node": "^22.0.0",
    "node-pty": "^1.0.0",
    "sharp": "^0.33.5",
    "ws": "^8.18.0"
  },
```
그리고 설치: `cd bridge && npm install`
(`sharp` 0.33+는 linux-x64/arm64 prebuilt 바이너리를 동봉 — Containerfile 빌드 의존성 변경 불필요.)

- [ ] **Step 2: `remarkable.ts` import 줄 확장**

기존 첫 줄:
```ts
import { verifyToken } from './auth.js';
```
변경 후:
```ts
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { extractBearer, verifyToken } from './auth.js';
import {
	lookupRemarkableHost,
	remarkableHostsConfigured,
	type RemarkableHost
} from './remarkableHosts.js';
```
그리고 기존 `import type { RemarkableHost } from './remarkableHosts.js';` 줄과 `export type { RemarkableHost };` 줄을 삭제(위 import가 `RemarkableHost`를 이미 가져옴). 재노출이 필요하면 아래 한 줄로 교체:
```ts
export type { RemarkableHost };
```

- [ ] **Step 3: 실 의존성 + HTTP 핸들러를 `remarkable.ts` 끝에 추가**

```ts
// ─── 실 의존성 (fetch + sharp + ssh) ──────────────────────────────────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RM_PORTRAIT = { width: 1404, height: 1872 };

/** Dropbox 공유 URL을 직접 다운로드 URL로 정규화. 그 외 URL은 그대로. */
function normalizeImageUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') {
			u.searchParams.set('dl', '1');
		}
		return u.toString();
	} catch {
		return url;
	}
}

async function realFetchImage(url: string): Promise<Buffer> {
	const resp = await fetch(normalizeImageUrl(url), { redirect: 'follow' });
	if (!resp.ok) throw new Error(`image fetch ${resp.status}`);
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length === 0) throw new Error('image empty');
	if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
	return buf;
}

async function realConvertImage(input: Buffer): Promise<Buffer> {
	return sharp(input)
		.rotate() // EXIF 방향 자동 보정
		.resize(RM_PORTRAIT.width, RM_PORTRAIT.height, { fit: 'cover' })
		.grayscale()
		.png()
		.toBuffer();
}

function runSsh(host: RemarkableHost, remoteCmd: string, stdin: Buffer | null): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			'-o', 'BatchMode=yes',
			'-o', 'StrictHostKeyChecking=accept-new',
			'-o', 'ConnectTimeout=8'
		];
		if (host.keyPath) args.push('-i', host.keyPath);
		if (host.port) args.push('-p', String(host.port));
		args.push(`${host.user}@${host.host}`, remoteCmd);
		const child = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', (err) => reject(err));
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ssh exit ${code}: ${stderr.trim().slice(0, 200)}`));
		});
		if (stdin) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

function realPushFile(host: RemarkableHost, deviceFile: string, data: Buffer): Promise<void> {
	// `/usr`가 읽기전용이면 remount 선행. 파일명은 RM_SLOT_FILES 고정값이라 셸 주입 위험 없음.
	const target = `/usr/share/remarkable/${deviceFile}`;
	const remoteCmd = `mount -o remount,rw / 2>/dev/null; cat > '${target}'`;
	return runSsh(host, remoteCmd, data);
}

function realRestartXochitl(host: RemarkableHost): Promise<void> {
	return runSsh(host, 'systemctl restart xochitl', null);
}

export function realWallpaperDeps(): WallpaperDeps {
	return {
		hostsConfigured: remarkableHostsConfigured,
		resolveHost: lookupRemarkableHost,
		fetchImage: realFetchImage,
		convertImage: realConvertImage,
		pushFile: realPushFile,
		restartXochitl: realRestartXochitl
	};
}

// ─── HTTP 핸들러 ──────────────────────────────────────────────────────────

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

/** POST /remarkable/wallpaper — Bearer 인증, 동기 응답. */
export async function handleRemarkableWallpaper(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	let body: unknown;
	try {
		body = await readJson(req);
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const outcome = await processWallpaperRequest({
		token,
		secret,
		body,
		deps: realWallpaperDeps()
	});
	console.log(
		`[term-bridge rm] wallpaper status=${outcome.status} ` +
			`results=${outcome.body.results?.map((r) => `${r.slot}:${r.status}`).join(',') ?? '-'}`
	);
	res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(outcome.body));
}
```

- [ ] **Step 4: `server.ts` import 추가** — 기존 import 블록(`./rag.js` 줄 근처)에 추가

기존:
```ts
import { handleLlmChat } from './llm.js';
import { handleRagSearch } from './rag.js';
```
변경 후:
```ts
import { handleLlmChat } from './llm.js';
import { handleRagSearch } from './rag.js';
import { handleRemarkableWallpaper } from './remarkable.js';
import { loadRemarkableHosts } from './remarkableHosts.js';
```

- [ ] **Step 5: `server.ts` 호스트 파일 로드** — `HOSTS_FILE` / `loadHostsFile` 근처

기존:
```ts
const HOSTS_FILE = process.env.BRIDGE_HOSTS_FILE;

loadHostsFile(HOSTS_FILE);
```
변경 후:
```ts
const HOSTS_FILE = process.env.BRIDGE_HOSTS_FILE;
const REMARKABLE_HOSTS_FILE = process.env.BRIDGE_REMARKABLE_HOSTS_FILE;

loadHostsFile(HOSTS_FILE);
loadRemarkableHosts(REMARKABLE_HOSTS_FILE);
```

- [ ] **Step 6: `server.ts` 라우트 추가** — `handleHttp`의 `/rag/search` 블록 바로 뒤

기존:
```ts
	if (url === '/rag/search' && req.method === 'POST') {
		await handleRagSearch(req, res, SECRET);
		return;
	}

	res.writeHead(404).end();
```
변경 후:
```ts
	if (url === '/rag/search' && req.method === 'POST') {
		await handleRagSearch(req, res, SECRET);
		return;
	}

	if (url === '/remarkable/wallpaper' && req.method === 'POST') {
		await handleRemarkableWallpaper(req, res, SECRET);
		return;
	}

	res.writeHead(404).end();
```

- [ ] **Step 7: 빌드 + 테스트 실행 — 통과 확인**

Run: `cd bridge && npm install && npm test`
Expected: PASS — `tsc` 타입 에러 0, `remarkable.test.js`/`remarkableHosts.test.js`/`tmuxControlClient.test.js` 전부 통과
(실 fetch/sharp/ssh 경로는 유닛 테스트 대상이 아님 — Task 3의 페이크 + Task 7 이후 수동 검증으로 커버.)

- [ ] **Step 8: 커밋**

```bash
git add bridge/src/remarkable.ts bridge/src/server.ts bridge/package.json bridge/package-lock.json
git commit -m "feat(bridge): /remarkable/wallpaper endpoint — sharp 변환 + ssh push"
```

---

### Task 5: 앱 — 배경화면 적용 클라이언트

**Goal:** 브릿지 `POST /remarkable/wallpaper`를 호출하고 슬롯별 결과를 반환하거나 분류된 에러를 던지는 클라이언트.

**Files:**
- Create: `app/src/lib/remarkable/applyWallpaper.ts`
- Test: `app/tests/unit/remarkable/applyWallpaper.test.ts`

**Acceptance Criteria:**
- [ ] 200 응답 시 `results` 배열을 반환한다
- [ ] 401→`unauthorized`, 503→`not_configured`, 400+`unknown_host`→`unknown_host` 종류의 `WallpaperApplyError`를 던진다
- [ ] fetch 자체 실패(네트워크) 시 `network` 종류 에러를 던진다
- [ ] `npx vitest run tests/unit/remarkable/applyWallpaper.test.ts` 통과

**Verify:** `cd app && npx vitest run tests/unit/remarkable/applyWallpaper.test.ts` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/remarkable/applyWallpaper.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	applyWallpaper,
	WallpaperApplyError
} from '$lib/remarkable/applyWallpaper.js';

function mockFetch(status: number, body: unknown) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as Response);
}

const baseOpts = {
	bridgeUrl: 'wss://bridge.example.com',
	token: 'tok',
	host: 'rm2',
	screens: [{ slot: 'starting' as const, imageUrl: 'https://x/boot.png' }]
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('applyWallpaper', () => {
	it('returns results on 200', async () => {
		vi.stubGlobal('fetch', mockFetch(200, { results: [{ slot: 'starting', status: 'ok' }] }));
		const results = await applyWallpaper(baseOpts);
		expect(results).toEqual([{ slot: 'starting', status: 'ok' }]);
	});

	it('throws unauthorized on 401', async () => {
		vi.stubGlobal('fetch', mockFetch(401, { error: 'unauthorized' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({
			name: 'WallpaperApplyError',
			kind: 'unauthorized'
		});
	});

	it('throws not_configured on 503', async () => {
		vi.stubGlobal('fetch', mockFetch(503, { error: 'remarkable_not_configured' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'not_configured' });
	});

	it('throws unknown_host on 400 + unknown_host body', async () => {
		vi.stubGlobal('fetch', mockFetch(400, { error: 'unknown_host' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'unknown_host' });
	});

	it('throws network when fetch rejects', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'network' });
	});

	it('throws server_error on unexpected 200 shape', async () => {
		vi.stubGlobal('fetch', mockFetch(200, { nope: true }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'server_error' });
	});

	it('WallpaperApplyError is an Error subclass', () => {
		expect(new WallpaperApplyError('network')).toBeInstanceOf(Error);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/applyWallpaper.test.ts`
Expected: FAIL — `Cannot find module '$lib/remarkable/applyWallpaper.js'`

- [ ] **Step 3: 구현** — `app/src/lib/remarkable/applyWallpaper.ts`

```ts
import { bridgeToHttpBase } from '$lib/editor/terminal/bridgeSettings.js';
import type { RmSlotId } from './slots.js';

export interface WallpaperApplyScreen {
	slot: RmSlotId;
	imageUrl: string;
}

export interface WallpaperSlotResult {
	slot: string;
	status: 'ok' | 'error';
	message?: string;
}

export type WallpaperApplyErrorKind =
	| 'unauthorized'
	| 'not_configured'
	| 'unknown_host'
	| 'bad_request'
	| 'network'
	| 'server_error';

export class WallpaperApplyError extends Error {
	kind: WallpaperApplyErrorKind;
	constructor(kind: WallpaperApplyErrorKind, message?: string) {
		super(message ?? kind);
		this.name = 'WallpaperApplyError';
		this.kind = kind;
	}
}

export interface ApplyWallpaperOptions {
	bridgeUrl: string;
	token: string;
	host: string;
	screens: WallpaperApplyScreen[];
}

/**
 * 브릿지로 배경화면 배치를 POST. 200이면 슬롯별 결과를 resolve,
 * 인증/구성/네트워크 실패면 WallpaperApplyError를 throw.
 */
export async function applyWallpaper(
	opts: ApplyWallpaperOptions
): Promise<WallpaperSlotResult[]> {
	const base = bridgeToHttpBase(opts.bridgeUrl);
	let resp: Response;
	try {
		resp = await fetch(base + '/remarkable/wallpaper', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ host: opts.host, screens: opts.screens })
		});
	} catch {
		throw new WallpaperApplyError('network', '브릿지에 연결할 수 없습니다');
	}

	if (resp.status === 401) {
		throw new WallpaperApplyError('unauthorized', '브릿지 인증에 실패했습니다');
	}
	if (resp.status === 503) {
		throw new WallpaperApplyError('not_configured', '브릿지에 리마커블 설정이 없습니다');
	}
	if (resp.status === 400) {
		const body = (await resp.json().catch(() => null)) as { error?: string } | null;
		if (body?.error === 'unknown_host') {
			throw new WallpaperApplyError('unknown_host', '알 수 없는 호스트 별칭입니다');
		}
		throw new WallpaperApplyError('bad_request', '잘못된 요청입니다');
	}
	if (!resp.ok) {
		throw new WallpaperApplyError('server_error', `브릿지 오류 (${resp.status})`);
	}

	const body = (await resp.json().catch(() => null)) as
		| { results?: WallpaperSlotResult[] }
		| null;
	if (!body || !Array.isArray(body.results)) {
		throw new WallpaperApplyError('server_error', '예상치 못한 응답 형식입니다');
	}
	return body.results;
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/applyWallpaper.test.ts`
Expected: PASS — 7개 테스트 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/remarkable/applyWallpaper.ts app/tests/unit/remarkable/applyWallpaper.test.ts
git commit -m "feat(remarkable): 배경화면 적용 브릿지 클라이언트"
```

---

### Task 6: 앱 — RemarkableActionBar 컴포넌트 + 라우트 배선

**Goal:** 에디터를 받아 리마커블 노트면 배너+[적용] 버튼을 렌더하고 슬롯별 상태를 표시하는 컴포넌트를 만들고, 모바일/데스크탑 노트 화면에 배선한다.

**Files:**
- Create: `app/src/lib/editor/remarkable/RemarkableActionBar.svelte`
- Test: `app/tests/unit/remarkable/RemarkableActionBar.test.ts`
- Modify: `app/src/routes/note/[id]/+page.svelte` (LlmSendBar 옆 1줄)
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (LlmSendBar 옆 1줄)

**Acceptance Criteria:**
- [ ] 리마커블 노트가 아니면(파서 null) 아무것도 렌더하지 않는다
- [ ] 리마커블 노트면 호스트 + 슬롯 라벨 목록 + [적용] 버튼을 렌더한다
- [ ] [적용] 클릭 시 `applyWallpaper`를 호출하고 슬롯별 ✓/✗ 상태를 표시한다
- [ ] 슬롯이 0개면 "적용할 화면이 없습니다" 안내를 보이고 버튼을 비활성화한다
- [ ] `npm run check`(svelte-check) 통과
- [ ] 컴포넌트 테스트 통과

**Verify:** `cd app && npx vitest run tests/unit/remarkable/RemarkableActionBar.test.ts && npm run check` → 테스트 PASS + 타입 에러 0

**Steps:**

- [ ] **Step 1: 컴포넌트 테스트 작성** — `app/tests/unit/remarkable/RemarkableActionBar.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { JSONContent } from '@tiptap/core';
import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';

vi.mock('$lib/remarkable/applyWallpaper.js', async (orig) => {
	const actual = await orig<typeof import('$lib/remarkable/applyWallpaper.js')>();
	return { ...actual, applyWallpaper: vi.fn() };
});
import { applyWallpaper } from '$lib/remarkable/applyWallpaper.js';

function fakeEditor(doc: JSONContent) {
	return {
		getJSON: () => doc,
		on: () => {},
		off: () => {}
	} as unknown as import('@tiptap/core').Editor;
}

function para(text: string): JSONContent {
	return { type: 'paragraph', content: text === '' ? undefined : [{ type: 'text', text }] };
}

const rmDoc: JSONContent = {
	type: 'doc',
	content: [para('remarkable://rm2'), para('절전 중:'), para('https://x/sleep.png')]
};

afterEach(() => {
	vi.clearAllMocks();
});

describe('RemarkableActionBar', () => {
	it('renders nothing for a non-remarkable note', () => {
		const { container } = render(RemarkableActionBar, {
			editor: fakeEditor({ type: 'doc', content: [para('보통 노트')] }),
			bridgeUrl: 'wss://b',
			bridgeToken: 't'
		});
		expect(container.textContent).not.toContain('리마커블 배경화면');
	});

	it('renders host + slot label for a remarkable note', () => {
		render(RemarkableActionBar, { editor: fakeEditor(rmDoc), bridgeUrl: 'wss://b', bridgeToken: 't' });
		expect(screen.getByText('리마커블 배경화면')).toBeTruthy();
		expect(screen.getByText('rm2')).toBeTruthy();
		expect(screen.getByText('절전 중')).toBeTruthy();
	});

	it('applies wallpaper on button click and shows ok status', async () => {
		vi.mocked(applyWallpaper).mockResolvedValue([{ slot: 'suspended', status: 'ok' }]);
		render(RemarkableActionBar, { editor: fakeEditor(rmDoc), bridgeUrl: 'wss://b', bridgeToken: 't' });
		await fireEvent.click(screen.getByRole('button', { name: '적용' }));
		expect(applyWallpaper).toHaveBeenCalledWith(
			expect.objectContaining({ host: 'rm2', screens: [{ slot: 'suspended', imageUrl: 'https://x/sleep.png' }] })
		);
		await screen.findByText('절전 중');
		const slotEl = screen.getByText('절전 중').closest('[data-status]');
		expect(slotEl?.getAttribute('data-status')).toBe('ok');
	});

	it('shows empty notice when there are no slots', () => {
		render(RemarkableActionBar, {
			editor: fakeEditor({ type: 'doc', content: [para('remarkable://rm2')] }),
			bridgeUrl: 'wss://b',
			bridgeToken: 't'
		});
		expect(screen.getByText(/적용할 화면이 없습니다/)).toBeTruthy();
		expect((screen.getByRole('button', { name: '적용' }) as HTMLButtonElement).disabled).toBe(true);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/RemarkableActionBar.test.ts`
Expected: FAIL — `Cannot find module '$lib/editor/remarkable/RemarkableActionBar.svelte'`

- [ ] **Step 3: 컴포넌트 구현** — `app/src/lib/editor/remarkable/RemarkableActionBar.svelte`

```svelte
<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { parseRemarkableNote } from '$lib/remarkable/parseRemarkableNote.js';
	import { RM_SLOT_LABELS } from '$lib/remarkable/slots.js';
	import {
		applyWallpaper,
		WallpaperApplyError,
		type WallpaperSlotResult
	} from '$lib/remarkable/applyWallpaper.js';
	import { pushToast } from '$lib/stores/toast.js';

	type Props = {
		editor: Editor;
		bridgeUrl: string;
		bridgeToken: string;
	};
	let { editor, bridgeUrl, bridgeToken }: Props = $props();

	let editorVersion = $state(0);
	$effect(() => {
		const bump = () => (editorVersion = (editorVersion + 1) | 0);
		editor.on('update', bump);
		return () => editor.off('update', bump);
	});

	let spec = $derived.by(() => {
		editorVersion; // 에디터 변경 구독
		return parseRemarkableNote(editor.getJSON());
	});

	type SlotStatus = 'idle' | 'pending' | 'ok' | 'error';
	let statuses = $state<Record<string, SlotStatus>>({});
	let messages = $state<Record<string, string>>({});
	let busy = $state(false);

	function labelFor(slot: string): string {
		return RM_SLOT_LABELS.find((s) => s.slot === slot)?.label ?? slot;
	}

	function icon(status: SlotStatus | undefined): string {
		if (status === 'pending') return '⏳';
		if (status === 'ok') return '✓';
		if (status === 'error') return '✗';
		return '·';
	}

	async function apply() {
		if (!spec || busy || spec.slots.length === 0) return;
		busy = true;
		const pending: Record<string, SlotStatus> = {};
		for (const s of spec.slots) pending[s.slot] = 'pending';
		statuses = pending;
		messages = {};
		try {
			const results: WallpaperSlotResult[] = await applyWallpaper({
				bridgeUrl,
				token: bridgeToken,
				host: spec.host,
				screens: spec.slots
			});
			const nextStatus: Record<string, SlotStatus> = {};
			const nextMsg: Record<string, string> = {};
			for (const r of results) {
				nextStatus[r.slot] = r.status === 'ok' ? 'ok' : 'error';
				if (r.message) nextMsg[r.slot] = r.message;
			}
			statuses = nextStatus;
			messages = nextMsg;
			const ok = results.filter((r) => r.status === 'ok').length;
			pushToast(`배경화면 적용: ${ok}/${results.length} 성공`);
		} catch (err) {
			const msg = err instanceof WallpaperApplyError ? err.message : '적용에 실패했습니다';
			const failed: Record<string, SlotStatus> = {};
			for (const s of spec.slots) failed[s.slot] = 'error';
			statuses = failed;
			pushToast(msg);
		} finally {
			busy = false;
		}
	}
</script>

{#if spec}
	<div class="rm-bar">
		<div class="rm-head">
			<span class="rm-title">리마커블 배경화면</span>
			<span class="rm-host">{spec.host}</span>
			<button
				class="rm-apply"
				onclick={apply}
				disabled={busy || spec.slots.length === 0}
			>
				{busy ? '적용 중…' : '적용'}
			</button>
		</div>
		{#if spec.slots.length === 0}
			<div class="rm-empty">
				적용할 화면이 없습니다 — 섹션 라벨(예: <code>절전 중:</code>) 아래에 이미지 링크를 넣으세요.
			</div>
		{:else}
			<ul class="rm-slots">
				{#each spec.slots as s (s.slot)}
					<li class="rm-slot" data-status={statuses[s.slot] ?? 'idle'}>
						<span class="rm-icon">{icon(statuses[s.slot])}</span>
						<span class="rm-slot-label">{labelFor(s.slot)}</span>
						{#if messages[s.slot]}<span class="rm-msg">{messages[s.slot]}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.rm-bar {
		border-top: 1px solid var(--border-color, #ddd);
		padding: clamp(6px, 1.5vw, 12px);
		font-size: clamp(0.78rem, 2.4vw, 0.9rem);
		background: var(--bg-subtle, #f6f6f6);
	}
	.rm-head {
		display: flex;
		align-items: center;
		gap: clamp(6px, 1.5vw, 12px);
	}
	.rm-title {
		font-weight: 600;
	}
	.rm-host {
		color: var(--text-muted, #777);
		font-family: monospace;
	}
	.rm-apply {
		margin-left: auto;
		padding: clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px);
		border: 1px solid var(--border-color, #ccc);
		border-radius: 6px;
		background: var(--bg-color, #fff);
		cursor: pointer;
	}
	.rm-apply:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.rm-empty {
		margin-top: 6px;
		color: var(--text-muted, #777);
	}
	.rm-slots {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.rm-slot {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.rm-slot[data-status='ok'] .rm-icon {
		color: #2a7;
	}
	.rm-slot[data-status='error'] .rm-icon {
		color: #c33;
	}
	.rm-msg {
		color: #c33;
		font-size: 0.85em;
	}
</style>
```

- [ ] **Step 4: 모바일 노트 화면 배선** — `app/src/routes/note/[id]/+page.svelte`

import 추가 — `import LlmSendBar from '$lib/editor/llmNote/LlmSendBar.svelte';` 줄 바로 아래:
```ts
	import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';
```

렌더 — 기존 `LlmSendBar` 블록:
```svelte
				{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}
					<LlmSendBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
				{/if}
```
변경 후 (`LlmSendBar` 아래에 `RemarkableActionBar` 추가 — 같은 가드 안):
```svelte
				{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}
					<LlmSendBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
					<RemarkableActionBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
				{/if}
```

- [ ] **Step 5: 데스크탑 노트 창 배선** — `app/src/lib/desktop/NoteWindow.svelte`

import 추가 — `import LlmSendBar from '$lib/editor/llmNote/LlmSendBar.svelte';` 줄 바로 아래:
```ts
	import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';
```

렌더 — `NoteWindow.svelte`의 `LlmSendBar` 사용 지점(파일 내 `<LlmSendBar`로 검색, 893줄 부근)을 모바일과 동일하게 바로 아래에 `RemarkableActionBar`를 추가. 가드(`{#if ... llmBridgeUrl && llmBridgeToken}`)·prop(`editor` / `bridgeUrl` / `bridgeToken`)은 그 파일의 기존 `LlmSendBar` 호출과 동일하게 맞춘다:
```svelte
					<RemarkableActionBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
```
(`editorComponent.getEditor()!` 표현은 같은 파일의 기존 `LlmSendBar` 호출에서 쓰는 에디터 접근 표현을 그대로 복사할 것 — 변수명이 다르면 그 변수명을 사용.)

- [ ] **Step 6: 테스트 + 타입 체크 — 통과 확인**

Run: `cd app && npx vitest run tests/unit/remarkable/ && npm run check`
Expected: PASS — Task 1/5/6 테스트 전부 통과, svelte-check 에러 0

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/remarkable/ app/tests/unit/remarkable/RemarkableActionBar.test.ts app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte
git commit -m "feat(remarkable): RemarkableActionBar — 노트 배너 + 적용 버튼"
```

---

### Task 7: 브릿지 배포 설정 + 문서

**Goal:** Quadlet 유닛에 리마커블 호스트 파일을 마운트·배선하고, `bridge/README.md`에 셋업 절차·노트 형식·펌웨어 한계를 문서화한다.

**Files:**
- Modify: `bridge/deploy/term-bridge.container`
- Modify: `bridge/README.md`

**Acceptance Criteria:**
- [ ] `term-bridge.container`가 `remarkable.json`을 컨테이너에 읽기전용 마운트하고 `BRIDGE_REMARKABLE_HOSTS_FILE` 환경변수를 설정한다
- [ ] 유닛 헤더 주석에 `remarkable.json` 생성 절차(별칭/host/user, ssh 키 사전 등록)가 추가된다
- [ ] `bridge/README.md`에 노트 형식·`/remarkable/wallpaper`·펌웨어 3.x 절전화면·OTA 초기화 한계가 문서화된다

**Verify:** `cd bridge && podman build -t term-bridge:test . 2>&1 | tail -5` → 빌드 성공 (podman 미설치 환경이면 이 검증은 건너뛰고 파일 diff 검토로 대체)

**Steps:**

- [ ] **Step 1: Quadlet 유닛에 마운트 추가** — `bridge/deploy/term-bridge.container`

기존 `[Container]` 블록의 WOL 호스트 마운트 줄들:
```ini
# WOL host map — read-only. File can be absent; bridge then logs "WOL
# disabled" and skips wake for every target.
Volume=%h/.config/term-bridge/hosts.json:/etc/term-bridge/hosts.json:ro,z
Environment=BRIDGE_HOSTS_FILE=/etc/term-bridge/hosts.json
```
바로 아래에 추가:
```ini
# reMarkable wallpaper host map — read-only, alias → {host,user,port?}.
# File can be absent; bridge then logs "wallpaper disabled" and the
# /remarkable/wallpaper endpoint returns 503. SSH auth reuses the
# read-only ~/.ssh mount above.
Volume=%h/.config/term-bridge/remarkable.json:/etc/term-bridge/remarkable.json:ro,z
Environment=BRIDGE_REMARKABLE_HOSTS_FILE=/etc/term-bridge/remarkable.json
```

- [ ] **Step 2: 유닛 헤더 주석에 셋업 절차 추가** — `bridge/deploy/term-bridge.container`

기존 헤더 주석의 step 4(`hosts.json`) 블록 뒤, `5. systemctl --user daemon-reload` 줄 앞에 새 step을 삽입하고 이후 번호를 +1:
```ini
#   5. (선택) 리마커블 배경화면 기능을 쓰면 ~/.config/term-bridge/remarkable.json
#      을 만든다(없으면 /remarkable/wallpaper 는 503). 별칭 → 접속 좌표:
#        {
#          "rm2": { "host": "10.0.0.42", "user": "root", "port": 22 }
#        }
#      "host" 는 노트의 remarkable://<별칭> 과 매칭된다. SSH 인증은 위
#      ~/.ssh 마운트의 키를 그대로 쓰므로, 사전에 파이에서 리마커블로
#      `ssh-copy-id root@<리마커블-IP>` 로 키를 한 번 등록해 둘 것.
#   6. systemctl --user daemon-reload
#      systemctl --user enable --now term-bridge.service
#   7. Make sure linger is enabled so the container survives logout:
#        loginctl enable-linger $USER
```
(기존 step 5/6을 위 6/7로 대체 — 내용은 동일, 번호만 +1.)

- [ ] **Step 3: `bridge/README.md`에 리마커블 배경화면 섹션 추가**

`bridge/README.md` 끝에 다음 섹션을 추가:
```markdown
## 리마커블 배경화면 (`/remarkable/wallpaper`)

`remarkable://<별칭>` 시그니처 노트의 섹션별 이미지 링크를 reMarkable의
시스템 스플래시 PNG로 교체한다. 앱이 `POST /remarkable/wallpaper`로 보내면
브릿지가 이미지를 페치 → 1404×1872 그레이스케일 PNG로 변환(`sharp`) →
`ssh`로 기기 `/usr/share/remarkable/<file>.png`에 기록한다.

### 노트 형식

```
remarkable://rm2

절전 중:
https://www.dropbox.com/s/.../sleep.png?dl=1

부팅 중:
https://.../boot.png
```

인식되는 섹션 라벨 → 기기 파일:

| 라벨 | 파일 | xochitl 재시작 |
|---|---|---|
| 절전 중 | `suspended.png` | 예 |
| 부팅 중 | `starting.png` | 아니오 |
| 전원 꺼짐 | `poweroff.png` | 아니오 |
| 재부팅 중 | `rebooting.png` | 아니오 |
| 배터리 없음 | `batteryempty.png` | 아니오 |

### 설정

`~/.config/term-bridge/remarkable.json` (Quadlet 헤더 주석 참조):
별칭 → `{host, user, port?, keyPath?}`. SSH 인증은 브릿지에 마운트된
`~/.ssh` 키를 쓴다 — 사전에 `ssh-copy-id root@<리마커블-IP>` 1회 필요.

### 알려진 한계

- **펌웨어 3.x 절전 화면**: `suspended.png` 교체는 리마커블 설정의 절전
  화면이 *정적 화면*일 때만 반영된다. "마지막 필기 페이지" 등 동적
  옵션이면 파일 교체가 무시될 수 있다. 부팅/전원 끔 스플래시는 안정적.
- **OTA 펌웨어 업데이트가 splash 파일을 초기화**한다(A/B 파티션 교체).
  업데이트 후 [적용]을 다시 누르면 복구된다.
- 적용 시점에 리마커블이 깨어 있고 SSH가 닿아야 한다(동기 push).
```

- [ ] **Step 4: 빌드 검증**

Run: `cd bridge && podman build -t term-bridge:test . 2>&1 | tail -5`
Expected: 빌드 성공 (`sharp`가 prebuilt 바이너리로 설치됨). podman 미설치 환경이면 건너뛰고 `git diff`로 두 파일 변경을 육안 검토.

- [ ] **Step 5: 커밋**

```bash
git add bridge/deploy/term-bridge.container bridge/README.md
git commit -m "docs(bridge): 리마커블 배경화면 배포 설정 + 셋업 문서"
```

---

## 자기 검토 결과 (Self-Review)

**스펙 커버리지** — 디자인 스펙 7개 섹션 대조:
- 섹션 1 (노트 형식/파서) → Task 1 ✓
- 섹션 2 (슬롯 매핑) → Task 1(`slots.ts`) + Task 3(`RM_SLOT_FILES`) ✓
- 섹션 3 (앱 UI) → Task 6 ✓
- 섹션 4 (브릿지 endpoint) → Task 2 + Task 3 + Task 4 ✓
- 섹션 5 (에러 처리) → Task 3(`processWallpaperRequest`/`applyWallpapers`) + Task 5(클라이언트 분류) ✓
- 섹션 6 (테스트) → Task 1/2/3/5/6 각 테스트 ✓
- 섹션 7 (알려진 한계 문서화) → Task 7(README) ✓

**플레이스홀더 스캔** — TBD/TODO/"적절히 처리" 없음. 모든 코드 단계에 완전한 코드 포함.

**타입 일관성** — `RmSlotId`(app) / `RM_SLOT_FILES` 키(bridge)는 동일 5개 문자열, 양쪽 테스트가 각자 검증. `WallpaperSlotResult`(app) ↔ `SlotResult`(bridge)는 와이어 호환 형태(`{slot,status,message?}`). `WallpaperDeps`/`applyWallpapers`/`processWallpaperRequest` 시그니처가 Task 3 정의와 Task 4 사용에서 일치. `RemarkableNoteSpec.slots`(`{slot,imageUrl}`)가 `applyWallpaper`의 `screens` 인자와 일치.

**스코프** — 단일 기능, 7개 태스크, 앱/브릿지 양쪽이 한 plan에 응집. 분해 불필요.
