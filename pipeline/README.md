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
| Desktop   | Bazzite Linux (or any RHEL-derivative), NVIDIA GPU (tested: RTX 3080), Python **3.12** (3.13 also OK; **avoid 3.14** — several deps have no wheels yet and source-build hits multiple breakage points) |
| GPU VRAM  | 10 GB+ for Qwen2.5-VL-7B 4-bit; 16 GB+ for unquantized |
| Pi        | Raspberry Pi (any model with SSH + Python 3.9+), on the same LAN or with WAN SSH |
| reMarkable | rM 2 or rM Paper Pro; SSH access enabled (Settings → Security → Developer mode) |
| Network   | Pi reachable from desktop via SSH (LAN or WAN); rM reachable from Pi via SSH or USB |

---

## Initial Setup (desktop, one-time)

All commands are run from the `pipeline/` directory.

### 1. Python 3.12 venv via `uv`

Bazzite ships Python 3.14 as the system Python, which most of our deps don't have wheels for yet. The cleanest path is to use [`uv`](https://docs.astral.sh/uv/) to install a pinned Python 3.12 and create the venv with it:

```bash
# install uv (one-time, into ~/.local/bin)
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc to persist

# install Python 3.12 + recreate the venv with it
cd pipeline
uv python install 3.12
uv venv --python 3.12 .venv
source .venv/bin/activate
```

### 2. System headers for `[rmrl]`

`rmrl` pulls `reportlab` which needs system freetype headers, and `pdf2image` needs `poppler-utils`. On Bazzite / Fedora atomic, layer them and reboot:

```bash
sudo rpm-ostree install freetype-devel libart_lgpl-devel poppler-utils
sudo systemctl reboot
# (alternative: install + work inside a `toolbox enter` session)
```

> **No `python3-devel` needed when using `uv`** — uv ships its own Python with full headers; only `freetype-devel` / `libart_lgpl-devel` are still required for the `reportlab` C extensions.

### 3. Install the pipeline + extras

```bash
# `-std=gnu17` works around old reportlab 3.6.13 C code (rmrl pins it) that
# uses `bool` as an identifier — GCC 14 defaults to C23 where it's reserved.
CFLAGS="-std=gnu17" uv pip install -e '.[dev,firebase,dropbox,prepare,rmrl,vlm]'

# rmrl uses pkg_resources, which setuptools 81+ has dropped — pin below 81.
uv pip install 'setuptools<81'
```

The extras:
- `dev` — pytest, pytest-mock, ruff
- `firebase` — firebase-admin SDK
- `dropbox` — Dropbox SDK
- `prepare` — Pillow + pdf2image (page-image utilities used by tests + `segment_lines`)
- `rmrl` — production rM-to-PDF rasterizer (reportlab + svglib + pdfrw)
- `vlm` — torch, transformers, bitsandbytes, accelerate (Qwen2.5-VL-7B)

Until `[rmrl]` is installed, `s2_prepare` will fail at runtime against real `.rm` files. The unit tests use `FakeRenderer` and pass without it.

> **GPU node only**: if bitsandbytes fails to find CUDA, ensure the NVIDIA driver and `cuda-toolkit` are installed and `nvcc --version` returns successfully before installing the `[vlm]` extra.

---

## Bootstrap (one-time)

```bash
cd pipeline
source .venv/bin/activate
python -m desktop.bootstrap
```

Bootstrap is interactive. It will:
1. Walk you through **Dropbox OAuth** (opens a browser; paste back the authorization code). Computes `firebase_uid = dbx-{sanitized account_id}` from the resulting token — must match the uid the Tomboy web app uses.
2. Ask for the path to your **Firebase service-account JSON** (Firebase Console → Project Settings → Service Accounts → Generate new private key). The path is stored in `pipeline.yaml`; the file itself stays where you put it.
3. Ask for **rM connection details** — `diary_notebook_name` (default `Diary`), `ssh_host` (default `rm.local`), `ssh_user` (default `root`). Stored for reference; the desktop pipeline doesn't ssh into rM (rM's cron pushes to Pi).
4. Ask for **Pi connection details** — `ssh_host`, `ssh_port` (default `2222`), `ssh_user` (default `diary-sync`), `ssh_key` (default `~/.ssh/id_ed25519_diary`), `inbox_path` (default `~/diary/inbox`). The desktop must already have the SSH key (see [Generating the desktop→Pi SSH key](#generating-the-desktoppi-ssh-key)).
5. Write `config/pipeline.yaml` (gitignored) with all credentials and paths.

Tomboy/OCR sections (`tomboy.diary_notebook_name`, `tomboy.title_format`, `ocr.backend`, `ocr.local_vlm.{model_id,quantization,max_new_tokens,system_prompt_path}`) are written with sensible defaults and not prompted for; edit `config/pipeline.yaml` directly to change them. See `config/pipeline.example.yaml` for the full schema.

### Generating the desktop→Pi SSH key

Bootstrap doesn't generate SSH keys — it just records the path. The desktop needs its own ed25519 key whose **public** half lives in the Pi's `diary-sync` `authorized_keys`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_diary -C "tomboy-pipeline desktop -> pi"
ssh-copy-id -p <pi-port> -i ~/.ssh/id_ed25519_diary.pub diary-sync@<pi-host>
ssh -i ~/.ssh/id_ed25519_diary diary-sync@<pi-host> "echo ok"   # verify
```

This key is **separate** from the rM→Pi key in [`pi/README.md`](pi/README.md) section 2-B; both end up in the same `diary-sync` `authorized_keys`, but the private halves stay on their respective machines (desktop / rM).

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
- Bitsandbytes 4-bit quantization is on by default (`ocr.local_vlm.quantization: 4bit`). If it failed to load, check `python -c "import bitsandbytes"` — reinstall with `uv pip install --upgrade bitsandbytes` if needed.
- Lower `ocr.local_vlm.max_new_tokens` in `pipeline.yaml` (default 2048) — reduces decoder-side memory.
- Switch to a smaller model: set `ocr.local_vlm.model_id` to `Qwen/Qwen2.5-VL-3B-Instruct`.

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
- Confirm `firebase_service_account` in `pipeline.yaml` is a correct, readable path and the JSON's `project_id` matches the Firebase project that owns the target Firestore database. The pipeline reads the project ID from the JSON itself — there is no `firebase_project_id` config key.
- In Firebase Console → Firestore → Rules, verify `users/{uid}/notes/{guid}` writes are allowed. Service accounts bypass client-side rules by default, but custom rules can still gate them.
- Check `firebase_uid` format in `pipeline.yaml`: must be `dbx-{sanitized_dropbox_account_id}` (same as the Tomboy web app uses). Re-run `python -m desktop.bootstrap` and verify the printed uid matches what you see under `users/` in the Firestore console.

### No notes appearing in the app

**Symptom:** Pipeline reports success but no new notes show in Tomboy Web.

**Checks:**
- The app's Firebase realtime sync must be enabled (Settings → 동기화 설정 → Firebase 실시간 동기화 ON). Without it, Firestore writes are invisible until the user opens the note by direct URL.
- Confirm the Dropbox account the app is signed into produces the same `firebase_uid` (`dbx-{sanitized account_id}`) as the one in `pipeline.yaml`. If you re-bootstrapped against a different Dropbox account, writes go to a different `users/<uid>` subtree that the app never reads.
- Check `state/written.json` (under `desktop.data_dir`) to confirm S4 actually wrote the entry.
- In Firestore Console, browse `users/<firebase_uid>/notes/` to confirm the document exists.
