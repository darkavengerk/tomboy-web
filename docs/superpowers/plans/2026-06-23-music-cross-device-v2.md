# Music Cross-Device v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-place-at-a-time music playback with seamless cross-device hand-off, a home-screen play FAB replacing the floating pill, a local/remote continuity picker, and a slimmed note record whose 10-second position updates live in a separate lightweight Firestore collection.

**Architecture:** Split cross-device state into two channels. **Channel A** = the existing `음악제어::` note record, now slim (`{deviceId, deviceName, noteGuid, trackUrl, trackTitle, noteTitle, state, updatedAt}`), written only on transport events (play/pause/stop/**track-change**), synced via the existing note-sync. **Channel B** = a new `users/{uid}/deviceState/{deviceId}` Firestore doc (`{position, trackUrl, updatedAt}`) written every 10 s while playing, synced directly (no Dropbox/XML). The receiver rebuilds the queue by re-parsing `noteGuid` (no stored queue) and reads the position one-shot from Channel B.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror JSON, Firestore (modular SDK, DI'd), vitest + @testing-library/svelte, `idb`.

**Spec:** `docs/superpowers/specs/2026-06-23-music-cross-device-v2-design.md`

**Conventions used throughout:**
- All UI strings Korean.
- Singleton stores isolated in tests via `__reset*` in `beforeEach`.
- Every IDB-touching test imports `'fake-indexeddb/auto'`.
- Run a single test file with: `cd app && npx vitest run tests/unit/music/<file>.test.ts`.
- Type-check with: `cd app && npm run check`.
- Full suite: `cd app && npm run test`.

---

### Task 1: Slim the note record schema (Channel A data model)

**Goal:** Remove `queue`/`index`/`position`/`MusicControlTrack` from `MusicControlRecord` and tolerate legacy records that still carry them.

**Files:**
- Modify: `app/src/lib/music/musicControlNote.ts`
- Test: `app/tests/unit/music/musicControlNote.test.ts` (existing — merge, do NOT overwrite)

**Acceptance Criteria:**
- [ ] `MusicControlRecord` no longer declares `queue`, `index`, or `position`; `MusicControlTrack` is removed.
- [ ] `isRecord` accepts a slim record `{deviceId, trackUrl, state, updatedAt, ...}` WITHOUT a `position` field, and still rejects non-objects / missing core fields.
- [ ] `parseRecordsFromXml` of a legacy record (with `queue`/`position`) returns the record with those extra keys ignored by the type (no crash).
- [ ] `serializeRecords` of a slim record emits no `queue`/`index`/`position` keys.

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Read the existing test file first.** It already contains round-trip tests (do NOT clobber). Add the new cases below alongside them.

- [ ] **Step 2: Write failing tests** in `app/tests/unit/music/musicControlNote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	serializeRecords,
	parseRecordsFromXml,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import { MUSIC_CONTROL_TITLE, serializeRecords as ser } from '$lib/music/musicControlNote.js';

const slim = (): MusicControlRecord => ({
	deviceId: 'd1',
	deviceName: '아이폰',
	noteGuid: 'g1',
	trackUrl: 'https://x/a.mp3',
	trackTitle: 'A',
	noteTitle: '음악::로제',
	state: 'playing',
	updatedAt: '2026-06-23T10:00:00.000Z'
});

describe('slim MusicControlRecord', () => {
	it('serializes without queue/index/position keys', () => {
		const json = serializeRecords([slim()]);
		expect(json).not.toMatch(/"queue"/);
		expect(json).not.toMatch(/"index"/);
		expect(json).not.toMatch(/"position"/);
	});

	it('parses a slim record from xml (no position field required)', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
				{ type: 'paragraph', content: [{ type: 'text', text: ser([slim()]) }] }
			]
		};
		const xml = serializeContent(doc);
		const recs = parseRecordsFromXml(xml);
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3');
		expect((recs[0] as Record<string, unknown>).position).toBeUndefined();
	});

	it('tolerates a legacy record carrying queue/position (extra keys ignored)', () => {
		const legacy = { ...slim(), position: 42, index: 1, queue: [{ url: 'u', display: 'd' }] };
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
				{ type: 'paragraph', content: [{ type: 'text', text: ser([legacy as MusicControlRecord]) }] }
			]
		};
		const xml = serializeContent(doc);
		const recs = parseRecordsFromXml(xml);
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3'); // core fields survive
	});
});
```

- [ ] **Step 3: Run to confirm the slim test fails** (current `isRecord` requires `position`):
Run: `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts` → FAIL on the slim-record parse (position required).

- [ ] **Step 4: Edit `musicControlNote.ts`.**
  - Delete the `MusicControlTrack` interface (lines ~13-20).
  - In `MusicControlRecord` remove `position`, `queue`, `index` fields and their doc comments. Final interface:

```ts
export interface MusicControlRecord {
	deviceId: string;
	deviceName: string;
	/** The music note that holds the track (큐 재구성 키). */
	noteGuid: string;
	trackUrl: string;
	trackTitle: string;
	noteTitle: string;
	state: TransportState;
	/** ISO-8601 — sorts lexically, like Tomboy changeDate. */
	updatedAt: string;
}
```

  - Loosen `isRecord` to NOT require `position` (position now lives in Channel B):

```ts
function isRecord(v: unknown): v is MusicControlRecord {
	const e = v as Record<string, unknown>;
	return (
		!!e &&
		typeof e.deviceId === 'string' &&
		typeof e.trackUrl === 'string' &&
		typeof e.state === 'string' &&
		typeof e.updatedAt === 'string'
	);
}
```

  Leave `parseRecordsFromDoc`, `parseRecordsFromXml`, `serializeRecords`, `upsertRecords`, `setMarkerRecordsInDoc`, `pickGlobalLatest` unchanged (they operate on whole records; extra legacy keys pass through harmlessly).

- [ ] **Step 5: Run to confirm pass:**
Run: `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts` → PASS.

- [ ] **Step 6: Commit:**
```bash
git add app/src/lib/music/musicControlNote.ts app/tests/unit/music/musicControlNote.test.ts
git commit -m "feat(music): slim MusicControlRecord — drop queue/index/position (Channel A)"
```

---

### Task 2: Headless JSONContent music-queue parser

**Goal:** Rebuild a music note's flat queue from its raw XML without an editor, by walking the deserialized JSONContent tree and reusing `parseMusicNote`'s URL/title heuristics.

**Files:**
- Modify: `app/src/lib/music/parseMusicNote.ts` (export the shared helpers)
- Create: `app/src/lib/music/headlessMusicParse.ts`
- Test: `app/tests/unit/music/headlessMusicParse.test.ts`

**Acceptance Criteria:**
- [ ] `buildQueueFromXml(xml)` returns the same track URLs (in order) as the editor's `parseMusicNote` for the three track patterns (bare-URL line, title + nested-list URL, head mark-link).
- [ ] A `플레이리스트:` header with a LEADING unchecked `inlineCheckbox` atom excludes that list (text mode); checked or no-checkbox includes it.
- [ ] A non-music note (title not `음악::`) returns `[]`.
- [ ] `tomboyUrlLink` mark href is preferred over body-regex; trailing punctuation is trimmed on body matches.

**Verify:** `cd app && npx vitest run tests/unit/music/headlessMusicParse.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Export shared helpers from `parseMusicNote.ts`.** Change `const URL_RE`, `function trimTrailingPunct`, `function deriveName` to exported:

```ts
export const URL_RE = /https?:\/\/[^\s<>"]+/;
export function trimTrailingPunct(url: string): string {
	return url.replace(/[.,;:!?)\]}'"]+$/, '');
}
// deriveName is already exported; leave as-is.
```
(`deriveName` is already `export function`. Only `URL_RE` and `trimTrailingPunct` need the `export` keyword added. The internal callers in the file keep working unchanged.)

- [ ] **Step 2: Write failing tests** in `app/tests/unit/music/headlessMusicParse.test.ts`. Build fixtures as JSONContent → `serializeContent` → XML, mirroring `musicControlRead.test.ts`'s seeding style:

```ts
import { describe, it, expect } from 'vitest';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import { buildQueueFromXml } from '$lib/music/headlessMusicParse.js';

function xmlOf(content: unknown[]): string {
	return serializeContent({ type: 'doc', content });
}
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const urlPara = (url: string) => ({
	type: 'paragraph',
	content: [{ type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] }]
});
const li = (children: unknown[]) => ({ type: 'listItem', content: children });
const ul = (items: unknown[]) => ({ type: 'bulletList', content: items });

describe('buildQueueFromXml', () => {
	it('returns [] for a non-music note', () => {
		expect(buildQueueFromXml(xmlOf([p('그냥 노트'), p('내용')]))).toEqual([]);
	});

	it('extracts bare-URL list items under a playlist header', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([li([urlPara('https://x/a.mp3')]), li([urlPara('https://x/b.mp3')])])
		]);
		const q = buildQueueFromXml(xml);
		expect(q.map((t) => t.url)).toEqual(['https://x/a.mp3', 'https://x/b.mp3']);
	});

	it('extracts title + nested-list URL (pattern A)', () => {
		const xml = xmlOf([
			p('음악::로제'),
			p('플레이리스트:로제'),
			ul([li([p('첫 곡'), ul([li([urlPara('https://x/a.mp3')])])])])
		]);
		const q = buildQueueFromXml(xml);
		expect(q[0].url).toBe('https://x/a.mp3');
		expect(q[0].title).toBe('첫 곡');
	});

	it('excludes a list whose header has a leading UNCHECKED inlineCheckbox', () => {
		const xml = xmlOf([
			p('음악::로제'),
			{
				type: 'paragraph',
				content: [
					{ type: 'inlineCheckbox', attrs: { checked: false } },
					{ type: 'text', text: '플레이리스트:끔' }
				]
			},
			ul([li([urlPara('https://x/off.mp3')])])
		]);
		expect(buildQueueFromXml(xml)).toEqual([]);
	});

	it('includes a list whose header inlineCheckbox is CHECKED', () => {
		const xml = xmlOf([
			p('음악::로제'),
			{
				type: 'paragraph',
				content: [
					{ type: 'inlineCheckbox', attrs: { checked: true } },
					{ type: 'text', text: '플레이리스트:켬' }
				]
			},
			ul([li([urlPara('https://x/on.mp3')])])
		]);
		expect(buildQueueFromXml(xml).map((t) => t.url)).toEqual(['https://x/on.mp3']);
	});
});
```

- [ ] **Step 3: Run — fails** (module absent):
Run: `cd app && npx vitest run tests/unit/music/headlessMusicParse.test.ts` → FAIL "Cannot find module".

- [ ] **Step 4: Create `app/src/lib/music/headlessMusicParse.ts`.** Walk JSONContent mirroring `parseMusicNote`'s patterns; reuse the exported helpers. `liPos` is `-1` (no editor positions headlessly).

```ts
import type { JSONContent } from '@tiptap/core';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { URL_RE, trimTrailingPunct, deriveName, type MusicTrack } from './parseMusicNote.js';

const TITLE_PREFIX = '음악::';
const PLAYLIST_PREFIX = '플레이리스트:';

function nodeText(node: JSONContent | undefined): string {
	if (!node?.content) return typeof node?.text === 'string' ? node.text : '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/** First http(s) URL inside a JSON node: tomboyUrlLink/link mark href first, else body regex. */
function firstUrlInJson(node: JSONContent | undefined): string | null {
	let marked: string | null = null;
	const walk = (n: JSONContent | undefined) => {
		if (!n || marked) return;
		if (n.type === 'text' && Array.isArray(n.marks)) {
			const link = n.marks.find((m) => m.type === 'tomboyUrlLink' || m.type === 'link');
			const href = (link?.attrs as { href?: unknown })?.href;
			if (typeof href === 'string' && URL_RE.test(href)) {
				marked = href;
				return;
			}
		}
		for (const c of n.content ?? []) walk(c);
	};
	walk(node);
	if (marked) return marked;
	const m = URL_RE.exec(nodeTextDeep(node));
	return m ? trimTrailingPunct(m[0]) : null;
}

/** Concatenated text of all descendant text nodes (for body-regex fallback). */
function nodeTextDeep(node: JSONContent | undefined): string {
	if (!node) return '';
	if (n_isText(node)) return node.text ?? '';
	return (node.content ?? []).map(nodeTextDeep).join('');
}
function n_isText(n: JSONContent): boolean {
	return n.type === 'text';
}

function isListNode(n: JSONContent): boolean {
	return n.type === 'bulletList' || n.type === 'orderedList';
}

/** head 문단 = listItem 의 첫 자식(문단). */
function listItemHead(li: JSONContent): string {
	const first = (li.content ?? [])[0];
	return nodeText(first).trim();
}
function nestedListOf(li: JSONContent): JSONContent | null {
	for (const c of li.content ?? []) if (isListNode(c)) return c;
	return null;
}

function extractTrack(li: JSONContent): MusicTrack | null {
	const head = listItemHead(li);
	const headMatch = URL_RE.exec(head);

	// 패턴 B: head 자체가 정확히 URL
	if (headMatch && headMatch[0] === head.trim()) {
		const url = trimTrailingPunct(headMatch[0]);
		return { url, title: null, display: deriveName(url), liPos: -1 };
	}
	// 패턴 A: head = 제목, 중첩 리스트 첫 아이템에 URL
	const nested = nestedListOf(li);
	const firstNestedLi = nested?.content?.find((c) => c.type === 'listItem');
	if (firstNestedLi) {
		const url = firstUrlInJson((firstNestedLi.content ?? [])[0]);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos: -1 };
	}
	// 패턴 C: head 문단 자체에 마크/링크 URL (link text = 제목)
	const firstChild = (li.content ?? [])[0];
	if (firstChild) {
		const url = firstUrlInJson(firstChild);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos: -1 };
	}
	// 패턴 B 변형: head 안에 URL 끼어있음
	if (headMatch) {
		const url = trimTrailingPunct(headMatch[0]);
		return { url, title: null, display: deriveName(url), liPos: -1 };
	}
	return null;
}

/** Rebuild the flat queue from a music note's raw <note-content> XML. Mirrors
 *  parseMusicNote (PMNode) but walks JSONContent so it runs without an editor. */
export function buildQueueFromXml(xmlContent: string): MusicTrack[] {
	if (!xmlContent) return [];
	const doc = deserializeContent(xmlContent);
	const blocks = doc.content ?? [];
	const titleText = nodeText(blocks[0]).trim();
	if (!titleText.startsWith(TITLE_PREFIX)) return [];

	const out: MusicTrack[] = [];
	let pendingLabel: string | null = null;
	for (const block of blocks) {
		if (block.type === 'paragraph') {
			const t = nodeText(block).trim();
			if (!t.startsWith(PLAYLIST_PREFIX)) {
				pendingLabel = null;
				continue;
			}
			// 헤더 앞 inlineCheckbox atom 의 checked 가 플레이리스트 on/off. 없음=on(레거시).
			const first = (block.content ?? [])[0];
			const enabled =
				first?.type === 'inlineCheckbox' ? (first.attrs as { checked?: unknown })?.checked === true : true;
			pendingLabel = enabled ? t.slice(PLAYLIST_PREFIX.length).trim() : null;
			continue;
		}
		if (isListNode(block) && pendingLabel !== null) {
			for (const li of block.content ?? []) {
				if (li.type !== 'listItem') continue;
				const track = extractTrack(li);
				if (track) {
					track.playlistLabel = pendingLabel ?? '';
					out.push(track);
				}
			}
			pendingLabel = null;
			continue;
		}
		pendingLabel = null;
	}
	return out;
}
```

- [ ] **Step 5: Run — passes:**
Run: `cd app && npx vitest run tests/unit/music/headlessMusicParse.test.ts` → PASS.

- [ ] **Step 6: Commit:**
```bash
git add app/src/lib/music/parseMusicNote.ts app/src/lib/music/headlessMusicParse.ts app/tests/unit/music/headlessMusicParse.test.ts
git commit -m "feat(music): headless JSONContent queue parser (buildQueueFromXml)"
```

---

### Task 3: deviceStateSync module + Firestore adapter (Channel B infra)

**Goal:** A DI'd, throttled client that writes this device's playback position to `users/{uid}/deviceState/{deviceId}` (≤ once / 10 s, immediate flush on demand) and reads another device's position one-shot, gated on the same `firebaseNotesEnabled` + sign-in as note-sync.

**Files:**
- Create: `app/src/lib/music/deviceStateSync.ts`
- Create: `app/src/lib/music/deviceStateSync.firestore.ts`
- Test: `app/tests/unit/music/deviceStateSync.test.ts`

**Acceptance Criteria:**
- [ ] `writePosition` writes at most once per `minIntervalMs` (default 10 000) for the same track; an immediate write fires when the trackUrl changes.
- [ ] `flushPosition` bypasses the throttle and always writes (gated).
- [ ] When `isEnabled()` is false OR `getUid()` returns null, neither write nor read touches the adapter (no-op).
- [ ] `readDeviceState(id)` returns the adapter's doc, or null when disabled/signed-out.

**Verify:** `cd app && npx vitest run tests/unit/music/deviceStateSync.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** in `app/tests/unit/music/deviceStateSync.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDeviceStateSync, type DeviceStateAdapter } from '$lib/music/deviceStateSync.js';

function fakeAdapter() {
	const writes: { deviceId: string; position: number; trackUrl: string }[] = [];
	let readReturn: { position: number; trackUrl: string } | null = null;
	const adapter: DeviceStateAdapter = {
		async write(_uid, deviceId, doc) {
			writes.push({ deviceId, ...doc });
		},
		async read() {
			return readReturn;
		}
	};
	return { adapter, writes, setRead: (r: typeof readReturn) => (readReturn = r) };
}

function make(overrides: Partial<Parameters<typeof createDeviceStateSync>[0]> = {}) {
	const f = fakeAdapter();
	let nowMs = 0;
	const sync = createDeviceStateSync({
		adapter: f.adapter,
		getUid: async () => 'uid1',
		isEnabled: async () => true,
		getDeviceId: async () => 'dev1',
		now: () => nowMs,
		minIntervalMs: 10_000,
		...overrides
	});
	return { sync, ...f, advance: (ms: number) => (nowMs += ms), setNow: (v: number) => (nowMs = v) };
}

describe('deviceStateSync throttle + gate', () => {
	it('throttles writePosition to once per interval for the same track', async () => {
		const t = make();
		t.sync.writePosition(1, 'u');
		t.sync.writePosition(2, 'u'); // same instant — throttled
		await Promise.resolve();
		expect(t.writes).toHaveLength(1);
		t.advance(10_000);
		t.sync.writePosition(3, 'u');
		await Promise.resolve();
		expect(t.writes).toHaveLength(2);
		expect(t.writes[1].position).toBe(3);
	});

	it('writes immediately when the track changes', async () => {
		const t = make();
		t.sync.writePosition(1, 'a');
		t.sync.writePosition(0, 'b'); // different url — not throttled
		await Promise.resolve();
		expect(t.writes.map((w) => w.trackUrl)).toEqual(['a', 'b']);
	});

	it('flushPosition bypasses the throttle', async () => {
		const t = make();
		t.sync.writePosition(1, 'u');
		t.sync.flushPosition(2, 'u');
		await Promise.resolve();
		expect(t.writes).toHaveLength(2);
	});

	it('no-ops when disabled', async () => {
		const t = make({ isEnabled: async () => false });
		t.sync.flushPosition(5, 'u');
		expect(await t.sync.readDeviceState('x')).toBeNull();
		await Promise.resolve();
		expect(t.writes).toHaveLength(0);
	});

	it('no-ops when signed out (uid null)', async () => {
		const t = make({ getUid: async () => null });
		t.sync.flushPosition(5, 'u');
		await Promise.resolve();
		expect(t.writes).toHaveLength(0);
	});

	it('readDeviceState returns the adapter doc', async () => {
		const t = make();
		t.setRead({ position: 77, trackUrl: 'u' });
		expect(await t.sync.readDeviceState('dev2')).toEqual({ position: 77, trackUrl: 'u' });
	});
});
```

- [ ] **Step 2: Run — fails** (module absent).

- [ ] **Step 3: Create `app/src/lib/music/deviceStateSync.ts`:**

```ts
/**
 * Channel B — ephemeral cross-device playback position.
 *
 * Writes THIS device's position to users/{uid}/deviceState/{deviceId} at most
 * once per `minIntervalMs` (timeupdate fires ~4×/s; the throttle keeps Firestore
 * writes to ~6/min while playing). Reads another device's position one-shot at
 * resume time. Gated on the same firebaseNotesEnabled + sign-in as note-sync.
 */
export interface DeviceStateDoc {
	position: number;
	trackUrl: string;
}

export interface DeviceStateAdapter {
	write(uid: string, deviceId: string, doc: DeviceStateDoc): Promise<void>;
	read(uid: string, deviceId: string): Promise<DeviceStateDoc | null>;
}

export interface DeviceStateSyncDeps {
	adapter: DeviceStateAdapter;
	getUid: () => Promise<string | null>;
	isEnabled: () => Promise<boolean>;
	getDeviceId: () => Promise<string>;
	now: () => number;
	minIntervalMs?: number;
}

export function createDeviceStateSync(deps: DeviceStateSyncDeps) {
	const minInterval = deps.minIntervalMs ?? 10_000;
	let lastWriteAt = -Infinity;
	let lastUrl = '';

	async function doWrite(position: number, trackUrl: string): Promise<void> {
		if (!(await deps.isEnabled())) return;
		const uid = await deps.getUid();
		if (!uid) return;
		const deviceId = await deps.getDeviceId();
		await deps.adapter.write(uid, deviceId, { position: Math.max(0, position), trackUrl });
	}

	return {
		/** Throttled — safe to call on every timeupdate. */
		writePosition(position: number, trackUrl: string): void {
			const t = deps.now();
			if (trackUrl === lastUrl && t - lastWriteAt < minInterval) return;
			lastWriteAt = t; // reserve the slot optimistically (avoid async bursts)
			lastUrl = trackUrl;
			void doWrite(position, trackUrl);
		},
		/** Immediate — pause/stop/seek. */
		flushPosition(position: number, trackUrl: string): void {
			lastWriteAt = deps.now();
			lastUrl = trackUrl;
			void doWrite(position, trackUrl);
		},
		async readDeviceState(deviceId: string): Promise<DeviceStateDoc | null> {
			if (!(await deps.isEnabled())) return null;
			const uid = await deps.getUid();
			if (!uid) return null;
			return deps.adapter.read(uid, deviceId);
		},
		__resetForTest(): void {
			lastWriteAt = -Infinity;
			lastUrl = '';
		}
	};
}
```

- [ ] **Step 4: Create the real adapter + singleton `app/src/lib/music/deviceStateSync.firestore.ts`.** Lazy-import the Firestore SDK so the startup music path doesn't pull it. Reuse the note-sync gate (`getCurrentNoteSyncUid`) and the install-id + setting.

```ts
import { getCurrentNoteSyncUid } from '$lib/sync/firebase/noteSyncClient.firestore.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import { getSetting } from '$lib/storage/appSettings.js';
import { getFirebaseFirestore } from '$lib/firebase/app.js';
import {
	createDeviceStateSync,
	type DeviceStateAdapter,
	type DeviceStateDoc
} from './deviceStateSync.js';

const FIREBASE_NOTES_ENABLED_KEY = 'firebaseNotesEnabled';

const firestoreAdapter: DeviceStateAdapter = {
	async write(uid, deviceId, docData) {
		const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
		await setDoc(
			doc(getFirebaseFirestore(), 'users', uid, 'deviceState', deviceId),
			{ position: docData.position, trackUrl: docData.trackUrl, updatedAt: serverTimestamp() },
			{ merge: true }
		);
	},
	async read(uid, deviceId): Promise<DeviceStateDoc | null> {
		const { doc, getDoc } = await import('firebase/firestore');
		const snap = await getDoc(doc(getFirebaseFirestore(), 'users', uid, 'deviceState', deviceId));
		if (!snap.exists()) return null;
		const d = snap.data() as Record<string, unknown>;
		return {
			position: typeof d.position === 'number' ? d.position : 0,
			trackUrl: typeof d.trackUrl === 'string' ? d.trackUrl : ''
		};
	}
};

/** App-wide singleton. */
export const deviceStateSync = createDeviceStateSync({
	adapter: firestoreAdapter,
	getUid: getCurrentNoteSyncUid,
	isEnabled: async () => (await getSetting<boolean>(FIREBASE_NOTES_ENABLED_KEY)) === true,
	getDeviceId: getOrCreateInstallId,
	now: () => Date.now()
});
```

- [ ] **Step 5: Run tests — pass.**
Run: `cd app && npx vitest run tests/unit/music/deviceStateSync.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 6: Commit:**
```bash
git add app/src/lib/music/deviceStateSync.ts app/src/lib/music/deviceStateSync.firestore.ts app/tests/unit/music/deviceStateSync.test.ts
git commit -m "feat(music): deviceStateSync — throttled Channel B position client + Firestore adapter"
```

---

### Task 4: Feed Channel B from the audio engine

**Goal:** The single audio engine reports position to `deviceStateSync` — throttled on `timeupdate`, flushed immediately on seek and on every transport event (so pause/stop capture the pre-clear position).

**Files:**
- Modify: `app/src/lib/music/musicAudio.svelte.ts`
- Modify: `app/src/lib/music/musicControl.svelte.ts` (transport→flush hook)
- Test: `app/tests/unit/music/deviceStatePlaybackWiring.test.ts`

**Acceptance Criteria:**
- [ ] On `timeupdate`, the engine calls `deviceStateSync.writePosition(currentTime, currentTrack.url)`.
- [ ] On a seek (requestSeek), the engine calls `deviceStateSync.flushPosition(...)`.
- [ ] On a transport event (play/pause/stop/track), `flushPosition` is called with the current track BEFORE any state clear (stop emits before clearing — verified by a non-null track in the flush).

**Verify:** `cd app && npx vitest run tests/unit/music/deviceStatePlaybackWiring.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Make the singleton swappable for tests.** In `deviceStateSync.firestore.ts`, the `deviceStateSync` export is the production singleton. The wiring test verifies call routing by spying on it. Add a tiny indirection so tests can observe calls without Firestore: export a mutable `reportPosition`/`flushReportedPosition` pair from a new `app/src/lib/music/deviceStatePlayback.ts`:

```ts
import { deviceStateSync } from './deviceStateSync.firestore.js';

/** Thin seam the audio engine + control-note transport hook call into. Kept
 *  separate from the Firestore singleton so unit tests can stub these two
 *  functions without importing the SDK. */
export function reportPlaybackPosition(position: number, trackUrl: string): void {
	deviceStateSync.writePosition(position, trackUrl);
}
export function flushPlaybackPosition(position: number, trackUrl: string): void {
	deviceStateSync.flushPosition(position, trackUrl);
}
```

- [ ] **Step 2: Wire the engine.** In `musicAudio.svelte.ts`:
  - Import: `import { reportPlaybackPosition, flushPlaybackPosition } from './deviceStatePlayback.js';`
  - In `onTime` (the `timeupdate` handler, currently `() => musicPlayer.reportTime(audio.currentTime || 0)`), append a Channel-B report:

```ts
const onTime = () => {
	const t = audio.currentTime || 0;
	musicPlayer.reportTime(t);
	const url = musicPlayer.currentTrack?.url;
	if (url) reportPlaybackPosition(t, url);
};
```

  - In the seek `$effect` (the one applying `pendingSeekTime`), after applying the seek, flush:

```ts
$effect(() => {
	musicPlayer.seekToken; // subscribe
	const target = musicPlayer.pendingSeekTime;
	if (Math.abs((audio.currentTime || 0) - target) > 0.25) audio.currentTime = target;
	const url = musicPlayer.currentTrack?.url;
	if (url) flushPlaybackPosition(target, url);
});
```

- [ ] **Step 3: Flush on transport.** In `musicControl.svelte.ts` `installMusicControl`, the existing transport subscription records the note; add a Channel-B flush in the SAME callback so pause/stop/track capture the pre-clear position:

```ts
const unsubTransport = musicPlayer.onTransport((kind) => {
	const t = musicPlayer.currentTrack;
	if (t) flushPlaybackPosition(musicPlayer.currentTime, t.url);
	void recordTransport(kind);
});
```
Add the import at the top of `musicControl.svelte.ts`:
`import { flushPlaybackPosition } from './deviceStatePlayback.js';`

- [ ] **Step 4: Write the wiring test** `app/tests/unit/music/deviceStatePlaybackWiring.test.ts`. Mock the seam module and assert routing via the engine + transport. Use `__musicAudioForTest()` to drive the element:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = { write: [] as [number, string][], flush: [] as [number, string][] };
vi.mock('$lib/music/deviceStatePlayback.js', () => ({
	reportPlaybackPosition: (p: number, u: string) => calls.write.push([p, u]),
	flushPlaybackPosition: (p: number, u: string) => calls.flush.push([p, u])
}));

import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import { installMusicAudio, __musicAudioForTest } from '$lib/music/musicAudio.svelte.js';

beforeEach(() => {
	calls.write.length = 0;
	calls.flush.length = 0;
	__resetMusicPlayer();
	__resetMusicProgress();
});

describe('Channel B engine wiring', () => {
	it('reports position on timeupdate', () => {
		const uninstall = installMusicAudio();
		musicPlayer.playNote('g', [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }], '음악::x');
		const { audio } = __musicAudioForTest();
		Object.defineProperty(audio!, 'currentTime', { value: 12, configurable: true });
		audio!.dispatchEvent(new Event('timeupdate'));
		expect(calls.write).toContainEqual([12, 'https://x/a.mp3']);
		uninstall();
	});

	it('flushes on seek', () => {
		const uninstall = installMusicAudio();
		musicPlayer.playNote('g', [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }], '음악::x');
		musicPlayer.requestSeek(30);
		expect(calls.flush.some(([p, u]) => p === 30 && u === 'https://x/a.mp3')).toBe(true);
		uninstall();
	});
});
```
(If `installMusicControl`'s transport-flush is hard to drive in this file, assert it in a focused control test instead — the key invariant is that the transport callback flushes a non-null track before clear; `musicControlWrite.test.ts` in Task 5 already drives transport and can assert `calls.flush` length ≥ 1.)

- [ ] **Step 5: Run + type-check:**
Run: `cd app && npx vitest run tests/unit/music/deviceStatePlaybackWiring.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 6: Commit:**
```bash
git add app/src/lib/music/deviceStatePlayback.ts app/src/lib/music/musicAudio.svelte.ts app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/deviceStatePlaybackWiring.test.ts
git commit -m "feat(music): feed Channel B position from the audio engine (timeupdate throttle + seek/transport flush)"
```

---

### Task 5: Slim the write path + add track-change transport

**Goal:** `recordTransport` writes the slim record (no queue/index/position); the player gains a `'track'` transport kind emitted on every track advance while playing, and emits `'pause'` when a queue runs out — so Channel A's `trackUrl` always reflects the current track.

**Files:**
- Modify: `app/src/lib/music/musicPlayer.svelte.ts`
- Modify: `app/src/lib/music/musicControl.svelte.ts`
- Test: `app/tests/unit/music/musicControlWrite.test.ts` (existing — merge), `app/tests/unit/music/musicPlayerTransport.test.ts`

**Acceptance Criteria:**
- [ ] `TransportKind` includes `'track'`; `STATE_BY_KIND.track === 'playing'`.
- [ ] `next()`/`prev()`/`reportEnded()` emit `'track'` when they advance to a different index while playing; they emit `'pause'` (not `'track'`) when the advance fails and playback stops.
- [ ] The initial gesture play still emits exactly one `'play'` (no spurious `'track'`).
- [ ] `recordTransport` writes a record with NO `queue`/`index`/`position` keys; the marker JSON for one device is < 320 bytes for a 5-track playlist.

**Verify:** `cd app && npx vitest run tests/unit/music/musicPlayerTransport.test.ts tests/unit/music/musicControlWrite.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write failing player-transport tests** `app/tests/unit/music/musicPlayerTransport.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';

const Q = [
	{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 },
	{ url: 'https://x/b.mp3', title: 'B', display: 'B', liPos: 0 }
];
let events: string[] = [];
beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
	events = [];
	musicPlayer.onTransport((k) => events.push(k));
});

describe('track-change transport', () => {
	it('emits "track" when next() advances while playing', () => {
		musicPlayer.playNote('g', Q, '음악::x'); // sets isPlaying=true (no transport — gesture funnel does that)
		events.length = 0;
		musicPlayer.next();
		expect(events).toEqual(['track']);
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('emits "pause" when next() runs off the end (no wrap)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		musicPlayer.play(1); // last track
		events.length = 0;
		musicPlayer.next(); // no next, repeat=off
		expect(events).toEqual(['pause']);
		expect(musicPlayer.isPlaying).toBe(false);
	});

	it('emits "track" on auto-advance (reportEnded)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		events.length = 0;
		musicPlayer.reportEnded();
		expect(events).toEqual(['track']);
		expect(musicPlayer.currentIndex).toBe(1);
	});
});
```

- [ ] **Step 2: Run — fails** (`'track'` not emitted yet).

- [ ] **Step 3: Edit `musicPlayer.svelte.ts`.**
  - Extend the type + map:

```ts
export type TransportKind = 'play' | 'pause' | 'stop' | 'track';
```

  - `next()` — emit `'track'` on advance, `'pause'` on stop:

```ts
next(): void {
	const i = stepIndex(1, repeat === 'all');
	if (i == null) {
		isPlaying = false;
		emitTransport('pause');
		return;
	}
	const changed = i !== currentIndex;
	this.play(i);
	if (changed) emitTransport('track');
},
```

  - `prev()` — emit `'track'` only when it actually moves to a different track:

```ts
prev(): void {
	const ord = playOrder();
	const pos = ord.indexOf(currentIndex);
	if (pos > 0) {
		this.play(ord[pos - 1]);
		emitTransport('track');
	} else {
		this.requestSeek(0);
	}
},
```

  - `reportEnded()` — emit `'track'` on each advance branch, `'pause'` when the queue is exhausted:

```ts
reportEnded(): void {
	if (queue.length === 0) {
		isPlaying = false;
		return;
	}
	if (repeat === 'one' && currentIndex >= 0) {
		this.requestSeek(0);
		isPlaying = true;
		return; // same track — no track-change record
	}
	const i = stepIndex(1, repeat === 'all');
	if (i == null) {
		isPlaying = false;
		emitTransport('pause');
		return;
	}
	if (i === currentIndex) {
		this.requestSeek(0);
		isPlaying = true;
		return;
	}
	this.play(i);
	emitTransport('track');
},
```

- [ ] **Step 4: Run player test — pass.**
Run: `cd app && npx vitest run tests/unit/music/musicPlayerTransport.test.ts` → PASS.

- [ ] **Step 5: Slim `recordTransport` in `musicControl.svelte.ts`.** Add `'track'` to the state map and drop the queue/index/position capture:

```ts
const STATE_BY_KIND: Record<TransportKind, TransportState> = {
	play: 'playing',
	pause: 'paused',
	stop: 'stopped',
	track: 'playing'
};
```

Replace the record body in `recordTransport` (remove `position`/`queue`/`index`):

```ts
export async function recordTransport(kind: TransportKind): Promise<void> {
	const track = musicPlayer.currentTrack;
	const noteGuid = musicPlayer.activeNoteGuid;
	const noteTitle = musicPlayer.activeNoteName;
	if (!track || !noteGuid) return;
	if (!(await isSharingEnabled())) return;
	const { id, name } = await deviceIdentity();
	const record: MusicControlRecord = {
		deviceId: id,
		deviceName: name,
		noteGuid,
		trackUrl: track.url,
		trackTitle: track.display,
		noteTitle,
		state: STATE_BY_KIND[kind],
		updatedAt: new Date().toISOString()
	};
	await ensureControlNote();
	await emitNoteFlush([MUSIC_CONTROL_GUID]);
	const fresh = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!fresh) return;
	const records = upsertRecords(parseRecordsFromXml(fresh.xmlContent), record);
	const newDoc = setMarkerRecordsInDoc(deserializeContent(fresh.xmlContent), records);
	await updateNoteFromEditor(MUSIC_CONTROL_GUID, newDoc);
}
```

- [ ] **Step 6: Update the existing write test** `app/tests/unit/music/musicControlWrite.test.ts` (read it first; it likely asserts `queue` is written — flip that to assert it is NOT). Add:

```ts
it('writes a slim record with no queue/index/position', async () => {
	await setSetting('firebaseNotesEnabled', true);
	musicPlayer.playNote('gx', [
		{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 },
		{ url: 'https://x/b.mp3', title: 'B', display: 'B', liPos: 0 }
	], '음악::x');
	await recordTransport('play');
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	expect(note!.xmlContent).not.toMatch(/"queue"/);
	expect(note!.xmlContent).not.toMatch(/"position"/);
	expect(note!.xmlContent).toMatch(/"trackUrl":"https:\/\/x\/a\.mp3"/);
});
```
(Wire imports/`beforeEach` resets to match the existing file — `__resetMusicPlayer`, `__resetMusicControlForTest`, fake-indexeddb, etc.)

- [ ] **Step 7: Run + type-check:**
Run: `cd app && npx vitest run tests/unit/music/musicControlWrite.test.ts tests/unit/music/musicPlayerTransport.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 8: Commit:**
```bash
git add app/src/lib/music/musicPlayer.svelte.ts app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/musicPlayerTransport.test.ts app/tests/unit/music/musicControlWrite.test.ts
git commit -m "feat(music): slim Channel A write + track-change transport kind"
```

---

### Task 6: Rewrite the read/restore path — re-parse queue, Channel-B position, cross-device auto-pause

**Goal:** `refreshFromNote` rebuilds the queue by re-parsing `noteGuid` (Task 2), reads the resume position one-shot from Channel B (Task 3), and — the headline single-playback feature — pauses THIS device when another device's newer record says `playing`.

**Files:**
- Modify: `app/src/lib/music/musicControl.svelte.ts`
- Test: `app/tests/unit/music/musicControlRead.test.ts` (existing — merge; some queue-field cases must be rewritten)

**Acceptance Criteria:**
- [ ] `tracksFromRecord(r)` returns the queue from `buildQueueFromXml(noteOf(r.noteGuid))`, indexed so `r.trackUrl` is the current track; falls back to a single synthetic track when the note is absent locally or has no parseable queue.
- [ ] `refreshFromNote` seeds `musicProgress` with the Channel-B position (when `deviceState.trackUrl === current trackUrl`), else 0.
- [ ] When `musicPlayer.isPlaying` AND a remote record (different `deviceId`) has `state==='playing'` AND its `updatedAt` is strictly newer than this device's last own action, `refreshFromNote` calls `musicPlayer.pause()` (queue preserved, not cleared).
- [ ] A remote `paused`/`stopped` record, or one not newer than our last action, does NOT pause us.
- [ ] The existing dedupe (re-delivered identical record does not re-restore) still holds.

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlRead.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Read `musicControlRead.test.ts`.** Cases that seed `queue`/`index` in the record (e.g. "restores the FULL queue", "restores at the recorded index") must be rewritten to seed a real MUSIC NOTE that `buildQueueFromXml` can parse, plus a slim control record pointing at it. Keep the dedupe + stopped-skip + "does NOT restore own device" cases.

- [ ] **Step 2: Add the new behaviors as failing tests.** Helper to seed a music note + a slim remote record:

```ts
import { buildQueueFromXml } from '$lib/music/headlessMusicParse.js'; // sanity import
import * as deviceState from '$lib/music/deviceStateSync.firestore.js';
import { vi } from 'vitest';

async function seedMusicNote(guid: string, urls: string[]) {
	const note = createEmptyNote(guid);
	note.title = '음악::로제';
	const doc = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '음악::로제' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: '플레이리스트:로제' }] },
			{
				type: 'bulletList',
				content: urls.map((u) => ({
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: u, marks: [{ type: 'tomboyUrlLink', attrs: { href: u } }] }] }]
				}))
			}
		]
	};
	note.xmlContent = serializeContent(doc);
	await noteStore.putNote(note);
}
```

Tests:

```ts
it('rebuilds the full queue from the note so ⏭ advances', async () => {
	await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3', 'https://x/c.mp3']);
	await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
	await refreshFromNote();
	expect(musicPlayer.queue).toHaveLength(3);
	expect(musicPlayer.currentIndex).toBe(0);
	musicPlayer.next();
	expect(musicPlayer.currentIndex).toBe(1);
});

it('indexes the queue at the record trackUrl', async () => {
	await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3']);
	await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/b.mp3' })]);
	await refreshFromNote();
	expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
});

it('falls back to a single synthetic track when the note is not local', async () => {
	await seedControlNote([remoteRec({ noteGuid: 'missing', trackUrl: 'https://x/z.mp3' })]);
	await refreshFromNote();
	expect(musicPlayer.queue).toHaveLength(1);
	expect(musicPlayer.currentTrack!.url).toBe('https://x/z.mp3');
});

it('seeds resume position from Channel B when trackUrl matches', async () => {
	vi.spyOn(deviceState.deviceStateSync, 'readDeviceState').mockResolvedValue({ position: 55, trackUrl: 'https://x/a.mp3' });
	await seedMusicNote('gR', ['https://x/a.mp3']);
	await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
	await refreshFromNote();
	musicPlayer.resume();
	expect(musicPlayer.resumeAt).toBeCloseTo(55, 0);
});

it('pauses this device when another device starts playing (newer)', async () => {
	// this device is playing locally
	musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
	expect(musicPlayer.isPlaying).toBe(true);
	await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2099-01-01T00:00:00.000Z' })]);
	await refreshFromNote();
	expect(musicPlayer.isPlaying).toBe(false); // auto-paused
	expect(musicPlayer.queue).toHaveLength(1); // queue NOT cleared
});

it('does NOT pause for a remote paused record', async () => {
	musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
	await seedControlNote([remoteRec({ state: 'paused', updatedAt: '2099-01-01T00:00:00.000Z' })]);
	await refreshFromNote();
	expect(musicPlayer.isPlaying).toBe(true);
});
```
(`remoteRec` from the existing file — extend its defaults to the slim shape: drop `position`, keep `state`/`updatedAt`/`deviceId`/`noteGuid`/`trackUrl`/`trackTitle`/`noteTitle`/`deviceName`.)

- [ ] **Step 3: Run — fails.**

- [ ] **Step 4: Rewrite `tracksFromRecord` + `refreshFromNote` in `musicControl.svelte.ts`.**
  - Imports:

```ts
import { buildQueueFromXml } from './headlessMusicParse.js';
import { deviceStateSync } from './deviceStateSync.firestore.js';
```

  - Track this device's last own action time (for the auto-pause "newer than mine" guard). Add a module var and set it in `recordTransport` right after building the record:

```ts
let lastOwnActionAt: string | null = null;
// inside recordTransport, after `const record = {...}`:
lastOwnActionAt = record.updatedAt;
```

  - Replace `tracksFromRecord` (now async — it reads IDB):

```ts
async function tracksFromRecord(r: MusicControlRecord): Promise<MusicTrack[]> {
	const note = await noteStore.getNote(r.noteGuid);
	if (note) {
		const q = buildQueueFromXml(note.xmlContent);
		if (q.length) return q;
	}
	return [syntheticTrack(r)];
}
```

  - Rewrite `refreshFromNote` with the auto-pause branch + Channel-B position. Full function:

```ts
export async function refreshFromNote(): Promise<void> {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		globalLatest = null;
		return;
	}
	const latest = pickGlobalLatest(parseRecordsFromXml(note.xmlContent));
	globalLatest = latest;
	if (!latest) return;

	const { id } = await deviceIdentity();
	if (latest.deviceId === id) return; // own record — nothing to do

	// #1 single playback: another device started playing more recently than our
	// last own action → stop our audio (keep the queue so the user can resume).
	if (
		latest.state === 'playing' &&
		musicPlayer.isPlaying &&
		(!lastOwnActionAt || latest.updatedAt > lastOwnActionAt)
	) {
		musicPlayer.pause();
		return;
	}

	if (musicPlayer.isPlaying) return; // never yank an active playback
	if (latest.state === 'stopped') return; // explicit stop is not resumable

	const sig = `${latest.deviceId}|${latest.updatedAt}|${latest.trackUrl}`;
	if (sig === lastAppliedSig) return;
	lastAppliedSig = sig;

	const tracks = await tracksFromRecord(latest);
	if (tracks.length === 0) return;
	const found = tracks.findIndex((t) => t.url === latest.trackUrl);
	const index = found >= 0 ? found : 0;

	// Channel B position (one-shot) — only when it belongs to this track.
	const ds = await deviceStateSync.readDeviceState(latest.deviceId);
	const position = ds && ds.trackUrl === tracks[index].url ? ds.position : 0;
	saveProgress(latest.noteGuid, tracks[index].url, position);

	musicPlayer.restoreSession({
		activeNoteGuid: latest.noteGuid,
		activeNoteName: latest.noteTitle,
		queue: tracks,
		currentIndex: index,
		originNoteGuid: latest.noteGuid
	});
}
```

  - Reset `lastOwnActionAt` in `__resetMusicControlForTest`:

```ts
export function __resetMusicControlForTest(): void {
	myDeviceId = null;
	globalLatest = null;
	lastAppliedSig = null;
	lastOwnActionAt = null;
}
```

- [ ] **Step 5: Run + type-check:**
Run: `cd app && npx vitest run tests/unit/music/musicControlRead.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 6: Commit:**
```bash
git add app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/musicControlRead.test.ts
git commit -m "feat(music): re-parse queue + Channel-B position + cross-device auto-pause"
```

---

### Task 7: Continuity decision logic + explicit remote-resume API

**Goal:** A pure predicate that decides whether to show the local/remote picker, plus a `musicControl` function that explicitly resumes a chosen remote record (re-parse + position + play) inside a gesture.

**Files:**
- Create: `app/src/lib/music/continuity.ts`
- Modify: `app/src/lib/music/musicControl.svelte.ts` (export `resumeGlobalLatest`, `getGlobalLatestForTest` already exists)
- Test: `app/tests/unit/music/continuity.test.ts`

**Acceptance Criteria:**
- [ ] `continuityChoice({ localTrackUrl, remote })` returns `'none'` (nothing to play), `'local'`, `'remote'`, or `'both'` (picker) per: both present and different track → `'both'`; only one → that one; same track → `'local'`; neither → `'none'`.
- [ ] `resumeGlobalLatest()` restores + plays the current `globalLatest` (re-parse queue + Channel-B seek) and returns true; returns false when there is no remote record.

**Verify:** `cd app && npx vitest run tests/unit/music/continuity.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write failing tests** `app/tests/unit/music/continuity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { continuityChoice } from '$lib/music/continuity.js';

describe('continuityChoice', () => {
	it('none when neither side has a track', () => {
		expect(continuityChoice({ localTrackUrl: null, remoteTrackUrl: null })).toBe('none');
	});
	it('local when only local', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: null })).toBe('local');
	});
	it('remote when only remote', () => {
		expect(continuityChoice({ localTrackUrl: null, remoteTrackUrl: 'b' })).toBe('remote');
	});
	it('both when present and different', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: 'b' })).toBe('both');
	});
	it('local when same track (no picker)', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: 'a' })).toBe('local');
	});
});
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Create `app/src/lib/music/continuity.ts`:**

```ts
export type ContinuityChoice = 'none' | 'local' | 'remote' | 'both';

/** Decide whether a play press should pop the local/remote picker.
 *  Picker only when both exist and point at DIFFERENT tracks. */
export function continuityChoice(args: {
	localTrackUrl: string | null;
	remoteTrackUrl: string | null;
}): ContinuityChoice {
	const { localTrackUrl, remoteTrackUrl } = args;
	if (!localTrackUrl && !remoteTrackUrl) return 'none';
	if (localTrackUrl && !remoteTrackUrl) return 'local';
	if (!localTrackUrl && remoteTrackUrl) return 'remote';
	return localTrackUrl === remoteTrackUrl ? 'local' : 'both';
}
```

- [ ] **Step 4: Add `resumeGlobalLatest` to `musicControl.svelte.ts`.** It reuses the restore path then plays (must be called inside a gesture; the caller follows with `resumePlaybackFromGesture`). Refactor the restore portion of `refreshFromNote` into a shared `restoreRecord(latest)` and call it here, bypassing the `isPlaying`/dedupe guards (explicit user intent):

```ts
/** Explicitly adopt the current global-latest remote record and play it. Returns
 *  false if there is no remote record. Call inside a user gesture, then call
 *  resumePlaybackFromGesture() so iOS unlocks the element. */
export async function resumeGlobalLatest(): Promise<boolean> {
	const latest = globalLatest;
	if (!latest) return false;
	const tracks = await tracksFromRecord(latest);
	if (tracks.length === 0) return false;
	const found = tracks.findIndex((t) => t.url === latest.trackUrl);
	const index = found >= 0 ? found : 0;
	const ds = await deviceStateSync.readDeviceState(latest.deviceId);
	const position = ds && ds.trackUrl === tracks[index].url ? ds.position : 0;
	saveProgress(latest.noteGuid, tracks[index].url, position);
	lastAppliedSig = `${latest.deviceId}|${latest.updatedAt}|${latest.trackUrl}`;
	musicPlayer.restoreSession({
		activeNoteGuid: latest.noteGuid,
		activeNoteName: latest.noteTitle,
		queue: tracks,
		currentIndex: index,
		originNoteGuid: latest.noteGuid
	});
	musicPlayer.resume();
	return true;
}
```

- [ ] **Step 5: Add a test for `resumeGlobalLatest`** in `musicControlRead.test.ts`:

```ts
it('resumeGlobalLatest adopts and plays the remote record', async () => {
	await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3']);
	await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/b.mp3' })]);
	await refreshFromNote(); // sets globalLatest
	const ok = await resumeGlobalLatest();
	expect(ok).toBe(true);
	expect(musicPlayer.isPlaying).toBe(true);
	expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
});
```

- [ ] **Step 6: Run + type-check:**
Run: `cd app && npx vitest run tests/unit/music/continuity.test.ts tests/unit/music/musicControlRead.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 7: Commit:**
```bash
git add app/src/lib/music/continuity.ts app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/continuity.test.ts app/tests/unit/music/musicControlRead.test.ts
git commit -m "feat(music): continuity choice predicate + explicit remote-resume API"
```

---

### Task 8: Continuity picker UI (mobile sheet + desktop rail menu)

**Goal:** Surface the local/remote choice — a bottom-sheet on mobile and an expand menu in the desktop rail — wired to `continuityChoice` + `resumeGlobalLatest`.

**Files:**
- Create: `app/src/lib/editor/musicNote/MusicContinuityPicker.svelte`
- Modify: `app/src/lib/editor/musicNote/RailMusicControls.svelte`
- Test: `app/tests/unit/music/continuityPicker.test.ts` (component render + selection)

**Acceptance Criteria:**
- [ ] `MusicContinuityPicker` renders two buttons: "이 기기에서 듣던 곡" (local) and "{deviceName}에서 듣던 곡" (remote), each showing its track title; selecting one emits `onpick` with `'local'`/`'remote'`.
- [ ] The rail play button, when `continuityChoice(...) === 'both'`, opens the menu instead of immediately resuming; choosing routes to local resume (`resumeOrRestart`) or `resumeGlobalLatest`, each followed by `resumePlaybackFromGesture()`.
- [ ] When choice is `'local'`/`'remote'`/`'none'`, the rail play button behaves as before (no menu).

**Verify:** `cd app && npx vitest run tests/unit/music/continuityPicker.test.ts` → pass; `cd app && npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: Create `MusicContinuityPicker.svelte`** (presentational; parent positions it as a sheet or a menu). Props: `localTitle`, `remoteTitle`, `remoteDeviceName`, `onpick`, `oncancel`.

```svelte
<script lang="ts">
	let {
		localTitle,
		remoteTitle,
		remoteDeviceName,
		onpick,
		oncancel
	}: {
		localTitle: string;
		remoteTitle: string;
		remoteDeviceName: string;
		onpick: (which: 'local' | 'remote') => void;
		oncancel: () => void;
	} = $props();
</script>

<div class="picker" role="dialog" aria-label="재생 위치 선택">
	<button type="button" class="opt" onclick={() => onpick('local')}>
		<span class="lbl">이 기기에서 듣던 곡</span>
		<span class="trk">{localTitle}</span>
	</button>
	<button type="button" class="opt" onclick={() => onpick('remote')}>
		<span class="lbl">{remoteDeviceName}에서 듣던 곡</span>
		<span class="trk">{remoteTitle}</span>
	</button>
	<button type="button" class="cancel" onclick={oncancel}>취소</button>
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
	}
	.opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 12px 14px;
		border: 1px solid var(--color-border, #333);
		border-radius: 10px;
		background: var(--color-bg, #111);
		color: var(--color-text, #eee);
		cursor: pointer;
		text-align: left;
	}
	.opt .lbl { font-size: 0.78rem; opacity: 0.7; }
	.opt .trk { font-size: 0.95rem; font-weight: 600; }
	.cancel {
		align-self: center;
		background: none;
		border: none;
		color: var(--color-text-secondary, #999);
		cursor: pointer;
		padding: 6px;
	}
</style>
```

- [ ] **Step 2: Wire the rail.** In `RailMusicControls.svelte`, import the picker + control API and branch `onPlayPause`:

```svelte
<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { getGlobalLatest, resumeGlobalLatest } from '$lib/music/musicControl.svelte.js';
	import { continuityChoice } from '$lib/music/continuity.js';
	import MusicContinuityPicker from './MusicContinuityPicker.svelte';

	const hasSession = $derived(musicPlayer.queue.length > 0);
	const playing = $derived(musicPlayer.isPlaying);
	let menuOpen = $state(false);

	function remote() {
		return getGlobalLatest();
	}

	async function pickRemote() {
		menuOpen = false;
		const ok = await resumeGlobalLatest();
		if (ok && musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function pickLocal() {
		menuOpen = false;
		musicPlayer.resumeOrRestart();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}

	function onPlayPause() {
		if (playing) {
			musicPlayer.pause();
			return;
		}
		const r = remote();
		const choice = continuityChoice({
			localTrackUrl: musicPlayer.currentTrack?.url ?? null,
			remoteTrackUrl: r?.trackUrl ?? null
		});
		if (choice === 'both') {
			menuOpen = true;
			return;
		}
		if (choice === 'remote') {
			void pickRemote();
			return;
		}
		pickLocal();
	}
	function onPrev() { musicPlayer.prev(); if (musicPlayer.isPlaying) resumePlaybackFromGesture(); }
	function onNext() { musicPlayer.next(); if (musicPlayer.isPlaying) resumePlaybackFromGesture(); }
</script>

<div class="rail-music" role="group" aria-label="음악 재생">
	<button type="button" onclick={onPrev} disabled={!hasSession} aria-label="이전 곡">⏮</button>
	<button
		type="button"
		class="play"
		onclick={onPlayPause}
		disabled={!hasSession && !remote()}
		aria-label={playing ? '일시정지' : '재생'}
	>{playing ? '⏸' : '▶'}</button>
	<button type="button" onclick={onNext} disabled={!hasSession} aria-label="다음 곡">⏭</button>
</div>

{#if menuOpen}
	<div class="rail-menu">
		<MusicContinuityPicker
			localTitle={musicPlayer.currentTrack?.display ?? ''}
			remoteTitle={remote()?.trackTitle ?? ''}
			remoteDeviceName={remote()?.deviceName ?? '다른 기기'}
			onpick={(w) => (w === 'remote' ? pickRemote() : pickLocal())}
			oncancel={() => (menuOpen = false)}
		/>
	</div>
{/if}

<style>
	/* keep the existing .rail-music styles; add the menu container */
	.rail-menu {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		z-index: var(--z-menu);
		background: var(--color-bg, #111);
		border: 1px solid var(--color-border, #333);
		border-radius: 10px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		margin-bottom: 6px;
	}
	/* ...preserve all prior .rail-music rules verbatim... */
</style>
```
(Preserve the existing `.rail-music` style block; only ADD `.rail-menu`. The rail container needs `position: relative` on its parent for the absolute menu — verify in `SidePanel.svelte`; if absent, wrap the controls in a `position: relative` div.)

- [ ] **Step 3: Component test** `app/tests/unit/music/continuityPicker.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import MusicContinuityPicker from '$lib/editor/musicNote/MusicContinuityPicker.svelte';

describe('MusicContinuityPicker', () => {
	it('renders both options and emits onpick', async () => {
		const onpick = vi.fn();
		const { getByText } = render(MusicContinuityPicker, {
			props: { localTitle: '로컬곡', remoteTitle: '리모트곡', remoteDeviceName: '아이폰', onpick, oncancel: () => {} }
		});
		expect(getByText('로컬곡')).toBeTruthy();
		expect(getByText('아이폰에서 듣던 곡')).toBeTruthy();
		await fireEvent.click(getByText('리모트곡'));
		expect(onpick).toHaveBeenCalledWith('remote');
	});
});
```

- [ ] **Step 4: Run + type-check:**
Run: `cd app && npx vitest run tests/unit/music/continuityPicker.test.ts` → PASS.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 5: Commit:**
```bash
git add app/src/lib/editor/musicNote/MusicContinuityPicker.svelte app/src/lib/editor/musicNote/RailMusicControls.svelte app/tests/unit/music/continuityPicker.test.ts
git commit -m "feat(music): local/remote continuity picker (rail menu + sheet component)"
```

---

### Task 9: Mobile home FAB + remove the floating pill

**Goal:** Add a round play/pause FAB to the home-note FAB stack (shown only on `?from=home` when there is something to play) wired to the continuity flow, and delete the floating `GlobalMiniPlayer` and its helpers.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte`
- Modify: `app/src/routes/+layout.svelte` (remove the `GlobalMiniPlayer` import + render)
- Delete: `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte`, `app/src/lib/editor/musicNote/miniPlayerVisibility.ts`, `app/src/lib/editor/musicNote/miniPlayerDrag.ts`
- Delete: any test of the deleted modules (e.g. `app/tests/unit/music/miniPlayerVisibility.test.ts` — grep first)
- Modify: `app/src/lib/editor/musicNote/index.ts` (drop deleted exports if re-exported)

**Acceptance Criteria:**
- [ ] On a note opened with `?from=home`, a `.fab-music` round button appears at `bottom: calc(88px + 56px * 2)` (above 📅/🎲) ONLY when `musicPlayer.queue.length > 0 || globalLatest != null`.
- [ ] The FAB shows ⏸ while playing and ▶ otherwise; tapping toggles play/pause via the continuity flow (picker when `'both'`), calling `resumePlaybackFromGesture()` on play.
- [ ] The FAB fades with the others on editor focus (joins the `:focus-within` selector).
- [ ] `GlobalMiniPlayer` is no longer imported or rendered anywhere; `grep -rn GlobalMiniPlayer app/src` returns nothing.
- [ ] `npm run check` passes (no dangling imports of deleted modules).

**Verify:** `cd app && grep -rn "GlobalMiniPlayer\|miniPlayerVisibility\|miniPlayerDrag" src` → no hits; `cd app && npm run check` → 0 errors; `cd app && npm run test` → green.

**Steps:**

- [ ] **Step 1: grep the blast radius:**
```bash
cd app && grep -rn "GlobalMiniPlayer\|miniPlayerVisibility\|miniPlayerDrag" src tests
```
Record every importer; each must be cleaned or deleted.

- [ ] **Step 2: Add the FAB markup** in `routes/note/[id]/+page.svelte`, right after the `{#if isFromHome}` 📅/🎲 block (around line 1059). Import the music store + continuity API in the script (top imports) and add a handler. In the script section add:

```ts
import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
import { getGlobalLatest, resumeGlobalLatest } from '$lib/music/musicControl.svelte.js';
import { continuityChoice } from '$lib/music/continuity.js';
import MusicContinuityPicker from '$lib/editor/musicNote/MusicContinuityPicker.svelte';

let musicMenuOpen = $state(false);
const musicRemote = $derived(getGlobalLatest());
const showMusicFab = $derived(isFromHome && (musicPlayer.queue.length > 0 || musicRemote != null));

async function pickRemoteMusic() {
	musicMenuOpen = false;
	const ok = await resumeGlobalLatest();
	if (ok && musicPlayer.isPlaying) resumePlaybackFromGesture();
}
function pickLocalMusic() {
	musicMenuOpen = false;
	musicPlayer.resumeOrRestart();
	if (musicPlayer.isPlaying) resumePlaybackFromGesture();
}
function onMusicFab() {
	if (musicPlayer.isPlaying) {
		musicPlayer.pause();
		return;
	}
	const choice = continuityChoice({
		localTrackUrl: musicPlayer.currentTrack?.url ?? null,
		remoteTrackUrl: musicRemote?.trackUrl ?? null
	});
	if (choice === 'both') { musicMenuOpen = true; return; }
	if (choice === 'remote') { void pickRemoteMusic(); return; }
	pickLocalMusic();
}
```

Markup (after the 🎲 button, still inside the `{#if isFromHome}` is wrong — the music FAB has its OWN visibility gate, so place it as a sibling `{#if showMusicFab}` right after the isFromHome block):

```svelte
{#if showMusicFab}
	<button
		class="fab-music"
		onclick={onMusicFab}
		aria-label={musicPlayer.isPlaying ? '음악 일시정지' : '음악 재생'}
	>{musicPlayer.isPlaying ? '⏸' : '▶'}</button>
{/if}

{#if musicMenuOpen}
	<div class="music-fab-sheet" role="dialog" aria-label="재생 위치 선택">
		<MusicContinuityPicker
			localTitle={musicPlayer.currentTrack?.display ?? ''}
			remoteTitle={musicRemote?.trackTitle ?? ''}
			remoteDeviceName={musicRemote?.deviceName ?? '다른 기기'}
			onpick={(w) => (w === 'remote' ? pickRemoteMusic() : pickLocalMusic())}
			oncancel={() => (musicMenuOpen = false)}
		/>
	</div>
{/if}
```

Styles (add near `.fab-today`):

```css
.fab-music {
	position: absolute;
	bottom: calc(88px + 56px * 2);
	right: 20px;
	width: 48px;
	height: 48px;
	border-radius: 50%;
	border: none;
	background: var(--color-bg);
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	font-size: 1.4rem;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	z-index: 10;
	transition: opacity 0.15s;
}
.fab-music:active { transform: scale(0.93); }
.music-fab-sheet {
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: var(--z-sheet);
	background: var(--color-bg);
	border-top: 1px solid var(--color-border, #333);
	box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
}
```

Add `.fab-music` to the focus-fade selector:

```css
.editor-area:focus-within ~ .fab-today,
.editor-area:focus-within ~ .fab-random,
.editor-area:focus-within ~ .fab-music,
.editor-area:focus-within ~ .fab-terminal-connect {
	opacity: 0;
	pointer-events: none;
}
```

- [ ] **Step 3: Remove the floating pill.** In `routes/+layout.svelte`: delete the `import GlobalMiniPlayer ...` line (~line 30) and the `<GlobalMiniPlayer />` render (~line 400). Then delete the three lib files and any re-export in `lib/editor/musicNote/index.ts`.

- [ ] **Step 4: Delete orphaned tests** found in Step 1 (e.g. `miniPlayerVisibility.test.ts`, `miniPlayerDrag.test.ts` if present).

- [ ] **Step 5: Verify clean removal + types:**
Run: `cd app && grep -rn "GlobalMiniPlayer\|miniPlayerVisibility\|miniPlayerDrag" src tests` → no hits.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 6: Commit:**
```bash
git add -A
git commit -m "feat(music): home-screen play FAB; remove floating GlobalMiniPlayer pill"
```

---

### Task 10: Guide card + full verification

**Goal:** Document the new behavior in 설정 → 가이드 and run the whole suite + type-check green.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (guide sub-tab `notes` — the existing 음악제어 / 음악 card)
- Test: full suite

**Acceptance Criteria:**
- [ ] A `<details class="guide-card">` in the `notes` guide sub-tab describes: one-place playback (other device stops), the home-screen play button, the local/remote picker, and that the floating pill was removed.
- [ ] `cd app && npm run check` → 0 errors.
- [ ] `cd app && npm run test` → all pass.

**Verify:** `cd app && npm run check && npm run test` → green.

**Steps:**

- [ ] **Step 1: Locate the music guide card** in `settings/+page.svelte` (search `음악::` or `음악제어`). Add/extend a card mirroring the existing pattern (short `<summary>`, one `<p class="info-text">`, a `<ul class="guide-list">`):

```svelte
<details class="guide-card">
	<summary>음악 — 기기 간 이어듣기</summary>
	<p class="info-text">
		음악은 한 곳에서만 재생됩니다. 다른 기기에서 재생을 누르면 지금 재생 중인 기기는 자동으로 멈춥니다.
	</p>
	<ul class="guide-list">
		<li>홈 화면의 둥근 ▶ 버튼으로 어디서든 재생/정지. 곡 선택·스킵은 음악 노트를 직접 엽니다.</li>
		<li>재생을 누를 때 이 기기와 다른 기기에서 듣던 곡이 다르면 어느 쪽을 이어들을지 고를 수 있습니다.</li>
		<li>재생 위치는 약 10초마다 저장돼, 다른 기기에서 누르면 듣던 지점부터 이어집니다(없으면 처음부터).</li>
		<li>예전의 떠다니던 미니 플레이어는 사라졌습니다 — 음악 조작은 홈 화면에서.</li>
	</ul>
</details>
```

- [ ] **Step 2: Full verification:**
Run: `cd app && npm run check` → 0 errors.
Run: `cd app && npm run test` → all pass.

- [ ] **Step 3: graphify update (project convention):**
```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu && graphify update . || true
```

- [ ] **Step 4: Commit:**
```bash
git add app/src/routes/settings/+page.svelte graphify-out 2>/dev/null; git add -A
git commit -m "docs(music): 가이드 카드 — 기기 간 단일 재생/홈 FAB/연속성 picker"
```

---

## Self-Review

**Spec coverage:**
- #1 single playback → Task 6 (auto-pause branch) + Task 5 (state writes).
- #2 home FAB + remove pill → Task 9.
- #3 continuity picker → Task 7 (logic) + Task 8 (UI) + Task 9 (mobile entry).
- #4 slim record + re-parse → Task 1 (schema) + Task 2 (parser) + Task 5 (slim write) + Task 6 (re-parse read).
- #5 Channel B position → Task 3 (module) + Task 4 (engine wiring) + Task 6 (resume read).
- track-change note write (channel consistency) → Task 5.
- guide card → Task 10. Firestore rule → confirmed already covered (`users/{uid}/**`), no task needed.

**Type consistency:** `MusicControlRecord` slim shape (Task 1) is consumed identically in Tasks 5/6/7. `tracksFromRecord` becomes async in Task 6 — all callers (`refreshFromNote`, `resumeGlobalLatest`) await it. `deviceStateSync` API (`writePosition`/`flushPosition`/`readDeviceState`) is stable across Tasks 3/4/6/7. `continuityChoice` signature stable across Tasks 7/8/9. `TransportKind` adds `'track'` (Task 5) consumed by `STATE_BY_KIND`.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The one soft spot — `RailMusicControls` parent needing `position: relative` for the absolute menu — is called out with a concrete check.

**Note on `getGlobalLatestForTest` naming:** it is reused as the live remote-record accessor in Tasks 8/9. Rename to `getGlobalLatest` during Task 7 (export both, or rename + update the existing read test) so production UI does not import a `*ForTest` name. Implementer: prefer renaming to `getGlobalLatest` and updating `musicControlRead.test.ts`.
