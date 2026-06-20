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

| Variable                  | Notes                                                                                  |
|---------------------------|----------------------------------------------------------------------------------------|
| `BRIDGE_PASSWORD`         | The login password. Pick something long.                                               |
| `BRIDGE_SECRET`           | HMAC key for cookie signatures. 32+ random bytes.                                      |
| `BRIDGE_ALLOWED_ORIGIN`   | Comma-separated list of allowed Origin headers (your app URL).                         |
| `OCR_SERVICE_URL`         | OCR FastAPI URL (e.g. `http://localhost:8080`). Missing → bridge refuses to boot.      |
| `BRIDGE_FILES_DIR`        | Persistent dir for `/files` uploads. Provided by the Quadlet unit's `Environment=` line (not `term-bridge.env`). Missing → boot refused. **Pre-create on host.** |
| `BRIDGE_PUBLIC_BASE_URL`  | HTTPS URL Caddy fronts the bridge at; embedded in upload responses. Missing → refused. |
| `BRIDGE_PORT`             | Optional. Defaults to 3000.                                                            |

Generate `BRIDGE_SECRET` with: `openssl rand -hex 32`.

### Hue creds 보관 (선택)

`BRIDGE_HUE_FILE` 환경변수에 쓰기 가능한 JSON 경로를 지정하면, 앱에서 1회 페어링한
Hue 키(`{ip, appkey, clientkey}`)를 브릿지가 보관한다(0600). 이후 같은 브릿지 토큰을
쓰는 모든 기기가 별도 Hue 설정 없이 조명을 제어한다. 미설정 시 각 기기가 매 요청에
creds 를 동봉하는 기존 동작 유지.

- 권장 경로: 컨테이너 영속 볼륨 내부, 예 `BRIDGE_HUE_FILE=/data/hue.json`.
- rootless Podman/Quadlet: 해당 경로가 포함된 볼륨이 마운트되어 있는지 확인.

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
OCR_SERVICE_URL=http://localhost:8080
BRIDGE_PUBLIC_BASE_URL=https://your-bridge-host
EOF
chmod 600 ~/.config/term-bridge.env
echo "Save the password from term-bridge.env somewhere safe — you'll log in with it."

# 3. Pre-create the bind-mount source dirs/files. Podman creates a FILE
#    at the source path if it doesn't exist, which silently breaks the
#    bind mount — for hosts.json this means the WOL map looks empty; for
#    the files dir this means /files uploads can't write anything.
mkdir -p ~/.config/term-bridge
[ -e ~/.config/term-bridge/hosts.json ] || echo '{}' > ~/.config/term-bridge/hosts.json
mkdir -p ~/.local/share/term-bridge/files

# 4. Drop the Quadlet unit.
mkdir -p ~/.config/containers/systemd
cp deploy/term-bridge.container ~/.config/containers/systemd/

# 5. Reload + start.
#    Quadlet-generated units can't be `enable`d directly — systemd treats
#    them as transient. Auto-start at boot is handled by the [Install]
#    section in the .container file plus `loginctl enable-linger`.
systemctl --user daemon-reload
systemctl --user start term-bridge.service

# 6. Survive logout / reboot.
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

---

## 리마커블 업로드 라우트

`POST /remarkable/upload` (SSE) — `리마커블::` 노트의 업로드 버튼이 호출.
필수 환경 변수:

- `AUTOMATION_SERVICE_URL` — 기존 변수 재사용 (브릿지가 `pipeline-run` 명령 호출).

리마커블 → Pi inbox 동기화 자체는 리마커블 위 `diary-push.timer`(1분 주기,
mtime 가드)가 자율적으로 처리한다. 브릿지는 SSH/rsync에 일절 관여하지 않고
이 라우트는 데스크탑 OCR 파이프라인을 즉시 깨우는 트리거 역할만 한다.
따라서 `REMARKABLE_SSH_*` / `REMARKABLE_INBOX_DIR` / `REMARKABLE_NOTEBOOK_NAME`
설정 일체 불필요.

---

## 리마커블 배경화면 (`/remarkable/wallpaper`)

`remarkable://<별칭>` 시그니처 노트의 섹션별 이미지 링크를 reMarkable의
시스템 스플래시 PNG로 교체한다. 앱이 `POST /remarkable/wallpaper`로 보내면
브릿지가 이미지를 페치 → 1404×1872 그레이스케일 PNG로 변환(`sharp`) →
`ssh`로 기기 `/usr/share/remarkable/<file>.png`에 기록한다.

### 노트 형식

```
remarkable://rm2

절전 중:
https://www.dropbox.com/s/.../sleep.png?dl=1

부팅 중:
https://.../boot.png
```

인식되는 섹션 라벨 → 기기 파일:

| 라벨 | 파일 | xochitl 재시작 |
|---|---|---|
| 절전 중 | `suspended.png` | 예 |
| 부팅 중 | `starting.png` | 아니오 |
| 전원 꺼짐 | `poweroff.png` | 아니오 |
| 재부팅 중 | `rebooting.png` | 아니오 |
| 배터리 없음 | `batteryempty.png` | 아니오 |

### 설정

`~/.config/term-bridge/remarkable.json` (Quadlet 헤더 주석 참조):
별칭 → `{host, user, port?, keyPath?}`. SSH 인증은 브릿지에 마운트된
`~/.ssh` 키를 쓴다 — 사전에 **브릿지 호스트에서** `ssh-copy-id
root@<리마커블-IP>` 를 1회 실행해 키를 등록할 것.
`~/.ssh` 는 읽기전용 마운트라 첫 접속 시 host key 를 저장하지 못하므로,
`ssh-keyscan -H <리마커블-IP> >> ~/.ssh/known_hosts` 로 미리 채워 둘 것.
`remarkable.json` 이 없거나 유효한 호스트 항목이 없으면
`/remarkable/wallpaper` 는 503을 반환한다.

### 알려진 한계

- **펌웨어 3.x 절전 화면**: `suspended.png` 교체는 리마커블 설정의 절전
  화면이 *정적 화면*일 때만 반영된다. "마지막 필기 페이지" 등 동적
  옵션이면 파일 교체가 무시될 수 있다. 부팅/전원 끔 스플래시는 안정적.
- **OTA 펌웨어 업데이트가 splash 파일을 초기화**한다(A/B 파티션 교체).
  업데이트 후 [적용]을 다시 누르면 복구된다.
- 적용 시점에 리마커블이 깨어 있고 SSH가 닿아야 한다(동기 push).
