---
name: tomboy-dataautomation
description: Use when working on data-note automation — `자동화::<command-id>` notes that carry a `⟳ 실행` button which runs a registered host command on the desktop (through the Pi bridge) and refreshes the matching `DATA::<project>` chart note's CSV block, recording each run in the note's own log list. Covers the app pipeline (`lib/automation/` + `lib/editor/automationNote/`), the bridge `/automation/run` proxy, the desktop `automation-service` (registry/runner/server, dynamic per-request registry reload, systemd --user deploy), the `loc-history.py` LOC-per-commit script the default command runs, the Bearer auth chain, and the cross-window note-reload + DATA:: CSV-splice invariants.
---

# 데이터 노트 자동화 (data-note automation)

A **`자동화::<command-id>`** note carries a single `⟳ 실행` button. Pressing it
calls the Pi bridge, which proxies to the desktop **`automation-service`**, which
runs the registered host command(s) for that id and returns
`{ results: { project: csv }, errors: { project: msg } }`. The app then finds (or
creates) each **`DATA::<project>`** chart note and replaces its CSV code-fence
body with the returned CSV. Every run is appended to a log list inside the
automation note itself.

The automation note and the data note are **deliberately separate**: the
automation note is the trigger + run history; the `DATA::` notes are the data
sinks. One command id can fan out to many projects (the default `loc-history`
command refreshes 4 projects at once).

```
자동화::loc-history          ← title: prefix + command id (button anchors here)
- 2026-06-02 10:54 — tomboy, robotC, aGameOfYJ, chohee-web 갱신   ← run log (newest first)
- 2026-06-02 09:30 — DATA::chohee-web 생성, tomboy 갱신
```

The note's `.note` XML stores plain text (title + a bulletList) — Tomboy desktop
sees a normal note and Dropbox/Firebase sync are unchanged. The `⟳ 실행` button
is a **runtime widget decoration only**, never serialized.

## Data flow

```
[자동화:: note] ⟳ 실행
  → runAutomationButtonClick(view, commandId)
  → runAutomation({command})              app → POST {bridge}/automation/run  (Bearer = client token)
      → bridge handleAutomationRun         verify client token → POST {service}/run (Bearer = BRIDGE_SECRET)
          → automation-service /run         verify BRIDGE_SHARED_TOKEN → loadRegistry() → runEntries(spawn)
          ← { results:{proj:csv}, errors:{proj:msg} }
      ← (pipes upstream status/body verbatim)
  ← AutomationResult
  → for each results[project]: applyDataNoteCsv(project, csv)   find/create DATA::project, splice CSV block
  → appendRunHistory(view, "<stamp> — <summary>")               live view.dispatch into the log list
  → pushToast(summary)
```

## File map

### App — `app/src/lib/automation/` (backend-agnostic logic)
- `parseAutomationNote.ts` — `parseAutomationTitle(text)` (returns command id after
  `자동화::`, first whitespace-token, or null) and `parseAutomationNote(doc)` (looks at
  `doc.content[0]` title paragraph). The plugin and the orchestrator both go through
  `parseAutomationTitle` — single source of truth for "is this an automation note".
- `runAutomation.ts` — `runAutomation({command, signal})`: resolves bridge URL + token
  via `editor/terminal/bridgeSettings`, POSTs to `{bridgeToHttpBase(bridge)}/automation/run`.
  Throws `AutomationError` with a typed `kind` (`not_configured | unauthorized |
  service_unavailable | unknown_command | bad_request | upstream_error | network`).
  `STATUS_TO_KIND` maps 401/503; 400+`unknown_command` is special-cased.
- `findDataBlockRegion.ts` — `findDataBlockRegion(doc)` finds the first csv/tsv fence
  region (`{openIdx, closeIdx, format}`) by reusing `tableBlock/parseTable`'s
  `detectFenceFormat` + `isFenceClose`. Returns null if opened-but-never-closed.
  `csvToParagraphs(csv)` → one paragraph node per line (trailing `\n` stripped).
- `applyDataNoteCsv.ts` — `buildUpdatedDoc(doc, csv)` splices the new CSV into the first
  fence region, **or appends a fresh ```csv block right after the title** if none exists.
  `applyDataNoteCsv(project, csv)` finds `DATA::<project>` via `noteManager.findNoteByTitle`,
  **creates it (`createNote`) if missing** (returns `'created'` vs `'updated'`), saves via
  `updateNoteFromEditor`, then fires `emitNoteReload([guid])` + `desktopSession.reloadWindows([guid])`.
- `appendRunHistory.ts` — `appendRunHistory(view, entry, cap=50)`: live `view.dispatch`
  prepending a `listItem` to the first top-level `bulletList` (creates one under the title
  if absent), capped to 50 newest. Guards `view.isDestroyed`. Mirrors footnote `claudeFill`.

### App — `app/src/lib/editor/automationNote/` (editor wiring)
- `automationNotePlugin.ts` — `createAutomationNotePlugin()`: ProseMirror plugin that puts a
  `Decoration.widget` `⟳ 실행` button at `firstChild.nodeSize - 1` (just inside the title
  paragraph end, `side: 1`) when `parseAutomationTitle` matches. Rebuilds decorations on
  `docChanged`. Button click → `runAutomationButtonClick`, disabling itself + showing
  "⟳ 실행 중…" while running. Registered in `TomboyEditor.svelte` as extension
  `tomboyAutomationNote`, placed right after `tomboyChartBlock`.
- `runAutomationButtonClick.ts` — orchestration: `runAutomation` → per-project
  `applyDataNoteCsv` (tallies created/updated/failed) → `appendRunHistory` + `pushToast`.
  `nowStamp()` = local `yyyy-mm-dd HH:MM`. `KIND_MESSAGES` maps each error kind to a Korean
  toast. On a thrown `AutomationError` the failure is still logged to the note.

### Bridge — `bridge/src/automation.ts` (Pi proxy)
- `handleAutomationRun(req, res, secret, automationServiceUrl)`: 401 on bad client Bearer,
  503 `automation_service_not_configured` if URL empty, `readJson` (64KiB cap) → 400
  `missing_command`, then `fetch {url}/run` with **`Authorization: Bearer ${secret}`**
  (re-Bearer with `BRIDGE_SECRET`, NOT the client token — mirrors `/ocr`), 503
  `automation_service_unavailable` on network error, else pipes upstream status + body
  verbatim. Registered in `bridge/src/server.ts`: import (line ~19), `AUTOMATION_SERVICE_URL`
  env (line ~50), route `POST /automation/run` (line ~157).

### Desktop — `automation-service/` (host command runner, desktop-only)
- `src/registry.ts` — `parseRegistry`/`loadRegistry`/`lookupCommand`. Registry shape:
  `{ commands: { <id>: [{ project, exec: string[] }, …] } }`. `commands` must be an **object**
  (array rejected); each `exec` a non-empty `string[]`. `lookupCommand` uses `hasOwnProperty`.
- `src/runner.ts` — `runEntries(entries, opts)` runs each entry's `exec` via `spawn`
  **no shell** (`exec[0]` + args), sequentially, collecting `{results, errors}` per project.
  `runOne` enforces `timeoutMs` (default 30s → SIGTERM + destroy streams), `maxOutputBytes`
  (default 5MB → fail), bounds stderr to 8KB, `settled` guard against double-resolve. Default
  cwd = `$HOME`.
- `src/server.ts` — Fastify `POST /run`. Auth: `extractBearer` + `verifyToken(sharedToken)`
  → 401. Body `{command}` required → 400 `bad_request`. Registry resolved **per request**
  (see dynamic reload below) → 503 `registry_error` if the loader throws. `lookupCommand` →
  400 `unknown_command`. Then `runEntries` → 200 `{results, errors}`. `BuildServerOpts.registry`
  accepts `Registry | (() => Registry)`.
- `src/auth.ts` — byte-identical to `claude-service/src/auth.ts` (`extractBearer` +
  constant-time `verifyToken`).
- `deploy/automation-service.service` + `deploy/README.md` — systemd --user unit + setup.
- `tests/*.test.ts` — vitest. `server.test.ts` covers 401/400/unknown/200 + the two
  dynamic-reload tests (loader returns different Registry between requests; 503 when loader throws).

### Default command script — `~/loc-history.py` (NOT in repo; home folder)
LOC-per-commit-day counter. Positional project-dir arg; walks the target branch
(`main`→`master`→`HEAD` auto-detect), picks each day's (or `--by week`'s) last commit,
counts source LOC by extension over **git-tracked files only** (so `.gitignore` is respected),
`--exclude <path>` to drop tracked-but-unwanted paths, `--ext` to override the source set.
`--csv-only` emits bare CSV (no fence/header) — that's what the registry uses so
`applyDataNoteCsv` can splice it straight in. The repo keeps a copy at `scripts/loc-history.py`.

## Local commands (browser-side, NO bridge)

Some commands compute their CSV entirely in the browser against the local IndexedDB —
no Pi bridge, no desktop service, no registry. `runAutomationButtonClick` checks
`getLocalCommand(commandId)` **first**; only ids absent from that registry fall through to
`runAutomation` (the bridge). A local handler returns the same `{results, errors}` shape as the
bridge (so the `applyDataNoteCsv` splice path is reused verbatim) **plus** `charts: ChartNoteOptions[]`
— chart notes to ensure exist.

- `app/src/lib/automation/localCommands.ts` — registry `{ id → () => Promise<LocalCommandResult> }`
  + `getLocalCommand(id)`. Currently one entry: **`note-count`**.
- `app/src/lib/automation/noteCount.ts` — pure `computeNoteCountCsv(notes, now)`: buckets the
  current note set by **creation week (ISO `GGGG-Www`, Mon-start)** and emits a **cumulative**
  running total per category. Categories = notebooks `[0] Slip-Box` + every `[1]…` notebook,
  Slip-Box column first then `[1]…` sorted, each its own column (new `[1]…` notebook → new column
  next run). Commas in category labels are folded to spaces (CSV is bare `split(',')`). Deleted +
  template notes already excluded by `getAllNotes()`.
- `app/src/lib/automation/buildChartNote.ts` — `buildChartNoteDoc(opts)`: authors a chart note doc
  (title line + `[x] Chart:<type> <title>` header + config bulletList: `DATA::…`, `x:<col>`,
  optional `[x]곡선`). **`y:` omitted on purpose** so `transformData` auto-includes every numeric
  column — the chart never needs a structural rewrite when a category column appears. `[x]` is
  written as literal text; the save→reload pipeline converts it to the inlineCheckbox atom (same
  round-trip as a hand-typed chart header — see inlineCheckbox gotcha).
- `app/src/lib/automation/applyChartNote.ts` — `applyChartNote(opts)`: **create-if-missing only**
  (`'created'` vs `'exists'`); never clobbers an existing chart note (user may have tweaked it, and
  the chart reads the DATA:: note live anyway). Same dual-channel reload as `applyDataNoteCsv`.

`note-count` → DATA note `DATA::note-count`, chart note `노트 수 추이` (line chart). The user just
creates a `자동화::note-count` note and presses ⟳ — nothing to deploy.

## DATA:: chart note (the data sink — pre-existing)

`DATA::<project>` notes render their first csv/tsv code-fence as a Chart.js chart via the
**existing** `app/src/lib/editor/chartBlock/` plugin (`chartBlockPlugin`, `findChartRegions`)
+ `lib/chart/chartSpec.ts`. Automation only **writes** the CSV body; rendering is unchanged.
The fence detection that automation reuses (`tableBlock/parseTable`) is the same machinery
chart/table blocks use — keep CSV/TSV fence parsing consistent across all three.

## Invariants

- **Local commands take precedence over the bridge.** `runAutomationButtonClick` resolves
  `getLocalCommand(commandId)` first; a hit runs in-browser (no bridge/registry), a miss falls
  through to `runAutomation`. So a registry command must never reuse a local id (e.g. `note-count`).
- **Chart notes are create-if-missing, never clobbered.** `applyChartNote` only writes a new note
  when absent; an existing chart note is left as-is (it reads the DATA:: note live, and the user may
  have customized it). DATA:: notes, by contrast, are rewritten every run.
- **Note header is the only config in the note.** The automation note carries just the
  command id (`자동화::<id>`). All paths/args/exclusions live in the desktop registry file —
  the note never transmits a path or shell string. Adding a project = edit the registry, not
  the note.
- **Registry is read per `/run` request — no restart to edit.** `server.ts` resolves
  `() => loadRegistry(configPath)` on every request; boot does one fail-fast `loadRegistry`
  (refuses to start if totally unreadable). A malformed file mid-edit fails **only that
  request** with 503 `registry_error`; fix it and the next request works. Editing
  `~/.config/tomboy-automation.json` needs no `systemctl restart`.
- **`exec` runs with no shell.** `spawn(exec[0], exec.slice(1))`. No `sh -c`, no glob/var
  expansion. Absolute interpreter + script paths in the registry.
- **Auth chain = terminal/ocr chain.** client `terminalBridgeToken` → bridge
  `verifyToken(BRIDGE_SECRET)` → re-Bearer with `BRIDGE_SECRET` upstream →
  service `verifyToken(BRIDGE_SHARED_TOKEN)`, where `BRIDGE_SHARED_TOKEN === BRIDGE_SECRET`.
  The bridge **re-Bearers with the secret, not the client token**.
- **DATA:: note is created when absent** (user-decided; do NOT skip). `applyDataNoteCsv`
  returns `'created'` vs `'updated'` so the run log/toast can say which.
- **CSV splice replaces only the first fence body.** Everything outside the first csv/tsv
  fence (title, prose, other blocks) is preserved. No fence → a fresh ```csv block is inserted
  right after the title line.
- **Cross-window reload after every write.** `applyDataNoteCsv` fires both `emitNoteReload`
  (core bus — mobile + non-desktop editors) AND `desktopSession.reloadWindows` (desktop
  windows). Same dual-channel pattern as the rename cascade; without it an open editor's stale
  pendingDoc would clobber the fresh CSV on its next save.
- **Run history is live-dispatched, capped 50.** `appendRunHistory` writes through the open
  `EditorView` (like footnote `claudeFill`), prepending newest-first; it guards
  `view.isDestroyed`. Failures are logged too, not just successes.
- **automation-service is desktop-only.** Same machine as ocr/claude services. Never on the Pi
  bridge — it runs host `python3`/`git` against host git repos. Not containerized (host repo
  access), unlike the Quadlet bridge.

## Deploy

**Desktop `automation-service`** — systemd --user (NOT a container):
- unit `~/.config/systemd/user/automation-service.service`
  (`systemctl --user enable --now automation-service`, `loginctl enable-linger`)
- env `~/.config/automation-service.env` — `BRIDGE_SHARED_TOKEN` (= bridge `BRIDGE_SECRET`),
  `AUTOMATION_SERVICE_PORT=7843` (7842 claude / 8080 ocr are taken), `AUTOMATION_CONFIG`,
  `AUTOMATION_TIMEOUT_MS`, `AUTOMATION_MAX_OUTPUT_BYTES`. EnvironmentFile values are **literal**
  — no `%h`/`$HOME` expansion; omit `AUTOMATION_CONFIG` to default to `$HOME/.config/...`.
- registry `~/.config/tomboy-automation.json` — `loc-history` → 4 projects (tomboy=tomboy-web
  `--exclude graphify-out/`, robotC, aGameOfYJ, chohee-web), exec
  `/usr/bin/python3 ~/loc-history.py <repo> --csv-only ...`.
- Build: `cd automation-service && npm install && npm run build` → `dist/server.js`.

**Two non-obvious deploy traps** (see `automation-service-deploy` memory):
1. **node is fnm-managed** → no `/usr/bin/node`. The unit `ExecStart` must use the real path
   `/var/home/<you>/.local/share/fnm/node-versions/vXX/installation/bin/node`.
2. **`/home`→`/var/home` symlink** breaks `server.ts`'s entry guard
   (`import.meta.url === file://${process.argv[1]}`): node realpath-resolves `import.meta.url`
   but not `argv[1]`. Unit `WorkingDirectory` + `ExecStart` script path must use **canonical
   `/var/home/...`** or the service exits cleanly (status=0) without listening.

**Bridge** — add `AUTOMATION_SERVICE_URL=http://<desktop-LAN-IP>:7843` to the Pi's
`~/.config/term-bridge.env`. Bridge code ships via `cd bridge && npm run deploy` (Pi pulls
`origin/main` → podman build → Quadlet restart) — **commit must be on origin/main**. A
`deploy exit 1` from a Quadlet start-timeout race can be benign; confirm with
`systemctl --user status term-bridge` (`active (running)`).

Local desktop check:
`curl -XPOST localhost:7843/run -H "Authorization: Bearer <BRIDGE_SHARED_TOKEN>" -d '{"command":"loc-history"}'`
→ `{results:{project:csv}, errors:{}}`.

## Tests

- App: `cd app && npm run test` (vitest). Units mirror `lib/automation/` + `lib/editor/automationNote/`.
- automation-service: `cd automation-service && npm run test` (vitest) — registry/runner/server,
  incl. dynamic-reload + 503 cases.
- Bridge: `cd bridge && node --test` (NOT vitest); `mintToken(SECRET)` for the Bearer gate.
- No automated e2e — verify the full chain by pressing `⟳ 실행` in a real `자동화::` note.

## Guide card

User-facing guide: `설정 → 가이드 → 노트` sub-tab has the `자동화::` card
(`app/src/routes/settings/+page.svelte`, `guideSubTab: notes`). Any change to the note format,
button behavior, or backend prerequisites must update that card.

## Design + plan

`docs/superpowers/specs/2026-06-02-data-note-automation-design.md` (spec),
`docs/superpowers/plans/2026-06-02-data-note-automation.md` (+`.tasks.json`, 11 tasks, all done).
