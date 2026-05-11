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
  - `s2_prepare.py` — `RmsceneRenderer` produces `png/<page-uuid>/page.png`. PAGE_WIDTH=1404 PAGE_HEIGHT=1872 STROKE_WIDTH=2 + `_COLOR_MAP` for rM PenColor enum.
  - `s3_ocr.py` — drives `LocalVlmBackend`. Supports `--force <uuid>` and `--uuid <uuid>` (filter to specific page uuids for smoke tests).
  - `s4_write.py` — Firestore upsert + Dropbox image upload + mappings update per spec I1.
- `pipeline/desktop/ocr_backends/`
  - `base.py` — `OCRBackend` ABC + `@register_backend(name)` decorator + `get_backend(name)` registry.
  - `__init__.py` — `from . import local_vlm` to side-effect-register the built-in backend (the `s3_ocr` import path doesn't hit `local_vlm` directly).
  - `local_vlm.py` — Qwen2.5-VL-7B via `AutoModelForImageTextToText`. nf4 + double-quant + fp16 compute. `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set at module top.
- `pipeline/desktop/lib/`
  - `tomboy_payload.py` — builds the Firestore document (per app's `FirestoreNotePayload` shape). Wraps image URL in `<link:url>` mark.
  - `firestore_client.py` — Firebase Admin SDK wrapper.
  - `dropbox_uploader.py` — PNG upload + share-link. `share_link()` rewrites Dropbox's default `?dl=0` (HTML preview page) to `?raw=1` (raw bytes) via `_to_inline_url`, so the URL works as an inline image source — without it, the URL only opens a Dropbox preview when clicked and is useless inside an `<img src>`.
  - `state.py`, `log.py`, `config.py` — shared infrastructure.
- `pipeline/desktop/bootstrap.py` — `sanitize_account_id` MUST mirror `functions/src/index.ts:280-281` byte-for-byte. Tests in `tests/test_bootstrap.py` lock the contract.
- `pipeline/config/pipeline.yaml` — gitignored. Holds `firebase_uid`, service-account path, Dropbox refresh token, host details. `bootstrap.py` emits it.
- `pipeline/config/prompts/diary-ko.txt` — Qwen2.5-VL system prompt for Korean handwriting.

### App-side helper added during bring-up

- `app/src/lib/editor/NoteXmlViewer.svelte` — modal that shows raw `xmlContent` for any note. Accessible from the **⋯** menu → "원본 XML 보기" on both mobile (`NoteActionSheet`) and desktop (`NoteContextMenu`). Critical for verifying what s4 actually wrote without firing up the Firestore console.

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
