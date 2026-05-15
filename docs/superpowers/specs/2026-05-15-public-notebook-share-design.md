# Public Notebook Share — design

## Goal

Let a Dropbox-logged-in host expose one or more notebooks so that a visitor
without any Dropbox login can land on the same domain, type a name, and
read + edit notes in those notebooks. Domain owner stays the only "host";
the feature is intentionally low-ceremony — no per-guest accounts, no
share-token URLs, no whitelisting.

## Roles

- **Host** — Dropbox account is connected. Sees everything as today.
- **Guest** — Dropbox not connected, has chosen a display name on the
  landing page. Sees only the host's shared notebooks. Can create / edit /
  delete notes inside those notebooks.
- **Visitor** — Dropbox not connected, no guest name yet. Redirected to
  the landing page on every navigation attempt.

Detection rule (`lib/stores/guestMode.svelte.ts`):

```
isHost    = await getFreshAccessToken() !== null
isGuest   = !isHost && localStorage('tomboy.guestName') != null
isVisitor = !isHost && !isGuest
```

Evaluated once on app boot inside `+layout.svelte`; result lives in a
Svelte 5 rune store everything else reads.

The guest name has **no security role**. It is stored in `localStorage`
purely for display (e.g. future "edited by" lines). Anyone typing any
name passes; the host doesn't manage a guest list.

## Data Model (Firestore)

Two additions on top of the existing `tomboy-notesync` schema:

```
/users/{hostUid}/notes/{guid}
  + public: boolean   // new field; default missing == false
  (all other fields unchanged)

/users/{hostUid}/publicConfig/main
  {
    sharedNotebooks: string[]   // notebook names (without the
                                 // 'system:notebook:' prefix)
  }
```

Nothing is mirrored to a separate collection. The host's notes stay where
they are; the `public` flag is the only gate Firestore rules check.

Guests reach the host's notes via a `collectionGroup('notes')` query
filtered on `public == true` — so the client never has to know the
host uid up front (a single-host domain today, multi-host later if we
want, without schema change).

**Discovering the host uid (guest side):** A guest's first Firestore call
is `collectionGroup('publicConfig').limit(1).get()`. The returned doc's
`ref.parent.parent.id` is the host's uid — the guest caches it in memory
for the rest of the session and uses it to build write paths
(`/users/{hostUid}/notes/{guid}`).

## Firestore Rules

```
match /databases/{db}/documents {

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
    allow read:  if true;                       // anonymous read OK
    allow write: if request.auth.uid == hostUid;
  }

  // Existing rule for everything else under users/{uid}/...
  match /users/{uid}/{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}
```

Notes:

- Guests use **anonymous Firebase Auth** (`signInAnonymously`). The
  Dropbox-bridged custom-token path is host-only; `ensureSignedIn`
  grows a `mode: 'host' | 'guest'` switch.
- Guests cannot flip a note's `public` field from `true` to `false`
  (the update rule blocks it). Only the host can un-publish.
- A `collectionGroup` composite index on `(public, serverUpdatedAt)`
  is required for the guest catch-up query (matches the existing
  incremental-sync watermark pattern).
- The `publicConfig` match works for `collectionGroup('publicConfig')`
  queries because Firestore evaluates the rule on each candidate doc
  using its parent path — the guest reads any host's publicConfig with
  `ref.parent.parent.id` yielding the hostUid for follow-up writes.

## Routing & Mode Detection

New route:

- `/welcome` — landing page. Two CTAs:
  1. Name input + "게스트로 시작" button. On submit: write
     `localStorage('tomboy.guestName')`, anonymous-sign-in to Firebase,
     redirect to `/`.
  2. "Dropbox로 로그인" button. Existing OAuth PKCE flow; on return
     `isHost` becomes true.

Guards inside `+layout.svelte` after mode detection:

| State        | Allowed                                        | Otherwise redirect to |
|--------------|------------------------------------------------|-----------------------|
| `isVisitor`  | `/welcome`                                     | `/welcome`            |
| `isGuest`    | `/`, `/notes`, `/note/{guid}` (public-only)     | `/notes`              |
| `isHost`     | everything (today's behavior)                  | —                     |

Specifically blocked for guests: `/settings`, `/admin/**`, `/desktop/**`,
`/sleepnote`. These redirect silently to `/notes`.

Home (`/`) behavior:

- Host: unchanged.
- Guest: redirect to the most-recently-changed note inside the **first**
  notebook in `publicConfig.sharedNotebooks` (array order, which is the
  order the host turned them on). If empty → `/notes`.

Per-note guard inside `/note/{guid}/+page.svelte`: if guest and the
loaded note is missing or `public !== true`, redirect to `/notes`.

## Guest UI Changes

**`lib/components/TopNav.svelte`**

- Replace the static `홈 / 슬립노트 / 전체` array with mode-aware items:
  - Host: today's three entries.
  - Guest: one entry per `publicConfig.sharedNotebooks[*]` (linking to
    `/notes?nb=<name>`) plus `전체` at the end.
- Right-side cluster:
  - Host: `+`, ★, ⚙ (today).
  - Guest: `+`, ★. **The ⚙ button is not rendered at all** — DOM
    omitted, not just hidden.
- Theme class: `theme-guest` (new) — distinct color from the four host
  themes so the user can see at a glance they are in guest mode. Pick
  a desaturated teal / slate. Suggested: `#3f6b66`.

**`+` new note (`handleNewNote`)**

- Host: unchanged.
- Guest: call `createNote()`, then `assignNotebook(newGuid, sharedNotebooks[0])`,
  then push to Firestore with `public: true` (handled by the auto-public
  pipeline below). Navigate to `/note/{guid}`. No notebook picker shown.

**Internal-link click (`TomboyInternalLink` extension)**

- Add a click guard: when `isGuest`, resolve the linked title → guid →
  if no such public note (either deleted or `public !== true`) emit a
  toast "공개되지 않은 노트입니다" and `preventDefault`. The URL-link
  mark continues to work normally (external URLs unaffected).

**Favorites sheet (`TopNav.svelte`)**

- Both modes share the `system:pinned` tag (per existing behavior, no
  per-device favorites). For guests, filter the favorites list to drop
  any note whose `public !== true` so non-public favorites simply don't
  appear in the sheet.

## Host UI — Settings

Add a new tab to `/settings/+page.svelte`: **공유** (between 동기화 and 기타).

Tab contents:

- List every notebook from `listNotebooks()`. For each:
  - Toggle switch bound to `publicConfig.sharedNotebooks.includes(name)`.
  - Caption: "공개된 노트: N개" (count of notes in that notebook with
    `public === true`).
- Toggle ON:
  - Confirm dialog: "노트북 'X'에 있는 N개 노트가 누구나 볼 수 있게 됩니다."
  - On confirm: Firestore `writeBatch` chunks of ≤ 500 notes setting
    `public: true` on every note tagged `system:notebook:X`. Then update
    `publicConfig.sharedNotebooks` to append the name.
  - Progress bar while batching.
- Toggle OFF: symmetric (`public: false`, remove from `sharedNotebooks`).

Edge case — note moved between notebooks: see auto-maintenance below.

The publicConfig doc is read once on app boot (`installRealNoteSync`)
and kept in memory; toggle updates rewrite it. Guests read it once at
sign-in.

## Auto-public Field Maintenance

When a note is saved (any source — editor, slip-note splicing, import),
the Firestore push payload builder (`lib/sync/firebase/notePayload.ts`)
must compute `public` from `(notebook, sharedNotebooks)`:

```
function computePublic(note, sharedNotebooks): boolean {
  const nb = getNotebook(note);
  return nb !== null && sharedNotebooks.includes(nb);
}
```

This runs on every push, so:

- New note created in a shared notebook → `public: true`.
- Existing note moved into / out of a shared notebook → `public` updates
  on the next save.
- Notebook name change (rename cascade) → re-evaluation happens because
  every affected note is rewritten anyway.

The sharedNotebooks list is read from the in-memory mirror of
`publicConfig.sharedNotebooks` that the host populates at boot. If the
mirror is stale (host toggled on another device), the auto-flag is
self-healing because every batch update writes the entire chunk anyway.

Guests read `publicConfig/main` once on sign-in to populate the TopNav
notebook items and the "first shared notebook" used by the `+` action.
The doc is **not** kept under a live listener; if the host toggles
mid-session the guest sees the change after a reload. This is
intentional — keeps the guest path to a single read and avoids a
second always-on listener.

## IDB & Data Storage

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

## Non-goals

- **Per-guest identity / audit.** The guest name is display-only. We do
  not record "edited by guest = 철수" anywhere.
- **Per-guest favorites.** Favorites stay note-level (`system:pinned`)
  and therefore globally visible — confirmed acceptable.
- **Multi-host on the same domain.** Schema supports it (no host uid in
  paths the guest depends on) but UI assumes one host per deployment.
- **Mobile-only enforcement.** Guest mode renders on desktop too;
  "mobile-only" is a styling/design intent, not a runtime gate.
- **Share-link revocation per-person.** Turning a notebook off
  un-shares it for every guest simultaneously.
- **Defending against malicious console use.** A guest with devtools
  open could call the Firestore SDK directly with a payload like
  `{ public: true, tags: ['system:notebook:호스트의비공개'] }` and create a
  note that lands inside the host's non-shared notebook. The rules
  prevent reading any non-public note, so the guest cannot read host
  data this way, but they can inject a note that shows up on the host
  side. The host can simply delete it. Treating this as a non-goal
  keeps the rules small; if it becomes a real problem, the fix is to
  add a `get(...publicConfig...)` reference in the create rule and a
  dedicated `notebook` field on each note doc for cheap lookup.

## Files Touched (preview)

New:

- `app/src/routes/welcome/+page.svelte` — landing page.
- `app/src/lib/stores/guestMode.svelte.ts` — mode rune.
- `app/src/lib/sync/firebase/publicConfig.ts` — read/write
  `publicConfig/main`.
- `app/src/lib/sync/firebase/guestAuth.ts` — `signInAnonymously`
  helper; gates `ensureSignedIn` to host path.

Modified:

- `app/src/routes/+layout.svelte` — mode detection + guards on
  `afterNavigate`.
- `app/src/lib/components/TopNav.svelte` — mode-aware items + gear
  omission + guest theme class.
- `app/src/lib/sync/firebase/notePayload.ts` — `public` field
  derivation.
- `app/src/lib/sync/firebase/noteSyncClient.firestore.ts` — guest path:
  collectionGroup query w/ `public == true`.
- `app/src/lib/firebase/app.ts` — host-vs-guest sign-in branching.
- `app/src/routes/settings/+page.svelte` — 공유 tab.
- `app/src/routes/note/[id]/+page.svelte` — per-note public guard.
- `app/src/lib/editor/extensions/TomboyInternalLink.ts` — guest click
  guard.
- `firestore.rules` — new public-notes rules.
- `firestore.indexes.json` — `(public, serverUpdatedAt)` composite
  index on collectionGroup `notes`.

Tests follow the existing `app/tests/unit/...` layout: rule simulator
tests for the four allow blocks, payload-builder unit tests for
`computePublic`, mode-store snapshot tests for visitor → guest → host
transitions.
