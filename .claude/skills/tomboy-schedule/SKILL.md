---
name: tomboy-schedule
description: Use when working on schedule-note push notifications. Covers the parser format (Korean date/time list-item lines under a `N월` section), fire-time rules (30 min before time-bearing items / 07:00 for date-only), the line-hash diff/upload pipeline, the Cloud Function firing window, and FCM device registration. Files in `app/src/lib/schedule/`, `functions/src/`, and `app/src/service-worker.ts`.
---

# 일정 알림 (schedule-note push notifications)

The user designates one note as the "schedule note". Its list items are
parsed every save; matching `(date, time, label)` triples are diff'd against
a stored snapshot, the delta is queued, and a Cloud Function drains the queue
and fires Web Push 30 min before each time-bearing event (or at 07:00 on the
event day for date-only entries).

## Format

```
4월
  노트 열심히 만드는 달          ← ignored (no day prefix)
  15(금) 등산 7시                ← fire 18:30 same day (PM default)
  16(토) 빨래                    ← fire 07:00 on day 16
  16(토) 친구 만나기 6시 반 집앞 ← fire 18:00, label "친구 만나기 집앞"
  17(일) 쓰레기 버리기 7시 20분  ← fire 18:50, label "쓰레기 버리기"
```

Rules — enforced by `app/src/lib/schedule/parseSchedule.ts`:

- **Month section** — any block (paragraph or top-level listItem) whose
  trimmed text is exactly `\d+월`. Only the section matching
  `now.getMonth()+1` is processed; other-month sections are ignored.
- **Year** — implicit. Always `now.getFullYear()`.
- **Day prefix** — required. `\d{1,2}` optionally followed by `(요일)`,
  then a space (or end), then label. Day must be a real date for the
  current month (Apr 31 → ignored; Feb 30 → ignored).
- **Time** — optional. Pattern `(오전|오후)? \d시 (반|\d분)?` anywhere
  in the line.
  - PM default for 1–11 with no period prefix (`7시` → 19:00).
  - `12시` → 12:00 (noon). `오전 12시` → 00:00 (midnight). `오후 12시` → 12:00.
  - `반` → :30. `13시` and above kept as 24-hour.
- **Label cleanup** — time substring stripped, runs of spaces collapsed,
  trimmed. `15(금) 친구 만나기 6시 반 집앞` → label `친구 만나기 집앞`.
- **List items only** — top-level `Nx월` paragraph + child bulletList,
  OR a top-level listItem whose first paragraph is `Nx월` with a nested
  bulletList. Both shapes supported.

## Fire-time rules

- Time present → `fireAt = eventAt - 30 min`.
- Date only (no time) → `eventAt = day at 00:00 local`,
  `fireAt = day at 07:00 local`.
- KST (Asia/Seoul) is hardcoded for the current month-of-year arithmetic,
  matching the user's single-device assumption.

## ID model — line hash, no "modified" operation

`buildScheduleItem` derives id as
`fnv1a64( "${year}-${MM}-${DD}|${hh}:${mm}|${label}" ).hex16chars`.
Any change to date, time, or label mints a new id. Edits are therefore
modeled as `{ removed: oldId, added: newId }` pairs — there is no
"update" path through Firestore. This keeps `flushPendingSchedule`
trivially idempotent on retry.

## Diff & flush pipeline

1. `noteManager.updateNoteFromEditor` saves the note, then calls
   `syncScheduleFromNote(note, now)`.
2. If `note.guid` matches `getScheduleNoteGuid()`, parse the note's TipTap
   JSON, build items, and diff against `loadScheduleSnapshot(guid)`.
3. Non-empty diff → write `PendingScheduleState` (single global slot,
   subsumes prior unflushed deltas because diff is always against the
   canonical snapshot).
4. If `isNotificationsEnabled()` and online, `flushIfEnabled()` runs
   `firestoreScheduleClient` against `users/{uid}/schedule/{itemId}` and
   `…/devices/{installId}`, then promotes `curr` to the snapshot and
   clears pending.
5. `+layout.svelte` calls `flushIfEnabled()` once on mount and on every
   `online` event so transient offline edits drain when the network
   returns.

## Cloud Function — `fireSchedules`

`functions/src/index.ts`. Runs `every 1 minutes` in `Asia/Seoul`.

- Query: `collectionGroup('schedule').where('fireAt' ∈ [now, now+2min)).where('notified', '==', false)`.
- 2-minute window absorbs a single-minute scheduler skip without missing.
- Together with the line-hash id model, the narrow window also guards
  against the "label-only edit close to fire-time" duplicate scenario:
  a new id only fires if `now` is still inside its `[fireAt, fireAt+2min)`
  slice, which the original (already-notified) id has already left.
- For each match: load all `users/{uid}/devices/*` tokens, send via
  `messaging.sendEachForMulticast`, then mark `notified=true`.
- Notification payload: `title="일정"`, `body="HH:MM label"` (KST) for
  time-bearing items, `body=label` for date-only.
- Click target: `webpush.fcmOptions.link = /note/{scheduleNoteGuid}?from=notes`
  (also propagated as `data.scheduleNoteGuid` for the SW handler).

## Service worker

`app/src/service-worker.ts` initialises Firebase with
`import.meta.env.PUBLIC_FIREBASE_*` (Vite inlines at build) and registers
`onBackgroundMessage` (explicit `showNotification` call so iOS WebKit
displays consistently) plus `notificationclick` (focuses an existing
window when present and navigates to the schedule note).

## Firestore layout

```
users/{uid}/
  devices/{installId}     { token, platform, scheduleNoteGuid, updatedAt }
  schedule/{itemId}       { fireAt, eventAt, label, hasTime,
                            year, month, day, notified, createdAt }
```

`uid` comes from Anonymous Auth (created on first `enableNotifications`).
`installId` is a per-install UUID stored in `appSettings`. Security rules
restrict reads/writes to the matching authenticated uid; the Function
uses Admin SDK and bypasses rules.

## File map

| File | Purpose |
|------|---------|
| `lib/schedule/parseSchedule.ts` | TipTap doc → ParsedScheduleEntry[]; `parseKoreanTime`, `parseDayLine`, month section walker |
| `lib/schedule/buildScheduleItem.ts` | Entry → ScheduleItem (eventAt, fireAt, hashed id) |
| `lib/schedule/diff.ts` | `diffSchedules(prev, curr)` — set diff by id |
| `lib/schedule/scheduleSnapshot.ts` | per-noteGuid snapshot in `appSettings` |
| `lib/schedule/schedulePending.ts` | single-slot pending state |
| `lib/schedule/syncSchedule.ts` | parse + diff + write pending; invoked from noteManager |
| `lib/schedule/firebase.ts` | lazy app/auth/firestore/messaging singletons |
| `lib/schedule/firestoreScheduleClient.ts` | real `ScheduleRemoteClient` impl |
| `lib/schedule/scheduleClient.ts` | adapter interface (let tests inject fakes) |
| `lib/schedule/flushPendingSchedule.ts` | apply pending diff via client → promote snapshot |
| `lib/schedule/flushScheduler.ts` | gated wrapper (only flushes when notifications enabled) + `online` listener |
| `lib/schedule/notification.ts` | `enableNotifications`, `disableNotifications`, foreground subscription |
| `lib/schedule/installId.ts` | per-install UUID in `appSettings` |
| `lib/core/schedule.ts` | `getScheduleNoteGuid` / `setScheduleNote` (mirrors `home.ts`) |
| `routes/settings/+page.svelte` (notify tab) | UI: pick schedule note + enable/disable alerts |
| `service-worker.ts` | Firebase init + `onBackgroundMessage` + `notificationclick` |
| `functions/src/index.ts` | `fireSchedules` Cloud Function (every 1 min) |
| `firestore.rules` / `firestore.indexes.json` | security + collectionGroup index |

## Known limitations

- **Single-device assumption (v1)** — the schema supports multiple devices
  per uid (the Function multicasts to all), but the settings UI only ever
  registers the current device. To test multi-device, add a second device
  row directly in Firestore.
- **Single schedule-note assumption (v1)** — `core/schedule.ts` stores
  one guid. Extension would store an array; `syncScheduleFromNote` already
  early-returns for non-matching guids so adding more is local.
- **Label-only edit close to fire-time** — line-hash id means a label
  edit mints a new id. If the edit happens *during* the 2-minute firing
  window, theoretically the new id could fire too. Practically unlikely
  because the firing slice is `[fireAt, fireAt+2min)`; the old id has
  already been marked notified=true, and the new id's fireAt is identical
  so it falls in the same slice and would also be notified=false → could
  fire once more. Document, don't fix in v1.
- **Year boundary** — December content composed in November is not
  processed (only the current month section is). Acceptable per spec
  ("다음 달은 등록 안해도 됨").

## Testing

`app/tests/unit/schedule/` — 92 unit tests as of Phase 5, expanded with
adapter-level tests in Phase 7. Patterns:

- Pure parser tests (`parseKoreanTime.test.ts`, `parseDayLine.test.ts`,
  `extractCurrentMonth.test.ts`) — synchronous, no IDB.
- IDB-backed tests use `fake-indexeddb/auto` + `_resetDBForTest()` in
  `beforeEach`, mirroring `home.test.ts`.
- The flush pipeline tests inject a fake `ScheduleRemoteClient` rather
  than mocking Firebase — see `flushPendingSchedule.test.ts`.

The Cloud Function isn't unit-tested in the SvelteKit suite. Verify in
the emulator (`firebase emulators:start --only functions,firestore`) or
by deploying and observing `firebase functions:log`.

## Operational notes

- **Deploy commands** (run from repo root):
  - Rules + indexes: `firebase deploy --only firestore:rules,firestore:indexes`
  - Function: `firebase deploy --only functions` (needs Node 22)
- **Firebase project**: `tomboy-web` (region `asia-northeast3`).
- **VAPID public key**: stored as `PUBLIC_FIREBASE_VAPID_KEY` in
  `app/.env`. Rotation requires re-running `enableNotifications` on every
  device (the cached token in `appSettings.schedule.fcmToken` becomes
  invalid).
- **Anonymous Auth uid persistence** — Firebase persists the uid in
  IndexedDB under `firebase-auth`. Clearing site data orphans the
  Firestore docs under the old uid; users would re-enable from a fresh
  uid. Not worth fixing for single-user case; flag if multi-user.
