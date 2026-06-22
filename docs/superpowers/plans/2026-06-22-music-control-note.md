# 음악제어:: 노트 — 기기간 재생 상태 공유 (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single fixed-GUID `음악제어::` control note that records each device's explicit play/pause/stop into a hidden JSON block, so a stopped device's ▶ resumes the globally-most-recent track at its position.

**Architecture:** The control note is one note with a shared fixed GUID (so all devices map to the same Firestore doc). Its body carries one machine-owned paragraph `음악제어데이터::[…compact JSON records…]`, hidden in the editor via a decoration plugin. Each device upserts its record (by `deviceId`) on explicit transport events routed through a tiny emitter on `musicPlayer`. A reactive `musicControl` module keeps the global-most-recent record in memory and, when this device is not playing and the latest record is from another device, restores it as a ready (paused) single-track queue so the existing gesture-synchronous ▶ resumes it (iOS-safe). Cross-device sharing rides the existing opt-in Firestore note sync.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, idb, vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-06-22-music-control-note-design.md`

**Plan-time refinement vs spec:** v1 resume always builds a **single synthetic track** from the record (`trackUrl`/`trackTitle`/`position`) rather than re-parsing the origin note's full playlist. This avoids async schema-deserialize in the resume path and keeps the global pointer a ready 1-track queue. Re-parsing the origin note for full next/prev across its playlist is deferred (future). The record still stores `noteGuid`/`noteTitle` for that future use.

---

## File Structure

**New files:**
- `app/src/lib/music/musicControlNote.ts` — pure: constants, record type, parse/upsert/serialize/pick-latest of the JSON block.
- `app/src/lib/music/musicControl.svelte.ts` — read/write/global-pointer + install; the orchestration module.
- `app/src/lib/editor/musicControlNote/musicControlHidePlugin.ts` — ProseMirror plugin hiding the marker paragraph + caret guard.
- Test files mirroring the above under `app/tests/unit/music/`.

**Modified files:**
- `app/src/lib/music/musicPlayer.svelte.ts` — transport-event emitter (`onTransport`, `notifyExplicitPlay`, emit in `pause()`/`stop()`).
- `app/src/lib/music/musicAudio.svelte.ts` — `resumePlaybackFromGesture` emits explicit-play.
- `app/src/lib/storage/appSettings.ts` — `deviceName` get/set.
- `app/src/lib/editor/TomboyEditor.svelte` — register hide plugin gated on control-note guid + CSS.
- `app/src/routes/+layout.svelte` — install/uninstall `musicControl`.
- `app/src/routes/settings/+page.svelte` — device-name field (config tab) + guide card (notes sub-tab).

---

### Task 1: Pure control-note block module

**Goal:** Pure parse/upsert/serialize of the hidden JSON records block + constants + record type.

**Files:**
- Create: `app/src/lib/music/musicControlNote.ts`
- Test: `app/tests/unit/music/musicControlNote.test.ts`

**Acceptance Criteria:**
- [ ] `parseRecordsFromDoc` returns `[]` for a doc with no marker paragraph, and the records array when present.
- [ ] `upsertRecordInDoc` replaces a same-`deviceId` record (no duplicate) and appends the marker paragraph when absent, preserving all other content blocks.
- [ ] `pickGlobalLatest` returns the record with the lexicographically-greatest ISO `updatedAt`, `null` for empty.
- [ ] Round-trip: `parseRecordsFromDoc(upsertRecordInDoc(doc, r))` contains `r`.

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicControlNote.test.ts
import { describe, it, expect } from 'vitest';
import {
	parseRecordsFromDoc,
	upsertRecordInDoc,
	pickGlobalLatest,
	MUSIC_CONTROL_MARKER,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
import type { JSONContent } from '@tiptap/core';

const rec = (o: Partial<MusicControlRecord> = {}): MusicControlRecord => ({
	deviceId: 'dev-a',
	deviceName: '노트북',
	trackUrl: 'https://x/song.mp3',
	trackTitle: '곡',
	noteGuid: 'g1',
	noteTitle: '음악::플리',
	position: 12,
	state: 'paused',
	updatedAt: '2026-06-22T00:00:00.000Z',
	...o
});

const docWith = (...blocks: JSONContent[]): JSONContent => ({
	type: 'doc',
	content: [{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] }, ...blocks]
});

describe('musicControlNote', () => {
	it('parses empty when no marker', () => {
		expect(parseRecordsFromDoc(docWith())).toEqual([]);
	});

	it('upserts by deviceId without duplicating and preserves user content', () => {
		const userPara: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '내 메모' }] };
		let doc = docWith(userPara);
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', position: 1 }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-b', position: 2 }));
		doc = upsertRecordInDoc(doc, rec({ deviceId: 'dev-a', position: 9 })); // update a
		const recs = parseRecordsFromDoc(doc);
		expect(recs).toHaveLength(2);
		expect(recs.find((r) => r.deviceId === 'dev-a')!.position).toBe(9);
		// user content survives
		const texts = (doc.content ?? []).map((n) => n.content?.[0]?.text ?? '');
		expect(texts).toContain('내 메모');
		// exactly one marker paragraph
		const markers = (doc.content ?? []).filter((n) =>
			(n.content?.[0]?.text ?? '').startsWith(MUSIC_CONTROL_MARKER)
		);
		expect(markers).toHaveLength(1);
	});

	it('picks global latest by ISO updatedAt', () => {
		const latest = pickGlobalLatest([
			rec({ deviceId: 'a', updatedAt: '2026-06-22T00:00:00.000Z' }),
			rec({ deviceId: 'b', updatedAt: '2026-06-22T05:00:00.000Z' })
		]);
		expect(latest!.deviceId).toBe('b');
		expect(pickGlobalLatest([])).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts`
Expected: FAIL — module `$lib/music/musicControlNote.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/music/musicControlNote.ts
import type { JSONContent } from '@tiptap/core';

/** Fixed shared GUID — every device maps to the SAME Firestore doc. Like the
 *  sleepnote index note, this is a hardcoded constant, NOT generated per device. */
export const MUSIC_CONTROL_GUID = '2d9f1a40-7c3e-4b58-9e21-6f0c5a8d3b14';
export const MUSIC_CONTROL_TITLE = '음악제어::공유';
export const MUSIC_CONTROL_TITLE_PREFIX = '음악제어::';
/** Prefix of the single machine-owned paragraph holding compact JSON records. */
export const MUSIC_CONTROL_MARKER = '음악제어데이터::';

export type TransportState = 'playing' | 'paused' | 'stopped';

export interface MusicControlRecord {
	deviceId: string;
	deviceName: string;
	trackUrl: string;
	trackTitle: string;
	/** The music note that holds the track (activeNoteGuid). For future full-queue rebuild. */
	noteGuid: string;
	noteTitle: string;
	position: number;
	state: TransportState;
	/** ISO-8601 — sorts lexically, like Tomboy changeDate. */
	updatedAt: string;
}

export function isMusicControlNoteTitle(title: string): boolean {
	return (title ?? '').trimStart().startsWith(MUSIC_CONTROL_TITLE_PREFIX);
}

function paragraphText(node: JSONContent | undefined): string {
	if (!node?.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

function isRecord(v: unknown): v is MusicControlRecord {
	const e = v as Record<string, unknown>;
	return (
		!!e &&
		typeof e.deviceId === 'string' &&
		typeof e.trackUrl === 'string' &&
		typeof e.position === 'number' &&
		typeof e.updatedAt === 'string'
	);
}

function markerIndex(content: JSONContent[]): number {
	return content.findIndex((n) => paragraphText(n).startsWith(MUSIC_CONTROL_MARKER));
}

export function parseRecordsFromDoc(doc: JSONContent): MusicControlRecord[] {
	const content = doc?.content ?? [];
	const idx = markerIndex(content);
	if (idx === -1) return [];
	const text = paragraphText(content[idx]).slice(MUSIC_CONTROL_MARKER.length).trim();
	if (!text) return [];
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
	} catch {
		return [];
	}
}

export function serializeRecords(records: MusicControlRecord[]): string {
	return MUSIC_CONTROL_MARKER + JSON.stringify(records);
}

/** New doc with `record` upserted by deviceId into the marker paragraph.
 *  Marker absent → appended as the last block. Other blocks untouched. */
export function upsertRecordInDoc(doc: JSONContent, record: MusicControlRecord): JSONContent {
	const content = [...(doc?.content ?? [])];
	const next = parseRecordsFromDoc(doc).filter((r) => r.deviceId !== record.deviceId);
	next.push(record);
	const markerPara: JSONContent = {
		type: 'paragraph',
		content: [{ type: 'text', text: serializeRecords(next) }]
	};
	const idx = markerIndex(content);
	if (idx === -1) content.push(markerPara);
	else content[idx] = markerPara;
	return { ...doc, content };
}

export function pickGlobalLatest(records: MusicControlRecord[]): MusicControlRecord | null {
	let best: MusicControlRecord | null = null;
	for (const r of records) {
		if (!best || r.updatedAt > best.updatedAt) best = r;
	}
	return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicControlNote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/musicControlNote.ts app/tests/unit/music/musicControlNote.test.ts
git commit -m "feat(music): 음악제어 노트 JSON 블록 파서/upsert (pure)"
```

---

### Task 2: musicPlayer transport-event emitter

**Goal:** Add a tiny transport emitter to `musicPlayer` so explicit play/pause/stop can be observed without an import cycle.

**Files:**
- Modify: `app/src/lib/music/musicPlayer.svelte.ts`
- Test: `app/tests/unit/music/musicPlayerTransport.test.ts`

**Acceptance Criteria:**
- [ ] `musicPlayer.onTransport(fn)` registers a listener and returns an unsubscribe.
- [ ] `pause()` emits `'pause'`; `stop()` emits `'stop'` **before** clearing state (so a listener can read `currentTrack`/`activeNoteGuid`); `notifyExplicitPlay()` emits `'play'`.
- [ ] `__resetMusicPlayer()` clears transport listeners.

**Verify:** `cd app && npx vitest run tests/unit/music/musicPlayerTransport.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicPlayerTransport.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';

beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
});

const tracks = [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }];

describe('musicPlayer transport emitter', () => {
	it('emits play/pause/stop and stop fires before state clears', () => {
		const seen: Array<{ kind: string; hadTrack: boolean }> = [];
		const off = musicPlayer.onTransport((kind) =>
			seen.push({ kind, hadTrack: !!musicPlayer.currentTrack })
		);

		musicPlayer.playNote('g1', tracks, '음악::x');
		musicPlayer.notifyExplicitPlay();
		musicPlayer.pause();
		musicPlayer.stop();
		off();

		expect(seen.map((s) => s.kind)).toEqual(['play', 'pause', 'stop']);
		// stop emitted while track still present
		expect(seen.find((s) => s.kind === 'stop')!.hadTrack).toBe(true);
		// after stop, queue is cleared
		expect(musicPlayer.currentTrack).toBeNull();
	});

	it('unsubscribe stops delivery', () => {
		let n = 0;
		const off = musicPlayer.onTransport(() => n++);
		off();
		musicPlayer.notifyExplicitPlay();
		expect(n).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicPlayerTransport.test.ts`
Expected: FAIL — `musicPlayer.onTransport is not a function`.

- [ ] **Step 3: Add the emitter to `musicPlayer.svelte.ts`**

Near the top module state (after the `let resumeAt = $state(0);` block, before `clampIndex`), add:

```ts
export type TransportKind = 'play' | 'pause' | 'stop';
const transportListeners = new Set<(k: TransportKind) => void>();
function emitTransport(k: TransportKind): void {
	for (const fn of Array.from(transportListeners)) {
		try {
			fn(k);
		} catch {
			/* a broken transport listener must not break playback */
		}
	}
}
```

In `__resetMusicPlayer()` add at the end of the body:

```ts
	transportListeners.clear();
```

In the `musicPlayer` object, add these methods (e.g. right after `resumeOrRestart`):

```ts
	,
	/** Subscribe to explicit transport events (play/pause/stop). Returns unsubscribe.
	 *  No import cycle: consumers register here; musicPlayer never imports them. */
	onTransport(fn: (k: TransportKind) => void): () => void {
		transportListeners.add(fn);
		return () => transportListeners.delete(fn);
	},
	/** Emit an explicit 'play' — called by resumePlaybackFromGesture (the sole
	 *  user-gesture play funnel). Auto-advance (reportEnded/next) does NOT call this. */
	notifyExplicitPlay(): void {
		emitTransport('play');
	}
```

In `pause()`, after the existing `saveProgress(...)/flushProgress()` block, add:

```ts
		emitTransport('pause');
```

In `stop()`, the body currently saves progress then clears fields. Insert the emit **between** the saveProgress/flush block and the clearing assignments:

```ts
	stop(): void {
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
			flushProgress();
		}
		emitTransport('stop'); // BEFORE clearing — listener still sees currentTrack/activeNoteGuid
		isPlaying = false;
		queue = [];
		currentIndex = -1;
		currentTime = 0;
		duration = 0;
		activeNoteGuid = null;
		activeNoteName = '';
		originNoteGuid = null;
		pendingRestore = 0;
		resumeAt = 0;
	},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicPlayerTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/musicPlayer.svelte.ts app/tests/unit/music/musicPlayerTransport.test.ts
git commit -m "feat(music): musicPlayer 트랜스포트 이벤트 emitter (play/pause/stop)"
```

---

### Task 3: Emit explicit-play from the gesture funnel

**Goal:** `resumePlaybackFromGesture` notifies an explicit play after starting playback, so the record hook fires for every gesture-driven play (and only those).

**Files:**
- Modify: `app/src/lib/music/musicAudio.svelte.ts:45-52`

**Acceptance Criteria:**
- [ ] `resumePlaybackFromGesture()` calls `musicPlayer.notifyExplicitPlay()` after `audio.play()`.
- [ ] Type check passes.

**Verify:** `cd app && npm run check` → no new errors in `musicAudio.svelte.ts`.

**Steps:**

- [ ] **Step 1: Edit `resumePlaybackFromGesture`**

Replace the body so it ends by notifying explicit play (the `musicPlayer` import already exists at the top of the file):

```ts
export function resumePlaybackFromGesture(): void {
	const audio = audioEl;
	if (!audio) return;
	const url = musicPlayer.currentTrack?.url ?? '';
	if (!url) return;
	if ((audio.getAttribute('src') ?? '') !== url) audio.src = url;
	void audio.play().catch(() => {});
	// Record this explicit play to the control note (fire-and-forget; async IDB
	// write must NOT block the synchronous gesture-time play() above).
	musicPlayer.notifyExplicitPlay();
}
```

- [ ] **Step 2: Verify type check**

Run: `cd app && npm run check`
Expected: no new errors referencing `musicAudio.svelte.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/music/musicAudio.svelte.ts
git commit -m "feat(music): 제스처 재생 시 explicit-play 이벤트 발행"
```

---

### Task 4: appSettings device name

**Goal:** Persist a user-set device name (used as the per-device record label).

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts`
- Test: `app/tests/unit/storage/deviceName.test.ts`

**Acceptance Criteria:**
- [ ] `getDeviceName()` returns `''` when unset and the stored trimmed value otherwise.
- [ ] `setDeviceName(v)` stores the trimmed value.

**Verify:** `cd app && npx vitest run tests/unit/storage/deviceName.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/storage/deviceName.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { getDeviceName, setDeviceName } from '$lib/storage/appSettings.js';

describe('deviceName setting', () => {
	it('defaults to empty and round-trips trimmed', async () => {
		expect(await getDeviceName()).toBe('');
		await setDeviceName('  내 노트북  ');
		expect(await getDeviceName()).toBe('내 노트북');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/storage/deviceName.test.ts`
Expected: FAIL — `getDeviceName` is not exported.

- [ ] **Step 3: Add to `appSettings.ts`** (append near the end of the file)

```ts
// ── Device name (기기 이름) ───────────────────────────────────────────
// User-set label for THIS device/browser. Used by the 음악제어:: control note
// to label per-device playback records. Generic on purpose (future reuse).

const DEVICE_NAME = 'deviceName';

export async function getDeviceName(): Promise<string> {
	const v = await getSetting<string>(DEVICE_NAME);
	return typeof v === 'string' ? v : '';
}

export async function setDeviceName(value: string): Promise<void> {
	await setSetting(DEVICE_NAME, value.trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/storage/deviceName.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/storage/appSettings.ts app/tests/unit/storage/deviceName.test.ts
git commit -m "feat(settings): deviceName 설정 get/set"
```

---

### Task 5: musicControl — write path (record transport)

**Goal:** On explicit transport, upsert this device's record into the fixed-GUID control note (get-or-create), gated on the Firestore sync toggle.

**Files:**
- Create: `app/src/lib/music/musicControl.svelte.ts`
- Test: `app/tests/unit/music/musicControlWrite.test.ts`

**Acceptance Criteria:**
- [ ] When the toggle is OFF, `recordTransport` is a no-op (no note created).
- [ ] When ON, the first record creates the control note (guid `MUSIC_CONTROL_GUID`, title `음악제어::공유`) and writes a record whose `deviceId === getOrCreateInstallId()`, `state` mapped from kind, `trackUrl`/`position` from the captured player snapshot.
- [ ] A second record from the same device updates (not duplicates) the record.
- [ ] The player snapshot is captured synchronously (a record written on `'stop'` still has the track URL even though `stop()` clears state immediately after emitting).

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlWrite.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicControlWrite.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import { recordTransport, __resetMusicControlForTest } from '$lib/music/musicControl.svelte.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseRecordsFromDoc, MUSIC_CONTROL_GUID } from '$lib/music/musicControlNote.js';

const tracks = [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }];

async function records() {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	return note ? parseRecordsFromDoc(deserializeContent(note.xmlContent)) : [];
}

beforeEach(async () => {
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	// wipe the control note between tests
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	await setSetting('firebaseNotesEnabled', false);
});

describe('musicControl write path', () => {
	it('no-op when sync toggle is off', async () => {
		musicPlayer.playNote('g1', tracks, '음악::x');
		await recordTransport('play');
		expect(await noteStore.getNote(MUSIC_CONTROL_GUID)).toBeUndefined();
	});

	it('creates the control note and upserts this device record when on', async () => {
		await setSetting('firebaseNotesEnabled', true);
		musicPlayer.playNote('g1', tracks, '음악::x');
		musicPlayer.requestSeek(30);
		await recordTransport('play');

		const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
		expect(note).toBeDefined();
		expect(note!.title).toBe('음악제어::공유');
		let recs = await records();
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3');
		expect(recs[0].state).toBe('playing');
		expect(recs[0].position).toBeCloseTo(30, 0);

		// second event from same device updates, not duplicates
		musicPlayer.requestSeek(45);
		await recordTransport('pause');
		recs = await records();
		expect(recs).toHaveLength(1);
		expect(recs[0].state).toBe('paused');
		expect(recs[0].position).toBeCloseTo(45, 0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicControlWrite.test.ts`
Expected: FAIL — module `$lib/music/musicControl.svelte.js` not found.

- [ ] **Step 3: Create `musicControl.svelte.ts`** (write half — read half added in Task 6)

```ts
// app/src/lib/music/musicControl.svelte.ts
import { musicPlayer, type TransportKind } from './musicPlayer.svelte.js';
import {
	MUSIC_CONTROL_GUID,
	MUSIC_CONTROL_TITLE,
	type MusicControlRecord,
	type TransportState,
	upsertRecordInDoc
} from './musicControlNote.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote, escapeXml, NOTE_CONTENT_VERSION } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { noteMutated } from '$lib/stores/noteListCache.js';
import { emitNoteFlush } from '$lib/core/noteReloadBus.js';
import { getSetting, getDeviceName } from '$lib/storage/appSettings.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';

const FIREBASE_NOTES_ENABLED_KEY = 'firebaseNotesEnabled';

let myDeviceId: string | null = null;

const STATE_BY_KIND: Record<TransportKind, TransportState> = {
	play: 'playing',
	pause: 'paused',
	stop: 'stopped'
};

async function isSharingEnabled(): Promise<boolean> {
	return (await getSetting<boolean>(FIREBASE_NOTES_ENABLED_KEY)) === true;
}

async function deviceIdentity(): Promise<{ id: string; name: string }> {
	if (!myDeviceId) myDeviceId = await getOrCreateInstallId();
	const stored = await getDeviceName();
	const name = stored || `기기-${myDeviceId.slice(0, 4)}`;
	return { id: myDeviceId, name };
}

async function ensureControlNote() {
	let note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		note = createEmptyNote(MUSIC_CONTROL_GUID);
		note.title = MUSIC_CONTROL_TITLE;
		note.xmlContent = `<note-content version="${NOTE_CONTENT_VERSION}">${escapeXml(
			MUSIC_CONTROL_TITLE
		)}\n\n</note-content>`;
		await noteStore.putNote(note);
		notifyNoteSaved(MUSIC_CONTROL_GUID);
		noteMutated(note);
	}
	return note;
}

/** Record an explicit transport event for THIS device into the control note.
 *  Snapshot of player state is captured SYNCHRONOUSLY at the top, before any
 *  await — stop() clears musicPlayer immediately after emitting 'stop'. */
export async function recordTransport(kind: TransportKind): Promise<void> {
	const track = musicPlayer.currentTrack;
	const noteGuid = musicPlayer.activeNoteGuid;
	const noteTitle = musicPlayer.activeNoteName;
	const position = musicPlayer.currentTime;
	if (!track || !noteGuid) return;

	if (!(await isSharingEnabled())) return;
	const { id, name } = await deviceIdentity();
	const record: MusicControlRecord = {
		deviceId: id,
		deviceName: name,
		trackUrl: track.url,
		trackTitle: track.display,
		noteGuid,
		noteTitle,
		position: Math.max(0, position),
		state: STATE_BY_KIND[kind],
		updatedAt: new Date().toISOString()
	};

	await ensureControlNote();
	// Drain any open editor's pending edit to IDB first, then read the freshest
	// body, splice our record, and persist. updateNoteFromEditor handles
	// serialize + putNote + notifyNoteSaved (Firestore push) + emitNoteReload.
	await emitNoteFlush([MUSIC_CONTROL_GUID]);
	const fresh = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!fresh) return;
	const newDoc = upsertRecordInDoc(deserializeContent(fresh.xmlContent), record);
	await updateNoteFromEditor(MUSIC_CONTROL_GUID, newDoc);
}

/** Test-only reset. */
export function __resetMusicControlForTest(): void {
	myDeviceId = null;
}
```

Note: confirm `noteStore` exports `deleteNote` (used by the test). It does — `putNote` peer. If the export name differs, adjust the test's teardown accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicControlWrite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/musicControlWrite.test.ts
git commit -m "feat(music): 음악제어 노트 기록 쓰기(기기별 upsert, 토글 게이트)"
```

---

### Task 6: musicControl — read path, global pointer + install

**Goal:** Keep the global-most-recent record in memory; restore it as a ready (paused) single-track queue when this device is not playing and the latest record is from another device. Install boot read + control-note subscription + transport listener.

**Files:**
- Modify: `app/src/lib/music/musicControl.svelte.ts`
- Test: `app/tests/unit/music/musicControlRead.test.ts`

**Acceptance Criteria:**
- [ ] `refreshFromNote()` parses the control note and sets the in-memory global-latest.
- [ ] When not playing and the latest record's `deviceId !== getOrCreateInstallId()`, the player is restored to a ready single-track queue (`activeNoteGuid`/`activeNoteName` from the record, one track whose url = `trackUrl`, `pendingRestore` = `position`), `isPlaying === false`.
- [ ] When the latest record is from THIS device, the player is NOT mutated (richer local session preserved).
- [ ] When the player is currently playing, the player is NOT mutated (no yank).
- [ ] `installMusicControl()` returns an uninstall that removes the reload subscription and the transport listener.

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlRead.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/music/musicControlRead.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import { refreshFromNote, __resetMusicControlForTest } from '$lib/music/musicControl.svelte.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { createEmptyNote, escapeXml, NOTE_CONTENT_VERSION } from '$lib/core/note.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import {
	MUSIC_CONTROL_GUID,
	MUSIC_CONTROL_TITLE,
	serializeRecords,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';

async function seedControlNote(records: MusicControlRecord[]) {
	const note = createEmptyNote(MUSIC_CONTROL_GUID);
	note.title = MUSIC_CONTROL_TITLE;
	const doc = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
			{ type: 'paragraph', content: [{ type: 'text', text: serializeRecords(records) }] }
		]
	};
	note.xmlContent = serializeContent(doc);
	await noteStore.putNote(note);
}

const remoteRec = (o: Partial<MusicControlRecord> = {}): MusicControlRecord => ({
	deviceId: 'other-device',
	deviceName: '아이폰',
	trackUrl: 'https://x/remote.mp3',
	trackTitle: '리모트곡',
	noteGuid: 'gR',
	noteTitle: '음악::리모트',
	position: 42,
	state: 'paused',
	updatedAt: '2026-06-22T10:00:00.000Z',
	...o
});

beforeEach(async () => {
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	await setSetting('firebaseNotesEnabled', true);
});

describe('musicControl read path', () => {
	it('restores a ready paused single-track queue from a remote latest', async () => {
		await seedControlNote([remoteRec()]);
		await refreshFromNote();

		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteGuid).toBe('gR');
		expect(musicPlayer.queue).toHaveLength(1);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/remote.mp3');
		expect(musicPlayer.resumeAt).toBe(0); // not promoted until resume()
		musicPlayer.resume();
		expect(musicPlayer.resumeAt).toBeCloseTo(42, 0); // pendingRestore promoted
	});

	it('does NOT restore when latest is this device', async () => {
		const myId = await getOrCreateInstallId();
		await seedControlNote([remoteRec({ deviceId: myId, updatedAt: '2026-06-22T11:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(0);
	});

	it('does NOT yank while playing', async () => {
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		await seedControlNote([remoteRec()]);
		await refreshFromNote();
		expect(musicPlayer.activeNoteGuid).toBe('local');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicControlRead.test.ts`
Expected: FAIL — `refreshFromNote` is not exported.

- [ ] **Step 3: Extend `musicControl.svelte.ts`**

Add imports at the top (merge with existing import lines):

```ts
import { saveProgress } from './musicProgress.js';
import { parseRecordsFromDoc, pickGlobalLatest } from './musicControlNote.js';
import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
import type { MusicTrack } from './parseMusicNote.js';
```

Add module state + the read/install functions (after the write path):

```ts
let globalLatest = $state<MusicControlRecord | null>(null);

function syntheticTrack(r: MusicControlRecord): MusicTrack {
	return {
		url: r.trackUrl,
		title: r.trackTitle || null,
		display: r.trackTitle || r.trackUrl,
		liPos: -1
	};
}

/** Re-read the control note, recompute the global-latest pointer, and (when
 *  safe) restore it as a ready paused queue so the existing ▶ resumes it
 *  synchronously inside the user gesture. */
export async function refreshFromNote(): Promise<void> {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		globalLatest = null;
		return;
	}
	const latest = pickGlobalLatest(parseRecordsFromDoc(deserializeContent(note.xmlContent)));
	globalLatest = latest;
	if (!latest) return;
	if (musicPlayer.isPlaying) return; // never yank an active playback
	const { id } = await deviceIdentity();
	if (latest.deviceId === id) return; // own device → keep richer local session

	// Seed musicProgress so restoreSession's loadProgress matches our synthetic
	// track's url and promotes `position` into pendingRestore.
	saveProgress(latest.noteGuid, latest.trackUrl, latest.position);
	musicPlayer.restoreSession({
		activeNoteGuid: latest.noteGuid,
		activeNoteName: latest.noteTitle,
		queue: [syntheticTrack(latest)],
		currentIndex: 0,
		originNoteGuid: latest.noteGuid
	});
}

export function getGlobalLatestForTest(): MusicControlRecord | null {
	return globalLatest;
}

/** Boot read + subscribe to control-note changes + listen for transport events.
 *  Install once from +layout. Returns uninstall. */
export function installMusicControl(): () => void {
	if (typeof window === 'undefined') return () => {};
	void refreshFromNote();
	const unsubReload = subscribeNoteReload(MUSIC_CONTROL_GUID, () => {
		void refreshFromNote();
	});
	const unsubTransport = musicPlayer.onTransport((kind) => {
		void recordTransport(kind);
	});
	return () => {
		unsubReload();
		unsubTransport();
	};
}
```

Also extend `__resetMusicControlForTest` to clear the pointer:

```ts
export function __resetMusicControlForTest(): void {
	myDeviceId = null;
	globalLatest = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicControlRead.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/music/musicControl.svelte.ts app/tests/unit/music/musicControlRead.test.ts
git commit -m "feat(music): 음악제어 전역 포인터 읽기 + 준비 큐 복원 + install"
```

---

### Task 7: Install musicControl in the layout

**Goal:** Wire `installMusicControl()` into the app shell alongside the other music installers.

**Files:**
- Modify: `app/src/routes/+layout.svelte:26-27,253-254,304-305`

**Acceptance Criteria:**
- [ ] `installMusicControl()` is called once where `installMusicAudio()`/`installMusicSession()` are, and its uninstall runs in the same cleanup.
- [ ] `npm run check` passes; app boots without console errors.

**Verify:** `cd app && npm run check` → no new errors; `npm run dev` boots cleanly.

**Steps:**

- [ ] **Step 1: Add the import** (next to the existing music installers, ~line 27)

```ts
	import { installMusicControl } from '$lib/music/musicControl.svelte.js';
```

- [ ] **Step 2: Install it** (right after `const uninstallMusicSession = installMusicSession();`, ~line 254)

```ts
		const uninstallMusicControl = installMusicControl();
```

- [ ] **Step 3: Uninstall it** (in the same cleanup block, next to `uninstallMusicSession();`, ~line 305)

```ts
			uninstallMusicControl();
```

- [ ] **Step 4: Verify**

Run: `cd app && npm run check`
Expected: no new errors. Then `npm run dev`, open the app, confirm no console errors at boot.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/+layout.svelte
git commit -m "feat(music): +layout 에서 musicControl 설치"
```

---

### Task 8: Hide-block editor plugin

**Goal:** Hide the `음악제어데이터::` marker paragraph in the editor (display:none + caret guard), active only on the control note. Raw XML viewer still shows it.

**Files:**
- Create: `app/src/lib/editor/musicControlNote/musicControlHidePlugin.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (register extension + CSS)
- Test: `app/tests/unit/music/musicControlHidePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `createMusicControlHidePlugin({enabled})` returns a Plugin that, when `enabled()` is true and a marker paragraph exists, decorates that node with class `tomboy-music-control-hidden`; otherwise emits no decorations.
- [ ] A selection landing inside the marker block is moved out via `appendTransaction`.
- [ ] In `TomboyEditor.svelte` the plugin is gated on `currentGuid === MUSIC_CONTROL_GUID`; CSS hides the class.
- [ ] An editor mount test confirms the marker node carries the hidden class; the editor is destroyed in `afterEach` (no teardown leak — see `project_flaky_ocr_test_teardown`).

**Verify:** `cd app && npx vitest run tests/unit/music/musicControlHidePlugin.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test** (mount an editor, assert decoration class present)

```ts
// app/tests/unit/music/musicControlHidePlugin.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { createMusicControlHidePlugin } from '$lib/editor/musicControlNote/musicControlHidePlugin.js';
import { MUSIC_CONTROL_MARKER } from '$lib/music/musicControlNote.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function mount(enabled: boolean) {
	const ext = Extension.create({
		name: 'mcHideTest',
		addProseMirrorPlugins() {
			return [createMusicControlHidePlugin({ enabled: () => enabled })];
		}
	});
	const el = document.createElement('div');
	document.body.appendChild(el);
	editor = new Editor({
		element: el,
		extensions: [StarterKit, ext],
		content: {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '음악제어::공유' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '보이는 메모' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: `${MUSIC_CONTROL_MARKER}[{"deviceId":"a"}]` }] }
			]
		}
	});
	return editor;
}

describe('musicControlHidePlugin', () => {
	it('hides the marker paragraph when enabled', () => {
		mount(true);
		const hidden = editor!.view.dom.querySelector('.tomboy-music-control-hidden');
		expect(hidden).not.toBeNull();
		expect(hidden!.textContent).toContain(MUSIC_CONTROL_MARKER);
	});

	it('does not hide when disabled', () => {
		mount(false);
		expect(editor!.view.dom.querySelector('.tomboy-music-control-hidden')).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/music/musicControlHidePlugin.test.ts`
Expected: FAIL — plugin module not found.

- [ ] **Step 3: Create the plugin**

```ts
// app/src/lib/editor/musicControlNote/musicControlHidePlugin.ts
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { MUSIC_CONTROL_MARKER } from '$lib/music/musicControlNote.js';

export const musicControlHidePluginKey = new PluginKey('musicControlHide');

/** {from,to} of the top-level marker block, or null. */
function findMarkerRange(doc: PMNode): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;
	doc.forEach((node, offset) => {
		if (result) return;
		if (node.isTextblock && node.textContent.startsWith(MUSIC_CONTROL_MARKER)) {
			result = { from: offset, to: offset + node.nodeSize };
		}
	});
	return result;
}

export function createMusicControlHidePlugin(opts: { enabled: () => boolean }): Plugin {
	return new Plugin({
		key: musicControlHidePluginKey,
		props: {
			decorations(state) {
				if (!opts.enabled()) return DecorationSet.empty;
				const range = findMarkerRange(state.doc);
				if (!range) return DecorationSet.empty;
				return DecorationSet.create(state.doc, [
					Decoration.node(range.from, range.to, { class: 'tomboy-music-control-hidden' })
				]);
			}
		},
		// Keep the caret out of the hidden marker block.
		appendTransaction(_trs, _old, newState) {
			if (!opts.enabled()) return null;
			const range = findMarkerRange(newState.doc);
			if (!range) return null;
			const sel = newState.selection;
			const inside = (p: number) => p > range.from && p < range.to;
			if (inside(sel.anchor) || inside(sel.head)) {
				const target = Math.max(0, range.from - 1);
				return newState.tr.setSelection(TextSelection.create(newState.doc, target));
			}
			return null;
		}
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/music/musicControlHidePlugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Register in `TomboyEditor.svelte`**

Add imports with the other editor imports:

```ts
	import { createMusicControlHidePlugin } from '$lib/editor/musicControlNote/musicControlHidePlugin.js';
	import { MUSIC_CONTROL_GUID } from '$lib/music/musicControlNote.js';
```

In the `extensions` array, alongside the other inline `Extension.create({...})` plugins (e.g. near `tomboyAutoWeekday`), add:

```ts
			Extension.create({
				name: 'tomboyMusicControlHide',
				addProseMirrorPlugins() {
					return [
						createMusicControlHidePlugin({
							enabled: () => currentGuid === MUSIC_CONTROL_GUID
						})
					];
				}
			}),
```

Add the CSS rule next to the other hidden-class rules (search for `tomboy-note-bundle-hidden`, ~line 3270):

```css
	.tomboy-editor :global(.tomboy-music-control-hidden) {
		display: none;
	}
```

- [ ] **Step 6: Verify the integration**

Run: `cd app && npm run check` → no new errors. Then `npm run dev`: open the control note (it appears once any device records), confirm the JSON line is invisible in the editor but present in 원본 보기 (right-click → 원본 XML 보기 / mobile action sheet).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/editor/musicControlNote/musicControlHidePlugin.ts app/src/lib/editor/TomboyEditor.svelte app/tests/unit/music/musicControlHidePlugin.test.ts
git commit -m "feat(music): 음악제어 데이터 블록 에디터 숨김 플러그인"
```

---

### Task 9: Settings — device name field

**Goal:** Let the user name this device, next to the Firebase realtime sync toggle.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (config tab, ~L1190; state ~L240; load ~L770; save handler ~L433)

**Acceptance Criteria:**
- [ ] A "기기 이름" text input appears in the config tab right after the 파이어베이스 실시간 동기화 section.
- [ ] It loads the current value on mount and saves (trimmed) on Enter / 저장, mirroring the `imageStorageToken` pattern.
- [ ] Placeholder explains the fallback (`기기-xxxx`).

**Verify:** `cd app && npm run check` → no new errors; manual: type a name, reload, value persists.

**Steps:**

- [ ] **Step 1: Import the helpers** (with the other appSettings imports)

```ts
	import { getDeviceName, setDeviceName } from '$lib/storage/appSettings.js';
```

- [ ] **Step 2: Add local state** (near `let imageStorageToken = $state('');`)

```ts
	let deviceName = $state('');
	let deviceNameSaved = $state(false);
```

- [ ] **Step 3: Load on mount** (near the other `void get*().then(...)` calls, ~L770)

```ts
	void getDeviceName().then((v) => (deviceName = v));
```

- [ ] **Step 4: Save handler** (near `saveImageStorageToken`)

```ts
	async function saveDeviceName(): Promise<void> {
		await setDeviceName(deviceName.trim());
		deviceName = deviceName.trim();
		deviceNameSaved = true;
		setTimeout(() => (deviceNameSaved = false), 1500);
	}
```

- [ ] **Step 5: Markup** — insert a new `<section>` immediately after the closing `</section>` of the 파이어베이스 실시간 동기화 block (after ~L1190)

```svelte
	<section class="section">
		<h2>기기 이름</h2>
		<p class="info-text">
			음악제어 노트가 기기별 재생 상태를 구분할 때 쓰는 이름입니다. 비워 두면
			자동 이름(<code>기기-xxxx</code>)이 쓰입니다.
		</p>
		<div class="path-row">
			<input
				class="path-input"
				type="text"
				bind:value={deviceName}
				placeholder="예: 노트북, 아이폰"
				onkeydown={(e) => e.key === 'Enter' && saveDeviceName()}
			/>
			<button class="btn-save" onclick={saveDeviceName}>
				{deviceNameSaved ? '저장됨' : '저장'}
			</button>
		</div>
	</section>
```

- [ ] **Step 6: Verify**

Run: `cd app && npm run check` → no new errors. Manual: set name, reload, persists.

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "feat(settings): 기기 이름 설정 필드"
```

---

### Task 10: Settings — guide card

**Goal:** Document the 음악제어:: note in 설정 → 가이드 → 노트 sub-tab (required by the whole-app invariant: user-facing features must be in the guide).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (notes sub-tab; insert before the section close at ~L2287)

**Acceptance Criteria:**
- [ ] A `<details class="guide-card">` for 음악제어 appears under the notes guide sub-tab, matching the existing card structure (summary / info-text / guide-list).
- [ ] It states: one note only, ▶ when stopped resumes the global latest, records only on play/pause/stop, requires 실시간 동기화 ON, device name in 동기화 설정, JSON hidden (원본 보기).

**Verify:** `cd app && npm run check` → no errors; manual: card renders under 가이드 → 노트.

**Steps:**

- [ ] **Step 1: Insert the card** (between the last notes-sub-tab `</details>` ~L2286 and its `</section>` ~L2287)

```svelte
				<details class="guide-card">
					<summary>음악제어:: 노트 — 기기간 재생 이어듣기</summary>
					<p class="info-text">
						제목이 <code>음악제어::</code> 로 시작하는 전용 노트 하나가 모든 기기의
						재생 상태를 공유합니다. 한 기기에서 음악을 멈추고 다른 기기에서 ▶ 를
						누르면 가장 최근에 재생하던 곡을 그 위치에서 이어 재생합니다.
					</p>
					<ul class="guide-list">
						<li>노트는 <strong>하나만</strong> 존재하며 첫 재생 시 자동으로 생깁니다.</li>
						<li>재생·일시정지·정지 같은 <strong>명시적 조작</strong>일 때만 기록됩니다(동기화 비용 절약).</li>
						<li>기기간 공유는 <strong>설정 → 동기화 설정 → 실시간 동기화</strong>가 켜져 있어야 동작합니다.</li>
						<li>기기 이름은 <strong>설정 → 동기화 설정 → 기기 이름</strong>에서 지정합니다.</li>
						<li>재생 상태 데이터는 노트에서 보이지 않게 숨겨져 있습니다 — 원본은 메뉴의 <strong>원본 보기</strong>로만 확인하세요.</li>
					</ul>
				</details>
```

- [ ] **Step 2: Verify**

Run: `cd app && npm run check` → no errors. Manual: 설정 → 가이드 → 노트, card present.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 음악제어 노트 가이드 카드"
```

---

### Task 11: Full suite + type check

**Goal:** Ensure the feature integrates cleanly with the existing test suite and types.

**Files:** none (verification only)

**Acceptance Criteria:**
- [ ] `npm run check` passes with no new errors.
- [ ] `npm run test` (full vitest) passes — no regressions in existing music/sync/editor tests.

**Verify:** `cd app && npm run check && npm run test`

**Steps:**

- [ ] **Step 1: Type check** — `cd app && npm run check` → 0 new errors.
- [ ] **Step 2: Full tests** — `cd app && npm run test` → green.
- [ ] **Step 3: Manual cross-device smoke** (documented, not automated — no real-Dropbox test harness): with 실시간 동기화 ON on two devices sharing one Dropbox account, play a track on device A, stop it; on device B press ▶ → device B resumes A's track near its stop position. Confirm the 음악제어::공유 note's JSON is hidden in the editor and visible in 원본 보기.
- [ ] **Step 4: Commit (if any incidental fixes)**

```bash
git add -A && git commit -m "test(music): 음악제어 노트 전체 검증"
```

---

## Self-Review

**Spec coverage:**
- Fixed-GUID singleton control note → Task 1 (`MUSIC_CONTROL_GUID`) + Task 5 (`ensureControlNote`). ✓
- Per-device records, upsert by deviceId → Task 1 + Task 5. ✓
- Record only on explicit play/pause/stop → Task 2 (emit) + Task 3 (gesture play) + Task 5 (`recordTransport`). ✓
- 전역 최신 우선 resume, gesture-sync → Task 6 (`refreshFromNote` restore-ready) + existing `resumeOrRestart`. ✓
- Requires Firestore toggle → Task 5 (`isSharingEnabled` gate) + Task 10 (guide doc). ✓
- Device name setting → Task 4 + Task 9. ✓
- JSON hidden, visible only in 원본 보기 → Task 8 (hide plugin; NoteXmlViewer shows raw XML). ✓
- Guide card (whole-app invariant) → Task 10. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete for new modules; existing-file edits give exact snippets + insertion anchors. ✓

**Type consistency:** `recordTransport(kind: TransportKind)` (Task 5) maps via `STATE_BY_KIND` to `TransportState` (Task 1). `onTransport`/`notifyExplicitPlay` (Task 2) consumed by Task 3 + Task 6. `MUSIC_CONTROL_GUID`/`MUSIC_CONTROL_MARKER` shared across Tasks 1/5/6/8. `restoreSession` signature matches `musicPlayer` (existing). ✓

**Verify-before-relying assumptions** (flagged for the implementer):
- `noteStore` exports `deleteNote` (used only in test teardown) — confirm name; adjust test if different.
- `note.ts` exports `escapeXml` + `NOTE_CONTENT_VERSION` (confirmed: imported by `noteManager.ts` / declared at top of `note.ts`).
- `+layout.svelte` line numbers (26-27/253-254/304-305) are approximate — anchor on the `installMusicAudio`/`installMusicSession` calls.
- settings `+page.svelte` line numbers are approximate — anchor on the 파이어베이스 실시간 동기화 `<section>` and the notes-sub-tab last `</details>`.

## Known limitations (carry into the guide / future work)
- Whole-doc last-write-wins on the single control Firestore doc → near-simultaneous writes from two devices can clobber a section (rare for manual transport; mitigated by flush-then-read-latest-then-splice).
- Position is only as fresh as the last explicit event; live handoff while both devices play is out of scope (start/stop-only recording was the user's cost choice).
- v1 resume is a single synthetic track (no full origin-playlist next/prev); origin-note re-parse is deferred.
- Editing the control note while a remote record arrives could drop a debounce-pending edit on reload (rare; `emitNoteFlush` mitigates).
