# 음악 노트 (`음악::`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제목이 `음악::{이름}` 인 노트에서, `플레이리스트:{설명}` 헤더 다음 리스트의 아이템(제목+URL / URL만 2패턴)을 트랙으로 추출해 노트 전체를 하나의 연속 큐로 재생하는 상단 컨트롤 패널 + Ctrl-게이트 트랙별 버튼을 추가한다.

**Architecture:** 기존 4개 패턴 조합 — (1) `parseAutomationNote` 류 제목 prefix 감지, (2) `automationNotePlugin`/`sendListItemPlugin` 류 ProseMirror 데코레이션, (3) `ChatSendBar` 류 에디터-밖 컴포넌트 + `editor.on('update')` 재파싱, (4) `modKeys.ctrl` Ctrl-게이트(`sendActiveGate`). 순수 파서(`parseMusicNote`)와 전역 rune 스토어(`musicPlayer`)가 단일 진실원천. 재생 상태는 노트에 기록하지 않아 `.note` XML 라운드트립 보존.

**Tech Stack:** SvelteKit, Svelte 5 runes, TipTap 3 / ProseMirror, TypeScript, vitest + @testing-library/svelte, HTML5 `<audio>`.

**Spec:** `docs/superpowers/specs/2026-06-03-music-note-design.md`

---

### Task 1: `parseMusicNote` 순수 파서 + `deriveName`

**Goal:** PMNode doc → `MusicNote`(감지·플레이리스트·flatQueue) 변환하는 순수 함수와 URL→표시명 헬퍼를, 헤드리스 에디터 기반 테스트와 함께 구현.

**Files:**
- Create: `app/src/lib/music/parseMusicNote.ts`
- Test: `app/tests/unit/music/parseMusicNote.test.ts`

**Acceptance Criteria:**
- [ ] 제목 `음악::X` → `isMusic=true`, `name='X'`; `음악::` 만 → `isMusic=true`, `name=''`; 비음악 → `isMusic=false`, `flatQueue=[]`.
- [ ] `플레이리스트:` 헤더 바로 다음 리스트만 트랙으로 인식(헤더 없는 리스트·헤더와 리스트 사이 끼인 문단은 무시). bulletList/orderedList 모두 인정.
- [ ] 패턴 A(깊이1 제목 + 깊이2 URL)와 패턴 B(깊이1 URL) 모두 추출. `tomboyUrlLink` 마크 href도 인식. URL 없는 아이템은 스킵.
- [ ] 다중 플레이리스트 → `flatQueue` 가 문서 순서대로 평탄화. 각 트랙 `liPos` 가 해당 listItem 시작 pos.
- [ ] `deriveName('https://h/p/My%20Song.mp3') === 'My Song'`.

**Verify:** `cd app && npx vitest run tests/unit/music/parseMusicNote.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/parseMusicNote.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { parseMusicNote, deriveName } from '$lib/music/parseMusicNote.js';

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}
afterEach(() => { ed?.destroy(); ed = null; });

describe('parseMusicNote — detection', () => {
	it('detects 음악:: title and name', () => {
		const note = parseMusicNote(makeEditor('<p>음악::주말</p>').state.doc);
		expect(note.isMusic).toBe(true);
		expect(note.name).toBe('주말');
	});
	it('음악:: with empty name still music', () => {
		expect(parseMusicNote(makeEditor('<p>음악::</p>').state.doc).isMusic).toBe(true);
		expect(parseMusicNote(makeEditor('<p>음악::</p>').state.doc).name).toBe('');
	});
	it('non-music title', () => {
		const note = parseMusicNote(makeEditor('<p>그냥 노트</p>').state.doc);
		expect(note.isMusic).toBe(false);
		expect(note.flatQueue).toEqual([]);
	});
});

describe('parseMusicNote — track extraction', () => {
	it('pattern B: depth-1 URL item', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/b.mp3');
		expect(note.flatQueue[0].title).toBeNull();
		expect(note.flatQueue[0].display).toBe('b');
		expect(note.flatQueue[0].liPos).toBeGreaterThan(0);
	});
	it('pattern A: depth-1 title + depth-2 URL', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>Song A</p><ul><li><p>https://h/a.mp3</p></li></ul></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].title).toBe('Song A');
		expect(note.flatQueue[0].url).toBe('https://h/a.mp3');
		expect(note.flatQueue[0].display).toBe('Song A');
	});
	it('recognizes tomboyUrlLink mark href', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트:</p><ul><li><p><a class="tomboy-link-url" href="https://h/c.mp3">노래</a></p></li></ul>').state.doc
		);
		expect(note.flatQueue[0].url).toBe('https://h/c.mp3');
	});
	it('skips non-URL items, ignores lists without a 플레이리스트 header', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><ul><li><p>일반 메모</p></li></ul><p>플레이리스트: a</p><ul><li><p>설명만</p></li><li><p>https://h/d.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(1);
		expect(note.flatQueue[0].url).toBe('https://h/d.mp3');
	});
	it('flattens multiple playlists in document order', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: 아침</p><ul><li><p>https://h/1.mp3</p></li></ul><p>플레이리스트: 저녁</p><ul><li><p>https://h/2.mp3</p></li></ul>').state.doc
		);
		expect(note.playlists.map((p) => p.label)).toEqual(['아침', '저녁']);
		expect(note.flatQueue.map((t) => t.url)).toEqual(['https://h/1.mp3', 'https://h/2.mp3']);
	});
	it('header immediately followed required (intervening paragraph resets)', () => {
		const note = parseMusicNote(
			makeEditor('<p>음악::x</p><p>플레이리스트: a</p><p>끼어든 문단</p><ul><li><p>https://h/x.mp3</p></li></ul>').state.doc
		);
		expect(note.flatQueue).toHaveLength(0);
	});
});

describe('deriveName', () => {
	it('decodes filename and strips extension', () => {
		expect(deriveName('https://h/path/My%20Song.mp3')).toBe('My Song');
	});
	it('falls back to raw url when unparseable', () => {
		expect(deriveName('not a url')).toBe('not a url');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/parseMusicNote.test.ts`
Expected: FAIL — `Cannot find module '$lib/music/parseMusicNote.js'`

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/music/parseMusicNote.ts
import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const TITLE_PREFIX = '음악::';
const PLAYLIST_PREFIX = '플레이리스트:';
const URL_RE = /https?:\/\/[^\s<>"']+/;

export interface MusicTrack {
	url: string;
	title: string | null;
	display: string;
	liPos: number; // listItem 시작 pos (데코레이션 anchor)
}
export interface MusicPlaylist {
	label: string;
	tracks: MusicTrack[];
}
export interface MusicNote {
	isMusic: boolean;
	name: string;
	playlists: MusicPlaylist[];
	flatQueue: MusicTrack[];
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

/** node 안의 첫 http(s) URL — tomboyUrlLink 마크 href 우선, 없으면 본문 정규식. */
function firstUrlInNode(node: PMNode): string | null {
	let marked: string | null = null;
	node.descendants((n) => {
		if (marked) return false;
		if (n.isText) {
			const link = n.marks.find((m) => m.type.name === 'tomboyUrlLink');
			const href = link?.attrs?.href;
			if (typeof href === 'string' && URL_RE.test(href)) {
				marked = href;
				return false;
			}
		}
		return true;
	});
	if (marked) return marked;
	const m = URL_RE.exec(node.textContent);
	return m ? m[0] : null;
}

/** listItem 의 head 텍스트 = 첫 자식(문단) 텍스트, 중첩 리스트 제외. */
function listItemHead(li: PMNode): string {
	const first = li.firstChild;
	return first ? first.textContent.trim() : '';
}

function nestedListOf(li: PMNode): PMNode | null {
	let found: PMNode | null = null;
	li.forEach((child) => {
		if (!found && isListNode(child)) found = child;
	});
	return found;
}

export function deriveName(url: string): string {
	try {
		const u = new URL(url);
		const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
		const decoded = decodeURIComponent(seg);
		const noExt = decoded.replace(/\.[a-z0-9]+$/i, '');
		return noExt || url;
	} catch {
		return url;
	}
}

function extractTrack(li: PMNode, liPos: number): MusicTrack | null {
	const head = listItemHead(li);
	// 패턴 B: head 자체가 URL
	const headMatch = URL_RE.exec(head);
	if (headMatch && headMatch[0] === head.trim()) {
		const url = headMatch[0];
		return { url, title: null, display: deriveName(url), liPos };
	}
	// 패턴 A: head = 제목, 중첩 리스트 첫 아이템에 URL
	const nested = nestedListOf(li);
	if (nested && nested.firstChild) {
		const url = firstUrlInNode(nested.firstChild);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos };
	}
	// head 자체에 URL 이 끼어있는 단일-깊이 케이스도 허용(패턴 B 변형)
	if (headMatch) {
		const url = headMatch[0];
		return { url, title: null, display: deriveName(url), liPos };
	}
	return null;
}

export function parseMusicNote(doc: PMNode): MusicNote {
	const titleText = doc.firstChild?.textContent.trim() ?? '';
	const isMusic = titleText.startsWith(TITLE_PREFIX);
	const name = isMusic ? titleText.slice(TITLE_PREFIX.length).trim() : '';
	const playlists: MusicPlaylist[] = [];
	if (!isMusic) return { isMusic, name, playlists, flatQueue: [] };

	let pendingLabel: string | null = null;
	doc.forEach((block, offset) => {
		const blockType = block.type.name;
		if (blockType === 'paragraph') {
			const t = block.textContent.trim();
			pendingLabel = t.startsWith(PLAYLIST_PREFIX) ? t.slice(PLAYLIST_PREFIX.length).trim() : null;
			return;
		}
		if (isListNode(block) && pendingLabel !== null) {
			const tracks: MusicTrack[] = [];
			block.forEach((li, liOffset) => {
				if (li.type.name !== 'listItem') return;
				const liPos = offset + 1 + liOffset; // 리스트 content 시작 = offset+1
				const track = extractTrack(li, liPos);
				if (track) tracks.push(track);
			});
			playlists.push({ label: pendingLabel, tracks });
			pendingLabel = null;
			return;
		}
		pendingLabel = null;
	});

	const flatQueue = playlists.flatMap((p) => p.tracks);
	return { isMusic, name, playlists, flatQueue };
}

/** 라우트의 마운트 게이트용 — JSON doc 의 첫 문단만 보고 음악 노트인지 판별. */
export function isMusicNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(TITLE_PREFIX);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/parseMusicNote.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/parseMusicNote.ts app/tests/unit/music/parseMusicNote.test.ts
git commit -m "feat(music): parseMusicNote 순수 파서 + deriveName"
```

---

### Task 2: `musicPlayer` 전역 rune 스토어

**Goal:** 큐·현재곡·재생상태·시간을 보유하고 play/toggle/next/prev/seek/report 액션을 노출하는 단일 오디오 플레이어 스토어를, 전이 로직 테스트와 함께 구현.

**Files:**
- Create: `app/src/lib/music/musicPlayer.svelte.ts`
- Test: `app/tests/unit/music/musicPlayer.test.ts`

**Acceptance Criteria:**
- [ ] `setQueue` — 같은 노트 + 같은 url 이면 `currentIndex` 보존(트랙 추가/삭제 견딤); 다른 노트거나 url 소실이면 0(큐 있으면)으로 리셋 + `isPlaying=false`.
- [ ] `play(i)` 클램프 + `isPlaying=true`; `toggle()` 은 미선택 시 0 재생, 아니면 토글.
- [ ] `next()` 끝에서 `isPlaying=false`(정지, 반복 없음); `prev()` 시작에서 `requestSeek(0)`.
- [ ] `reportEnded()` → 다음 곡; `requestSeek(t)` 가 `seekToken` 을 bump 하고 `currentTime` 갱신.

**Verify:** `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicPlayer.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => __resetMusicPlayer());

describe('musicPlayer.setQueue', () => {
	it('starts at index 0 paused for a fresh note', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('preserves the playing track by url across re-parse (same note)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b'), t('c')]);
		musicPlayer.play(2); // c
		musicPlayer.setQueue('n1', [t('x'), t('a'), t('b'), t('c')]); // c moved to idx 3
		expect(musicPlayer.currentTrack?.url).toBe('c');
		expect(musicPlayer.currentIndex).toBe(3);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('resets to 0 paused when the playing url vanished', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.setQueue('n1', [t('a'), t('z')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('resets on a different note even if a url coincides', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		musicPlayer.play(0);
		musicPlayer.setQueue('n2', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
});

describe('musicPlayer transport', () => {
	it('toggle from no selection plays first', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.toggle();
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentIndex).toBe(0);
	});
	it('next stops at end of queue', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.next();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
	it('reportEnded advances to next track', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('prev at start requests seek to 0', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		const before = musicPlayer.seekToken;
		musicPlayer.prev();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
	it('requestSeek bumps token and updates time', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		const before = musicPlayer.seekToken;
		musicPlayer.requestSeek(42);
		expect(musicPlayer.currentTime).toBe(42);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts`
Expected: FAIL — `Cannot find module '$lib/music/musicPlayer.svelte.js'`

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/music/musicPlayer.svelte.ts
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

let queue = $state<MusicTrack[]>([]);
let currentIndex = $state(-1);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let activeNoteGuid = $state<string | null>(null);
let seekToken = $state(0);
let pendingSeekTime = $state(0);

function clampIndex(i: number): number {
	if (queue.length === 0) return -1;
	return Math.max(0, Math.min(i, queue.length - 1));
}

/** 테스트 전용 — 모듈 싱글톤 상태 초기화. */
export function __resetMusicPlayer(): void {
	queue = [];
	currentIndex = -1;
	isPlaying = false;
	currentTime = 0;
	duration = 0;
	activeNoteGuid = null;
	seekToken = 0;
	pendingSeekTime = 0;
}

export const musicPlayer = {
	get queue() {
		return queue;
	},
	get currentIndex() {
		return currentIndex;
	},
	get isPlaying() {
		return isPlaying;
	},
	get currentTime() {
		return currentTime;
	},
	get duration() {
		return duration;
	},
	get seekToken() {
		return seekToken;
	},
	get pendingSeekTime() {
		return pendingSeekTime;
	},
	get currentTrack(): MusicTrack | null {
		return queue[currentIndex] ?? null;
	},

	/** doc 재파싱 결과를 반영. 같은 노트면 재생 중 url 로 index 보존. */
	setQueue(noteGuid: string, tracks: MusicTrack[]): void {
		const sameNote = noteGuid === activeNoteGuid;
		const prevUrl = sameNote ? (queue[currentIndex]?.url ?? null) : null;
		queue = tracks;
		activeNoteGuid = noteGuid;
		let idx = prevUrl ? tracks.findIndex((t) => t.url === prevUrl) : -1;
		if (idx === -1) {
			idx = tracks.length ? 0 : -1;
			isPlaying = false;
			currentTime = 0;
			duration = 0;
		}
		currentIndex = idx;
	},

	play(index: number): void {
		if (queue.length === 0) return;
		const i = clampIndex(index);
		if (i !== currentIndex) {
			currentIndex = i;
			currentTime = 0;
		}
		isPlaying = true;
	},

	toggle(): void {
		if (currentIndex < 0) {
			if (queue.length) this.play(0);
			return;
		}
		isPlaying = !isPlaying;
	},

	next(): void {
		if (currentIndex + 1 < queue.length) this.play(currentIndex + 1);
		else isPlaying = false;
	},

	prev(): void {
		if (currentIndex > 0) this.play(currentIndex - 1);
		else this.requestSeek(0);
	},

	requestSeek(t: number): void {
		pendingSeekTime = Math.max(0, t);
		currentTime = pendingSeekTime;
		seekToken = (seekToken + 1) | 0;
	},

	reportTime(t: number): void {
		currentTime = t;
	},
	reportDuration(d: number): void {
		duration = Number.isFinite(d) ? d : 0;
	},
	reportEnded(): void {
		this.next();
	}
};
```

> **Note:** `musicPlayer` 의 메서드는 `this` 바인딩에 의존하므로 구조분해(`const { play } = musicPlayer`) 하지 말 것 — 항상 `musicPlayer.play(...)` 형태로 호출.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/musicPlayer.svelte.ts app/tests/unit/music/musicPlayer.test.ts
git commit -m "feat(music): musicPlayer 전역 rune 스토어 + 전이 테스트"
```

---

### Task 3: `musicNotePlugin` 데코레이션 + extension export

**Goal:** 재생 중 곡 마커(하이라이트 + 이퀄라이저 아이콘)와 Ctrl-게이트 트랙별 재생 버튼을 그리는 ProseMirror 플러그인 + TipTap extension 을 구현하고, 데코레이션 빌더를 헤드리스 에디터로 테스트.

**Files:**
- Create: `app/src/lib/editor/musicNote/musicNotePlugin.ts`
- Create: `app/src/lib/editor/musicNote/index.ts`
- Test: `app/tests/unit/music/musicNotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `ctrlActive=false`, `currentUrl=null` → 데코레이션 0개.
- [ ] `currentUrl` 지정 + `isPlaying=true` → 해당 `<li>` 에 node deco(class `music-track--playing`) 1개 + 이퀄라이저 위젯 1개.
- [ ] `ctrlActive=true` → 각 트랙 `<li>` 에 재생 버튼 위젯 1개씩(트랙 수만큼). 버튼 클릭 → `onPlay(index)` 호출.
- [ ] `createMusicNotePlugin` 이 비음악 노트에서 `props.decorations` null 반환.

**Verify:** `cd app && npx vitest run tests/unit/music/musicNotePlugin.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicNotePlugin.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { buildMusicDecorations } from '$lib/editor/musicNote/musicNotePlugin.js';

let ed: Editor | null = null;
function doc(html: string) {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed.state.doc;
}
afterEach(() => { ed?.destroy(); ed = null; });

const TWO = '<p>음악::x</p><p>플레이리스트: a</p><ul><li><p>https://h/1.mp3</p></li><li><p>https://h/2.mp3</p></li></ul>';

describe('buildMusicDecorations', () => {
	it('no decorations when idle and ctrl off', () => {
		const set = buildMusicDecorations(doc(TWO), { currentUrl: null, isPlaying: false, ctrlActive: false, onPlay: () => {} });
		expect(set.find().length).toBe(0);
	});
	it('playing track gets node deco + eq widget', () => {
		const d = doc(TWO);
		const set = buildMusicDecorations(d, { currentUrl: 'https://h/1.mp3', isPlaying: true, ctrlActive: false, onPlay: () => {} });
		// 1 node decoration + 1 widget = 2
		expect(set.find().length).toBe(2);
	});
	it('ctrl active adds one play button per track', () => {
		const d = doc(TWO);
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, ctrlActive: true, onPlay: () => {} });
		expect(set.find().length).toBe(2); // 2 tracks → 2 buttons
	});
	it('play button invokes onPlay with the track index', () => {
		const d = doc(TWO);
		let called = -1;
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, ctrlActive: true, onPlay: (i) => { called = i; } });
		const widgets = set.find();
		// second track's widget → index 1
		const second = widgets[1];
		const dom = (second as unknown as { type: { toDOM: HTMLElement } }).type.toDOM as HTMLElement;
		dom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(called).toBe(1);
	});
});
```

> **Note:** widget DOM 접근은 ProseMirror 내부 형태에 의존하므로, 마지막 테스트가 환경에서 불안정하면 `onPlay` 직접 호출 단위 테스트로 대체 가능(클릭 핸들러 로직을 작은 export 함수로 분리). 핵심 AC 는 데코 개수.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicNotePlugin.test.ts`
Expected: FAIL — `Cannot find module '$lib/editor/musicNote/musicNotePlugin.js'`

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/editor/musicNote/musicNotePlugin.ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { modKeys } from '$lib/desktop/modKeys.svelte.js';

export const musicNotePluginKey = new PluginKey('tomboyMusicNote');

export interface BuildOpts {
	currentUrl: string | null;
	isPlaying: boolean;
	ctrlActive: boolean;
	onPlay: (index: number) => void;
}

function eqWidget(): HTMLElement {
	const span = document.createElement('span');
	span.className = 'music-track-eq';
	span.contentEditable = 'false';
	span.setAttribute('aria-hidden', 'true');
	span.innerHTML = '<i></i><i></i><i></i>';
	return span;
}

export function buildMusicDecorations(doc: PMNode, opts: BuildOpts): DecorationSet {
	const { flatQueue } = parseMusicNote(doc);
	if (flatQueue.length === 0) return DecorationSet.empty;
	const decos: Decoration[] = [];

	flatQueue.forEach((track, index) => {
		const li = doc.nodeAt(track.liPos);
		if (!li || li.type.name !== 'listItem') return;
		const isCurrent = opts.currentUrl !== null && track.url === opts.currentUrl;

		if (isCurrent) {
			decos.push(
				Decoration.node(track.liPos, track.liPos + li.nodeSize, { class: 'music-track--playing' })
			);
			if (opts.isPlaying) {
				decos.push(
					Decoration.widget(track.liPos + 1, eqWidget, {
						side: -1,
						key: `music-eq:${track.url}`,
						ignoreSelection: true
					})
				);
			}
		}

		if (opts.ctrlActive) {
			const playingNow = isCurrent && opts.isPlaying;
			decos.push(
				Decoration.widget(
					track.liPos + 1,
					() => {
						const btn = document.createElement('button');
						btn.type = 'button';
						btn.className = 'tomboy-music-play-btn';
						btn.contentEditable = 'false';
						btn.setAttribute('data-no-drag', '');
						btn.textContent = playingNow ? '⏸' : '▶';
						btn.addEventListener('mousedown', (e) => {
							e.preventDefault();
							e.stopPropagation();
						});
						btn.addEventListener('click', (e) => {
							e.preventDefault();
							e.stopPropagation();
							if (isCurrent) musicPlayer.toggle();
							else opts.onPlay(index);
						});
						return btn;
					},
					{ side: -1, key: `music-play:${index}:${playingNow}`, ignoreSelection: true }
				)
			);
		}
	});

	return DecorationSet.create(doc, decos);
}

export function createMusicNotePlugin(): Plugin {
	return new Plugin({
		key: musicNotePluginKey,
		props: {
			decorations(state) {
				const { isMusic } = parseMusicNote(state.doc);
				if (!isMusic) return null;
				return buildMusicDecorations(state.doc, {
					currentUrl: musicPlayer.currentTrack?.url ?? null,
					isPlaying: musicPlayer.isPlaying,
					ctrlActive: modKeys.ctrl,
					onPlay: (index) => musicPlayer.play(index)
				});
			}
		}
	});
}
```

```ts
// app/src/lib/editor/musicNote/index.ts
import { Extension } from '@tiptap/core';
import { createMusicNotePlugin } from './musicNotePlugin.js';

export const TomboyMusicNote = Extension.create({
	name: 'tomboyMusicNote',
	addProseMirrorPlugins() {
		return [createMusicNotePlugin()];
	}
});

export { createMusicNotePlugin, musicNotePluginKey, buildMusicDecorations } from './musicNotePlugin.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicNotePlugin.test.ts`
Expected: PASS (개수 AC 확실; 클릭 DOM 테스트가 불안정하면 Step 1 Note 대로 대체)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/musicNote/musicNotePlugin.ts app/src/lib/editor/musicNote/index.ts app/tests/unit/music/musicNotePlugin.test.ts
git commit -m "feat(music): musicNotePlugin 데코레이션(재생중 마커 + Ctrl 버튼)"
```

---

### Task 4: `MusicPlayerBar.svelte` 상단 컨트롤 패널 + `<audio>`

**Goal:** 제목 아래 sticky 컨트롤 패널 컴포넌트 — 숨은 `<audio>` 소유, doc 재파싱 → `setQueue`, 스토어↔오디오 동기화, 재생/모드 변경 시 에디터 데코 갱신 nudge.

**Files:**
- Create: `app/src/lib/editor/musicNote/MusicPlayerBar.svelte`

**Acceptance Criteria:**
- [ ] `editor.on('update')` 로 doc 변경 감지 → `parseMusicNote(editor.state.doc)` → `musicPlayer.setQueue(guid, flatQueue)`.
- [ ] `<audio>` src 가 `currentTrack.url` 과 동기화; `isPlaying` → `play()/pause()`; `seekToken` → `currentTime` 적용.
- [ ] `timeupdate/loadedmetadata/ended/error` → 스토어 report; `error` → 다음 곡.
- [ ] `musicPlayer.currentIndex/isPlaying`, `modKeys.ctrl` 변화 시 no-op 트랜잭션으로 에디터 데코 갱신.
- [ ] `npm run check` 타입 통과.

**Verify:** `cd app && npm run check` → 0 errors in new files; `npm run dev` 로 수동 재생 확인

**Steps:**

- [ ] **Step 1: Write the component**

```svelte
<!-- app/src/lib/editor/musicNote/MusicPlayerBar.svelte -->
<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { parseMusicNote } from '$lib/music/parseMusicNote.js';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';

	type Props = { editor: Editor; guid: string };
	let { editor, guid }: Props = $props();

	let audioEl = $state<HTMLAudioElement | null>(null);
	let version = $state(0);
	let refreshN = 0;

	const onUpdate = () => {
		version = (version + 1) | 0;
	};
	$effect(() => {
		editor.on('update', onUpdate);
		return () => {
			editor.off('update', onUpdate);
		};
	});

	// doc 변경마다 재파싱 → 스토어 큐 갱신.
	$effect(() => {
		version; // subscribe
		const note = parseMusicNote(editor.state.doc);
		musicPlayer.setQueue(guid, note.flatQueue);
	});

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	const label = $derived.by(() => {
		version;
		const url = track?.url;
		if (!url) return '';
		const note = parseMusicNote(editor.state.doc);
		for (const pl of note.playlists) if (pl.tracks.some((t) => t.url === url)) return pl.label;
		return '';
	});

	// <audio> src 동기화.
	$effect(() => {
		const el = audioEl;
		const url = track?.url ?? '';
		if (!el) return;
		if ((el.getAttribute('src') ?? '') !== url) {
			if (url) el.src = url;
			else el.removeAttribute('src');
		}
	});
	// 재생/일시정지 동기화.
	$effect(() => {
		const el = audioEl;
		if (!el) return;
		if (playing) void el.play().catch(() => {});
		else el.pause();
	});
	// seek 요청 적용.
	$effect(() => {
		const el = audioEl;
		musicPlayer.seekToken; // subscribe
		if (!el) return;
		const target = musicPlayer.pendingSeekTime;
		if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
	});
	// 재생/Ctrl 상태 변화 → 에디터 데코 갱신(no-op tr).
	$effect(() => {
		musicPlayer.currentIndex;
		musicPlayer.isPlaying;
		modKeys.ctrl;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta('musicRefresh', (refreshN = (refreshN + 1) | 0)));
	});

	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
	function onSeekInput(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
</script>

{#if track}
	<div class="music-bar">
		<div class="music-now">
			재생 중
			{#if label}<span class="music-pl">{label}</span>{/if}
			<b>{track.display}</b>
		</div>
		<div class="music-row">
			<div class="music-btns">
				<button type="button" onclick={() => musicPlayer.prev()} aria-label="이전">⏮</button>
				<button
					type="button"
					class="main"
					onclick={() => musicPlayer.toggle()}
					aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button
				>
				<button type="button" onclick={() => musicPlayer.next()} aria-label="다음">⏭</button>
			</div>
			<div class="music-seek">
				<span class="t">{fmt(musicPlayer.currentTime)}</span>
				<input
					type="range"
					min="0"
					max={Math.max(1, musicPlayer.duration)}
					step="0.1"
					value={musicPlayer.currentTime}
					oninput={onSeekInput}
				/>
				<span class="t">{fmt(musicPlayer.duration)}</span>
			</div>
		</div>
	</div>
{/if}
<audio
	bind:this={audioEl}
	preload="metadata"
	ontimeupdate={() => musicPlayer.reportTime(audioEl?.currentTime ?? 0)}
	onloadedmetadata={() => musicPlayer.reportDuration(audioEl?.duration ?? 0)}
	onended={() => musicPlayer.reportEnded()}
	onerror={() => musicPlayer.next()}
></audio>

<style>
	.music-bar {
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--surface, #fff);
		border-bottom: 1px solid var(--border, #ececea);
		padding: clamp(0.5rem, 1.6vw, 0.85rem) clamp(0.6rem, 2.4vw, 1rem);
		display: flex;
		flex-direction: column;
		gap: clamp(0.35rem, 1.2vw, 0.6rem);
	}
	.music-now {
		font-size: clamp(0.72rem, 2.6vw, 0.8rem);
		color: var(--text-muted, #666);
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.music-now b {
		color: var(--text, #222);
		font-weight: 600;
	}
	.music-pl {
		background: var(--accent-soft, #f0e6f0);
		color: var(--accent, #a05);
		border-radius: 5px;
		padding: 1px 6px;
		font-size: 0.86em;
	}
	.music-row {
		display: flex;
		align-items: center;
		gap: clamp(0.5rem, 2vw, 0.9rem);
	}
	.music-btns {
		display: flex;
		align-items: center;
		gap: clamp(0.35rem, 1.4vw, 0.65rem);
	}
	.music-btns button {
		border: none;
		background: transparent;
		color: var(--text, #444);
		font-size: clamp(0.85rem, 3vw, 1rem);
		cursor: pointer;
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.music-btns button.main {
		background: var(--accent, #a05);
		color: #fff;
		width: 2.3em;
		height: 2.3em;
	}
	.music-seek {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.music-seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.music-seek .t {
		font-size: 0.7rem;
		color: var(--text-muted, #888);
		font-variant-numeric: tabular-nums;
	}
	audio {
		display: none;
	}
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: 0 errors referencing `MusicPlayerBar.svelte` / `lib/music/*`

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/editor/musicNote/MusicPlayerBar.svelte
git commit -m "feat(music): MusicPlayerBar 상단 컨트롤 패널 + <audio>"
```

---

### Task 5: TomboyEditor 통합 — extension 등록 + 데코 CSS

**Goal:** `tomboyMusicNote` extension 을 에디터에 등록하고, 데코레이션이 주입하는 클래스(`music-track--playing`, `music-track-eq`, `tomboy-music-play-btn`)의 전역 CSS 를 추가.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import + extensions 배열 + `<style>`)

**Acceptance Criteria:**
- [ ] `tomboyMusicNote` extension 이 `tomboyAutomationNote` 블록 옆에 등록됨.
- [ ] `.tomboy-editor :global(.music-track--playing)` / `:global(.music-track-eq)` / `:global(.tomboy-music-play-btn)` CSS 추가(`.tomboy-send-li-btn` 규칙 미러링).
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → no new errors

**Steps:**

- [ ] **Step 1: Add the import**

`app/src/lib/editor/TomboyEditor.svelte` 의 다른 editor extension import 근처(예: 자동화/지오맵 import 블록 부근)에 추가:

```ts
import { TomboyMusicNote } from "./musicNote/index.js";
```

- [ ] **Step 2: Register the extension**

`app/src/lib/editor/TomboyEditor.svelte:467-472` 의 `tomboyAutomationNote` `Extension.create({...})` 블록 **바로 다음**에 추가:

```ts
				TomboyMusicNote,
```

(다른 항목들은 `Extension.create({...})` 인라인인데, `TomboyMusicNote` 는 `index.ts` 에서 이미 `Extension.create` 로 만들어 export 하므로 식별자만 나열한다. extensions 배열에 Extension 인스턴스를 직접 넣는 것은 TipTap 에서 정상.)

- [ ] **Step 3: Add the global CSS**

`app/src/lib/editor/TomboyEditor.svelte` 의 `<style>` 안, `.tomboy-editor :global(.tomboy-send-li-btn)` 규칙(약 line 1912) 근처에 추가:

```css
	.tomboy-editor :global(li.music-track--playing) {
		list-style: none;
		background: var(--accent-soft, #faf2f7);
		border-radius: 6px;
	}
	.tomboy-editor :global(.music-track-eq) {
		display: inline-flex;
		gap: 2px;
		align-items: flex-end;
		height: 0.85em;
		margin-right: 0.35em;
		vertical-align: -0.1em;
	}
	.tomboy-editor :global(.music-track-eq i) {
		width: 2.5px;
		background: var(--accent, #a05);
		border-radius: 1px;
		animation: music-eq 1s ease-in-out infinite;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(1)) {
		height: 45%;
		animation-delay: 0s;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(2)) {
		height: 100%;
		animation-delay: 0.2s;
	}
	.tomboy-editor :global(.music-track-eq i:nth-child(3)) {
		height: 65%;
		animation-delay: 0.4s;
	}
	@keyframes music-eq {
		0%,
		100% {
			transform: scaleY(0.5);
		}
		50% {
			transform: scaleY(1);
		}
	}
	.tomboy-editor :global(.tomboy-music-play-btn) {
		float: right;
		border: 1px solid var(--border, #e0e0dc);
		border-radius: 6px;
		background: var(--surface, #fff);
		color: var(--text, #555);
		font-size: 0.8em;
		width: 1.8em;
		height: 1.8em;
		cursor: pointer;
		margin-left: 0.4em;
	}
	.tomboy-editor :global(.tomboy-music-play-btn:hover) {
		background: var(--accent-soft, #faf2f7);
	}
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: 0 new errors

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(music): TomboyEditor 에 tomboyMusicNote extension + 데코 CSS 등록"
```

---

### Task 6: 라우트 마운트 — `/note/[id]` + 데스크탑 `NoteWindow`

**Goal:** 두 노트 화면에서 음악 노트일 때 `MusicPlayerBar` 를 마운트하고, `isMusicNoteDoc` 으로 reactive 게이트 플래그를 유지.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte`
- Modify: `app/src/lib/desktop/NoteWindow.svelte`

**Acceptance Criteria:**
- [ ] `/note/[id]`: 음악 노트에서 제목 아래 `MusicPlayerBar` 표시, 재생/다음/이전/seek 동작, 재생 중 곡 마커 아이콘, Ctrl(데스크탑) / 모바일 Ctrl 버튼 ON 시 트랙별 ▶ 노출.
- [ ] 데스크탑 `NoteWindow`: 동일 동작.
- [ ] 비음악 노트에서는 바가 마운트되지 않음.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → no new errors; `npm run dev` → 아래 수동 시나리오 통과

**Steps:**

- [ ] **Step 1: `/note/[id]/+page.svelte` — import + 상태 플래그**

import 블록(다른 `parse*Note` / `ChatSendBar` import 근처, 예: line 30/65 부근)에 추가:

```ts
	import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
	import { isMusicNoteDoc } from '$lib/music/parseMusicNote.js';
```

`isScheduleNoteState` 선언(line 83) 근처에 추가:

```ts
	let isMusicNote = $state(false);
```

- [ ] **Step 2: `/note/[id]/+page.svelte` — 플래그 갱신 2곳**

로드 시(line 261 `editorContent = getNoteEditorContent(loaded);` **바로 다음 줄**) 추가:

```ts
			isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
```

`handleEditorChange`(line 349) 본문 첫 줄에 추가:

```ts
		isMusicNote = isMusicNoteDoc(doc);
```

- [ ] **Step 3: `/note/[id]/+page.svelte` — 바 마운트**

`<ChatSendBar .../>` 가 들어있는 `{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}` 블록(line 759) **앞**에 별도 블록 추가:

```svelte
				{#if editorComponent?.getEditor() && isMusicNote}
					<MusicPlayerBar editor={editorComponent.getEditor()!} guid={noteId ?? ''} />
				{/if}
```

- [ ] **Step 4: `NoteWindow.svelte` — import + 플래그**

import 블록(line 23 `ChatSendBar` 근처)에 추가:

```ts
	import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
	import { isMusicNoteDoc } from '$lib/music/parseMusicNote.js';
```

`let isScheduleNote = $state(false);`(line 127) 근처에 추가:

```ts
	let isMusicNote = $state(false);
```

- [ ] **Step 5: `NoteWindow.svelte` — 플래그 갱신 3곳**

`editorContent = getNoteEditorContent(loaded);`(line 228) 다음 줄, `editorContent = getNoteEditorContent(fresh);`(line 481) 다음 줄에 각각:

```ts
			isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
```

`handleEditorChange`(line 331) 본문 첫 줄에:

```ts
		isMusicNote = isMusicNoteDoc(doc);
```

- [ ] **Step 6: `NoteWindow.svelte` — 바 마운트**

`<ChatSendBar .../>` 의 `{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}` 블록(line 914) **앞**에 추가:

```svelte
					{#if editorComponent?.getEditor() && isMusicNote}
						<MusicPlayerBar editor={editorComponent.getEditor()!} guid={guid} />
					{/if}
```

- [ ] **Step 7: Typecheck**

Run: `cd app && npm run check`
Expected: 0 new errors. (`JSONContent` 타입이 미import 면 두 파일 상단에 `import type { JSONContent } from '@tiptap/core';` 가 이미 있는지 확인; 없으면 추가.)

- [ ] **Step 8: Manual verification (`npm run dev`)**

다음 본문으로 노트 생성/편집:

```
음악::테스트
플레이리스트: 아침
- https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3
- Song 2
  - https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3
플레이리스트: 저녁
- https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3
```

확인:
1. 제목 아래 컨트롤 패널 표시, 첫 곡이 paused 로 선택됨.
2. ▶ → 1곡 재생, 마커가 이퀄라이저 아이콘으로, seek/시간 갱신.
3. 곡 끝 또는 ⏭ → 다음 곡(저녁 플레이리스트로 가로질러 진행), 큐 끝에서 정지.
4. 데스크탑: Ctrl 누른 채 호버 → 각 트랙 ▶ 노출, 클릭 시 그 곡 재생.
5. 모바일(또는 좁은 폭): 툴바 Ctrl 버튼 ON → 트랙별 ▶ 노출.
6. 비음악 노트로 이동 → 패널 사라짐.

- [ ] **Step 9: Commit**

```bash
git add app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte
git commit -m "feat(music): /note/[id] + NoteWindow 에 MusicPlayerBar 마운트"
```

---

### Task 7: 설정 가이드 카드 (필수 invariant)

**Goal:** 설정 → 가이드 `notes` 탭에 음악 노트 사용법 `<details class="guide-card">` 추가 (CLAUDE.md 의 "사용자 기능은 가이드에 문서화" invariant).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] `guideSubTab === 'notes'` 블록 안에 음악 노트 카드 추가.
- [ ] summary + info-text 소개 + `<pre class="snippet">` 포맷 예시 + `<ul class="guide-list">` 제약/팁(직접 오디오 URL 한정, Ctrl 게이트/모바일 Ctrl 버튼, SUNO 후속) 포함.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → no new errors; `npm run dev` → 설정 → 가이드 → 노트 탭에서 카드 확인

**Steps:**

- [ ] **Step 1: Add the guide card**

`app/src/routes/settings/+page.svelte` 의 `{#if guideSubTab === 'notes'}`(line 1548) 블록 안, 기존 노트 카드들 사이(예: 슬립노트 카드 근처)에 추가:

```svelte
				<details class="guide-card">
					<summary>음악 노트 — <code>음악::</code> 플레이리스트 재생</summary>
					<p class="info-text">
						제목을 <code>음악::제목</code> 으로 시작하면 음악 노트가 됩니다. 본문의
						<code>플레이리스트: 설명</code> 줄 바로 다음 리스트의 아이템들이 트랙이 되고, 제목 아래
						컨트롤 패널에서 재생/정지·이전/다음·탐색을 할 수 있습니다. 한 노트의 모든 플레이리스트는
						문서 순서대로 이어 재생됩니다.
					</p>
					<pre class="snippet">음악::주말 플레이리스트

플레이리스트: 아침
&nbsp; - 곡 제목
&nbsp; &nbsp; - https://example.com/song.mp3
&nbsp; - https://example.com/another.mp3

플레이리스트: 저녁
&nbsp; - https://example.com/evening.mp3</pre>
					<ul class="guide-list">
						<li>아이템 2가지 형식: <strong>제목(깊이1) + URL(깊이2)</strong>, 또는 제목을 모르면
							<strong>URL만(깊이1)</strong>.</li>
						<li>재생 중인 곡은 리스트 마커 대신 재생 아이콘으로 표시됩니다.</li>
						<li>각 트랙의 ▶ 버튼은 <strong>Ctrl 을 누른 채</strong> 노출됩니다 — 데스크탑은 Ctrl+마우스
							오버, 모바일은 툴바의 <code>Ctrl</code> 버튼을 켠 뒤 탭.</li>
						<li>현재는 <strong>직접 오디오 파일 URL</strong>(mp3 등 브라우저가 재생 가능한 링크)만
							지원합니다. SUNO 플레이리스트 자동 채움은 향후 추가 예정입니다.</li>
					</ul>
				</details>
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: 0 new errors

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(music): 설정 가이드에 음악 노트 카드 추가"
```

---

## Self-Review

**Spec coverage** (spec 의 각 절 → 태스크):
- 노트 포맷 & 감지 → Task 1 (`parseMusicNote` + `isMusicNoteDoc`).
- 트랙 추출(패턴 A/B, URL 마크, 비-트랙 스킵, 다중 평탄화) → Task 1.
- 플레이어 런타임(스토어 + 바 + `<audio>`) → Task 2 (스토어), Task 4 (바).
- 에디터 안 렌더링(재생중 마커 + Ctrl 게이트) → Task 3 (플러그인) + Task 5 (등록/CSS).
- 마운트 지점(`/note/[id]`, `NoteWindow`, `TomboyEditor`) → Task 5, Task 6.
- 재생중 마커 = fresh 파스 + URL 매칭 보정 → Task 3 (`buildMusicDecorations` 의 `currentUrl` 매칭).
- Dropbox 직링크 = v1 패스스루 → 별도 변환 미구현(스펙대로 비목표 인접). 
- 가이드 카드 → Task 7.
- 비목표(SUNO/유튜브/셔플/영속화/다중재생) → 구현 안 함(스토어 단일 오디오 + setQueue 노트 교체로 다중재생 차단).

**Placeholder scan:** 모든 step 에 실제 코드/명령/기대출력 포함. "적절히 처리" 류 없음.

**Type consistency:** `MusicTrack`/`MusicNote`/`MusicPlaylist` (Task 1) → Task 2 `setQueue(tracks: MusicTrack[])`, Task 3 `parseMusicNote`/`flatQueue`, Task 4 `parseMusicNote(editor.state.doc)` 일관. `musicPlayer` 액션명(`play/toggle/next/prev/requestSeek/reportTime/reportDuration/reportEnded/setQueue/currentTrack/seekToken/pendingSeekTime`)이 Task 2 정의와 Task 3·4 소비처 일치. `buildMusicDecorations(doc, {currentUrl,isPlaying,ctrlActive,onPlay})` 시그니처가 Task 3 정의·테스트·플러그인 호출 일치. `isMusicNoteDoc(JSONContent)` Task 1 정의 → Task 6 소비 일치.

**리스크 노트:**
- 동일 url 트랙이 한 노트에 중복되면 `currentUrl` 매칭이 첫 항목을 가리킴 — 같은 곡을 두 번 넣은 드문 케이스. v1 허용.
- `props.decorations` 가 rune 을 비반응 컨텍스트에서 읽으므로 갱신은 바의 no-op tr nudge 에 의존 — 바가 마운트된 음악 노트에서만 데코가 의미 있으므로 정합.
