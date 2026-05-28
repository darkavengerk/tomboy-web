---
name: tomboy-terminal
description: Use when working on the terminal-note feature — a note whose body is `ssh://[user@]host[:port]` (optionally followed by `bridge: wss://...` and/or `spectate: <session>`) opens an xterm.js session through a separate WebSocket bridge service. Covers the parser, WS protocol + Bearer-token auth, the bridge HTTP/WS server (`bridge/`), rootless Podman + Quadlet deployment, SELinux + user-namespace constraints, host-sshd requirement, Caddy reverse proxy, and the tmux -CC spectator mode — the **1:N SpectatorHub model** (shared ssh + tmux -CC per (target, session), per-WS SpectatorSubscription with follow-active OR ordinal-pinned modes), `send-keys -H` opt-in input, transform:scale width-fit, native touch scroll, pane/window nav, current-window label strip, sticky modifier chips.
---

# 터미널 노트 (SSH terminal in a note)

A note whose body is **1–3 metadata paragraphs (ssh URL + optional `bridge:` + optional `spectate:`, any order) + optional `connect:` / `pinned:` / `history:` sections** matching:

```
ssh://[user@]host[:port]
bridge: wss://my-pc.example.com/ws        # optional
                                           # optional blank
connect:                                   # optional, single bucket — auto-runs on WS open
- tmux a -t main

pinned:                                    # optional, non-tmux pinned bucket (no cap)
- ls -la

pinned:tmux:@1:                            # optional, per-tmux-window pinned bucket
- htop

history:                                   # optional, non-tmux bucket
- sudo systemctl restart caddy

history:tmux:@1:                           # optional, per-tmux-window bucket
- tail -f /var/log/caddy.log
```

is matched as a terminal note. The title can be anything; only the body is constrained. A 3rd free paragraph (or any non-recognized block), any list/markup outside recognized sections, or a malformed section header (or scheme) falls back to a regular note. The note's `.note` XML stores plain text — Tomboy desktop sees a normal note and Dropbox/Firebase sync are unchanged. **Terminal output is never persisted**; it lives only in the open xterm scrollback.

By default the note opens in `<TomboyEditor>` with a "SSH 터미널 노트입니다 — `<target>` [접속]" banner. Clicking 접속 sets `terminalConnectMode = true` and starts the WS session. The TerminalView's "편집 모드" button sets it back to false — to convert a note out of terminal mode permanently, edit it to no longer match the format.

## Note format

Parser: `app/src/lib/editor/terminal/parseTerminalNote.ts` (pure, takes a
TipTap doc). Returns `TerminalNoteSpec | null`.

```ts
const SSH_RE    = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;
```

- **Body block count** — strip leading and trailing empty paragraphs;
  result must be 1–3 non-empty paragraphs. `bridge:` and `spectate:`
  lines may appear in either order; duplicates of either reject the note.
- **Non-paragraph blocks** (lists, headings, etc.), **inline images**, or
  a `hardBreak` inside the URL line → reject (regular note).
- `port` must be an integer in `[1, 65535]`; otherwise reject.
- `user`, `port`, `bridge` are all optional. When `bridge` is omitted the
  client falls back to `appSettings.defaultTerminalBridge`.

## Client side

| File | Role |
|------|------|
| `lib/editor/terminal/parseTerminalNote.ts` | Pure parser (above). |
| `lib/editor/terminal/wsClient.ts` | WebSocket protocol wrapper. `sendImage` + `onImageResult` for image paste; `subscribePane(ordinal)` for hub pin/unpin (0 = unpin); `onPaneUnavailable` callback. |
| `lib/editor/terminal/TerminalView.svelte` | xterm.js + FitAddon, header (target/bridge/status/끊김/재연결/편집 모드). Handles `onBell`, Ctrl+V / drag-and-drop / "이미지" button image triggers. `pinUnavailableInfo` state drives the yellow "패널 N번 없음" banner when the hub reports `pane-unavailable`. |
| `lib/editor/terminal/bridgeSettings.ts` | `appSettings` glue + `/login` `/logout` `/health` HTTP helpers. |
| `lib/editor/terminal/historyStore.ts` | Read-modify-write history/pinned mutation + per-guid serialization + 500ms debounce. Exposes `pinCommandInTerminalHistory`, `unpinCommandInTerminalHistory`. |
| `lib/editor/terminal/connectAutoRun.ts` | Pure `runConnectScript` — sends each `connect:` item as `text + '\r'` with 50 ms gap, skips empty lines, swallows per-line send errors. |
| `lib/editor/terminal/oscCapture.ts` | Pure OSC 133 parser / command-extraction helpers. |
| `lib/editor/terminal/HistoryPanel.svelte` | Desktop side panel + mobile bottom sheet UI for captured history + pinned commands. |
| `lib/editor/terminal/terminalBell.ts` | 벨 링어 — Web Audio API로 단음 비프음 합성 + `navigator.vibrate(200)`. ~300ms 스로틀. |
| `lib/editor/terminal/stickyMods.ts` | 순수 키→바이트 매핑 — `computeStickyKeySequence(event, mods)`, `applyStickyToText(text, mods)`, `StickyMods` 타입. 관전 모드 sticky modifier 칩 (Ctrl/Alt/Shift)에서만 사용. |
| `lib/editor/terminal/stickyDoubleTap.ts` | sticky 칩 토글 더블탭 단축키 순수 상태머신 — `onModKeydown` / `onModKeyup` / `onNonModKeydown`, `modKeyFromEventKey`, `DoubleTapState`. 400 ms 윈도우. 데스크탑 관전 모드에서만 사용. |
| `lib/editor/terminal/imagePasteClient.ts` | 클라이언트 이미지 헬퍼 — `validateImageFile`, `imageFilesFromList`, `fileToImagePayload`, `extractImageFile` re-export. |
| `lib/editor/terminal/clipboardImage.ts` | `extractImageFromClipboardItems(items: ClipboardItem[]): Promise<File \| null>` — `navigator.clipboard.read()` 결과에서 첫 `image/*` 항목을 `File`로 추출. 보내기 팝업의 "📋 이미지 붙여넣기" 버튼이 사용. |
| `bridge/src/imageTransfer.ts` | 브릿지 이미지 전송 — `mimeToExt`, `safeImageName`, `bracketedPaste`, `buildRemoteCatArgs`, `transferImage`. |
| `routes/note/[id]/+page.svelte` | Mobile route — branches on `parseTerminalNote(editorContent)` at load and after every IDB reload. |
| `lib/desktop/NoteWindow.svelte` | Desktop route — same branch. |
| `routes/settings/+page.svelte` (config tab → "터미널") | Bridge URL + login form + history settings + shell-integration snippet. |

### Bridge side (selected)

| File | Role |
|------|------|
| `bridge/src/server.ts` | HTTP `/login` `/logout` `/health` `/ocr` `/gpu/*` `/claude/chat` + WS handler. Routes spectator → `SpectatorHubRegistry.subscribe`. |
| `bridge/src/auth.ts` | `mintToken` / `verifyToken` (HMAC). |
| `bridge/src/pty.ts` | Shell-mode PTY spawn (`spawnForTarget`); `controlMasterArgs` exported for hub reuse. |
| `bridge/src/spectatorSession.ts` | Pure helpers: `buildSpectatorSshArgs(target, session, controlPath?)`, `panePosition(paneIds, activePaneId)`. Plus `SpectatorCallbacks` / `SpectatorNavAction` types. **No class — the legacy `SpectatorSession` class was deleted in the hub refactor.** |
| `bridge/src/spectatorHub.ts` | **`SpectatorHub`** + **`SpectatorSubscription`** + **`HubRegistry`** singleton (`SpectatorHubRegistry`). Hub owns ssh + tmux -CC + ControlMaster socket per `(target, session)`. Subscription is per-WS, filters `%output` to its own pane (follow-active or pinned ordinal). Last subscription close destroys the hub. |
| `bridge/src/tmuxControlClient.ts` | tmux -CC binary protocol parser. |
| `bridge/src/imageTransfer.ts` | `transferImage(controlPath, ...)` via ControlMaster reuse. |
| `bridge/src/hosts.ts`, `wol.ts` | WOL host map + magic packet. |

`TerminalView` short-circuits on mount: if no bridge URL → "브릿지 URL이
설정되지 않았습니다." banner; if no token → "브릿지에 로그인하지
않았습니다." banner. Only when both exist does it open the WS.

`document.fonts.ready` is awaited before refitting the terminal — xterm
measures `M` to derive cell width, and a missing named font produces
double-wide cells against a proportional fallback.

## Bearer-token auth

Stateless HMAC-signed token, stored in `appSettings.terminalBridgeToken`.
**No cookies** — that sidesteps `Secure` / `SameSite=None` requirements
so the bridge works over plain `ws://` on a LAN IP without TLS.

```
token = "<issuedAtMs>.<hmac_sha256(BRIDGE_SECRET, issuedAtMs)>"
```

`bridge/src/auth.ts`:

- `mintToken(secret)` — issued by `POST /login` after password match.
- `verifyToken(secret, token)` — re-signs `issuedAt` and constant-time
  compares against the supplied hmac. Rejects when the dot is missing,
  signature length differs, or `now - issuedAt > TOKEN_MAX_AGE_SEC`
  (30 days).

Login flow (`bridgeSettings.loginBridge` → `bridge/src/server.ts`):

1. Client `POST {bridge}/login` with `{ password }`.
2. Server `passwordMatches` (constant-time UTF-8 compare). Failure →
   750 ms fixed delay then 401.
3. Success → `{ token }` in JSON. Client persists to
   `appSettings.terminalBridgeToken`.

The token is sent:
- On HTTP in `Authorization: Bearer ...` (used by `/health`).
- On WS as `msg.token` in the first **`connect`** frame.

## WebSocket protocol

```
client → server : { type:'connect', target, token, cols, rows }
                  { type:'data',    d }
                  { type:'resize',  cols, rows }

server → client : { type:'ready' }
                  { type:'data',  d }
                  { type:'exit',  code }
                  { type:'error', message }
```

The browser's `WebSocket` API can't add custom headers on the upgrade
request, so the bridge defers auth to the first frame. After upgrade the
server holds the connection open for **`AUTH_TIMEOUT_MS = 5000`** waiting
for `connect`; missing or invalid token → close `1008`.

The bridge emits exactly one `{type:'ready'}` after `spawnForTarget`
returns and `pty.onData/onExit` are wired — i.e. the earliest moment a
`{type:'data'}` from the client will actually reach a live PTY. The
client uses this to gate `status='open'` (and therefore `connect:`
auto-run); without it the WS-handshake-only signal raced the async
spawn and frames were silently dropped by `if (!pty) return`. A 3 s
`READY_FALLBACK_MS` timer in `wsClient.ts` keeps older bridges (without
the `ready` frame) working.

Origin enforcement happens at the upgrade itself (`bridge/src/server.ts`):
mismatched `Origin` returns `403 Forbidden` and never reaches the auth
step. `BRIDGE_ALLOWED_ORIGIN` is comma-split — multiple origins are
supported.

`cols` / `rows` are clamped to `[1, 1000]`; nonsense values fall back to
80 × 24.

## PTY spawn — `bridge/src/pty.ts`

```ts
const isLocal = !t.user
    && (LOCAL_HOSTS.has(t.host) || t.host.toLowerCase() === hostname().toLowerCase());
```

- `isLocal` → spawn `process.env.SHELL || '/bin/bash'` with `-l`. Useful
  when the bridge runs natively as the target user.
- Otherwise → spawn `ssh [-p port] -o StrictHostKeyChecking=accept-new
  user@host`. Auth (key/password) flows through the PTY directly; the
  bridge does not broker credentials — never put the password in the
  note, the URL, or any WS frame.

**The `!t.user` guard is load-bearing for the containerized deployment.**
Inside the container `localhost` is the container itself (after
`Network=host`, the host loopback). `ssh://localhost` would drop into the
container's own `node` shell. Writing `ssh://you@localhost` instead
forces the ssh path → `ssh you@localhost` → host's sshd → real login
shell as `you` on the host.

**Note**: "host" in this section is whatever machine the bridge runs on.
The bridge can sit on the same machine as the ssh target (original
deployment) or on a separate always-on host (e.g., a Raspberry Pi) that
ssh's into the actual workstation over the LAN. The latter is what
unlocks the WOL flow below.

## WOL (Wake-on-LAN) — `bridge/src/{hosts,wol}.ts`

When the bridge runs on an always-on host (Raspberry Pi) and ssh's into
a workstation that may be asleep/off, the bridge can wake the
workstation before the ssh spawn.

Flow (in `server.ts` → `wakeIfNeeded`):

1. Client sends `connect` with `target = ssh://you@desktop.lan`.
2. Bridge looks up `target.host` (case-insensitive) in `BRIDGE_HOSTS_FILE`.
   Hit returns `{ mac, broadcast?, wakeTimeoutSec? }`. Miss → skip the
   whole WOL step (existing behaviour).
3. Quick TCP probe of `target.port ?? 22` with 1 s timeout. Open →
   skip wake. Closed → continue.
4. Send `data` frame `깨우는 중...` to the xterm.
5. UDP magic packet to `broadcast || 255.255.255.255:9` (16× MAC repetitions).
6. Poll the ssh port at 1 s intervals (1.5 s probe timeout each) until
   open or `wakeTimeoutSec` (default 60) elapses.
7. Open → send `연결 중...` and proceed to `spawnForTarget`.
   Timeout → send `{type:'error', message:'wake_timeout'}` and close `1011`.
8. WS close at any time aborts the polling via an `AbortController` so
   the bridge doesn't keep trying after the client gave up.

`hosts.json` schema (path = `BRIDGE_HOSTS_FILE`, default unset = WOL
disabled):

```json
{
  "desktop.lan": {
    "mac": "AA:BB:CC:DD:EE:FF",
    "broadcast": "192.168.0.255",
    "wakeTimeoutSec": 90
  }
}
```

- Keys match the host token verbatim from the note's ssh URL
  (case-insensitive). Use the same string the user types — no DNS
  resolution is performed for matching.
- `broadcast` is optional; default `255.255.255.255` works on most home
  LANs but the per-subnet broadcast (`192.168.x.255`) is more reliable.
- `wakeTimeoutSec` clamps to `[1, 600]`.
- Missing/malformed entries are logged and skipped — the rest of the
  file still loads.
- Failed/missing/non-JSON file is logged and treated as "no WOL
  targets"; the bridge still serves non-WOL hosts.

The host map is loaded **once at startup**. To pick up edits, restart
the unit (`systemctl --user restart term-bridge`).

## Bridge server — environment

Required env vars:

| Var | Purpose |
|-----|---------|
| `BRIDGE_PORT` | TCP port (default 3000). |
| `BRIDGE_PASSWORD` | Login password. |
| `BRIDGE_SECRET` | HMAC key for Bearer token signatures. **Must be stable across restarts** — rotating it invalidates every previously issued token (clients see `unauthorized` on the WS `connect` frame). Generate once with `openssl rand -hex 32` and keep it in `~/.config/term-bridge.env`. |
| `BRIDGE_ALLOWED_ORIGIN` | Comma-separated allowed `Origin` headers for CORS + WS upgrade. Add the Vercel / production app origin alongside any dev origins. |
| `BRIDGE_HOSTS_FILE` | Optional. Path to `hosts.json` for WOL host map. Unset/missing/invalid → WOL skipped, ssh attempted directly. |

## Container image — `bridge/Containerfile`

Two-stage Debian-slim build:

1. **Build stage** — installs `python3 make g++` (required by
   `node-pty`'s native addon), runs `npm install` and `npx tsc`,
   then `npm prune --omit=dev`.
2. **Runtime stage** — `node:22-bookworm-slim` + `openssh-client` +
   `ca-certificates`. Copies `dist/` and pruned `node_modules/`. Runs
   as `USER node` (uid 1000) by default.

## Quadlet deployment — `bridge/deploy/term-bridge.container`

The deployment recipe assumes **rootless Podman on Bazzite (SELinux
enforcing)**. Drop the file at `~/.config/containers/systemd/term-bridge.container`,
put env vars in `~/.config/term-bridge.env`, then:

```
loginctl enable-linger $USER          # so the container survives logout
systemctl --user daemon-reload
systemctl --user start term-bridge    # NOT enable — Quadlet auto-generates [Install]
```

The lines that have to be exactly right:

```ini
[Container]
Network=host
EnvironmentFile=%h/.config/term-bridge.env
Volume=%h/.ssh:/home/node/.ssh:ro,z
Volume=%h/.config/term-bridge/hosts.json:/etc/term-bridge/hosts.json:ro,z
Environment=BRIDGE_HOSTS_FILE=/etc/term-bridge/hosts.json
UserNS=keep-id
ReadOnly=true
```

Why each one:

- **`Network=host`** — without it the container's `localhost` is the
  container itself, so `ssh user@localhost` gets `Connection refused`.
  Using `Network=host` also obsoletes any `PublishPort=` line; remove it.
  Also required for UDP broadcast (WOL magic packet) to actually leave
  the host network namespace.
- **`Volume=%h/.ssh:/home/node/.ssh:ro,z`** — mounts the host user's
  SSH config + keys read-only into the container's `node` home so ssh
  can reuse them. **`:z` (lowercase, shared SELinux label)** is correct
  — `:Z` (uppercase, private label) breaks the host sshd's own access
  to its `~/.ssh`, and no label option at all leaves the host's
  `user_home_t` label which `container_t` cannot read (manifests as
  `ls: cannot open directory '/home/node/.ssh': Permission denied`).
- **`Volume=%h/.config/term-bridge/hosts.json:...`** + **`Environment=BRIDGE_HOSTS_FILE=...`** —
  WOL host map. **The host file must exist before the unit starts**; if
  it doesn't, podman creates a directory at the source path, which
  silently breaks the bind mount and produces a confusing failure mode.
  For "no WOL" deployments write `{}` and leave it.
- **`UserNS=keep-id`** — maps host uid 1000 ↔ container `node` (uid 1000)
  so the mounted `.ssh` files are readable inside the container. Without
  this, rootless podman maps `node` to a subuid that doesn't own the
  files; ssh logs every `identity file ... type -1` (couldn't read) and
  drops to password auth.
- **`ReadOnly=true`** + `Tmpfs=/tmp:rw,size=64m` — defense in depth.
  Combined with `DropCapability=ALL` and `NoNewPrivileges=true` the
  container has shell access only via spawned ssh.

After editing the unit:

```
systemctl --user daemon-reload && systemctl --user restart term-bridge
```

## Host-side requirements

The container's only privileged operation is spawning `ssh` against the
host loopback. The host has to actually serve sshd and accept the user's
key:

1. **sshd running on the host.** `systemctl status sshd` (Bazzite ships
   it disabled by default — `sudo systemctl enable --now sshd` once).
2. **`~/.ssh/authorized_keys` on the host contains the user's own
   public key.** `cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
   && chmod 600 ~/.ssh/authorized_keys`. This is the easy-to-miss step
   when nobody has ssh'd into the machine before.
3. **Passphrase-less private key** (or an agent socket — not currently
   wired). With a passphrase, ssh in non-interactive PTY use can't
   prompt and falls back to password auth.
4. **`~/.ssh/known_hosts` already has the loopback entry** — otherwise
   ssh hits a yes/no fingerprint prompt that surfaces inside the xterm
   on every fresh connect. Easiest fix: `ssh-keyscan -H localhost
   127.0.0.1 ::1 >> ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts`.

## Caddy reverse proxy — `bridge/deploy/Caddyfile`

Caddy fronts the bridge with TLS so the browser can use `wss://`. Single
domain block, `reverse_proxy 127.0.0.1:3000` (WebSocket upgrade is
transparent), `Cache-Control: no-store` on `/login` and `/health`, and a
`@bad method CONNECT TRACE → 405` defense-in-depth filter.

Caddy must be reachable from the public internet on 80 + 443 to obtain
and renew the Let's Encrypt cert.

## Vercel / cross-origin deployment

The app is a static SPA — Vercel serves the build, the bridge stays on
the home host. Two things to update:

1. Add the Vercel origin to `BRIDGE_ALLOWED_ORIGIN`:
   ```
   BRIDGE_ALLOWED_ORIGIN=http://localhost:5173,https://<your-app>.vercel.app
   ```
   Without this, `/login` POSTs are CORS-rejected and WS upgrades
   return `403`.
2. Vercel is HTTPS-only, so the bridge URL stored in
   `appSettings.defaultTerminalBridge` (and any inline `bridge:` line in
   notes) must be `wss://` — `ws://` would be blocked as mixed content.
   The Caddy front already provides this.

## Spectator mode (1:N hub — shared ssh, per-WS subscription)

A note with a `spectate:` metadata line is a **read-by-default mirror** of
a tmux pane on the target. Useful for kicking off a long task on the
desktop (e.g. claude code) and watching from a phone while you walk away
— with optional explicit-input via the mobile "보내기" popup for quick
confirmations (y/n/Enter). Multiple notes can spectate the same
`(target, session)` simultaneously and each can watch a different pane.

Note format:

```
ssh://you@desktop
spectate: main            # tmux session name (optionally ":<N>" for persistent ordinal pin)
bridge: wss://b/ws        # optional, order-agnostic with spectate:
```

`spectate:` accepts characters `[A-Za-z0-9_\-./@:]` (gated in
`parseTerminalNote.SPECTATE_RE`); any other character disqualifies the
note. `spectate: main:3` → load with ordinal-3 pin already active.

### Architecture: SpectatorHub + SpectatorSubscription (1:N)

`bridge/src/spectatorHub.ts`:

- **`SpectatorHub`** — owns one ssh + tmux -CC client per
  `(target, session)` pair. Keyed by `hubKey(target, session) =
  "<user>@<host>:<port>|<session>"`. Caches `sessionId / windowId /
  activePaneId / paneStates / currentWindowPaneOrder` from tmux events.
  Holds the ControlMaster socket path. Exposes listener-set fan-out
  (`addOutputListener`, `addActivePaneListener`, …) and desktop-mutating
  commands (`selectPane`, `tmuxNav`, `sendInput`).
- **`SpectatorSubscription`** — per-WS handle. Subscribes to hub listener
  sets; filters `%output` by its current `subscribedPaneId`; runs its
  own UTF-8 streaming decoder so per-pane state doesn't bleed between
  subscriptions. Has two `mode` kinds:
    - `{ kind: 'follow-active' }` (default) — `subscribedPaneId` tracks
      `hub.activePaneId` on every `%window-pane-changed`.
    - `{ kind: 'pinned', ordinal: N }` — `subscribedPaneId` resolves
      from `currentWindowPaneOrder[N-1]` and re-resolves on every
      `%layout-change` / window switch / pane order change. Out-of-range
      ordinal fires `paneUnavailable`.
- **`HubRegistry`** — module-level singleton `Map<hubKey, SpectatorHub>`.
  `subscribe(target, session, callbacks)` creates a hub on first call,
  reuses it on subsequent. `subscription.close()` decrefs; last close →
  `hub.destroy()` immediately (no grace timer): kills ssh, closes tmux,
  unlinks ControlMaster socket.

### How it works

1. WS `connect` frame carries `mode: 'spectate'` and `session: '<name>'`.
2. `server.ts` calls `SpectatorHubRegistry.subscribe(target, session, cb)`.
   On first call for the hubKey, it spawns ssh with `-tt` and runs
   `stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC
   attach -t <session>` via `buildSpectatorSshArgs` in
   `bridge/src/spectatorSession.ts`. `-tt` forces remote PTY allocation
   (tmux -CC calls `tcgetattr` at startup and exits with "Inappropriate
   ioctl for device" otherwise); `stty raw -echo` disables
   ECHO/ICANON/ONLCR so the binary control protocol passes unmunged;
   `exec` replaces the shell so signals + exit codes propagate cleanly.
   **The `stty cols 500 rows 200` step declares a large fake PTY size
   BEFORE tmux attaches** so the spectator never constrains the
   session's window size — without it ssh -tt sends the default 80x24
   and the desktop user's window shrinks as soon as we attach (especially
   under `window-size smallest` on the target). `bootstrap()` follows
   up with `refresh-client -C 500x200` as a belt-and-suspenders for
   environments where stty cols/rows is unsupported. **iTerm2-compatible
   invocation — don't "simplify" it.** ssh is spawned with
   `-o ControlMaster=auto -o ControlPath=<ctrlDir>/<8-uuid>.sock` so
   image-transfer can reuse the authenticated connection.
3. `bridge/src/tmuxControlClient.ts` parses the control protocol:
   `%output %<pane> <escaped-bytes>`, `%window-pane-changed @<win> %<pane>`,
   `%session-window-changed $<sess> @<win>`, `%layout-change`, plus
   `%begin..%end` blocks for command responses.
4. `hub.bootstrap(session)` (idempotent — concurrent callers share one
   Promise) queries
   `#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}`
   and `list-panes -t <windowId> -F '#{pane_id}'`, populating state cache.
   `#{window_name}` is placed last and rejoined with
   `parts.slice(9).join('|')` so a literal `|` doesn't desync the split.
5. **Fan-out**: tmux emits `%output` for every pane (not just active).
   `hub.paneOutputListeners` fires every listener; each subscription's
   listener early-returns unless `paneId === subscribedPaneId`. So two
   subscriptions on the same hub can independently watch different
   panes — no extra ssh, no extra tmux.
6. **Active-pane changes** (`%window-pane-changed`) → `hub.scheduleActiveChange`
   debounces 100 ms, then fires `activePaneListeners`.
   `follow-active` subscriptions route through their switch queue
   (which fetches `ensurePaneState`, then issues `paneSwitch` + seed).
   `pinned` subscriptions ignore active-pane changes.
7. **Window switches** (`%session-window-changed`) → re-query active
   pane for the new window + `refreshPaneOrder` → fires
   `windowOrderListeners`. `pinned` subscriptions re-resolve their
   ordinal against the new order.
8. **`%layout-change`** → **clears `paneStates` cache** (split/resize/close
   invalidates cols/rows/cursor) → fires `layoutChangeListeners` +
   `refreshPaneOrder` (so pinned subscriptions re-resolve).
9. **Switch protocol**: when a subscription changes pane, it sets
   `seeding=true`, queues subsequent `%output` for that pane into
   `pendingOutput[]`, calls `hub.captureSeed(paneId, 1000)` (scrollback),
   emits `paneSwitch` then a seed string (`\x1b[?1049l\x1bc` reset →
   optional `\x1b[?1049h` alt-screen → captured content joined with
   CRLF → `CSI cursorY+1;cursorX+1 H`), then flushes pending bytes.
10. **Input**: WS `data` frames from the client → `subscription.sendInput`
    → `hub.sendInput(text)` → `send-keys -t <activePaneId> -H <hex>` —
    every byte hex-encoded so the command line is shell/tmux-quoting-safe.
    Requires tmux 3.0+ for `-H`.
11. **Pane/window nav**: WS `tmux-nav` frames →
    `subscription.tmuxNav(action)` or `subscription.selectPane(index)`,
    both delegating to `hub` methods. Relative cycle uses
    `select-pane -t <s>:.+/-` or `select-window -t <s>:+/-`. Absolute
    pane jump resolves the ordinal via `list-panes -t <s> -F '#{pane_id}'`
    (correct regardless of the target's `pane-base-index`); out-of-range
    is a silent no-op. The resulting `%window-pane-changed` flows
    through the hub fan-out — no separate ack frame.
12. **Pin / unpin**: WS `subscribe-pane` frame with `ordinal` field.
    `0` → `subscription.unpin()` → back to follow-active.
    `≥1` → `subscription.pinOrdinal(n)` → resolve and apply (fires
    `paneSwitch` if resolvable, `paneUnavailable` otherwise).
13. **Error surfacing**: ssh stderr is rolling-buffered (last 1 KB) and
    appended to every subscription's exit reason as the last non-empty
    line — so `can't find session: main` or `Permission denied`
    surfaces in the mobile status line. Stderr alone with exit 0 does
    NOT escalate.

### WS frames added for spectator

Server → client:

```jsonc
{"type": "pane-switch", "paneId": "%12", "cols": 200, "rows": 50,
 "altScreen": true, "windowIndex": "3", "windowName": "dev",
 "paneOrdinal": 2, "paneCount": 4}
{"type": "pane-resize", "cols": 220, "rows": 50}
{"type": "pane-unavailable", "pinnedOrdinal": 3, "paneCount": 2}
```

`pane-unavailable` fires when a pinned subscription's ordinal exceeds
the current window's pane count. The client shows a yellow banner;
when pane count returns to ≥ ordinal (split/new window), the next
`%layout-change` re-resolves and a fresh `pane-switch` clears the
banner.

Client → server (spectator mode only):

```jsonc
{"type": "data", "d": "y\r"}                           // 보내기 popup
{"type": "tmux-nav", "action": "next-window"}          // » button / Ctrl+Shift+L
{"type": "tmux-nav", "action": "prev-window"}          // « button / Ctrl+Shift+H
{"type": "tmux-nav", "action": "next-pane"}            // Ctrl+L (relative)
{"type": "tmux-nav", "action": "prev-pane"}            // Ctrl+H (relative)
{"type": "tmux-nav", "action": "select-pane", "index": 2}  // 1–4 buttons (1-based)
{"type": "subscribe-pane", "ordinal": 3}               // pin to ordinal 3
{"type": "subscribe-pane", "ordinal": 0}               // unpin → follow-active
```

`data` frames are unchanged from shell mode. `resize` frames are still
dropped in spectator mode (bridge dictates size from tmux).

### Pin (자물쇠 🔒) — ordinal-based pane subscription

Spectator footer 1–N buttons show the current window's panes. Clicking
the **already-active** ordinal toggles pin mode. While pinned:

- `client.subscribePane(ordinal)` is sent on every relevant transition;
  the bridge's `SpectatorSubscription` switches to `{ kind: 'pinned',
  ordinal: N }` and resolves against `currentWindowPaneOrder`.
- The persistence form is `spectate: <session>:<N>` in the note body
  (e.g. `spectate: main:3`). The parser surfaces this on load and the
  client re-sends `subscribePane(N)` after the first `pane-switch`.
- Pin is **ordinal-based**, not paneId-based. Window switch → new
  window's ordinal-N pane. Layout change → re-resolve against the new
  pane order. Out-of-range → yellow `pane-unavailable` banner with
  `(pinnedOrdinal, paneCount)`. Restoring ≥ ordinal panes → next
  `%layout-change` clears the banner via fresh `pane-switch`.
- The other footer ordinal buttons + `Ctrl+H/L` shortcuts are disabled
  while pinned (no accidental unpin via nav). `Ctrl+Shift+H/L` window
  shortcuts and `«`/`»` stay active.
- Clicking/typing on a pinned note ALSO calls `hub.selectPane(N)` so
  the desktop active follows — pin doesn't desync the desktop view,
  it just guarantees the mobile view stays on N.

Input
wiring in spectator mode is **viewport-conditional**: on desktop
(`min-width: 768px`) `term.onData` is wired straight to `client.send`
so typing into a focused xterm feels like a real terminal; on mobile
the wiring is skipped (the closure early-returns) so the on-screen
keyboard / accidental touches stay inert and explicit input flows
only through the "보내기" popup. The popup itself is also gated
`{#if isMobile}` — desktop users use the keyboard. The breakpoint is
read live inside the `onData` closure, so a viewport resize crossing
768 px takes effect on the next keystroke without re-wiring. `tmux-nav`
actions are whitelisted on the server (`TMUX_NAV_ACTIONS` set in
`server.ts`) — unknown actions are dropped silently.

### Client-side behavior in spectator mode

`TerminalView.svelte` branches via `const isSpectator = $derived(!!spec.spectate)`:

- No `FitAddon` — bridge dictates pane dimensions; `term.resize(cols, rows)`
  is driven by `pane-switch` / `pane-resize` callbacks.
- No OSC 133 handler registered → no command history capture.
- `term.onData` → `client.send` wiring is **desktop-only**. On mobile
  (`isMobile` = `!matchMedia('(min-width: 768px)')`), the handler
  early-returns so the on-screen keyboard stays inert and explicit
  input flows only through the 보내기 popup. On desktop, typing into
  a focused xterm sends keystrokes directly to the active pane via
  the same `send-keys -H` path — natural terminal feel, no popup
  hop. `isMobile` is reactive, so a viewport crossing 768 px is
  honored on the next keystroke.
- No `runConnectScript` on `'open'`.
- No history panel toggle in the header; `connect:` / `pinned:` /
  `history:` sections (if accidentally present) are still parsed but
  hidden in the UI.
- Header shows `관전: tmux <session> · <pane_id> · <cols>×<rows>` instead
  of the bridge URL line.
- **Width-fit via `transform: scale`** — three-layer DOM
  `.xterm-host > .xterm-stage > .xterm-mount` where the mount holds the
  xterm at its natural cell dimensions and `transform: scale(s)` shrinks
  it, while the stage carries an explicit scaled-pixel layout box so
  `.xterm-host { overflow-y: auto }` can compute scroll bounds.
  `applySpectatorFit()` reads `.xterm-screen.offsetWidth/Height` (the
  source of truth for natural size), divides by `host.clientWidth`, and
  clamps the scale at 1 so we never enlarge. **`transform: scale` not
  CSS `zoom`** — the latter interacts badly with xterm's
  absolutely-positioned cell spans on mobile Safari/Chrome (glyphs
  collapse to the left at fractional values).
- **Native touch scroll** — `.xterm-host` has `overflow-y: auto;
  -webkit-overflow-scrolling: touch`. Vertical drag works out of the
  box; no explicit scroll buttons. Alt-screen TUIs (claude code, vim)
  have no xterm scrollback at all — use the 보내기 popup's `PgUp`/`PgDn`
  for in-app scroll.
- **Bottom spectator footer (`.spec-footer`)** — two rows:
  - Top row (`.spec-windowbar`): current window label
    `[<window_index>] <window_name>` (or "윈도우 정보 대기 중…"
    until the first `pane-switch` lands). Updated on every pane-switch.
  - Bottom row (`.spec-controls`): nav button group `« 1 2 3 4 »` —
    `«`/`»` cycle windows, the `1`–`4` (`.pane-num`) buttons jump
    straight to that-numbered pane (`selectPane(n)` → `client.selectPane`
    → `tmux-nav` `select-pane` frame). Plus a 보내기 button **only on
    mobile** (`{#if isMobile}`). On desktop the popup is unnecessary —
    direct keyboard input handles every case the popup was built for.
- **Desktop keyboard shortcuts** (spectator only — in shell mode the
  same combos would clobber the user's own Ctrl+H/L on the remote
  shell). Window-level `keydown` listener registered with
  `capture: true` so it fires BEFORE xterm's textarea processes the
  key — otherwise Ctrl+L would be converted to `^L` (clear-screen)
  and shipped to the shell. Scoped via
  `pageEl.contains(document.activeElement)` so multiple terminal
  windows don't all respond:
  - `Ctrl+H` → `tmuxNav('prev-pane')` (relative pane cycle — no button;
    the footer's `1`–`4` are the absolute equivalent)
  - `Ctrl+L` → `tmuxNav('next-pane')` (relative pane cycle — no button)
  - `Ctrl+Shift+H` → `tmuxNav('prev-window')` (matches `«`)
  - `Ctrl+Shift+L` → `tmuxNav('next-window')` (matches `»`)
- **Focus retention.** `term.focus()` is called in `onMount` and at
  the end of `reconnect()` so the user can type immediately without
  clicking the xterm canvas first. `.terminal-page` carries a bubble
  `onclick` that calls `refocusTerminal()` — header/footer button
  clicks run their own handlers first (bubble), then our handler
  steals focus back to xterm. This makes typing work whenever the
  note (window) is the active surface, not just when xterm itself
  has focus. Mobile spectator skips both (`keyboardEnabled` derived
  is false), so the OSK doesn't pop on entry. The svelte-ignore
  pair on the wrapper div is intentional: the click handler is a
  passive focus-redirect, not a new interaction surface.
    - `«` / `»` map to `tmuxNav('prev-window' | 'next-window')`; the
      `1`–`4` buttons map to `selectPane(n)`. All disabled while
      `status !== 'open'`. Bridge issues `select-window -t <s>:+/-`
      (windows) or `select-pane -t %<paneId>` after a `list-panes`
      ordinal resolve (panes); we don't local-track state — the
      resulting `%window-pane-changed` flows back through the normal
      seed path. Because nav happens on the bridge's control client,
      it also changes the desktop client's view (same tmux session
      = same active window/pane per the `:.+/-` and `:+/-` targets).
- **보내기 popup** — modal with text input + quick-key row
  (`y ↵ n ↵ 1 ↵ ↵ Esc ^C PgUp PgDn`) + actions
  (`취소 / 타이핑만 / 엔터로 실행`). Enter in the field = "엔터로 실행"
  (text + `\r`); Esc = cancel. **IME composition guard** — `!e.isComposing`
  on the Enter/Escape handler so mid-composition Hangul/Japanese/Chinese
  candidates don't submit prematurely. Quick-key buttons send literal
  sequences immediately, e.g. `\x03` for ^C, `\x1b[5~` for PgUp. All
  input flows through `client.send(text)` → bridge `sendInput` → tmux
  `send-keys -H`.

### Sticky modifier 칩 (Ctrl / Alt / Shift)

데스크탑 관전 모드의 페이지-레벨 keydown 리스너가 `Ctrl+L`을 next-pane으로
가로채므로 셸의 "화면 클리어" 단축키를 직접 보낼 수 없다. Sticky modifier
칩은 이 충돌을 우회하는 명시적 opt-in 경로다.

**UI**: `.spec-windowbar` 안에 윈도우 라벨 오른쪽으로 [Ctrl] [Alt] [Shift]
토글 칩 3개. 클릭하면 해당 mod가 armed 상태 (#6cf 채워진 배경). 한 번 더
클릭하면 해제. 여러 mod 동시 armed 가능 (Ctrl+Alt+x 등). `{#if isSpectator}`
가드 안이라 셸 모드에서는 노출되지 않는다. `disabled={status !== 'open'}`로
연결 안 됐을 때 비활성. CSS는 `.spec-windowbar` 컨테이너로 한정 (`.spec-footer
button` 광역 규칙을 이기기 위해).

**키 매핑** (`stickyMods.ts:computeStickyKeySequence`):

| 키 종류 | Ctrl | Alt | Ctrl+Alt | Shift | Ctrl+Shift |
|---|---|---|---|---|---|
| letter (a-z) | `c & 0x1F` | `\x1b + c` | `\x1b + (c&0x1F)` | upper(c) | (c&0x1F) |
| printable (숫자/기호) | null | `\x1b + c` | null | c 그대로 | null |
| Enter/BS/ESC/Tab | null | `\x1b + seq` | null | null | null |
| 그 외 (화살표/F-키) | null | null | null | null | null |

null 반환 시 sticky **유지** + 원본 키 정상 전송.

**데스크탑 통합**: `handleWindowKeydown` capture-phase 리스너에서 기존
pane-nav 분기 **이전**에 sticky 검사. armed + 대응 키 → `computeStickyKeySequence`
결과를 `client.send`, `resetStickyMods()`, `preventDefault + stopPropagation`.
비대응 키 → `preventDefault` 없이 함수만 종료 → 이벤트가 target 단계로 흘러
xterm이 정상 처리, sticky는 유지. sticky 분기는 무조건 return — pane-nav로
떨어지지 않음. 재연결 (`reconnect()`) 시 자동 reset.

**모바일 통합**: 보내기 팝업 헤더에 `[Ctrl+][Alt+][Shift+] 다음 키에 적용됩니다`
armed 뱃지 (role="status"). "타이핑만"/"엔터로 실행" 양쪽이 `applyStickyToText`로
**텍스트 첫 글자**를 변환. 첫 글자 대응 → 변환된 텍스트 + (autoExecute면 `\r`)
전송 + reset. 첫 글자 비대응 → 원본 텍스트 전송, sticky 유지. 빈 텍스트 +
autoExecute + Alt만 armed → `\x1b\r` + reset. 퀵키 버튼 (`y`, `n`, `^C`,
`PgUp` 등)은 `sendQuickKey`를 거치므로 sticky 무관하게 그대로 동작 +
armed 상태 유지. 팝업 취소도 sticky 유지.

**기존 Ctrl+H/L pane-nav 단축키는 그대로 유지.** Sticky는 추가 메커니즘.
실제 키보드 `Ctrl+L` → next-pane; sticky-Ctrl + 키보드 `L` → 셸로 `\x0c`.

**더블탭 단축키 (`stickyDoubleTap.ts`)**: Ctrl/Alt/Shift 중 하나를 단독으로
두 번 연속 (400 ms 이내) 누르면 해당 칩이 토글된다 — 클릭과 동일한 효과,
armed/해제 양방향. 데스크탑 관전 모드 전용 (`handleWindowKeydown` +
`handleWindowKeyup` 가 같은 가드 — `isSpectator && !isMobile`). 순수 상태머신
3개 (`onModKeydown` / `onModKeyup` / `onNonModKeydown`) + `DoubleTapState`
{`primingMod`, `primingTime`, `pendingMod`}. **Clean keydown → keyup → keydown**
패턴만 인식: 사이에 다른 키 (modifier 포함) 가 끼이거나 keyup 시 다른 modifier
가 여전히 held 상태면 priming 취소. 즉 `Ctrl+L` 콤보는 Ctrl 더블탭으로 오인되지
않음. `e.repeat` keydown 은 ignore (홀딩으로 인한 오토리피트 무시). `reconnect()`
시 `INITIAL_DOUBLE_TAP_STATE` 로 리셋. 키 시퀀스 변환 (`computeStickyKeySequence`)
와 독립적인 별도 모듈 — 두 머신을 한 함수에 합치지 말 것.

### Target-side tmux configuration

To prevent the desktop's working window from shrinking when a small
mobile spectator client attaches:

```tmux
set -g window-size smallest
set -g focus-events on
set -g aggressive-resize on   # tmux-sensible already does this on Linux
```

Drop-in plugin: `bridge/deploy/tomboy-spectator.tmux` — tpm-compatible,
also runnable via `run-shell /path/to/tomboy-spectator.tmux` from
`.tmux.conf`.

**The crucial pair is `window-size smallest` + bridge claims 500x200.**
The bridge's ssh -tt + tmux -CC attach happens with no local TTY, so
ssh's default PTY is 80x24. Without intervention, tmux's `window-size`
policy would either:
- `latest` (tmux 3.x default): spectator's initial attach counts as
  "most recent activity" and shrinks the window to 80x24 — the exact
  symptom seen when the desktop monitor is off and the desktop client
  is idle.
- `smallest`: the bridge's 80x24 would still be smallest and shrink
  the window.

The fix is two-sided: the bridge claims a virtual 500x200 size (via
`stty cols 500 rows 200` before tmux attaches + `refresh-client -C
500x200` immediately after — see `spectatorSession.ts`), and the
target uses `window-size smallest` so the real desktop client (usually
~200x60) wins. iTerm2's tmux integration uses the same trick.

`aggressive-resize on` further scopes any resize impact to the
currently-viewed window per client, so even if a fallback path
fires, only the spectated window is affected — not the rest of the
session.

For users who already have a heavy `.tmux.conf` it's usually cleaner
to add the three lines inline than to source the plugin file.

### Spectator-mode constraints worth caching

- **tmux 3.0+** required for `send-keys -H` (hex input). tmux 2.x targets
  the spectator can still attach + view, but the 보내기 popup will fail
  silently (error logged to bridge stderr).
- **Same ssh user as the desktop tmux session owner** — tmux server
  sockets are per-user. The note's `ssh://user@host` must reach the same
  user that owns the session socket on the target.
- **Session must exist on attach** — bridge does NOT `new-session`. tmux
  exits with an error and the spectator session terminates; the error
  surfaces as the ssh stderr tail in the exit reason.
- **No share token / discovery channel** — the spectator note is just a
  regular Tomboy note that the user creates and (optionally) syncs via
  Dropbox/Firebase. Bearer + ssh credentials are the entire auth surface,
  exactly the same as a regular terminal note. **The mobile popup CAN
  inject input** into the active pane — same trust boundary as opening
  the regular terminal note on mobile and typing.
- **`pane-switch` re-seeds via `capture-pane -epJ -S -1000`** — last
  1000 lines of scrollback (constant `SCROLLBACK_SEED_LINES` in
  `spectatorHub.ts`). Cursor position is appended at the end via
  `CSI <y>;<x> H`.
- **tmux 2.1+ required** for control mode. Modern distros are fine.
- **Subscription filter is per-pane id** — each `SpectatorSubscription`
  early-returns unless `paneId === subscribedPaneId`. Pane ids (`%N`)
  are stable for a pane's lifetime; closing a pane and opening a new
  one yields a new id, which fires `%window-pane-changed` (follow-active
  re-seeds) or `%layout-change` (pinned re-resolves).
- **Hub state cache is invalidated on `%layout-change`** — `paneStates`
  is fully cleared so the next `ensurePaneState` re-fetches cols / rows
  / cursor. Without this, split/resize would seed the new pane with
  stale geometry. Test: `spectatorHub.test.ts:layout-change invalidates
  paneStates cache`.
- **Seeding races resolved by buffering**: `pendingOutput[]` accumulates
  `%output` for the new pane while `capture-pane` is in flight, then
  drains after the seed lands. No seed-after-live ordering possible.
- **Concurrent switchTo coalescing**: `processSwitchQueue` records the
  latest desired paneId; if a switch is in flight, the in-flight call
  loops to pick it up after completing. Prevents two rapid `pane-switch`
  events from racing and corrupting `seeding` / `pendingOutput` state.
- **Nested tmux** — the outer tmux's `%window-pane-changed` is what we
  track. Inner-tmux pane switches happen entirely within the outer pane's
  byte stream and are invisible to the spectator as discrete events.
- **Spectator MUST NOT constrain window size.** The bridge claims a
  virtual 500x200 PTY (stty + refresh-client) and the target must run
  `window-size smallest` — if either half is missing, attaching the
  spectator shrinks the desktop user's window. `window-size latest`
  (the previous setting) breaks specifically when the desktop client
  has been idle, because the spectator's attach counts as the most
  recent activity. Don't "simplify" by dropping the stty line or
  switching back to `latest`.
- **Nav buttons drive both views.** `«` `»` (`:+/-` window targets) and
  the `1`–`4` pane buttons (`select-pane -t %<paneId>`) all change the
  SESSION's active pane/window — affecting the desktop user's view too.
  This is intentional (mobile is acting AS the user). If you ever want
  spectator-private navigation, you'd need per-client `switch-client`
  semantics, which tmux's control mode doesn't cleanly support.
- **Sticky modifier 칩은 관전 모드 전용 + 휘발성.** `stickyMods.ts`는 순수
  함수, `TerminalView.svelte`의 `$state`로만 보관. 노트 포맷 / 브릿지 /
  WS 프로토콜 변경 없음. 셸 모드에서는 칩이 렌더되지 않는다 — 셸 모드는
  `term.onData` 직결이라 키 가로채기가 없어 충돌이 없기 때문. 재연결 시
  `resetStickyMods()`로 자동 초기화. 비대응 키 조합(예: Ctrl + Tab)은
  sticky를 소비하지 않고 유지 — 사용자가 다음 글자 키를 칠 때 적용.
- **더블탭 토글은 데스크탑 관전 모드 한정.** Ctrl/Alt/Shift 단독 두 번 (400 ms)
  → 칩 토글. 별도 `keyup` 리스너를 같이 등록해야 priming 이 일어나므로 단축키
  도입 시 keyup 등록을 빠뜨리지 말 것. 콤보 (`Ctrl+L`) 가 더블탭으로 오인되지
  않도록 `pendingMod` 가 매개 — 비-modifier keydown 또는 keyup-while-other-held
  는 즉시 상태 클리어. 모바일에서는 keydown listener 자체가 `isMobile` 가드로
  early-return 이므로 화면 키보드 영향 없음.

## 이미지 붙여넣기

터미널 노트에서 이미지를 원격 호스트로 전송하고 경로를 활성 패널에 주입한다.
셸 모드와 관전(spectator) 모드 모두 지원한다.

### 셸 모드

**트리거 세 가지 (TerminalView.svelte, `isSpectator` false):**

1. **Ctrl+V** — capture-phase `paste` 이벤트에서 `ClipboardEvent.clipboardData.items`
   를 순회해 `image/*` 항목을 추출.
2. **드래그 앤 드롭** — `drop` 이벤트에서 `DataTransfer.files`를 통해 이미지 파일 추출.
3. **"이미지" 버튼** — 헤더 버튼; 모바일에서는 `accept="image/*" capture="environment"`
   `<input type="file">` 로 카메라/갤러리를 열고, 데스크탑에서는 파일 선택 다이얼로그.

**전송 흐름:**

1. `imagePasteClient.ts` — `validateImageFile` (10 MB 상한, MIME 검증),
   `fileToImagePayload` (Base64 인코딩) → `wsClient.sendImage({type:'image', mime, data})`.
2. `bridge/src/server.ts` — `image` 메시지 수신.
   PTY SSH 연결은 ControlMaster 마스터(`-o ControlMaster=auto -o ControlPath=/tmp/tomboy-ctl/<uuid>.sock`)
   로 스폰된다. 마스터 소켓이 살아 있는 동안 이미지 전송 시 재인증 없이 연결을 재사용한다.
3. `bridge/src/imageTransfer.ts:transferImage` — 로컬 타겟(`isLocalTarget`: user 없는 localhost)이면
   파일을 브릿지 호스트에 직접 기록. 원격 타겟이면
   `ssh -o ControlPath=<sock> -o BatchMode=yes user@host 'mkdir -p /tmp/tomboy-images && cat > <safe-path>'`
   를 stdin 파이프로 실행해 이미지 바이트를 원격에 기록.
4. 전송 성공 후 브릿지는 `\x1b[200~<remotePath>\x1b[201~ ` (bracketed paste + trailing space)
   를 PTY에 기록한다(`pty.write`). 셸/Claude Code는 이것을 붙여넣기로 인식해 경로를
   커맨드라인에 삽입한다.
5. `wsClient.ts:onImageResult` 콜백이 성공/실패 여부를 `TerminalView`에 알려
   로딩 상태를 해제한다.

### 관전 모드 데스크탑

**트리거** — 셸 모드와 동일 (Ctrl+V / 드래그앤드롭 / 헤더 "이미지" 버튼) — Task 5에서 `isSpectator` 가드가 풀려 양 모드에서 동일 트리거가 발화한다.

**전송 흐름:**

- Hub의 ssh 연결이 ControlMaster 마스터
  (`-o ControlMaster=auto -o ControlPath=/tmp/tomboy-ctl/<8자 uuid>.sock`)로
  스폰되어 있고, 같은 hub를 공유하는 모든 노트가 이 마스터 소켓을 통해
  재인증 없이 이미지를 업로드한다. 셸 모드와 동일한 ControlMaster 패턴.
- `handleImageMessage` 분기에서 `subscription.hasActivePane()`이 false면 즉시
  `image-error` 회신 (첫 pane-switch 프레임 전 race guard).
- `imageTransfer.transferImage(subscription.controlPath, ...)` — hub의
  소켓 경로를 재사용한 업로드.
- 경로 주입은 `pty.write` 대신 `subscription.sendInput(bracketedPaste(path))`
  → `hub.sendInput` → `tmux send-keys -t <activePane> -H <hex>`로
  hub의 현재 활성 패널에 binary-safe 주입.

### 관전 모드 모바일

**트리거** — 보내기 팝업의 두 버튼:

1. **"📋 이미지 붙여넣기"** — `navigator.clipboard.read()`로 `ClipboardItem` 배열을 읽어
   `clipboardImage.ts:extractImageFromClipboardItems`로 첫 `image/*` 항목을 `File`로 변환 후 전송.
2. **"📷 이미지 불러오기"** — `<input type="file" accept="image/*">` 파일 선택기.

팝업의 텍스트 입력 필드(`<input type="text">`)에 `onpaste` 핸들러도 달려 있어 롱프레스 붙여넣기로
이미지를 가로챈다. 전송 경로는 관전 모드 데스크탑과 동일
(`subscription.sendInput` → `hub.sendInput` → `tmux send-keys -H`).

**안전 파일명** — `safeImageName` (`imageTransfer.ts`)이 MIME에서 확장자를 파생하고
`tomboy-<unix-ms>-<4바이트 hex>.<ext>` 패턴으로 이름을 만든다 — 셸 메타문자가 없어
원격 `cat >` 경로에 셸 인젝션이 없다.

**maxPayload** — 브릿지 WS 서버를 `maxPayload: 16 * 1024 * 1024`로 초기화한다
(기본 1 MiB에서 변경; 10 MB 이미지의 base64 인코딩 ≈ 13.3 MB를 수용).

**WS 프레임 추가 (이미지):**

클라이언트 → 서버:
```jsonc
{"type": "image", "mime": "image/png", "data": "<base64>"}
```
서버 → 클라이언트:
```jsonc
{"type": "image-ok", "path": "/tmp/tomboy-images/tomboy-1716000000000-a1b2c3d4.png"}
{"type": "image-error", "message": "transfer failed: ..."}
```

**불변 조건:**
- 이미지 붙여넣기는 셸·관전 양 모드 모두 지원. 셸은 `pty.write(bracketedPaste(path))`, 관전은 `subscription.sendInput(bracketedPaste(path))` → `hub.sendInput` → `tmux send-keys -H <hex>`. 두 경로 모두 ControlMaster 멀티플렉싱으로 재인증 없이 업로드.
- 셸 모드의 ControlMaster 마스터 소켓은 PTY ssh 연결이, 관전 모드는 **hub의 ssh 연결**이 생성한다. 셸 소켓은 `WS close` 시 `unlink(controlPath)`로 정리. 관전 소켓은 hub destroy 시(`마지막 subscription.close()`) hub가 unlink한다 — `server.ts`는 spectator controlPath 소유권을 갖지 않는다 (hub-owned). ssh 마스터 프로세스 자체는 `pty.kill()` / `hub.ssh.kill()`로 함께 정리된다.
- 관전 모드에서 `transferImage` 후 `subscription.hasActivePane()`이 false면 `image-error` 즉시 반환 — race guard (파일은 이미 원격 `/tmp/tomboy-images/`에 기록된 상태).
- 안전 파일명은 브릿지가 생성한다 — 노트 포맷에 경로 힌트 필드를 추가하지 말 것.
- 로컬 타겟 경로는 브릿지 컨테이너 내부다. 볼륨 마운트 없이 외부에서 볼 수 없다.

## 터미널 벨 (shell mode only)

xterm이 `\x07` (BEL) 바이트를 받으면 짧은 비프음과 진동이 발생한다.
관전 모드는 제외한다 — 데스크탑이 이미 시스템 벨을 낸다.

**구현 (`terminalBell.ts`):**

- `term.onBell(() => ringBell())` — TerminalView.svelte에서 셸 모드 onMount 시 등록.
- `ringBell()` — Web Audio API로 880 Hz 사인파(OscillatorNode)를 약 150 ms 재생.
  10 ms attack + 60 ms release 엔벨로프로 클릭음 방지.
  `AudioContext` 인스턴스는 싱글톤으로 지연 생성(브라우저 자동재생 정책 회피).
  `navigator.vibrate(200)` 병렬 호출(지원 안 되면 무시).
- **스로틀** — 마지막 벨로부터 300 ms 이내에 추가 BEL이 오면 무시. 연속 BEL 폭탄 방지.
- **`terminalBellEnabled` 설정** — `appSettings.terminalBellEnabled` (boolean, 기본 `true`).
  설정 → 터미널 브릿지 섹션에 토글 추가.

**수동 QA 참고사항:**

- tmux 대상에서는 `bell-action` 설정이 적용된다. `set -g bell-action any`이어야
  백그라운드 창 BEL이 클라이언트로 전달된다.
- `visual-bell on`이면 tmux가 BEL 대신 시각 신호만 내므로 클라이언트 onBell이 호출되지 않는다.

## Invariants

- **Pi 브릿지는 GPU가 없다 (Bridge ≠ model host).** 브릿지는 라우팅·인증·SSH
  터미널만 담당하고 모델(Ollama, ocr-service, llama.cpp 등)은 절대
  호스팅하지 않는다. 모든 모델은 별도 데스크탑(RTX 3080)에서 실행되며
  브릿지가 `OLLAMA_BASE_URL`, `OCR_SERVICE_URL`, `RAG_SEARCH_URL` 환경변수로
  데스크탑 LAN IP 를 가리킨다. **같은 머신을 가정하면 안 된다** — 과거에
  이 가정 때문에 OCR 분리 작업과 RAG 도입에서 잘못된 설계로 되돌린 적이 있다.
- **Note body = 1–3 metadata paragraphs (ssh URL + optional `bridge:` + optional `spectate:`, any order) + optional `connect:` / `pinned:` / `history:` sections.** A 4th free paragraph (or any non-recognized block) means it's no longer a terminal note — by design, so users opt out simply by typing more.
- **Default view is the editor.** Terminal notes open in `<TomboyEditor>` with a banner; clicking 접속 sets `terminalConnectMode = true` and starts the WS session. "편집 모드" sets it back to false. There is no separate "terminal edit mode" flag.
- **`connect:` is single-bucket only** — no `connect:tmux:...` variant. On every WS `'open'` transition, `runConnectScript` sends each item as `text + '\r'` in order with a 50 ms gap. The `connectFired` flag in `TerminalView.svelte` ensures one run per open lifetime; reconnect resets it so the next open re-runs.
- **Client `status='open'` is gated on the bridge's `{type:'ready'}` frame, not on the WebSocket handshake.** The bridge emits `ready` after `spawnForTarget` returns + `pty.onData/onExit` are wired. Without this gate, `data` frames sent during the async spawn are dropped by `if (!pty) return` in the bridge. The 3 s `READY_FALLBACK_MS` timer in `wsClient.ts` keeps older bridges working.
- **`pinned:` mirrors `history:` per-bucket layout but has no capacity cap.** Pinning a history item moves it to pinned (single physical existence per bucket); unpinning prepends it back to the top of history. Each panel row shows a star toggle: ★ (pinned) / ☆ (not pinned), plus a × delete button.
- **`history:` header text is fixed** — exactly that string, not localized. Same for `connect:` and `pinned:`.
- **History items are plain text only.** Marks ignored, nested lists ignored.
- **History capacity = 20, FIFO + move-to-top dedup.** Older items are dropped when a new command pushes the list past the cap. Pinned items are not counted.
- **Per-item × delete** removes a row immediately with no confirm. The panel header's ⌫ (clear-all bucket) still goes through `confirm(...)`.
- **Serializer emits sections in fixed order:** `connect:` → `pinned:` (sorted, non-tmux first) → `history:` (sorted, non-tmux first). Empty sections are dropped — do not preserve empty headers.
- **`TerminalNoteSpec` has `connect: string[]` and `pinneds: Map<string, string[]>`** in addition to existing `histories` and `history`.
- **Re-input does not auto-press Enter.** Click stages text into the prompt; Shift+click sends `\r`. The user explicitly executes.
- **Whitespace-prefixed commands are NOT captured** (HISTCONTROL=ignorespace convention). Use a leading space to keep a one-off command out of history.
- **OSC 133 shell integration is opt-in per remote** — without the snippet installed, capture is NO-OP and the existing terminal note behaviour is 100% unchanged.
- **No credentials in the note.** The parser intentionally rejects malformed lines but does not validate SSH passwords or keys — those flow through the PTY. Don't add a `password:` field to the note format.
- **Terminal output is ephemeral.** It's never written back to `xmlContent`. Closing or navigating away discards the scrollback.
- **Bearer tokens, not cookies.** Sent on the first WS frame and on `/health` via `Authorization: Bearer ...`. Never put the password in the note, the URL, or the WebSocket frame.
- **`BRIDGE_SECRET` is stable across restarts.** Rotating it invalidates every issued token and every active session sees `unauthorized` on its next reconnect.
- **`ssh://localhost` and `ssh://user@localhost` mean different things.** The former drops into the container's own shell (because `!t.user` is true); the latter forces the ssh path to the host. The containerized deployment relies on the latter — write `ssh://you@localhost` in notes that target the bridge's host.
- **`history:` (non-tmux) and `history:tmux:<window_id>:` are independent buckets.** Dedup, 20-cap, and debounce all apply per-bucket. Never introduce cross-bucket dedup.
- **Window key uses `@<window_id>` only** — session_id is intentionally not part of the key. Keys stay stable for the lifetime of a tmux window, which matches the user's working unit.
- **PS1 polls the shell context on every prompt.** The shell snippet emits `OSC 133 ; W ; <window_id>` (inside tmux) or `OSC 133 ; W` (outside) at every prompt. This single signal handles tmux start, last-shell exit, attach, window switch, and outside-tmux automatically — `currentWindowKey` is always in sync with what the next command will do. `;C;<hex>;<id>` payload (or its absence) is the secondary correctness baseline.
- **`after-select-window` and `client-attached` hooks are optional micro-optimizations.** They only matter for two no-prompt-redraw transitions (window switch while idle; attach while the active shell already sat at a prompt) where they reduce panel-update latency from "next prompt" to "instant." Detach is the one transition we can't catch instantly — the panel updates on the user's next prompt in the outside shell.
- **The bridge has full shell access** to whatever host runs it. `BRIDGE_PASSWORD` is the only line of defense — front it with TLS + fail2ban while it's publicly reachable.
- **WOL config lives only in `hosts.json`, never in the note.** The note format stays unchanged (`ssh://[user@]host[:port]` + optional `bridge:`). Don't add a `wol:` field — that would couple a per-device secret-ish (MAC) to the synced note text and wouldn't survive bridge swaps.
- **WOL is purely opt-in by config.** Hosts not in `hosts.json` skip the wake step entirely and behave exactly as before. There is no auto-discovery of MACs.
- **WOL is gated by an immediate TCP probe.** If the ssh port is already open, the bridge skips the magic packet and any "깨우는 중..." message. So enabling WOL for an always-on host is a no-op, not a cost.
- **Polling is bounded by `wakeTimeoutSec` (default 60).** Tune per host: cold-boot Windows machines can need 60–90 s, suspended Linux laptops < 10 s. The polling aborts immediately on WS close.
- **Spectator hub is shared per `(target, session)`.** Multiple notes
  spectating the same tmux session reuse a single ssh + tmux -CC
  client + single ControlMaster socket. Each `SpectatorSubscription`
  filters `%output` to its own `subscribedPaneId`. Last subscription
  close → `hub.destroy()` immediately (no grace timer): ssh kill +
  tmux close + socket unlink. Hub state cache (`paneStates`) is the
  single source of truth across all subscriptions for that hub.
- **Pin is ordinal-based, not paneId-based.** `spectate: <s>:<N>` persists
  the ordinal; `subscribe-pane`/`pane-unavailable` WS frames carry the
  ordinal model. Window switch + layout change both trigger
  re-resolution against `currentWindowPaneOrder`. Don't introduce a
  pin-by-paneId variant — pane ids change when panes are closed and
  recreated; the ordinal is what the user perceives.
- **`server.ts` does NOT own spectator controlPath.** The hub owns its
  ssh + ControlMaster socket. Server stores `controlPath` only for
  shell-mode PTY connections. Mixing the two ownership models was the
  bug class that the hub refactor fixed.
- **Future improvement ideas:** see `docs/tmux-note-integration.md` for the integration roadmap.

## Tests

`app/tests/unit/editor/parseTerminalNote.test.ts` covers the parser
exhaustively (1-line / 2-line / trailing empty / leading empty / bad
port / bad scheme / non-paragraph / hardBreak / inline image / unicode
host). The bridge has no unit tests; smoke-test by running locally with

```
BRIDGE_PASSWORD=test BRIDGE_SECRET=$(openssl rand -hex 16) \
BRIDGE_ALLOWED_ORIGIN=http://localhost:5173 npm run dev   # in bridge/
```

then opening a terminal note in the dev server.
