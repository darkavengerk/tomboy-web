---
name: tomboy-diary
description: Use when working on the reMarkable diary OCR pipeline (pipeline/) — rM tablet → Raspberry Pi inbox → desktop OCR (Qwen2.5-VL-7B local) → Firestore notes in the Tomboy app. Covers the 3-machine flow, the per-page flat-inbox contract, the rM-side push script (busybox+dropbear quirks, Diary folder vs notebook layout, synthesized per-page metadata), the Pi-side watcher + systemd timer, the desktop stages s1_fetch / s2_prepare (rmscene-based renderer) / s3_ocr (Qwen2.5-VL + 4-bit nf4 quantization on RTX 3080) / s4_write (Firestore + Dropbox image upload), the Cloud-Function-bytecompatible uid sanitize contract, the `<link:url>` mark wrapping for clickable image links, and the operational gotchas that ate hours during M1–M3 bring-up. Files in `pipeline/` plus the app-side `NoteXmlViewer` debug helper.
---

# 리마커블 일기 OCR 파이프라인 (pipeline/)

A 3-machine pipeline that ingests handwritten diary pages drawn on the
reMarkable tablet and produces Tomboy notes with OCR text + an image
link. Design doc:
`docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`.
Implementation plan:
`docs/superpowers/plans/2026-05-10-remarkable-diary-pipeline.md`. Both
predate live bring-up — this skill captures what M1–M3 bring-up
actually exposed.

## 1. Architecture (3 machines)

```
┌─────────────────┐ rsync push  ┌──────────────────┐ rsync pull  ┌──────────────────────┐
│ reMarkable      │ ──────────► │ Raspberry Pi     │ ──────────► │ Desktop (Bazzite,    │
│ - "Diary" folder│  (WAN SSH,  │ ~/diary/inbox/   │  (manual)   │ RTX 3080)            │
│ - DocumentType  │   port 2222)│ + state/index    │             │ s1→s2→s3→s4          │
│   children      │             │ + inbox_watcher  │             │                      │
│ - systemd timer │             │ + systemd timer  │             │ rmscene→PNG→Qwen2.5- │
│ (5 min)         │             │ (5 min)          │             │ VL-7B (4bit nf4)→    │
│                 │             │                  │             │ Firestore + Dropbox  │
└─────────────────┘             └──────────────────┘             └──────────┬───────────┘
                                                                            │
                                          ┌─────────────────────────────────┴────────┐
                                          ▼                                          ▼
                              ┌────────────────────────┐                ┌────────────────────────┐
                              │ Firestore              │                │ Dropbox                │
                              │ users/{uid}/notes/     │                │ /Apps/Tomboy/          │
                              │   {tomboy-guid}        │                │   diary-images/        │
                              │                        │                │   {YYYY}/{MM}/{DD}/    │
                              │ → web app picks up via │                │   {rm-page-uuid}/      │
                              │ realtime-note-sync     │                │   page.png             │
                              └────────────────────────┘                └────────────────────────┘
```

- **reMarkable tablet** — writes; pushes new pages to the Pi via SSH+rsync (synthesizes per-page `<page-uuid>.metadata` since rM has no per-page metadata natively).
- **Raspberry Pi (24/7)** — receives flat `<page-uuid>.{rm,metadata}` files; inbox_watcher.py keeps `~/diary/state/index.json` up to date so the desktop fetcher can pull only what's new.
- **Desktop (Bazzite + RTX 3080)** — pulls from Pi → renders `.rm` to PNG with rmscene+Pillow → OCRs with local Qwen2.5-VL-7B (4-bit) → uploads PNG to Dropbox → writes Tomboy note to Firestore.

## 2. Operational invariants

The bring-up surfaced contracts that aren't obvious from reading any single file.
Violating any of these breaks the pipeline silently — the symptom is "0 pages
X'd" at the stage where the contract is read.

### I1. Page UUID is the universal key

- Each rM PAGE (`.rm` file) is one OCR unit, one Tomboy note. NOT the notebook.
- The rM page UUID flows end-to-end: file name on rM (`<uuid>.rm`), Pi inbox key, `raw/<uuid>/` on desktop, mapping key in `state/mappings.json`, marker in Tomboy note title (`[<uuid>]`).
- Title-embedded marker is the protection signal (spec I1) — user removes `[<uuid>]` from a corrected note's title → next re-OCR writes a NEW note instead of overwriting.

### I2. Pi inbox is flat per-page, not per-notebook

- Layout: `~/diary/inbox/<page-uuid>.rm` + `~/diary/inbox/<page-uuid>.metadata`.
- `inbox_watcher.py` globs `*.metadata` and uses the filename stem as the page uuid.
- `s4_write` reads only `metadata["lastModified"]` (ms since epoch) for Tomboy `createDate` / `changeDate`. Other metadata fields are ignored.
- The rM-side push script SYNTHESIZES per-page `.metadata` stubs from `.rm` file mtime (rM natively has only notebook-level `.metadata`).

### I3. rM "Diary" is a FOLDER (CollectionType) with DocumentType children

- The push script finds the folder by `visibleName == "Diary"` AND `type == "CollectionType"`. There can be (and typically are) multiple deleted/orphan `visibleName == "Diary"` notebooks scattered in the trash; the CollectionType+visibleName combo is what disambiguates.
- Direct children are DocumentType notebooks (one per month is the user's convention). The push script iterates these, filters out PDF-content notebooks (`.content` has `"fileType": "pdf"`), and stages every `.rm` inside each.

### I4. The Firebase uid sanitize MUST match the Cloud Function byte-for-byte

This burned an entire migration cycle. `pipeline/desktop/bootstrap.py:sanitize_account_id`:

```python
return re.sub(r"[^A-Za-z0-9_-]", "_", account_id)
# uid = f"dbx-{sanitized}"[:128]
```

Mirrors `functions/src/index.ts:280-281` exactly. **Do NOT strip the `dbid:` prefix.** **Do NOT use `-` as replacement char (the Cloud Function uses `_`).** **Do NOT skip the 128-char truncate.** If pipeline's uid ≠ what `dropboxAuthExchange` mints, the pipeline writes to one `users/{uid}/...` and the app reads from a different one → docs invisible.

### I5. The image URL must be wrapped in `<link:url>` at write time

- `TomboyUrlLink` (app/src/lib/editor/extensions/TomboyUrlLink.ts) has no input or paste rule. A plain URL loaded from xmlContent renders as unclickable text.
- The pipeline's payload builder emits `<link:url>{escaped url}</link:url>` so the URL is a clickable link in the rendered note.
- `&` in the Dropbox share URL's query string MUST be XML-escaped to `&amp;` inside the `<link:url>` element.

### I6. rmrl CANNOT render a single `.rm` file — use rmscene

- `rmrl.render(source)` requires a path that either is a `.zip` notebook bundle OR has a `<stem>.content` sibling (see `rmrl/sources.py:get_source`). The pipeline's per-page flat layout has neither.
- `s2_prepare.RmsceneRenderer` uses `rmscene.read_tree()` to parse `.rm` v6 → Pillow `ImageDraw.line` for each stroke → PNG. ~80 LOC, pure Python.
- **rM2 coordinate space**: x centered (~`[-702, +702]`), y **top-anchored** (~`[0, 1872]`). Translate only x by `+PAGE_WIDTH/2`; y is already top-down. Initially translating y too pushed handwriting off the bottom and left huge top whitespace.
- **Page height is NOT a hard ceiling.** rM users can scroll the page down and keep writing past y=1872. `RmsceneRenderer` runs a two-pass: first pass collects strokes + `max_y`; second pass allocates `canvas_h = max(PAGE_HEIGHT, int(max_y + BOTTOM_PADDING))`. Standard non-scrolled pages still render at exactly 1404×1872 (no regression). Scrolled pages get a tall PNG that the OCR backend then tile-slices (see I11).

### I7. rM userland is busybox + dropbear, not GNU/OpenSSH

Three concrete consequences hit during M1:

- `/usr/bin/ssh` is dropbear's `dbclient`. Most OpenSSH flags work (`-p`, `-i`, `-l`) but **`-o StrictHostKeyChecking=...` does NOT**. Use **`-y`** instead (accept new host keys, abort on mismatch).
- `head -1` is rejected. Always pass `head -n 1`.
- `ssh-keygen` is not installed and reinstalling on rM is fragile (rootfs is replaced on firmware updates). Generate the keypair on another machine (the Pi works) and `scp` it onto the rM.

### I8. `scp` and `ssh` have different port flags

- **`ssh -p PORT`** (lowercase). Used by direct ssh and by `rsync -e "ssh -p ..."`.
- **`scp -P PORT`** (UPPERCASE). Used by scp.
- `s1_fetch.SshRsyncTransport._ssh_args()` returns ssh-style args; a separate scp arg list (or, better, avoid scp entirely — see I9) uses `-P`.

### I9. Modern scp can't write to `/dev/stdout`

OpenSSH 9+ defaults scp to SFTP mode, which `ftruncate`+`lseek`s the destination → fails on `/dev/stdout` ("Invalid argument", "Illegal seek"). `s1_fetch.fetch_index` uses **`ssh ... cat <path>`** instead of `scp ... /dev/stdout`. Avoids both the I8 flag asymmetry and the SFTP limitation in one stroke.

### I10. rM systemd, not cron

The rM doesn't ship cron. Schedule the push via a systemd timer (`/etc/systemd/system/diary-push.timer`). Canonical unit files live in `/home/root/diary-push/` (survives firmware updates) and an `install.sh` re-installs them into `/etc/systemd/system/` after each rM firmware update (which wipes `/etc/`).

### I11. Tall (scrolled) pages must be tile-OCR'd, not single-shot

A scrolled rM page can produce a PNG taller than the Qwen2.5-VL processor's default `max_pixels` (~1.0 M) downsampling budget, and KV-cache for a much longer generation blows the 10 GB RTX 3080. `LocalVlmBackend._run_inference` calls `_split_to_tiles` first:

- Image height ≤ `TILE_THRESHOLD` (2400): pass-through (one tile). Standard 1404×1872 pages → no behavior change vs. M1–M3.
- Image height > `TILE_THRESHOLD`: slice into `TILE_HEIGHT` (1872)-tall tiles. Each cut is snapped to the longest blank row within ±`LINE_GAP_SEARCH` (240) of the target so a line of handwriting is never split. Falls back to the exact target row if no blank band exists in the window (graceful degradation — at worst one line is bisected, OCR'd as two partials).
- Each tile is fed to the existing single-image inference path; outputs are stripped per tile and joined with `\n`.

No overlap + no dedup — the line-gap snap is what prevents text being split, so concatenation is just `"\n".join(...)`. Don't reintroduce an overlap-with-dedup scheme without first measuring that the gap-snap approach actually misses lines.

`_ink_row_mask` does the scan in pure Pillow (`Image.tobytes()` + per-row `min()`) — no numpy dep added.

### I12. Admin status mirror lives at `users/{uid}/diary-pipeline-pages/{pageUuid}`

A small per-page mirror that lets `/admin/remarkable` show what the pipeline has processed without reaching the desktop filesystem. Schema (all optional except the four core fields):

```
{ pageUuid, tomboyGuid, imageUrl, writtenAt,
  imageWidth?, imageHeight?,     // height > 1872 = scroll-extended page
  ocrModel?, ocrCharCount?, ocrAt?,
  preparedAt?, lastModifiedMs?,
  rerunRequested?: bool, rerunRequestedAt?: ISO|null }
```

Write side: `s4_write` calls `PipelineStatusClient.set` after every successful Firestore note write, then `clear_rerun` to drop any pending flag. It also runs `backfill_status` at startup for any uuid in `written.json` that lacks a status doc — so the admin view is populated for pages OCR'd before this feature.

Read/rerun side: each stage's `main()` calls `fetch_pending_reruns(cfg, log)` and folds the returned UUIDs into its `force` set. The admin's "재처리 요청" button writes `rerunRequested: true`; the next manual `s2 → s3 → s4` run picks it up, and `s4` clears the flag on success.

Failures (no network, missing creds) are **best-effort silent** — pipeline progress trumps the optional admin mirror.

### I13. `metadata_change_date` must be bumped to `now()` on every Firestore write

The app's `conflictResolver.resolveNoteConflict` (`app/src/lib/sync/firebase/conflictResolver.ts`) compares `changeDate`, then `metadataChangeDate`, then falls through to **`tie-prefers-local`** which **PUSHES local content back over remote**. This is a deliberate safety for the user's in-progress edits, but it eats pipeline re-OCR writes:

1. First pipeline run: `changeDate = metadataChangeDate = rM mtime` + initial OCR → Firestore.
2. App pulls, local IDB now has same timestamps + initial OCR.
3. Re-OCR run with the long-page fix produces a longer/different OCR. Pipeline writes again — **but `lastModified` (rM file mtime) hasn't changed**, so `changeDate` and `metadataChangeDate` stay identical to the previous write.
4. App syncs → conflict resolver: both timestamps tie, `xmlContent` differs → `tie-prefers-local` → app pushes LOCAL (stale short OCR) BACK to Firestore. The pipeline's longer write is silently undone.

`s4_write.write_pending` therefore passes `metadata_change_date=datetime.now(timezone.utc)` on every call. `change_date` stays at the rM mtime so the diary date in the title and `changeDate`-based sort still reflect the actual writing date. Title generation in `tomboy_payload.build_payload` uses `change_date`, not the bumped `metadata_change_date`.

**Symptoms when this regresses:**
- Firestore has older xmlContent than `~/.local/share/tomboy-pipeline/ocr/<uuid>.json`.
- A specific note "doesn't sync" after a re-OCR while other (never-locally-opened) notes do.
- App-side hard refresh of the note doesn't help (the resolver runs identically every time).

**Recovery after a regression:**
1. Apply the `metadata_change_date=now()` fix.
2. `rm ~/.local/share/tomboy-pipeline/state/written.json` (so s4 re-resolves every uuid).
3. `python -m desktop.stages.s4_write` — re-publishes every doc with bumped `metadataChangeDate`.
4. User refreshes the app; resolver now picks remote (`metadataChangeDate` newer) and pulls the long OCR.

Do NOT instead change `changeDate` to `now()` — it would break the diary-date title and `changeDate`-based sort.

### I14. ocr-service shares the same RTX 3080 — must be fully stopped before diary OCR

After the May 2026 main-branch merge brought in the on-host `ocr-service` container (GOT-OCR2 for note OCR/translate), the diary pipeline started OOM'ing reliably on every re-OCR. Root cause: when ocr-service has its model loaded, it sits at ~5.5 GiB. The pipeline's `local_vlm` Qwen2.5-VL-7B (nf4) at ~5.9 GiB + KV-cache ~2 GiB + nvidia kernel reserve ~1 GiB just barely tips a 10 GB RTX 3080 over.

**`POST /unload` is not sufficient.** Even after `engine.unload()` empties the model from VRAM, the uvicorn Python process holds a ~300 MiB CUDA context (allocator, cuBLAS handles, etc.) until the process exits. That residual + chrome's GPU process (~200 MiB) is enough to push the diary load over the edge.

The fix is in `pipeline/desktop/deploy/desktop-pipeline.service`:
```
ExecStartPre=/bin/bash -c 'systemctl --user stop ocr-service.service 2>/dev/null || true'
ExecStartPost=/bin/bash -c 'systemctl --user start ocr-service.service 2>/dev/null || true'
```

`stop` releases the full CUDA context; `ExecStartPost` brings the container back so the user's note-OCR/translate features keep working during the ~3-minute window between diary runs. Both lines silent-fail so a machine without ocr-service installed is unaffected.

**Don't "simplify" back to a curl `/unload` call** — that path was tried and shipped, then immediately reverted when reruns kept OOM'ing.

Trade-off: while diary is running (typically ~6–8 min when there's work, ~30 s when idle), the bridge's `/ocr` / `/translate` proxy returns errors. The 5-min systemd timer means at most ~8 min downtime per cycle. If the churn ever bothers a user, guard the stop with a "do we have pending work?" precondition before adding complexity.

### I15. Diagnosing "OCR text feels truncated" — per-tile probe recipe

When a user reports a long page's OCR seems to cut off mid-content, the actual chain is:

1. **Verify the canvas captures all strokes**: `rmscene.read_tree(...)` + iterate Line items, compute `y_max`. Should equal `png_height - BOTTOM_PADDING`.
2. **Verify all tiles produced output**: pull tile count from `_split_to_tiles(image)`, then call `_infer_image(tile, prompt)` per tile in a probe script. Log per-tile `gen_tokens`, `chars`, and `hit_cap` (= `gen_ids[-1] != eos and gen_len >= max_new_tokens-1`). Hit cap is the only legitimate truncation signal.
3. **Verify Firestore has the long content**: `FirestoreClient.get_note(tomboy_guid)` and print `xmlContent` length. If it's shorter than `~/.local/share/tomboy-pipeline/ocr/<uuid>.json`, the user's device has push-clobbered remote per I13 — apply the recovery procedure there.
4. **Only after 1–3 are clean** is "model accuracy" the right answer (nf4 quantization loses ~10-15% recall on dense Korean handwriting).

The probe script lives in shell history of the May 15 2026 session, but the gist is: stop ocr-service, lazy-load model, walk tiles, decode per-tile, check eos. Don't write production code for this — it's a one-off diagnostic.

### I16. Desktop trigger service auto-runs the pipeline on rerun

`pipeline/desktop/trigger_server.py` is a small stdlib HTTP service the admin page POSTs to so the user doesn't have to manually re-run the pipeline after clicking "재처리 요청".

Endpoints:
- `GET  /health` (no auth) — readiness probe used by the admin to color the connection chip.
- `GET  /status` (Bearer) — current job snapshot: `{ running, jobId, startedAt, finishedAt, exitCode, stderrTail, stdoutTail }`.
- `POST /run` (Bearer) — fire-and-forget. Returns 202 immediately and runs `python -m desktop.run_pipeline` in a worker thread. Concurrent calls get 409 (`alreadyRunning: true`).

Auth: Bearer token from the `DIARY_TRIGGER_TOKEN` env var (preferred — kept out of `argv`) or `trigger.token` in `pipeline.yaml` as a fallback.

CORS: the admin (deployed PWA origin) calls a different origin (the user's desktop / their reverse proxy). The service responds to OPTIONS preflight and echoes the request origin in `Access-Control-Allow-Origin`. Security still rests on the Bearer token — `*` origin without credentials is fine because cookies aren't part of the flow.

Deployment: `pipeline/desktop/deploy/diary-trigger.service` (user systemd unit). Default bind is `127.0.0.1:8765` — front with Caddy / the existing terminal-bridge reverse proxy when exposing beyond loopback. The unit reads the token from `~/.config/diary-trigger.env` so it isn't visible in `systemctl status`.

Admin side wiring (`app/src/lib/storage/appSettings.ts` keys `diaryTriggerUrl` + `diaryTriggerToken`, called from `app/src/routes/admin/remarkable/+page.svelte`): when both are configured, clicking 재처리 요청 sets the Firestore flag AND POSTs to `<url>/run`. If unconfigured, the page falls back to the manual-run instructions (the Firestore-only path of I12 still works).

The trigger NEVER passes per-page UUIDs in the body — every stage drains the Firestore rerun queue at startup (I12), so a single trigger call processes everything that's pending. Don't add a per-uuid HTTP shape; it would duplicate the queue's role.

## 3. End-to-end workflow

### 3a. rM tablet (one-time setup)

```bash
# As root on the rM:
mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh
# On the Pi: ssh-keygen -t ed25519 -f /tmp/id_diary -N "" -C "rM diary"
# Then on the rM:
scp <pi-user>@<pi-lan-ip>:/tmp/id_diary      /home/root/.ssh/id_diary
scp <pi-user>@<pi-lan-ip>:/tmp/id_diary.pub  /home/root/.ssh/id_diary.pub
chmod 600 /home/root/.ssh/id_diary
```

Then on the Pi authorize the rM pubkey on `diary-sync` (`pipeline/pi/README.md` step 3f).

Install the push script + systemd timer: see `pipeline/pi/README.md` "rM-side push" sections 2–3. The push script:

1. Finds the Diary FOLDER (CollectionType, visibleName "Diary") under `/home/root/.local/share/remarkable/xochitl/*.metadata`.
2. Iterates DocumentType notebook children (skipping `fileType: "pdf"`).
3. For each `.rm` page, stages `<page-uuid>.rm` (preserving mtime via `cp -p`) and a synthesized `<page-uuid>.metadata` stub with `lastModified` (`.rm` mtime in ms).
4. rsyncs the staging dir flat to `diary-sync@<pi>:diary/inbox/`. `touch -r` on the staged `.metadata` so unchanged pages are rsync no-ops on subsequent runs.

The systemd timer fires every 5 min after a 2-minute boot delay.

### 3b. Raspberry Pi (one-time setup + 24/7 watcher)

`pipeline/pi/README.md` is the source of truth. Highlights:

- Dedicated `diary-sync` user (no password — locked, key-auth only).
- SSH hardening drop-in: `Port 2222`, `PasswordAuthentication no`, `PubkeyAuthentication yes`, `AllowUsers diary-sync <your-admin-user>`. `<your-admin-user>` is required — `AllowUsers` is a hard whitelist.
- fail2ban with the default sshd jail.
- Router port forwarding 2222→Pi:2222 once you're ready to expose to WAN.
- systemd timer runs `inbox_watcher.py` every 5 min — globs `~/diary/inbox/*.metadata`, updates `~/diary/state/index.json` with `{mtime, present, received_at}` keyed by page uuid.

### 3c. Desktop (manual stages)

Prereqs:

```bash
cd pipeline
.venv/bin/python -m pip install -e .[prepare,vlm,firebase,dropbox,dev]
# torchvision is in [vlm]; rmscene is in [prepare].
```

(`pipeline.yaml` must exist — `desktop/bootstrap.py` walks the user through
Dropbox PKCE + Firebase service account JSON and emits it.)

Run the 4 stages in order:

```bash
.venv/bin/python -m desktop.stages.s1_fetch              # Pi inbox → ~/.local/share/tomboy-pipeline/raw/<page-uuid>/
.venv/bin/python -m desktop.stages.s2_prepare            # .rm → png/<uuid>/page.png
.venv/bin/python -m desktop.stages.s3_ocr --uuid <UUID>  # Smoke-test one page first (model download is ~14 GB)
.venv/bin/python -m desktop.stages.s3_ocr                # Process the rest
.venv/bin/python -m desktop.stages.s4_write              # Firestore upsert + Dropbox image upload
```

Each stage is idempotent — re-running skips what's already in `state/<stage>.json`. To force a single page, use `--force <uuid>` (or `--uuid <uuid>` on s3 to filter to a single uuid).

Verifying inside the app: open any diary note → menu (⋯) → **원본 XML 보기** (`NoteXmlViewer.svelte`). Shows the raw `xmlContent` so you can confirm `<link:url>` wrapping, the title format, etc.

App-side **Firebase realtime note sync** must be enabled — **OFF by default**. 설정 → 동기화 설정 → "파이어베이스 실시간 노트 동기화". Without it, Firestore writes are invisible to the app.

## 4. Known pitfalls (bring-up lessons)

These cost meaningful time during M1–M3 and are easy to re-hit. All are
locked down by tests now (see "Tests" below) but the symptom→cause
mapping below is faster than re-deriving.

| Symptom | Root cause | Fix |
|---|---|---|
| s1 fails: `scp ... -p 2222 ... returned 1` | scp's port flag is `-P` (capital). `-p` means "preserve mtime"; `2222` got treated as a local source file. | Use `-P` for scp. Better: avoid scp entirely — `s1_fetch.fetch_index` uses `ssh ... cat <path>`. |
| s1 fails: `scp ... local ftruncate "/dev/stdout": Invalid argument` | OpenSSH 9+ scp uses SFTP mode which refuses non-regular destination files. | Use `ssh remote 'cat <path>'` instead of `scp ... /dev/stdout`. |
| s1 prompts for `diary-sync@... password:` | Desktop pubkey not in `~diary-sync/.ssh/authorized_keys` on Pi. The `diary-sync` account has no password (locked), so the prompt always fails. | From desktop: `scp -P 2222 ~/.ssh/id_ed25519_diary.pub <admin>@pi:/tmp/` then `ssh -t <admin>@pi 'sudo -u diary-sync tee -a /home/diary-sync/.ssh/authorized_keys < /tmp/...'`. |
| s2 fails: `Could not find a source file from '....rm'` | rmrl needs a notebook context (`.content` sibling or `.zip` bundle). Our flat per-page layout has neither. | s2 now uses `RmsceneRenderer` (rmscene + Pillow), which works on a bare `.rm`. rmrl is gone from `[prepare]`. |
| s2 produces PNGs with ~50% top whitespace and clipped bottom | rmscene's y axis is **top-anchored** (range ~`[0, 1872]`), not centered. We were translating y by `+ PAGE_HEIGHT/2`. | Translate **only x** by `+PAGE_WIDTH/2`; pass `p.y` through unchanged. |
| s3 prints `0 pages OCR'd` with `No module named 'transformers'` | `pip install -e .[vlm]` ran against the wrong Python (system pip, not the venv's). | `.venv/bin/python -m pip install -e .[vlm]` explicitly. |
| s3 fails: `Qwen2VLVideoProcessor requires the Torchvision library` | transformers 4.45+ eagerly imports torchvision via the video-processor stack even for image-only models. | `torchvision` is now in `[vlm]` deps. |
| s3 fails: `CUDA out of memory` (around 7–8 GB used on RTX 3080) | Default `BitsAndBytesConfig(load_in_4bit=True)` alone takes ~5.8 GiB; KV cache for 2048-token generation tips the 10 GB GPU over. | `bnb_4bit_quant_type="nf4"` + `bnb_4bit_use_double_quant=True` + `bnb_4bit_compute_dtype=torch.float16` saves ~1 GiB. Also set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` at module top of `local_vlm.py`. |
| s3 fails: `KeyError: "OCR backend not registered: 'local_vlm'"` | `desktop/ocr_backends/__init__.py` was empty → `local_vlm` module never imported → `@register_backend("local_vlm")` decorator never ran. | `__init__.py` now does `from . import local_vlm` to side-effect-register. |
| s3 fails: `Qwen2VLForConditionalGeneration` can't load the Qwen2.5-VL model | Class name mismatch — `Qwen2.5-VL` needs `Qwen2_5_VLForConditionalGeneration`, not the v2.0 class. | Use `AutoModelForImageTextToText` (transformers 4.45+); it inspects `config.json` and routes to the correct class. |
| s4 reports success but notes don't appear in the app | uid mismatch: `bootstrap.sanitize_account_id` produced `dbx-AADgRChv...` (`dbid:` stripped) while Cloud Function produces `dbx-dbid_AADgRChv...` (`:` → `_`). Two different `users/{uid}/...` namespaces. | `sanitize_account_id` now mirrors the Cloud Function exactly (preserve `dbid:`, replace `:` with `_`, truncate to 128 chars). Verify with the regression tests in `tests/test_bootstrap.py`. |
| Notes appear but the image URL is plain unclickable text | `TomboyUrlLink` extension has no input/paste rule, so plain URLs loaded from xmlContent never get the url-link mark. | Pipeline now emits `<link:url>{url}</link:url>` in the body. |
| The `---` separator does not render as a horizontal rule | The app's `noteContentArchiver.ts` has no `horizontalRule` case (neither parse nor serialize). The HR support was attempted in this session and reverted at user's request; user said "나중에 따로 고칠게". | Currently `---` is plain text. To add HR support cleanly: parser branch on `tagName === 'hr'` → `{type:'horizontalRule'}`; serializer branch on `node.type === 'horizontalRule'` → `<hr/>`; pipeline emits `<hr/>` instead of `---`. Tomboy desktop compatibility on round-trip is the open question. |
| s4 writes succeed but image URLs return 404 / no preview | Dropbox upload failed silently. | Check `~/.local/share/tomboy-pipeline/logs/s4_write.log` for `dropbox_upload_failed`. |
| Image URL is clickable but doesn't render inline / loads Dropbox HTML page | Dropbox SDK returns share links with `?dl=0` by default — that's the HTML preview, not raw bytes. | `dropbox_uploader._to_inline_url` rewrites `dl=0` → `raw=1`, preserving every other query param. `share_link` applies it to both the create-new and fall-back-to-existing paths. |
| OCR transcribes only the top portion of a long page (rest is missing) | Page was scrolled on the rM but `RmsceneRenderer` was hardcoded to a 1404×1872 canvas, clipping strokes with `y > 1872`. Even after extending the canvas, single-shot OCR on a tall image gets aggressively downsampled by Qwen2.5-VL's `max_pixels` ≈ 1.0 M. | Renderer now grows the canvas to `max(PAGE_HEIGHT, max_stroke_y + BOTTOM_PADDING)`; `LocalVlmBackend._split_to_tiles` slices the tall PNG along blank-row line gaps and OCRs each tile separately. To re-process pages OCR'd before this change, delete `state/{prepared,ocr-done,written}.json` for affected uuids (or pass `--force <uuid>` to each stage). `mappings.json` is kept so the same handwriting still maps to the same Tomboy note (per I1). |
| All re-OCR attempts fail with CUDA OOM after ocr-service deployed | Even with `engine.unload()` cleared the model, the ocr-service uvicorn process keeps a ~300 MiB CUDA context. Combined with chrome's GPU buffer and the nvidia kernel reserve, there's not enough headroom for Qwen2.5-VL-7B nf4 (~5.9 GiB) + KV-cache (~2 GiB) on the 10 GB RTX 3080. | `desktop-pipeline.service` now `systemctl --user stop`s ocr-service entirely in `ExecStartPre` and `ExecStartPost`-starts it again. Releases the full CUDA context (see I14). |
| Re-OCR succeeds in Firestore but the app still shows the old short content even after hard refresh | App-side `conflictResolver` hits `metadataChangeDate` tie (rM mtime is the same on both writes) → falls to `tie-prefers-local` → the user's device pushes its stale local content BACK over Firestore. | `s4_write` now sets `metadata_change_date=datetime.now(timezone.utc)` so the pipeline's write is strictly newer; the receiver pulls (see I13). After applying the fix, `rm state/written.json && python -m desktop.stages.s4_write` to re-publish every note with bumped timestamps. |

## 5. State files (desktop)

Under `~/.local/share/tomboy-pipeline/state/`:

| File | Written by | Keyed by | Purpose |
|---|---|---|---|
| `fetched.json` | s1_fetch | rm-page-uuid | Skip re-fetch of pages already in `raw/<uuid>/`. |
| `prepared.json` | s2_prepare | rm-page-uuid | Skip re-rasterize. Stores `png_path` + the per-page `.metadata` dict for downstream. |
| `ocr-done.json` | s3_ocr | rm-page-uuid | Skip re-OCR. Stores `model` + `ocr_at`. |
| `written.json` | s4_write | rm-page-uuid | Skip re-publish (Firestore upsert + Dropbox upload). |
| `mappings.json` | s4_write | rm-page-uuid | The page-uuid → tomboy-guid map that drives spec I1's overwrite-vs-new decision. Survives across re-OCRs so the same handwriting stays the same Tomboy note. |

To force a re-run of a stage: delete the relevant file or pass `--force <uuid>`. **`mappings.json` is sacred** — losing it means every existing note gets a new tomboy-guid on the next s4 run (duplicates in the app).

## 6. Quick map (files)

### reMarkable side (lives on rM, not in repo)

- `/home/root/diary-push.sh` — main push script (busybox sh).
- `/home/root/diary-push/diary-push.{service,timer}` — canonical systemd units.
- `/home/root/diary-push/install.sh` — copies units into `/etc/systemd/system/` and re-enables the timer; re-run after every rM firmware update.
- `/home/root/.ssh/id_diary{,.pub}` — keypair generated on the Pi.

### Raspberry Pi side

- `pipeline/pi/inbox_watcher.py` — globs `<inbox>/*.metadata`, maintains `state/index.json` (~/diary/state/index.json on the Pi).
- `pipeline/pi/deploy/pi-watcher.{service,timer}` — systemd units; installed under `/etc/systemd/system/` per `pipeline/pi/README.md` step 4.
- `pipeline/pi/README.md` — full setup recipe (SSH hardening, key flow, systemd, fail2ban, router NAT).

### Desktop side

- `pipeline/desktop/stages/`
  - `s1_fetch.py` — `SshRsyncTransport` uses `ssh ... cat` for the index + `rsync -e "ssh -p ..."` for pull. Pulls into `raw/<page-uuid>/`.
  - `s2_prepare.py` — `RmsceneRenderer` produces `png/<page-uuid>/page.png`. PAGE_WIDTH=1404, PAGE_HEIGHT=1872 (floor — canvas grows to `max_stroke_y + BOTTOM_PADDING=32` for scrolled pages), STROKE_WIDTH=2 + `_COLOR_MAP` for rM PenColor enum.
  - `s3_ocr.py` — drives `LocalVlmBackend`. Supports `--force <uuid>` and `--uuid <uuid>` (filter to specific page uuids for smoke tests).
  - `s4_write.py` — Firestore upsert + Dropbox image upload + mappings update per spec I1.
- `pipeline/desktop/ocr_backends/`
  - `base.py` — `OCRBackend` ABC + `@register_backend(name)` decorator + `get_backend(name)` registry.
  - `__init__.py` — `from . import local_vlm` to side-effect-register the built-in backend (the `s3_ocr` import path doesn't hit `local_vlm` directly).
  - `local_vlm.py` — Qwen2.5-VL-7B via `AutoModelForImageTextToText`. nf4 + double-quant + fp16 compute. `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set at module top. Auto-tiles tall scrolled pages via `_split_to_tiles` (TILE_THRESHOLD=2400, TILE_HEIGHT=1872, line-gap-snap with LINE_GAP_SEARCH=240); per-tile outputs joined with `\n`.
- `pipeline/desktop/lib/`
  - `tomboy_payload.py` — builds the Firestore document (per app's `FirestoreNotePayload` shape). Wraps image URL in `<link:url>` mark.
  - `firestore_client.py` — Firebase Admin SDK wrapper.
  - `dropbox_uploader.py` — PNG upload + share-link. `share_link()` rewrites Dropbox's default `?dl=0` (HTML preview page) to `?raw=1` (raw bytes) via `_to_inline_url`, so the URL works as an inline image source — without it, the URL only opens a Dropbox preview when clicked and is useless inside an `<img src>`.
  - `pipeline_status.py` — `PipelineStatusClient` (Firebase Admin SDK) for per-page status docs at `users/{uid}/diary-pipeline-pages/{pageUuid}` (see I12). `fetch_pending_reruns(cfg, log)` is the best-effort helper every stage's `main()` uses to fold admin-page rerun requests into its `force` set.
  - `state.py`, `log.py`, `config.py` — shared infrastructure.
- `pipeline/desktop/trigger_server.py` — stdlib HTTP trigger (see I16). Bearer-authed, CORS-enabled, fire-and-forget run of `desktop.run_pipeline`. Unit file at `pipeline/desktop/deploy/diary-trigger.service`.
- `pipeline/desktop/bootstrap.py` — `sanitize_account_id` MUST mirror `functions/src/index.ts:280-281` byte-for-byte. Tests in `tests/test_bootstrap.py` lock the contract.
- `pipeline/config/pipeline.yaml` — gitignored. Holds `firebase_uid`, service-account path, Dropbox refresh token, host details. `bootstrap.py` emits it.
- `pipeline/config/prompts/diary-ko.txt` — Qwen2.5-VL system prompt for Korean handwriting.

### App-side helpers added during bring-up

- `app/src/lib/editor/NoteXmlViewer.svelte` — modal that shows raw `xmlContent` for any note. Accessible from the **⋯** menu → "원본 XML 보기" on both mobile (`NoteActionSheet`) and desktop (`NoteContextMenu`). Critical for verifying what s4 actually wrote without firing up the Firestore console.
- `app/src/lib/admin/remarkablePipeline.ts` + `app/src/routes/admin/remarkable/+page.svelte` — the `/admin/remarkable` operator UI. Reads from `users/{uid}/diary-pipeline-pages`, writes the `rerunRequested` flag, and (when configured) POSTs to the desktop trigger server. Surfaces page UUID → tomboy GUID mapping, Dropbox image thumb, PNG dimensions, OCR char count + model, a "스크롤" badge for `imageHeight > 1872`, and a trigger panel with URL/token inputs + connection health + last-run status. Added to `admin/+layout.svelte` tabs as "리마커블".

## 7. Tests guarding the bring-up bugs

- `tests/test_bootstrap.py` — uid sanitize parity with Cloud Function (`dbid:` preserved, `_` replacement, 128-char truncate).
- `tests/stages/test_s1_fetch.py` — `SshRsyncTransport` argv structure: `ssh` not `scp` for the index, `-p` lowercase in rsync's `-e`, `cat` as the remote command.
- `tests/stages/test_s2_prepare.py` — `RmsceneRenderer` raises on missing `.rm`; renders strokes to a non-blank PNG; eraser strokes are filtered.
- `tests/stages/test_s3_ocr.py` — `only_uuids` filter (spec I2).
- `tests/ocr_backends/test_local_vlm.py` — `desktop.ocr_backends` package import alone registers the `local_vlm` backend.
- `tests/lib/test_tomboy_payload.py` — `<link:url>` wrapping; `&` inside the URL becomes `&amp;`.

Run subset: `pipeline/.venv/bin/python -m pytest tests/ -q`.

## 8. Recovery / re-runs

After any code change that affects the on-wire payload (e.g., adding the
`<link:url>` mark), delete the corresponding `state/<stage>.json` and
re-run that stage and downstream:

```bash
# Re-publish all 28 docs with new payload shape:
rm ~/.local/share/tomboy-pipeline/state/written.json
.venv/bin/python -m desktop.stages.s4_write
```

For uid migrations (rare — only if `bootstrap.sanitize_account_id`
changes): edit `firebase_uid` in `pipeline.yaml` to the corrected value,
delete `state/written.json`, re-run s4. The old docs at the wrong uid
path become orphans in Firestore; they're storage-cost-only and can be
left or pruned manually.

## 9. Open / deferred items

- **HR rendering** — `---` is currently plain text. Adding `<hr/>` round-trip support to `noteContentArchiver.ts` is sketched in "Known pitfalls" but reverted at user request pending a separate fix.
- **Inline image rendering** — explicit non-goal per spec §1. The note body carries a `<link:url>` to the Dropbox preview; users open it in a new tab. If inline rendering is wanted later, the editor needs a new `TomboyImage` Node + XML representation + the archiver branches.
- **Prompt tuning** — `config/prompts/diary-ko.txt` is the initial Korean-handwriting prompt. OCR quality on real diary pages is reportedly decent on first run but the prompt deserves iteration once correction data accumulates.
- **Orphan-doc cleanup** — the 28 docs written to the wrong uid path during the migration are still in Firestore. Harmless but a one-shot cleanup script would be nice.
