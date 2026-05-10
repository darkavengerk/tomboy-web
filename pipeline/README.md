# Tomboy reMarkable Diary OCR Pipeline

A 3-machine pipeline that converts handwritten diary pages into Tomboy notes via OCR:
**reMarkable tablet → Raspberry Pi (24/7 inbox) → desktop (Bazzite + GPU) → Firestore**.

See [the design spec](../docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md)
and [the implementation plan](../docs/superpowers/plans/2026-05-10-remarkable-diary-pipeline.md)
for full architecture and rationale.

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Desktop   | Bazzite Linux (or any RHEL-derivative), NVIDIA GPU (tested: RTX 3080), Python 3.11+ |
| GPU VRAM  | 10 GB+ for Qwen2.5-VL-7B 4-bit; 16 GB+ for unquantized |
| Pi        | Raspberry Pi (any model with SSH + Python 3.9+), on the same LAN or with WAN SSH |
| reMarkable | rM 2 or rM Paper Pro; SSH access enabled (Settings → Security → Developer mode) |
| Network   | Pi reachable from desktop via SSH (LAN or WAN); rM reachable from Pi via SSH or USB |

---

## Initial Setup (desktop, one-time)

All commands are run from the `pipeline/` directory.

```bash
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev,firebase,dropbox,prepare,vlm]
```

This installs the pipeline package plus all optional dependencies:
- `dev` — pytest, black, mypy
- `firebase` — firebase-admin SDK
- `dropbox` — Dropbox SDK
- `prepare` — rmrl (rM page rasterizer) + Pillow
- `vlm` — transformers, bitsandbytes, accelerate (Qwen2.5-VL-7B)

> **GPU node only**: if bitsandbytes fails to find CUDA, ensure the NVIDIA driver and `cuda-toolkit` are installed and `nvcc --version` returns successfully before running pip install.

---

## Bootstrap (one-time)

```bash
cd pipeline
source .venv/bin/activate
python -m desktop.bootstrap
```

Bootstrap is interactive. It will:
1. Walk you through Dropbox OAuth (opens a browser; paste back the authorization code).
2. Ask for the path to your Firebase service-account JSON (downloaded from Firebase Console → Project Settings → Service Accounts).
3. Ask for the Pi SSH connection string (e.g. `pi@192.168.1.50` or `diary-sync@my-pi.example.com`).
4. Write `config/pipeline.yaml` (gitignored) with all credentials and paths.

Bootstrap is idempotent — re-running it updates the config without losing existing values. Use `python -m desktop.bootstrap --dry-run` to preview the resulting YAML without writing it.

After bootstrap, install the Pi-side inbox watcher — see [`pi/README.md`](pi/README.md).

---

## Manual Run

```bash
cd pipeline
source .venv/bin/activate
python -m desktop.run_pipeline
```

This runs all four stages in sequence for every new uuid in the Pi inbox:

| Stage | Module | What it does |
|-------|--------|--------------|
| S1 fetch   | `desktop.stages.s1_fetch`   | rsync new `.metadata` + `.rm` files from Pi inbox |
| S2 prepare | `desktop.stages.s2_prepare` | rasterize `.rm` → PNG; write `state/prepared.json` |
| S3 OCR     | `desktop.stages.s3_ocr`     | run Qwen2.5-VL-7B; write `state/ocr.json` |
| S4 write   | `desktop.stages.s4_write`   | build Tomboy note payload; upload image to Dropbox; write to Firestore |

State files live in `~/.local/share/tomboy-pipeline/state/` (configurable via `desktop.data_dir` in `pipeline.yaml`). Each stage records which uuids it has processed; already-processed uuids are skipped on re-runs.

---

## Per-Stage Debugging

Each stage is independently runnable against your live config:

```bash
# Pull new files from Pi (no uuid needed — operates on the whole inbox)
python -m desktop.stages.s1_fetch

# Rasterize a specific page (--uuid filters to one page)
python -m desktop.stages.s2_prepare --uuid <rm-page-uuid>

# Re-run OCR for a page, bypassing the state cache (--force re-processes)
python -m desktop.stages.s3_ocr --force <rm-page-uuid>

# Re-run the Firestore write for a page
python -m desktop.stages.s4_write --force <rm-page-uuid>
```

`--force <uuid>` (append; repeatable) bypasses the stage's state-cache check for that uuid. Use it when you want to re-OCR or re-write a page without deleting state files.

To point at an alternate config:

```bash
python -m desktop.stages.s3_ocr --config /path/to/other-pipeline.yaml --force <uuid>
```

---

## Correction Workflow

When the OCR output needs correction:

1. Open the note in the Tomboy app (it will be in the `일기` notebook).
2. Edit the note body to fix transcription errors.
3. **Remove `[<rm-page-uuid>]` from the note title** — this signals that the note has been human-reviewed. The pipeline will not overwrite a note whose title no longer contains the uuid marker.
4. Save the note (auto-saves on blur).
5. After you have corrected several notes, run the correction extractor to produce fine-tuning triples:

```bash
python -m desktop.tools.extract_corrections
```

This compares the OCR text (from `state/ocr.json`) against the current Firestore note body for every uuid that has been reviewed (i.e., the title no longer contains `[uuid]`), and writes `(image_path, ocr_text, corrected_text)` triples to `state/corrections.jsonl`. Use these for fine-tuning or prompt iteration.

---

## systemd Timer (optional, deferred)

The timer unit is provided but **not enabled by default**. Enable it when you are satisfied with pipeline quality and want fully automatic runs every 30 minutes:

```bash
# Install the units into your user session
cp pipeline/desktop/deploy/desktop-pipeline.{service,timer} \
   ~/.config/systemd/user/

# Reload and enable
systemctl --user daemon-reload
systemctl --user enable --now desktop-pipeline.timer

# Check status
systemctl --user status desktop-pipeline.timer
journalctl --user -u desktop-pipeline.service -f
```

To disable:

```bash
systemctl --user disable --now desktop-pipeline.timer
```

The service runs as your own user and uses the venv at
`~/workspace/tomboy-web/pipeline/.venv`. If you cloned the repo elsewhere,
edit `WorkingDirectory=` and `ExecStart=` in `desktop-pipeline.service` accordingly.

---

## Troubleshooting

### VLM out-of-memory (OOM)

**Symptom:** `torch.cuda.OutOfMemoryError` during S3 OCR.

**Fixes:**
- Ensure no other GPU process is running (`nvidia-smi`).
- Bitsandbytes 4-bit quantization is on by default. If it failed to load, check `python -c "import bitsandbytes"` — reinstall with `pip install bitsandbytes --upgrade` if needed.
- Reduce the image resolution before OCR: set `vlm.max_image_px` in `pipeline.yaml` (default: 1568×1568). Try `1024`.
- As a last resort, switch to a smaller model: set `vlm.model_id` to `Qwen/Qwen2.5-VL-3B-Instruct`.

### Pi WAN reachability

**Symptom:** S1 fetch hangs or `ssh: connect to host … port … Connection refused`.

**Checks:**
- `ssh -p <port> <user>@<pi-host> echo ok` — confirm SSH works from the desktop.
- On the Pi: `systemctl --user status pi-watcher.timer` and `journalctl --user -u pi-watcher.service` to see if the inbox watcher is running.
- If behind a NAT: confirm port-forward on your router maps the WAN port to the Pi's LAN IP. Check with `curl -s ifconfig.me` on the Pi vs your router's WAN IP.
- Fail2ban may have blocked you: `sudo fail2ban-client status sshd` on the Pi.

### Firestore permission errors

**Symptom:** `google.api_core.exceptions.PermissionDenied` during S4 write.

**Fixes:**
- Confirm the service-account key path in `pipeline.yaml` is correct and the file is readable.
- In Firebase Console → Firestore → Rules, verify that `users/{uid}/notes/{guid}` allows write from the service account (service accounts bypass client-side rules but must match server rules if any exist).
- Confirm the Firebase project ID in `pipeline.yaml` matches the project that owns the Firestore database (`firebase_project_id` key).
- Check the uid format: must be `dbx-{sanitized_dropbox_account_id}` (same as the app uses). Re-run `python -m desktop.bootstrap` and verify the printed uid matches what you see in the Firestore console.

### No notes appearing in the app

**Symptom:** Pipeline reports success but no new notes show in Tomboy Web.

**Checks:**
- The app's Firebase realtime sync must be enabled (Settings → 동기화 설정 → Firebase 실시간 동기화 ON). Without it, Firestore writes are invisible until the user opens the note by direct URL.
- Confirm the Dropbox account used for the app matches the `dropbox_account_id` in `pipeline.yaml` — the uid must be identical.
- Check `state/written.json` to confirm S4 actually wrote the entry.
- In Firestore Console, browse `users/<uid>/notes/` to confirm the document exists.
