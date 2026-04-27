---
name: tomboy-notesync
description: Use when working on Firebase Firestore-based realtime note sync (`app/src/lib/sync/firebase/`). Covers the orchestrator (notifyNoteSaved / attachOpenNote / detachOpenNote), the per-guid debounced push queue, the openNoteRegistry refcounting, the conflictResolver (changeDate-based last-write-wins), the noteSyncClient Firestore wrapper, the incremental collection-level sync (serverUpdatedAt watermark), the Dropbox-bridged auth reuse, the settings toggle, and the gating model that keeps the feature OFF by default. Coexists with Dropbox sync (which stays as backup); does not replace it.
---

# 파이어베이스 실시간 노트 동기화

A second sync channel that runs alongside the existing Dropbox sync. The
device mirrors three flows through Firestore:

1. **Push** — every IDB write (editor save, rename cascade, delete, favorite
   toggle) on this device gets debounced and pushed.
2. **Per-note attach** — while a note is open in an editor window, a
   doc-level `onSnapshot` keeps it in lockstep with other devices in real
   time.
3. **Incremental collection sync** — a single live cursor over
   `users/{uid}/notes` filtered by `serverUpdatedAt > lastSeen` delivers
   both the catch-up of changes accumulated while offline AND realtime
   updates that arrive while the listener is alive. This is what makes a
   newly-created note on device A reach device B without device B having
   to open it first.

Dropbox sync is unchanged — it remains the backup channel and the
authority for never-opened-anywhere notes.

The user opted out of building a 2,000-note backfill of long-dormant notes:
notes that have never been opened on any Firebase-enabled device are not in
Firestore. Other devices discover those notes through the Dropbox channel,
then carry the realtime baton from there. Once any device opens a note, it
lands in Firestore and the incremental sync covers all other devices from
that point on.

## Why this exists

Dropbox sync is **explicit-only** — the user has to click "지금 동기화". For
the active note(s) the user is editing, that's too coarse: the iPhone never
sees the laptop's edits unless the user remembers to sync. Firestore fills
the realtime gap for open notes without forcing an auto-Dropbox-sync that
would burn the 100 GiB Dropbox quota and the Tomboy revision protocol.

Single-user product, so no merge UI: timestamps decide.

## Data model

```
users/{uid}/notes/{guid}
  ├─ guid               string   (mirrors doc id)
  ├─ uri                string   (note://tomboy/<guid>)
  ├─ title              string
  ├─ xmlContent         string   (current <note-content> XML)
  ├─ createDate         string   (Tomboy ISO)
  ├─ changeDate         string   (Tomboy ISO — primary conflict key)
  ├─ metadataChangeDate string   (Tomboy ISO — tiebreaker)
  ├─ tags               string[]
  ├─ deleted            boolean  (tombstone — doc is NOT removed)
  └─ serverUpdatedAt    Timestamp (Firestore serverTimestamp())
```

`uid` reuses the Dropbox-bridged Firebase identity (`dbx-{sanitized
account_id}`) — same uid as the schedule feature. Both share the
`users/{uid}/...` namespace under the same security rule
(`firestore.rules:8-10`); no new rule was needed for the `notes` subpath.

**Per-device fields excluded from Firestore on purpose** — `cursorPosition`,
`selectionBoundPosition`, `width`, `height`, `x`, `y`, `openOnStartup`,
`localDirty`, `syncedXmlContent`. Each device keeps its own UI state.

**Firestore document size cap is ~1 MiB.** `noteToFirestorePayload` enforces
a conservative `MAX_FIRESTORE_NOTE_BYTES = 900_000` ceiling on the
JSON-serialized payload so the Firestore wire-format overhead can't push us
over. Oversized notes throw `NotePayloadTooLargeError` and are skipped.

## Module map

```
app/src/lib/sync/firebase/
├── notePayload.ts             pure: NoteData ↔ FirestoreNotePayload + size guard + validator
├── conflictResolver.ts        pure: changeDate → metadataChangeDate → tie-prefers-local
├── pushQueue.ts               per-guid debounced push, getNote-at-fire-time semantics
├── openNoteRegistry.ts        refcounted attach/detach + safe-unsubscribe
├── incrementalSync.ts         pure: collection-level catch-up + live cursor on serverUpdatedAt
├── noteSyncClient.ts          DI'd Firestore primitives (getDoc/setDoc/onSnapshot/onNotesAfter/serverTimestamp)
├── noteSyncClient.firestore.ts  real wiring against firebase/firestore SDK
├── orchestrator.ts            module-level singleton: notifyNoteSaved, attachOpenNote, detachOpenNote, start/stop incremental
└── install.ts                 one-shot configure() + apply persisted enabled flag at startup
```

The pure modules are unit-tested in isolation; the orchestrator is exercised
via fake-IDB integration tests that swap in fake `push`, `getNote`,
`getUid`, `subscribeRemote` callbacks. Tests live in
`app/tests/unit/sync/firebase/`.

## Two sides of the orchestrator

### Push side — `notifyNoteSaved(guid)`

Called from `noteManager.updateNoteFromEditor` immediately after `putNote`,
plus from the rename-cascade backlink sweep, `deleteNoteById`, and
`toggleFavorite`. Synchronous and cheap when disabled.

When enabled, enqueues the guid into a per-guid debounce queue
(`debounceMs: 500` in production, `400` for unit tests). Within the window:

- Repeated enqueues for the same guid collapse — only one push fires.
- The push function reads the **current** IDB row at fire time via
  `getNote`, so a coalesced burst of edits ends up pushing the latest
  serialized XML, not the value at the first enqueue.
- A failed push is logged via `onError` and **does not block** subsequent
  enqueues. The next save retries naturally.

The actual push function (configured in `install.ts`) signs in via
`getCurrentNoteSyncUid()` (which calls the shared `ensureSignedIn()`) and
calls `noteSyncClient.setNoteDoc(uid, note)`. If sign-in returns null
(no Dropbox connection, network down), the push is a no-op rather than an
error — the note stays `localDirty=true` and will get retried on the next
edit or, eventually, picked up by Dropbox sync.

### Pull side — `attachOpenNote(guid)` / `detachOpenNote(guid)`

Called from the mobile `/note/[id]/+page.svelte` `$effect` and the desktop
`NoteWindow.svelte` `onMount`/cleanup. Refcounted: multiple windows holding
the same guid share one Firestore subscription.

`attach` does NOT do a separate one-shot `getDoc` reconcile. Firestore's
`onSnapshot` fires immediately with the current doc state, so we hang the
initial reconcile off the very first snapshot callback. This eliminates a
race between fetch + subscribe and a redundant network round-trip.

`reconcileWithRemote(guid, remote)` runs on every snapshot:

1. Read local from IDB.
2. Build the `ConflictSide` for both (`xmlContent`, `changeDate`,
   `metadataChangeDate`, `tags`, `deleted`).
3. `resolveNoteConflict(local, remote)` returns one of:
   - `{ kind: 'noop' }` — sides equivalent (also handles "echo of our own
     write" for free; we don't need a separate echo tracker).
   - `{ kind: 'push', reason: 'remote-missing' | 'local-newer' | 'tie-prefers-local' }` — enqueue via the same push queue.
   - `{ kind: 'pull', reason: 'local-missing' | 'remote-newer' }` —
     `mergeRemoteIntoLocal(local, remote)` + `putNoteSynced(merged)` +
     `invalidateCache()` (so SidePanel, the auto-link title→guid index,
     and the `/notes` list page see the new/changed note without a
     manual refresh) + `emitNoteReload([guid])` (so the open editor for
     that guid drops its pendingDoc and swaps to the remote content).
     `invalidateCache` only fires on the pull path — `noop` and `push`
     leave IDB unchanged so there's nothing for cache subscribers to
     learn.

Echo suppression for our own pushes is implicit: after we push, Firestore
echoes the same payload we wrote, the equivalence check fires, and the
conflict resolver returns `noop`. No tracker, no signature memory.

### Incremental side — collection-level catch-up + live cursor

The per-note attach listener only covers notes that are currently open in
an editor. Without a third channel, a note created on device A while
device B sits on a different note is invisible to B until B explicitly
opens that note's guid — and B has no way to know the guid exists until
the user clicks the broken link. The incremental sync closes that gap.

`createIncrementalSync` (in `incrementalSync.ts`) keeps a single
`onSnapshot` over `users/{uid}/notes` filtered by
`serverUpdatedAt > lastFirebaseSyncAt`. The first emission delivers the
catch-up batch (everything that changed while we were offline);
subsequent emissions deliver realtime changes from other devices. Per
emission:

1. For each doc in the batch, run the same `reconcileWithRemote(guid,
   payload)` that the per-note attach listener uses. Echo of our own
   pushes resolves to `noop` via the equivalence check.
2. Track `max(serverUpdatedAtMillis)` seen so far in the batch.
3. After the batch is fully applied, persist that max to
   `appSettings.firebaseNotesLastSyncAt` so the next session resumes
   exactly where this one ended. The watermark never regresses — older
   timestamps don't move it backwards.

The lower bound is `serverUpdatedAt` (Firestore `Timestamp`, set by
`serverTimestamp()` on every push), **not** `changeDate`. `changeDate`
is a wall-clock ISO string that doesn't sort lexically across timezone
offsets, so it's unsafe as a query predicate. `serverUpdatedAt` is
server-side and monotonic.

The lifecycle is driven by `setNoteSyncEnabled`:
- `setNoteSyncEnabled(true)` reads the persisted watermark, fetches the
  uid, and starts the listener. Idempotent — calling it twice while
  running is a no-op.
- `setNoteSyncEnabled(false)` synchronously unsubscribes.
- `start(uid)` is async (it awaits `getLastSyncMillis`); if `stop()` runs
  before the inner subscription resolves, the eventual handle is
  cancelled (the `stopRequested` latch in `incrementalSync.ts`).

Pending Firestore writes whose `serverTimestamp()` hasn't been finalised
yet emit a snapshot with `serverUpdatedAt = null`. The firestore-wiring
adapter drops those rows; they arrive in the follow-up snapshot once the
server confirms.

The per-note attach listener and the incremental listener can both fire
for the same doc — they call the same `reconcileWithRemote`, which is
idempotent under the conflict resolver. The duplicate IDB write is a
no-op cost, not a correctness problem.

**First-run cost on a new device**: the watermark starts at 0 so the
initial query pulls every note that has ever been mirrored to Firestore.
For a 2,000-note user with ~200 ever-opened notes, that's a few hundred
KB — paid once. After that, only deltas.

## Conflict resolution rules

`resolveNoteConflict(local, remote)` priority order:

1. Both undefined → `noop`.
2. Only one side present → `push` (`remote-missing`) or `pull`
   (`local-missing`).
3. Both present and **equivalent** (same `xmlContent`, same `tags`, same
   `deleted`) → `noop`.
4. `changeDate` differs → later wins.
5. `changeDate` ties → `metadataChangeDate` decides (covers tag-only edits
   like favorite toggle).
6. Both timestamps tie but content differs → **`push` with reason
   `tie-prefers-local`**: never silently overwrite the editor the user is
   currently looking at.

Tomboy `changeDate` is a string ISO-8601 with timezone, so plain
`localeCompare` is correct across days/years. `xmlContent` equality is
byte-level, which is fine because the editor's no-op-skip logic in
`updateNoteFromEditor` already prevents whitespace-only writes.

Tombstones flow through unchanged: a remote `deleted=true` with a newer
`changeDate` pulls; a local resurrection with a newer `changeDate` pushes.
Documents are never `deleteDoc`'d — soft-delete only, so other devices learn
about the deletion when they reconcile.

## Gating: feature flag + sign-in

Two independent gates. Both must pass for any Firestore I/O to happen:

- **Settings flag** — `firebaseNotesEnabled` in `appSettings`, read by
  `isFirebaseNotesEnabledSetting()` in `install.ts`. Default `false`.
  Loaded once at startup, reapplied on every settings toggle. Consulted by
  `setNoteSyncEnabled` / `isNoteSyncEnabled` on the orchestrator.
- **Auth** — `getCurrentNoteSyncUid()` returns null when Dropbox isn't
  connected or `ensureSignedIn()` throws. Push and attach both no-op on
  null uid.

The flag and auth are deliberately separate: flipping the flag in settings
should not block the UI on a network round-trip; the auth gate handles the
"connected but offline" case implicitly.

`installRealNoteSync()` is idempotent. The first call wires the orchestrator
with the real Firestore primitives via `getRealNoteSyncClient()` /
`getCurrentNoteSyncUid` / `noteSyncClient.subscribeNoteDoc`. Subsequent calls
just re-apply the persisted flag — used by the settings toggle so flipping
ON works even if the user changed the flag before the layout's startup
install ran (race-safe).

## Integration with Dropbox sync

Dropbox sync is **untouched**. Manual "지금 동기화" still pushes/pulls
`.note` files via the revision protocol. The two channels coexist as
follows:

- **Editor save** → IDB → Firestore push (if enabled). Dropbox is silent
  until the next manual sync.
- **Dropbox pull** → IDB write via `putNoteSynced` (doesn't go through
  `updateNoteFromEditor`, so `notifyNoteSaved` is **not** called). If that
  note happens to be open in an editor, the pull-side `reconcileWithRemote`
  on the next Firestore snapshot will see local newer and push it. If the
  note is closed, Firestore stays unaware until someone opens it again.
- **Note never opened anywhere** → not in Firestore, lives in Dropbox only.
  Opening it on any device triggers the `attach → first snapshot →
  remote-missing → push` path that bootstraps the doc.
- **Note created or edited on device A while device B sits on a different
  note** → device A's push lands in Firestore. Device B's incremental
  collection listener catches the doc on its next emission (effectively
  realtime — usually within a second). Device B's IDB ends up with the
  full note before the user ever needs to click a link to it. This is
  what the incremental sync exists to cover.

This is the intended steady state for a 2,000-note collection where only a
handful are actively edited at any time.

## Hooked save paths

Every IDB write that should propagate to Firestore goes through one of these
in `noteManager.ts`:

| Function | Trigger |
|----------|---------|
| `createNote(initialTitle?)` | new (often empty) note — pushes so receivers can resolve a link to it before the user ever edits the body |
| `updateNoteFromEditor(guid, doc)` | every editor save |
| `rewriteBacklinksForRename(...)` | rename cascade — fires `notifyNoteSaved` per affected guid |
| `deleteNoteById(guid)` | soft-delete (sets `deleted=true`); the underlying `noteStore.deleteNote` ALSO bumps `changeDate`/`metadataChangeDate` so the tombstone wins on the receiver |
| `toggleFavorite(guid)` | `system:pinned` tag flip — picks up `metadataChangeDate` |

Notes intentionally NOT hooked:
- `importNoteXml` and `syncManager.applyIncomingRemoteNote` — Dropbox-channel
  writes; they don't run through Firebase. If the note is open, the next
  Firestore snapshot will reconcile.

### Why `createNote` pushes

The original design assumed a new note immediately gets edited, so the
first edit's push covers it. That breaks the "create new note + drop a
link to it from another note" workflow: device A creates "새 노트", switches
to note B, adds a `<link:internal>새 노트</link:internal>` mark, saves B.
Note B is pushed; note "새 노트" is **not** because it was never edited.
Device B receives note B via incremental sync, sees the link, but
`findNoteByTitle("새 노트")` returns undefined → "노트를 찾을 수 없습니다".
Hooking `createNote` fixes this — the push queue's debounce coalesces
the create-push with any follow-up edit at zero extra cost.

### Why `deleteNote` bumps `changeDate`

Soft-delete used to set only `deleted=true` + `localDirty=true`. After
push, the receiver saw `(deleted=true, changeDate=T)` arrive against
its local `(deleted=false, changeDate=T)`. The conflict resolver's
ladder is: equivalence-check → `changeDate.localeCompare` → `metadataChangeDate.localeCompare`
→ **`tie-prefers-local`**. With both timestamps tied, the receiver
would push its non-deleted state back, silently undoing the delete on
every device. Bumping both timestamps inside `deleteNote` makes the
tombstone strictly newer, so the resolver's `remote-newer` branch
fires and the delete propagates as expected.

## File map

| File | Purpose |
|------|---------|
| `lib/sync/firebase/notePayload.ts` | `noteToFirestorePayload`, `assertValidPayload`, `mergeRemoteIntoLocal`; size guard + custom error types |
| `lib/sync/firebase/conflictResolver.ts` | `resolveNoteConflict` — pure last-write-wins + tiebreakers |
| `lib/sync/firebase/pushQueue.ts` | `createPushQueue({ debounceMs, push, getNote })` — per-guid debounce + flush/flushAll |
| `lib/sync/firebase/openNoteRegistry.ts` | `createOpenNoteRegistry({ start })` — refcounted attach/detach with safe unsubscribe |
| `lib/sync/firebase/incrementalSync.ts` | `createIncrementalSync({ subscribe, applyRemote, getLastSyncMillis, setLastSyncMillis })` — collection-level catch-up + live cursor on `serverUpdatedAt`; idempotent `start(uid)` / `stop()` |
| `lib/sync/firebase/noteSyncClient.ts` | `createNoteSyncClient(prim)` over injectable Firestore primitives + `noteDocPath` + `subscribeNoteCollection` |
| `lib/sync/firebase/noteSyncClient.firestore.ts` | real `firebase/firestore` adapter; `getCurrentNoteSyncUid`; `onNotesAfter` wraps `query(... where('serverUpdatedAt', '>', Timestamp.fromMillis(since)))` |
| `lib/sync/firebase/orchestrator.ts` | module-level singleton: `notifyNoteSaved`, `attachOpenNote`, `detachOpenNote`, `setNoteSyncEnabled` (auto-starts/stops incremental), `flushAllNoteSync`, `_resetNoteSyncForTest` |
| `lib/sync/firebase/install.ts` | startup glue: persisted-flag load, `configureNoteSync(...)` with watermark adapters reading/writing `firebaseNotesLastSyncAt`, `installRealNoteSync()` |
| `lib/firebase/app.ts` | shared lazy Firebase singletons + `ensureSignedIn` (also used by `lib/schedule/`) |
| `lib/core/noteManager.ts` | hooks: `notifyNoteSaved` calls in `updateNoteFromEditor`, rename cascade, `deleteNoteById`, `toggleFavorite` |
| `routes/note/[id]/+page.svelte` | mobile attach/detach via `$effect` keyed on `noteId` |
| `lib/desktop/NoteWindow.svelte` | desktop attach in onMount, detach in cleanup |
| `routes/+layout.svelte` | calls `installRealNoteSync()` once at app start |
| `routes/settings/+page.svelte` (config tab) | "파이어베이스 실시간 동기화" toggle |

## Testing

Tests in `app/tests/unit/sync/firebase/` (10 files, ~100 tests):

- **Pure**: `notePayload.test.ts`, `conflictResolver.test.ts`,
  `incrementalSync.test.ts` — no IDB, no timers. The incremental tests
  inject fake `subscribe` / `applyRemote` / watermark fns and assert
  start/stop lifecycle, watermark advancement, and start-after-stop
  resume semantics.
- **Timer-driven**: `pushQueue.test.ts`, `orchestrator.test.ts` —
  `vi.useFakeTimers()` plus async advance helpers.
- **Refcounting**: `openNoteRegistry.test.ts` — synchronous, fakes only.
- **DI'd Firestore**: `noteSyncClient.test.ts` — fakes
  `FirestorePrimitives` (including `onNotesAfter`), asserts payload
  shape, snapshot dispatch, and collection-batch parsing with malformed
  rows dropped.
- **Integration**: `orchestrator.integration.test.ts`,
  `orchestrator.attach.test.ts`, and
  `orchestrator.incremental.test.ts` — fake-indexeddb + real noteManager
  calls, injected fake `subscribeRemote` / `subscribeNoteCollection` /
  watermark fns. Real timers (fake-indexeddb relies on setTimeout for
  microtask scheduling and starves under fake timers).

The production wiring file `noteSyncClient.firestore.ts` is **not**
unit-tested; it's a thin pass-through to the real SDK. Manual verification:
flip the toggle ON in settings against a real Firebase project, edit a note
on two devices, watch realtime propagation.

## Settings UI

`routes/settings/+page.svelte` → "동기화 설정" tab → "파이어베이스 실시간
동기화" section. A single checkbox bound to `firebaseNotesEnabled`:

- On toggle, `setSetting(FIREBASE_NOTES_ENABLED_KEY, next)` persists,
  `installRealNoteSync()` re-runs (idempotent), `setNoteSyncEnabled(next)`
  flips the orchestrator gate, and a toast confirms.
- No "connection status" indicator currently — failures show up as toast
  errors only when the user actively interacts. (Future work if needed.)

## Known limitations

- **No 2,000-note backfill.** Notes you've never opened on any
  Firebase-enabled device are not in Firestore. Live with it; the Dropbox
  channel still has them. Once any device opens such a note, it becomes
  reachable to all other devices via the incremental collection sync.
- **First-run incremental query is a full pull of Firestore-mirrored
  notes.** A new device with a 0 watermark fetches every doc whose
  `serverUpdatedAt` exists. Bounded by the actual Firestore footprint
  (only ever-opened notes), so for typical use this is hundreds of KB,
  not megabytes. Subsequent sessions only pull the delta.
- **Backlink rewrites of closed notes don't reach other devices in
  real time.** The rename cascade enqueues pushes for every affected note,
  but if a target device hasn't opened those notes, the rewrite only lands
  in Firestore on the originating device's next attach. The receiving
  device picks it up the next time *it* opens those notes (or via
  Dropbox sync). With incremental sync enabled, the rewrites still flow
  in via the collection cursor as soon as the originating device pushes.
- **Dropbox-pulled notes don't auto-push to Firestore.**
  `applyIncomingRemoteNote` writes via `putNoteSynced` and intentionally
  bypasses `notifyNoteSaved`. If the user wants the freshly pulled note in
  Firestore, they need to open it (which triggers the attach reconcile) or
  edit it.
- **No offline persistence yet.** `enableIndexedDbPersistence()` is not
  called. When offline, pushes silently no-op (uid lookup fails) and
  pulls don't fire. The Dropbox channel still acts as the offline-safe
  backup. Adding persistence would shift cost-vs-complexity; deferred until
  there's a concrete need.
- **No size-cap UX.** A note that exceeds `MAX_FIRESTORE_NOTE_BYTES` throws
  inside the push queue's `onError` and gets logged but no user-facing
  toast. Rare in practice; revisit if it ever happens.
- **Watermark uses `serverUpdatedAt`, not `changeDate`.** `changeDate` is
  a wall-clock ISO string that doesn't sort lexically across timezone
  offsets, so it's not safe as a Firestore range-query predicate. The
  collection cursor uses `serverUpdatedAt` (Firestore `Timestamp`,
  monotonic per server). Conflict resolution still uses `changeDate` —
  the two timestamps serve different purposes.

## Operational notes

- **Firebase project**: same `tomboy-web` project (region
  `asia-northeast3`) used by the schedule feature. No new function, no new
  index — single-doc reads/writes/onSnapshot only, covered by the existing
  `users/{uid}/{document=**}` security rule.
- **No Cloud Function added.** Reconciliation runs entirely on the client.
- **Auth bridge is shared.** Sign-in is the same as for schedule alarms;
  the first feature to call `ensureSignedIn()` on a fresh session pays the
  one-time cost. The console log prefix on the leftover-anonymous cleanup
  was changed from `[schedule]` to `[firebase]` to reflect the shared role.
- **Debounce window**: 500 ms in production. Tuned for keystroke bursts
  while staying tight enough that the iPhone visibly follows the laptop's
  edits within a second or two.
- **Quota footprint**: per active note, one onSnapshot listener + one
  `setDoc` per debounce window. Spark-plan-friendly for a single user.

## When making changes here

- **Pure modules first** (`notePayload`, `conflictResolver`, `pushQueue`):
  these are the easiest to test and the foundation everything else builds
  on. New conflict rules belong here, not scattered into `reconcileWithRemote`.
- **Don't reach into `firebase/firestore` outside
  `noteSyncClient.firestore.ts`.** All other modules consume the
  `FirestorePrimitives` interface so they stay testable without the SDK.
- **The orchestrator is a singleton with reset for tests.** If you find
  yourself wanting per-instance state, extract it into a new pure module
  rather than parameterising the singleton.
- **Don't add an echo tracker.** The conflict resolver's equivalence check
  already handles self-echo. A separate tracker would just be a second
  source of truth for "what did we last push" and would drift.
- **Don't reintroduce auto-sync via Dropbox** to "fix" the closed-note
  Firestore gap. The user explicitly opted out of Dropbox auto-sync; the
  realtime channel is supposed to cover only the open-note case.
