# reMarkable Diary OCR Pipeline — Design

- **Date**: 2026-05-10
- **Status**: Draft → Pending user review
- **Owner**: JH
- **Scope**: A personal pipeline that converts handwritten diary pages drawn on a reMarkable tablet into Tomboy notes, retaining the original page image alongside extracted text. The pipeline is the foundation for future fine-tuning of a handwriting OCR model.

## 1. Goals & non-goals

### Goals

- Pages drawn in a designated reMarkable notebook (default name: `Diary`) flow automatically to the Tomboy app as new notes containing OCR text + a link to the original page image.
- Each pipeline stage is independently runnable and verifiable; failures in one stage do not corrupt the others.
- The OCR backend is pluggable; the first implementation is a local VLM (Qwen2.5-VL-7B) running on the desktop's RTX 3080.
- The pipeline collects (original page image, machine-extracted text, user-corrected text) triples that can later be used as fine-tuning training data.
- The user can stop a re-OCR from clobbering their corrections through a single explicit action: removing the page-uuid marker from the note title.

### Non-goals

- Real-time / instant sync. Pipeline runs are user-initiated (manual `run-pipeline.py`); a systemd timer is a later enhancement.
- Per-line image cropping at storage time. Line segmentation is deferred to the `tools/segment_lines.py` tool that runs on demand at fine-tuning prep time.
- Inline image rendering inside Tomboy notes. The editor has no image extension; notes carry plain Dropbox share URLs.
- Multi-user / cross-account support. The pipeline writes to one user's `users/{uid}/notes/{guid}` namespace.
- Replacing Tomboy's existing Dropbox sync. The pipeline writes to Firestore only; Dropbox stays the user-driven backup channel and picks up the new notes on the user's next manual sync.

## 2. System overview

```
┌─────────────────┐  rsync push   ┌──────────────────┐  rsync pull       ┌──────────────────────┐
│ reMarkable      │ ─────────────► │ Raspberry Pi     │ (manual/timer)    │ Desktop (Bazzite)    │
│ - 'Diary'       │  (WAN SSH      │ ~/diary/inbox/   │ ─────────────►    │ pipeline/desktop/    │
│ - cron / hook   │   별도 포트)   │ + state index    │                   │ s1 → s2 → s3 → s4   │
└─────────────────┘                └──────────────────┘                   └────────┬─────────────┘
                                                                                    │
                                  ┌────────────────────────────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────────┐
            │                     │                         │
            ▼                     ▼                         ▼
   ┌────────────────┐   ┌──────────────────────┐  ┌──────────────────────┐
   │ Dropbox        │   │ Firestore            │  │ Local data/state     │
   │ /diary-images/ │   │ users/{uid}/notes/   │  │ raw/ png/ ocr/       │
   │  yyyy/mm/dd/   │   │ {tomboy-guid}        │  │ state/ logs/         │
   │  {uuid}/       │   │                      │  │ corrections/         │
   └────────────────┘   └──────────┬───────────┘  └──────────────────────┘
                                   │ incremental sync
                                   ▼
                         ┌─────────────────────┐
                         │ Tomboy 앱           │
                         │ - 사용자 교정       │
                         │ - 제목에서 uuid     │
                         │   제거 = 보호 신호  │
                         └─────────────────────┘
```

The pipeline runs across **three machines**:

- **reMarkable tablet (Linux)** — writes; pushes new pages to the Pi via SSH.
- **Raspberry Pi (24/7)** — receives and indexes; acts as the durable inbox while the desktop is asleep.
- **Desktop (Bazzite + RTX 3080)** — pulls from the Pi, runs `.rm → PNG → OCR → Firestore` pipeline.

## 3. Core invariants

These shape every component decision. Implementation must not violate them.

### I1. The page-uuid title marker is the mapping key

A note created by the pipeline has the title format:

```
2026-05-10 리마커블([abc-123-def-456])
```

where `[abc-123-def-456]` is the rM page UUID in square brackets.

When re-OCRing a page that has been processed before:

1. Look up `mappings[rm-page-uuid] → tomboy-guid`.
2. If a mapping exists, fetch the note from Firestore.
3. If the doc exists, is not deleted (`deleted != true`), and its **current** title still contains `[<rm-page-uuid>]`, overwrite that note (target = `tomboy-guid`).
4. If the title no longer contains the marker (= the user has corrected the entry and removed the uuid manually), treat this as a protected note and write a **new** note with a new `tomboy-guid`. Update `mappings[rm-page-uuid]` to point at the new guid.
5. If the doc is missing or has `deleted = true` (= user trashed it on purpose), behave the same as case 4: write a **new** note, refresh the mapping. The pipeline does not resurrect deleted notes.
6. If no mapping exists, create a fresh `tomboy-guid` and a new note.

**The user's act of removing the uuid from the title is the sole protection signal for the "kept-but-corrected" case.** Note deletion is the protection signal for the "throw away entirely" case. No other state, flag, or manifest is consulted. This keeps the protection mechanism legible and self-evident.

### I2. Each pipeline stage is independently runnable

Every stage is invokable as `python -m pipeline.desktop.stages.<sN_name>` with options to operate on a specific page-uuid or the full pending set. The orchestrator (`run-pipeline.py`) is a thin wrapper that calls them in order. Stage isolation lets the user debug a single stage without re-running the others.

### I3. Stage state lives in stage-local JSON files

Each stage has its own state file under `~/.local/share/tomboy-pipeline/state/`. A stage failing or being re-run only touches its own state. To force-re-run a stage for a uuid, the user deletes that uuid's entry from the relevant state file.

### I4. OCR backends are plugins behind `OCRBackend`

`pipeline/desktop/ocr_backends/base.py` defines an `OCRBackend` ABC with one method: `ocr(image_path: Path) -> OCRResult` where `OCRResult = {text: str, model: str, prompt_hash: str, ts: datetime}`. The first implementation is `local_vlm.py` (Qwen2.5-VL-7B). Adding a backend (Clova, Google, fine-tuned TrOCR) is a single new file plus a config-key change.

### I5. Page images are stored whole

s2 produces one page-level PNG per `.rm` file. No line cropping in the main pipeline. The optional `tools/segment_lines.py` tool consumes the same `.rm` strokes after the fact, when fine-tuning data is being prepared.

### I6. Firestore is the only first-party write target

The pipeline writes to `users/{uid}/notes/{guid}` and uploads images to Dropbox at `/Apps/Tomboy/diary-images/...`. It does **not** write `.note` files into Tomboy's Dropbox sync namespace, does **not** touch `manifest.xml`, and does **not** advance the revision counter. Notes reach Dropbox naturally on the user's next "지금 동기화" click in the app.

### I7. Note body format is fixed

The `<note-content version="0.1">` block of every pipeline-written note has this exact structure:

```
2026-05-10 리마커블([abc-123-def-456])

<OCR text — line breaks preserved verbatim from the VLM output>

---

https://www.dropbox.com/scl/fi/.../page.png
```

- First line is the title (Tomboy convention).
- Blank line, then OCR text.
- Blank line, `---`, blank line, then the image URL on its own line.
- Plain URL text, no link mark applied at write time. Auto-link / url-link conversion is the editor's job and outside this pipeline's scope.

## 4. Components

### 4.1 reMarkable side (push)

A small shell script on the rM tablet, scheduled via the rM's own cron (or installed as a `systemd-style` service if available), runs `rsync` over SSH to the Pi whenever it detects new/modified files in the `xochitl` data directory belonging to the configured Diary notebook.

Risks:

- rM firmware updates may wipe the script. README documents the re-install procedure.
- rM may be on cellular hotspot / outside home WiFi — Pi must be reachable on WAN.

### 4.2 Raspberry Pi side (inbox)

`pipeline/pi/inbox-watcher.py` — a small Python service (or shell + systemd timer) that:

1. Watches `~/diary/inbox/` for new files.
2. Maintains `~/diary/state/index.json` mapping `{rm-page-uuid → {received_at, mtime, archived: false}}`.
3. After successful desktop fetch, marks `archived: true` and (optionally) moves the original to `~/diary/archive/`.

The Pi exposes SSH on a non-standard port with an ed25519 key + fail2ban + a dedicated `diary-sync` user.

### 4.3 Desktop side (main pipeline)

Stages, in order:

| Stage | File | Inputs | Outputs |
|-------|------|--------|---------|
| s1 | `stages/s1_fetch.py` | Pi inbox via SSH | `raw/{rm-page-uuid}/` (rsync mirror of one rM page's files) |
| s2 | `stages/s2_prepare.py` | `raw/<uuid>/*.rm` | `png/<uuid>/page.png` (full-page rasterization via `rmrl` or equivalent) |
| s3 | `stages/s3_ocr.py` | `png/<uuid>/page.png` | `ocr/<uuid>.json` (`{text, model, prompt_hash, ts}`) |
| s4 | `stages/s4_write.py` | `ocr/<uuid>.json` + `png/<uuid>/page.png` | Firestore doc + Dropbox image upload + `state/mappings.json` update |

Each stage:

- Reads its own state file to skip already-processed uuids unless `--force <uuid>` is passed.
- Writes a JSONL log line per processed item to `logs/<stage>.jsonl` plus a human-readable line to `logs/<stage>.log`.
- Catches exceptions per-uuid; one bad page does not abort the rest of the batch.

### 4.4 OCR backend

`ocr_backends/base.py`:

```python
@dataclass
class OCRResult:
    text: str
    model: str
    prompt_hash: str
    ts: datetime

class OCRBackend(ABC):
    @abstractmethod
    def ocr(self, image_path: Path) -> OCRResult: ...
```

`ocr_backends/local_vlm.py`:

- Model: Qwen2.5-VL-7B (4-bit quantized via bitsandbytes).
- GPU memory: ~6–8 GB on RTX 3080 (10 GB).
- System prompt: tuned for Korean handwritten diary text. Instructs the model to preserve line breaks verbatim and emit text only (no commentary).
- `prompt_hash`: SHA-256 of the system prompt string. Persisted into `ocr/<uuid>.json` so future re-runs can detect prompt changes.

### 4.5 Tomboy payload (Firestore writer)

`lib/tomboy_payload.py` constructs the Firestore document with the exact shape the existing app expects (see `app/src/lib/sync/firebase/notePayload.ts` and `app/src/lib/core/note.ts` for the canonical types):

- `guid`: new UUID (or reused existing one per I1)
- `uri`: `note://tomboy/<guid>`
- `title`: per I1 / I7 (the title-only string, e.g. `2026-05-10 리마커블([abc-123])`)
- `xmlContent`: **only the `<note-content version="0.1">...</note-content>` block**, not the full `.note` XML. The body text inside follows I7's structure (title line, blank, OCR text, blank, `---`, blank, image URL). The pipeline only **produces** this string; it never parses it back, so a minimal write-only port is sufficient — but it must be parseable by the existing app's `parseNote` / `parseNoteContent` (used on Firestore pull). Cross-check with golden fixtures during M3.
- `tags`: includes `system:notebook:<name>` where `<name>` comes from `pipeline.yaml`'s `tomboy.diary_notebook_name` (default: `일기`). Tomboy's notebook membership is encoded as a tag.
- `createDate` / `changeDate` / `metadataChangeDate`: from the rM `.metadata` JSON `lastModified` field (the rM-side authoritative timestamp), converted to Tomboy's ISO format `yyyy-MM-ddTHH:mm:ss.fffffffzzz`. File mtime is a fallback if the metadata file is missing. `createDate` is the rM page's first-seen timestamp (recorded in `state/mappings.json` on first OCR); `changeDate` and `metadataChangeDate` track the latest rM `lastModified`.
- `deleted`: `false`
- `serverUpdatedAt`: set out-of-band via `firestore.SERVER_TIMESTAMP` at write time (not part of the payload struct itself).
- `serverUpdatedAt`: `firestore.SERVER_TIMESTAMP`
- `deleted`: `false`

Auth: Firebase Admin SDK with a service-account JSON whose path lives in `pipeline.yaml`. Admin SDK bypasses the `users/{uid}/...` security rule, so writes succeed as long as the path is correct.

The uid is computed once during bootstrap (see §5) and saved to `pipeline.yaml`.

### 4.6 Dropbox image uploader

`lib/dropbox_uploader.py` uploads `png/<uuid>/page.png` to:

```
/Apps/Tomboy/diary-images/{yyyy}/{mm}/{dd}/{rm-page-uuid}/page.png
```

Returns a Dropbox sharable URL. Uses a long-lived refresh token (PKCE) saved during bootstrap.

### 4.7 Tools (separate from main pipeline)

- `tools/extract_corrections.py` — for every page-uuid where the user has removed `[uuid]` from the title (= correction completed):
  1. Fetch the current note text from Firestore.
  2. Strip the title line, the `---` separator, and the image URL.
  3. Write the triple `corrections/{rm-page-uuid}/{page.png, ocr.txt, corrected.txt}`.
  4. Mark the uuid as `corrected: true` in `state/corrections.json` so it won't be re-extracted.
- `tools/segment_lines.py` — given a uuid, parse the original `.rm` strokes (via `lines-are-rusty` or equivalent), cluster strokes by Y-coordinate into lines, and emit `corrections/{uuid}/lines/line-XX.png` cropped from `page.png`. Used at fine-tuning prep time, not in the main flow.

### 4.8 Bootstrap

`desktop/bootstrap.py` is a one-shot interactive script:

1. Walks the user through Dropbox OAuth (PKCE, no client secret).
2. Fetches the Dropbox `account_id` and computes `uid = dbx-{sanitized account_id}`.
3. Asks for the path to the Firebase Admin SDK service account JSON.
4. Writes `pipeline.yaml` with `uid`, `dropbox_refresh_token`, `firebase_service_account`, plus default values for `diary_notebook_name`, paths, and the OCR backend.

After bootstrap, normal pipeline runs use the saved credentials and never prompt again.

## 5. Configuration

Single YAML file at `pipeline/config/pipeline.yaml` (gitignored). Example template at `pipeline/config/pipeline.example.yaml` (committed, no secrets).

```yaml
# Identity
firebase_uid: "dbx-<sanitized account_id>"
firebase_service_account: "/home/jh/secrets/tomboy-pipeline-sa.json"
dropbox_refresh_token: "<long string>"
dropbox_app_key: "<public key>"

# rM source
remarkable:
  diary_notebook_name: "Diary"      # rM-side folder/notebook name
  ssh_host: "rm.local"
  ssh_user: "root"

# Pi
pi:
  ssh_host: "pi.example.com"
  ssh_port: 2222
  ssh_user: "diary-sync"
  ssh_key: "~/.ssh/id_ed25519_diary"
  inbox_path: "~/diary/inbox"

# Desktop paths (defaults shown; override if XDG dirs differ)
desktop:
  data_dir: "~/.local/share/tomboy-pipeline"

# Tomboy target
tomboy:
  diary_notebook_name: "일기"        # Tomboy notebook the new notes go into
  title_format: "{date} 리마커블([{page_uuid}])"

# OCR
ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
```

## 6. Implementation milestones

The implementation is broken into 5 milestones. Each ends with a runnable artifact that the user can verify end-to-end.

### M0 — Foundation

`config.py`, `log.py`, `state.py`, `bootstrap.py`, `ocr_backends/base.py` (interface only). No `.rm` parsing, no OCR, no Firestore writes.

**Verify**: `python -m pipeline.desktop.bootstrap --dry-run` reports OK for every credential. `state.py` round-trips a sample state file.

### M1 — Pi inbox + rM push

rM-side push script (documented, manually installed). Pi-side `inbox-watcher.py` + systemd unit. WAN SSH hardening guide in `pi/README.md`.

**Verify**: Draw a new page on rM → within ~5 min, Pi `~/diary/inbox/` contains the page's `.rm` + metadata files. `journalctl -u pi-watcher` confirms.

### M2 — s1 fetch + s2 prepare

`s1_fetch.py` (Pi → desktop raw/) + `s2_prepare.py` (.rm → page PNG via `rmrl`).

**Verify**: `python -m pipeline.desktop.stages.s1_fetch` then `s2_prepare` → `png/<uuid>/page.png` exists and looks like the page. Re-running both is a no-op.

### M3 — s3 OCR + s4 write (the hard milestone)

- `local_vlm.py` (Qwen2.5-VL-7B + 4-bit quantization + system prompt for Korean diary).
- `s3_ocr.py` driving the backend.
- `lib/tomboy_payload.py` building the Firestore document.
- `lib/firestore_client.py` Admin SDK wrapper.
- `lib/dropbox_uploader.py` image upload + share URL.
- `s4_write.py` orchestrating §4.5 + §4.6 + the I1 mapping algorithm.

**Verify**:

1. Run end-to-end on one page → app shows a new note with the correct title, OCR text, separator, image URL.
2. Modify the same page on rM → re-run → same Tomboy note is updated (title + uuid still match).
3. In the app, manually delete `[uuid]` from the note title → modify the rM page again → re-run → a **new** Tomboy note appears; the user-edited one is untouched.

### M4 — Tools

`tools/extract_corrections.py` and `tools/segment_lines.py`. These are run on demand, separately from the main pipeline.

**Verify**: After the user corrects a note and removes the uuid, `extract_corrections.py` produces `corrections/<uuid>/{page.png, ocr.txt, corrected.txt}`. `segment_lines.py` against the same uuid produces `corrections/<uuid>/lines/line-01.png`, etc., that visually correspond to actual lines.

## 7. Error handling

- **Per-uuid try/except** at every stage. One bad page never blocks the rest of the batch.
- **State files are append-only within a stage.** Re-running a stage is idempotent: already-processed uuids are skipped unless `--force <uuid>` is given.
- **Firestore writes use `set` with `merge=False`** — full document replacement. The mapping algorithm (I1) decides the target guid before the write, so there's no need for partial-update semantics.
- **Dropbox upload failures** → s4 logs and skips writing the Firestore doc. The next run retries. (Don't write a Firestore doc whose image URL would 404.)
- **VLM OOM / model load failure** → s3 logs the uuid and continues. The user can `--force <uuid>` after fixing. No partial OCR is written.
- **Logging**: `logs/<stage>.jsonl` (machine-parseable) + `logs/<stage>.log` (human-readable, one line per item: `[2026-05-10 12:34:56] s3_ocr uuid=abc-123 result=ok chars=412`).

## 8. Testing strategy

This is a personal pipeline; manual verification per milestone (§6) is the primary test. Unit tests are added only where they pay back:

- `lib/tomboy_payload.py` — payload shape vs. golden fixtures (the existing app's expected document shape; cross-check by reading `app/src/lib/sync/firebase/notePayload.ts`).
- `state.py` — round-trip + concurrent-write protection.
- I1 mapping algorithm — table-driven tests covering the five cases (new, existing-still-marked, existing-marker-removed, mapping-exists-but-note-deleted, malformed-title).

No integration tests against real Firestore or Dropbox; manual verification owns that path.

## 9. Open / deferred decisions

These are not blockers for M0–M2. They get resolved as we approach the milestone that needs them.

- **VLM prompt tuning**: the system prompt at `config/prompts/diary-ko.txt` will need iteration on real diary pages. Initial prompt: "다음은 한국어 손글씨 일기 페이지입니다. 줄바꿈을 그대로 보존하면서 텍스트만 추출해 주세요. 설명이나 주석을 추가하지 마세요." Plan: M3 lands a baseline; iterate during M4.
- **rM-side push mechanism specifics** (cron vs. service vs. xochitl-hook). M1 picks one based on what the user's rM firmware supports.
- **Whether to apply url-link mark** to the image URL in note body. Initial: plain text; revisit if the auto-link extension doesn't pick it up reliably.
- **Multi-page diary entries**: an entry that spans 3 rM pages becomes 3 Tomboy notes (one per page) per I1. If this proves annoying, a future "merge by date" tool can stitch consecutive pages into one note. Not in scope for M0–M4.

## 10. Directory structure (final)

```
tomboy-web/
├── app/                              # existing
├── bridge/                           # existing
├── functions/                        # existing
├── docs/superpowers/specs/
│   └── 2026-05-10-remarkable-diary-pipeline-design.md  # this file
└── pipeline/                         # new
    ├── README.md
    ├── config/
    │   ├── pipeline.example.yaml     # committed
    │   ├── pipeline.yaml             # gitignored
    │   └── prompts/
    │       └── diary-ko.txt          # committed
    ├── pi/
    │   ├── inbox-watcher.py
    │   ├── deploy/
    │   │   ├── pi-watcher.service
    │   │   └── pi-watcher.timer
    │   └── README.md
    ├── desktop/
    │   ├── run-pipeline.py
    │   ├── bootstrap.py
    │   ├── stages/
    │   │   ├── s1_fetch.py
    │   │   ├── s2_prepare.py
    │   │   ├── s3_ocr.py
    │   │   └── s4_write.py
    │   ├── tools/
    │   │   ├── extract_corrections.py
    │   │   └── segment_lines.py
    │   ├── ocr_backends/
    │   │   ├── base.py
    │   │   └── local_vlm.py
    │   ├── lib/
    │   │   ├── config.py
    │   │   ├── log.py
    │   │   ├── state.py
    │   │   ├── tomboy_payload.py
    │   │   ├── firestore_client.py
    │   │   └── dropbox_uploader.py
    │   ├── deploy/
    │   │   └── desktop-pipeline.{service,timer}  # added in/after M4
    │   └── README.md
    └── shared/
        ├── data_model.md
        └── schemas/
            ├── stage_state.schema.json
            └── ocr_result.schema.json
```

Local data (gitignored, host-local):

- Pi: `~/diary/{inbox, archive, state}/`
- Desktop: `~/.local/share/tomboy-pipeline/{raw, png, ocr, state, logs, corrections}/`

## 11. Security & operational notes

- **rM push script** is wiped by rM firmware updates. README documents reinstallation.
- **Pi WAN SSH** uses a non-standard port + ed25519 key + fail2ban + dedicated `diary-sync` user with `AllowUsers diary-sync` in sshd config. The user lives in a chroot or has shell limited to rsync.
- **Firebase Admin SDK service-account JSON** is a high-value secret. Stored outside the repo (path pointed at by `pipeline.yaml`); `pipeline.yaml` itself stays gitignored.
- **No credentials in note bodies.** The pipeline never embeds anything sensitive in the `<note-content>`.
- **Image URLs are Dropbox shared links.** Anyone with the URL can view; this is acceptable for personal use but documented in README.
