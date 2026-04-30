---
name: tomboy-schedule
description: Use when working on schedule-note push notifications, the auto-weekday day-prefix helper, or the schedule-note "보내기" Ctrl-gate. Covers the parser format (Korean date/time list-item lines under a `N월` section), the multi-slot fire rules (07:00 morning ping for every entry; time-bearing entries additionally ping 1 hour before AND at the event time), the line-hash diff/upload pipeline, the Cloud Function firing window, FCM device registration, Dropbox-bridged Firebase Custom Auth, PWA-install requirements, the auto-weekday plugin, and the focus-scoped send-list-item gate. Files in `app/src/lib/schedule/`, `app/src/lib/editor/autoWeekday/`, `app/src/lib/editor/sendListItem/`, `app/src/service-worker.ts`, `functions/src/`, plus PWA infra (manifest + apple-touch-icon).
---

# 일정 알림 (schedule-note push notifications)

The user designates one note as the "schedule note". Its list items are
parsed every save; matching `(date, time, label)` triples are diff'd
against a stored snapshot, the delta is queued, and a Cloud Function
drains the queue and fires Web Push on a per-slot schedule. Every entry
expands into one or three notification slots: every entry pings at 07:00
on the event day; entries with a time additionally ping 1 hour before
AND exactly at the event time — three notifications per time-bearing
event, one for date-only. All devices that share a Dropbox account share
the same Firestore namespace, so editing the schedule on the desktop
notifies the iPhone and vice versa.

## Format

```
4월
  노트 열심히 만드는 달          ← ignored (no day prefix)
  15(금) 등산 7시                ← 3 pings: 07:00 / 18:00 / 19:00 (PM default)
  16(토) 빨래                    ← 1 ping: 07:00 on day 16
  16(토) 친구 만나기 6시 반 집앞 ← 3 pings: 07:00 / 17:30 / 18:30, label "친구 만나기 집앞"
  17(일) 쓰레기 버리기 7시 20분  ← 3 pings: 07:00 / 18:20 / 19:20, label "쓰레기 버리기"
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

Each parsed entry expands into one or three `ScheduleItem`s
(`buildScheduleItems(entry) → ScheduleItem[]`). Every item has a
`kind: 'morning' | 'pre1h' | 'at'` field that drives both the Firestore
doc id and the Cloud Function's notification body prefix.

- Date-only entry (no time) → 1 item:
  - `kind='morning'`: `eventAt = day at 00:00 local`, `fireAt = day at 07:00 local`.
- Time-bearing entry → 3 items, all sharing the same `eventAt`:
  - `kind='morning'`: `fireAt = day at 07:00 local`.
  - `kind='pre1h'`  : `fireAt = eventAt - 1 hour`.
  - `kind='at'`     : `fireAt = eventAt` exactly.
- KST (Asia/Seoul) is hardcoded for the current month-of-year arithmetic.

There is no de-duplication when slots collide on wall time (e.g. a 07:00
event would fire `morning` and `at` at the same minute, with `pre1h` at
06:00). The user explicitly opted into "always 3 pings for time-bearing
entries"; if collisions become annoying we can add a fireAt-based
collapse later.

## ID model — line hash, per slot, no "modified" operation

Each slot's id is
`fnv1a64( "${year}-${MM}-${DD}|${hh}:${mm}|${label}|${kind}" ).hex16chars`
(empty `hh:mm` segment for date-only entries, which only emit `morning`).
Any change to date, time, label, or slot kind mints a new id. Time
participates in **every** slot's hash — including `morning` — so two
same-day same-label entries with different times don't collide on the
morning row in Firestore. Edits are therefore modeled as
`{ removed: oldId, added: newId }` pairs — there is no "update" path
through Firestore. This keeps `flushPendingSchedule` trivially idempotent
on retry.

Backwards compatibility: pre-multi-slot Firestore docs have no `kind`
field. The Cloud Function falls back to the legacy `HH:MM label` body
when `kind` is missing. After a user re-saves the schedule note, the
diff naturally removes the legacy ids and uploads the new per-slot rows.

## Auth model — Dropbox account_id → Firebase Custom Token

**Critical**: Firebase auth is **NOT anonymous**. Every device signs into
Firebase using a custom token whose uid is `dbx-{sanitized account_id}`,
derived server-side from the user's Dropbox account. This way every
device sharing a Dropbox account lands on the same Firebase uid and
shares the `users/{uid}/schedule/*` namespace. The same uid is reused
by the realtime note-sync feature for `users/{uid}/notes/*` (see
`tomboy-notesync` skill); both features call the same `ensureSignedIn()`
in `lib/firebase/app.ts`.

Flow:
1. Client checks if a Dropbox access token exists (`dropboxClient.getAccessToken()`).
2. Client calls `dropboxAuthExchange` callable with the token.
3. Function verifies via `https://api.dropboxapi.com/2/users/get_current_account`,
   sanitises `account_id`, mints `createCustomToken('dbx-...', { provider: 'dropbox', dropboxAccountId })`.
4. Client `signInWithCustomToken(...)`.
5. `users/{uid}/devices/{installId}` and `users/{uid}/schedule/{itemId}` writes
   land under the shared uid.

If a leftover anonymous session exists from before the bridge, `ensureSignedIn`
force-signs-out and re-auths via Dropbox.

**Required Dropbox OAuth scopes**: `account_info.read` (added alongside the
existing files/sharing scopes). Without it, the token gets `missing_scope/`
when calling `users/get_current_account`. Existing users must revoke the app
at https://www.dropbox.com/account/connected_apps and re-authorize once.

**Required IAM role on Cloud Function service account**:
`507473101009-compute@developer.gserviceaccount.com` needs
`roles/iam.serviceAccountTokenCreator` (to call `createCustomToken`) AND
`roles/editor` or equivalents (`roles/datastore.user`,
`roles/cloudbuild.builds.builder`, `roles/artifactregistry.writer`,
`roles/storage.objectAdmin`) for Firestore + builds. Granting Editor is
the simplest way to cover both.

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
6. **Snapshot migration on uid change**: `enableNotifications` records the
   last seen Firebase uid (`schedule.lastFirebaseUid` in appSettings).
   If the new uid differs from the stored one, the current schedule
   note's snapshot is cleared so the next save re-uploads everything
   under the new uid. Used when migrating from anonymous to Dropbox
   custom auth.

## Cloud Function — `fireSchedules`

`functions/src/index.ts`. Runs `every 1 minutes` in `Asia/Seoul`.

- Query: `collectionGroup('schedule').where('fireAt' ∈ [now, now+2min)).where('notified', '==', false)`.
- 2-minute window absorbs a single-minute scheduler skip without missing.
- Together with the line-hash id model, the narrow window also guards
  against the "label-only edit close to fire-time" duplicate scenario.
- For each match: load all `users/{uid}/devices/*` tokens, send via
  `messaging.sendEachForMulticast` with `webpush.headers: { Urgency: 'high', TTL: '600' }`,
  then mark `notified=true`.
- Notification payload: `title="일정"`, `body="HH:MM label"` (KST) for
  time-bearing items, `body=label` for date-only.
- Click target: `webpush.fcmOptions.link = /note/{scheduleNoteGuid}?from=notes`
  (also propagated as `data.scheduleNoteGuid` for the SW handler).

## Cloud Function — `sendTestPush`

Callable. Sends an immediate FCM message to every registered device of
the calling user. Used by the settings-page "FCM 테스트 푸시" button to
verify the full round-trip independent of the scheduler. Returns
`{ tokenCount, successCount, failureCount, details, errors }` so the
client can surface delivery results.

## Cloud Function — `dropboxAuthExchange`

Unauthenticated callable. Takes `{ dropboxAccessToken }`, verifies via
Dropbox API, mints a Firebase custom token whose uid is
`dbx-{sanitized account_id}`. Returns `{ customToken, uid }`. Detects
`missing_scope` body and throws `failed-precondition: dropbox-scope-missing`
so the client surfaces "Dropbox 재연결 필요".

## Service worker — `app/src/service-worker.ts`

Initialises Firebase using `$env/static/public` imports (NOT
`import.meta.env`, which falls back to Vite defaults and produces
undefined values for `PUBLIC_*` vars in SW context).

`onBackgroundMessage` branches on `isIOSWebKit`:
- iOS Safari Web Push: OS auto-renders the `notification` payload before
  the SW handler runs, so the handler logs only — calling
  `showNotification` would duplicate.
- Other browsers (desktop Chrome/Firefox/macOS Safari): no auto-render.
  The handler must call `self.registration.showNotification` explicitly,
  using PNG icons (`/icons/icon-192.png` — SVG icons aren't reliably
  rendered in notifications on iOS).

`pushsubscriptionchange` listener logs a warning so developers know to
re-register the FCM token when iOS rotates the subscription.

`notificationclick` handler focuses an existing window when present and
navigates to the schedule note via `data.scheduleNoteGuid`.

`install` handler does NOT pre-cache assets. SvelteKit's default
`cache.addAll(ASSETS)` rejects on a single 404/timeout, blocking SW
activation indefinitely; we just `skipWaiting()` and let the `fetch`
handler cache lazily.

## PWA install requirements

iOS treats a home-screen entry as a real PWA (with persistent
ServiceWorker + push subscription) only when the install metadata is
correct. Without these, iOS falls back to "Safari bookmark" mode and
push subscriptions evaporate every time the PWA is restarted.

Required in `app/src/app.html`:
- `<link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png">` —
  **MUST be PNG**, NOT SVG. iOS doesn't accept SVG for apple-touch-icon.
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<link rel="manifest" href="/manifest.webmanifest">`

Required in `app/static/manifest.webmanifest`:
- `id`, `scope`, `start_url`, `display: standalone`.
- Icons array including 192x192 and 512x512 PNG (any + maskable purpose).
- SVG icon allowed as fallback.

PNG icons live in `app/static/icons/` (icon-180.png, icon-192.png,
icon-512.png). Generated from icon.svg via `magick -background none
icon.svg -resize NxN icon-N.png`.

## Firestore layout

```
users/{uid}/
  devices/{installId}     { token, platform, scheduleNoteGuid, updatedAt }
  schedule/{itemId}       { fireAt, eventAt, label, hasTime,
                            year, month, day, notified, createdAt }
```

`uid` = `dbx-{sanitized Dropbox account_id}` (from custom auth bridge).
`installId` = per-install UUID stored in `appSettings`. Security rules
restrict reads/writes to the matching authenticated uid; the Function
uses Admin SDK and bypasses rules.

## File map

| File | Purpose |
|------|---------|
| `lib/schedule/parseSchedule.ts` | TipTap doc → ParsedScheduleEntry[]; `parseKoreanTime`, `parseDayLine`, month section walker |
| `lib/schedule/buildScheduleItem.ts` | `buildScheduleItems(entry) → ScheduleItem[]` — expands one parsed entry into 1 (date-only) or 3 (time-bearing) per-slot items, each with eventAt, fireAt, kind, and a kind-aware hashed id |
| `lib/schedule/diff.ts` | `diffSchedules(prev, curr)` — set diff by id |
| `lib/schedule/scheduleSnapshot.ts` | per-noteGuid snapshot in `appSettings` |
| `lib/schedule/schedulePending.ts` | single-slot pending state |
| `lib/schedule/syncSchedule.ts` | parse + diff + write pending; invoked from noteManager |
| `lib/firebase/app.ts` | shared lazy app/auth/firestore/messaging singletons + Dropbox-bridged `ensureSignedIn`. Promoted out of `lib/schedule/` so the realtime note-sync feature can reuse the same Firebase identity (see `tomboy-notesync` skill). |
| `lib/schedule/firestoreScheduleClient.ts` | real `ScheduleRemoteClient` impl |
| `lib/schedule/scheduleClient.ts` | adapter interface (let tests inject fakes) |
| `lib/schedule/flushPendingSchedule.ts` | apply pending diff via client → promote snapshot |
| `lib/schedule/flushScheduler.ts` | gated wrapper (only flushes when notifications enabled) + `online` listener |
| `lib/schedule/notification.ts` | enableNotifications, forceResubscribe, sendTestPush, showLocalTestNotification, getNotificationDiagnostics, getPushSubscriptionDiagnostics |
| `lib/schedule/installId.ts` | per-install UUID in `appSettings` |
| `lib/schedule/autoWeekday.ts` | pure transforms: `getWeekdayChar`, `formatDayWithWeekday`, `transformDayPrefixLine`, `transformMultilineDayPrefix` |
| `lib/editor/autoWeekday/autoWeekdayPlugin.ts` | ProseMirror plugin: `appendTransaction` runs the pure transform on doc-change AND on `setMeta(autoWeekdayPluginKey, { rescan: true })` |
| `lib/editor/sendListItem/transferListItem.ts` | hardcoded `SEND_SOURCE_GUID` + `SEND_TARGET_GUID`; live-editor / IDB write path |
| `lib/editor/sendListItem/sendActiveGate.ts` | pure `shouldSendListBeActive` — gates the "보내기" button by source-guid + Ctrl + window focus |
| `lib/core/schedule.ts` | `getScheduleNoteGuid` / `setScheduleNote` (mirrors `home.ts`) |
| `lib/sync/dropboxClient.ts` | `getAccessToken()` exposed for the auth bridge |
| `routes/settings/+page.svelte` (notify tab) | Pick schedule note, enable/disable, push subscription diag, test buttons (local / FCM / Force 재구독), token copy |
| `service-worker.ts` | Firebase init via `$env/static/public` + iOS-branched onBackgroundMessage + notificationclick |
| `functions/src/index.ts` | fireSchedules + sendTestPush + dropboxAuthExchange |
| `firestore.rules` / `firestore.indexes.json` | uid-scoped security + (notified, fireAt) index |
| `app.html`, `static/manifest.webmanifest`, `static/icons/icon-{180,192,512}.png` | PWA install metadata for iOS |

## Settings UI structure (`/settings` → 알림 tab)

- "일정 노트" — note picker that drives `setScheduleNote(guid)`.
- "푸시 알림":
  - Permission/standalone/sw/api one-line diag.
  - "Push 구독 진단" details: hasSubscription, endpointHost (apple ✓ marker),
    VAPID prefix match. Manual `↻` refresh button.
  - State-specific buttons:
    - Inactive: "알림 활성화" with step progress (단계: 진단 → 권한 요청 →
      SW 준비 → FCM 초기화 → Firebase 로그인 → FCM 토큰 발급 → 구독 검증 →
      Firestore 디바이스 등록).
    - Active: "로컬 테스트 알림" / "FCM 테스트 푸시" / "Force 재구독" /
      "알림 끄기".
  - FCM token textarea (collapsed by default) for direct testing via
    Firebase Console → Cloud Messaging → "Send test message".

## Known limitations

- **One schedule note (v1)** — `core/schedule.ts` stores one guid.
  Extension would store an array; `syncScheduleFromNote` early-returns
  for non-matching guids so adding more is local.
- **Manual sync only** — Edits made on a device that does NOT have
  notifications enabled are written to Dropbox via the existing manual
  sync flow but NOT to Firestore. The current iPhone receives the new
  schedule when the user runs Dropbox sync, but `updateNoteFromEditor`
  is not called for sync-pulled notes, so Firestore stays stale until
  the iPhone (or any device with notifications enabled) re-saves the
  note. To fully cover this, a hook into `syncManager.applyIncomingRemoteNote`
  could call `syncScheduleFromNote` for the schedule guid — not
  implemented yet.
- **Label-only edit close to fire-time** — line-hash id means a label
  edit mints a new id. If the edit happens *during* the 2-minute firing
  window, the new id would also be eligible to fire. Documented; not
  fixed.
- **Year boundary** — December content composed in November is not
  processed (only the current month section is). Acceptable per spec.

## Auto-weekday day-prefix helper

When the user types in the schedule note (and ONLY there), the editor
auto-fills `(요일)` after a leading day number, and corrects malformed
existing weekday parens. This is purely an editor-side ergonomic
helper; it never touches Firestore directly. The note's normal
save → `syncScheduleFromNote` path still applies after the rewrite.

### Trigger paths

1. **Single-line typing** — user types `12<space>` on a fresh list-item
   line under a `N월` section → the appendTransaction rewrite produces
   `12(<요일>) `. Caret stays after the inserted parens.
2. **Multi-line paste / drop** — pasting multiple list items at once
   produces a single docChanged tr with all the new items; the plugin
   walks every list item under any month section and rewrites them in
   one coalesced tr.
3. **Scan-on-open** — when the editor's `isScheduleNote` prop flips
   `false → true` (because `getScheduleNoteGuid()` resolves async after
   the initial `setContent`), the editor dispatches
   `tr.setMeta(autoWeekdayPluginKey, { rescan: true })`. The plugin
   honours that meta even on non-docChanged transactions, so any
   pre-existing wrong content gets corrected on first paint. Same
   meta is fired after every subsequent `setContent` while
   `autoWeekdayEnabled === true` (covers note switching in
   `NoteWindow`, where the editor instance is reused across notes).

### Pure transform contract (`lib/schedule/autoWeekday.ts`)

`transformDayPrefixLine(input, year, month) → { changed, output }`:

- Auto-fills `D ` → `D(요일) ` when the bare number is followed by
  whitespace and the next char is not `(`.
- Corrects ANY content inside the parens — wrong char (`12(월)` when
  Apr 12 is actually 일), garbage (`12(?)`, `12(Wed)`, `12(수목)`),
  empty (`12()`), extra whitespace (`12( 수 )`).
- Collapses gap before parens: `12 (수) abc` → `12(<correct>) abc`.
- Leading zero: `04` → day 4. Three+ digits (`100`) don't match.
- Invalid days for the month (`31` in February) are LEFT UNCHANGED —
  not the helper's job to flag them.
- Idempotent. `transformMultilineDayPrefix` preserves `\n` / `\r\n`.

### Plugin contract

- `enabled: () => boolean` — closure-bound flag; the editor flips it
  via `$effect` on the `isScheduleNote` prop.
- `now: () => Date` — injected for test determinism.
- `appendTransaction` returns `null` when no rewrites needed (avoids
  infinite loops; the transform is idempotent over its own output).
- All rewrites coalesced into ONE transaction; positions handled in
  reverse order so prior replacements don't shift later ones.
- `autoWeekdayPluginKey` is exported so callers can `setMeta` for the
  rescan path.

### Wiring (per route)

| Route | Where `isScheduleNote` is computed |
|-------|------------------------------------|
| `/desktop/...` (NoteWindow) | `onMount` resolves `getScheduleNoteGuid()` and compares with `guid`; passes `isScheduleNote` to `<TomboyEditor>` |
| `/note/[id]` (mobile) | Same resolution inside the note-loading async block; passes `isScheduleNote` |

## "보내기" Ctrl gate

Independent of auto-weekday but co-resident in this skill because both
features hang off the same logical "schedule note". Each list item in
the source note (`SEND_SOURCE_GUID = 'd5ef5481-…'`) shows a floating
"보내기" button that transfers the item to `SEND_TARGET_GUID`. The
gate now requires:

```
guid === SEND_SOURCE_GUID
&& Ctrl held / mobile Ctrl-lock on
&& this window is the focused note window  (desktop only)
```

The pure helper `shouldSendListBeActive({ guid, sourceGuid, ctrlHeld,
focusedGuid, ignoreFocus })` lives at
`lib/editor/sendListItem/sendActiveGate.ts`. Mobile passes
`ignoreFocus: true` because the route is single-note-per-page —
there's no focus ambiguity. The mobile route also calls
`installModKeyListeners()` in `onMount` so the physical Ctrl key (on
desktop browsers viewing the mobile route) updates the shared
`modKeys` state; the same listeners power the Toolbar's Ctrl-lock
toggle.

## Testing

`app/tests/unit/schedule/` + `app/tests/unit/editor/` — 200+ unit
tests as of finalization (pre-existing schedule tests + 70+ new
auto-weekday / send-active gate tests).

- Pure parser tests (`parseKoreanTime`, `parseDayLine`,
  `extractCurrentMonth`) — synchronous, no IDB.
- Pure auto-weekday tests (`autoWeekday.test.ts`) — `Date` math only,
  no editor. Cover bare-fill, correction, idempotency, leap year,
  CRLF, leading zero, English/multi-char garbage, gap before parens.
- Plugin tests (`autoWeekdayPlugin.test.ts`) build a TipTap editor
  with the plugin attached and assert doc-text deltas. Cover paste,
  rescan-meta, year-boundary, mark dropping, nested listItems.
- Send-gate tests (`sendActiveGate.test.ts`) cover the pure boolean
  gate — desktop with focus, desktop without focus, mobile
  (`ignoreFocus`), missing source guid, Ctrl off.
- IDB-backed tests use `fake-indexeddb/auto` + `_resetDBForTest()` in
  `beforeEach`, mirroring `home.test.ts`.
- The flush pipeline tests inject a fake `ScheduleRemoteClient` rather
  than mocking Firebase — see `flushPendingSchedule.test.ts`.

Cloud Functions aren't unit-tested in the SvelteKit suite. Verify in
the emulator (`firebase emulators:start --only functions,firestore`) or
by deploying and observing `firebase functions:log`.

## Operational notes

- **Deploy commands** (run from repo root):
  - Rules + indexes: `firebase deploy --only firestore:rules,firestore:indexes`
  - Functions: `firebase deploy --only functions` (needs Node 22 — `fnm use 22`).
- **Firebase project**: `tomboy-web` (region `asia-northeast3`).
- **VAPID public key**: stored as `PUBLIC_FIREBASE_VAPID_KEY` in
  `app/.env` (and Vercel project env vars). Rotation requires re-running
  `enableNotifications` on every device — the cached token in
  `appSettings.schedule.fcmToken` becomes invalid.
- **IAM gotcha**: editing the compute SA's roles in Console can
  accidentally remove the default Editor role, breaking both Firestore
  access and function builds. Always *add* roles, never replace. If
  builds start failing with "missing permission on the build service
  account", re-grant Editor (or the granular set: cloudbuild.builds.builder,
  artifactregistry.writer, storage.objectAdmin, datastore.user) plus
  iam.serviceAccountTokenCreator.

## Adding a second schedule-enabled device (e.g. desktop)

1. On the new device, open the deployed site (PWA install on iOS, plain
   tab is fine on desktop).
2. Settings → 동기화 tab → connect to the same Dropbox account.
3. Settings → 알림 tab → pick the schedule note → "알림 활성화".
4. The Dropbox-bridged auth resolves to the same `dbx-{...}` uid as
   other devices, so the new device just adds a `users/{uid}/devices/{newInstallId}`
   row. Future schedule edits multicast to all devices.
