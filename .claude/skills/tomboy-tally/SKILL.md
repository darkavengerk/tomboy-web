---
name: tomboy-tally
description: Use when working on the 집계:: anonymous vote/quiz dedicated note — the parser (`집계::<제목>` title + paragraph-question/`|중복가능|정답:N` tokens + bulletList options), the client-side aggregation + per-voter quiz scoring, the top-level Firestore `polls/{noteGuid}` + `ballots/{voterUid}` model, the host-vs-guest TallyNote render branch, the bar-chart result dashboard, the `/poll/<제목>` kiosk share-link route (chromeless, auto-anonymous-guest, no nickname), the host share-URL copy bar + 결과 공개 toggle, and the solo/shared firestore.rules `polls` block. Files in `app/src/lib/tally/`, `app/src/lib/editor/tallyNote/`, `app/src/routes/poll/[title]/`, plus dispatch in note/[id] + NoteWindow + layout + welcome + registry + firestore.rules(.shared).
---

# 집계 (tally — anonymous vote/quiz dedicated note)

A `집계::<제목>` dedicated note carries one or more multiple-choice questions.
Anonymous visitors (no login) open the shared note, pick option(s), submit; one
ballot per browser. Results render as bar charts. By default only the **host**
(logged-in owner) sees results; a **결과 공개** toggle reveals them to everyone.
A `|정답:N` token turns a question into a **quiz** (per-voter scoring + 정답률,
correct option tinted green). `|중복가능` allows multi-select.

**Pure view layer over a regular note** — the `.note` XML is unchanged
(geoMap/chartBlock/noteBundle pattern). The note body is the source of truth for
the questions; only the *votes* live in a separate top-level Firestore
collection. Tomboy desktop and Dropbox/Firebase note sync see a normal paragraph
+ bullet list and never touch ballot data.

It **rides the existing notebook-sharing infra** — the poll note must live in a
**공유 노트북** with **공유 모드 규칙** active for guests to see it (reuses
`ensureGuestSignedIn` + anon Firebase + collectionGroup public-note read +
separate guest IDB). See `tomboy-notesync` for the sharing/guest machinery.

## File map

| File | Role |
|------|------|
| `lib/tally/parseTally.ts` | Pure parser. `isTallyTitle(title)` (`집계::` 접두), `tallyName(title)` (접두 뗀 제목), `parseTallyNote(jsonDoc, title): TallySpec`. JSON-based body walk (twin of `noteBundle/parser.ts:parseDedicatedBundle`). No IDB, no index. |
| `lib/tally/types.ts` | `TallyQuestion {index,text,options,allowMultiple,correctIndex}`, `TallySpec {title,questions}`, `Ballot {voterUid, answers:Record<qIndex,optIdx[]>}`, `PollMeta {ownerUid,resultsPublic}`, `QuestionResult {counts[],total,correctRate}`. |
| `lib/tally/aggregate.ts` | `aggregate(spec, ballots): QuestionResult[]` (counts/total/correctRate). `scoreBallot(spec, answers): {correct,scored}` (one voter's quiz score). Pure. |
| `lib/tally/tallyClient.ts` | Firestore wrappers: `currentUid`, `ensurePollMeta`(host), `setResultsPublic`(host), `subscribePollMeta`, `getMyBallot`, `castBallot`, `subscribeBallots`. |
| `lib/tally/index.ts` | Barrel. |
| `lib/editor/tallyNote/TallyNote.svelte` | Root view. Branch on `mode.value` (guest vote form / host dashboard). Share-URL copy bar + 결과 공개 toggle + host self-vote + `onraw` Ctrl-편집. |
| `lib/editor/tallyNote/TallyResultChart.svelte` | One bar chart per question via `lib/chart` `mountChart`/`destroyChart`; correct bar tinted green; full remount on count change; `ownerDocument`-safe teardown. |
| `routes/poll/[title]/+page.svelte` | **Kiosk share route** `/poll/<제목>`. Resolves 제목→note, guest bootstrap + public-gate + sync-wait poll, renders `<TallyNote>` in place (no chrome, no `onraw`). |
| `routes/poll/[title]/+page.ts` | `export const prerender = false` (dynamic route, mirrors `note/[id]`). |
| `routes/note/[id]/+page.svelte` + `lib/desktop/NoteWindow.svelte` | **Dedicated-note hosts** — branch on `isTallyTitle(note.title)`; render `TallyNote` `onraw={()=>showRawTally=true}` when `!showRawTally`; else normal editor + Ctrl-gated `↩` back. Reset `showRawTally=false` on note change. |
| `routes/+layout.svelte` | `/poll/` → `isChromeless` (no TopNav). Visitor on `/poll` auto-boots anonymous guest (`setGuestName('익명')` + full reload). |
| `routes/welcome/+page.svelte` | `safeNext()` same-origin `?next=` redirect (poll deep-link fallback when localStorage unavailable). |
| `lib/noteTypes/registry.ts` | `tally` entry in `NOTE_TYPES` (note-creation picker, `titlePrefix: '집계::'`). |
| `firestore.rules` + `firestore.rules.shared` | `polls` block (see rules section). |
| `routes/settings/+page.svelte` (가이드 → notes 탭) | "집계 노트" guide card. |
| `tests/unit/tally/{parseTally,aggregate}.test.ts` | 18 tests. No Svelte component tests (repo has none). |

## Note format & parser (`parseTally.ts`)

Title signature `집계::<제목>`. Body = questions. **One question = a paragraph
(or heading) immediately followed by a bulletList/orderedList of options.** A
paragraph with no list following it is ignored (no options = not a question).

```
집계::맛 투표          ← title (block 0, never a question)
점심 뭐?               ← question paragraph
• 김밥                 ← options (bulletList)
• 라면
좋아하는 색? |중복가능   ← multi-select question
• 빨강
• 파랑
3+4? |정답:2           ← quiz question (정답 = 2nd option, 1-based)
• 6
• 7
```

- **Settings tokens** split the question paragraph on `|`: `seg[0]` = question
  text (trimmed); `중복가능` → `allowMultiple`; `정답:N` (1-based) → `correctIndex
  = N-1`. Regex `^정답\s*:\s*(\d+)$`.
- **`correctIndex` is clamped at parse time** — out-of-range (`< 0` or `>=
  options.length`) → `null` (treated as a plain vote, not a quiz).
- **Options** = each list item's first textblock text, trimmed; empty items
  dropped.
- **Block 0 (title line) is never a question.** `bodyBlocks` slices it off.
- **`question.index`** = ordinal among parsed questions (0-based) — this is the
  **ballot answer key**. ⚠️ Reordering/inserting/deleting questions after voting
  starts misaligns existing ballots.

## Firestore data model (top-level `polls`, outside `users/**`)

```
polls/{noteGuid}                      meta — host-written
  { ownerUid, resultsPublic, updatedAt }
polls/{noteGuid}/ballots/{voterUid}   one per voter, immutable
  { answers: { [qIndex]: optIdx[] }, at }
```

- **`noteGuid`** = the poll note's guid (rename-safe — guids are UUID-stable, so
  renaming the note or its 제목 doesn't orphan votes). Guest derives the path from
  the note id it already synced — no host-uid lookup.
- **`voterUid`** = current Firebase uid (guest = anon, host = Dropbox-bridged).
  One ballot doc per uid, all questions answered at once, then locked → "1인 1표".
- **`correctIndex` is NOT stored** — parsed from note text client-side for
  scoring. (This is also why the quiz answer can leak — see limitations.)

`currentUid()` only calls `ensureGuestSignedIn` when `mode.value === 'guest'` —
calling it as host would **log the host session out** (anon sign-in replaces the
current user). `install.ts` already signs in both host and guest at startup, so
`currentUser` is usually present.

## TallyNote render branch (`TallyNote.svelte`)

Props `{ spec, guid, onraw? }`. `onraw` present → host context (note page /
NoteWindow, Ctrl→편집 toggle). `onraw` absent → kiosk (`/poll`).

**Guest** (`mode.value==='guest'`):
- Not voted → vote form (`{#snippet voteForm()}`): radio (single) / checkbox
  (`중복가능`) per question; 투표 제출 disabled until `allAnswered`.
- Voted → "✓ 제출 완료" + quiz score (if any) + per-question review (my pick ●/○,
  correct tinted, wrong red) + bar charts **only if `resultsPublic`** (else
  "결과는 비공개입니다").
- Ballots subscribed **only when `resultsPublic`** (otherwise rule denies read →
  empty array).

**Host** (`onraw` + not guest):
- **Share-URL row** — `${origin}/poll/${encodeURIComponent(spec.title)}` (note
  **title**, not uid) + 복사 button (`navigator.clipboard`, silent fallback to
  manual select on permission/insecure-context denial).
- **결과 공개** checkbox → `setResultsPublic`.
- **나도 투표** — host can vote too (same `voteForm` snippet); after voting shows
  own score.
- **결과** dashboard — per-question bar chart + 응답 N명 + 정답률 (quiz).
- `ensurePollMeta` runs **before** `subscribeBallots` (the ballot read rule's
  `get(meta)` fails if meta is absent → listener dies → no results). The host
  effect chains `ensurePollMeta().finally(subscribe)`.

`getMyBallot` runs for **both** host and guest (host self-vote).

## `/poll/<제목>` kiosk route

The shareable link. Unspecified-many visitors → show **only the vote**, no app
chrome, no nickname.

- **Chromeless** — layout adds `/poll/` to `isChromeless` (TopNav suppressed).
  Renders `TallyNote` **in place** (NOT a redirect to `/note`), **without
  `onraw`** → no title edit, no menu, no raw toggle.
- **No nickname** — a visitor hitting `/poll` is auto-booted as an **anonymous
  guest** in `+layout.svelte`: `setGuestName('익명')` + **full reload** (the reload
  is required — `installRealNoteSync` is `installed`-gated and reads mode at call
  time, so a soft `goto` wouldn't wire guest adapters). Vote identity is the anon
  Firebase uid, so no display name is needed. **localStorage unavailable** (시크릿
  등) → `setGuestName` no-ops → fall back to `/welcome?next=` (avoids reload loop).
- **Title→note resolution** (`resolve`): exact `findNoteByTitle('집계::'+name)`
  first, then scan `getAllNotes` by `tallyName`. SvelteKit already decodes
  `page.params.title` — **do not double-decode**.
- **Guest sync wait** — first public sync can lag, so poll `resolve` 20×400ms
  (≈8s) until the note appears in guest IDB AND `isPublic` (notebook ∈ cached
  `publicConfig.sharedNotebooks`). On guest, bootstrap `ensureGuestSignedIn` +
  `discoverPublicConfigForGuest` before the wait loop.

**Two entry points, intentionally separate:** `/note/<id>` (host, full chrome,
edit/manage) vs `/poll/<제목>` (anyone, kiosk, vote only).

## Firestore rules (`polls` block — both files)

In **`firestore.rules`** (solo): meta read=any-auth, create/update/delete=owner;
ballots create=self, **update/delete=false (immutable)**, read=voter|owner|
`resultsPublic==true`. This block is **load-bearing in solo** — `polls` is
top-level so the `users/{uid}/**` rules never reach it; without it the host can't
write meta or read ballots.

In **`firestore.rules.shared`**: the **same block** exists, but the blanket
`match /{document=**}` catch-all **OR-supersedes** it. So while guests actually
vote (shared mode active), **1인 1표 and results-privacy are client-soft only** —
consistent with shared mode already opening the whole host namespace to guests.
**Do not narrow the catch-all** — it would break the collectionGroup public-note
query (the rules file warns about this).

## Known limitations (also in 설정 guide)

1. **1인 1표 = browser-unit** (anon uid). Clearing storage / new device = revote.
2. **Shared-mode privacy is soft** — while guests vote, the catch-all means
   ballots/results aren't server-private. Casual use.
3. **Quiz answer leak** — `|정답:N` is plain note text guests sync into IDB; a
   technical guest can extract it. Casual quizzes only. (UI never *shows* the
   answer pre-submit.)
4. **Don't edit questions after voting starts** — ballots key on question ordinal
   (`question.index`); reorder/insert/delete misaligns counts.

## Gotchas

- **JSON object keys are strings** — `aggregate`/`scoreBallot` read
  `answers[q.index]` relying on JS number→string coercion (Firestore stores
  `answers` keys as strings).
- **Kiosk render height** — `TallyNote` `.tally-root` is `height:100%;
  overflow-y:auto`; the chromeless flex container (`.poll-kiosk`) feeds it
  `flex:1; min-height:0`. Verify visually after layout changes.
- **Chart teardown flake** — `TallyResultChart` destroys via container
  `ownerDocument` to dodge the known post-teardown `document is not defined`
  flake (see memory `project_flaky_ocr_test_teardown`). Keep that pattern.

## Tests & verification

- `cd app && npm run test` — 18 tally tests (`tests/unit/tally/`).
- `npm run check` — clean except pre-existing `firebase/app.ts:80`.
- Manual e2e: create `집계::테스트` (one `|정답:N`, one `|중복가능`) → add to a
  shared notebook → swap Firebase console to `firestore.rules.shared` → open
  `/poll/테스트` in a second browser/incognito (auto-anon guest, no nickname) →
  vote → host note shows live bars + 정답률 + 투표자 수; toggle 결과 공개 → guest
  sees results.
