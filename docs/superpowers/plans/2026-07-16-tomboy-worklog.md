# Tomboy Worklog (기록 중심 개발 — 노트 미러) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 세션이 프로젝트 기록(작업/스펙/계획/로그)을 로컬 파일=워킹카피, 톰보이 노트=리모트 미러로 읽고 쓰는 시스템 — 브릿지 `/notes/*` HTTP API + `/mcp` MCP 엔드포인트 + 전역 worklog 스킬 + SessionStart 훅.

**Architecture:** Claude Code → Pi 브릿지(Bearer) → Firestore `users/{uid}/notes/{guid}` → 앱 증분 커서가 pull (일기 파이프라인 s4_write와 동일 채널, 앱 코드 변경 0). 브릿지가 md↔`<note-content>` XML 변환 담당, 클라이언트는 마크다운만 취급. 충돌은 `changeDate` 낙관적 잠금(409).

**Tech Stack:** bridge = Node 22 ESM TypeScript, 의존성 0 추가 (node:crypto RS256 JWT + fetch로 Firestore REST). 테스트 `node --test` + tsx. 클라이언트 = bash 훅 + node mjs 스크립트.

---

## 설계 요약 (컨텍스트 없는 실행자용)

### 데이터 경로 & 스키마 (조사 확정치)

Firestore 문서 `users/{uid}/notes/{guid}` — **10필드 전부 필수** (`app/src/lib/sync/firebase/notePayload.ts:79-114`의 `assertValidPayload`가 누락 시 문서를 조용히 drop):

| 필드 | 타입 | 값 |
|---|---|---|
| guid | string | uuid4 소문자 |
| uri | string | `note://tomboy/{guid}` |
| title | string | 트림된 제목 (이스케이프 없음) |
| xmlContent | string | `<note-content version="0.1">제목\n\n본문</note-content>` — 전체 `.note` 아님 |
| createDate / changeDate / metadataChangeDate | string | Tomboy 날짜: `yyyy-MM-ddTHH:mm:ss.fffffff±HH:MM` (소수점 7자리, 로컬 tz 콜론 오프셋) |
| tags | string[] | 노트북 = `system:notebook:개발` (문서 필드, XML 아님) |
| deleted | boolean | 소프트 삭제 톰스톤 |
| public | boolean | false (누락 허용이지만 항상 씀) |

추가로 **`serverUpdatedAt`을 반드시 서버 타임스탬프로** set (REST `:commit`의 `updateTransforms: setToServerValue REQUEST_TIME`) — 앱 증분 커서(`where serverUpdatedAt >`)가 이걸로 pull. 앱 쓰기는 setDoc 전체 교체(merge 아님)라 브릿지도 항상 전체 payload를 씀. changeDate 문자열이 LWW 비교 키.

### note-content XML 규약 (앱 `noteContentArchiver.ts` 미러)

- 첫 줄 = 제목 (본문과 `\n\n` 구분). 텍스트 이스케이프는 `& < >` 3종.
- 사용 태그: `<bold>`, `<monospace>`, `<link:internal>`, `<list>`/`<list-item dir="ltr">`. **이외 태그 금지** — 미지 태그는 앱 재저장 시 태그 소실(텍스트만 남음).
- 리스트: 중첩 `<list>`는 `<list-item>` 안, 부모 텍스트 뒤 `\n`. 최상위 리스트 마지막 항목만 트레일링 `\n` 없음, 그 외 항목은 `</list-item>` 직전 `\n`.
- `[x]`/`[ ]`는 평문으로 저장 → 앱이 체크박스 atom 렌더(폰에서 탭 가능). `[^N]`, `( )`/`(o)`, `체크리스트:`, `Process`/`Complete` 줄머리, `[[X]]`/`(( ))` 이중괄호는 앱 트리거 — 직렬화기가 생성하지 않고 사용자 md에 있으면 그대로 통과(의도 기능).
- `---` 단독 줄 = hrSplit 세로분할 트리거 → **md 서브셋에서 드롭**.

### 제목 그램마 & 가드

- `[<프로젝트>/<브랜치>] 작업` (워크트리당, 완료 시 리셋) / `[<프로젝트>] 로그` (append) / `[<프로젝트>] 스펙: <기능>` / `[개발] 인박스`.
- 브릿지 가드: 제목 `/^\[[^\]]+\] .+/` AND 문서 tags에 `system:notebook:개발` 포함. 슬립노트(`[0] Slip-Box`류)는 노트북 태그가 없어 403.
- **rename 금지** — 백링크 캐스케이드는 앱측 전용. 제목은 생성 시 고정.

### 미러 모델 (클라이언트)

파일=워킹카피(오프라인 보장), 노트=리모트. `WORK.md`(워크트리 루트, `info/exclude`로 무시) ↔ 작업 노트. push 명시적(/worklog checkpoint), fetch 자동(SessionStart 훅, fail-soft). 상태 `~/.local/state/tomboy-worklog/<encodeURIComponent(제목)>.json` = `{lastPushedChangeDate}`.

### 인증

브릿지 기존 Bearer 체계 + notes/mcp 한정으로 **원시 BRIDGE_SECRET도 수락** (constant-time) — MCP 고정 헤더/스크립트가 30일 민트 만료에 안 걸리게. creds는 `BRIDGE_NOTES_FILE` JSON `{uid, notebook, serviceAccount:{project_id, client_email, private_key}}` (hueCreds 파일 패턴, 캐시 없음). uid/SA 출처: 데스크탑 `pipeline/config/pipeline.yaml`의 `firebase_uid` / `firebase_service_account`.

### 파일 구조

| 파일 | 책임 |
|---|---|
| `bridge/src/noteMarkdown.ts` (+test) | md 서브셋 ↔ note-content XML |
| `bridge/src/notesStore.ts` (+test) | creds 로더 + SA JWT 토큰 + Firestore REST (findByTitle/listByNotebook/write) |
| `bridge/src/notes.ts` (+test) | 코어 op (read/write/list/append, 가드, 409) + HTTP 핸들러 |
| `bridge/src/notesMcp.ts` (+test) | POST /mcp — JSON-RPC initialize/tools.list/tools.call → 코어 op |
| `bridge/src/server.ts` | 라우트 5개 배선 |
| `bridge/deploy/term-bridge.container` | notes-creds 볼륨 + env |
| `app/tests/unit/core/bridgeNoteFixture.test.ts` | 브릿지 산출 XML을 앱 archiver로 바이트 라운드트립 검증 |
| `~/.claude/skills/worklog/SKILL.md` + `scripts/worklog.mjs` | 의식(체크포인트/랩업/스펙) + 브릿지 CLI |
| `~/.claude/hooks/worklog-session-start.sh` + settings.json | 부팅 자동 주입 + PreCompact 경고 |
| `~/.config/tomboy-worklog/env` | BRIDGE_URL / BRIDGE_SECRET |

---

### Task 1: md↔XML 직렬화기 (`noteMarkdown.ts`) + 앱측 바이트 라운드트립 검증

**Goal:** 마크다운 서브셋과 Tomboy `<note-content>` XML 양방향 변환기 — 앱 archiver로 파싱→재직렬화 시 바이트 동일.

**Files:**
- Create: `bridge/src/noteMarkdown.ts`
- Test: `bridge/src/noteMarkdown.test.ts`
- Test: `app/tests/unit/core/bridgeNoteFixture.test.ts`

**Acceptance Criteria:**
- [ ] md 서브셋(`## 헤딩`→bold 줄, `- ` 2칸 중첩 리스트, `**bold**`, `` `mono` ``, ``` 펜스→줄별 monospace, `[[링크]]`→link:internal, `---` 드롭, `[x]` 평문 유지) 왕복 변환
- [ ] `[[[tomboy-web] 로그]]`처럼 대괄호 포함 제목 링크 처리 (lazy `\[\[(.+?)\]\]`)
- [ ] `& < >` 이스케이프/역이스케이프 왕복
- [ ] 앱측 테스트: 브릿지 산출 fixture를 `deserializeContent`→`serializeContent` 했을 때 **바이트 동일** + `[x]`가 inlineCheckbox atom으로 파싱됨
- [ ] `noteContentToMd(mdToNoteContent(t, md))` 라운드트립이 서브셋 입력에 대해 md 복원 (펜스→인라인 코드 축퇴는 허용, 문서화)

**Verify:** `cd bridge && node --import tsx --test src/noteMarkdown.test.ts` → all pass; `cd app && npx vitest run tests/unit/core/bridgeNoteFixture.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/noteMarkdown.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToNoteContent, noteContentToMd, escapeXml } from './noteMarkdown.js';

const MD = `## 범위
- 하는 것: 브릿지 노트 API
  - 세부: [[[tomboy-web] 로그]]
- 안 하는 것: rename

## 상태  (HEAD: abc1234)
[x] 직렬화기
[ ] 배포

다음 명령: \`npm test\``;

const XML = `<note-content version="0.1">[tomboy-web/shifu] 작업

<bold>범위</bold>
<list><list-item dir="ltr">하는 것: 브릿지 노트 API
<list><list-item dir="ltr">세부: <link:internal>[tomboy-web] 로그</link:internal>
</list-item></list>
</list-item><list-item dir="ltr">안 하는 것: rename</list-item></list>

<bold>상태  (HEAD: abc1234)</bold>
[x] 직렬화기
[ ] 배포

다음 명령: <monospace>npm test</monospace></note-content>`;

test('mdToNoteContent: 표준 작업노트 형태', () => {
  assert.equal(mdToNoteContent('[tomboy-web/shifu] 작업', MD), XML);
});

test('noteContentToMd: 역변환', () => {
  const { title, markdown } = noteContentToMd(XML);
  assert.equal(title, '[tomboy-web/shifu] 작업');
  assert.equal(markdown, MD);
});

test('이스케이프 왕복: & < >', () => {
  const xml = mdToNoteContent('[p/b] 작업', 'a < b && c > d');
  assert.ok(xml.includes('a &lt; b &amp;&amp; c &gt; d'));
  assert.equal(noteContentToMd(xml).markdown, 'a < b && c > d');
});

test('펜스 → 줄별 monospace (역변환은 인라인 코드로 축퇴)', () => {
  const xml = mdToNoteContent('[p/b] 작업', '```\nnpm run dev\ngit status\n```');
  assert.ok(xml.includes('<monospace>npm run dev</monospace>\n<monospace>git status</monospace>'));
  assert.equal(noteContentToMd(xml).markdown, '`npm run dev`\n`git status`');
});

test('--- 단독 줄은 드롭 (hrSplit 트리거 회피)', () => {
  const xml = mdToNoteContent('[p/b] 작업', 'a\n---\nb');
  assert.ok(!xml.includes('---'));
});

test('escapeXml 3종만', () => {
  assert.equal(escapeXml(`&<>"'`), `&amp;&lt;&gt;"'`);
});
```

**주의:** XML fixture의 리스트 트레일링 `\n` 배치는 앱 archiver 규약의 1차 추정치. Step 4의 앱측 바이트 라운드트립이 진실 — 불일치하면 **fixture와 직렬화기를 앱 출력에 맞춰 수정**하라 (앱 코드는 절대 수정 금지).

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && node --import tsx --test src/noteMarkdown.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 구현** — `bridge/src/noteMarkdown.ts`

```ts
// Markdown 서브셋 ↔ Tomboy <note-content> XML.
// 앱 noteContentArchiver.ts 직렬화 규약 미러: bold / monospace / link:internal / list(list-item dir="ltr").
// 미지원(의도): 표, ---(hrSplit 트리거라 드롭), 이미지, italic/strike.
// [x]/[ ]는 평문 통과 — 앱이 체크박스 atom으로 렌더.

export function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function unescapeXml(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// 인라인 md → XML. 이스케이프 먼저, 마크 치환은 이스케이프된 텍스트 위에서.
function inlineToXml(text: string): string {
	let s = escapeXml(text);
	s = s.replace(/\[\[(.+?)\]\]/g, (_m, t: string) => `<link:internal>${t}</link:internal>`);
	s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => `<bold>${t}</bold>`);
	s = s.replace(/`([^`]+)`/g, (_m, t: string) => `<monospace>${t}</monospace>`);
	return s;
}

interface ListNode {
	text: string;
	children: ListNode[];
}

function buildTree(flat: Array<{ depth: number; text: string }>, depth: number): ListNode[] {
	const out: ListNode[] = [];
	let i = 0;
	while (i < flat.length) {
		if (flat[i].depth <= depth) {
			const node: ListNode = { text: flat[i].text, children: [] };
			i++;
			const start = i;
			while (i < flat.length && flat[i].depth > depth) i++;
			node.children = buildTree(flat.slice(start, i), depth + 1);
			out.push(node);
		} else {
			i++;
		}
	}
	return out;
}

// 규약: 최상위 리스트의 마지막 항목만 트레일링 \n 없음, 그 외 </list-item> 직전 \n.
// 중첩 <list>는 부모 텍스트 + \n 뒤 list-item 안에.
function serializeList(items: ListNode[], isTop: boolean): string {
	const parts: string[] = [];
	items.forEach((it, i) => {
		let inner = inlineToXml(it.text);
		if (it.children.length > 0) inner += '\n' + serializeList(it.children, false);
		const last = isTop && i === items.length - 1;
		parts.push(`<list-item dir="ltr">${inner}${last ? '' : '\n'}</list-item>`);
	});
	return `<list>${parts.join('')}</list>`;
}

export function mdToNoteContent(title: string, md: string): string {
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	const blocks: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^```/.test(line)) {
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				blocks.push(`<monospace>${escapeXml(lines[i])}</monospace>`);
				i++;
			}
			i++; // 닫는 펜스
			continue;
		}
		if (/^-{3,}\s*$/.test(line)) {
			i++; // hrSplit 트리거 회피 — 드롭
			continue;
		}
		const h = /^#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			blocks.push(`<bold>${inlineToXml(h[1])}</bold>`);
			i++;
			continue;
		}
		if (/^(\s*)- /.test(line)) {
			const flat: Array<{ depth: number; text: string }> = [];
			while (i < lines.length) {
				const m = /^(\s*)- (.*)$/.exec(lines[i]);
				if (!m) break;
				flat.push({ depth: Math.floor(m[1].length / 2), text: m[2] });
				i++;
			}
			blocks.push(serializeList(buildTree(flat, 0), true));
			continue;
		}
		blocks.push(inlineToXml(line));
		i++;
	}
	return `<note-content version="0.1">${escapeXml(title)}\n\n${blocks.join('\n')}</note-content>`;
}

// XML → md. 미지 태그는 텍스트만 유지(앱 파서와 동일 관용).
export function noteContentToMd(xmlContent: string): { title: string; markdown: string } {
	const m = /<note-content[^>]*>([\s\S]*)<\/note-content>/.exec(xmlContent);
	const inner = m ? m[1] : xmlContent;
	const lines: string[] = [];
	let cur = '';
	let started = false; // cur에 내용/프리픽스가 실렸는지
	const stack: string[] = [];
	let listDepth = 0;
	let swallowNewline = false; // </list> 직후 블록 구분 \n 1개 삼킴
	const flush = () => {
		lines.push(cur);
		cur = '';
		started = false;
	};
	const tokenRe = /<(\/?)([A-Za-z0-9:_-]+)(?:\s[^>]*)?>|([^<]+)/g;
	let t: RegExpExecArray | null;
	while ((t = tokenRe.exec(inner))) {
		if (t[3] !== undefined) {
			const parts = t[3].split('\n');
			parts.forEach((rawPart, idx) => {
				if (idx > 0) {
					if (swallowNewline) {
						swallowNewline = false;
					} else {
						flush();
					}
				}
				if (rawPart === '') return;
				swallowNewline = false;
				const p = unescapeXml(rawPart);
				if (stack.includes('link:internal') || stack.includes('link:broken')) cur += `[[${p}]]`;
				else if (stack.includes('monospace')) cur += `\`${p}\``;
				else if (stack.includes('bold')) cur += `**${p}**`;
				else cur += p;
				started = true;
			});
			continue;
		}
		const closing = t[1] === '/';
		const tag = t[2];
		if (!closing) {
			stack.push(tag);
			if (tag === 'list') listDepth++;
			if (tag === 'list-item') {
				cur = '  '.repeat(Math.max(0, listDepth - 1)) + '- ';
				started = true;
			}
		} else {
			const idx = stack.lastIndexOf(tag);
			if (idx >= 0) stack.splice(idx, 1);
			if (tag === 'list') {
				listDepth--;
				if (listDepth === 0) swallowNewline = true;
			}
			if (tag === 'list-item' && started) flush();
		}
	}
	if (started || cur) flush();
	const mdLines = lines.map((l) => {
		const h = /^\*\*(.+)\*\*$/.exec(l);
		return h ? `## ${h[1]}` : l;
	});
	const title = (mdLines[0] ?? '').trim();
	const body = mdLines.slice(1);
	while (body.length && body[0].trim() === '') body.shift();
	while (body.length && body[body.length - 1].trim() === '') body.pop();
	return { title, markdown: body.join('\n') };
}
```

- [ ] **Step 4: 앱측 바이트 라운드트립 테스트** — `app/tests/unit/core/bridgeNoteFixture.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deserializeContent, serializeContent } from '../../../src/lib/core/noteContentArchiver';

// bridge/src/noteMarkdown.test.ts의 XML fixture와 동일 문자열 (수동 동기화 — 변경 시 양쪽 갱신)
const BRIDGE_XML = `<note-content version="0.1">[tomboy-web/shifu] 작업

<bold>범위</bold>
<list><list-item dir="ltr">하는 것: 브릿지 노트 API
<list><list-item dir="ltr">세부: <link:internal>[tomboy-web] 로그</link:internal>
</list-item></list>
</list-item><list-item dir="ltr">안 하는 것: rename</list-item></list>

<bold>상태  (HEAD: abc1234)</bold>
[x] 직렬화기
[ ] 배포

다음 명령: <monospace>npm test</monospace></note-content>`;

describe('bridge 노트 fixture ↔ 앱 archiver', () => {
	it('deserialize → serialize 바이트 동일 (브릿지 산출물이 앱 규약과 일치)', () => {
		const doc = deserializeContent(BRIDGE_XML);
		expect(serializeContent(doc)).toBe(BRIDGE_XML);
	});

	it('[x] / [ ]가 inlineCheckbox atom으로 파싱됨', () => {
		const doc = deserializeContent(BRIDGE_XML);
		const json = JSON.stringify(doc);
		expect(json).toContain('inlineCheckbox');
	});

	it('link:internal이 내부링크 마크로 파싱됨 (제목에 대괄호 포함)', () => {
		const json = JSON.stringify(deserializeContent(BRIDGE_XML));
		expect(json).toContain('[tomboy-web] 로그');
		expect(json).toContain('tomboyInternalLink');
	});
});
```

주의: `deserializeContent`/`serializeContent` export 시그니처는 `app/src/lib/core/noteContentArchiver.ts` 실물 확인 후 맞출 것 (인자·mark 이름 `tomboyInternalLink`는 조사 결과 기준). 바이트 불일치 시: diff를 보고 **bridge 직렬화기의 리스트 `\n` 배치·블록 구분을 앱 출력에 맞춰 조정**하고 두 fixture를 갱신.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd bridge && node --import tsx --test src/noteMarkdown.test.ts` → PASS
Run: `cd app && npx vitest run tests/unit/core/bridgeNoteFixture.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add bridge/src/noteMarkdown.ts bridge/src/noteMarkdown.test.ts app/tests/unit/core/bridgeNoteFixture.test.ts
git commit -m "feat(bridge): md↔note-content XML 직렬화기 + 앱 archiver 바이트 라운드트립 검증"
```

### Task 2: creds + Firestore REST 스토어 (`notesStore.ts`)

**Goal:** `BRIDGE_NOTES_FILE` creds 로더 + SA JWT 토큰 교환 + Firestore REST(findByTitle/listByNotebook/write) — 의존성 0.

**Files:**
- Create: `bridge/src/notesStore.ts`
- Test: `bridge/src/notesStore.test.ts`

**Acceptance Criteria:**
- [ ] creds 로더: env 미설정→null, ENOENT→null, 필드 결손→null, 정상 JSON→객체 (hueCreds 패턴, 캐시 없음)
- [ ] `getAccessToken`: RS256 JWT(iss/scope/aud/iat/exp) → 토큰 endpoint POST, 만료 60초 전까지 캐시
- [ ] `findByTitle`: `users/{uid}:runQuery` structuredQuery(title EQUAL, limit 2), 0건→null, 2건→console.warn 후 첫 건
- [ ] `listByNotebook`: tags ARRAY_CONTAINS `system:notebook:{notebook}`
- [ ] `write`: `documents:commit` — update(10필드 전부) + updateTransforms serverUpdatedAt REQUEST_TIME
- [ ] `formatTomboyDate`: 소수점 7자리 + `±HH:MM` 콜론 오프셋
- [ ] 모든 HTTP는 주입된 `fetchFn` 사용 (테스트에서 mock)

**Verify:** `cd bridge && node --import tsx --test src/notesStore.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/notesStore.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
	readNotesCreds, getAccessToken, createFirestoreNotesStore, formatTomboyDate,
	__resetTokenCacheForTest
} from './notesStore.js';
import type { NotesCreds } from './notesStore.js';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function makeCreds(): NotesCreds {
	return {
		uid: 'dbx-test_uid',
		notebook: '개발',
		serviceAccount: { project_id: 'tomboy-web', client_email: 'sa@test.iam', private_key: privateKey as unknown as string }
	};
}

function setEnv(p: string | undefined) {
	if (p === undefined) delete process.env.BRIDGE_NOTES_FILE;
	else process.env.BRIDGE_NOTES_FILE = p;
}

beforeEach(() => __resetTokenCacheForTest());

test('readNotesCreds: env 미설정 → null', () => {
	setEnv(undefined);
	assert.equal(readNotesCreds(), null);
});

test('readNotesCreds: 정상 파일 라운드트립 + notebook 기본값', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'notes.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	setEnv(p);
	const c = readNotesCreds();
	assert.ok(c);
	assert.equal(c.uid, 'dbx-x');
	assert.equal(c.notebook, '개발');
});

test('readNotesCreds: 필드 결손 → null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'bad.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x' }));
	setEnv(p);
	assert.equal(readNotesCreds(), null);
});

test('getAccessToken: JWT 형태 + 캐시', async () => {
	let calls = 0;
	let capturedBody = '';
	const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
		calls++;
		capturedBody = String(init?.body ?? '');
		return new Response(JSON.stringify({ access_token: 'tok1', expires_in: 3600 }), { status: 200 });
	}) as typeof fetch;
	const creds = makeCreds();
	const t1 = await getAccessToken(creds, fakeFetch);
	const t2 = await getAccessToken(creds, fakeFetch);
	assert.equal(t1, 'tok1');
	assert.equal(t2, 'tok1');
	assert.equal(calls, 1); // 캐시 적중
	const assertion = /assertion=([^&]+)$/.exec(capturedBody)![1];
	const [h, c] = assertion.split('.');
	const header = JSON.parse(Buffer.from(h, 'base64url').toString());
	const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
	assert.equal(header.alg, 'RS256');
	assert.equal(claims.iss, 'sa@test.iam');
	assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
	assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
});

function tokenThenData(rows: unknown): { fetchFn: typeof fetch; captured: { url: string; body: unknown }[] } {
	const captured: { url: string; body: unknown }[] = [];
	const fetchFn = (async (url: unknown, init?: RequestInit) => {
		const u = String(url);
		if (u.includes('oauth2.googleapis.com')) {
			return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
		}
		captured.push({ url: u, body: JSON.parse(String(init?.body ?? 'null')) });
		return new Response(JSON.stringify(rows), { status: 200 });
	}) as typeof fetch;
	return { fetchFn, captured };
}

const DOC_FIELDS = {
	guid: { stringValue: 'g1' },
	uri: { stringValue: 'note://tomboy/g1' },
	title: { stringValue: '[p/b] 작업' },
	xmlContent: { stringValue: '<note-content version="0.1">[p/b] 작업\n\n</note-content>' },
	createDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	changeDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	metadataChangeDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	tags: { arrayValue: { values: [{ stringValue: 'system:notebook:개발' }] } },
	deleted: { booleanValue: false },
	public: { booleanValue: false }
};

test('findByTitle: runQuery 요청 형태 + 매핑', async () => {
	const { fetchFn, captured } = tokenThenData([{ document: { name: 'x', fields: DOC_FIELDS } }]);
	const store = createFirestoreNotesStore(fetchFn);
	const doc = await store.findByTitle(makeCreds(), '[p/b] 작업');
	assert.ok(doc);
	assert.equal(doc.guid, 'g1');
	assert.deepEqual(doc.tags, ['system:notebook:개발']);
	assert.equal(doc.deleted, false);
	const q = captured[0];
	assert.ok(q.url.endsWith('/documents/users/dbx-test_uid:runQuery'));
	const sq = (q.body as { structuredQuery: { where: { fieldFilter: { field: { fieldPath: string }; op: string; value: { stringValue: string } } } } }).structuredQuery;
	assert.equal(sq.where.fieldFilter.field.fieldPath, 'title');
	assert.equal(sq.where.fieldFilter.op, 'EQUAL');
	assert.equal(sq.where.fieldFilter.value.stringValue, '[p/b] 작업');
});

test('findByTitle: 0건 → null (runQuery는 빈 row {readTime}만 반환하기도 함)', async () => {
	const { fetchFn } = tokenThenData([{ readTime: 'x' }]);
	const store = createFirestoreNotesStore(fetchFn);
	assert.equal(await store.findByTitle(makeCreds(), '[p/b] 없음'), null);
});

test('listByNotebook: ARRAY_CONTAINS 쿼리', async () => {
	const { fetchFn, captured } = tokenThenData([{ document: { name: 'x', fields: DOC_FIELDS } }]);
	const store = createFirestoreNotesStore(fetchFn);
	const docs = await store.listByNotebook(makeCreds());
	assert.equal(docs.length, 1);
	const sq = (captured[0].body as { structuredQuery: { where: { fieldFilter: { op: string; value: { stringValue: string } } } } }).structuredQuery;
	assert.equal(sq.where.fieldFilter.op, 'ARRAY_CONTAINS');
	assert.equal(sq.where.fieldFilter.value.stringValue, 'system:notebook:개발');
});

test('write: commit — 10필드 + serverUpdatedAt transform', async () => {
	const { fetchFn, captured } = tokenThenData({});
	const store = createFirestoreNotesStore(fetchFn);
	await store.write(makeCreds(), {
		guid: 'g2', uri: 'note://tomboy/g2', title: '[p/b] 작업',
		xmlContent: '<note-content version="0.1">[p/b] 작업\n\nx</note-content>',
		createDate: 'c', changeDate: 'd', metadataChangeDate: 'm',
		tags: ['system:notebook:개발'], deleted: false, public: false
	});
	const body = captured[0].body as {
		writes: Array<{
			update: { name: string; fields: Record<string, unknown> };
			updateTransforms: Array<{ fieldPath: string; setToServerValue: string }>;
		}>;
	};
	assert.ok(captured[0].url.endsWith('/documents:commit'));
	const w = body.writes[0];
	assert.ok(w.update.name.endsWith('/documents/users/dbx-test_uid/notes/g2'));
	assert.deepEqual(Object.keys(w.update.fields).sort(), [
		'changeDate', 'createDate', 'deleted', 'guid', 'metadataChangeDate', 'public', 'tags', 'title', 'uri', 'xmlContent'
	]);
	assert.deepEqual(w.updateTransforms, [{ fieldPath: 'serverUpdatedAt', setToServerValue: 'REQUEST_TIME' }]);
});

test('formatTomboyDate: 7자리 소수점 + 콜론 오프셋', () => {
	const s = formatTomboyDate(new Date('2026-07-16T12:34:56.789Z'));
	assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}[+-]\d{2}:\d{2}$/);
	assert.ok(s.includes('.7890000') || /\.\d{3}0000/.test(s));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && node --import tsx --test src/notesStore.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 구현** — `bridge/src/notesStore.ts`

```ts
// BRIDGE_NOTES_FILE creds + Firestore REST 접근. 의존성 0 (node:crypto RS256 + fetch).
// 문서 스키마는 app notePayload.ts / pipeline s4_write 미러 — 10필드 전부 필수.
import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';

export interface NotesCreds {
	uid: string;
	notebook: string; // 가드 + 새 노트 태그. 기본 '개발'
	serviceAccount: { project_id: string; client_email: string; private_key: string };
}

export interface NoteDoc {
	guid: string;
	uri: string;
	title: string;
	xmlContent: string;
	createDate: string;
	changeDate: string;
	metadataChangeDate: string;
	tags: string[];
	deleted: boolean;
	public: boolean;
}

export interface NotesStore {
	findByTitle(creds: NotesCreds, title: string): Promise<NoteDoc | null>;
	listByNotebook(creds: NotesCreds): Promise<NoteDoc[]>;
	write(creds: NotesCreds, doc: NoteDoc): Promise<void>;
}

/** BRIDGE_NOTES_FILE 경로. 호출마다 재평가 — 캐시 없음 (hueCreds 패턴). */
export function readNotesCreds(): NotesCreds | null {
	const p = process.env.BRIDGE_NOTES_FILE;
	if (!p || !p.trim()) return null;
	let raw: string;
	try {
		raw = readFileSync(p, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[term-bridge] notesCreds read failed ${p}:`, err);
		return null;
	}
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		const sa = v.serviceAccount as Record<string, unknown> | undefined;
		if (typeof v.uid !== 'string' || !v.uid) return null;
		if (!sa || typeof sa.project_id !== 'string' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return null;
		const notebook = typeof v.notebook === 'string' && v.notebook ? v.notebook : '개발';
		return {
			uid: v.uid,
			notebook,
			serviceAccount: { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key }
		};
	} catch {
		return null;
	}
}

// ---- SA JWT → OAuth 액세스 토큰 (만료 60초 전까지 캐시) ----
let tokenCache: { token: string; exp: number; email: string } | null = null;
export function __resetTokenCacheForTest(): void {
	tokenCache = null;
}

function b64url(buf: Buffer | string): string {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getAccessToken(creds: NotesCreds, fetchFn: typeof fetch = fetch): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (tokenCache && tokenCache.email === creds.serviceAccount.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: creds.serviceAccount.client_email,
			scope: 'https://www.googleapis.com/auth/datastore',
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600
		})
	);
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${claims}`);
	const sig = signer.sign(creds.serviceAccount.private_key);
	const res = await fetchFn('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claims}.${b64url(sig)}`
	});
	if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
	const data = (await res.json()) as { access_token: string; expires_in?: number };
	tokenCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600), email: creds.serviceAccount.client_email };
	return data.access_token;
}

// ---- Firestore REST 값 매핑 ----
type FsValue =
	| { stringValue: string }
	| { booleanValue: boolean }
	| { arrayValue: { values?: FsValue[] } };

function toFields(doc: NoteDoc): Record<string, FsValue> {
	return {
		guid: { stringValue: doc.guid },
		uri: { stringValue: doc.uri },
		title: { stringValue: doc.title },
		xmlContent: { stringValue: doc.xmlContent },
		createDate: { stringValue: doc.createDate },
		changeDate: { stringValue: doc.changeDate },
		metadataChangeDate: { stringValue: doc.metadataChangeDate },
		tags: { arrayValue: { values: doc.tags.map((t) => ({ stringValue: t })) } },
		deleted: { booleanValue: doc.deleted },
		public: { booleanValue: doc.public }
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFields(fields: Record<string, any>): NoteDoc {
	const s = (k: string) => String(fields[k]?.stringValue ?? '');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tags = (fields.tags?.arrayValue?.values ?? []).map((v: any) => String(v.stringValue ?? ''));
	return {
		guid: s('guid'),
		uri: s('uri'),
		title: s('title'),
		xmlContent: s('xmlContent'),
		createDate: s('createDate'),
		changeDate: s('changeDate'),
		metadataChangeDate: s('metadataChangeDate'),
		tags,
		deleted: fields.deleted?.booleanValue === true,
		public: fields.public?.booleanValue === true
	};
}

function baseUrl(creds: NotesCreds): string {
	return `https://firestore.googleapis.com/v1/projects/${creds.serviceAccount.project_id}/databases/(default)`;
}

export function createFirestoreNotesStore(fetchFn: typeof fetch = fetch): NotesStore {
	async function runQuery(creds: NotesCreds, structuredQuery: unknown): Promise<NoteDoc[]> {
		const token = await getAccessToken(creds, fetchFn);
		const res = await fetchFn(`${baseUrl(creds)}/documents/users/${creds.uid}:runQuery`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ structuredQuery })
		});
		if (!res.ok) throw new Error(`firestore query failed: ${res.status} ${await res.text()}`);
		const rows = (await res.json()) as Array<{ document?: { name: string; fields: Record<string, unknown> } }>;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return rows.filter((r) => r.document).map((r) => fromFields(r.document!.fields as Record<string, any>));
	}
	return {
		async findByTitle(creds, title) {
			const docs = await runQuery(creds, {
				from: [{ collectionId: 'notes' }],
				where: { fieldFilter: { field: { fieldPath: 'title' }, op: 'EQUAL', value: { stringValue: title } } },
				limit: 2
			});
			if (docs.length > 1) console.warn(`[term-bridge] duplicate title in Firestore: ${title}`);
			return docs[0] ?? null;
		},
		async listByNotebook(creds) {
			return runQuery(creds, {
				from: [{ collectionId: 'notes' }],
				where: {
					fieldFilter: {
						field: { fieldPath: 'tags' },
						op: 'ARRAY_CONTAINS',
						value: { stringValue: `system:notebook:${creds.notebook}` }
					}
				}
			});
		},
		async write(creds, doc) {
			const token = await getAccessToken(creds, fetchFn);
			const name = `projects/${creds.serviceAccount.project_id}/databases/(default)/documents/users/${creds.uid}/notes/${doc.guid}`;
			const res = await fetchFn(`${baseUrl(creds)}/documents:commit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({
					writes: [
						{
							update: { name, fields: toFields(doc) },
							updateTransforms: [{ fieldPath: 'serverUpdatedAt', setToServerValue: 'REQUEST_TIME' }]
						}
					]
				})
			});
			if (!res.ok) throw new Error(`firestore commit failed: ${res.status} ${await res.text()}`);
		}
	};
}

// ---- 공용 헬퍼 ----
/** Tomboy 날짜: yyyy-MM-ddTHH:mm:ss.fffffff±HH:MM (app core/note.ts formatTomboyDate 미러, 로컬 tz). */
export function formatTomboyDate(d = new Date()): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	const frac = pad(d.getMilliseconds(), 3) + '0000';
	const offMin = -d.getTimezoneOffset();
	const sign = offMin >= 0 ? '+' : '-';
	const abs = Math.abs(offMin);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function newGuid(): string {
	return randomUUID();
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && node --import tsx --test src/notesStore.test.ts`
Expected: PASS (전체)

- [ ] **Step 5: Commit**

```bash
git add bridge/src/notesStore.ts bridge/src/notesStore.test.ts
git commit -m "feat(bridge): notes creds 로더 + Firestore REST 스토어 (SA JWT, 의존성 0)"
```

### Task 3: 코어 op + HTTP 핸들러 (`notes.ts`)

**Goal:** 가드/409/톰스톤 부활을 포함한 read/write/list/append 코어 op + `/notes/*` HTTP 핸들러 4개 (fake store DI로 테스트).

**Files:**
- Create: `bridge/src/notes.ts`
- Test: `bridge/src/notes.test.ts`

**Acceptance Criteria:**
- [ ] 인증: 민트 토큰 OR 원시 시크릿(constant-time) 수락, 그 외 401
- [ ] creds 없음 → 503 `not_configured`
- [ ] 제목 가드 `/^\[[^\]]+\] .+/` 위반 → 403 `forbidden_title`; 노트북 태그 없는 기존 문서 → 403 `forbidden_notebook` (슬립노트 보호)
- [ ] 생성: 10필드 완전한 문서 (tags=[`system:notebook:개발`], public=false, uri=`note://tomboy/{guid}`)
- [ ] 갱신: guid/uri/createDate/tags/public 보존, `ifChangeDate` 불일치·부재 → 409 + `{changeDate, markdown}` (force로 우회, createOnly는 존재 시 409)
- [ ] 톰스톤(deleted:true): read는 404, write는 guid 재사용 부활 (타 노트북 톰스톤은 403)
- [ ] append: 기존 md 뒤 `\n\n` + 새 블록, 없으면 생성
- [ ] list: deleted 제외 + 제목 가드 통과분만, 제목 정렬

**Verify:** `cd bridge && node --import tsx --test src/notes.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/notes.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mintToken } from './auth.js';
import { handleNotesRead, handleNotesWrite, handleNotesList, handleNotesAppend } from './notes.js';
import type { NoteDoc, NotesCreds, NotesStore } from './notesStore.js';

const SECRET = 'test-secret';

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
	const res = {
		writeHead: (s: number) => {
			status = s;
			return res;
		},
		end: (b?: string) => {
			if (b) writes.push(b);
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, body: writes.join('') ? JSON.parse(writes.join('')) : null }) };
}

function auth(): Record<string, string> {
	return { authorization: `Bearer ${mintToken(SECRET)}` };
}

// 인메모리 fake store
function fakeStore(initial: NoteDoc[] = []): NotesStore & { docs: Map<string, NoteDoc> } {
	const docs = new Map(initial.map((d) => [d.guid, d]));
	return {
		docs,
		async findByTitle(_c: NotesCreds, title: string) {
			for (const d of docs.values()) if (d.title === title) return structuredClone(d);
			return null;
		},
		async listByNotebook(c: NotesCreds) {
			return [...docs.values()].filter((d) => d.tags.includes(`system:notebook:${c.notebook}`)).map((d) => structuredClone(d));
		},
		async write(_c: NotesCreds, doc: NoteDoc) {
			docs.set(doc.guid, structuredClone(doc));
		}
	};
}

function makeDoc(over: Partial<NoteDoc>): NoteDoc {
	return {
		guid: 'g1',
		uri: 'note://tomboy/g1',
		title: '[p/b] 작업',
		xmlContent: '<note-content version="0.1">[p/b] 작업\n\n본문</note-content>',
		createDate: '2026-01-01T00:00:00.0000000+00:00',
		changeDate: '2026-01-02T00:00:00.0000000+00:00',
		metadataChangeDate: '2026-01-02T00:00:00.0000000+00:00',
		tags: ['system:notebook:개발'],
		deleted: false,
		public: false,
		...over
	};
}

// 핸들러가 readNotesCreds()를 부르므로 임시 creds 파일 세팅
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), 'notes-'));
	const p = join(dir, 'creds.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', notebook: '개발', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	process.env.BRIDGE_NOTES_FILE = p;
});

test('401: 토큰 없음', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq({}, { title: '[p/b] 작업' }), res, SECRET, fakeStore());
	assert.equal(get().status, 401);
});

test('원시 시크릿 Bearer 수락', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq({ authorization: `Bearer ${SECRET}` }, { title: '[p/b] 작업' }), res, SECRET, fakeStore([makeDoc({})]));
	assert.equal(get().status, 200);
});

test('503: creds 미설정', async () => {
	delete process.env.BRIDGE_NOTES_FILE;
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), res, SECRET, fakeStore());
	assert.equal(get().status, 503);
	assert.equal(get().body.error, 'not_configured');
});

test('read: 정상 → markdown + changeDate', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), res, SECRET, fakeStore([makeDoc({})]));
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.markdown, '본문');
	assert.equal(r.body.changeDate, '2026-01-02T00:00:00.0000000+00:00');
});

test('read: 제목 가드 위반 → 403', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '아무 노트' }), res, SECRET, fakeStore());
	assert.equal(get().status, 403);
	assert.equal(get().body.error, 'forbidden_title');
});

test('read: 노트북 태그 없는 문서 → 403 (슬립노트 보호)', async () => {
	const { res, get } = mockRes();
	const store = fakeStore([makeDoc({ title: '[0] Slip-Box', tags: [] })]);
	await handleNotesRead(mockReq(auth(), { title: '[0] Slip-Box' }), res, SECRET, store);
	assert.equal(get().status, 403);
	assert.equal(get().body.error, 'forbidden_notebook');
});

test('read: 없음/톰스톤 → 404', async () => {
	const s = fakeStore([makeDoc({ deleted: true })]);
	const a = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), a.res, SECRET, s);
	assert.equal(a.get().status, 404);
	const b = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 없음' }), b.res, SECRET, s);
	assert.equal(b.get().status, 404);
});

test('write 생성: 10필드 완전 + 노트북 태그', async () => {
	const store = fakeStore();
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: '## 범위\n- a' }), res, SECRET, store);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.created, true);
	const doc = store.docs.get(r.body.guid)!;
	assert.deepEqual(Object.keys(doc).sort(), [
		'changeDate', 'createDate', 'deleted', 'guid', 'metadataChangeDate', 'public', 'tags', 'title', 'uri', 'xmlContent'
	]);
	assert.equal(doc.uri, `note://tomboy/${doc.guid}`);
	assert.deepEqual(doc.tags, ['system:notebook:개발']);
	assert.equal(doc.public, false);
	assert.ok(doc.xmlContent.startsWith('<note-content version="0.1">[p/b] 작업\n\n'));
});

test('write 갱신: ifChangeDate 일치 → 성공, guid/createDate/tags 보존', async () => {
	const store = fakeStore([makeDoc({ tags: ['system:notebook:개발', 'system:pinned'] })]);
	const { res, get } = mockRes();
	await handleNotesWrite(
		mockReq(auth(), { title: '[p/b] 작업', markdown: '새 본문', ifChangeDate: '2026-01-02T00:00:00.0000000+00:00' }),
		res, SECRET, store
	);
	assert.equal(get().status, 200);
	const doc = store.docs.get('g1')!;
	assert.equal(doc.createDate, '2026-01-01T00:00:00.0000000+00:00');
	assert.deepEqual(doc.tags, ['system:notebook:개발', 'system:pinned']);
	assert.ok(doc.xmlContent.includes('새 본문'));
	assert.notEqual(doc.changeDate, '2026-01-02T00:00:00.0000000+00:00');
});

test('write 갱신: ifChangeDate 불일치/부재 → 409 + 현재 본문', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x', ifChangeDate: '틀림' }), a.res, SECRET, store);
	assert.equal(a.get().status, 409);
	assert.equal(a.get().body.changeDate, '2026-01-02T00:00:00.0000000+00:00');
	assert.equal(a.get().body.markdown, '본문');
	const b = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x' }), b.res, SECRET, store);
	assert.equal(b.get().status, 409);
});

test('write: force 덮어쓰기 / createOnly 존재 시 409', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x', force: true }), a.res, SECRET, store);
	assert.equal(a.get().status, 200);
	const b = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'y', createOnly: true }), b.res, SECRET, store);
	assert.equal(b.get().status, 409);
});

test('write: 톰스톤 부활 — guid 재사용', async () => {
	const store = fakeStore([makeDoc({ deleted: true })]);
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: '부활' }), res, SECRET, store);
	assert.equal(get().status, 200);
	assert.equal(get().body.guid, 'g1');
	assert.equal(store.docs.get('g1')!.deleted, false);
});

test('write: 타 노트북 톰스톤 → 403', async () => {
	const store = fakeStore([makeDoc({ deleted: true, tags: ['system:notebook:일기'] })]);
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x' }), res, SECRET, store);
	assert.equal(get().status, 403);
});

test('append: 기존 뒤에 블록 추가 / 없으면 생성', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesAppend(mockReq(auth(), { title: '[p/b] 작업', markdown: '## 2026-07-16\n- 완료' }), a.res, SECRET, store);
	assert.equal(a.get().status, 200);
	assert.ok(store.docs.get('g1')!.xmlContent.includes('본문\n\n<bold>2026-07-16</bold>'));
	const b = mockRes();
	await handleNotesAppend(mockReq(auth(), { title: '[p] 로그', markdown: '첫 항목' }), b.res, SECRET, store);
	assert.equal(b.get().status, 200);
	assert.equal(b.get().body.created, true);
});

test('list: deleted 제외 + 제목 가드 + 정렬', async () => {
	const store = fakeStore([
		makeDoc({ guid: 'g1', title: '[p/b] 작업' }),
		makeDoc({ guid: 'g2', title: '[p] 로그' }),
		makeDoc({ guid: 'g3', title: '[p] 삭제됨', deleted: true }),
		makeDoc({ guid: 'g4', title: '가드밖제목' })
	]);
	const { res, get } = mockRes();
	await handleNotesList(mockReq(auth(), {}), res, SECRET, store);
	const r = get();
	assert.equal(r.status, 200);
	assert.deepEqual(
		r.body.notes.map((n: { title: string }) => n.title),
		['[p] 로그', '[p/b] 작업']
	);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && node --import tsx --test src/notes.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 구현** — `bridge/src/notes.ts`

```ts
// 워크로그 노트 API — 코어 op + HTTP 핸들러.
// 가드: 제목 /^\[[^\]]+\] .+/ AND 문서 tags에 system:notebook:{notebook}.
// rename 없음(백링크 캐스케이드는 앱측 전용). 충돌은 changeDate 낙관적 잠금.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifyToken, extractBearer } from './auth.js';
import {
	readNotesCreds, createFirestoreNotesStore, formatTomboyDate, newGuid
} from './notesStore.js';
import type { NotesCreds, NotesStore, NoteDoc } from './notesStore.js';
import { mdToNoteContent, noteContentToMd } from './noteMarkdown.js';

// ---- 에러 모델 ----
type OpCode = 'not_configured' | 'forbidden_title' | 'forbidden_notebook' | 'not_found' | 'conflict' | 'bad_request';

export class NotesOpError extends Error {
	constructor(
		public code: OpCode,
		message: string,
		public extra?: Record<string, unknown>
	) {
		super(message);
	}
}

const CODE_TO_STATUS: Record<OpCode, number> = {
	not_configured: 503,
	forbidden_title: 403,
	forbidden_notebook: 403,
	not_found: 404,
	conflict: 409,
	bad_request: 400
};

// ---- 가드 ----
const TITLE_RE = /^\[[^\]]+\] .+/;

function notebookTag(creds: NotesCreds): string {
	return `system:notebook:${creds.notebook}`;
}
function guardTitle(title: string): void {
	if (!TITLE_RE.test(title)) throw new NotesOpError('forbidden_title', '제목은 "[네임스페이스] 이름" 형식이어야 함');
}
function guardDoc(creds: NotesCreds, doc: NoteDoc): void {
	if (!doc.tags.includes(notebookTag(creds))) throw new NotesOpError('forbidden_notebook', `노트가 ${creds.notebook} 노트북 밖`);
}

// ---- 코어 op (MCP에서도 재사용) ----
export interface ReadResult {
	guid: string;
	title: string;
	changeDate: string;
	markdown: string;
}
export interface WriteInput {
	title: string;
	markdown: string;
	ifChangeDate?: string;
	force?: boolean;
	createOnly?: boolean;
}
export interface WriteResult {
	guid: string;
	changeDate: string;
	created: boolean;
}

export async function readNoteOp(creds: NotesCreds, store: NotesStore, title: string): Promise<ReadResult> {
	const t = title.trim();
	guardTitle(t);
	const doc = await store.findByTitle(creds, t);
	if (!doc || doc.deleted) throw new NotesOpError('not_found', '노트 없음');
	guardDoc(creds, doc);
	return { guid: doc.guid, title: doc.title, changeDate: doc.changeDate, markdown: noteContentToMd(doc.xmlContent).markdown };
}

export async function writeNoteOp(creds: NotesCreds, store: NotesStore, input: WriteInput): Promise<WriteResult> {
	const title = input.title.trim();
	guardTitle(title);
	const existing = await store.findByTitle(creds, title);
	const now = formatTomboyDate();
	if (existing && !existing.deleted) {
		guardDoc(creds, existing);
		const conflictExtra = () => ({
			changeDate: existing.changeDate,
			markdown: noteContentToMd(existing.xmlContent).markdown
		});
		if (input.createOnly) throw new NotesOpError('conflict', '노트가 이미 존재', conflictExtra());
		if (!input.force) {
			if (!input.ifChangeDate) throw new NotesOpError('conflict', '기존 노트 갱신엔 ifChangeDate 필요 (read 후 재시도)', conflictExtra());
			if (input.ifChangeDate !== existing.changeDate) throw new NotesOpError('conflict', 'changeDate 불일치 — 원격이 더 최신', conflictExtra());
		}
		const doc: NoteDoc = {
			...existing,
			title,
			xmlContent: mdToNoteContent(title, input.markdown),
			changeDate: now,
			metadataChangeDate: now,
			deleted: false
		};
		await store.write(creds, doc);
		return { guid: doc.guid, changeDate: now, created: false };
	}
	// 신규 또는 톰스톤 부활(guid 재사용 — 제목 중복 방지). 타 노트북 톰스톤은 거부.
	if (existing?.deleted && existing.tags.length > 0 && !existing.tags.includes(notebookTag(creds))) {
		throw new NotesOpError('forbidden_notebook', '타 노트북의 삭제 노트 제목');
	}
	const guid = existing?.guid ?? newGuid();
	const doc: NoteDoc = {
		guid,
		uri: `note://tomboy/${guid}`,
		title,
		xmlContent: mdToNoteContent(title, input.markdown),
		createDate: existing?.createDate || now,
		changeDate: now,
		metadataChangeDate: now,
		tags: [notebookTag(creds)],
		deleted: false,
		public: false
	};
	await store.write(creds, doc);
	return { guid, changeDate: now, created: true };
}

export async function appendNoteOp(creds: NotesCreds, store: NotesStore, title: string, markdown: string): Promise<WriteResult> {
	const t = title.trim();
	guardTitle(t);
	const existing = await store.findByTitle(creds, t);
	if (!existing || existing.deleted) return writeNoteOp(creds, store, { title: t, markdown });
	guardDoc(creds, existing);
	const cur = noteContentToMd(existing.xmlContent).markdown;
	const merged = cur.trim() ? `${cur}\n\n${markdown}` : markdown;
	return writeNoteOp(creds, store, { title: t, markdown: merged, ifChangeDate: existing.changeDate });
}

export async function listNotesOp(creds: NotesCreds, store: NotesStore): Promise<{ notes: Array<{ title: string; guid: string; changeDate: string }> }> {
	const docs = await store.listByNotebook(creds);
	return {
		notes: docs
			.filter((d) => !d.deleted && TITLE_RE.test(d.title))
			.map((d) => ({ title: d.title, guid: d.guid, changeDate: d.changeDate }))
			.sort((a, b) => a.title.localeCompare(b.title))
	};
}

// ---- HTTP 배선 ----
let _store: NotesStore | null = null;
function defaultStore(): NotesStore {
	return (_store ??= createFirestoreNotesStore());
}

/** 민트 토큰 OR 원시 시크릿(constant-time) — MCP 고정 헤더/스크립트가 30일 만료에 안 걸리게. */
export function notesAuthorized(secret: string, req: IncomingMessage): boolean {
	const token = extractBearer(req.headers.authorization);
	if (!token) return false;
	if (verifyToken(secret, token)) return true;
	const a = Buffer.from(token, 'utf8');
	const b = Buffer.from(secret, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024; // 노트 본문 1 MiB 상한
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

async function runHandler(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	fn: (creds: NotesCreds, body: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
	if (!notesAuthorized(secret, req)) {
		json(res, 401, { error: 'unauthorized' });
		return;
	}
	const creds = readNotesCreds();
	if (!creds) {
		json(res, 503, { error: 'not_configured', detail: 'BRIDGE_NOTES_FILE 미설정' });
		return;
	}
	let body: Record<string, unknown>;
	try {
		body = (await readJson(req)) as Record<string, unknown>;
	} catch {
		json(res, 400, { error: 'bad_json' });
		return;
	}
	try {
		json(res, 200, await fn(creds, body));
	} catch (err) {
		if (err instanceof NotesOpError) {
			json(res, CODE_TO_STATUS[err.code], { error: err.code, detail: err.message, ...err.extra });
			return;
		}
		console.error('[term-bridge] notes op failed:', err);
		json(res, 502, { error: 'upstream_failed', detail: err instanceof Error ? err.message : String(err) });
	}
}

function requireString(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	if (typeof v !== 'string' || !v) throw new NotesOpError('bad_request', `missing_${key}`);
	return v;
}

export async function handleNotesRead(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) => readNoteOp(creds, store, requireString(body, 'title')));
}

export async function handleNotesWrite(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) =>
		writeNoteOp(creds, store, {
			title: requireString(body, 'title'),
			markdown: typeof body.markdown === 'string' ? body.markdown : '',
			ifChangeDate: typeof body.ifChangeDate === 'string' ? body.ifChangeDate : undefined,
			force: body.force === true,
			createOnly: body.createOnly === true
		})
	);
}

export async function handleNotesAppend(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) =>
		appendNoteOp(creds, store, requireString(body, 'title'), requireString(body, 'markdown'))
	);
}

export async function handleNotesList(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds) => listNotesOp(creds, store));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && node --import tsx --test src/notes.test.ts`
Expected: PASS (전체)

- [ ] **Step 5: Commit**

```bash
git add bridge/src/notes.ts bridge/src/notes.test.ts
git commit -m "feat(bridge): /notes 코어 op + HTTP 핸들러 (가드/409/톰스톤 부활)"
```

### Task 4: MCP 엔드포인트 (`notesMcp.ts`)

**Goal:** `POST /mcp` — MCP Streamable HTTP(무상태, 단건 JSON 응답)로 worklog_read/write/list/append 4개 툴 노출. 코어 op 재사용.

**Files:**
- Create: `bridge/src/notesMcp.ts`
- Test: `bridge/src/notesMcp.test.ts`

**Acceptance Criteria:**
- [ ] `initialize` → protocolVersion(클라 요청값 에코, 기본 `2025-03-26`) + capabilities.tools + serverInfo
- [ ] `notifications/initialized` (id 없음) → HTTP 202 빈 응답
- [ ] `tools/list` → 4개 툴 + inputSchema
- [ ] `tools/call` → 결과 `{content:[{type:'text',text:JSON}]}`; NotesOpError는 `isError:true` + 코드/본문 포함 (409 시 현재 markdown 동봉)
- [ ] 알 수 없는 메서드 → JSON-RPC error -32601; 잘못된 body → -32700
- [ ] 인증 실패 → HTTP 401 (notes와 동일: 민트 토큰 or 원시 시크릿)

**Verify:** `cd bridge && node --import tsx --test src/notesMcp.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/notesMcp.test.ts`

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mintToken } from './auth.js';
import { handleNotesMcp } from './notesMcp.js';
import type { NoteDoc, NotesCreds, NotesStore } from './notesStore.js';

const SECRET = 'test-secret';

function mockReq(headers: Record<string, string>, body: object): IncomingMessage {
	const r = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	return r;
}
function mockRes() {
	const writes: string[] = [];
	let status = 0;
	const res = {
		writeHead: (s: number) => { status = s; return res; },
		end: (b?: string) => { if (b) writes.push(b); }
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, body: writes.join('') ? JSON.parse(writes.join('')) : null }) };
}
function auth(): Record<string, string> {
	return { authorization: `Bearer ${mintToken(SECRET)}` };
}
function fakeStore(initial: NoteDoc[] = []): NotesStore {
	const docs = new Map(initial.map((d) => [d.guid, d]));
	return {
		async findByTitle(_c: NotesCreds, title: string) {
			for (const d of docs.values()) if (d.title === title) return structuredClone(d);
			return null;
		},
		async listByNotebook(c: NotesCreds) {
			return [...docs.values()].filter((d) => d.tags.includes(`system:notebook:${c.notebook}`));
		},
		async write(_c: NotesCreds, doc: NoteDoc) { docs.set(doc.guid, structuredClone(doc)); }
	};
}

beforeEach(() => {
	const p = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'creds.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', notebook: '개발', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	process.env.BRIDGE_NOTES_FILE = p;
});

test('401 without auth', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'initialize' }), res, SECRET, fakeStore());
	assert.equal(get().status, 401);
});

test('initialize', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
		res, SECRET, fakeStore()
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.protocolVersion, '2025-06-18');
	assert.equal(r.body.result.serverInfo.name, 'tomboy-worklog');
	assert.ok(r.body.result.capabilities.tools);
});

test('notifications/initialized → 202', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', method: 'notifications/initialized' }), res, SECRET, fakeStore());
	assert.equal(get().status, 202);
});

test('tools/list → 4개', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }), res, SECRET, fakeStore());
	const names = get().body.result.tools.map((t: { name: string }) => t.name);
	assert.deepEqual(names.sort(), ['worklog_append', 'worklog_list', 'worklog_read', 'worklog_write']);
});

test('tools/call worklog_write → worklog_read 왕복', async () => {
	const store = fakeStore();
	const a = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '본문' } } }),
		a.res, SECRET, store
	);
	assert.equal(a.get().status, 200);
	const wrote = JSON.parse(a.get().body.result.content[0].text);
	assert.equal(wrote.created, true);
	const b = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'worklog_read', arguments: { title: '[p/b] 작업' } } }),
		b.res, SECRET, store
	);
	const read = JSON.parse(b.get().body.result.content[0].text);
	assert.equal(read.markdown, '본문');
});

test('tools/call 충돌 → isError + 현재 본문', async () => {
	const store = fakeStore();
	const seed = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '원본' } } }),
		seed.res, SECRET, store
	);
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '충돌' } } }),
		res, SECRET, store
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.isError, true);
	const payload = JSON.parse(r.body.result.content[0].text);
	assert.equal(payload.error, 'conflict');
	assert.equal(payload.markdown, '원본');
});

test('unknown method → -32601', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 7, method: 'resources/list' }), res, SECRET, fakeStore());
	assert.equal(get().body.error.code, -32601);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd bridge && node --import tsx --test src/notesMcp.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 구현** — `bridge/src/notesMcp.ts`

```ts
// MCP Streamable HTTP 서버 (무상태 단건 JSON 응답 모드) — worklog 툴 4종.
// 클라 등록: claude mcp add --scope user --transport http worklog <base>/mcp \
//            --header "Authorization: Bearer <BRIDGE_SECRET>"
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readNotesCreds, createFirestoreNotesStore } from './notesStore.js';
import type { NotesStore } from './notesStore.js';
import {
	NotesOpError, notesAuthorized, readNoteOp, writeNoteOp, appendNoteOp, listNotesOp
} from './notes.js';

const PROTOCOL_FALLBACK = '2025-03-26';

const TOOLS = [
	{
		name: 'worklog_read',
		description: '톰보이 워크로그 노트를 마크다운으로 읽기. title 예: "[tomboy-web/shifu] 작업". 반환 changeDate는 다음 worklog_write의 ifChangeDate로 사용.',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string', description: '"[네임스페이스] 이름" 형식 정확 제목' } },
			required: ['title']
		}
	},
	{
		name: 'worklog_write',
		description: '워크로그 노트 업서트(마크다운 서브셋: ##헤딩/- 리스트/**bold**/`code`/[[내부링크]]/[x] 체크박스; 표·--- 금지). 기존 노트엔 ifChangeDate 필수 — conflict면 현재 본문이 반환되니 병합 후 재시도. force:true=무조건 덮어쓰기.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				markdown: { type: 'string' },
				ifChangeDate: { type: 'string' },
				force: { type: 'boolean' },
				createOnly: { type: 'boolean' }
			},
			required: ['title', 'markdown']
		}
	},
	{
		name: 'worklog_list',
		description: '개발 노트북의 워크로그 노트 전체 목록 (title/guid/changeDate).',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'worklog_append',
		description: '노트 끝에 마크다운 블록 append (없으면 생성). "[프로젝트] 로그" append-only 노트용.',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string' }, markdown: { type: 'string' } },
			required: ['title', 'markdown']
		}
	}
];

let _store: NotesStore | null = null;
function defaultStore(): NotesStore {
	return (_store ??= createFirestoreNotesStore());
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024;
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

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
	json(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}
function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
	json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function handleNotesMcp(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	if (!notesAuthorized(secret, req)) {
		json(res, 401, { error: 'unauthorized' });
		return;
	}
	let msg: Record<string, unknown>;
	try {
		msg = (await readJson(req)) as Record<string, unknown>;
	} catch {
		json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
		return;
	}
	// JSON.parse('null')/배열/원시값은 throw 없이 통과 — 프로퍼티 접근 전에 차단 (-32600)
	if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
		json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
		return;
	}
	const id = msg.id;
	const method = typeof msg.method === 'string' ? msg.method : '';
	const params = (msg.params ?? {}) as Record<string, unknown>;

	if (method.startsWith('notifications/')) {
		res.writeHead(202);
		res.end();
		return;
	}
	if (method === 'initialize') {
		rpcResult(res, id, {
			protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'tomboy-worklog', version: '0.1.0' }
		});
		return;
	}
	if (method === 'ping') {
		rpcResult(res, id, {});
		return;
	}
	if (method === 'tools/list') {
		rpcResult(res, id, { tools: TOOLS });
		return;
	}
	if (method === 'tools/call') {
		const name = typeof params.name === 'string' ? params.name : '';
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		const creds = readNotesCreds();
		if (!creds) {
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify({ error: 'not_configured', detail: 'BRIDGE_NOTES_FILE 미설정' }) }], isError: true });
			return;
		}
		try {
			let result: unknown;
			if (name === 'worklog_read') result = await readNoteOp(creds, store, String(args.title ?? ''));
			else if (name === 'worklog_write')
				result = await writeNoteOp(creds, store, {
					title: String(args.title ?? ''),
					markdown: String(args.markdown ?? ''),
					ifChangeDate: typeof args.ifChangeDate === 'string' ? args.ifChangeDate : undefined,
					force: args.force === true,
					createOnly: args.createOnly === true
				});
			else if (name === 'worklog_append') result = await appendNoteOp(creds, store, String(args.title ?? ''), String(args.markdown ?? ''));
			else if (name === 'worklog_list') result = await listNotesOp(creds, store);
			else {
				rpcError(res, id, -32602, `unknown tool: ${name}`);
				return;
			}
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
		} catch (err) {
			if (err instanceof NotesOpError) {
				rpcResult(res, id, {
					content: [{ type: 'text', text: JSON.stringify({ error: err.code, detail: err.message, ...err.extra }, null, 1) }],
					isError: true
				});
				return;
			}
			console.error('[term-bridge] mcp tool failed:', err);
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify({ error: 'upstream_failed', detail: String(err) }) }], isError: true });
		}
		return;
	}
	rpcError(res, id, -32601, `method not found: ${method}`);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd bridge && node --import tsx --test src/notesMcp.test.ts`
Expected: PASS (전체)

- [ ] **Step 5: Commit**

```bash
git add bridge/src/notesMcp.ts bridge/src/notesMcp.test.ts
git commit -m "feat(bridge): /mcp MCP 엔드포인트 — worklog 툴 4종 (streamable http, 무상태)"
```

---

### Task 5: 서버 배선 + quadlet + 전체 검증

**Goal:** server.ts에 라우트 5개 등록, quadlet에 notes-creds 마운트 추가, bridge 전체 테스트+빌드 green.

**Files:**
- Modify: `bridge/src/server.ts` (import 블록 + handleHttp 라우트 체인)
- Modify: `bridge/deploy/term-bridge.container`

**Acceptance Criteria:**
- [ ] `/notes/read|write|append|list` + `/mcp` POST 정확매칭 라우트 (기존 라우트와 충돌 없음, CORS 수정 불필요 — 전부 POST)
- [ ] quadlet: `%h/.config/term-bridge/notes-creds.json` ro 마운트 + `BRIDGE_NOTES_FILE` env (기존 hosts.json 패턴 미러, "결측 source→podman이 디렉토리 생성" 경고 주석 포함)
- [ ] `npm test` 전체 green, `npm run build` 성공

**Verify:** `cd bridge && npm test && npm run build` → 전체 PASS + 빌드 성공

**Steps:**

- [ ] **Step 1: server.ts import 추가** (기존 import 블록 끝, `server.ts:18-23` 부근)

```ts
import { handleNotesRead, handleNotesWrite, handleNotesAppend, handleNotesList } from './notes.js';
import { handleNotesMcp } from './notesMcp.js';
```

- [ ] **Step 2: 라우트 등록** — handleHttp 안, `/hue/creds` 블록 뒤에 삽입

```ts
	if (url === '/notes/read' && req.method === 'POST') {
		await handleNotesRead(req, res, SECRET);
		return;
	}
	if (url === '/notes/write' && req.method === 'POST') {
		await handleNotesWrite(req, res, SECRET);
		return;
	}
	if (url === '/notes/append' && req.method === 'POST') {
		await handleNotesAppend(req, res, SECRET);
		return;
	}
	if (url === '/notes/list' && req.method === 'POST') {
		await handleNotesList(req, res, SECRET);
		return;
	}
	if (url === '/mcp' && req.method === 'POST') {
		await handleNotesMcp(req, res, SECRET);
		return;
	}
```

- [ ] **Step 3: quadlet 수정** — `bridge/deploy/term-bridge.container`, 기존 `hosts.json` Volume/Environment 짝 밑에 추가

```ini
# 워크로그 노트 creds ({uid, notebook, serviceAccount}) — 없으면 /notes는 503.
# 주의: podman은 결측 source를 디렉토리로 생성함 — 유닛 start 전에 파일을 먼저 만들 것.
Volume=%h/.config/term-bridge/notes-creds.json:/etc/term-bridge/notes-creds.json:ro,z
Environment=BRIDGE_NOTES_FILE=/etc/term-bridge/notes-creds.json
```

- [ ] **Step 4: 전체 검증**

Run: `cd bridge && npm test` → 기존+신규 전체 PASS
Run: `cd bridge && npm run build` → tsc 성공

- [ ] **Step 5: Commit**

```bash
git add bridge/src/server.ts bridge/deploy/term-bridge.container
git commit -m "feat(bridge): /notes + /mcp 라우트 배선, quadlet notes-creds 마운트"
```

### Task 6: 전역 worklog 스킬 + CLI 스크립트 + 훅

**Goal:** `~/.claude/skills/worklog/`(의식 + CLI) + SessionStart/PreCompact 훅 + 설정 파일 골격 — repo 밖 사용자 전역 파일. 브릿지 없이 검증 가능한 부분(resolve/init/로컬 동작)까지 확인.

**Files:**
- Create: `~/.claude/skills/worklog/SKILL.md`
- Create: `~/.claude/skills/worklog/scripts/worklog.mjs`
- Create: `~/.claude/hooks/worklog-session-start.sh` (chmod +x)
- Create: `~/.config/tomboy-worklog/env` (0600, 값은 Task 7에서 채움)
- Modify: `~/.claude/settings.json` (hooks.SessionStart + hooks.PreCompact 추가 — 기존 Stop/Notification 보존)

**Acceptance Criteria:**
- [ ] `worklog.mjs resolve`가 이 워크트리에서 `{"project":"tomboy-web","branch":"shifu","workTitle":"[tomboy-web/shifu] 작업",...}` 출력 (`--git-common-dir` 기반 — 워크트리 cwd 함정 회피)
- [ ] `worklog.mjs init`이 `$(git-common-dir)/info/exclude`에 `WORK.md` 멱등 추가
- [ ] 훅 스크립트: git repo 아니면 침묵 종료 0; WORK.md 있으면 출력; 브릿지 실패 시 경고 한 줄 후 종료 0 (fail-soft)
- [ ] settings.json에 SessionStart/PreCompact 추가, 기존 hooks(Stop/Notification)·설정 무손상 (`claude` 재시작 없이 JSON 유효성만 확인)
- [ ] env 파일 0600

**Verify:** `node ~/.claude/skills/worklog/scripts/worklog.mjs resolve` → 올바른 JSON; `bash ~/.claude/hooks/worklog-session-start.sh` → exit 0; `python3 -m json.tool ~/.claude/settings.json` → 유효

**Steps:**

- [ ] **Step 1: CLI 스크립트** — `~/.claude/skills/worklog/scripts/worklog.mjs`

```js
#!/usr/bin/env node
// tomboy-worklog CLI — 브릿지 /notes API 클라이언트 + git 컨텍스트 해석 + push 상태 추적.
// 설정: ~/.config/tomboy-worklog/env (BRIDGE_URL=..., BRIDGE_SECRET=...)
// 상태: ~/.local/state/tomboy-worklog/<encodeURIComponent(제목)>.json = {lastPushedChangeDate}
// 사용:
//   worklog.mjs resolve                     # 프로젝트/브랜치/제목 JSON
//   worklog.mjs init                        # info/exclude에 WORK.md 등록
//   worklog.mjs read <제목>                 # {title, markdown, changeDate}
//   worklog.mjs write <제목> [--force]      # stdin=markdown, 상태의 lastPushedChangeDate를 ifChangeDate로 사용
//   worklog.mjs append <제목>               # stdin=markdown 블록
//   worklog.mjs list
//   worklog.mjs push-work                   # WORK.md → 작업 노트 (write 래퍼)
//   worklog.mjs status                      # 훅용: WORK.md/노트 비교 요약 (fail-soft)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = join(homedir(), '.config', 'tomboy-worklog', 'env');
const STATE_DIR = join(homedir(), '.local', 'state', 'tomboy-worklog');

function fail(msg, code = 1) {
	console.error(`[worklog] ${msg}`);
	process.exit(code);
}

function loadConfig() {
	let raw;
	try {
		raw = readFileSync(CONFIG_PATH, 'utf8');
	} catch {
		fail(`설정 없음: ${CONFIG_PATH} (BRIDGE_URL=, BRIDGE_SECRET= 두 줄 필요)`);
	}
	const cfg = {};
	for (const line of raw.split('\n')) {
		const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
		if (m) cfg[m[1]] = m[2];
	}
	if (!cfg.BRIDGE_URL || !cfg.BRIDGE_SECRET) fail('BRIDGE_URL/BRIDGE_SECRET 누락');
	return cfg;
}

function sh(cmd) {
	return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function resolveCtx() {
	let top = null;
	let project;
	let branch = '';
	try {
		top = sh('git rev-parse --show-toplevel');
		const common = sh('git rev-parse --path-format=absolute --git-common-dir');
		project = basename(dirname(common)); // 워크트리에서도 main repo 이름
		branch = sh('git branch --show-current') || 'detached';
	} catch {
		project = basename(process.cwd());
		branch = 'main';
	}
	return {
		project,
		branch,
		top,
		workTitle: `[${project}/${branch}] 작업`,
		logTitle: `[${project}] 로그`,
		workFile: top ? join(top, 'WORK.md') : join(process.cwd(), 'WORK.md')
	};
}

function statePath(title) {
	return join(STATE_DIR, `${encodeURIComponent(title)}.json`);
}
function loadState(title) {
	try {
		return JSON.parse(readFileSync(statePath(title), 'utf8'));
	} catch {
		return {};
	}
}
function saveState(title, state) {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(statePath(title), JSON.stringify(state));
}

async function api(cfg, path, body, { timeoutMs = 10000 } = {}) {
	const res = await fetch(`${cfg.BRIDGE_URL.replace(/\/$/, '')}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.BRIDGE_SECRET}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const data = await res.json().catch(() => ({}));
	return { status: res.status, data };
}

function readStdin() {
	try {
		return readFileSync(0, 'utf8');
	} catch {
		return '';
	}
}

const [, , cmd, ...args] = process.argv;

async function main() {
	if (cmd === 'resolve') {
		console.log(JSON.stringify(resolveCtx(), null, 1));
		return;
	}
	if (cmd === 'init') {
		const ctx = resolveCtx();
		if (!ctx.top) fail('git repo 아님');
		const common = sh('git rev-parse --path-format=absolute --git-common-dir');
		const exclude = join(common, 'info', 'exclude');
		const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
		if (!cur.split('\n').includes('WORK.md')) {
			appendFileSync(exclude, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}WORK.md\n`);
			console.log(`[worklog] ${exclude}에 WORK.md 추가`);
		} else {
			console.log('[worklog] 이미 등록됨');
		}
		return;
	}

	const cfg = loadConfig();

	if (cmd === 'read') {
		const title = args[0] || fail('제목 필요');
		const { status, data } = await api(cfg, '/notes/read', { title });
		if (status !== 200) fail(`read ${status}: ${JSON.stringify(data)}`, status === 404 ? 4 : 1);
		saveState(title, { lastPushedChangeDate: data.changeDate });
		console.log(JSON.stringify(data, null, 1));
		return;
	}
	if (cmd === 'write' || cmd === 'push-work') {
		const ctx = resolveCtx();
		const title = cmd === 'push-work' ? ctx.workTitle : args[0] || fail('제목 필요');
		const markdown = cmd === 'push-work'
			? (existsSync(ctx.workFile) ? readFileSync(ctx.workFile, 'utf8') : fail(`WORK.md 없음: ${ctx.workFile}`))
			: readStdin();
		const force = args.includes('--force');
		const state = loadState(title);
		const body = { title, markdown };
		if (force) body.force = true;
		else if (state.lastPushedChangeDate) body.ifChangeDate = state.lastPushedChangeDate;
		const { status, data } = await api(cfg, '/notes/write', body);
		if (status === 409) {
			console.error('[worklog] 충돌 — 원격(폰?)에 더 새 버전 있음. 아래가 원격 본문. 병합 후 재시도(read → write).');
			console.log(JSON.stringify(data, null, 1));
			process.exit(9);
		}
		if (status !== 200) fail(`write ${status}: ${JSON.stringify(data)}`);
		saveState(title, { lastPushedChangeDate: data.changeDate });
		console.log(JSON.stringify(data, null, 1));
		return;
	}
	if (cmd === 'append') {
		const title = args[0] || fail('제목 필요');
		const markdown = readStdin();
		if (!markdown.trim()) fail('stdin으로 markdown 필요');
		const { status, data } = await api(cfg, '/notes/append', { title, markdown });
		if (status !== 200) fail(`append ${status}: ${JSON.stringify(data)}`);
		console.log(JSON.stringify(data, null, 1));
		return;
	}
	if (cmd === 'list') {
		const { status, data } = await api(cfg, '/notes/list', {});
		if (status !== 200) fail(`list ${status}: ${JSON.stringify(data)}`);
		console.log(JSON.stringify(data, null, 1));
		return;
	}
	if (cmd === 'status') {
		// 훅용 — 절대 실패하지 않음. 요약 텍스트만 stdout.
		const ctx = resolveCtx();
		const state = loadState(ctx.workTitle);
		try {
			const { status, data } = await api(cfg, '/notes/read', { title: ctx.workTitle }, { timeoutMs: 3000 });
			if (status === 404) {
				console.log(`[worklog] 작업 노트 없음 (${ctx.workTitle}) — /worklog checkpoint가 생성함`);
			} else if (status !== 200) {
				console.log(`[worklog] 브릿지 응답 ${status} — 로컬 WORK.md 기준 진행`);
			} else if (state.lastPushedChangeDate && data.changeDate !== state.lastPushedChangeDate) {
				console.log(`[worklog] ⚠ 원격 수정 감지 (폰에서 고침?) — 노트 본문:\n${data.markdown}\n[worklog] WORK.md와 병합 후 push-work 필요`);
			} else {
				console.log(`[worklog] 노트=로컬 동기 상태 (changeDate ${data.changeDate})`);
			}
		} catch {
			console.log('[worklog] 브릿지 연결 실패 — 로컬 WORK.md 기준 진행 (fail-soft)');
		}
		return;
	}
	fail(`unknown command: ${cmd ?? '(none)'} — resolve|init|read|write|append|list|push-work|status`);
}

main().catch((e) => fail(String(e)));
```

- [ ] **Step 2: SKILL.md** — `~/.claude/skills/worklog/SKILL.md`

```markdown
---
name: worklog
description: 기록 중심 개발 — 프로젝트 기록(작업/스펙/로그)을 로컬 파일 워킹카피 + 톰보이 노트 미러로 관리. /worklog checkpoint(세션 마무리 저장), /worklog wrapup(기능 완료), /worklog spec(스펙 노트), /worklog boot(수동 부팅 읽기). 세션이 길어지면 compact 대신 checkpoint 후 새 세션.
---

# worklog — 기록이 주, 세션은 일회용

CLI: `node ~/.claude/skills/worklog/scripts/worklog.mjs <cmd>` (아래 `worklog`로 표기).
MCP 툴이 있으면(worklog_read/write/append/list) HTTP 대신 그걸 써도 됨 — 같은 백엔드.

## 모델

- **파일 = 워킹카피** (오프라인 보장): `WORK.md`(워크트리 루트), `docs/specs/`, `docs/plans/`
- **노트 = 리모트 미러** (크로스디바이스 + 폰 터치포인트): `[프로젝트/브랜치] 작업`, `[프로젝트] 로그`, `[프로젝트] 스펙: <기능>`, `[개발] 인박스`
- push 명시적(checkpoint/wrapup/spec), fetch 자동(SessionStart 훅). 충돌(409/exit 9)은 원격 본문이 반환되니 **병합 후 재push** — 사람 수정을 절대 덮지 마라.

## WORK.md 4섹션 (작업 노트와 동일 형식)

    ## 범위
    - 하는 것 / 안 하는 것
    ## 상태  (HEAD: <git short hash>, <날짜>)
    [x] 끝난 것
    [ ] 남은 것
    ## 결정·함정
    - 왜 이렇게, 밟은 지뢰
    ## 다음
    1. 새 세션이 첫 줄에 읽을 것

작성 규율: "지금 아는 것"이 아니라 **"내일의 내가 0에서 재개하는 데 필요한 것"**. 세션 일기는 .remember가 자동으로 함 — 중복 금지.

## 의식

### /worklog checkpoint — 세션 마무리(또는 큰 마일스톤)마다
1. `WORK.md` 4섹션 갱신 (상태에 `git rev-parse --short HEAD` 박기)
2. `worklog push-work` — exit 9(충돌)면 출력된 원격 본문과 병합해 WORK.md 재작성 후 재실행
3. 사용자에게 "기록 완료 — 세션 종료해도 됨" 보고. **compact 금지.**

### /worklog wrapup — 기능 완료 시
1. checkpoint 먼저
2. 로그 다이제스트 append: `worklog append "[<프로젝트>] 로그"` stdin으로
   `## <YYYY-MM-DD> <기능명>` + 커밋 범위 + 핵심 결정 2-3줄 + `[[<관련 노트>]]` 링크
3. `WORK.md`를 빈 템플릿으로 리셋 + `worklog push-work --force`
4. 교훈이 있으면 auto-memory로 승격 (상태성 항목은 노트에 남기고 memory엔 넣지 않기)

### /worklog spec — 설계 스펙 (brainstorm 산출물)
1. `docs/specs/<날짜>-<기능>.md` 작성 (무엇/왜/경계/열린 질문 + 첫 줄에 `상태: [ ] 승인`)
2. `worklog write "[<프로젝트>] 스펙: <기능>"` stdin으로 push
3. 사용자가 폰에서 검토·수정·`[x] 승인` 체크 → 다음 세션 훅/read가 감지 → 파일에 병합 → 구현 착수. 승인 전 구현 금지.

### /worklog boot — 훅이 안 돌았을 때 수동
`worklog resolve` → WORK.md 읽기 → `worklog status` → 원격 수정 있으면 병합.

## md 서브셋 (노트로 가는 모든 본문)

지원: `## 헤딩`, `- 리스트`(2칸 들여쓰기 중첩), `**bold**`, `` `code` ``, ``` 펜스(노트에선 줄별 monospace), `[[노트제목]]` 내부링크, `[x]`/`[ ]`(앱에서 탭 가능한 체크박스).
금지: 표, `---`(드롭됨 — hrSplit 트리거), 이미지, JSON 블롭(atomization 부패), **시크릿**(노트는 전 기기로 퍼짐).

## 제목 그램마

`[<프로젝트>/<브랜치>] 작업` / `[<프로젝트>] 로그` / `[<프로젝트>] 스펙: <기능>` / `[개발] 인박스`.
프로젝트/브랜치는 `worklog resolve`가 계산 (main repo 디렉토리명 + 현재 브랜치). **노트 제목 rename 절대 금지** — 링크가 깨짐. 새 제목이 필요하면 새 노트.

## 신규 프로젝트 셋업

`worklog init` (WORK.md gitignore) → WORK.md 템플릿 작성 → checkpoint. 끝.
```

- [ ] **Step 3: SessionStart 훅** — `~/.claude/hooks/worklog-session-start.sh` + `chmod +x`

```bash
#!/usr/bin/env bash
# worklog 부팅 컨텍스트 주입 — 항상 fail-soft (비 git / 브릿지 다운이어도 exit 0).
set -u
NODE=/var/home/umayloveme/.local/share/fnm/aliases/default/bin/node
SCRIPT="$HOME/.claude/skills/worklog/scripts/worklog.mjs"

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

printed=0
if [ -f "$top/WORK.md" ]; then
  echo "=== worklog: WORK.md (로컬 워킹카피) ==="
  cat "$top/WORK.md"
  printed=1
fi
if [ -x "$NODE" ] && [ -f "$SCRIPT" ] && [ -f "$HOME/.config/tomboy-worklog/env" ]; then
  out=$(timeout 6 "$NODE" "$SCRIPT" status 2>/dev/null) || out="[worklog] 브릿지 연결 실패 — 로컬 WORK.md 기준 진행"
  [ -n "$out" ] && { echo "$out"; printed=1; }
fi
[ "$printed" = 1 ] && echo "=== worklog 끝 — 갱신은 /worklog checkpoint ==="
exit 0
```

- [ ] **Step 4: settings.json 훅 등록** — `~/.claude/settings.json`의 `hooks` 객체에 두 키 추가 (기존 Stop/Notification 유지, JSON 병합 편집)

```json
"SessionStart": [
  {
    "matcher": "*",
    "hooks": [
      { "type": "command", "command": "bash \"$HOME/.claude/hooks/worklog-session-start.sh\"" }
    ]
  }
],
"PreCompact": [
  {
    "matcher": "*",
    "hooks": [
      { "type": "command", "command": "echo '[worklog] compact 대신 /worklog checkpoint 후 새 세션 권장 — 기록이 주, 세션은 일회용'" }
    ]
  }
]
```

- [ ] **Step 5: 설정 파일 골격** — `~/.config/tomboy-worklog/env` (0600; 실값은 Task 7)

```bash
mkdir -p ~/.config/tomboy-worklog
cat > ~/.config/tomboy-worklog/env <<'EOF'
BRIDGE_URL=PLACEHOLDER_TASK7
BRIDGE_SECRET=PLACEHOLDER_TASK7
EOF
chmod 600 ~/.config/tomboy-worklog/env
```

- [ ] **Step 6: 검증**

Run: `node ~/.claude/skills/worklog/scripts/worklog.mjs resolve` (이 워크트리에서)
Expected: `"project": "tomboy-web"`, `"branch": "shifu"`, `"workTitle": "[tomboy-web/shifu] 작업"`

Run: `node ~/.claude/skills/worklog/scripts/worklog.mjs init && node ~/.claude/skills/worklog/scripts/worklog.mjs init`
Expected: 1회차 "추가", 2회차 "이미 등록됨" (멱등)

Run: `bash ~/.claude/hooks/worklog-session-start.sh; echo "exit=$?"`
Expected: exit=0 (WORK.md 없고 env가 placeholder라 브릿지 경고 or 침묵 — 어느 쪽이든 0)

Run: `python3 -m json.tool ~/.claude/settings.json >/dev/null && echo OK`
Expected: OK

- [ ] **Step 7: Commit 없음** (repo 밖 파일) — 대신 변경 목록을 대화에 보고

### Task 7: Pi 프로비저닝 + 배포 + 라이브 검증

**Goal:** notes-creds.json을 Pi에 배치, 브릿지 재배포, 데스크탑에서 `/notes/list` 라이브 200 + MCP 등록.

**Files:**
- Create (Pi): `~/.config/term-bridge/notes-creds.json` (0600)
- Modify: `~/.config/tomboy-worklog/env` (placeholder → 실값)
- MCP 등록: `claude mcp add --scope user`

**Acceptance Criteria:**
- [ ] Pi에 creds 파일 (uid = pipeline.yaml `firebase_uid`, SA = `firebase_service_account` JSON, notebook 개발)
- [ ] 브릿지 재배포 후 `/notes/list` → 200 `{"notes":[...]}`; `/notes/read` 존재하지 않는 제목 → 404 (500/503 아님)
- [ ] 인증 없는 요청 → 401
- [ ] `claude mcp list`에 worklog 표시
- [ ] Pi에서 기존 서비스 무영향 (`systemctl --user status term-bridge` active, `/health` 200)

**Verify:** `node ~/.claude/skills/worklog/scripts/worklog.mjs list` → `{"notes":[]}` 또는 기존 목록 (에러 아님)

**Steps:**

- [ ] **Step 1: uid/SA 수집** (데스크탑)

```bash
# pipeline.yaml에서 uid + SA 경로 추출
grep -E '^(firebase_uid|firebase_service_account):' \
  /var/home/umayloveme/workspace/tomboy-web/pipeline/config/pipeline.yaml
```

Expected: `firebase_uid: dbx-...` + SA JSON 절대경로. 파일이 없으면 main 체크아웃(`/var/home/umayloveme/workspace/tomboy-web/pipeline/config/pipeline.yaml`) 확인.

- [ ] **Step 2: notes-creds.json 조립 + Pi 전송**

```bash
# 스크래치패드에서 조립 (SA_PATH/UID는 Step 1 값으로 치환)
python3 - <<'EOF'
import json, pathlib
sa = json.loads(pathlib.Path("SA_PATH").read_text())
out = {"uid": "UID", "notebook": "개발", "serviceAccount": {
    "project_id": sa["project_id"], "client_email": sa["client_email"], "private_key": sa["private_key"]}}
p = pathlib.Path("/tmp/claude-1000/notes-creds.json"); p.write_text(json.dumps(out)); p.chmod(0o600)
print("project_id:", sa["project_id"])
EOF
scp -P 2222 /tmp/claude-1000/notes-creds.json umayloveme@192.168.219.110:.config/term-bridge/notes-creds.json
ssh -p 2222 umayloveme@192.168.219.110 'chmod 600 ~/.config/term-bridge/notes-creds.json'
rm /tmp/claude-1000/notes-creds.json
```

주의: project_id가 앱 `PUBLIC_FIREBASE_PROJECT_ID`(= tomboy-web)와 같아야 함. 다르면 중단하고 사용자에게 보고.

- [ ] **Step 3: 브랜치 push + 배포**

```bash
git push origin shifu   # Pi가 pull할 수 있게
cd bridge && BRIDGE_DEPLOY_BRANCH=shifu npm run deploy
```

`bridge/.env`에 `BRIDGE_DEPLOY_HOST`가 없으면 `bridge/.env.example` 참고해 사용자에게 물어볼 것. deploy가 branch 옵션을 무시하면 Pi에서 수동: `ssh -p 2222 umayloveme@192.168.219.110 'cd ~/tomboy-web && git fetch && git checkout shifu && git pull'` 후 deploy 재실행. **main 머지는 사용자 결정 — 임의 머지 금지.**

- [ ] **Step 4: env 실값 채우기** (데스크탑)

```bash
# BRIDGE_URL: Pi LAN 기본. 공개 URL(duckdns)은 bridge/deploy/Caddyfile 확인 후 선택.
ssh -p 2222 umayloveme@192.168.219.110 'grep -E "^BRIDGE_SECRET=" ~/.config/term-bridge.env'
# 출력값으로 ~/.config/tomboy-worklog/env 의 두 placeholder 교체:
#   BRIDGE_URL=http://192.168.219.110:3000   (Caddyfile상 https 공개 경로가 있으면 그걸 우선)
#   BRIDGE_SECRET=<위 출력값>
chmod 600 ~/.config/tomboy-worklog/env
```

- [ ] **Step 5: 라이브 검증**

```bash
node ~/.claude/skills/worklog/scripts/worklog.mjs list
# → {"notes":[]} (200)
node ~/.claude/skills/worklog/scripts/worklog.mjs read "[없는프로젝트/x] 작업" ; echo "exit=$?"
# → read 404 에러 메시지 + exit=4
curl -s -o /dev/null -w '%{http_code}' -X POST "$BRIDGE_URL/notes/list" -d '{}'
# → 401 (토큰 없음)
ssh -p 2222 umayloveme@192.168.219.110 'systemctl --user --no-pager status term-bridge.service | head -5'
# → active (running)
```

- [ ] **Step 6: MCP 등록** (데스크탑, user 스코프 — 모든 프로젝트 공통)

```bash
source ~/.config/tomboy-worklog/env
claude mcp add --scope user --transport http worklog "${BRIDGE_URL}/mcp" \
  --header "Authorization: Bearer ${BRIDGE_SECRET}"
claude mcp list   # → worklog 표시
```

- [ ] **Step 7: Commit** (repo 변경분이 있으면 — 없으면 스킵)

---

### Task 8: 초기 노트 + 도그푸드 e2e + 문서화

**Goal:** 로그/인박스/작업 노트 실생성, 이 기능 자체를 첫 기록으로 checkpoint, 사용자가 앱에서 end-to-end 확인, CLAUDE.md·메모리 문서화.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Create: `WORK.md` (shifu 워크트리 루트, gitignored)
- Modify: `CLAUDE.md` (Cross-cutting infra invariants 섹션에 worklog 항목)
- Create: 메모리 `project_worklog_system.md` + MEMORY.md 인덱스 줄
- 노트 3개: `[tomboy-web] 로그`, `[개발] 인박스`, `[tomboy-web/shifu] 작업`

**Acceptance Criteria:**
- [ ] `worklog append "[tomboy-web] 로그"` + `worklog write "[개발] 인박스"` + `worklog push-work` 전부 200
- [ ] `worklog list` → 노트 3개 표시
- [ ] `worklog read "[tomboy-web/shifu] 작업"` markdown이 WORK.md와 동일 내용
- [ ] **사용자 확인 (게이트):** 앱(폰 또는 데스크탑, Firestore 실시간 동기화 ON)에서 — ① 전체 페이지 노트북 필터 '개발'에 노트 3개 표시, ② 작업 노트 열면 섹션 bold + `[x]`/`[ ]`가 탭 가능한 체크박스로 렌더, ③ `[[...]]` 내부링크 클릭 시 로그 노트로 이동, ④ 앱에서 체크박스 하나 토글 저장 후 데스크탑 `worklog read`에 토글 반영( `[x]`↔`[ ]` )
- [ ] SessionStart 훅이 새 세션에서 WORK.md + 동기 상태를 실제 주입 (새 claude 세션 1회 열어 확인)
- [ ] CLAUDE.md에 브릿지 `/notes`·`/mcp`·제목 가드·rename 금지 요약 추가, 메모리 파일 작성

**Verify:** `node ~/.claude/skills/worklog/scripts/worklog.mjs list` → 3개; 사용자 구두 확인 ①~④ 캡처

**Steps:**

- [ ] **Step 1: WORK.md 작성** (이 기능의 실제 상태로 — 4섹션 템플릿, 상태에 실 HEAD)

- [ ] **Step 2: 노트 생성**

```bash
W=~/.claude/skills/worklog/scripts/worklog.mjs
printf '## 2026-07-16 tomboy-worklog 시스템 구축\n- 브릿지 /notes + /mcp + 전역 스킬 + 훅\n- 기록 중심 개발 전환: 파일=워킹카피, 노트=미러\n- 관련: [[[tomboy-web/shifu] 작업]]' | node $W append "[tomboy-web] 로그"
printf '아이디어/스킬 요청을 여기에 한 줄씩. 다음 세션이 읽고 처리.\n\n- (비어있음)' | node $W write "[개발] 인박스"
node $W push-work
node $W list
```

- [ ] **Step 3: 사용자 게이트 — 앱 확인 ①~④** (AskUserQuestion으로 결과 수집, 실패 항목은 원인 수정 후 재확인)

- [ ] **Step 4: 새 세션 훅 확인** — 사용자가 이 워크트리에서 `claude` 새 세션 열어 부팅 컨텍스트에 WORK.md 주입 확인

- [ ] **Step 5: 문서화** — CLAUDE.md "Cross-cutting infra invariants"에 추가:

```markdown
- **워크로그 노트 채널**: 브릿지 `/notes/{read,write,append,list}` + `/mcp`가 Firestore `users/{uid}/notes`에 직접 쓴다(일기 s4_write와 동일 스키마·serverUpdatedAt 트랜스폼). 가드 = 제목 `[네임스페이스] 이름` + `system:notebook:개발` 태그. **브릿지发 rename 금지**(백링크 캐스케이드는 앱측 전용). creds `BRIDGE_NOTES_FILE`(Pi). 클라이언트는 `~/.claude/skills/worklog/`.
```

메모리 `project_worklog_system.md`: 시스템 존재/구성/제목 그램마/스킬 위치/충돌 규약 요약 + MEMORY.md 한 줄.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-07-16-tomboy-worklog.md
git commit -m "docs: worklog 노트 채널 invariant + 구현 플랜"
```

```json:metadata
{"userGate": true, "tags": ["user-gate"], "verifyCommand": "node ~/.claude/skills/worklog/scripts/worklog.mjs list", "acceptanceCriteria": ["worklog list에 노트 3개", "앱 개발 노트북 필터에 3개 표시(사용자 확인)", "작업 노트 체크박스 탭 가능 + 토글이 worklog read에 반영(사용자 확인)", "내부링크 이동 동작(사용자 확인)", "새 세션 SessionStart 훅이 WORK.md 주입(사용자 확인)"]}
```

---

## Self-Review 결과

- **스펙 커버리지**: 브릿지 API(T2-5), md↔XML(T1), MCP(T4), 스킬+훅(T6), 프로비저닝(T7), 초기 노트+게이트(T8) — 설계 요약의 모든 항목에 태스크 존재. 스펙/계획 노트 의식은 T6 SKILL.md에 정의(별도 코드 불필요).
- **플레이스홀더**: T7 Step 2의 `SA_PATH`/`UID`는 Step 1 출력값 치환 — 실행 시 결정되는 값으로 의도된 것. `PLACEHOLDER_TASK7`도 동일(T7 Step 4가 채움).
- **타입 일관성**: `NotesCreds`/`NoteDoc`/`NotesStore`(T2 정의) ↔ T3/T4 사용 일치. `notesAuthorized`/`NotesOpError`/코어 op 4종은 T3 export, T4 import 일치. `mdToNoteContent(title, md)`/`noteContentToMd(xml)` 시그니처 T1↔T3 일치.
- **알려진 추정치 2개** (실행 중 검증): ① T1 XML fixture의 리스트 `\n` 배치 — 앱측 바이트 라운드트립 테스트가 진실, 불일치 시 직렬화기 수정. ② app 테스트의 `deserializeContent`/`serializeContent` import 경로/시그니처 — 실물 확인 후 조정.





