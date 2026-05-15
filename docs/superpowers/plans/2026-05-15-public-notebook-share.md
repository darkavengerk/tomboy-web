# Public Notebook Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guest path so Dropbox-less visitors can name themselves on a `/welcome` page and then read+write notes inside notebooks the host marked public, all gated by a `public:boolean` flag and anonymous Firebase Auth.

**Architecture:** Single-host-per-domain model. Guest reads via `collectionGroup('notes').where('public','==',true)` and writes back into the host's namespace (`/users/{hostUid}/notes/{guid}`). Host uid is discovered through `collectionGroup('publicConfig')`. Mode (`host` / `guest` / `visitor`) is a Svelte 5 rune set at boot from Dropbox-token state + a localStorage display name. Guest IDB is a **separate database** (`tomboy-web-guest`) so it never mixes with the host's `tomboy-web`.

**Tech Stack:** SvelteKit + Svelte 5 runes, Firestore + Firebase Auth (anonymous + custom token), TypeScript, vitest.

**Deviation from spec — IDB:** The committed spec said guests use no IDB at all. Implementing that requires forking every consumer of `noteStore.ts` (10+ call sites: list page, search, auto-link title index, favorites, etc). Task 1 updates the spec to use a separate-DB approach which addresses the spec's actual concern (no data mixing in a shared browser) without the rewrite. If you disagree with this, stop and re-discuss before Task 1.

---

## Task 1: Update spec — IDB approach + write-uid bootstrap

**Goal:** Replace the "memory-only" IDB section with "separate IDB database" + record the publicConfig discovery method.

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-public-notebook-share-design.md` (sections `## IDB & Data Storage`, `## Data Model (Firestore)`, `## Firestore Rules`)

**Acceptance Criteria:**
- [ ] Spec's "IDB & Data Storage" section says guests use a separate IDB database `tomboy-web-guest`, with a per-mode `dbName` parameter on `db.ts`.
- [ ] Spec explains how guests bootstrap the host uid for writes: `collectionGroup('publicConfig').limit(1)` returns the host's publicConfig doc, and `doc.ref.parent.parent.id` yields the hostUid.
- [ ] Spec's "Firestore Rules" section adds the rule that lets `collectionGroup('publicConfig')` succeed (matching `publicConfig` rule is shape-compatible).
- [ ] Diff committed with a message that explains the deviation.

**Verify:** `git log --oneline -1 docs/superpowers/specs/2026-05-15-public-notebook-share-design.md` shows the new commit message.

**Steps:**

- [ ] **Step 1: Edit the spec — IDB section**

Replace the `## IDB & Data Storage` body with:

```markdown
Guests use a **separate IndexedDB database** named `tomboy-web-guest`,
opened by parameterizing the DB name in `lib/storage/db.ts`. The host's
`tomboy-web` DB is never touched in guest mode. Same-browser cohabitation
(household tablet etc.) is safe because the two DBs are fully isolated;
guest data persisting on disk is acceptable since it is data the host
has explicitly marked public.

The guest's `tomboy-web-guest` is a filtered mirror of the host's
namespace: it only ever contains notes the incremental-sync listener
received (i.e. notes with `public == true`).

Host IDB and the host's Firestore-based realtime sync stay exactly as
today.
```

- [ ] **Step 2: Edit the spec — bootstrap section**

Inside `## Data Model (Firestore)`, append:

```markdown
**Discovering the host uid (guest side):** A guest's first Firestore call
is `collectionGroup('publicConfig').limit(1).get()`. The returned doc's
`ref.parent.parent.id` is the host's uid — the guest caches it in memory
for the rest of the session and uses it to build write paths
(`/users/{hostUid}/notes/{guid}`).
```

- [ ] **Step 3: Edit the spec — rules section adjustment**

Inside `## Firestore Rules`, replace the `publicConfig` block with:

```
match /users/{hostUid}/publicConfig/{doc} {
  allow read:  if true;                       // anonymous read OK
  allow write: if request.auth.uid == hostUid;
}
```

(already shape-compatible with collectionGroup — keep wording intact, just confirm under the rules block "Notes:" bullet that `collectionGroup('publicConfig')` works because the `match` is on a sub-path under `users/*/`).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-15-public-notebook-share-design.md
git commit -m "docs(spec): public-notebook-share — separate guest IDB; host-uid bootstrap via collectionGroup"
```

---

## Task 2: Firestore rules + composite index

**Goal:** Land the security rules and the `(public, serverUpdatedAt)` collectionGroup index so the rest of the plan can deploy/test against them.

**Files:**
- Modify: `firestore.rules`
- Modify: `firestore.indexes.json`

**Acceptance Criteria:**
- [ ] `firestore.rules` enforces the 4 allow rules per spec (read/create/update/delete) and the publicConfig rule.
- [ ] `firestore.indexes.json` has a `collectionGroup: notes` composite index on `(public ASC, serverUpdatedAt DESC)`.
- [ ] `firebase deploy --only firestore:rules,firestore:indexes` succeeds (dry-run OK if no shell access — verify config syntax via `firebase deploy --dry-run` or manual JSON parse).

**Verify:**
```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/tigress
node -e "JSON.parse(require('fs').readFileSync('firestore.indexes.json'))" && echo OK
```
Expected: `OK` and no parse error.

**Steps:**

- [ ] **Step 1: Replace `firestore.rules` body**

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    match /users/{hostUid}/notes/{noteId} {
      allow read:   if request.auth.uid == hostUid
                    || (request.auth != null && resource.data.public == true);
      allow create: if request.auth.uid == hostUid
                    || (request.auth != null && request.resource.data.public == true);
      allow update: if request.auth.uid == hostUid
                    || (request.auth != null
                        && resource.data.public == true
                        && request.resource.data.public == true);
      allow delete: if request.auth.uid == hostUid
                    || (request.auth != null && resource.data.public == true);
    }

    match /users/{hostUid}/publicConfig/{doc} {
      allow read:  if true;
      allow write: if request.auth.uid == hostUid;
    }

    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

The narrower `notes` and `publicConfig` matches must come first; Firestore picks the **most specific** match, but listing specific-first is convention.

- [ ] **Step 2: Add composite index**

Edit `firestore.indexes.json` and add inside the `"indexes"` array (preserve existing entries):

```json
{
  "collectionGroup": "notes",
  "queryScope": "COLLECTION_GROUP",
  "fields": [
    { "fieldPath": "public", "order": "ASCENDING" },
    { "fieldPath": "serverUpdatedAt", "order": "DESCENDING" }
  ]
}
```

- [ ] **Step 3: Verify JSON parses + Run rules JSON syntax check via firebase-tools**

```bash
node -e "JSON.parse(require('fs').readFileSync('firestore.indexes.json'))" && echo OK
```

If the worktree has `firebase` CLI available:
```bash
firebase deploy --only firestore:rules --dry-run
```

- [ ] **Step 4: Commit**

```bash
git add firestore.rules firestore.indexes.json
git commit -m "feat(firestore): public-notes rules + (public, serverUpdatedAt) collectionGroup index"
```

Deployment to production happens at end of plan; for now the worktree change is enough.

---

## Task 3: Guest mode rune store + ensureGuestSignedIn

**Goal:** Add a single source of truth for "what mode is the app in?" and an anonymous-auth helper for guests.

**Files:**
- Create: `app/src/lib/stores/guestMode.svelte.ts`
- Modify: `app/src/lib/firebase/app.ts` (add `ensureGuestSignedIn`)
- Create: `app/tests/unit/stores/guestMode.test.ts`

**Acceptance Criteria:**
- [ ] `guestMode.svelte.ts` exports a rune-backed object `mode` with `.value: 'visitor' | 'guest' | 'host'`, plus a synchronous setter `mode.set(v)` and an async `mode.detectAndSet()` that derives from `getFreshAccessToken()` + `localStorage('tomboy.guestName')`.
- [ ] `ensureGuestSignedIn()` returns a `User` from `signInAnonymously(getFirebaseAuth())`. Idempotent (returns `auth.currentUser` if already anonymous).
- [ ] Unit test covers all 3 derivations: dropbox-token + name → host; no-token + name → guest; no-token + no-name → visitor.

**Verify:** `cd app && npm run test -- guestMode`
Expected: 3 passing tests.

**Steps:**

- [ ] **Step 1: Write the test first**

Create `app/tests/unit/stores/guestMode.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dropbox client + localStorage before importing the module under test.
const getTokenMock = vi.fn();
vi.mock('$lib/sync/dropboxClient.js', () => ({
  getFreshAccessToken: () => getTokenMock()
}));

import { mode } from '$lib/stores/guestMode.svelte.js';

describe('guestMode.detectAndSet', () => {
  beforeEach(() => {
    getTokenMock.mockReset();
    localStorage.clear();
  });

  it('detects host when dropbox token exists', async () => {
    getTokenMock.mockResolvedValue('dbx-tok');
    localStorage.setItem('tomboy.guestName', '철수');
    await mode.detectAndSet();
    expect(mode.value).toBe('host');
  });

  it('detects guest when no token but name set', async () => {
    getTokenMock.mockResolvedValue(null);
    localStorage.setItem('tomboy.guestName', '철수');
    await mode.detectAndSet();
    expect(mode.value).toBe('guest');
  });

  it('detects visitor when neither', async () => {
    getTokenMock.mockResolvedValue(null);
    await mode.detectAndSet();
    expect(mode.value).toBe('visitor');
  });
});
```

- [ ] **Step 2: Run the test (red)**

```bash
cd app && npm run test -- guestMode
```
Expected: FAIL with "cannot find module" or similar.

- [ ] **Step 3: Implement the store**

Create `app/src/lib/stores/guestMode.svelte.ts`:

```ts
import { getFreshAccessToken } from '$lib/sync/dropboxClient.js';

export type AppMode = 'visitor' | 'guest' | 'host';

const GUEST_NAME_KEY = 'tomboy.guestName';

function getGuestName(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(GUEST_NAME_KEY);
}

function setGuestName(name: string): void {
  localStorage.setItem(GUEST_NAME_KEY, name);
}

function clearGuestName(): void {
  localStorage.removeItem(GUEST_NAME_KEY);
}

let _mode = $state<AppMode>('visitor');

export const mode = {
  get value(): AppMode {
    return _mode;
  },
  set(v: AppMode): void {
    _mode = v;
  },
  async detectAndSet(): Promise<AppMode> {
    const token = await getFreshAccessToken();
    if (token) {
      _mode = 'host';
    } else if (getGuestName()) {
      _mode = 'guest';
    } else {
      _mode = 'visitor';
    }
    return _mode;
  },
  getGuestName,
  setGuestName,
  clearGuestName
};
```

- [ ] **Step 4: Implement `ensureGuestSignedIn`**

Modify `app/src/lib/firebase/app.ts`. After `ensureSignedIn` add:

```ts
import { signInAnonymously } from 'firebase/auth';
// ... existing imports

export async function ensureGuestSignedIn(): Promise<User> {
  const auth = getFirebaseAuth();
  await auth.authStateReady();
  if (auth.currentUser?.isAnonymous) return auth.currentUser;
  // Force out any leftover host session — guest mode means no Dropbox.
  if (auth.currentUser) await signOut(auth);
  const cred = await signInAnonymously(auth);
  return cred.user;
}
```

- [ ] **Step 5: Run the tests (green)**

```bash
cd app && npm run test -- guestMode
```
Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/stores/guestMode.svelte.ts app/src/lib/firebase/app.ts app/tests/unit/stores/guestMode.test.ts
git commit -m "feat(guest): mode rune store + ensureGuestSignedIn anonymous helper"
```

---

## Task 4: publicConfig client module

**Goal:** Read/write `users/{hostUid}/publicConfig/main` from both the host-write path (settings tab) and the guest-discover path (collectionGroup query).

**Files:**
- Create: `app/src/lib/sync/firebase/publicConfig.ts`
- Create: `app/tests/unit/sync/firebase/publicConfig.test.ts`

**Acceptance Criteria:**
- [ ] Exports `discoverPublicConfigForGuest(): Promise<{ hostUid: string; sharedNotebooks: string[] } | null>` — uses `collectionGroup('publicConfig').limit(1)`.
- [ ] Exports `readPublicConfigForHost(hostUid: string): Promise<{ sharedNotebooks: string[] }>`.
- [ ] Exports `writePublicConfigAsHost(hostUid: string, cfg: { sharedNotebooks: string[] }): Promise<void>` — uses `setDoc` with `{ merge: true }`.
- [ ] In-memory module-level cache `let cached: { hostUid; sharedNotebooks }` populated by either discover/read. Plus a `getCached()` accessor.
- [ ] Tests with mocked FirestorePrimitives cover all 3 functions.

**Verify:** `cd app && npm run test -- publicConfig`
Expected: 4+ passing tests.

**Steps:**

- [ ] **Step 1: Test file**

Create `app/tests/unit/sync/firebase/publicConfig.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We will mock the Firestore SDK calls used inside publicConfig.ts.
const collectionGroupMock = vi.fn();
const limitMock = vi.fn(() => ({}));
const getDocsMock = vi.fn();
const docMock = vi.fn(() => ({ id: 'main' }));
const setDocMock = vi.fn();
const getDocMock = vi.fn();

vi.mock('firebase/firestore', () => ({
  collectionGroup: (...a: unknown[]) => collectionGroupMock(...a),
  query: (...a: unknown[]) => a,
  limit: (...a: unknown[]) => limitMock(...a),
  getDocs: () => getDocsMock(),
  doc: (...a: unknown[]) => docMock(...a),
  setDoc: (...a: unknown[]) => setDocMock(...a),
  getDoc: () => getDocMock()
}));

vi.mock('$lib/firebase/app.js', () => ({
  getFirebaseFirestore: () => ({})
}));

import {
  discoverPublicConfigForGuest,
  writePublicConfigAsHost,
  readPublicConfigForHost,
  _resetCache
} from '$lib/sync/firebase/publicConfig.js';

beforeEach(() => {
  collectionGroupMock.mockReset();
  getDocsMock.mockReset();
  setDocMock.mockReset();
  getDocMock.mockReset();
  _resetCache();
});

describe('discoverPublicConfigForGuest', () => {
  it('returns host uid + sharedNotebooks from collectionGroup', async () => {
    getDocsMock.mockResolvedValue({
      empty: false,
      docs: [
        {
          ref: { parent: { parent: { id: 'dbx-XYZ' } } },
          data: () => ({ sharedNotebooks: ['공유A'] })
        }
      ]
    });
    const out = await discoverPublicConfigForGuest();
    expect(out).toEqual({ hostUid: 'dbx-XYZ', sharedNotebooks: ['공유A'] });
  });

  it('returns null when no publicConfig exists', async () => {
    getDocsMock.mockResolvedValue({ empty: true, docs: [] });
    const out = await discoverPublicConfigForGuest();
    expect(out).toBeNull();
  });
});

describe('writePublicConfigAsHost', () => {
  it('writes with merge:true', async () => {
    await writePublicConfigAsHost('dbx-XYZ', { sharedNotebooks: ['x'] });
    expect(setDocMock).toHaveBeenCalledWith(
      expect.anything(),
      { sharedNotebooks: ['x'] },
      { merge: true }
    );
  });
});

describe('readPublicConfigForHost', () => {
  it('returns sharedNotebooks from doc data', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ sharedNotebooks: ['공유A'] })
    });
    const out = await readPublicConfigForHost('dbx-XYZ');
    expect(out).toEqual({ sharedNotebooks: ['공유A'] });
  });

  it('returns empty list when doc missing', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const out = await readPublicConfigForHost('dbx-XYZ');
    expect(out).toEqual({ sharedNotebooks: [] });
  });
});
```

- [ ] **Step 2: Run tests (red)**

```bash
cd app && npm run test -- publicConfig
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module**

Create `app/src/lib/sync/firebase/publicConfig.ts`:

```ts
import {
  collectionGroup,
  query,
  limit,
  getDocs,
  doc,
  setDoc,
  getDoc
} from 'firebase/firestore';
import { getFirebaseFirestore } from '$lib/firebase/app.js';

export interface PublicConfig {
  hostUid: string;
  sharedNotebooks: string[];
}

let cached: PublicConfig | null = null;

export function getCachedPublicConfig(): PublicConfig | null {
  return cached;
}

export async function discoverPublicConfigForGuest(): Promise<PublicConfig | null> {
  const db = getFirebaseFirestore();
  const q = query(collectionGroup(db, 'publicConfig'), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  const hostUid = d.ref.parent.parent!.id;
  const data = d.data() as { sharedNotebooks?: string[] };
  cached = { hostUid, sharedNotebooks: data.sharedNotebooks ?? [] };
  return cached;
}

export async function readPublicConfigForHost(
  hostUid: string
): Promise<{ sharedNotebooks: string[] }> {
  const db = getFirebaseFirestore();
  const ref = doc(db, 'users', hostUid, 'publicConfig', 'main');
  const snap = await getDoc(ref);
  const data = snap.exists() ? (snap.data() as { sharedNotebooks?: string[] }) : {};
  const out = { sharedNotebooks: data.sharedNotebooks ?? [] };
  cached = { hostUid, sharedNotebooks: out.sharedNotebooks };
  return out;
}

export async function writePublicConfigAsHost(
  hostUid: string,
  cfg: { sharedNotebooks: string[] }
): Promise<void> {
  const db = getFirebaseFirestore();
  const ref = doc(db, 'users', hostUid, 'publicConfig', 'main');
  await setDoc(ref, { sharedNotebooks: cfg.sharedNotebooks }, { merge: true });
  cached = { hostUid, sharedNotebooks: cfg.sharedNotebooks };
}

/** Test-only */
export function _resetCache(): void {
  cached = null;
}
```

- [ ] **Step 4: Run tests (green)**

```bash
cd app && npm run test -- publicConfig
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/sync/firebase/publicConfig.ts app/tests/unit/sync/firebase/publicConfig.test.ts
git commit -m "feat(firebase): publicConfig — host write + guest collectionGroup discovery"
```

---

## Task 5: Note payload `public` field + host-side auto-public on push

**Goal:** Every Firestore push computes `public` from `(notebook tag, sharedNotebooks)`. New notes in shared notebooks land public; moves in/out flip the flag on the next save.

**Files:**
- Modify: `app/src/lib/sync/firebase/notePayload.ts`
- Modify: `app/src/lib/sync/firebase/noteSyncClient.firestore.ts` (whichever function builds the write — add the field at write time)
- Modify: `app/tests/unit/sync/firebase/notePayload.test.ts` (if exists; else create)

**Acceptance Criteria:**
- [ ] `noteToFirestorePayload(note, sharedNotebooks)` accepts a second arg and stamps `public: boolean` on the output.
- [ ] `public` is `true` iff `getNotebook(note) !== null && sharedNotebooks.includes(getNotebook(note))`.
- [ ] Unit test covers: in shared notebook → public; outside shared notebook → not public; no notebook → not public.
- [ ] All existing call sites of `noteToFirestorePayload` updated to pass `sharedNotebooks` (from `getCachedPublicConfig()?.sharedNotebooks ?? []`).

**Verify:** `cd app && npm run test -- notePayload && npm run check`
Expected: tests pass; svelte-check no new errors.

**Steps:**

- [ ] **Step 1: Edit the payload builder**

In `app/src/lib/sync/firebase/notePayload.ts`, change the signature:

```ts
import { getNotebook } from '$lib/core/notebooks.js';

// ...existing imports + FirestoreNotePayload type

export interface FirestoreNotePayload {
  guid: string;
  uri: string;
  title: string;
  xmlContent: string;
  createDate: string;
  changeDate: string;
  metadataChangeDate: string;
  tags: string[];
  deleted: boolean;
  public: boolean;   // NEW
}

export function noteToFirestorePayload(
  note: NoteData,
  sharedNotebooks: string[]
): FirestoreNotePayload {
  const nb = getNotebook(note);
  return {
    guid: note.guid,
    uri: note.uri,
    title: note.title,
    xmlContent: note.xmlContent,
    createDate: note.createDate,
    changeDate: note.changeDate,
    metadataChangeDate: note.metadataChangeDate,
    tags: [...note.tags],
    deleted: note.deleted ?? false,
    public: nb !== null && sharedNotebooks.includes(nb)
  };
}
```

- [ ] **Step 2: Update call sites**

Search and update:

```bash
grep -rn "noteToFirestorePayload" app/src
```

For each call, pass `getCachedPublicConfig()?.sharedNotebooks ?? []`. Typical site is inside `pushQueue` flush; the call becomes:

```ts
import { getCachedPublicConfig } from '$lib/sync/firebase/publicConfig.js';
// ...
const payload = noteToFirestorePayload(note, getCachedPublicConfig()?.sharedNotebooks ?? []);
```

- [ ] **Step 3: Add/extend payload unit test**

Add to `app/tests/unit/sync/firebase/notePayload.test.ts` (create if missing):

```ts
import { describe, it, expect } from 'vitest';
import { noteToFirestorePayload } from '$lib/sync/firebase/notePayload.js';
import { createEmptyNote } from '$lib/core/note.js';

function noteIn(nb: string | null) {
  const n = createEmptyNote('g1');
  if (nb) n.tags.push(`system:notebook:${nb}`);
  return n;
}

describe('noteToFirestorePayload public flag', () => {
  it('marks public when notebook is in shared list', () => {
    const p = noteToFirestorePayload(noteIn('공유A'), ['공유A', '공유B']);
    expect(p.public).toBe(true);
  });

  it('marks not-public when notebook is outside shared list', () => {
    const p = noteToFirestorePayload(noteIn('비공유'), ['공유A']);
    expect(p.public).toBe(false);
  });

  it('marks not-public when note has no notebook', () => {
    const p = noteToFirestorePayload(noteIn(null), ['공유A']);
    expect(p.public).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests + type check**

```bash
cd app && npm run test -- notePayload && npm run check
```
Expected: tests pass; no new TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/sync/firebase/notePayload.ts app/src/lib/sync/firebase/noteSyncClient.firestore.ts app/tests/unit/sync/firebase/notePayload.test.ts
git commit -m "feat(firebase): notes auto-stamp public flag from sharedNotebooks on push"
```

---

## Task 6: Guest IDB + guest-mode sync wiring

**Goal:** When `mode === 'guest'`, the app reads/writes `tomboy-web-guest` IndexedDB and routes Firestore listeners through the collectionGroup public query, with writes pushing into `users/{hostUid}/notes/{guid}`.

**Files:**
- Modify: `app/src/lib/storage/db.ts` (parameterize DB name)
- Modify: `app/src/lib/sync/firebase/install.ts` (mode-aware adapter wiring)
- Modify: `app/src/lib/sync/firebase/noteSyncClient.firestore.ts` (add `subscribeAllPublicNotes` adapter)
- Create: `app/tests/unit/storage/dbName.test.ts`

**Acceptance Criteria:**
- [ ] `db.ts` exports a `setDbMode('host'|'guest')` and `getDbName()` returning `'tomboy-web'` or `'tomboy-web-guest'` accordingly. Default = `host` so existing host code is unaffected.
- [ ] `installRealNoteSync()` reads `mode.value`. For guests: configures the orchestrator with a `subscribeAllPublicNotes` adapter (collectionGroup query) and a push path that writes to `users/{hostUid}/notes/{guid}`, where `hostUid` is read from `getCachedPublicConfig()`. The watermark key becomes `firebaseGuestLastSyncAt` (separate from host).
- [ ] Guest mode forces feature enabled (no need to toggle in settings; setting key not used for guests).
- [ ] Unit test confirms `getDbName()` returns the expected name per mode.

**Verify:** `cd app && npm run test -- dbName && npm run check`
Expected: tests pass; no new TS errors.

**Steps:**

- [ ] **Step 1: Parameterize db.ts**

In `app/src/lib/storage/db.ts`, change the hard-coded DB name to a function. Read the current file first to know exact API. The change pattern:

```ts
let dbMode: 'host' | 'guest' = 'host';

export function setDbMode(m: 'host' | 'guest'): void {
  dbMode = m;
}

export function getDbName(): string {
  return dbMode === 'guest' ? 'tomboy-web-guest' : 'tomboy-web';
}

// Replace 'tomboy-web' literal in openDB(...) call with getDbName().
// Important: cache the handle separately per mode so we don't accidentally
// reuse a host-mode connection in guest-mode.
let cachedDb: { mode: typeof dbMode; handle: IDBPDatabase | null } = { mode: 'host', handle: null };
async function getDb(): Promise<IDBPDatabase> {
  if (cachedDb.mode !== dbMode || !cachedDb.handle) {
    if (cachedDb.handle) cachedDb.handle.close();
    cachedDb = { mode: dbMode, handle: await openDB(getDbName(), CURRENT_VERSION, { /* upgrade fn unchanged */ }) };
  }
  return cachedDb.handle;
}
```

(Adapt to the file's actual structure — particularly the `upgrade` callback should stay verbatim.)

- [ ] **Step 2: Test**

Create `app/tests/unit/storage/dbName.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { setDbMode, getDbName } from '$lib/storage/db.js';

describe('getDbName', () => {
  it('defaults to tomboy-web', () => {
    setDbMode('host');
    expect(getDbName()).toBe('tomboy-web');
  });
  it('switches to tomboy-web-guest in guest mode', () => {
    setDbMode('guest');
    expect(getDbName()).toBe('tomboy-web-guest');
  });
});
```

- [ ] **Step 3: Add collectionGroup adapter**

In `app/src/lib/sync/firebase/noteSyncClient.firestore.ts`, add an exported function:

```ts
import { collectionGroup, query, where, Timestamp, onSnapshot as fsOnSnapshot } from 'firebase/firestore';

export function subscribeAllPublicNotesAfter(
  sinceMillis: number,
  onNext: (changes: CollectionDocChange[]) => void,
  onError: (e: unknown) => void
): Unsubscribe {
  const db = getFirebaseFirestore();
  const q = query(
    collectionGroup(db, 'notes'),
    where('public', '==', true),
    where('serverUpdatedAt', '>', Timestamp.fromMillis(sinceMillis))
  );
  return fsOnSnapshot(
    q,
    (snap) => {
      const changes: CollectionDocChange[] = snap.docChanges().map((c) => ({
        data: c.doc.data(),
        serverUpdatedAtMillis: (c.doc.data().serverUpdatedAt as Timestamp)?.toMillis() ?? 0
      }));
      onNext(changes);
    },
    onError
  );
}
```

- [ ] **Step 4: Mode-aware install**

In `app/src/lib/sync/firebase/install.ts`, branch on `mode.value`:

```ts
import { mode } from '$lib/stores/guestMode.svelte.js';
import { getCachedPublicConfig, discoverPublicConfigForGuest } from './publicConfig.js';
import { setDbMode } from '$lib/storage/db.js';
import { ensureGuestSignedIn } from '$lib/firebase/app.js';
import { subscribeAllPublicNotesAfter } from './noteSyncClient.firestore.js';

export async function installRealNoteSync(): Promise<void> {
  if (mode.value === 'guest') {
    setDbMode('guest');
    await ensureGuestSignedIn();
    const cfg = getCachedPublicConfig() ?? await discoverPublicConfigForGuest();
    if (!cfg) return; // no public config — nothing to sync; UI will show empty.
    configureOrchestratorForGuest(cfg.hostUid);
    setEnabled(true);
    return;
  }
  // ...existing host-mode body (unchanged)
}

function configureOrchestratorForGuest(hostUid: string): void {
  configureNoteSync({
    push: async (payload) => {
      // Forced public:true for guest writes (Firestore rule will reject otherwise).
      const guestPayload = { ...payload, public: true };
      await setDocAtUid(hostUid, guestPayload.guid, guestPayload);
    },
    getNote: async (guid) => getDocAtUid(hostUid, guid),
    getUid: async () => hostUid,
    subscribeNoteCollection: subscribeAllPublicNotesAfter,
    // ...watermark getter/setter using 'firebaseGuestLastSyncAt' key
  });
}
```

The exact adapter shape depends on `configureNoteSync` — read the current orchestrator and match it. Add helpers `setDocAtUid` / `getDocAtUid` to `noteSyncClient.firestore.ts` if not already present.

- [ ] **Step 5: Force-enable for guests**

Guest mode shouldn't be gated by the existing `firebaseNotesEnabled` setting. In `installRealNoteSync` guest branch, skip the setting check entirely and call `setEnabled(true)` unconditionally.

- [ ] **Step 6: Run tests + check**

```bash
cd app && npm run test -- dbName && npm run check
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/storage/db.ts app/src/lib/sync/firebase/install.ts app/src/lib/sync/firebase/noteSyncClient.firestore.ts app/tests/unit/storage/dbName.test.ts
git commit -m "feat(sync): mode-aware DB + guest writes target host namespace via collectionGroup"
```

---

## Task 7: `/welcome` landing route

**Goal:** When `mode === 'visitor'` the user lands here. Two CTAs: guest name submit, Dropbox login.

**Files:**
- Create: `app/src/routes/welcome/+page.svelte`
- Modify: `app/src/routes/+layout.svelte` (visitor → /welcome redirect inside `afterNavigate`)

**Acceptance Criteria:**
- [ ] `/welcome` renders an input + 게스트로 시작 button, plus a Dropbox로 로그인 button.
- [ ] Submitting the form: `mode.setGuestName(value.trim())`, `await mode.detectAndSet()`, navigate to `/`.
- [ ] Empty input shows inline error and doesn't submit.
- [ ] Dropbox button calls the existing Dropbox PKCE start flow (search `dropboxClient` for `startAuth` or similar).
- [ ] Visitors arriving at any non-`/welcome` route are silently redirected to `/welcome`.

**Verify:** Manual — `npm run dev`, clear localStorage, ensure Dropbox not connected, navigate to `/notes`, confirm redirect to `/welcome`. Submit a name, confirm redirect to `/`.

**Steps:**

- [ ] **Step 1: Implement the page**

Create `app/src/routes/welcome/+page.svelte`:

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { mode } from '$lib/stores/guestMode.svelte.js';
  import { startDropboxAuth } from '$lib/sync/dropboxClient.js';  // confirm export name

  let name = $state('');
  let error = $state('');

  async function submitGuest(e: SubmitEvent) {
    e.preventDefault();
    const v = name.trim();
    if (!v) {
      error = '이름을 입력해주세요.';
      return;
    }
    mode.setGuestName(v);
    await mode.detectAndSet();
    void goto('/');
  }
</script>

<svelte:head><title>환영합니다 — Tomboy</title></svelte:head>

<main class="welcome">
  <h1>Tomboy</h1>
  <p>공유된 노트북을 보려면 이름을 입력하세요.</p>

  <form onsubmit={submitGuest}>
    <input
      type="text"
      bind:value={name}
      placeholder="이름"
      maxlength="40"
      autofocus
    />
    <button type="submit">게스트로 시작</button>
    {#if error}<p class="error">{error}</p>{/if}
  </form>

  <hr />

  <button class="dbx" onclick={() => startDropboxAuth()}>Dropbox로 로그인</button>
</main>

<style>
  .welcome { max-width: 360px; margin: 40px auto; padding: 0 16px; text-align: center; }
  form { display: flex; flex-direction: column; gap: 12px; margin-top: 24px; }
  input, button { padding: 12px; font-size: 1rem; border-radius: 8px; }
  input { border: 1px solid var(--color-border, #ccc); }
  button { background: var(--color-primary, #f57900); color: white; border: none; cursor: pointer; }
  .dbx { background: #0061ff; margin-top: 8px; }
  .error { color: #c00; font-size: 0.85rem; }
  hr { margin: 24px 0; border: none; border-top: 1px solid var(--color-border, #eee); }
</style>
```

(Confirm `startDropboxAuth` is the actual export — if not, swap for the right symbol.)

- [ ] **Step 2: Visitor redirect**

In `app/src/routes/+layout.svelte`, change `afterNavigate` to also redirect visitors:

```ts
import { mode } from '$lib/stores/guestMode.svelte.js';
import { goto } from '$app/navigation';

onMount(async () => {
  await mode.detectAndSet();
  // existing onMount body
});

afterNavigate(({ type }) => {
  tracker.onNavigate(type);
  const derived = modeFromUrl(page.url.pathname, page.url.searchParams);
  if (derived) appMode.set(derived);

  if (mode.value === 'visitor' && !page.url.pathname.startsWith('/welcome')) {
    void goto('/welcome', { replaceState: true });
  }
});
```

- [ ] **Step 3: Manual smoke**

```bash
cd app && npm run dev
```
- Open http://localhost:5173/notes in private window.
- Verify redirect to /welcome.
- Type a name → redirect to /.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/welcome/+page.svelte app/src/routes/+layout.svelte
git commit -m "feat(welcome): visitor landing page with guest name + Dropbox login"
```

---

## Task 8: TopNav guest mode (mode-aware items + gear omit + theme-guest)

**Goal:** In guest mode the top nav shows one item per shared notebook + `전체`, the gear icon is gone, and a distinct theme color signals guest mode.

**Files:**
- Modify: `app/src/lib/components/TopNav.svelte`

**Acceptance Criteria:**
- [ ] Guest mode: nav items = `[ ...sharedNotebooks.map(name => ({ href: `/notes?nb=${name}`, label: name, mode: 'notes' })), { href: '/notes', label: '전체', mode: 'notes' } ]`. The gear button is not in the DOM (`{#if !isGuest}...{/if}`).
- [ ] Host mode: unchanged.
- [ ] New CSS class `.theme-guest` with a desaturated color (e.g. `#3f6b66`). Applied when `mode.value === 'guest'`.

**Verify:** Manual — switch to guest mode (clear Dropbox connection, set guest name), navigate `/notes`, confirm new nav and no gear button.

**Steps:**

- [ ] **Step 1: Imports + derive items**

In `TopNav.svelte` `<script>`, add:

```ts
import { mode } from '$lib/stores/guestMode.svelte.js';
import { getCachedPublicConfig } from '$lib/sync/firebase/publicConfig.js';

const isGuest = $derived(mode.value === 'guest');

const navItems = $derived.by(() => {
  if (mode.value === 'guest') {
    const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
    return [
      ...shared.map((n) => ({ href: `/notes?nb=${encodeURIComponent(n)}`, label: n, mode: 'notes' as AppMode })),
      { href: '/notes', label: '전체', mode: 'notes' as AppMode }
    ];
  }
  return [
    { href: '/', label: '홈', mode: 'home' as AppMode },
    { href: '/sleepnote', label: '슬립노트', mode: 'sleepnote' as AppMode },
    { href: '/notes', label: '전체', mode: 'notes' as AppMode }
  ];
});
```

Replace the `const items: ...` array usage with `{navItems}` in the `{#each}`.

- [ ] **Step 2: Conditional gear**

Wrap the settings button:

```svelte
{#if !isGuest}
  <button class="nav-btn" aria-label="설정" onclick={handleSettings}>
    <!-- existing SVG -->
  </button>
{/if}
```

- [ ] **Step 3: Theme**

Modify the `$derived(themeClass)`:

```ts
const themeClass = $derived(
  mode.value === 'guest' ? 'theme-guest' :
  page.url.pathname === '/settings' ? 'theme-settings' :
  `theme-${appMode.value}`
);
```

Append CSS:

```css
.theme-guest { background: #3f6b66; }
```

- [ ] **Step 4: Manual smoke**

```bash
cd app && npm run dev
```

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/components/TopNav.svelte
git commit -m "feat(topnav): guest-mode item list + omit gear + theme-guest color"
```

---

## Task 9: New-note guest behavior

**Goal:** Guest hitting `+` creates a note already tagged with the first shared notebook.

**Files:**
- Modify: `app/src/lib/components/TopNav.svelte` (`handleNewNote`)

**Acceptance Criteria:**
- [ ] Guest path calls `createNote()` then `assignNotebook(n.guid, sharedNotebooks[0])` before navigating.
- [ ] If `sharedNotebooks.length === 0`, show a toast "공유 노트북이 없습니다" and don't create.
- [ ] Host path unchanged.

**Verify:** Manual — guest mode, hit `+`, confirm new note is in the first shared notebook.

**Steps:**

- [ ] **Step 1: Modify `handleNewNote`**

```ts
import { assignNotebook } from '$lib/core/notebooks.js';
import { pushToast } from '$lib/stores/toast.js';

async function handleNewNote() {
  if (mode.value === 'guest') {
    const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
    if (shared.length === 0) {
      pushToast('공유 노트북이 없습니다.', { kind: 'warning' });
      return;
    }
    const n = await createNote();
    await assignNotebook(n.guid, shared[0]);
    void goto(`/note/${n.guid}`);
    return;
  }
  const n = await createNote();
  void goto(`/note/${n.guid}`);
}
```

- [ ] **Step 2: Manual smoke + check**

```bash
cd app && npm run check
```

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/components/TopNav.svelte
git commit -m "feat(topnav): guest + button auto-assigns first shared notebook"
```

---

## Task 10: Guest guards — per-note + favorites filter + route blocks + home

**Goal:** Cover the remaining guest UX boundaries in one task — direct-URL guard for non-public notes, favorite sheet filter, blocked routes redirect, and guest home behavior.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte` (load-guard)
- Modify: `app/src/lib/components/TopNav.svelte` (favorites filter)
- Modify: `app/src/routes/+layout.svelte` (route guards + home)
- Modify: `app/src/lib/editor/extensions/TomboyInternalLink.ts` (optional toast)

**Acceptance Criteria:**
- [ ] Guest opening `/note/{guid}` of a non-public guid → silent `goto('/notes')`.
- [ ] Favorites sheet filters out notes with `getNotebook(n) !== null && !sharedNotebooks.includes(getNotebook(n))` in guest mode. (Belt-and-suspenders — guest IDB should not contain them anyway, but defensive against stale data.)
- [ ] Guest hitting `/settings`, `/admin/*`, `/desktop/*`, `/sleepnote` is silently redirected to `/notes`.
- [ ] Guest hitting `/` redirects to the most-recent note in `sharedNotebooks[0]`; if none, `/notes`.
- [ ] Internal link extension's `onLinkClick` shows toast "공개되지 않은 노트입니다." if the title doesn't resolve in the guest IDB.

**Verify:** Manual smoke for each path; `npm run check`.

**Steps:**

- [ ] **Step 1: Per-note guard**

In `app/src/routes/note/[id]/+page.svelte`, after the note is loaded (find the `getNote(guid)` call), add:

```ts
import { mode } from '$lib/stores/guestMode.svelte.js';
import { goto } from '$app/navigation';
import { getNotebook } from '$lib/core/notebooks.js';
import { getCachedPublicConfig } from '$lib/sync/firebase/publicConfig.js';

// after note loaded:
if (mode.value === 'guest') {
  const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
  const nb = note ? getNotebook(note) : null;
  if (!note || !nb || !shared.includes(nb)) {
    void goto('/notes', { replaceState: true });
    return;
  }
}
```

- [ ] **Step 2: Favorites filter**

In `TopNav.svelte`'s `openFavorites`:

```ts
async function openFavorites() {
  const all = await getAllNotes();
  let favs = all.filter(isFavorite);
  if (mode.value === 'guest') {
    const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
    favs = favs.filter((n) => {
      const nb = getNotebook(n);
      return nb !== null && shared.includes(nb);
    });
  }
  favoriteNotes = favs;
  showFavorites = true;
}
```

- [ ] **Step 3: Layout-level route guards + home redirect**

Inside `+layout.svelte`'s `afterNavigate`, after the visitor redirect:

```ts
if (mode.value === 'guest') {
  const path = page.url.pathname;
  const blocked =
    path.startsWith('/settings') ||
    path.startsWith('/admin') ||
    path.startsWith('/desktop') ||
    path === '/sleepnote';
  if (blocked) {
    void goto('/notes', { replaceState: true });
    return;
  }
  // Home redirect:
  if (path === '/') {
    const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
    if (shared.length === 0) {
      void goto('/notes', { replaceState: true });
      return;
    }
    // pick most-recently-changed note in first shared notebook
    const all = await getAllNotes();
    const cand = all
      .filter((n) => n.tags.includes(`system:notebook:${shared[0]}`))
      .sort((a, b) => b.changeDate.localeCompare(a.changeDate))[0];
    if (cand) void goto(`/note/${cand.guid}`, { replaceState: true });
    else void goto('/notes', { replaceState: true });
  }
}
```

- [ ] **Step 4: Internal link toast (optional friendliness)**

In `TomboyEditor.svelte` (or wherever `onLinkClick` is wired into `TomboyInternalLink`), wrap:

```ts
onLinkClick: async (target) => {
  if (mode.value === 'guest') {
    const note = await findNoteByTitle(target);
    if (!note) {
      pushToast('공개되지 않은 노트입니다.', { kind: 'info' });
      return;
    }
  }
  // existing navigation
}
```

- [ ] **Step 5: Type-check + smoke**

```bash
cd app && npm run check
npm run dev  # then click around as a guest
```

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/note/[id]/+page.svelte app/src/lib/components/TopNav.svelte app/src/routes/+layout.svelte app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(guest): per-note guard + favorites filter + route blocks + home redirect"
```

---

## Task 11: Settings — "공유" tab

**Goal:** Host can toggle which notebooks are public from the settings page. Toggle batches the `public` field update across the notebook's notes and updates `publicConfig.sharedNotebooks`.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`
- Possibly: a new helper `app/src/lib/sync/firebase/publishNotebook.ts`

**Acceptance Criteria:**
- [ ] Settings page exposes a new "공유" tab (the `Tab` type union gets `| 'share'`).
- [ ] Tab body lists every notebook from `listNotebooks()` with a toggle reflecting `publicConfig.sharedNotebooks`.
- [ ] Toggle ON: confirm modal → batch-update all notes tagged that notebook with `public: true` (using `writeBatch`, ≤ 500 per batch) → update `publicConfig.sharedNotebooks` → progress bar reflects work.
- [ ] Toggle OFF: symmetric.
- [ ] "공개된 노트: N개" counter per notebook (count of notes in IDB matching the tag).

**Verify:** Manual — toggle a notebook, open a private window without Dropbox, name yourself, confirm the notebook is reachable; toggle off, refresh private window, confirm it disappears.

**Steps:**

- [ ] **Step 1: `publishNotebook.ts` helper**

```ts
// app/src/lib/sync/firebase/publishNotebook.ts
import { writeBatch, doc } from 'firebase/firestore';
import { getFirebaseFirestore, ensureSignedIn } from '$lib/firebase/app.js';
import { getAllNotes } from '$lib/storage/noteStore.js';
import { getNotebook } from '$lib/core/notebooks.js';
import { writePublicConfigAsHost, readPublicConfigForHost } from './publicConfig.js';

export async function setNotebookPublic(name: string, isPublic: boolean,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const user = await ensureSignedIn();
  const db = getFirebaseFirestore();
  const all = await getAllNotes();
  const notes = all.filter((n) => getNotebook(n) === name);
  const CHUNK = 450;
  let done = 0;
  for (let i = 0; i < notes.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const n of notes.slice(i, i + CHUNK)) {
      batch.update(doc(db, 'users', user.uid, 'notes', n.guid), { public: isPublic });
    }
    await batch.commit();
    done += Math.min(CHUNK, notes.length - i);
    onProgress?.(done, notes.length);
  }

  const cfg = await readPublicConfigForHost(user.uid);
  const next = new Set(cfg.sharedNotebooks);
  if (isPublic) next.add(name);
  else next.delete(name);
  await writePublicConfigAsHost(user.uid, { sharedNotebooks: [...next] });
}
```

- [ ] **Step 2: Add tab to settings**

Search `app/src/routes/settings/+page.svelte` for the `Tab` type union and the tab-list array. Add `'share'` to the union and `{ id: 'share', label: '공유' }` to the list (match existing shape). Add a `{#if tab === 'share'}...{/if}` block with the notebook toggle UI.

```svelte
{#if tab === 'share'}
  <section class="share-tab">
    <h2>공유 노트북</h2>
    <p class="hint">체크된 노트북은 Dropbox 로그인 없이도 누구나 접근할 수 있습니다.</p>
    {#each notebooks as nb (nb)}
      <label class="row">
        <input
          type="checkbox"
          checked={sharedNotebooks.includes(nb)}
          onchange={(e) => toggleShare(nb, e.currentTarget.checked)}
        />
        <span class="label">{nb}</span>
        <span class="count">{countByNotebook.get(nb) ?? 0}개 노트</span>
      </label>
    {/each}
    {#if busy}
      <progress max={busyTotal} value={busyDone}></progress>
      <p>{busyDone}/{busyTotal}</p>
    {/if}
  </section>
{/if}
```

Backing state:

```ts
let notebooks = $state<string[]>([]);
let sharedNotebooks = $state<string[]>([]);
let countByNotebook = $state(new Map<string, number>());
let busy = $state(false);
let busyDone = $state(0);
let busyTotal = $state(0);

async function refresh() {
  notebooks = await listNotebooks();
  const all = await getAllNotes();
  const m = new Map<string, number>();
  for (const n of all) {
    const nb = getNotebook(n);
    if (nb) m.set(nb, (m.get(nb) ?? 0) + 1);
  }
  countByNotebook = m;
  const user = await ensureSignedIn();
  const cfg = await readPublicConfigForHost(user.uid);
  sharedNotebooks = cfg.sharedNotebooks;
}

async function toggleShare(name: string, on: boolean) {
  const verb = on ? '공유 시작' : '공유 해제';
  const count = countByNotebook.get(name) ?? 0;
  if (!confirm(`노트북 '${name}'의 ${count}개 노트를 ${verb}하시겠습니까?`)) {
    await refresh();
    return;
  }
  busy = true;
  busyDone = 0;
  busyTotal = count;
  await setNotebookPublic(name, on, (d, t) => { busyDone = d; busyTotal = t; });
  busy = false;
  await refresh();
}

$effect(() => {
  if (tab === 'share') refresh();
});
```

- [ ] **Step 3: Manual smoke**

```bash
cd app && npm run dev
```
Toggle a notebook, open a private window, confirm guest access.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/sync/firebase/publishNotebook.ts app/src/routes/settings/+page.svelte
git commit -m "feat(settings): 공유 tab — toggle notebook public via batched note updates"
```

---

## Task 12: End-to-end smoke + deploy hooks

**Goal:** A single mobile-flow smoke test, plus production-deploy steps for the rules + index.

**Files:**
- (No file changes — operational task.)

**Acceptance Criteria:**
- [ ] Manual smoke (host): toggle notebook public in settings, confirm progress bar finishes, refresh, confirm notebook persists as shared.
- [ ] Manual smoke (guest): open a fresh private window, navigate to the deployment URL, get the welcome page, type a name, see exactly the shared notebooks in the top nav, open a note, edit it, refresh — edit persists.
- [ ] Rules + indexes deployed to Firebase: `firebase deploy --only firestore:rules,firestore:indexes` succeeds.
- [ ] Internal-link click to a non-public title (set up by manually editing a note in the host to link to a non-shared note) shows the toast and does not navigate.

**Verify:** Run through the smoke list manually.

**Steps:**

- [ ] **Step 1: Deploy rules + indexes**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/tigress
firebase deploy --only firestore:rules,firestore:indexes
```

- [ ] **Step 2: Host smoke**

- Open `/settings` → 공유 tab → toggle a notebook → confirm progress bar.
- Reload → confirm shared state persists.

- [ ] **Step 3: Guest smoke (private window)**

- Visit `/notes` → redirected to `/welcome`.
- Type name → land on `/` → redirected into first shared notebook's most-recent note.
- TopNav shows only shared notebooks + 전체. No gear.
- Edit the note, refresh → edit persists.
- Hit `+` → new note appears in shared notebook.
- Try `/settings` directly → silently redirected to `/notes`.

- [ ] **Step 4: Internal-link guard smoke**

- In a public note, add a link to a title that exists in a non-public notebook.
- In guest mode, click it → toast appears, no navigation.

- [ ] **Step 5: Final commit (only if any tweaks)**

```bash
git status
# if clean, no commit needed.
```

---

## Self-Review Notes

- Spec coverage:
  - Welcome page (✓ Task 7)
  - Mode detection (✓ Task 3)
  - Firestore rules + composite index (✓ Task 2)
  - Public field auto-maintenance (✓ Task 5)
  - publicConfig host-write + guest-discover (✓ Task 4)
  - TopNav guest items + gear omission + theme (✓ Task 8)
  - New-note auto-notebook (✓ Task 9)
  - Per-note guard (✓ Task 10)
  - Favorites filter (✓ Task 10)
  - Route blocks (✓ Task 10)
  - Home redirect (✓ Task 10)
  - Internal link guard (✓ Task 10)
  - Settings share tab (✓ Task 11)
  - Separate guest IDB (✓ Task 6) — replaces "memory-only" via Task 1 spec update
  - Deploy + smoke (✓ Task 12)

- Type consistency:
  - `mode.value` is `'visitor' | 'guest' | 'host'` everywhere.
  - `getCachedPublicConfig()?.sharedNotebooks ?? []` is the canonical guard for "no shared notebooks yet".
  - `getNotebook(note)` returns `string | null` everywhere.
  - `FirestoreNotePayload.public: boolean` added in Task 5, referenced in Task 6's guest push.

- Risks:
  - Task 6 `configureNoteSync` interface is described abstractly; the implementer will need to read `orchestrator.ts` for the exact shape. Acceptable — that's an integration detail, not a design choice.
  - Internal-link click hook (Task 10 step 4) assumes `onLinkClick` is wired in `TomboyEditor.svelte`. Implementer should grep first to confirm location.
