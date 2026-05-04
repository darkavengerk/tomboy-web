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

| Method | Path     | Notes                                                       |
|--------|----------|-------------------------------------------------------------|
| POST   | `/login` | Body: `{"password": "..."}` → sets `term_auth` cookie.      |
| POST   | `/logout`| Clears the cookie.                                          |
| GET    | `/health`| Returns `{"authed": bool}` based on the cookie.             |

CORS is allow-listed to `BRIDGE_ALLOWED_ORIGIN`. The cookie is
`HttpOnly; Secure; SameSite=None; Max-Age=30 days`.

### WebSocket `/ws`

The cookie is verified on the upgrade. After `OPEN`, the client sends:

```jsonc
{"type": "connect", "target": "ssh://user@host:22", "cols": 100, "rows": 30}
{"type": "data",    "d": "ls\r"}
{"type": "resize",  "cols": 100, "rows": 30}
```

Server messages:

```jsonc
{"type": "data",  "d": "...stdout/stderr..."}
{"type": "exit",  "code": 0}
{"type": "error", "message": "..."}
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
systemctl --user daemon-reload
systemctl --user enable --now term-bridge.service

# 5. Survive logout / reboot.
loginctl enable-linger $USER
```

Verify:

```bash
curl -s http://127.0.0.1:3000/health
# → {"authed":false}
```

### TLS in front of the bridge

Cookies require `Secure`, so the public-facing endpoint must be HTTPS. Use
Caddy (also as a Podman container or rpm-ostree `caddy` package) with the
sample [`deploy/Caddyfile`](deploy/Caddyfile). Caddy auto-issues a Let's
Encrypt certificate.

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

For `ssh://localhost` the bridge spawns `bash -l` directly and skips `ssh`
entirely.

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
curl -i -c jar.txt -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"password":"test"}' http://127.0.0.1:3000/login

curl -b jar.txt http://127.0.0.1:3000/health
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
