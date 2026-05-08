---
name: tomboy-terminal
description: Use when working on the terminal-note feature — a note whose body is `ssh://[user@]host[:port]` (optionally followed by `bridge: wss://...`) opens an xterm.js session through a separate WebSocket bridge service. Covers the parser, the WS protocol and Bearer-token auth, the bridge HTTP/WS server (`bridge/`), the rootless Podman + Quadlet deployment with SELinux + user-namespace constraints, the host-sshd requirement, and the Caddy reverse proxy in front. Files in `app/src/lib/editor/terminal/` and `bridge/`.
---

# 터미널 노트 (SSH terminal in a note)

A note whose body is **1–2 metadata paragraphs + an optional `history:` section** matching:

```
ssh://[user@]host[:port]
bridge: wss://my-pc.example.com/ws        # optional
                                           # optional blank
history:                                   # optional, non-tmux bucket
- ls -la
- sudo systemctl restart caddy

history:tmux:@1:                           # optional, per-tmux-window bucket
- htop
- tail -f /var/log/caddy.log
```

is opened as an `xterm.js` terminal instead of the regular editor. The
title can be anything; only the body is constrained. A 3rd free paragraph
(or any non-history block), any list/markup outside the history section(s),
or a malformed section header (or scheme) falls back to a regular note. The note's `.note`
XML stores plain text — Tomboy desktop sees a normal note and
Dropbox/Firebase sync are unchanged. **Terminal output is never
persisted**; it lives only in the open xterm scrollback.

The header has a "편집 모드" toggle that swaps the view back to
`TomboyEditor` for that page-load only — to convert a note out of terminal
mode permanently you edit it to no longer match the format.

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
| `lib/editor/terminal/historyStore.ts` | Read-modify-write history mutation + per-guid serialization + 500ms debounce. |
| `lib/editor/terminal/oscCapture.ts` | Pure OSC 133 parser / command-extraction helpers. |
| `lib/editor/terminal/HistoryPanel.svelte` | Desktop side panel + mobile bottom sheet UI for the captured history. |
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

server → client : { type:'data',  d }
                  { type:'exit',  code }
                  { type:'error', message }
```

The browser's `WebSocket` API can't add custom headers on the upgrade
request, so the bridge defers auth to the first frame. After upgrade the
server holds the connection open for **`AUTH_TIMEOUT_MS = 5000`** waiting
for `connect`; missing or invalid token → close `1008`.

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

## Bridge server — environment

Required env vars (`bridge/src/server.ts:11-14`):

| Var | Purpose |
|-----|---------|
| `BRIDGE_PORT` | TCP port (default 3000). |
| `BRIDGE_PASSWORD` | Login password. |
| `BRIDGE_SECRET` | HMAC key for Bearer token signatures. **Must be stable across restarts** — rotating it invalidates every previously issued token (clients see `unauthorized` on the WS `connect` frame). Generate once with `openssl rand -hex 32` and keep it in `~/.config/term-bridge.env`. |
| `BRIDGE_ALLOWED_ORIGIN` | Comma-separated allowed `Origin` headers for CORS + WS upgrade. Add the Vercel / production app origin alongside any dev origins. |

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

The five lines that have to be exactly right:

```ini
[Container]
Network=host
EnvironmentFile=%h/.config/term-bridge.env
Volume=%h/.ssh:/home/node/.ssh:ro,z
UserNS=keep-id
ReadOnly=true
```

Why each one:

- **`Network=host`** — without it the container's `localhost` is the
  container itself, so `ssh user@localhost` gets `Connection refused`.
  Using `Network=host` also obsoletes any `PublishPort=` line; remove it.
- **`Volume=%h/.ssh:/home/node/.ssh:ro,z`** — mounts the host user's
  SSH config + keys read-only into the container's `node` home so ssh
  can reuse them. **`:z` (lowercase, shared SELinux label)** is correct
  — `:Z` (uppercase, private label) breaks the host sshd's own access
  to its `~/.ssh`, and no label option at all leaves the host's
  `user_home_t` label which `container_t` cannot read (manifests as
  `ls: cannot open directory '/home/node/.ssh': Permission denied`).
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

## Invariants

- **Note body = 1–2 metadata paragraphs + (optional) `history:` section.**
  A 3rd free paragraph (or any non-history block) means it's no longer a
  terminal note — by design, so users opt out simply by typing more.
- **`history:` header text is fixed** — exactly that string, not localized.
- **History items are plain text only.** Marks ignored, nested lists ignored.
- **History capacity = 50, FIFO + move-to-top dedup.** Older items are dropped when a new command pushes the list past the cap.
- **Re-input does not auto-press Enter.** Click stages text into the prompt; Shift+click sends `\r`. The user explicitly executes.
- **Whitespace-prefixed commands are NOT captured** (HISTCONTROL=ignorespace convention). Use a leading space to keep a one-off command out of history.
- **OSC 133 shell integration is opt-in per remote** — without the snippet installed, capture is NO-OP and the existing terminal note behaviour is 100% unchanged.
- **No credentials in the note.** The parser intentionally rejects
  malformed lines but does not validate SSH passwords or keys — those
  flow through the PTY. Don't add a `password:` field to the note
  format.
- **Terminal output is ephemeral.** It's never written back to
  `xmlContent`. Closing or navigating away discards the scrollback.
- **Bearer tokens, not cookies.** Sent on the first WS frame and on
  `/health` via `Authorization: Bearer ...`. Never put the password in
  the note, the URL, or the WebSocket frame.
- **`BRIDGE_SECRET` is stable across restarts.** Rotating it
  invalidates every issued token and every active session sees
  `unauthorized` on its next reconnect.
- **`ssh://localhost` and `ssh://user@localhost` mean different
  things.** The former drops into the container's own shell (because
  `!t.user` is true); the latter forces the ssh path to the host. The
  containerized deployment relies on the latter — write `ssh://you@localhost`
  in notes that target the bridge's host.
- **`history:` (non-tmux) and `history:tmux:<window_id>:` are independent buckets.** Dedup, 50-cap, and debounce all apply per-bucket. Never introduce cross-bucket dedup.
- **Window key uses `@<window_id>` only** — session_id is intentionally not part of the key. Keys stay stable for the lifetime of a tmux window, which matches the user's working unit.
- **PS1 polls the shell context on every prompt.** The shell snippet emits `OSC 133 ; W ; <window_id>` (inside tmux) or `OSC 133 ; W` (outside) at every prompt. This single signal handles tmux start, last-shell exit, attach, window switch, and outside-tmux automatically — `currentWindowKey` is always in sync with what the next command will do. `;C;<hex>;<id>` payload (or its absence) is the secondary correctness baseline.
- **`after-select-window` and `client-attached` hooks are optional micro-optimizations.** They only matter for two no-prompt-redraw transitions (window switch while idle; attach while the active shell already sat at a prompt) where they reduce panel-update latency from "next prompt" to "instant." Detach is the one transition we can't catch instantly — the panel updates on the user's next prompt in the outside shell.
- **Empty sections are dropped on serialize.** Both `clearTerminalHistory(guid, key)` and item-removal-to-empty leave the section header out of the doc. Do not "preserve" an empty header.
- **The bridge has full shell access** to whatever host runs it.
  `BRIDGE_PASSWORD` is the only line of defense — front it with TLS +
  fail2ban while it's publicly reachable.

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
