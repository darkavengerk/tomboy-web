---
name: tomboy-diary
description: Use when working on the reMarkable diary OCR pipeline (pipeline/) — rM tablet → Raspberry Pi inbox → desktop OCR (Qwen2.5-VL-7B local) → Firestore notes in the Tomboy app. Covers the 3-machine flow, the per-page flat-inbox contract, the rM-side push script (busybox+dropbear quirks, multi-folder Diary/Notes/Slip-Notes, synthesized per-page metadata with sourceFolder), the Pi-side watcher + systemd timer, the desktop stages s1_fetch / s2_prepare (rmscene-based renderer + slip split) / s3_ocr (Qwen2.5-VL + 4-bit nf4 quantization on RTX 3080) / s4_write (Firestore only, no Dropbox, route-based notebook/title), the unit-key model (uuid vs uuid#half for split pages), the Cloud-Function-bytecompatible uid sanitize contract, and the operational gotchas that ate hours during M1–M3 bring-up. Files in `pipeline/` plus the app-side `NoteXmlViewer` debug helper.
---

# 리마커블 일기 OCR 파이프라인 (pipeline/)

A 3-machine pipeline that ingests handwritten diary pages drawn on the
reMarkable tablet and produces Tomboy notes with OCR text. Design doc:
`docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`.
Implementation plan:
`docs/superpowers/plans/2026-05-10-remarkable-diary-pipeline.md`. Both
predate live bring-up — this skill captures what M1–M3 bring-up
actually exposed.

다중 폴더 + 슬립 분할 + 이미지 폐지 변경 설계 문서:
`docs/superpowers/specs/2026-06-14-remarkable-multifolder-ocr-design.md`.
구현 계획: `docs/superpowers/plans/2026-06-14-remarkable-multifolder-ocr.md`.

## 1. Architecture (3 machines)

```
┌─────────────────┐ rsync push  ┌──────────────────┐ rsync pull  ┌──────────────────────┐
│ reMarkable      │ ──────────► │ Raspberry Pi     │ ──────────► │ Desktop (Bazzite,    │
│ - Diary folder  │  (WAN SSH,  │ ~/diary/inbox/   │  (manual)   │ RTX 3080)            │
│ - Notes folder  │   port 2222)│ + state/index    │             │ s1→s2→s3→s4          │
│ - Slip-Notes    │             │ + inbox_watcher  │             │                      │
│   folder        │             │ + systemd timer  │             │ rmscene→PNG(+split)→ │
│ - systemd timer │             │ (5 min)          │             │ Qwen2.5-VL-7B(4bit)→ │
│ (5 min)         │             │                  │             │ Firestore (OCR only) │
└─────────────────┘             └──────────────────┘             └──────────┬───────────┘
                                                                            │
                                                               ┌────────────┴───────────┐
                                                               ▼
                                               ┌────────────────────────┐
                                               │ Firestore              │
                                               │ users/{uid}/notes/     │
                                               │   {tomboy-guid}        │
                                               │                        │
                                               │ → web app picks up via │
                                               │ realtime-note-sync     │
                                               └────────────────────────┘
```

- **reMarkable tablet** — writes; pushes new pages from Diary/Notes/Slip-Notes folders to the Pi via SSH+rsync (synthesizes per-page `<page-uuid>.metadata` with `sourceFolder` field since rM has no per-page metadata natively).
- **Raspberry Pi (24/7)** — receives flat `<page-uuid>.{rm,metadata}` files; inbox_watcher.py keeps `~/diary/state/index.json` up to date so the desktop fetcher can pull only what's new.
- **Desktop (Bazzite + RTX 3080)** — pulls from Pi → renders `.rm` to PNG with rmscene+Pillow (Slip-Notes pages split into two halves) → OCRs with local Qwen2.5-VL-7B (4-bit) → writes Tomboy note to Firestore. No Dropbox upload (이미지 폐지, 2026-06-14).

## 2. Operational invariants

The bring-up surfaced contracts that aren't obvious from reading any single file.
Violating any of these breaks the pipeline silently — the symptom is "0 pages
X'd" at the stage where the contract is read.

### I1. 작업단위 키(unit key)가 범용 키

- 각 rM 페이지(`.rm` 파일)은 원칙적으로 하나 이상의 OCR 작업단위. NOT the notebook.
- **비분할 폴더(Diary/Notes)**: 작업단위 키 = `<page-uuid>` (기존과 동일). 한 페이지 → 한 Tomboy 노트.
- **분할 폴더(Slip-Notes)**: 작업단위 키 = `<page-uuid>#0` (위 절반) / `<page-uuid>#1` (아래 절반). 한 페이지 → 최대 두 Tomboy 노트.
- 이 단위 키가 `state/prepared.json`·`ocr-done.json`·`written.json`·`mappings.json`의 키이며, 노트 제목의 보호 마커 `[unit_key]`의 단위다.
- **마커 보호 신호**: 사용자가 제목에서 `[unit_key]` 제거 → 다음 재OCR이 새 노트를 생성(기존 노트 덮어쓰기 안 함).
- `lib/keys.py` 참조: `unit_keys_for_page(page_uuid, split)`, `page_uuid_of(unit_key)`, `half_index_of(unit_key)`.
- Firestore 문서 ID는 별도 `uuid4`(`_resolve_target_guid`) — `#`가 포함되지 않음. `#`는 로컬 상태 키·파일명·제목 마커에만 등장.

### I2. Pi inbox is flat per-page, not per-notebook

- Layout: `~/diary/inbox/<page-uuid>.rm` + `~/diary/inbox/<page-uuid>.metadata`.
- `inbox_watcher.py` globs `*.metadata` and uses the filename stem as the page uuid.
- `s4_write` reads only `metadata["lastModified"]` (ms since epoch) for Tomboy `createDate` / `changeDate`. Other metadata fields are ignored.
- The rM-side push script SYNTHESIZES per-page `.metadata` stubs from `.rm` file mtime (rM natively has only notebook-level `.metadata`).

### I3. rM은 세 개의 FOLDER (CollectionType)에서 수집

수집 대상 폴더: **Diary, Notes, Slip-Notes** (rM `CollectionType`, `visibleName` 일치).

- rM 푸시 스크립트(`diary-push.sh`)는 `TARGET_FOLDERS="Diary Notes Slip-Notes"`를 루프하며 각 폴더를 `CollectionType + visibleName == <folder>` 조합으로 식별. 삭제/고아 노트북이 같은 이름으로 존재할 수 있으나 CollectionType+visibleName 조합이 구별한다.
- 각 폴더의 직접 자식 DocumentType 노트북(`.content`의 `"fileType": "pdf"` 제외)을 순회하며 모든 `.rm` 페이지를 스테이징.
- 합성 per-page `.metadata` 스텁에 **`"sourceFolder": "<폴더명>"`** 필드가 추가됨 — 데스크탑 `s2`/`s4`가 `cfg.tomboy.route_for(sourceFolder)`로 폴더별 라우팅을 결정하는 데 사용.
- 데스크탑 폴더 라우팅은 `config.py:TomboyConfig.route_for(source_folder) → FolderRoute{notebook, title_format, split, labels}`로 처리. 기본 라우팅(`DEFAULT_FOLDER_ROUTES`):

  | rM 폴더 | Tomboy 노트북 | 분할 | 라벨 |
  |---|---|---|---|
  | Diary | `일기` | 아니오 | — |
  | Notes | `기록` | 아니오 | — |
  | Slip-Notes | `[0] Slip-Box` | 예 | `上` / `下` |

- `pipeline.yaml`의 `tomboy.folders` 맵으로 오버라이드 가능. 레거시 `diary_notebook_name`/`title_format` 단일 키는 Diary 엔트리에만 적용되고 Notes/Slip-Notes는 코드 기본값 사용(하위호환).
- 미지의 `sourceFolder`는 Notes 기본 라우트(분할 없음, 노트북 `기록`)로 폴백.
- page-uuid는 전역 고유 → 폴더가 늘어도 평탄 Pi inbox에서 키 충돌 없음. inbox 레이아웃(I2) 무변경.

### I4. The Firebase uid sanitize MUST match the Cloud Function byte-for-byte

This burned an entire migration cycle. `pipeline/desktop/bootstrap.py:sanitize_account_id`:

```python
return re.sub(r"[^A-Za-z0-9_-]", "_", account_id)
# uid = f"dbx-{sanitized}"[:128]
```

Mirrors `functions/src/index.ts:280-281` exactly. **Do NOT strip the `dbid:` prefix.** **Do NOT use `-` as replacement char (the Cloud Function uses `_`).** **Do NOT skip the 128-char truncate.** If pipeline's uid ≠ what `dropboxAuthExchange` mints, the pipeline writes to one `users/{uid}/...` and the app reads from a different one → docs invisible.

### I5. ~~이미지 URL `<link:url>` 래핑~~ — **폐지됨 (2026-06-14)**

**이 불변식은 2026-06-14 이미지 폐지로 더 이상 유효하지 않다.**

- s4의 Dropbox PNG 업로드와 본문 `<link:url>` / `---` 구분선 생성이 모두 제거됐다.
- 본문은 OCR 텍스트만(슬립 노트는 `validateSlipNoteFormat` 스켈레톤, 아래 I17 참조).
- `dropbox_refresh_token` / `dropbox_app_key` config 키는 이제 **선택값** — 없어도 파이프라인이 동작한다.
- 사용자는 reMarkable 원본을 직접 보며 검수한다.
- 기존에 `<link:url>`이 들어간 Diary 노트를 새 형식으로 재발행하려면 I13 복구 절차(`rm state/written.json → s4 재실행`)를 사용한다. 마커를 지운(교정 완료) 노트는 보호되어 건드리지 않는다.

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

### I17. 슬립노트 분할 (Slip-Notes 전용)

`s2_prepare._split_full_png`가 Slip-Notes 폴더 페이지를 위/아래 두 절반으로 분할한다.

**분할 알고리즘:**

1. `RmsceneRenderer`가 전체 페이지를 `page.full.png`로 렌더 (최대 `max(PAGE_HEIGHT, max_stroke_y + BOTTOM_PADDING)` 높이).
2. **컷 타깃 = `PAGE_HEIGHT // 2` = 936** (물리 화면 중앙 행). `canvas_h`의 바닥이 `max(PAGE_HEIGHT, …)` = 1872로 고정되므로 비스크롤 페이지는 컷이 정확히 936. 아래쪽 공백은 캔버스 크기에 영향 없음(원점이 화면 상단).
3. `lib/raster.find_blank_row_near(img, 936, SPLIT_GAP_SEARCH=240)` — 타깃 ±240px 창에서 가장 긴 잉크 없는 가로 띠의 중간 행을 찾아 그 행에서 컷. 두 카드 사이 여백/구분선에 스냅하여 글자 줄 가르기를 방지. 빈 띠가 창 안에 없으면 936 그대로(폴백).
4. 위 절반 → `png/<uuid>/page.0.png`, 아래 절반 → `png/<uuid>/page.1.png`. `prepared.json`에 복합 키 `uuid#0`/`uuid#1`로 각각 기록.
5. 중간 `page.full.png`는 즉시 삭제(`full.unlink(missing_ok=True)`).

**스크롤 경고**: `canvas_h > PAGE_HEIGHT`(사용자가 rM에서 아래로 스크롤해서 작성)이면 `log.info("split_scroll_warning", uuid=uuid, height=h)` 로그. 이 페이지의 분할 컷 위치가 의도와 다를 수 있으므로 수동 확인 필요 신호.

**빈 반쪽 건너뛰기**: s4 `write_pending`에서 `ocr_data["text"].strip() == ""`이면 Firestore 쓰기·mappings/written 갱신 없이 `log.info("skipped_empty", uuid=unit_key)` 후 건너뜀. 예: 페이지 상단 카드만 작성하고 하단은 비워둔 경우. 건너뛴 반쪽은 retryable — 사용자가 내용을 채운 뒤 가필(mtime-bump)하면 s1 재취득 → s2 재렌더 → s3 재OCR → s4 쓰기 흐름이 다시 동작한다.

**슬립 노트 본문 스켈레톤**: `build_note_content_xml(title, ocr_text, slip=True)` 출력:
```
{title}

이전: 없음
다음: 없음

{ocr_text}
```
앱 `validateSlipNoteFormat` 레이아웃(블록 인덱스: [0]제목 [1]공백 [2]이전 [3]다음 [4]공백 [5+]본문)과 정확히 일치. `이전:`/`다음:`은 `없음`으로 두고 사용자가 수동으로 인덱스 체인에 연결한다.

**슬립 노트 제목 형식**: `{datetime} 리마커블 {label}([{unit_key}])` — 예) `2026-06-14 09:30 리마커블 上([abcd#0])`. `datetime`은 rM `lastModified` 기준 `yyyy-mm-dd HH:mm`. 앱 `isSlipNoteTitle` 정규식(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b`)이 이를 슬립노트로 인식하여 `validateSlipNoteFormat` 검증을 적용한다.

**s1 재취득 캐스케이드**: 재취득(mtime-bump) 또는 `--force` 시 s1이 `StateFile.remove_page(page_uuid)`를 호출 — 이 메서드는 `page_uuid` 자신의 키와 `page_uuid#*` 접두사로 시작하는 모든 복합 키를 한 번에 삭제한다. 덕분에 수정된 슬립 페이지는 s2~s4 상태가 완전히 지워져 전체 재처리된다. `remove(key)` 단순 삭제(단일 키만 제거)와 혼동하지 말 것.

### I18. 앱에서 폴더별 프롬프트·라우팅 편집 (folders.yaml 오버레이)

설정 → 리마커블 탭의 "일기 OCR 파이프라인 설정"(`app/src/lib/remarkable/DiaryOcrSettings.svelte`)에서 폴더별 OCR 프롬프트와 라우팅을 보고 편집한다. **저장 위치는 데스크탑(브릿지 아님)** — OCR이 데스크탑에서 실행되고 프롬프트/라우팅이 거기 살기 때문.

- **`pipeline/config/folders.yaml` (gitignored, 앱 관리 오버레이)** — `pipeline.yaml`은 절대 건드리지 않는다(시크릿 보존, 주석 손실 방지). `config.py:load_config`가 `pipeline.yaml` 로드 후 같은 디렉터리의 `folders.yaml`을 `apply_folders_overlay`로 덮는다. 우선순위 `folders.yaml > pipeline.yaml tomboy.folders > DEFAULT_FOLDER_ROUTES`. 파일 부재 = 기존 동작 그대로.
- **폴더별 프롬프트 해석 순서** (`s3_ocr` 페이지 루프, 각 페이지 `source_folder` 기준): `folders.<name>.prompt`(비어있지 않으면) → `default_prompt`(folders.yaml) → backend `system_prompt_path` 파일(기존 동작). `TomboyConfig.prompt_for(source_folder)`가 해석하고 `s3_ocr.run_ocr`이 `backend.ocr(png, system_prompt=...)`로 전달. `OCRBackend.ocr`의 `system_prompt: str | None = None` 인자 — `None`이면 생성자 기본값(하위호환). claude·local_vlm 둘 다 적용.
- **trigger 서버 `GET/PUT /config`** (`trigger_server.py:ConfigStore`, Bearer 인증, I16 재사용) — GET은 effective config(`load_config` 결과)를 직렬화, PUT은 검증 후 `folders.yaml`을 원자적(temp+`os.replace`)으로 기록. `title_format`은 알려진 플레이스홀더(`date/datetime/unit_key/page_uuid/label`)만 허용하고 attribute/index/positional 접근(`{date.__class__}`/`{date[0]}`/`{}`/`{date!r}`)은 거부 — 잘못된 포맷이 노트 제목 생성을 깨뜨리는 것을 막는다. 앱은 기존 `diaryTriggerUrl`/`diaryTriggerToken`(관리자 → 리마커블)으로 이 엔드포인트를 호출.
- **새 폴더 한계**: `folders.yaml`은 데스크탑 라우팅만 바꾼다. 완전히 새 폴더를 추가하면 태블릿 `diary-push.sh`의 `TARGET_FOLDERS`도 수동 추가해야 페이지가 Pi inbox로 들어온다(rM→Pi→데스크탑 단방향, I3). 앱이 이 경고를 고정 표시.

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

1. `TARGET_FOLDERS="Diary Notes Slip-Notes"` 루프 — 각 폴더를 `CollectionType + visibleName == <folder>` 조합으로 식별.
2. 각 폴더의 DocumentType 노트북 자식 순회 (`.content`의 `"fileType": "pdf"` 제외).
3. 각 `.rm` 페이지에 대해: `<page-uuid>.rm` 스테이징(mtime `cp -p` 보존) + 합성 `<page-uuid>.metadata` 스텁 생성 (`lastModified` = `.rm` mtime in ms, **`sourceFolder` = 폴더명**, `visibleName` = 폴더명).
4. 스테이징 디렉터리를 `diary-sync@<pi>:diary/inbox/`로 평탄 rsync. 변경 없는 페이지는 `touch -r`로 `.metadata` mtime 동기화 → rsync no-op.

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
.venv/bin/python -m pip install -e .[prepare,vlm,firebase,dev]
# torchvision is in [vlm]; rmscene is in [prepare].
# dropbox extra는 이미지 폐지로 더 이상 필수 아님(config에 dropbox 키가 선택값).
```

(`pipeline.yaml` must exist — `desktop/bootstrap.py` walks the user through
Firebase service account JSON setup and emits it. Dropbox PKCE 단계는 건너뛸 수 있다.)

Run the 4 stages in order:

```bash
.venv/bin/python -m desktop.stages.s1_fetch              # Pi inbox → ~/.local/share/tomboy-pipeline/raw/<page-uuid>/
.venv/bin/python -m desktop.stages.s2_prepare            # .rm → png/<uuid>/page.png (슬립은 page.0.png+page.1.png)
.venv/bin/python -m desktop.stages.s3_ocr --uuid <UUID>  # Smoke-test one page first (model download is ~14 GB)
.venv/bin/python -m desktop.stages.s3_ocr                # Process the rest
.venv/bin/python -m desktop.stages.s4_write              # Firestore upsert (Dropbox 업로드 없음)
```

Each stage is idempotent — re-running skips what's already in `state/<stage>.json`. To force a single page, use `--force <uuid>` (or `--uuid <uuid>` on s3 to filter to a single uuid). 슬립 페이지를 강제 재처리할 때는 page-uuid를 넘기면 `#0`/`#1` 복합 키까지 함께 클리어된다.

Verifying inside the app: open any diary note → menu (⋯) → **원본 XML 보기** (`NoteXmlViewer.svelte`). Shows the raw `xmlContent` so you can confirm the title format, OCR body, slip skeleton, etc.

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
| Notes appear but the image URL is plain unclickable text | `TomboyUrlLink` extension has no input/paste rule, so plain URLs loaded from xmlContent never get the url-link mark. | ~~Pipeline now emits `<link:url>{url}</link:url>` in the body.~~ **이미지 폐지(2026-06-14)로 더 이상 해당 없음** — s4는 이미지를 생성하지 않는다. 이 증상이 재발한다면 이미지 이전 출력물(old re-publish)이 원인. |
| The `---` separator does not render as a horizontal rule | The app's `noteContentArchiver.ts` has no `horizontalRule` case (neither parse nor serialize). The HR support was attempted in this session and reverted at user's request; user said "나중에 따로 고칠게". | **이미지 폐지로 `---` 자체가 본문에서 제거됨.** 더 이상 관련 없음(s4가 `---`를 생성하지 않는다). HR 지원 별도 작업이 필요하다면 archiver 분기 추가가 경로. |
| s4 writes succeed but image URLs return 404 / no preview | Dropbox upload failed silently. | **이미지 폐지(2026-06-14)로 더 이상 해당 없음** — s4가 Dropbox 업로드를 하지 않는다. |
| Image URL is clickable but doesn't render inline / loads Dropbox HTML page | Dropbox SDK returns share links with `?dl=0` by default — that's the HTML preview, not raw bytes. | **이미지 폐지(2026-06-14)로 더 이상 해당 없음** — s4가 Dropbox share link를 생성하지 않는다. |
| OCR transcribes only the top portion of a long page (rest is missing) | Page was scrolled on the rM but `RmsceneRenderer` was hardcoded to a 1404×1872 canvas, clipping strokes with `y > 1872`. Even after extending the canvas, single-shot OCR on a tall image gets aggressively downsampled by Qwen2.5-VL's `max_pixels` ≈ 1.0 M. | Renderer now grows the canvas to `max(PAGE_HEIGHT, max_stroke_y + BOTTOM_PADDING)`; `LocalVlmBackend._split_to_tiles` slices the tall PNG along blank-row line gaps and OCRs each tile separately. To re-process pages OCR'd before this change, delete `state/{prepared,ocr-done,written}.json` for affected uuids (or pass `--force <uuid>` to each stage). `mappings.json` is kept so the same handwriting still maps to the same Tomboy note (per I1). |
| All re-OCR attempts fail with CUDA OOM after ocr-service deployed | Even with `engine.unload()` cleared the model, the ocr-service uvicorn process keeps a ~300 MiB CUDA context. Combined with chrome's GPU buffer and the nvidia kernel reserve, there's not enough headroom for Qwen2.5-VL-7B nf4 (~5.9 GiB) + KV-cache (~2 GiB) on the 10 GB RTX 3080. | `desktop-pipeline.service` now `systemctl --user stop`s ocr-service entirely in `ExecStartPre` and `ExecStartPost`-starts it again. Releases the full CUDA context (see I14). |
| Re-OCR succeeds in Firestore but the app still shows the old short content even after hard refresh | App-side `conflictResolver` hits `metadataChangeDate` tie (rM mtime is the same on both writes) → falls to `tie-prefers-local` → the user's device pushes its stale local content BACK over Firestore. | `s4_write` now sets `metadata_change_date=datetime.now(timezone.utc)` so the pipeline's write is strictly newer; the receiver pulls (see I13). After applying the fix, `rm state/written.json && python -m desktop.stages.s4_write` to re-publish every note with bumped timestamps. |

## 5. State files (desktop)

Under `~/.local/share/tomboy-pipeline/state/`:

| File | Written by | Keyed by | Purpose |
|---|---|---|---|
| `fetched.json` | s1_fetch | rm-page-uuid | Skip re-fetch of pages already in `raw/<uuid>/`. |
| `prepared.json` | s2_prepare | **unit-key** (`uuid` 또는 `uuid#half`) | Skip re-rasterize. Stores `png_path`, `source_folder`, `metadata`, optional `half_index` for downstream. |
| `ocr-done.json` | s3_ocr | **unit-key** | Skip re-OCR. Stores `model` + `ocr_at`. OCR 결과 파일도 `ocr/<unit_key>.json`(예: `ocr/abcd#0.json`). |
| `written.json` | s4_write | **unit-key** | Skip re-publish (Firestore upsert). 이미지 폐지로 `image_url`은 빈 문자열. |
| `mappings.json` | s4_write | **unit-key** | unit-key → tomboy-guid 맵. I1 덮어쓰기/새 guid 결정의 근거. 재OCR 후에도 유지 — 동일 필기가 동일 Tomboy 노트로 연결. |

`fetched.json`만 page-uuid 키, 나머지 3개(`prepared`/`ocr-done`/`written`)와 `mappings`는 unit-key 키임에 주의.

To force a re-run of a stage: delete the relevant file or pass `--force <uuid>`. **`mappings.json` is sacred** — losing it means every existing note gets a new tomboy-guid on the next s4 run (duplicates in the app). 슬립 페이지 force 시에는 page-uuid 하나를 넘기면 `uuid#0`/`uuid#1` 양쪽이 자동 클리어된다(`StateFile.remove_page`).

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
  - `s1_fetch.py` — `SshRsyncTransport` uses `ssh ... cat` for the index + `rsync -e "ssh -p ..."` for pull. Pulls into `raw/<page-uuid>/`. 재취득(mtime-bump)/`--force` 시 `StateFile.remove_page`로 `uuid`·`uuid#*` 하위 상태 모두 클리어.
  - `s2_prepare.py` — metadata `sourceFolder` → `cfg.tomboy.route_for` → `FolderRoute`. 비분할: `RmsceneRenderer` → `png/<uuid>/page.png`. 분할(슬립): `page.full.png` 렌더 후 `_split_full_png` 호출 → `page.0.png`/`page.1.png`, `full.png` 삭제. PAGE_WIDTH=1404, PAGE_HEIGHT=1872, SPLIT_GAP_SEARCH=240.
  - `s3_ocr.py` — drives `LocalVlmBackend`. unit-key 단위 순회(`prepared.json` 키). OCR 결과 `ocr/<unit_key>.json`. Supports `--force <uuid>` and `--uuid <uuid>`.
  - `s4_write.py` — Firestore upsert + mappings update per unit-key(I1). `route_for(source_folder)`로 노트북·제목 포맷 결정. 빈 OCR 건너뜀. Dropbox 업로드 없음(이미지 폐지).
- `pipeline/desktop/ocr_backends/`
  - `base.py` — `OCRBackend` ABC + `@register_backend(name)` decorator + `get_backend(name)` registry.
  - `__init__.py` — `from . import local_vlm` to side-effect-register the built-in backend (the `s3_ocr` import path doesn't hit `local_vlm` directly).
  - `local_vlm.py` — Qwen2.5-VL-7B via `AutoModelForImageTextToText`. nf4 + double-quant + fp16 compute. `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set at module top. Auto-tiles tall scrolled pages via `_split_to_tiles` (TILE_THRESHOLD=2400, TILE_HEIGHT=1872, `lib/raster` 헬퍼 공유); per-tile outputs joined with `\n`.
- `pipeline/desktop/lib/`
  - `keys.py` — 작업단위 키 헬퍼: `unit_keys_for_page`, `page_uuid_of`, `half_index_of`. `SEP="#"`.
  - `raster.py` — 순수 Pillow 빈 가로 띠 탐색: `ink_row_mask`, `find_gap_near`, `find_blank_row_near`. `local_vlm`의 타일-컷과 s2의 슬립 분할이 공유. torch/numpy 의존 없음.
  - `tomboy_payload.py` — Firestore 문서 빌더. `build_note_content_xml(title, ocr_text, slip=False)`: 이미지/`---` 없음; 슬립이면 `validateSlipNoteFormat` 스켈레톤. `build_payload`: `unit_key`, `label`, `slip` 인자 추가; 제목 포맷 플레이스홀더 `{date}`, `{datetime}`, `{page_uuid}`, `{unit_key}`, `{label}`.
  - `firestore_client.py` — Firebase Admin SDK wrapper.
  - `dropbox_uploader.py` — 데드코드(s4에서 미사용). 이미지 폐지 이전 출력물 재처리 등 일회성 용도로만 남아있음.
  - `config.py` — `FolderRoute(notebook, title_format, split, labels)`, `DEFAULT_FOLDER_ROUTES`, `TomboyConfig.route_for(source_folder)`. `dropbox_*` 키는 `Config.from_dict`에서 선택값으로 강등.
  - `pipeline_status.py` — `PipelineStatusClient` (Firebase Admin SDK) for per-page status docs at `users/{uid}/diary-pipeline-pages/{pageUuid}` (see I12). `fetch_pending_reruns(cfg, log)` is the best-effort helper every stage's `main()` uses to fold admin-page rerun requests into its `force` set.
  - `state.py` — `StateFile`: `remove(key)` 단일 키, `remove_page(page_uuid)` page-uuid + `uuid#*` 전체 삭제.
  - `log.py` — shared StageLogger.
- `pipeline/desktop/trigger_server.py` — stdlib HTTP trigger (see I16). Bearer-authed, CORS-enabled, fire-and-forget run of `desktop.run_pipeline`. Unit file at `pipeline/desktop/deploy/diary-trigger.service`. 또한 `ConfigStore` + `GET/PUT /config`로 앱이 폴더별 프롬프트·라우팅을 편집해 `folders.yaml`에 저장(I18).
- `pipeline/desktop/bootstrap.py` — `sanitize_account_id` MUST mirror `functions/src/index.ts:280-281` byte-for-byte. Tests in `tests/test_bootstrap.py` lock the contract.
- `pipeline/config/pipeline.yaml` — gitignored. Holds `firebase_uid`, service-account path, host details. Dropbox 키(`dropbox_refresh_token`, `dropbox_app_key`)는 이미지 폐지로 **선택값**. `bootstrap.py` emits it.
- `pipeline/config/prompts/diary-ko.txt` — Qwen2.5-VL system prompt for Korean handwriting.

### App-side helpers added during bring-up

- `app/src/lib/editor/NoteXmlViewer.svelte` — modal that shows raw `xmlContent` for any note. Accessible from the **⋯** menu → "원본 XML 보기" on both mobile (`NoteActionSheet`) and desktop (`NoteContextMenu`). Critical for verifying what s4 actually wrote without firing up the Firestore console.
- `app/src/lib/admin/remarkablePipeline.ts` + `app/src/routes/admin/remarkable/+page.svelte` — the `/admin/remarkable` operator UI. Reads from `users/{uid}/diary-pipeline-pages`, writes the `rerunRequested` flag, and (when configured) POSTs to the desktop trigger server. Surfaces unit-key → tomboy GUID mapping, OCR char count + model, a "스크롤" badge for `imageHeight > 1872`, and a trigger panel with URL/token inputs + connection health + last-run status. 이미지 폐지로 Dropbox 썸네일은 제거됨(`imageUrl` 빈 값 안전 처리). Added to `admin/+layout.svelte` tabs as "리마커블".

## 7. Tests guarding the bring-up bugs

- `tests/test_bootstrap.py` — uid sanitize parity with Cloud Function (`dbid:` preserved, `_` replacement, 128-char truncate).
- `tests/stages/test_s1_fetch.py` — `SshRsyncTransport` argv structure: `ssh` not `scp` for the index, `-p` lowercase in rsync's `-e`, `cat` as the remote command. `StateFile.remove_page`가 `uuid#*` 캐스케이드함을 확인.
- `tests/stages/test_s2_prepare.py` — `RmsceneRenderer` raises on missing `.rm`; renders strokes to a non-blank PNG; eraser strokes are filtered. 분할 폴더 → 복합 키 2개 + `page.0.png`/`page.1.png`; 비분할 → 1개 키; 바닥 공백 큰 페이지도 canvas 1872 유지 → 컷 ~936; `canvas_h > 1872` 경고; force가 page 단위로 동작.
- `tests/stages/test_s3_ocr.py` — `only_uuids` filter (spec I2).
- `tests/ocr_backends/test_local_vlm.py` — `desktop.ocr_backends` package import alone registers the `local_vlm` backend.
- `tests/lib/test_tomboy_payload.py` — 본문에 `<link:url>`/`---` 없음; 일반 본문과 슬립 스켈레톤 확인; 슬립 제목이 앱 `isSlipNoteTitle` 정규식(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b`) 매칭; 마커 `[unit_key]`.
- `tests/lib/test_keys.py` — `unit_keys_for_page`(split T/F), `page_uuid_of`, `half_index_of`.
- `tests/lib/test_raster.py` — `find_blank_row_near` 중앙 빈 띠 스냅; 빈 띠 없으면 타깃 폴백.
- `tests/lib/test_config.py` — `folders` 맵 파싱 + 레거시 폴백 + 미지 폴더 기본 라우트; `dropbox_*` 키 선택값.

Run subset: `pipeline/.venv/bin/python -m pytest tests/ -q`.

## 8. Recovery / re-runs

After any code change that affects the on-wire payload, delete the corresponding `state/<stage>.json` and re-run that stage and downstream:

```bash
# Re-publish all docs with new payload shape (e.g., after image-abolition migration):
rm ~/.local/share/tomboy-pipeline/state/written.json
.venv/bin/python -m desktop.stages.s4_write
```

기존 Diary 노트의 `<link:url>` 이미지 링크를 제거하려면: 마커 `[unit_key]`가 남아있는 노트만 재발행(OCR 텍스트는 기존 것 재사용). 마커를 지운(교정 완료) 노트는 보호되어 유지.

For uid migrations (rare — only if `bootstrap.sanitize_account_id`
changes): edit `firebase_uid` in `pipeline.yaml` to the corrected value,
delete `state/written.json`, re-run s4. The old docs at the wrong uid
path become orphans in Firestore; they're storage-cost-only and can be
left or pruned manually.

## 9. Open / deferred items

- **슬립 인덱스 체인 자동 배선** — `이전:`/`다음:` 링크는 스켈레톤에서 `없음`으로 두고 사용자가 수동 연결. 자동화는 미결.
- **HR rendering** — `---` was removed from pipeline output (image abolition). Adding `<hr/>` round-trip support to `noteContentArchiver.ts` remains a separate deferred item if ever wanted.
- **Inline image rendering** — 이미지 폐지로 현재 비목표. 복원이 필요하다면 editor `TomboyImage` Node + archiver 분기 + 별도 이미지 저장 채널이 필요.
- **Prompt tuning** — `config/prompts/diary-ko.txt` is the initial Korean-handwriting prompt. OCR quality on real diary pages is reportedly decent on first run but the prompt deserves iteration once correction data accumulates.
- **Orphan-doc cleanup** — the 28 docs written to the wrong uid path during the migration are still in Firestore. Harmless but a one-shot cleanup script would be nice.
- **가변 카드 수** — Slip-Notes는 항상 위/아래 2장 가정. 카드가 1장이거나 3장 이상인 페이지는 빈 반쪽 건너뛰기(1장) 또는 하단 카드 잘림(3장 이상)으로 처리. 콘텐츠 인식 기반 카드 경계 탐지는 범위 외.
