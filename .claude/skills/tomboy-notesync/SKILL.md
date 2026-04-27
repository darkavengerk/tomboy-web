---
name: tomboy-notesync
description: Use when working on Firebase Firestore-based realtime note sync (`app/src/lib/sync/firebase/`). Covers the orchestrator (notifyNoteSaved / attachOpenNote / detachOpenNote), the per-guid debounced push queue, the openNoteRegistry refcounting, the conflictResolver (changeDate-based last-write-wins), the noteSyncClient Firestore wrapper, the Dropbox-bridged auth reuse, the settings toggle, and the gating model that keeps the feature OFF by default. Coexists with Dropbox sync (which stays as backup); does not replace it.
---

# 파이어베이스 실시간 노트 동기화

A second sync channel that runs alongside the existing Dropbox sync. Notes
that the user has **opened at least once** are mirrored into Firestore; while
they're open, every save is pushed and every remote change is pulled in real
time. Dropbox sync is unchanged — it remains the backup channel and the
authority for never-opened notes (the 2,000-note backlog).

The user opted out of building a 2,000-note backfill: closed notes are not
present in Firestore until the user opens them on some device. Other devices
discover those notes through the Dropbox channel, then carry the realtime
baton from there.

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
├── noteSyncClient.ts          DI'd Firestore primitives (getDoc/setDoc/onSnapshot/serverTimestamp)
├── noteSyncClient.firestore.ts  real wiring against firebase/firestore SDK
├── orchestrator.ts            module-level singleton: notifyNoteSaved, attachOpenNote, detachOpenNote
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
     `emitNoteReload([guid])` so the open editor drops its pendingDoc and
     swaps to the remote content.

Echo suppression for our own pushes is implicit: after we push, Firestore
echoes the same payload we wrote, the equivalence check fires, and the
conflict resolver returns `noop`. No tracker, no signature memory.

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

This is the intended steady state for a 2,000-note collection where only a
handful are actively edited at any time.

## Hooked save paths

Every IDB write that should propagate to Firestore goes through one of these
in `noteManager.ts`:

| Function | Trigger |
|----------|---------|
| `updateNoteFromEditor(guid, doc)` | every editor save |
| `rewriteBacklinksForRename(...)` | rename cascade — fires `notifyNoteSaved` per affected guid |
| `deleteNoteById(guid)` | soft-delete (sets `deleted=true`) |
| `toggleFavorite(guid)` | `system:pinned` tag flip — picks up `metadataChangeDate` |

Notes intentionally NOT hooked:
- `createNote` — the new note immediately opens in the editor; the first
  edit triggers push.
- `importNoteXml` and `syncManager.applyIncomingRemoteNote` — Dropbox-channel
  writes; they don't run through Firebase. If the note is open, the next
  Firestore snapshot will reconcile.

## File map

| File | Purpose |
|------|---------|
| `lib/sync/firebase/notePayload.ts` | `noteToFirestorePayload`, `assertValidPayload`, `mergeRemoteIntoLocal`; size guard + custom error types |
| `lib/sync/firebase/conflictResolver.ts` | `resolveNoteConflict` — pure last-write-wins + tiebreakers |
| `lib/sync/firebase/pushQueue.ts` | `createPushQueue({ debounceMs, push, getNote })` — per-guid debounce + flush/flushAll |
| `lib/sync/firebase/openNoteRegistry.ts` | `createOpenNoteRegistry({ start })` — refcounted attach/detach with safe unsubscribe |
| `lib/sync/firebase/noteSyncClient.ts` | `createNoteSyncClient(prim)` over injectable Firestore primitives + `noteDocPath` |
| `lib/sync/firebase/noteSyncClient.firestore.ts` | real `firebase/firestore` adapter; `getCurrentNoteSyncUid` |
| `lib/sync/firebase/orchestrator.ts` | module-level singleton: `notifyNoteSaved`, `attachOpenNote`, `detachOpenNote`, `setNoteSyncEnabled`, `flushAllNoteSync`, `_resetNoteSyncForTest` |
| `lib/sync/firebase/install.ts` | startup glue: persisted-flag load, `configureNoteSync(...)`, `installRealNoteSync()` |
| `lib/firebase/app.ts` | shared lazy Firebase singletons + `ensureSignedIn` (also used by `lib/schedule/`) |
| `lib/core/noteManager.ts` | hooks: `notifyNoteSaved` calls in `updateNoteFromEditor`, rename cascade, `deleteNoteById`, `toggleFavorite` |
| `routes/note/[id]/+page.svelte` | mobile attach/detach via `$effect` keyed on `noteId` |
| `lib/desktop/NoteWindow.svelte` | desktop attach in onMount, detach in cleanup |
| `routes/+layout.svelte` | calls `installRealNoteSync()` once at app start |
| `routes/settings/+page.svelte` (config tab) | "파이어베이스 실시간 동기화" toggle |

## Testing

Tests in `app/tests/unit/sync/firebase/` (8 files, ~78 tests):

- **Pure**: `notePayload.test.ts`, `conflictResolver.test.ts` —
  no IDB, no timers.
- **Timer-driven**: `pushQueue.test.ts`, `orchestrator.test.ts` —
  `vi.useFakeTimers()` plus async advance helpers.
- **Refcounting**: `openNoteRegistry.test.ts` — synchronous, fakes only.
- **DI'd Firestore**: `noteSyncClient.test.ts` — fakes
  `FirestorePrimitives`, asserts payload shape and snapshot dispatch.
- **Integration**: `orchestrator.integration.test.ts` and
  `orchestrator.attach.test.ts` — fake-indexeddb + real noteManager calls,
  injected fake `subscribeRemote`. Real timers (fake-indexeddb relies on
  setTimeout for microtask scheduling and starves under fake timers).

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
  channel still has them.
- **Backlink rewrites of closed notes don't reach other devices in
  real time.** The rename cascade enqueues pushes for every affected note,
  but if a target device hasn't opened those notes, the rewrite only lands
  in Firestore on the originating device's next attach. The receiving
  device picks it up the next time *it* opens those notes (or via
  Dropbox sync).
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
