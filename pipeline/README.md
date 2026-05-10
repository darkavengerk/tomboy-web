# Tomboy reMarkable Diary OCR Pipeline

A 3-machine pipeline (reMarkable tablet → Raspberry Pi → desktop) that converts handwritten diary pages into Tomboy notes via OCR.

See [the design spec](../docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md) for the full architecture.

## Quick start

1. **Bootstrap (desktop, one-time)**: `python -m desktop.bootstrap` — walks you through Dropbox auth, Firebase service-account selection, and writes `config/pipeline.yaml`.
2. **Install the Pi inbox** — see `pi/README.md`.
3. **Install the rM-side push script** — see `pi/README.md` § "rM-side push".
4. **Run the pipeline manually**: `python -m desktop.run_pipeline`.
5. (Later) **Enable systemd timer**: `systemctl --user enable --now desktop-pipeline.timer`.

## Per-stage debugging

Each stage is independently runnable:

```bash
python -m desktop.stages.s1_fetch
python -m desktop.stages.s2_prepare --uuid <rm-page-uuid>
python -m desktop.stages.s3_ocr --uuid <rm-page-uuid>
python -m desktop.stages.s4_write --uuid <rm-page-uuid>
```

State files in `~/.local/share/tomboy-pipeline/state/` track which uuids each stage has processed; pass `--force <uuid>` to override.
