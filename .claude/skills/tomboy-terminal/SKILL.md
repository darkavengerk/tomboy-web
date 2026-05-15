---
name: tomboy-terminal
description: Use when working on the terminal-note feature — a note whose body is `ssh://[user@]host[:port]` (optionally followed by `bridge: wss://...` and/or `spectate: <session>`) opens an xterm.js session through a separate WebSocket bridge service. Covers the parser, the WS protocol and Bearer-token auth, the bridge HTTP/WS server (`bridge/`), the rootless Podman + Quadlet deployment with SELinux + user-namespace constraints, the host-sshd requirement, the Caddy reverse proxy in front, and the tmux -CC spectator mode (active-pane follow with `send-keys -H` opt-in input via the mobile 보내기 popup, transform:scale width-fit rendering, native touch scroll, pane/window navigation buttons, and current-window label strip).
---

# 터미널 노트 (SSH terminal in a note)

A note whose body is **1–2 metadata paragraphs + optional `connect:` / `pinned:` / `history:` sections** matching:

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
  result must be 1 or 2 non-empty paragraphs.
- **Non-paragraph blocks** (lists, headings, etc.), **inline images**, or
  a `hardBreak` inside the URL line → reject (regular note).
- `port` must be an integer in `[1, 65535]`; otherwise reject.
- `user`, `port`, `bridge` are all optional. When `bridge` is omitted the
  client falls back to `appSettings.defaultTerminalBridge`.

## Client side

| File | Role |
|------|------|
| `lib/editor/terminal/parseTerminalNote.ts` | Pure parser (above). |
| `lib/editor/terminal/wsClient.ts` | WebSocket protocol wrapper. |
| `lib/editor/terminal/TerminalView.svelte` | xterm.js + FitAddon, header (target/bridge/status/끊김/재연결/편집 모드). |
| `lib/editor/terminal/bridgeSettings.ts` | `appSettings` glue + `/login` `/logout` `/health` HTTP helpers. |
| `lib/editor/terminal/historyStore.ts` | Read-modify-write history/pinned mutation + per-guid serialization + 500ms debounce. Exposes `pinCommandInTerminalHistory`, `unpinCommandInTerminalHistory`. |
| `lib/editor/terminal/connectAutoRun.ts` | Pure `runConnectScript` — sends each `connect:` item as `text + '\r'` with 50 ms gap, skips empty lines, swallows per-line send errors. |
| `lib/editor/terminal/oscCapture.ts` | Pure OSC 133 parser / command-extraction helpers. |
| `lib/editor/terminal/HistoryPanel.svelte` | Desktop side panel + mobile bottom sheet UI for captured history + pinned commands. |
| `routes/note/[id]/+page.svelte` | Mobile route — branches on `parseTerminalNote(editorContent)` at load and after every IDB reload. |
| `lib/desktop/NoteWindow.svelte` | Desktop route — same branch. |
| `routes/settings/+page.svelte` (config tab → "터미널") | Bridge URL + login form + history settings + shell-integration snippet. |

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

## Spectator mode (active-pane follow with opt-in input)

A note with a `spectate:` metadata line is a **read-by-default mirror** of
the currently-focused pane of a tmux session on the target. Useful for
kicking off a long task on the desktop (e.g. claude code) and watching
from a phone while you walk away — with optional explicit-input via the
mobile "보내기" popup for quick confirmations (y/n/Enter).

Note format:

```
ssh://you@desktop
spectate: main            # tmux session name on the target
bridge: wss://b/ws        # optional, order-agnostic with spectate:
```

`spectate:` accepts characters `[A-Za-z0-9_\-./@:]` (gated in
`parseTerminalNote.SPECTATE_RE`); any other character disqualifies the
note from spectator parsing. Lines `spectate:` and `bridge:` may appear
in either order. Duplicates of either reject the note.

### How it works

1. WS `connect` frame carries `mode: 'spectate'` and `session: '<name>'`.
2. Bridge `startSpectator` ssh's into the target with `-tt` and runs
   `stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t <session>` via
   `bridge/src/spectatorSession.ts`. `-tt` forces remote PTY allocation
   (tmux -CC calls `tcgetattr` at startup and exits with "Inappropriate
   ioctl for device" otherwise); `stty raw -echo` disables ECHO/ICANON/ONLCR
   so the binary control protocol passes through unmunged; `exec` replaces
   the shell so signals + exit codes propagate cleanly. **The `stty cols
   500 rows 200` step declares a large fake PTY size BEFORE tmux attaches**
   so the spectator client never constrains the session's window size —
   without it ssh -tt sends the default 80x24 and the desktop user's
   window shrinks as soon as we attach (especially under `window-size
   smallest` on the target). `bootstrap()` follows up with
   `refresh-client -C 500x200` as a belt-and-suspenders for environments
   where stty cols/rows is unsupported (e.g. busybox). **This is the
   iTerm2-compatible invocation, not a workaround we can simplify.**
3. `bridge/src/tmuxControlClient.ts` parses the control protocol:
   `%output %<pane> <escaped-bytes>`, `%window-pane-changed @<win> %<pane>`,
   `%session-window-changed $<sess> @<win>`, `%layout-change`, plus
   `%begin..%end` blocks for `display-message` / `capture-pane` /
   `send-keys` responses.
4. On bootstrap and on every focus change, bridge queries
   `#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{window_index}|#{window_name}`
   then issues `capture-pane -epJ -t %<pane>` and emits a `pane-switch`
   WS frame followed by seed bytes: `\e[?1049l\ec` reset → optional
   `\e[?1049h` alt-screen toggle → captured content → cursor positioning.
   `#{window_name}` is placed last and rejoined with `parts.slice(N).join('|')`
   so a literal `|` in the name doesn't desync the split.
5. Subsequent `%output` for the active pane is forwarded as `data`
   frames; output from non-active panes is dropped.
6. `%window-pane-changed` triggers a 100 ms debounced re-seed (avoids
   flicker when desktop user rapidly cycles panes).
7. `%layout-change` triggers a size re-query; if changed → `pane-resize`
   frame to the client.
8. Bytes-to-text uses a streaming `TextDecoder` keyed per pane (reset on
   switch) so partial UTF-8 sequences across `%output` chunks don't
   surface as replacement chars.
9. **Input**: WS `data` frames from the client are routed to
   `spectator.sendInput(text)` which issues
   `send-keys -t <activePaneId> -H <hex>` — every byte hex-encoded so
   the command line is shell/tmux-quoting-safe regardless of payload
   (control chars, multibyte UTF-8, etc). `resize` frames are still
   dropped (bridge dictates size from tmux). Requires tmux 3.0+ for `-H`.
10. **Pane/window nav**: WS `tmux-nav` frames (`action: 'next-pane' |
    'prev-pane' | 'next-window' | 'prev-window'`) are routed to
    `spectator.tmuxNav(action)` which issues `select-pane -t <s>:.+/-`
    or `select-window -t <s>:+/-`. The resulting `%window-pane-changed`
    / `%session-window-changed` notification flows through the existing
    focus-follow path, so the spectator's view + size + window label
    update naturally — no separate ack frame.
11. **Error surfacing**: ssh stderr is rolling-buffered (last 1 KB) and
    appended to the exit reason as the last non-empty line — so when the
    session dies with e.g. `can't find session: main` or
    `Permission denied`, the user sees it in the mobile status line.
    Stderr alone with exit code 0 (e.g. benign `.bashrc`-sourced
    `command not found` warnings) does NOT escalate to an `error` frame.

### WS frames added for spectator

Server → client:

```jsonc
{"type": "pane-switch", "paneId": "%12", "cols": 200, "rows": 50,
 "altScreen": true, "windowIndex": "3", "windowName": "dev"}
{"type": "pane-resize", "cols": 220, "rows": 50}
```

Client → server (spectator mode only):

```jsonc
{"type": "data", "d": "y\r"}                           // 보내기 popup
{"type": "tmux-nav", "action": "next-pane"}            // « ‹ › » buttons
{"type": "tmux-nav", "action": "prev-pane"}
{"type": "tmux-nav", "action": "next-window"}
{"type": "tmux-nav", "action": "prev-window"}
```

`data` frames are unchanged from shell mode. `resize` frames are still
dropped in spectator mode (bridge dictates size from tmux). Input
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
  - Bottom row (`.spec-controls`): pane/window nav button group
    `« ‹ › »`, plus a 보내기 button **only on mobile** (`{#if isMobile}`).
    On desktop the popup is unnecessary — direct keyboard input
    handles every case the popup was built for.
    - `«` `‹` `›` `»` map to `tmuxNav('prev-window' | 'prev-pane' |
      'next-pane' | 'next-window')` respectively. All disabled while
      `status !== 'open'`. Bridge issues `select-pane -t <s>:.+/-` or
      `select-window -t <s>:+/-`; we don't local-track state — the
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
- **`pane-switch` re-seeds via `capture-pane`** — visible region only by
  default. Pass `-S -<n>` to grab scrollback if needed (currently not
  exposed; the v1 seed is just the visible screen). Cursor position is
  appended at the end via `CSI <y>;<x> H`.
- **tmux 2.1+ required** for control mode. Modern distros are fine.
- **Bridge filter is per-pane id** — `paneId === this.activePaneId`. Pane
  ids (`%N`) are stable for a pane's lifetime; closing a pane and opening
  a new one in its position yields a new id, which fires
  `%window-pane-changed` and we re-seed correctly.
- **Seeding races resolved by buffering**: `pendingOutput[]` accumulates
  `%output` for the new pane while `capture-pane` is in flight, then
  drains after the seed lands. No seed-after-live ordering possible.
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
- **Nav buttons drive both views.** `«` `‹` `›` `»` issue tmux
  commands with `:.+/-` and `:+/-` targets, which change the SESSION's
  active pane/window — affecting the desktop user's view too. This is
  intentional (mobile is acting AS the user). If you ever want
  spectator-private navigation, you'd need per-client `switch-client`
  semantics, which tmux's control mode doesn't cleanly support.

## Invariants

- **Note body = 1–2 metadata paragraphs + optional `connect:` / `pinned:` / `history:` sections.** A 3rd free paragraph (or any non-recognized block) means it's no longer a terminal note — by design, so users opt out simply by typing more.
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
