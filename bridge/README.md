# tomboy-web terminal bridge

A small WebSocket → PTY bridge for the **terminal note** feature in tomboy-web.

The note app recognises notes whose body is exactly:

```
ssh://[user@]host[:port]
bridge: wss://your-bridge.example/ws    # optional, falls back to app default
```

When such a note is opened, the editor is replaced with an `xterm.js` terminal
that connects to this service over WebSocket. The bridge spawns a PTY:

- `ssh://localhost` (or your machine's hostname) → a local login shell.
- Anything else → `ssh user@host -p port`.

For "jump to other servers" use the local-shell form and run `ssh other-host`
inside the session.

---

## Protocol

### HTTP

| Method | Path     | Notes                                                                      |
|--------|----------|----------------------------------------------------------------------------|
| POST   | `/login` | Body: `{"password": "..."}` → returns `{"token": "..."}` (30-day HMAC).    |
| GET    | `/health`| `Authorization: Bearer <token>` → returns `{"authed": bool}`.              |

CORS is allow-listed to `BRIDGE_ALLOWED_ORIGIN`. **No cookies** — the token
is sent explicitly per request, so the bridge works over plain `ws://` on
a LAN IP without needing a TLS certificate. (Logout = client just drops
the stored token.)

### WebSocket `/ws`

The browser cannot set custom headers on a WS upgrade, so the token rides
in the first client message. The bridge accepts the upgrade, then waits
up to 5 seconds for a valid `connect` frame; otherwise it closes.

```jsonc
{"type": "connect", "target": "ssh://user@host:22", "token": "<...>", "cols": 100, "rows": 30}
{"type": "data",    "d": "ls\r"}
{"type": "resize",  "cols": 100, "rows": 30}
```

Spectator-mode connect frame (read-only view of an active tmux pane):

```jsonc
{"type": "connect", "target": "ssh://user@host:22", "token": "<...>",
 "mode": "spectate", "session": "main"}
```

Server messages:

```jsonc
{"type": "data",  "d": "...stdout/stderr..."}
{"type": "exit",  "code": 0}
{"type": "error", "message": "..."}

// spectator mode only:
{"type": "pane-switch", "paneId": "%12", "cols": 200, "rows": 50, "altScreen": true}
{"type": "pane-resize", "cols": 220, "rows": 50}
```

---

## Required environment variables

| Variable                | Notes                                                         |
|-------------------------|---------------------------------------------------------------|
| `BRIDGE_PASSWORD`       | The login password. Pick something long.                      |
| `BRIDGE_SECRET`         | HMAC key for cookie signatures. 32+ random bytes.             |
| `BRIDGE_ALLOWED_ORIGIN` | Comma-separated list of allowed Origin headers (your app URL).|
| `BRIDGE_PORT`           | Optional. Defaults to 3000.                                   |

Generate `BRIDGE_SECRET` with: `openssl rand -hex 32`.

---

## Running on Bazzite (immutable Fedora)

Bazzite is `rpm-ostree` based — don't try to `dnf install node`. Instead, run
the bridge as a Podman container managed by systemd via Quadlet:

```bash
# 1. Build the image (one-time, from a checkout of this repo).
cd bridge
podman build -t term-bridge:latest .

# 2. Write the env file. NEVER commit this.
mkdir -p ~/.config
cat > ~/.config/term-bridge.env <<EOF
BRIDGE_PASSWORD=$(openssl rand -base64 24)
BRIDGE_SECRET=$(openssl rand -hex 32)
BRIDGE_ALLOWED_ORIGIN=https://your-app-domain
EOF
chmod 600 ~/.config/term-bridge.env
echo "Save the password from term-bridge.env somewhere safe — you'll log in with it."

# 3. Drop the Quadlet unit.
mkdir -p ~/.config/containers/systemd
cp deploy/term-bridge.container ~/.config/containers/systemd/

# 4. Reload + start.
#    Quadlet-generated units can't be `enable`d directly — systemd treats
#    them as transient. Auto-start at boot is handled by the [Install]
#    section in the .container file plus `loginctl enable-linger`.
systemctl --user daemon-reload
systemctl --user start term-bridge.service

# 5. Survive logout / reboot.
loginctl enable-linger $USER
```

Verify:

```bash
curl -s http://127.0.0.1:3000/health
# → {"authed":false}
```

### TLS in front of the bridge (optional)

Bearer-token auth means **TLS is not strictly required** — the bridge
accepts plain `ws://` on a LAN IP, which is fine for personal "open
the note app on phone in same Wi-Fi" use. The trade-offs of plain HTTP:

- The token is sent in the first WS message — anyone sniffing the LAN
  could capture it (and the SSH session contents).
- Browsers block `ws://` from `https://` pages (mixed content). If the
  note app is served from Vercel/HTTPS, the bridge MUST be `wss://`.

If you want HTTPS anyway, Caddy in front of the bridge gets you a
Let's Encrypt certificate. See [`deploy/Caddyfile`](deploy/Caddyfile).

#### Letting rootless Caddy bind to 80/443

Rootless Podman runs the container as your unprivileged user. The kernel's
default `net.ipv4.ip_unprivileged_port_start=1024` blocks binding 80/443,
which is what Caddy needs for HTTPS + the ACME HTTP-01 challenge. Lower
the floor:

```bash
sudo sysctl net.ipv4.ip_unprivileged_port_start=80
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-rootless-ports.conf
```

Run Caddy with `Network=host` so its `reverse_proxy 127.0.0.1:3000` can
reach the bridge container on the host's loopback. With `Network=host`,
Quadlet `PublishPort=` lines are ignored (the container shares the host
namespace) — don't list them.

### Port forwarding

Forward your router's external `443/tcp` → Bazzite's Caddy port. firewalld
on Bazzite is enabled by default; open the port:

```bash
sudo firewall-cmd --add-port=443/tcp --permanent
sudo firewall-cmd --reload
```

### SSH credentials

The bridge invokes `ssh` as the unprivileged `node` user inside the container.
The Quadlet unit mounts `~/.ssh` read-only into the container so your
existing keys / `known_hosts` / `config` work as-is. **No credentials are ever
brokered through the bridge** — `ssh` prompts for passwords and key
passphrases on the PTY, exactly like a normal terminal.

### "I want a shell as my own user, on this same machine"

The bridge runs as an unprivileged container user (`node`), so a literal
`ssh://localhost` would drop you into the container's shell — not what you
want for personal use. Instead, write the note as:

```
ssh://your-username@localhost
```

The bridge then runs `ssh your-username@localhost` from inside the
container. With `Network=host` on the term-bridge Quadlet, that hits the
host's sshd directly (127.0.0.1:22 is the host's loopback, not the
container's). Setup on the host:

```bash
# 1. Make sure sshd is running.
sudo systemctl enable --now sshd

# 2. Optional but recommended: self-trust your own SSH key so you don't
#    have to type a password every time you open a terminal note.
ssh-keygen -t ed25519               # if you don't have a key yet
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# 3. First connection will prompt to trust the host key — answer "yes"
#    once and it's remembered.
```

(`ssh://localhost` without a user is still useful when running the bridge
**natively** under your own account — without a container — where the
bridge process already IS your user.)

---

## Spectator mode (mobile观전)

A "spectator" note watches the **currently-focused pane** of a tmux session
on the target, with no input — useful for kicking off a long task on the
desktop (e.g. claude code) and watching it from a phone.

Note format:

```
ssh://you@desktop
spectate: main
```

Bridge: same auth, same ssh credentials. The bridge ssh's into the target
and runs `tmux -CC attach -t <session>` (control mode). When you switch
panes / windows on the desktop, the bridge re-seeds the spectator's screen
via `capture-pane -epJ` for the new pane and resumes streaming its output.

### Target-side tmux configuration

To keep the desktop's working size from being shrunk by a small spectator
client, set on the target:

```tmux
set -g window-size latest
set -g focus-events on
set -g aggressive-resize on
```

A drop-in plugin lives in [`deploy/tomboy-spectator.tmux`](deploy/tomboy-spectator.tmux)
that sets all three. Install via tpm or `run-shell /path/to/tomboy-spectator.tmux`
in your `.tmux.conf`.

### Requirements

- tmux 2.1+ on the target (control mode).
- The note's `ssh://user@host` must reach a real shell account that
  attaches to a running tmux server (same OS user that owns the session
  socket).
- The named session must already exist on attach — the bridge does NOT
  `new-session` to spectate.

---

## Tailscale (later)

When you want to remove the public endpoint:

1. Install Tailscale (already shipped on Bazzite). `tailscale up`.
2. `tailscale serve --bg --https=443 http://localhost:3000`.
3. Update the app's bridge URL to your MagicDNS name (e.g.
   `wss://my-pc.tailnet-xyz.ts.net/ws`).
4. Close the router port forward.

The bridge code is unchanged.

---

## Development

```bash
npm install
npm run build       # tsc → dist/
BRIDGE_PASSWORD=test BRIDGE_SECRET=$(openssl rand -hex 16) \
  BRIDGE_ALLOWED_ORIGIN=http://localhost:5173 \
  npm start
```

Then in another shell:

```bash
TOKEN=$(curl -s -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"password":"test"}' http://127.0.0.1:3000/login | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/health
# → {"authed":true}
```

---

## Security notes

- The bridge has full shell access to the host running it. `BRIDGE_PASSWORD`
  is the only line of defense — pick a long password and treat it like an
  SSH key.
- A reverse proxy (Caddy/nginx) with `fail2ban` watching `/login` 401s is
  strongly recommended while the endpoint is publicly reachable.
- The container runs read-only with no added capabilities; it cannot
  modify the host filesystem outside the volumes it's been given.
- Ports `80` and `443` on the router are the only exposed surface — don't
  publish `3000` directly.
