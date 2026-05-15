---
name: tomboy-ocr-note
description: Use when working on the OCR note feature — a note with body starting `ocr://<model>` that, on image paste, runs OCR + translation via two specialized models. Covers the ocrNote module (parser, sendOcr, runOcrInEditor two-stage flow), the bridge `/ocr` `/gpu/status` `/gpu/unload` proxy routes, the desktop-side `ocr-service` FastAPI container (GOT-OCR-2.0-hf), the `/admin/gpu` monitor + manual-unload page, and the VRAM coexistence model with Ollama. Distinct from the diary pipeline OCR (different stack, different backend).
---

# OCR note + GPU monitor

A note whose first content line matches `^ocr://([A-Za-z0-9._:/-]+)` is an
OCR-trigger note. Pasting an image into it runs **OCR → translation**
across two specialized models hosted on the desktop, with results
streamed back into the note as `[원문]` + `[번역]` blocks. A companion
admin page (`/admin/gpu`) shows VRAM usage + per-model unload buttons.

Distinct from the **diary pipeline** (Qwen2.5-VL-7B, separate
`pipeline/desktop/` flow — see `tomboy-diary` skill).

## 1. Architecture — machine separation

```
┌──────────────┐  HTTPS+Bearer   ┌─────────────────────┐  HTTP (LAN)   ┌─────────────────────────┐
│ Web app      │ ───────────────►│ Raspberry Pi        │ ─────────────►│ Desktop (RTX 3080 10GB) │
│ (TipTap +    │                 │ - term-bridge       │               │ - Ollama (translation)  │
│  ocrNote)    │                 │ - /ocr proxy        │               │ - ocr-service           │
│              │                 │ - /gpu/status merge │               │   (GOT-OCR-2.0-hf,      │
│              │                 │ - /gpu/unload route │               │    FastAPI + Quadlet)   │
│              │                 │                     │               │                         │
│              │                 │ NO GPU.             │               │                         │
└──────────────┘                 │ NO model hosting.   │               └─────────────────────────┘
                                 └─────────────────────┘
```

The **machine-separation invariant** is the most important thing about
this feature. The Pi has no GPU and never hosts a model. The bridge
points to the desktop via `OCR_SERVICE_URL` (required env, no default)
and `OLLAMA_BASE_URL` (defaults to localhost — must be overridden in
prod).

The same invariant is recorded as a bullet in
`.claude/skills/tomboy-terminal/SKILL.md` and `CLAUDE.md` because past
work has assumed same-machine and lost time.

## 2. Note signature format

```
ocr://<ocr-model>
translate: <ollama-model>      # optional — absence == legacy single-call
system: ...                    # optional — override translation system prompt
temperature: 0.2               # optional — translation step
num_ctx: 4096                  # optional — translation step
```

Parser: `app/src/lib/ocrNote/parseOcrNote.ts` → `OcrNoteSpec`.

Key fields:
- `model: string` — the OCR-side model (e.g. `got-ocr2`). For legacy
  notes this was the single VLM doing both stages.
- `translateModel?: string` — Ollama model id (default
  `exaone3.5:2.4b`). Absence flips `legacy = true`.
- `legacy: boolean` — true when no `translate:` header. UI uses this to
  pick the legacy code path.

The old `target_lang:` header is **silently dropped** for graceful
backwards compatibility. Don't reintroduce it — the post-split flow is
hardcoded English→Korean.

## 3. Two-stage flow (non-legacy)

`app/src/lib/ocrNote/runOcrInEditor.ts:runTwoStage`:

1. **OCR (single-shot)** — `sendOcr({url: ${bridge}/ocr, token, imageB64})`.
   Renders an `[원문]\nOCR 진행 중…` placeholder; replaces with
   `[원문]\n<text>` on success.
2. **Translation (streaming)** — `sendChat({url: ${bridge}/llm/chat,
   body: {model: translateModel, messages: [{role:system,
   content:buildTranslatePrompt()}, {role:user, content:extractedText}]}})`.
   Tokens stream into a new `[번역]\n…` block.

OCR is **not** streamed because ocr-service returns a single JSON body.
If extraction yields empty/whitespace text, translation is skipped.

Legacy flow (`spec.legacy === true`) preserves the single combined-call
behavior using a hardcoded English+Korean system prompt
(`buildLegacyOcrSystemPrompt('한국어')`) — kept inline in
`runOcrInEditor.ts` rather than `defaults.ts` so the post-split
`defaults.ts` stays simple.

## 4. ocr-service (desktop, FastAPI + Podman)

Endpoints (all under Bearer except `/healthz`):

| Endpoint | Body | Returns |
|---|---|---|
| `GET /healthz` | — | `{"ok": true}` (no auth) |
| `POST /ocr` | `{image_b64}` | `{"text": "..."}` |
| `GET /status` | — | `{loaded, last_called_at, in_flight}` |
| `POST /unload` | — | 200 + `{unloaded:true}` OR 423 if `in_flight > 0` |
| `GET /gpu/raw` | — | `{available, total_mb, used_mb, free_mb, processes:[]}` OR `{available:false, reason}` |

The runner wrap (`ocr-service/src/ocr_service/model_real.py`) uses
**transformers-native** API:

```python
from transformers import AutoModelForImageTextToText, AutoProcessor
processor = AutoProcessor.from_pretrained(model_id, use_fast=True)
model = AutoModelForImageTextToText.from_pretrained(model_id, low_cpu_mem_usage=True, use_safetensors=True, torch_dtype=torch.float16)
inputs = processor(image, return_tensors="pt", format=True).to(model.device)
generate_ids = model.generate(**inputs, do_sample=False, tokenizer=processor.tokenizer, stop_strings="<|im_end|>", max_new_tokens=4096)
text = processor.decode(generate_ids[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True)
```

Key contract details:
- **Model is `stepfun-ai/GOT-OCR-2.0-hf`** — the upstream-maintained HF
  native variant. NOT the legacy `stepfun-ai/GOT-OCR2_0`
  (`trust_remote_code` + frozen modeling_GOT.py + chained API
  breakages).
- **`format=True`** = markdown-style structured output. Without it,
  plain-text mode.
- **PIL Image is passed directly** — the HF native processor accepts
  PIL. The legacy variant required a file path (string), which forced
  a tempfile round-trip.
- **fp16** on the configured `OCR_DEVICE` (`cuda:0` default).
- **Idle auto-unload** via `idle.py:idle_watcher` background task —
  unloads when `(now - last_called_at) >= OCR_IDLE_UNLOAD_S` (default
  300s). Self-heals on exception (logs + continues) so a single
  unload failure doesn't kill the watcher.

Tests: `ocr-service/tests/` — pytest with `FakeRunner` from
`tests/_fakes.py`. Tests **never load the real model** (lazy imports +
fixture-injected engine), so `pytest` runs without transformers/torch
installed.

## 5. Bridge routing

| Endpoint | Function | Behavior |
|---|---|---|
| `POST /ocr` | `handleOcrProxy` | Bearer check, body `image_b64` validation, forward to `${OCR_SERVICE_URL}/ocr` with `Authorization: Bearer ${BRIDGE_SECRET}`. 503 on upstream failure. |
| `GET /gpu/status` | `handleGpuStatus` | `Promise.all` fan-out: ocr-service `/gpu/raw` + `/status` + Ollama `/api/ps`. Single merged JSON. Each upstream gets an `*_available` flag for graceful UI degradation. |
| `POST /gpu/unload` | `handleGpuUnload` | Body `{backend, name?}`. `backend:"ollama"` → Ollama `/api/generate` with `keep_alive:0` (official unload trick). `backend:"ocr"` → ocr-service `/unload`. 423 from ocr-service passes through. |

Files: `bridge/src/{ocr,gpu}.ts`. Tests: `*.test.ts` using **`node:test`
+ `node:assert/strict`** (NOT vitest — bridge convention). Bearer tokens
in tests minted via `mintToken(SECRET)` from `bridge/src/auth.ts`
(HMAC, not raw secret).

Bridge → ocr-service Bearer: the bridge forwards **its own
`BRIDGE_SECRET` value** as the Bearer to ocr-service. So **`BRIDGE_SECRET`
on Pi must equal `BRIDGE_SHARED_TOKEN` on Desktop** (byte-identical).
Mismatch → 401 from ocr-service.

## 6. `/admin/gpu` page

Route: `app/src/routes/admin/gpu/+page.svelte`. Listed in the admin
subnav (`/admin/+layout.svelte` `tabs` array).

- **Polls** `/gpu/status` every 5s while `document.visibilityState ===
  'visible'`. Stops on hidden + on destroy.
- Per-model row with **`[언로드]`** button → `POST /gpu/unload` → toast
  + immediate refresh.
- **423** response → toast `"사용 중 — 잠시 후 다시 시도"`.
- **Empty/error states**:
  - Bridge unreachable: `"브릿지 연결 실패"`
  - Auth missing: `"터미널 브릿지 설정이 필요합니다. 설정 → 터미널 브릿지에서 로그인하세요."`
  - GPU info unavailable (nvidia-smi failed): `"GPU 정보를 가져올 수 없습니다 (nvidia-smi 응답 없음)."`

Client helpers: `app/src/lib/gpuMonitor/{types,client}.ts`. Settings
keys read via `getDefaultTerminalBridge()` / `getTerminalBridgeToken()`
(bridge URL + token are shared with the terminal-note feature).

Admin uses `class:active` pattern (NOT `aria-current="page"`) — match
the existing convention; don't introduce new attributes.

## 7. VRAM coexistence model

ocr-service (PyTorch CUDA allocator) and Ollama (llama.cpp CUDA
allocator) **share the same GPU memory pool**. Neither process sees the
other's allocation. Practical consequences:

- ocr-service idle-unload (default 5min) so Ollama gets full pool when
  user isn't OCR'ing.
- Ollama's own LRU swap (`OLLAMA_MAX_LOADED_MODELS` /
  `OLLAMA_KEEP_ALIVE`) is automatic.
- Manual unload via `/admin/gpu` for tight VRAM situations.
- Ollama trying to load a big model while ocr-service is resident may
  hit `CUDA out of memory` or partial CPU offload (very slow).

## 8. Deployment

### Desktop side (`ocr-service`)

- Rootless Podman + Quadlet. Unit file:
  `ocr-service/deploy/ocr-service.container`. `EnvironmentFile`
  pattern mirrors term-bridge.
- **CDI for GPU**: `AddDevice=nvidia.com/gpu=all`. Requires
  `nvidia-container-toolkit-cdi` + `/etc/cdi/nvidia.yaml` on host.
  Quick CDI probe:
  `podman run --rm --device nvidia.com/gpu=all docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi`.
- **HuggingFace cache** mounted from `~/.cache/huggingface:Z` so model
  weights survive container rebuilds.
- **Caddy/firewall**: port 8080 listens on the desktop's LAN
  interface only. Never expose to public internet (Bearer is the only
  protection).
- Listen on `*:8080` works for IPv4 LAN access. **Rootless Podman
  port-binding can be IPv6-only on some setups** — for IPv4-only
  smoke tests use `-p 127.0.0.1:N:8080` form.
- Setup recipe in `ocr-service/deploy/README.md`.

### Pi side (bridge)

- The bridge container must be **rebuilt and restarted** after each
  bridge code change. Quadlet recreates the container on
  `systemctl --user restart term-bridge.service`, so any
  `podman exec`-applied changes do not survive.
- Required env adds: `OCR_SERVICE_URL=http://<desktop-ip>:8080`.
  No default — bridge refuses to boot if missing (intentional, to
  catch the same-machine assumption early).
- The Caddyfile in front of the bridge is path-agnostic
  (`reverse_proxy 127.0.0.1:3000` covers everything), so adding new
  bridge routes never requires Caddyfile edits.

## 9. Dependency pins worth caching

Located in `ocr-service/pyproject.toml`. Each pin is load-bearing:

| Pin | Why |
|---|---|
| `torch>=2.4,<2.5` | Ubuntu 22.04's `python3.11` package lacks `sys.get_int_max_str_digits`; torch 2.5+ `_dynamo.polyfills.sys` references it at module import. Torch 2.4 LTS is the last unaffected line. **Lift this cap by moving the base image to Ubuntu 24.04 + Python 3.12.** |
| `torchvision>=0.19,<0.20` | Paired with torch 2.4. |
| `transformers>=4.49,<4.50` | 4.49 added GOT-OCR-2.0-hf native support. 4.50+ added `integrations/moe.py` which uses `torch.library.custom_op` with PEP-563 string annotations that require torch 2.5+. Tightly coupled to the torch pin above. |
| `accelerate>=0.33,<1.0` | Needed for `low_cpu_mem_usage=True`. Cap to avoid the 1.x API rewrite. |
| `safetensors>=0.4` | `use_safetensors=True` in `from_pretrained`. |
| `requests>=2.31` | huggingface_hub transitive but pin explicit to dodge resolver shuffles. |
| `pillow>=10.4,<12` | Image decode path. |

**Future relaxation**: switch base image to `nvidia/cuda:12.6.X-runtime-ubuntu24.04`. That gives Python 3.12 (has the missing sys API) and unblocks torch 2.5+ → transformers 4.50+. One-time rebuild cost; permanent escape from the 4.49 / 2.4 cage.

## 10. Container build gotcha

`pyproject.toml` uses `[tool.setuptools.packages.find] where = ["src"]`,
so `src/` MUST be present at `pip install .[model]` time. The plan
originally tried to copy `pyproject.toml` alone first for layer cache —
that fails with `error in 'egg_base' option: 'src' does not exist`. The
fix in `Containerfile`: copy both `pyproject.toml` AND `src/` before
the install. Layer cache is invalidated on any src change, but the
expensive transformers/torch wheel downloads stay cached in the apt
layer above.

Also note: **drop `-e`** from the install — production container
doesn't need editable mode. Without `-e` you also dodge the
`Can't uninstall ocr-service. No files were found` warning.

## 11. Quick map (files)

```
ocr-service/                            (desktop FastAPI service)
├── pyproject.toml                      pinned deps + extras
├── Containerfile                       CUDA runtime base, src copied before install
├── deploy/
│   ├── ocr-service.container           Quadlet unit
│   └── README.md                       step-by-step setup
├── src/ocr_service/
│   ├── app.py                          FastAPI, lifespan, routing.
│   │                                   PYTORCH_CUDA_ALLOC_CONF setdefault at top.
│   ├── config.py                       Settings.from_env (OCR_MODEL_ID,
│   │                                   BRIDGE_SHARED_TOKEN, OCR_IDLE_UNLOAD_S, OCR_DEVICE)
│   ├── model.py                        OcrEngine + OcrRunner Protocol
│   ├── model_real.py                   GotOcr2Runner (transformers-native).
│   │                                   Lazy imports of torch/transformers.
│   ├── idle.py                         idle_watcher (injectable clock, self-healing)
│   └── gpu.py                          nvidia-smi parser (injectable subprocess runner)
└── tests/                              FakeRunner-based, no GPU needed

bridge/src/
├── ocr.ts                              POST /ocr proxy
├── gpu.ts                              GET /gpu/status fan-out + POST /gpu/unload route
└── server.ts                           routing registry; OCR_SERVICE_URL = requireEnv(...)

app/src/lib/ocrNote/
├── defaults.ts                         OCR_DEFAULT_TRANSLATE_MODEL, buildTranslatePrompt
├── parseOcrNote.ts                     OcrNoteSpec with legacy flag
├── sendOcr.ts                          OCR HTTP helper + OcrSendError
└── runOcrInEditor.ts                   branches on spec.legacy

app/src/lib/gpuMonitor/
├── types.ts                            GpuStatusResponse / GpuStatusModel / UnloadRequest
└── client.ts                           fetchGpuStatus / unloadModel + URL normalization

app/src/routes/admin/gpu/+page.svelte   monitor UI, 5s polling, manual unload
```

## 12. Cross-cutting invariants worth caching

- **Bridge ≠ model host.** Pi has no GPU. All models on a separate
  desktop. Same invariant exists in `tomboy-terminal` SKILL.md /
  CLAUDE.md — keep all three in sync.
- **`BRIDGE_SECRET` (Pi) == `BRIDGE_SHARED_TOKEN` (Desktop ocr-service)**
  byte-identical. Bridge forwards its own SECRET as Bearer to
  ocr-service.
- **`OCR_SERVICE_URL` has no default.** Bridge bootup refuses if
  missing — prevents the same-machine assumption regression.
- **OCR text is not streamed.** ocr-service returns one JSON body.
  Translation IS streamed (Ollama). UX is: original block appears at
  once, translated block streams in.
- **`spec.legacy` flag drives flow choice.** Don't add a separate
  config knob — the absence of `translate:` header IS the legacy
  signal.
- **`target_lang:` header is dropped silently** for backward compat.
  Don't reintroduce it; the post-split flow is fixed English→Korean.
- **`format=True` in the processor call** is what gives markdown-style
  output. Without it, plain text mode (also useful, but not what we
  pick).
- **Idle auto-unload + manual unload are independent.** Auto via
  ocr-service self-timer; manual via `/admin/gpu`. Both call the
  same `OcrEngine.unload()` which respects `_in_flight > 0` (423).
- **Test framework convention**: ocr-service = pytest (asyncio_mode =
  auto); bridge = `node:test` + `assert/strict` (NOT vitest); web app
  = vitest. **`mintToken(SECRET)` for valid Bearer in bridge tests.**
- **rootless Podman + Quadlet recreates the container on restart.**
  `podman exec ... pip install ...` does NOT survive
  `systemctl --user restart`. Use `EnvironmentFile` for env tweaks
  and a fresh image build for dep tweaks.
- **`stepfun-ai/GOT-OCR-2.0-hf` (HF native) NOT `stepfun-ai/GOT-OCR2_0`
  (legacy custom code).** The legacy variant chains compatibility
  breakages with every transformers/torch update; the `-hf` variant
  is maintained upstream.
- **NAT hairpin**: testing the public DDNS hostname FROM the Pi
  itself fails (most home routers don't loop back). Use external
  client (laptop on cellular, or another LAN host) to reach
  `https://<bridge-host>/...`.

## 13. Operational checks

```bash
# Pi → desktop LAN reachability
curl -fsS --max-time 5 http://<desktop-ip>:8080/healthz   # → {"ok":true}

# Bridge has new code (after rebuild)
podman exec term-bridge node -e "const s=require('fs').readFileSync('/app/dist/server.js','utf8'); console.log(s.includes('/ocr')?'NEW':'OLD')"

# End-to-end /ocr via bridge (run from external host, NOT the Pi)
curl -X POST https://<bridge-host>/ocr \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"image_b64":"<base64>"}'   # 400 if image_b64 missing, 401 if bad token

# Bridge fan-out merge
curl -fsS -H "Authorization: Bearer <token>" https://<bridge-host>/gpu/status | jq .

# ocr-service logs on desktop
podman logs --tail 100 ocr-service

# Bridge logs (Pi)
podman logs --tail 100 term-bridge       # journalctl may be empty depending on Quadlet config

# Verify Bearer parity
podman exec term-bridge sh -c 'echo "$BRIDGE_SECRET" | sha256sum'
podman exec ocr-service sh -c 'echo "$BRIDGE_SHARED_TOKEN" | sha256sum'  # must match
```

## 14. Spec + plan archive

- Design: `docs/superpowers/specs/2026-05-15-ocr-translate-split-design.md`
- Plan: `docs/superpowers/plans/2026-05-15-ocr-translate-split.md`
- PR: GitHub PR #9 on `darkavengerk/tomboy-web` (branch `tigress` → `main`)

The plan is task-decomposed (Tasks 0-10) so it can serve as the
template for future restructures of this feature.
