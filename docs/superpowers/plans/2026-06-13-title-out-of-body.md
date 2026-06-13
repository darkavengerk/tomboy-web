# 타이틀 본문 분리 + 타이틀 다이얼로그 + 생성 로딩 표시 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 타이틀을 편집 본문에서 분리(데이터는 첫 줄로 유지, 에디터는 숨김)하고, 생성·수정용 타이틀 다이얼로그(노트종류 드롭다운+노트북)와 생성 단계별 로딩 표시를 추가한다.

**Architecture:** 불변식 `note.title ≡ <note-content> 첫 줄 ≡ <title>` 는 그대로. 새 PM 플러그인 `titleIsolation` 이 첫 top-level 노드를 데코레이션으로 숨기고 커서/Backspace 를 가드한다. 타이틀 입력/수정은 공용 `NoteTitleDialog` 로 분리하고, 생성 플로우는 전역 rune 스토어 `newNoteFlow` 가 네비게이션을 넘어 단계(ms)를 추적한다. 타이틀 변경은 기존 rename 캐스케이드(`rewriteBacklinksForRename` + `emitNoteReload`)를 재사용하는 `renameNote` 로 처리한다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, IndexedDB(idb), vitest + @testing-library/svelte, fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-06-13-title-out-of-body-design.md`

---

## File Structure

| File | 책임 | 상태 |
|---|---|---|
| `app/src/lib/noteTypes/registry.ts` | 노트종류 카탈로그 + 스캐폴드 합성(순수) | 신규 |
| `app/src/lib/editor/titleIsolation/titleIsolationPlugin.ts` | 첫 줄 숨김 + 커서/Backspace 가드 PM 플러그인 | 신규 |
| `app/src/lib/components/NoteTitleDialog.svelte` | 생성/수정 공용 다이얼로그(입력+진행) | 신규 |
| `app/src/lib/stores/newNoteFlow.svelte.ts` | 전역 생성 플로우 + 단계 계측 | 신규 |
| `app/src/lib/core/noteManager.ts` | `createNote` 확장 + `renameNote` 신규 | 수정 |
| `app/src/lib/editor/TomboyEditor.svelte` | `titleIsolation` 배선 + `onnoteready` | 수정 |
| `app/src/routes/+layout.svelte` | 다이얼로그 호스트 마운트 | 수정 |
| `app/src/lib/components/TopNav.svelte` | "+" → newNoteFlow | 수정 |
| `app/src/lib/desktop/SidePanel.svelte` | "새 노트" → newNoteFlow | 수정 |
| `app/src/routes/note/[id]/+page.svelte` | 타이틀 바 + editTitle + onnoteready | 수정 |
| `app/src/lib/editor/NoteActionSheet.svelte` | `editTitle` 액션 | 수정 |
| `app/src/lib/editor/NoteContextMenu.svelte` | `editTitle` 액션 | 수정 |
| `app/src/lib/desktop/NoteWindow.svelte` | 윈도우 타이틀 더블클릭 + hideTitleLine | 수정 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 2장 | 수정 |

---

### Task 0: 노트종류 레지스트리 (순수 모듈)

**Goal:** 13종 whole-note 타입 + `plain` 카탈로그와 스캐폴드 합성 헬퍼를 한 곳에 정의한다.

**Files:**
- Create: `app/src/lib/noteTypes/registry.ts`
- Test: `app/tests/unit/noteTypes/registry.test.ts`

**Acceptance Criteria:**
- [ ] `NOTE_TYPES` 가 `plain` 포함 14개 항목을 가진다.
- [ ] `composeTitle('automation','x')` → `'자동화::x'`; `composeTitle('terminal','x')` → `'x'`.
- [ ] `bodyFirstLine('terminal')` → `'ssh://user@host'`; `bodyFirstLine('automation')` → `undefined`.
- [ ] `getNoteType('nope')` → `undefined`.

**Verify:** `cd app && npx vitest run tests/unit/noteTypes/registry.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

Create `app/tests/unit/noteTypes/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	NOTE_TYPES,
	getNoteType,
	composeTitle,
	bodyFirstLine
} from '$lib/noteTypes/registry.js';

describe('noteTypes registry', () => {
	it('plain 포함 14종을 노출한다', () => {
		expect(NOTE_TYPES.length).toBe(14);
		expect(NOTE_TYPES[0].id).toBe('plain');
		expect(getNoteType('terminal')?.label).toContain('터미널');
	});

	it('title-prefix 타입은 접두어를 붙인다', () => {
		expect(composeTitle('automation', '매출')).toBe('자동화::매출');
		expect(composeTitle('data', '매출')).toBe('DATA::매출');
		expect(composeTitle('music-extract', 'p')).toBe('음악추출::p');
	});

	it('body-signature/plain 타입은 타이틀을 그대로 둔다', () => {
		expect(composeTitle('terminal', '서버')).toBe('서버');
		expect(composeTitle('plain', '메모')).toBe('메모');
	});

	it('body-signature 타입만 본문 시그니처 줄을 준다', () => {
		expect(bodyFirstLine('terminal')).toBe('ssh://user@host');
		expect(bodyFirstLine('chat-ollama')).toBe('llm://qwen2.5-coder:3b');
		expect(bodyFirstLine('automation')).toBeUndefined();
		expect(bodyFirstLine('plain')).toBeUndefined();
	});

	it('알 수 없는 id 는 undefined', () => {
		expect(getNoteType('nope')).toBeUndefined();
		expect(composeTitle('nope', 'x')).toBe('x');
		expect(bodyFirstLine('nope')).toBeUndefined();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/noteTypes/registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: 레지스트리 구현**

Create `app/src/lib/noteTypes/registry.ts`:

```ts
/**
 * 노트종류 카탈로그 — 생성 다이얼로그의 드롭다운/스캐폴드/도움말의 단일 출처.
 * 순수 모듈(저장소 접근 없음). 각 parser 가 인식하는 최소 형식과 일치시킨다.
 *
 * trigger:
 *   'title-prefix'   — 타이틀 앞에 접두어를 붙여 인식 (자동화:: 등)
 *   'body-signature' — 본문 첫 보이는 줄(노트-content 2번째 줄) 시그니처 (ssh:// 등)
 *   'structural'     — 본문 구조로 인식 (일정 노트). 스캐폴드 없음.
 *   'plain'          — 일반 노트(기본값).
 */
export interface NoteTypeSpec {
	id: string;
	label: string;
	trigger: 'title-prefix' | 'body-signature' | 'structural' | 'plain';
	/** title-prefix 타입의 타이틀 접두어. */
	titlePrefix?: string;
	/** body-signature 타입의 본문 첫 줄 시그니처(스캐폴드). */
	bodySignature?: string;
	/** 팝업 안내 + 예시(한국어). */
	help: string;
}

export const NOTE_TYPES: NoteTypeSpec[] = [
	{ id: 'plain', label: '일반 노트', trigger: 'plain', help: '평범한 노트입니다.' },
	{
		id: 'terminal', label: '터미널 (SSH)', trigger: 'body-signature',
		bodySignature: 'ssh://user@host',
		help: '본문 첫 줄을 ssh://[user@]host[:port] 로 두면 터미널이 열립니다. 예: ssh://pi@192.168.0.5'
	},
	{
		id: 'keys', label: '키 이벤트', trigger: 'body-signature',
		bodySignature: 'keys://user@host',
		help: '본문 첫 줄을 keys://[user@]host[:port] 로 두면 키 이벤트 전송 노트가 됩니다.'
	},
	{
		id: 'chat-ollama', label: '채팅 (Ollama)', trigger: 'body-signature',
		bodySignature: 'llm://qwen2.5-coder:3b',
		help: '본문 첫 줄 llm://<model> + Q:/A: 턴으로 로컬 Ollama 와 대화합니다.'
	},
	{
		id: 'chat-claude', label: '채팅 (Claude)', trigger: 'body-signature',
		bodySignature: 'claude://',
		help: '본문 첫 줄 claude:// + Q:/A: 턴으로 Claude 와 대화합니다(구독 OAuth).'
	},
	{
		id: 'ocr', label: 'OCR', trigger: 'body-signature',
		bodySignature: 'ocr://claude',
		help: '본문 첫 줄 ocr://<model>. 이미지를 붙이면 원문 추출 + 번역이 채워집니다.'
	},
	{
		id: 'remarkable-wallpaper', label: '리마커블 배경화면', trigger: 'body-signature',
		bodySignature: 'remarkable://rm2',
		help: '본문 첫 줄 remarkable://<alias>. 리마커블 배경화면을 설정합니다.'
	},
	{
		id: 'automation', label: '데이터 자동화', trigger: 'title-prefix',
		titlePrefix: '자동화::',
		help: '타이틀 자동화::<command-id>. ⟳ 실행 버튼으로 데스크탑 명령을 돌리고 DATA:: 차트를 갱신합니다.'
	},
	{
		id: 'data', label: '데이터/차트', trigger: 'title-prefix',
		titlePrefix: 'DATA::',
		help: '타이틀 DATA::<project>. 본문의 ```csv 펜스가 차트로 렌더됩니다.'
	},
	{
		id: 'music-extract', label: '음악 추출', trigger: 'title-prefix',
		titlePrefix: '음악추출::',
		help: '타이틀 음악추출::<이름>. 본문에 유튜브 URL 목록을 두면 ⟳ 로 mp3 추출합니다.'
	},
	{
		id: 'music', label: '음악 플레이리스트', trigger: 'title-prefix',
		titlePrefix: '음악::',
		help: '타이틀 음악::<이름>. 추출된 mp3 를 재생하는 플레이리스트입니다.'
	},
	{
		id: 'remarkable-upload', label: '리마커블 업로드', trigger: 'title-prefix',
		titlePrefix: '리마커블::',
		help: '타이틀 리마커블::<이름>. 📥 업로드 버튼으로 OCR 파이프라인에 수동 투입합니다.'
	},
	{
		id: 'schedule', label: '일정', trigger: 'structural',
		help: '본문에 N월 헤더 + 한글 날짜 리스트로 적으면 일정 노트가 됩니다(설정 → 알림에서 지정).'
	},
	{
		id: 'slip', label: 'Slip-Box', trigger: 'title-prefix',
		titlePrefix: 'Slip-Box::',
		help: '[0] Slip-Box 노트북의 링크드리스트 노드. 이전:/다음: 으로 연결합니다.'
	}
];

const BY_ID = new Map(NOTE_TYPES.map((t) => [t.id, t]));

export function getNoteType(id: string): NoteTypeSpec | undefined {
	return BY_ID.get(id);
}

/** 사용자가 입력한 raw 타이틀에 타입 접두어를 적용한 최종 타이틀. */
export function composeTitle(typeId: string, rawTitle: string): string {
	const t = BY_ID.get(typeId);
	return t?.titlePrefix ? t.titlePrefix + rawTitle : rawTitle;
}

/** body-signature 타입이면 본문 첫 줄 시그니처, 아니면 undefined. */
export function bodyFirstLine(typeId: string): string | undefined {
	return BY_ID.get(typeId)?.bodySignature;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/noteTypes/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/noteTypes/registry.ts app/tests/unit/noteTypes/registry.test.ts
git commit -m "feat(noteTypes): 노트종류 레지스트리 + 스캐폴드 합성"
```

---

### Task 1: `createNote` 확장 + `renameNote` 신규 (noteManager)

**Goal:** `createNote` 가 본문 시그니처/노트북 옵션을 받게 확장하고, 다이얼로그/메뉴용 `renameNote(guid, newTitle)` 를 추가한다(기존 rename 캐스케이드 재사용).

**Files:**
- Modify: `app/src/lib/core/noteManager.ts:53-101` (createNote), 신규 export `renameNote`, import 추가
- Test: `app/tests/unit/core/renameNote.test.ts`, `app/tests/unit/core/createNoteOptions.test.ts`

**Acceptance Criteria:**
- [ ] `createNote({ title, bodyFirstLine, notebook })` 가 본문 2번째 줄에 시그니처를, 태그에 노트북을 넣는다.
- [ ] `createNote('서버')`(문자열) 가 기존과 동일하게 동작한다(역호환).
- [ ] `renameNote` 가 충돌 시 `false`, 성공 시 첫 줄+`note.title` 동기 갱신 후 `true`.
- [ ] rename 후 `serializeNote → parseNote` 라운드트립에서 `<title>` 과 첫 줄이 새 제목으로 일치.

**Verify:** `cd app && npx vitest run tests/unit/core/renameNote.test.ts tests/unit/core/createNoteOptions.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성 — createNote 옵션**

Create `app/tests/unit/core/createNoteOptions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, getNote } from '$lib/core/noteManager.js';
import { getNotebook } from '$lib/core/notebooks.js';

describe('createNote 옵션', () => {
	it('bodyFirstLine 을 본문 2번째 줄로 시드한다', async () => {
		const n = await createNote({ title: '내 서버', bodyFirstLine: 'ssh://pi@host' });
		expect(n.title).toBe('내 서버');
		const lines = n.xmlContent
			.replace(/^<note-content[^>]*>/, '')
			.replace(/<\/note-content>$/, '')
			.split('\n');
		expect(lines[0]).toBe('내 서버');
		expect(lines[1]).toBe('ssh://pi@host');
	});

	it('notebook 옵션을 태그로 넣는다', async () => {
		const n = await createNote({ title: '업무 메모', notebook: '업무' });
		const fresh = await getNote(n.guid);
		expect(getNotebook(fresh!)).toBe('업무');
	});

	it('문자열 인자 역호환 — 날짜형 타이틀 시드 유지', async () => {
		const n = await createNote('2026-06-13');
		expect(n.xmlContent).toContain('2026년');
	});
});
```

- [ ] **Step 2: 실패 테스트 작성 — renameNote**

Create `app/tests/unit/core/renameNote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, renameNote, getNote } from '$lib/core/noteManager.js';
import { serializeNote } from '$lib/core/noteArchiver.js';
import { parseNote } from '$lib/core/noteArchiver.js';

describe('renameNote', () => {
	it('첫 줄과 note.title 을 함께 갱신하고 라운드트립이 일치한다', async () => {
		const n = await createNote({ title: '예전 제목' });
		const ok = await renameNote(n.guid, '새 제목');
		expect(ok).toBe(true);
		const fresh = await getNote(n.guid);
		expect(fresh!.title).toBe('새 제목');
		expect(fresh!.xmlContent).toContain('<note-content version="0.1">새 제목');
		// 라운드트립: <title> 과 첫 줄이 새 제목으로 일치
		const xml = serializeNote(fresh!);
		const reparsed = parseNote(xml, fresh!.uri);
		expect(reparsed.title).toBe('새 제목');
		expect(reparsed.xmlContent).toContain('새 제목');
	});

	it('빈/동일 제목은 no-op, 충돌은 false', async () => {
		const a = await createNote({ title: 'A 노트' });
		await createNote({ title: 'B 노트' });
		expect(await renameNote(a.guid, '   ')).toBe(false);
		expect(await renameNote(a.guid, 'A 노트')).toBe(true); // 동일 → no-op 성공
		expect(await renameNote(a.guid, 'B 노트')).toBe(false); // 충돌
	});
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/core/renameNote.test.ts tests/unit/core/createNoteOptions.test.ts`
Expected: FAIL (`renameNote` 없음 / 옵션 미지원).

- [ ] **Step 4: import 추가**

`app/src/lib/core/noteManager.ts` 상단 import 블록에 추가/수정:

```ts
import { createEmptyNote, formatTomboyDate, escapeXml, type NoteData } from './note.js';
```

그리고 titleRewrite import 에 `rewriteTitleInNoteContentXml` 추가:

```ts
import {
	prepareIncomingNoteForLocal,
	rewriteInternalLinkRefsInXml,
	rewriteTitleInNoteContentXml
} from './titleRewrite.js';
```

`bodyFirstLine` 스캐폴드는 호출부(스토어)에서 합성해 넘기므로 registry import 는 불필요. 노트북 태그는 인라인 처리(아래)로 notebooks 모듈 순환을 피한다. `renameNote` 의 충돌 검사는 이미 import 된 `noteStore.findNoteByTitle`(noteStore.ts:146) 를 쓰므로 추가 import 불필요.

- [ ] **Step 5: `createNote` 교체**

`app/src/lib/core/noteManager.ts:53-101` 의 `createNote` 전체를 교체:

```ts
export interface CreateNoteOptions {
	/** 최종 타이틀(이미 타입 접두어가 합성된 값). 미지정 시 날짜 자동 타이틀. */
	title?: string;
	/** 본문 첫 보이는 줄(note-content 2번째 줄) 시그니처. 예: 'ssh://user@host'. */
	bodyFirstLine?: string;
	/** 생성 후 지정할 노트북(없으면 미지정). */
	notebook?: string | null;
}

/** Create a new note and persist it to IndexedDB.
 *  문자열 인자는 `{ title }` 로 매핑(역호환). */
export async function createNote(arg?: string | CreateNoteOptions): Promise<NoteData> {
	const opts: CreateNoteOptions = typeof arg === 'string' ? { title: arg } : (arg ?? {});
	const explicitTitle = opts.title !== undefined;
	const guid = generateGuid();
	const note = createEmptyNote(guid);
	const title = opts.title ?? (await ensureUniqueTitle(formatDateTimeTitle(new Date())));
	note.title = title;

	if (opts.bodyFirstLine) {
		// Whole-note 타입 스캐폴드: 1줄=타이틀, 2줄=시그니처.
		note.xmlContent =
			`<note-content version="0.1">${escapeXml(title)}\n${escapeXml(opts.bodyFirstLine)}\n\n</note-content>`;
	} else {
		// 기존 동작: 날짜형 타이틀은 2번째 줄 연도 + 일정 시드.
		const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(title);
		const suffix = dateMatch ? `\n${dateMatch[1]}년\n` : `\n\n`;
		note.xmlContent = `<note-content version="0.1">${title}${suffix}</note-content>`;
		if (dateMatch) {
			const year = Number(dateMatch[1]);
			const month = Number(dateMatch[2]);
			const day = Number(dateMatch[3]);
			const seed = await buildDateNoteScheduleSeed(year, month, day);
			if (seed.length > 0) {
				const doc: JSONContent = {
					type: 'doc',
					content: [
						{ type: 'paragraph', content: [{ type: 'text', text: title }] },
						{ type: 'paragraph', content: [{ type: 'text', text: `${year}년` }] },
						...seed,
						{ type: 'paragraph' },
						{ type: 'paragraph' }
					]
				};
				note.xmlContent = serializeContent(doc);
			}
		}
	}

	// 노트북 태그 인라인(시스템 태그 prefix 는 notebooks.ts PREFIX 와 동일).
	// 다이얼로그가 고른 노트북은 이미 존재하거나 createNotebook 으로 캐시가
	// 갱신된 상태라, 인라인 태그만으로 캐시 정합이 유지된다.
	if (opts.notebook) {
		note.tags = note.tags.filter((t) => !t.startsWith('system:notebook:'));
		note.tags.push(`system:notebook:${opts.notebook}`);
	}

	await noteStore.putNote(note);
	// 명시 타이틀 → 본문에 커서, 자동 날짜 타이틀 → 타이틀 전체 선택.
	setNewNoteIntent(guid, explicitTitle ? 'bodyCursor' : 'selectTitle');
	notifyNoteSaved(guid);
	noteMutated(note);
	return note;
}
```

- [ ] **Step 6: `renameNote` 추가**

`rewriteBacklinksForRename`(현 `:191`) 정의 **바로 위**에 추가:

```ts
/**
 * 에디터 밖(타이틀 수정 다이얼로그/메뉴)에서 노트 제목을 바꾼다.
 * note-content 첫 줄 + note.title 동기 갱신 → 백링크 rename 캐스케이드 →
 * 열린 에디터 리로드. 충돌이면 아무것도 바꾸지 않고 false.
 */
export async function renameNote(guid: string, newTitle: string): Promise<boolean> {
	const note = await noteStore.getNote(guid);
	if (!note) return false;
	const trimmed = newTitle.trim();
	if (!trimmed) return false;
	if (trimmed === note.title) return true; // no-op (성공 취급)

	// 권위 있는 충돌 검사 — by-title IDB 인덱스를 읽는 full lookup 이라 워밍된
	// in-memory 인덱스에 의존하지 않는다(테스트/직접-IDB 경로에서도 정확).
	const existing = await noteStore.findNoteByTitle(trimmed);
	if (existing && existing.guid !== guid && !existing.deleted) return false;

	const oldTitle = note.title;
	const now = formatTomboyDate(new Date());
	note.title = trimmed;
	note.xmlContent = rewriteTitleInNoteContentXml(note.xmlContent, trimmed);
	note.changeDate = now;
	note.metadataChangeDate = now;
	await noteStore.putNote(note);
	notifyNoteSaved(guid);
	noteMutated(note);

	const affected = await rewriteBacklinksForRename(oldTitle, trimmed, guid);
	if (affected.length > 0) invalidateCache();
	// 자기 자신 + 백링크 대상 에디터를 리로드 — 자기 노트의 in-memory doc 은
	// 아직 옛 첫 줄을 들고 있어 리로드하지 않으면 다음 저장에 덮어쓴다.
	await emitNoteReload([guid, ...affected]);
	return true;
}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/core/renameNote.test.ts tests/unit/core/createNoteOptions.test.ts`
Expected: PASS.

- [ ] **Step 8: 타입 체크 + 커밋**

```bash
cd app && npm run check 2>&1 | grep -E "noteManager|renameNote" || echo "no new type errors"
git add app/src/lib/core/noteManager.ts app/src/lib/core/note.ts app/tests/unit/core/renameNote.test.ts app/tests/unit/core/createNoteOptions.test.ts
git commit -m "feat(noteManager): createNote 옵션 확장 + renameNote 신규"
```

> 참고: `escapeXml` 은 이미 `note.js:112` 에 export 되어 있다. import 만 추가하면 된다.

---

### Task 2: `titleIsolation` ProseMirror 플러그인 (순수)

**Goal:** 첫 top-level 노드를 데코레이션으로 숨기고, 커서가 그 노드에 들어가면 둘째 블록으로 클램프, 첫 보이는 줄 맨 앞 Backspace 를 차단하는 PM 플러그인.

**Files:**
- Create: `app/src/lib/editor/titleIsolation/titleIsolationPlugin.ts`
- Test: `app/tests/unit/editor/titleIsolation.test.ts`

**Acceptance Criteria:**
- [ ] 활성 시 첫 노드에 `.tomboy-title-hidden` 데코레이션이 붙는다.
- [ ] 첫 노드 안으로 selection 을 옮기면 둘째 블록 시작으로 클램프된다.
- [ ] 둘째 블록 맨 앞 Backspace 가 차단된다(병합 안 됨).
- [ ] `enabled() === false` 면 아무 동작도 안 한다.

**Verify:** `cd app && npx vitest run tests/unit/editor/titleIsolation.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

Create `app/tests/unit/editor/titleIsolation.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
	createTitleIsolationPlugin,
	titleIsolationPluginKey
} from '$lib/editor/titleIsolation/titleIsolationPlugin.js';

let editor: Editor | null = null;
afterEach(() => { editor?.destroy(); editor = null; });

function makeEditor(enabled: boolean) {
	const ext = Extension.create({
		name: 'titleIsolationTest',
		addProseMirrorPlugins() {
			return [createTitleIsolationPlugin(() => enabled)];
		}
	});
	const el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({
		element: el,
		extensions: [StarterKit, ext],
		content: '<p>타이틀</p><p>본문 첫 줄</p>'
	});
}

describe('titleIsolation', () => {
	it('첫 노드를 .tomboy-title-hidden 으로 숨긴다', () => {
		editor = makeEditor(true);
		const firstP = editor.view.dom.querySelector('p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(true);
	});

	it('첫 노드로 들어간 커서를 둘째 블록 시작으로 클램프한다', () => {
		editor = makeEditor(true);
		// pos 1 = 첫 문단 텍스트 안
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		const first = editor.state.doc.firstChild!;
		// 둘째 블록 콘텐츠 시작 = first.nodeSize + 1
		expect(editor.state.selection.from).toBe(first.nodeSize + 1);
	});

	it('비활성이면 클램프하지 않는다', () => {
		editor = makeEditor(false);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		expect(editor.state.selection.from).toBe(1);
		const firstP = editor.view.dom.querySelector('p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(false);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/titleIsolation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: 플러그인 구현**

Create `app/src/lib/editor/titleIsolation/titleIsolationPlugin.ts`:

```ts
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isCursorInTitleBlock } from '$lib/editor/titleUniqueGuard.js';

export const titleIsolationPluginKey = new PluginKey('tomboyTitleIsolation');

/**
 * 첫 top-level 노드(=타이틀)를 화면에서 분리한다.
 *  1) `decorations` — 첫 노드에 `.tomboy-title-hidden`(display:none) 부여.
 *  2) `appendTransaction` — selection 이 첫 노드 안으로 들어가면 둘째 블록
 *     콘텐츠 시작으로 클램프(↑/Ctrl+Home/클릭 진입 차단).
 *  3) `handleKeyDown` — 둘째 블록 맨 앞 Backspace 가 타이틀로 병합되는 것을 차단.
 *
 * `enabled()` 클로저 게이트로 prop 토글이 에디터 재생성 없이 반영된다.
 * 데이터(문서)는 그대로 — 직렬화/추출/라운드트립 전부 무영향.
 */
export function createTitleIsolationPlugin(enabled: () => boolean): Plugin {
	return new Plugin({
		key: titleIsolationPluginKey,
		props: {
			decorations(state) {
				if (!enabled()) return null;
				const first = state.doc.firstChild;
				if (!first) return null;
				return DecorationSet.create(state.doc, [
					Decoration.node(0, first.nodeSize, { class: 'tomboy-title-hidden' })
				]);
			},
			handleKeyDown(view, event) {
				if (!enabled() || event.key !== 'Backspace') return false;
				const { selection, doc } = view.state;
				if (!selection.empty) return false;
				const first = doc.firstChild;
				if (!first || doc.childCount < 2) return false;
				// 둘째 블록 콘텐츠 시작 = first.nodeSize + 1.
				if (selection.from === first.nodeSize + 1) return true; // 병합 차단
				return false;
			}
		},
		appendTransaction(_transactions, _oldState, newState) {
			if (!enabled()) return null;
			const { doc, selection } = newState;
			if (doc.childCount < 2) return null; // 보호해 들어갈 둘째 블록 없음
			if (
				!isCursorInTitleBlock(doc, selection.anchor) &&
				!isCursorInTitleBlock(doc, selection.head)
			) {
				return null;
			}
			const first = doc.firstChild!;
			const target = Math.min(first.nodeSize + 1, doc.content.size);
			return newState.tr.setSelection(TextSelection.create(doc, target));
		}
	});
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/titleIsolation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/titleIsolation/ app/tests/unit/editor/titleIsolation.test.ts
git commit -m "feat(editor): titleIsolation 플러그인 — 첫 줄 숨김 + 커서/Backspace 가드"
```

---

### Task 3: `titleIsolation` + `onnoteready` 를 TomboyEditor 에 배선

**Goal:** 에디터에 `hideTitleLine`(기본 false) prop 과 `onnoteready` 콜백을 추가하고, 플러그인 등록 + 첫 줄 숨김 CSS + 콘텐츠 스왑 완료 신호를 건다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` — Props 인터페이스(`:248` 부근), 구조분해(`:250-280`), 플러그인 등록(`:518` 부근 패턴), `$effect` 스왑(`:1215`,`:1277`), `<style>` 끝
- Test: `app/tests/unit/editor/tomboyEditorTitleHide.test.ts`

**Acceptance Criteria:**
- [ ] `hideTitleLine={true}` 로 마운트하면 첫 문단에 `.tomboy-title-hidden` 이 붙는다.
- [ ] `onnoteready` 가 콘텐츠 스왑 후 호출된다.
- [ ] 기본값(`hideTitleLine` 미지정)에서는 첫 문단이 숨겨지지 않는다(기존 동작 보존).

**Verify:** `cd app && npx vitest run tests/unit/editor/tomboyEditorTitleHide.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

Create `app/tests/unit/editor/tomboyEditorTitleHide.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import TomboyEditor from '$lib/editor/TomboyEditor.svelte';

afterEach(() => cleanup());

const content = { type: 'doc', content: [
	{ type: 'paragraph', content: [{ type: 'text', text: '타이틀' }] },
	{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }
]};

describe('TomboyEditor hideTitleLine', () => {
	it('hideTitleLine=true 면 첫 문단을 숨긴다', async () => {
		const { container } = render(TomboyEditor, { props: { content, currentGuid: 'g1', hideTitleLine: true } });
		await new Promise((r) => setTimeout(r, 50));
		const firstP = container.querySelector('.ProseMirror p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(true);
	});

	it('기본값에서는 숨기지 않는다', async () => {
		const { container } = render(TomboyEditor, { props: { content, currentGuid: 'g2' } });
		await new Promise((r) => setTimeout(r, 50));
		const firstP = container.querySelector('.ProseMirror p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(false);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/tomboyEditorTitleHide.test.ts`
Expected: FAIL (`hideTitleLine` 무시됨).

- [ ] **Step 3: import + Props + 구조분해 추가**

`TomboyEditor.svelte` 의 import 블록(상단, 다른 플러그인 import 근처)에 추가:

```ts
import { createTitleIsolationPlugin } from "./titleIsolation/titleIsolationPlugin.js";
```

`Props` 인터페이스(`:248` 의 `enableNoteBundle?` 다음 줄, 닫는 `}` 앞)에 추가:

```ts
		/** 첫 top-level 줄(타이틀)을 에디터에서 숨기고 커서/Backspace 를 가드.
		 *  실제 노트 편집 화면(/note, NoteWindow)만 true. 번들 임베디드는 false. */
		hideTitleLine?: boolean;
		/** 콘텐츠 스왑(setContent)이 settle 된 뒤 1회 호출. 생성 로딩 플로우가
		 *  '에디터 여는 중' 단계를 종료하는 신호로 쓴다. */
		onnoteready?: (guid: string | null) => void;
```

구조분해(`:250-280` 의 `enableNoteBundle = true,` 다음)에 추가:

```ts
		hideTitleLine = false,
		onnoteready = () => {},
```

- [ ] **Step 4: 클로저 플래그 + 플러그인 등록**

다른 클로저 플래그(`hrSplitEnabledFlag` 부근, `:304`)에 추가:

```ts
	// titleIsolation enabled 게이트 — prop 을 클로저로 읽어 재생성 없이 반영.
	let hideTitleLineFlag = false;
```

prop 동기화 `$effect` 추가(다른 `$effect` 들 근처, 예: `sendListItemActive` $effect 뒤):

```ts
	$effect(() => {
		hideTitleLineFlag = hideTitleLine;
	});
```

extensions 배열에서 `tomboyGeoMap` Extension(`:512-517`) **다음**에 등록:

```ts
				Extension.create({
					name: "tomboyTitleIsolation",
					addProseMirrorPlugins() {
						return [createTitleIsolationPlugin(() => hideTitleLineFlag)];
					},
				}),
```

- [ ] **Step 5: onnoteready 발화**

`$effect` 스왑 블록의 시드 분기 끝(`:1215` `applyNewNoteIntent(ed, g);` **다음 줄**, `return;` 앞)에 추가:

```ts
			requestAnimationFrame(() => { if (!ed.isDestroyed) onnoteready(g); });
```

그리고 스왑 분기 끝(`:1277` `applyNewNoteIntent(ed, g);` **다음 줄**)에도 동일하게 추가:

```ts
		requestAnimationFrame(() => { if (!ed.isDestroyed) onnoteready(g); });
```

- [ ] **Step 6: 숨김 CSS**

`TomboyEditor.svelte` 의 `<style>` 블록 끝에 추가:

```css
	/* titleIsolation: 데코레이션으로 첫 top-level 줄(타이틀)을 숨긴다.
	   PM DOM 에 직접 붙는 클래스라 :global 필요. */
	:global(.ProseMirror .tomboy-title-hidden) {
		display: none;
	}
```

- [ ] **Step 7: 테스트 통과 + 타입 체크 + 커밋**

Run: `cd app && npx vitest run tests/unit/editor/tomboyEditorTitleHide.test.ts`
Expected: PASS.

```bash
cd app && npm run check 2>&1 | grep -E "TomboyEditor" || echo "no new type errors"
git add app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/tomboyEditorTitleHide.test.ts
git commit -m "feat(editor): TomboyEditor 에 titleIsolation + onnoteready 배선"
```

> 노트 번들 임베디드 에디터(`createNoteBundlePlugin` 의 `EditorComponent` 사용처, `:531` 부근)는 `hideTitleLine` 을 넘기지 않으므로 기본 false 로 기존 동작을 유지한다. 변경 불필요.

---

### Task 4: `NoteTitleDialog` 공용 다이얼로그

**Goal:** 생성/수정 공용 다이얼로그 — 타이틀(필수) + 노트종류 드롭다운(생성 모드, 스캐폴드 도움말) + 노트북 드롭다운 + 진행 단계 표시.

**Files:**
- Create: `app/src/lib/components/NoteTitleDialog.svelte`
- Test: `app/tests/unit/components/noteTitleDialog.test.ts`

**Acceptance Criteria:**
- [ ] 타이틀이 비면 확정 버튼이 비활성.
- [ ] 생성 모드에서 종류를 고르면 해당 `help` 텍스트가 보인다.
- [ ] 확정 시 `onsubmit({ title, typeId, notebook })` 가 입력값으로 호출된다.
- [ ] `progressStages` 가 주어지면 입력 대신 단계+ms 진행 뷰를 보여준다.

**Verify:** `cd app && npx vitest run tests/unit/components/noteTitleDialog.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

Create `app/tests/unit/components/noteTitleDialog.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';

afterEach(() => cleanup());

describe('NoteTitleDialog', () => {
	it('타이틀이 비면 확정 비활성, 입력하면 활성', async () => {
		const { getByRole, getByLabelText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: [], initialTitle: '', initialNotebook: null,
				onsubmit: () => {}, oncancel: () => {} }
		});
		const submit = getByRole('button', { name: '만들기' }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		await fireEvent.input(getByLabelText('타이틀'), { target: { value: '메모' } });
		expect(submit.disabled).toBe(false);
	});

	it('확정 시 입력값을 넘긴다', async () => {
		const onsubmit = vi.fn();
		const { getByRole, getByLabelText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: ['업무'], initialTitle: '', initialNotebook: null,
				onsubmit, oncancel: () => {} }
		});
		await fireEvent.input(getByLabelText('타이틀'), { target: { value: '서버' } });
		await fireEvent.click(getByRole('button', { name: '만들기' }));
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ title: '서버', typeId: 'plain' }));
	});

	it('progressStages 가 있으면 진행 뷰', () => {
		const { queryByLabelText, getByText } = render(NoteTitleDialog, {
			props: { mode: 'create', notebooks: [], initialTitle: '', initialNotebook: null,
				onsubmit: () => {}, oncancel: () => {},
				progressStages: [{ name: '노트 생성', ms: 12, status: 'done' }] }
		});
		expect(queryByLabelText('타이틀')).toBeNull();
		expect(getByText('노트 생성')).toBeTruthy();
		expect(getByText(/12\s*ms/)).toBeTruthy();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/components/noteTitleDialog.test.ts`
Expected: FAIL (component 없음).

- [ ] **Step 3: 컴포넌트 구현**

Create `app/src/lib/components/NoteTitleDialog.svelte`:

```svelte
<script lang="ts">
	import { NOTE_TYPES, getNoteType } from '$lib/noteTypes/registry.js';

	export interface Stage {
		name: string;
		ms: number | null;
		status: 'pending' | 'active' | 'done';
	}

	interface Props {
		mode: 'create' | 'edit';
		notebooks: string[];
		initialTitle?: string;
		initialNotebook?: string | null;
		/** 진행 단계가 주어지면 입력 폼 대신 진행 뷰를 표시. */
		progressStages?: Stage[];
		onsubmit: (r: { title: string; typeId: string; notebook: string | null }) => void;
		oncancel: () => void;
	}

	let {
		mode,
		notebooks,
		initialTitle = '',
		initialNotebook = null,
		progressStages,
		onsubmit,
		oncancel
	}: Props = $props();

	let title = $state(initialTitle);
	let typeId = $state('plain');
	let notebook = $state<string | null>(initialNotebook);

	const showProgress = $derived(!!progressStages && progressStages.length > 0);
	const helpText = $derived(getNoteType(typeId)?.help ?? '');
	const canSubmit = $derived(title.trim().length > 0);
	const confirmLabel = $derived(mode === 'create' ? '만들기' : '저장');

	function submit() {
		if (!canSubmit) return;
		onsubmit({ title: title.trim(), typeId, notebook });
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') oncancel();
		else if (e.key === 'Enter' && canSubmit) submit();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={() => !showProgress && oncancel()}></div>

<div class="dialog" role="dialog" aria-modal="true">
	{#if showProgress}
		<div class="dlg-title">새 노트 만드는 중…</div>
		<ul class="stages">
			{#each progressStages! as s (s.name)}
				<li class="stage" class:active={s.status === 'active'} class:done={s.status === 'done'}>
					<span class="stage-mark">{s.status === 'done' ? '✔' : s.status === 'active' ? '◉' : '○'}</span>
					<span class="stage-name">{s.name}</span>
					{#if s.ms !== null}<span class="stage-ms">{s.ms}ms</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<div class="dlg-title">{mode === 'create' ? '새 노트' : '제목 수정'}</div>

		<label class="field">
			<span class="field-label">타이틀</span>
			<input bind:value={title} placeholder="제목을 입력하세요" autofocus />
		</label>

		{#if mode === 'create'}
			<label class="field">
				<span class="field-label">종류</span>
				<select bind:value={typeId}>
					{#each NOTE_TYPES as t (t.id)}
						<option value={t.id}>{t.label}</option>
					{/each}
				</select>
			</label>
			{#if helpText}
				<p class="help">ℹ {helpText}</p>
			{/if}
		{/if}

		<label class="field">
			<span class="field-label">노트북</span>
			<select bind:value={notebook}>
				<option value={null}>없음</option>
				{#each notebooks as n (n)}
					<option value={n}>🗂 {n}</option>
				{/each}
			</select>
		</label>

		<div class="actions">
			<button class="btn" onclick={oncancel}>취소</button>
			<button class="btn primary" onclick={submit} disabled={!canSubmit}>{confirmLabel}</button>
		</div>
	{/if}
</div>

<style>
	.backdrop {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: var(--z-modal);
	}
	.dialog {
		position: fixed;
		left: 50%; top: 50%;
		transform: translate(-50%, -50%);
		width: min(92vw, 420px);
		background: var(--color-bg, #fff);
		border-radius: 14px;
		padding: 20px;
		z-index: var(--z-modal);
		box-shadow: 0 8px 40px rgba(0, 0, 0, 0.25);
		display: flex; flex-direction: column; gap: 14px;
	}
	.dlg-title { font-size: 1.05rem; font-weight: 700; color: var(--color-text, #111); }
	.field { display: flex; flex-direction: column; gap: 4px; }
	.field-label { font-size: 0.8rem; color: var(--color-text-secondary, #666); }
	.field input, .field select {
		padding: 10px 12px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 8px;
		font-size: 1rem;
		background: var(--color-bg, #fff);
		color: var(--color-text, #111);
	}
	.help {
		font-size: 0.85rem; line-height: 1.5;
		color: var(--color-text-secondary, #555);
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 10px 12px; border-radius: 8px; margin: 0;
	}
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	.btn {
		padding: 9px 16px; border: none; border-radius: 8px;
		font-size: 0.95rem; cursor: pointer;
		background: var(--color-bg-secondary, #eee); color: var(--color-text, #111);
	}
	.btn.primary { background: var(--color-primary, #1a73e8); color: #fff; }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.stage { display: flex; align-items: center; gap: 10px; color: var(--color-text-secondary, #888); }
	.stage.active { color: var(--color-text, #111); }
	.stage.done { color: var(--color-text, #111); }
	.stage-mark { width: 18px; text-align: center; }
	.stage-name { flex: 1; }
	.stage-ms { font-size: 0.8rem; color: var(--color-text-secondary, #888); font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/components/noteTitleDialog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/components/NoteTitleDialog.svelte app/tests/unit/components/noteTitleDialog.test.ts
git commit -m "feat(components): NoteTitleDialog 공용 생성/수정 다이얼로그"
```

---

### Task 5: `newNoteFlow` 전역 스토어 + 레이아웃 호스트

**Goal:** 입력→생성→네비게이션→에디터-준비를 잇고 단계(ms)를 추적하는 전역 rune 스토어와, 루트 레이아웃에 1회 마운트되는 다이얼로그 호스트.

**Files:**
- Create: `app/src/lib/stores/newNoteFlow.svelte.ts`
- Modify: `app/src/routes/+layout.svelte` (호스트 마운트)
- Test: `app/tests/unit/stores/newNoteFlow.test.ts`

**Acceptance Criteria:**
- [ ] `open()` → `phase==='input'`; `submit()` 진행 중 `phase==='creating'` + 3단계.
- [ ] `markEditorReady(guid)` 가 일치하는 guid 일 때 마지막 단계를 끝내고 `phase==='idle'`.
- [ ] `submit` 이 `createNote` 를 합성된 타이틀/시그니처/노트북으로 호출한다.

**Verify:** `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

Create `app/tests/unit/stores/newNoteFlow.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
import { getNote } from '$lib/core/noteManager.js';

describe('newNoteFlow', () => {
	beforeEach(() => newNoteFlow.cancel());

	it('open → input, submit → creating → ready → idle', async () => {
		let openedGuid: string | null = null;
		newNoteFlow.open({ notebook: null, navigate: (n) => { openedGuid = n.guid; } });
		expect(newNoteFlow.phase).toBe('input');

		const p = newNoteFlow.submit({ title: '서버', typeId: 'terminal', notebook: null });
		// 진행 시작
		expect(newNoteFlow.phase).toBe('creating');
		// navigate 가 호출될 때까지 기다렸다가 ready 신호
		await vi.waitFor(() => expect(openedGuid).not.toBeNull());
		newNoteFlow.markEditorReady(openedGuid!);
		await p;
		expect(newNoteFlow.phase).toBe('idle');

		const note = await getNote(openedGuid!);
		expect(note!.title).toBe('서버');
		expect(note!.xmlContent).toContain('ssh://user@host');
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts`
Expected: FAIL (store 없음).

- [ ] **Step 3: 스토어 구현**

Create `app/src/lib/stores/newNoteFlow.svelte.ts`:

```ts
import type { NoteData } from '$lib/core/note.js';
import { createNote } from '$lib/core/noteManager.js';
import { ensureTitleIndexReady } from '$lib/editor/autoLink/titleProvider.js';
import { ensureBacklinkIndexReady } from '$lib/core/backlinkIndex.js';
import { composeTitle, bodyFirstLine } from '$lib/noteTypes/registry.js';

export interface Stage {
	name: string;
	ms: number | null;
	status: 'pending' | 'active' | 'done';
}

type NavigateFn = (note: NoteData) => void | Promise<void>;

let phase = $state<'idle' | 'input' | 'creating'>('idle');
let stages = $state<Stage[]>([]);
let defaultNotebook = $state<string | null>(null);

let navigateFn: NavigateFn | null = null;
let pendingGuid: string | null = null;
let readyResolve: (() => void) | null = null;

const READY_TIMEOUT_MS = 5000;

function setStage(i: number, patch: Partial<Stage>) {
	stages[i] = { ...stages[i], ...patch };
}

export const newNoteFlow = {
	get phase() { return phase; },
	get stages() { return stages; },
	get defaultNotebook() { return defaultNotebook; },

	open(opts: { notebook?: string | null; navigate: NavigateFn }) {
		defaultNotebook = opts.notebook ?? null;
		navigateFn = opts.navigate;
		stages = [];
		phase = 'input';
	},

	cancel() {
		phase = 'idle';
		stages = [];
		navigateFn = null;
		pendingGuid = null;
		readyResolve = null;
	},

	/** 에디터가 새 노트 콘텐츠 스왑을 끝냈을 때 호출(TomboyEditor onnoteready). */
	markEditorReady(guid: string | null) {
		if (guid && guid === pendingGuid && readyResolve) {
			readyResolve();
			readyResolve = null;
		}
	},

	async submit(input: { title: string; typeId: string; notebook: string | null }) {
		phase = 'creating';
		stages = [
			{ name: '노트 생성', ms: null, status: 'active' },
			{ name: '인덱스 갱신', ms: null, status: 'pending' },
			{ name: '에디터 여는 중', ms: null, status: 'pending' }
		];

		// 1) 노트 생성
		let t0 = performance.now();
		const finalTitle = composeTitle(input.typeId, input.title);
		const note = await createNote({
			title: finalTitle,
			bodyFirstLine: bodyFirstLine(input.typeId),
			notebook: input.notebook
		});
		setStage(0, { ms: Math.round(performance.now() - t0), status: 'done' });

		// 2) 인덱스 갱신(에디터가 곧 await 하는 인덱스를 미리 데움)
		setStage(1, { status: 'active' });
		t0 = performance.now();
		await ensureTitleIndexReady();
		await ensureBacklinkIndexReady();
		setStage(1, { ms: Math.round(performance.now() - t0), status: 'done' });

		// 3) 에디터 여는 중 — 네비게이션 후 onnoteready 신호까지
		setStage(2, { status: 'active' });
		t0 = performance.now();
		pendingGuid = note.guid;
		const readyP = new Promise<void>((res) => { readyResolve = res; });
		await navigateFn?.(note);
		await Promise.race([
			readyP,
			new Promise<void>((res) => setTimeout(res, READY_TIMEOUT_MS))
		]);
		setStage(2, { ms: Math.round(performance.now() - t0), status: 'done' });

		phase = 'idle';
		pendingGuid = null;
		readyResolve = null;
		navigateFn = null;
	}
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: 레이아웃 호스트 마운트**

`app/src/routes/+layout.svelte` 의 `<script>` 에 import 추가:

```ts
	import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
	import { listNotebooks } from '$lib/core/notebooks.js';
```

`<script>` 안에 노트북 로드 상태 + 핸들러 추가:

```ts
	let flowNotebooks = $state<string[]>([]);
	$effect(() => {
		if (newNoteFlow.phase === 'input') {
			listNotebooks().then((n) => (flowNotebooks = n));
		}
	});
```

레이아웃 마크업의 최상위(다른 배너/토스트 호스트 옆, `{@render children()}` 뒤)에 추가:

```svelte
{#if newNoteFlow.phase === 'input'}
	<NoteTitleDialog
		mode="create"
		notebooks={flowNotebooks}
		initialNotebook={newNoteFlow.defaultNotebook}
		onsubmit={(r) => newNoteFlow.submit(r)}
		oncancel={() => newNoteFlow.cancel()}
	/>
{:else if newNoteFlow.phase === 'creating'}
	<NoteTitleDialog
		mode="create"
		notebooks={flowNotebooks}
		progressStages={newNoteFlow.stages}
		onsubmit={() => {}}
		oncancel={() => {}}
	/>
{/if}
```

- [ ] **Step 6: 타입 체크 + 커밋**

```bash
cd app && npm run check 2>&1 | grep -E "newNoteFlow|\+layout" || echo "no new type errors"
git add app/src/lib/stores/newNoteFlow.svelte.ts app/src/routes/+layout.svelte app/tests/unit/stores/newNoteFlow.test.ts
git commit -m "feat(stores): newNoteFlow 생성 플로우 + 레이아웃 다이얼로그 호스트"
```

> 진행 중(`creating`) 다이얼로그는 같은 `NoteTitleDialog` 를 `progressStages` 로 띄워 진행 뷰를 렌더한다. 입력값은 이미 `submit` 으로 넘어갔으므로 `onsubmit`/`oncancel` 은 no-op.

---

### Task 6: 생성 진입점 배선 (TopNav + SidePanel)

**Goal:** 모바일 "+" 와 데스크탑 "새 노트" 가 `createNote()` 직접 호출 대신 `newNoteFlow.open()` 을 쓴다.

**Files:**
- Modify: `app/src/lib/components/TopNav.svelte:50-63` (handleNewNote)
- Modify: `app/src/lib/desktop/SidePanel.svelte:131` 부근 (새 노트 핸들러)

**Acceptance Criteria:**
- [ ] 모바일 "+" → 타이틀 다이얼로그가 뜨고, 확정 시 새 노트로 이동.
- [ ] 게스트 모드는 공유 노트북을 기본 노트북으로 채운다.
- [ ] 데스크탑 "새 노트" → 다이얼로그 확정 시 새 윈도우가 열린다.

**Verify:** `cd app && npm run dev` → 모바일 폭에서 "+" 클릭 → 다이얼로그 → "만들기" → 노트 열림. 데스크탑 폭 `/desktop` 에서 "새 노트" 동일.

**Steps:**

- [ ] **Step 1: TopNav 배선**

`app/src/lib/components/TopNav.svelte` import 에 추가:

```ts
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
```

`handleNewNote`(`:50-63`)를 교체:

```ts
	async function handleNewNote() {
		if (mode.value === 'guest') {
			const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
			if (shared.length === 0) {
				pushToast('공유 노트북이 없습니다.', { kind: 'info' });
				return;
			}
			newNoteFlow.open({
				notebook: shared[0],
				navigate: (n) => goto(`/note/${n.guid}`)
			});
			return;
		}
		newNoteFlow.open({
			notebook: null,
			navigate: (n) => goto(`/note/${n.guid}`)
		});
	}
```

> `createNote`/`assignNotebook` import 가 이 파일에서 더는 안 쓰이면 svelte-check 경고가 날 수 있다. 다른 사용처가 없으면 import 에서 제거.

- [ ] **Step 2: SidePanel 배선**

`app/src/lib/desktop/SidePanel.svelte` import 에 추가:

```ts
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
```

`handleNew`(`:127-136`)를 교체 — 슬립노트 전용 경로(`createSlipNote`)는 유지하고, 일반 노트만 다이얼로그로 라우팅. 윈도우 오픈은 기존 `onopen` prop 사용:

```ts
	function handleNew() {
		if (selectedNotebook === SLIPBOX_NOTEBOOK) {
			// 슬립노트는 전용 생성 경로 유지(다이얼로그 미사용).
			void createSlipNote().then((note) => {
				if (selectedNotebook) void assignNotebook(note.guid, selectedNotebook);
				onopen(note.guid);
			});
			return;
		}
		newNoteFlow.open({
			notebook: selectedNotebook ?? null,
			navigate: (n) => onopen(n.guid)
		});
	}
```

> 기존 `selectedNotebook` → `assignNotebook` 로직은 `notebook` 옵션이 대체하므로 일반 경로에서 제거됨. `createNote` import 가 더는 안 쓰이면(다른 사용처 확인) import 에서 정리.

- [ ] **Step 3: 수동 검증 + 커밋**

```bash
cd app && npm run dev
# 모바일 폭: "+" → 다이얼로그 → "만들기" → 노트 열림 확인
# /desktop: "새 노트" → 다이얼로그 → 윈도우 열림 확인
git add app/src/lib/components/TopNav.svelte app/src/lib/desktop/SidePanel.svelte
git commit -m "feat: 새 노트 생성 진입점을 newNoteFlow 다이얼로그로 전환"
```

---

### Task 7: 모바일 노트 페이지 — 타이틀 바 + 수정 + onnoteready

**Goal:** `/note/[id]` 에 읽기전용 타이틀 바(별도 줄)를 추가하고, 더블클릭/“…” 메뉴로 제목 수정 다이얼로그를 열며, 에디터에 `hideTitleLine`/`onnoteready` 를 배선한다.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte` — 메타바 아래 타이틀 바(`:745` 부근), TomboyEditor props(`:788`), handleAction(`:601`), 다이얼로그 렌더(`:865` 부근), import/state
- Modify: `app/src/lib/editor/NoteActionSheet.svelte` — `editTitle` ActionKind + 버튼

**Acceptance Criteria:**
- [ ] 메타바 아래 타이틀 바가 `note.title` 을 읽기전용으로 보여준다.
- [ ] 타이틀 바 더블클릭 또는 "…" → "제목 수정" → 다이얼로그(기존 제목 프리필).
- [ ] 저장 시 `renameNote` 호출 + 충돌 토스트, 성공 시 본문 첫 줄/제목 갱신.
- [ ] 에디터에 `hideTitleLine={true}` 가 걸려 첫 줄이 숨겨진다.
- [ ] `onnoteready` 가 `newNoteFlow.markEditorReady` 로 연결된다.

**Verify:** `cd app && npm run dev` → 노트 열기: 본문에 제목 줄 없음 + 상단 타이틀 바 표시. 더블클릭 → 수정 → 본문/목록 반영.

**Steps:**

- [ ] **Step 1: NoteActionSheet 에 editTitle 추가**

`app/src/lib/editor/NoteActionSheet.svelte` 의 `ActionKind`(`:6-15`)에 `'editTitle'` 추가:

```ts
	export type ActionKind =
		| 'delete'
		| 'redownload'
		| 'editTitle'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'pickNotebook'
		| 'toggleScrollBottom'
		| 'compareWithServer'
		| 'viewXml';
```

`pickNotebook` 버튼(`:118-121`) **위**에 버튼 추가:

```svelte
				<button class="action-btn" onclick={() => onaction('editTitle')}>
					<span class="action-icon">✎</span>
					제목 수정
				</button>
```

- [ ] **Step 2: 노트 페이지 import + state**

`app/src/routes/note/[id]/+page.svelte` import 에 추가:

```ts
	import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';
	import { renameNote } from '$lib/core/noteManager.js';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
	import { listNotebooks } from '$lib/core/notebooks.js';
```

state(`:82-84` 부근)에 추가:

```ts
	let titleDialogOpen = $state(false);
	let titleDialogNotebooks = $state<string[]>([]);
```

- [ ] **Step 3: 타이틀 바 마크업**

`editor-meta-bar` 닫는 `</div>`(`:745`) **다음**에 추가:

```svelte
	{#if note}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="title-bar"
			ondblclick={openTitleDialog}
			title="더블클릭하면 제목을 수정합니다"
		>
			<span class="title-text">{note.title || '제목 없음'}</span>
			<button class="title-edit-btn" onclick={openTitleDialog} aria-label="제목 수정">✎</button>
		</div>
	{/if}
```

`<style>` 에 추가:

```css
	.title-bar {
		display: flex;
		align-items: center;
		gap: clamp(6px, 1.5vw, 12px);
		padding: clamp(6px, 1.5vw, 10px) clamp(10px, 3vw, 16px);
		border-bottom: 1px solid var(--color-border, #eee);
		cursor: pointer;
		user-select: none;
	}
	.title-text {
		flex: 1;
		font-size: clamp(1rem, 3.5vw, 1.15rem);
		font-weight: 700;
		color: var(--color-text, #111);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.title-edit-btn {
		border: none; background: none; cursor: pointer;
		font-size: 1rem; color: var(--color-text-secondary, #888);
		padding: 4px 6px;
	}
```

- [ ] **Step 4: 핸들러 추가**

`handleAction`(`:601`) 안, `if (kind === 'viewXml')` 블록 근처에 분기 추가:

```ts
		if (kind === 'editTitle') {
			openTitleDialog();
			return;
		}
```

스크립트에 핸들러 함수 추가(예: `handleAction` 근처):

```ts
	async function openTitleDialog() {
		titleDialogNotebooks = await listNotebooks();
		titleDialogOpen = true;
	}

	async function handleTitleSave(r: { title: string; notebook: string | null }) {
		if (!note) return;
		titleDialogOpen = false;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
		const ok = await renameNote(note.guid, r.title);
		if (!ok) {
			pushToast('이미 같은 제목의 노트가 있거나 제목이 비어 있습니다.', { kind: 'error' });
			return;
		}
		if (r.notebook !== currentNotebook) {
			await assignNotebook(note.guid, r.notebook);
		}
		const updated = await getNote(note.guid);
		if (updated) note = updated; // editorContent 재파생 → 에디터 스왑(새 첫 줄)
		pushToast('제목이 변경되었습니다.');
	}
```

> `assignNotebook` 은 이미 이 파일에서 import 되어 있다(노트북 피커). 없으면 `$lib/core/notebooks.js` 에서 추가 import.

- [ ] **Step 5: TomboyEditor props 배선**

`<TomboyEditor ... />`(`:788-813`)에 두 prop 추가(`onimageinserted` 옆):

```svelte
			hideTitleLine={true}
			onnoteready={(g) => newNoteFlow.markEditorReady(g)}
```

- [ ] **Step 6: 다이얼로그 렌더**

`NotebookPicker` 렌더 블록(`:886` 부근) 근처에 추가:

```svelte
{#if titleDialogOpen && note}
	<NoteTitleDialog
		mode="edit"
		notebooks={titleDialogNotebooks}
		initialTitle={note.title}
		initialNotebook={currentNotebook}
		onsubmit={(r) => handleTitleSave(r)}
		oncancel={() => (titleDialogOpen = false)}
	/>
{/if}
```

- [ ] **Step 7: 수동 검증 + 커밋**

```bash
cd app && npm run dev
# 노트 열기: 본문에 제목 줄 없음, 상단 타이틀 바 표시
# 더블클릭 → 다이얼로그 → 제목 변경 → 본문/목록/링크 반영
# "…" → "제목 수정" 동일 동작
git add app/src/routes/note/\[id\]/+page.svelte app/src/lib/editor/NoteActionSheet.svelte
git commit -m "feat(note): 타이틀 바 + 제목 수정 다이얼로그 + hideTitleLine/onnoteready 배선"
```

---

### Task 8: 데스크탑 패리티 (NoteWindow + NoteContextMenu)

**Goal:** 데스크탑에서도 첫 줄을 숨기고, 윈도우 타이틀 더블클릭/우클릭 메뉴로 제목 수정을 연다.

**Files:**
- Modify: `app/src/lib/editor/NoteContextMenu.svelte` — `editTitle` ActionKind + 항목
- Modify: `app/src/lib/desktop/NoteWindow.svelte` — TomboyEditor props, 윈도우 타이틀(`:1060`) 더블클릭, handleAction 분기, 다이얼로그 렌더

**Acceptance Criteria:**
- [ ] NoteWindow 의 에디터가 첫 줄을 숨긴다.
- [ ] 윈도우 타이틀 더블클릭 또는 우클릭 "제목 수정" → 다이얼로그.
- [ ] 저장 시 `renameNote` 로 갱신되고 윈도우 타이틀/본문 반영.

**Verify:** `cd app && npm run dev` → `/desktop` 에서 노트 윈도우: 첫 줄 숨김 + 타이틀 더블클릭 수정 동작.

**Steps:**

- [ ] **Step 1: NoteContextMenu 에 editTitle**

`app/src/lib/editor/NoteContextMenu.svelte` 의 `ActionKind`(`:7-15`)에 `'editTitle'` 추가하고, `toggleFavorite` 항목(`:110`) **위**에 메뉴 항목 추가:

```svelte
			<button class="item" onclick={() => onaction('editTitle')}>
				<span class="icon">✎</span>제목 수정
			</button>
			<div class="sep"></div>
```

- [ ] **Step 2: NoteWindow 배선**

`app/src/lib/desktop/NoteWindow.svelte` 에서(`pushToast` 는 `:45` 에 이미 import):

1. import 추가:
```ts
	import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';
	import { renameNote, getNote } from '$lib/core/noteManager.js';
	import { listNotebooks, assignNotebook, getNotebook } from '$lib/core/notebooks.js';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
```

2. state 추가:
```ts
	let titleDialogOpen = $state(false);
	let titleDialogNotebooks = $state<string[]>([]);
```

3. TomboyEditor(`:930`)에 두 prop 추가:
```svelte
				hideTitleLine={true}
				onnoteready={(g) => newNoteFlow.markEditorReady(g)}
```

4. 타이틀 바 div(`:877-882`, `onpointerdown={startDrag}` `onauxclick={handleTitleBarAuxClick}` 가 달린 `.title-bar`)에 `ondblclick` 추가:
```svelte
		onpointerdown={startDrag}
		onauxclick={handleTitleBarAuxClick}
		ondblclick={openTitleDialog}
```

5. 우클릭 메뉴 `handleAction`(`:739`)에 분기 추가(예: favorite 분기 근처):
```ts
		if (kind === 'editTitle') { void openTitleDialog(); return; }
```

6. 핸들러 추가:
```ts
	async function openTitleDialog() {
		titleDialogNotebooks = await listNotebooks();
		titleDialogOpen = true;
	}
	async function handleTitleSave(r: { title: string; notebook: string | null }) {
		titleDialogOpen = false;
		const ok = await renameNote(note.guid, r.title);
		if (!ok) { pushToast('이미 같은 제목의 노트가 있거나 제목이 비어 있습니다.', { kind: 'error' }); return; }
		if (r.notebook !== getNotebook(note)) await assignNotebook(note.guid, r.notebook);
		// 본문은 renameNote 의 emitNoteReload 로 리로드된다. 타이틀 바(titleDisplay)는
		// 로컬 note 에서 파생되므로 재조회로 갱신.
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		pushToast('제목이 변경되었습니다.');
	}
```
> `note` 가 prop(immutable)이라 재할당이 안 되면, NoteWindow 가 `note` 를 들고 있는 방식(세션 store/$derived)에 맞춰 `titleDisplay` 가 파생되는 소스를 갱신한다. `titleDisplay`(`:885`)가 `note.title` 에서 파생되면 위 재조회로 충분.

7. 다이얼로그 렌더(윈도우 마크업 안, 닫는 태그 근처):
```svelte
{#if titleDialogOpen}
	<NoteTitleDialog
		mode="edit"
		notebooks={titleDialogNotebooks}
		initialTitle={note.title}
		initialNotebook={getNotebook(note)}
		onsubmit={(r) => handleTitleSave(r)}
		oncancel={() => (titleDialogOpen = false)}
	/>
{/if}
```
> `NoteTitleDialog` 의 backdrop/dialog 는 `position:fixed` 지만 NoteWindow(`.note-window` = `position:absolute`+inline-z)는 자체 stacking context 라 윈도우 안에 갇힌다. Step 3(아래)에서 `NoteTitleDialog` 루트에 `use:portal` 을 적용해 body 로 띄운다(z 토큰 `--z-modal` 유지).

- [ ] **Step 3: NoteTitleDialog 에 portal 적용**

`app/src/lib/components/NoteTitleDialog.svelte` 의 backdrop/dialog 두 요소에 `use:portal` 추가하고 import:

```ts
	import { portal } from '$lib/utils/portal.js';
```
```svelte
<div class="backdrop" use:portal onclick={() => !showProgress && oncancel()}></div>
<div class="dialog" use:portal role="dialog" aria-modal="true">
```
> Task 4 의 컴포넌트 테스트는 portal 적용 후에도 `document.body` 에 렌더되므로 `render` 의 쿼리(getByRole 등)가 그대로 통과한다. 회귀 시 `within(document.body)` 사용.

- [ ] **Step 4: 수동 검증 + 커밋**

```bash
cd app && npm run dev
# /desktop: 노트 윈도우 첫 줄 숨김, 타이틀 더블클릭 → 수정 → 반영
cd app && npx vitest run tests/unit/components/noteTitleDialog.test.ts   # portal 회귀 확인
git add app/src/lib/editor/NoteContextMenu.svelte app/src/lib/desktop/NoteWindow.svelte app/src/lib/components/NoteTitleDialog.svelte
git commit -m "feat(desktop): NoteWindow 제목 수정 다이얼로그 + hideTitleLine + portal"
```

---

### Task 9: 가이드 카드 (설정 → 가이드)

**Goal:** CLAUDE.md 규약대로 새 기능을 설정 가이드에 문서화한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` — `notes` 탭(`:1556` 부근)에 생성 카드, `editor` 탭(`:1942` 부근)에 타이틀 분리 카드

**Acceptance Criteria:**
- [ ] `notes` 탭에 "새 노트 만들기" 카드.
- [ ] `editor` 탭에 "타이틀은 본문에서 분리됨" 카드.
- [ ] 기존 `<details class="guide-card">` 패턴(summary + info-text + guide-list) 미러링.

**Verify:** `cd app && npm run dev` → 설정 → 가이드 → notes/editor 탭에서 카드 확인.

**Steps:**

- [ ] **Step 1: notes 탭 카드 추가**

`{#if guideSubTab === 'notes'}` 섹션(`:1556`)의 `<p class="info-text">` 안내문 **다음**에 추가:

```svelte
					<details class="guide-card" open>
						<summary>새 노트 만들기 — 제목·종류·노트북</summary>
						<p class="info-text">
							＋ 버튼을 누르면 팝업이 떠서 제목을 입력합니다(제목은 필수). 종류를 고르면
							터미널·채팅·자동화 같은 특수 노트의 형식이 자동으로 채워지고, 노트북도 함께 지정할 수 있습니다.
						</p>
						<ul class="guide-list">
							<li>종류 드롭다운 → 본문 시그니처(<code>ssh://</code> 등)나 제목 접두어(<code>자동화::</code> 등)를 자동 주입.</li>
							<li>생성 중에는 <strong>노트 생성 → 인덱스 갱신 → 에디터 여는 중</strong> 단계와 소요시간(ms)이 표시됩니다.</li>
							<li>제목이 비어 있으면 만들 수 없습니다.</li>
						</ul>
					</details>
```

- [ ] **Step 2: editor 탭 카드 추가**

`{:else if guideSubTab === 'editor'}` 섹션(`:1942`)의 첫 `<details class="guide-card" open>`(`:1950`) **앞**에 추가:

```svelte
				<details class="guide-card" open>
					<summary>제목은 본문에서 분리됩니다</summary>
					<p class="info-text">
						제목은 더 이상 본문 첫 줄로 편집하지 않습니다. 본문 위 <strong>제목 바</strong>에 표시되며,
						편집 본문은 둘째 줄부터 시작합니다.
					</p>
					<ul class="guide-list">
						<li>제목 수정: 제목 바를 <strong>더블클릭</strong>하거나 <strong>⋯ 메뉴 → 제목 수정</strong>.</li>
						<li>데이터(.note)에는 제목이 첫 줄로 그대로 저장됩니다 — Dropbox 동기화·내부 링크·노트 종류 인식에 영향 없음.</li>
						<li>이름을 바꾸면 이 노트를 가리키던 내부 링크가 자동으로 함께 갱신됩니다.</li>
					</ul>
				</details>
```

- [ ] **Step 3: 수동 검증 + 커밋**

```bash
cd app && npm run dev
# 설정 → 가이드 → notes/editor 탭 카드 확인
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): 타이틀 분리 + 새 노트 생성 가이드 카드"
```

---

## 최종 검증

- [ ] 전체 단위 테스트: `cd app && npm run test`
- [ ] 타입 체크: `cd app && npm run check`
- [ ] 수동 스모크: `npm run dev` →
  - 새 노트 생성(다이얼로그 + 단계 로딩) → 본문에 제목 줄 없음 + 타이틀 바 표시
  - 제목 수정(더블클릭/메뉴) → 본문 첫 줄·목록·역참조 링크 반영
  - 터미널/자동화 종류 선택 시 스캐폴드 주입 확인
  - 데스크탑 `/desktop` 윈도우 패리티
  - Dropbox 라운드트립(설정 → 지금 동기화) — `.note` 의 `<title>`/첫 줄 정상

## 후속(범위 밖)

- 측정값 기반 성능 최적화(에디터 mount 비용)
- 편집 모드 노트 타입 변환
- 종류별 맞춤 미니폼(host/user/port)
- 데스크탑 Ctrl+L 추출 생성 경로(현행 유지)
