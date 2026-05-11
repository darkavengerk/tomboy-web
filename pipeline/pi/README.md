# Tomboy Diary Pipeline — Raspberry Pi side

The Pi acts as the always-on inbox between the reMarkable tablet and the desktop. It does two things:

1. Receive `.rm` files pushed from the rM tablet over SSH (rsync).
2. Maintain `~/diary/state/index.json` so the desktop fetcher knows what's available.

## Install

### 1. Create the dedicated user

```bash
sudo useradd -m -s /bin/bash diary-sync
sudo -u diary-sync mkdir -p /home/diary-sync/diary/{inbox,archive,state}
```

### 2. Clone the pipeline + venv

```bash
sudo -u diary-sync -i
git clone <tomboy-web repo> /home/diary-sync/tomboy-web
cd /home/diary-sync/tomboy-web/pipeline
python3 -m venv .venv
.venv/bin/pip install -e .
ln -s /home/diary-sync/tomboy-web/pipeline /home/diary-sync/tomboy-pipeline
```

### 3. SSH hardening for WAN exposure

The Pi will be reachable from the internet, so SSH needs to be locked down
before forwarding a port to it. **A wrong move here can lock you out of the
Pi — read 3a before changing anything.**

Drop-ins in `/etc/ssh/sshd_config.d/` are auto-loaded because the stock Pi OS
`/etc/ssh/sshd_config` includes `Include /etc/ssh/sshd_config.d/*.conf`.
Verify:

```bash
sudo grep -i '^Include' /etc/ssh/sshd_config
# → Include /etc/ssh/sshd_config.d/*.conf
```

If that line is missing, add it back to the main config first.

#### 3a. Pre-flight — don't lock yourself out

From your laptop, against the admin account you normally SSH into the Pi as
(e.g. `pi`):

1. **Confirm key-based login already works.** If this lands on a shell
   without asking for a password, you're set:

   ```bash
   ssh -o PasswordAuthentication=no <admin-user>@<pi-host>
   ```

   If it falls through to a password prompt, copy your key first:

   ```bash
   ssh-copy-id <admin-user>@<pi-host>
   ```

   and retest.

2. **Keep a second SSH session open** in another terminal while you apply
   3b–3c. If `sshd` fails to start or `AllowUsers` is wrong, that session
   is your way back in.

#### 3b. Write the drop-in

Replace `<admin-user>` with the account you SSH in as — `AllowUsers` is a
hard whitelist, so anyone not listed is rejected after auth:

```bash
sudo tee /etc/ssh/sshd_config.d/diary.conf >/dev/null <<'EOF'
Port 2222
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers diary-sync <admin-user>
EOF
```

What each line does:

| Line | Effect |
|------|--------|
| `Port 2222` | sshd listens **only on 2222**. The stock `sshd_config` has `Port 22` commented out, so this drop-in fully replaces the default. To keep 22 alive (e.g. as a LAN-only fallback), add a second `Port 22` line in this drop-in. |
| `PasswordAuthentication no` | Password logins disabled globally. Key auth only. |
| `PubkeyAuthentication yes` | Explicit — some hardened base configs disable it. |
| `AllowUsers diary-sync <admin-user>` | Whitelist of accounts allowed to SSH at all. List every account you need; everyone else is rejected, root included. |

#### 3c. Validate, restart, verify

```bash
sudo sshd -t                 # must print nothing — any output is a syntax error
sudo systemctl restart ssh   # unit is `ssh` on Pi OS, not `sshd`
sudo ss -tlnp | grep sshd    # confirm sshd is listening on :2222 (and :22 if kept)
```

If `sshd -t` prints anything, **do not restart** — fix the config first.
The running sshd keeps your existing session alive; restarting with a
broken config leaves you with no sshd at all.

From a fresh terminal (not the safety session from 3a), confirm the new
port works over LAN before exposing 2222 to WAN:

```bash
ssh -p 2222 <admin-user>@<pi-lan-ip>
```

If that succeeds, the safety session can be closed.

#### 3d. fail2ban

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd   # confirm the `sshd` jail is active
```

The default `sshd` jail watches `/var/log/auth.log` and bans IPs after a
handful of failed auths. No extra config needed.

#### 3e. Router port forwarding

In the home router's NAT / port-forwarding UI, add **WAN TCP 2222 → LAN
Pi-IP TCP 2222**. Don't forward 22. Pair this with a DHCP reservation
(by MAC) for the Pi so the rule doesn't break on reboot.

#### 3f. Authorize the rM key on `diary-sync` (after "rM-side push" step 1)

The rM-side push section below generates an ed25519 key on the tablet.
Once its public key exists, paste it into `diary-sync`'s
`authorized_keys`:

```bash
sudo -u diary-sync mkdir -p /home/diary-sync/.ssh
sudo -u diary-sync chmod 700 /home/diary-sync/.ssh
sudo -u diary-sync tee -a /home/diary-sync/.ssh/authorized_keys >/dev/null <<'EOF'
ssh-ed25519 AAAA...rM-public-key... rM-diary
EOF
sudo -u diary-sync chmod 600 /home/diary-sync/.ssh/authorized_keys
```

Smoke-test the rM-side path from the LAN before relying on it from WAN:

```bash
ssh -p 2222 -i ~/.ssh/id_diary diary-sync@<pi-lan-ip>
```

### 4. Install the systemd timer

```bash
sudo cp /home/diary-sync/tomboy-pipeline/pi/deploy/pi-watcher.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-watcher.timer
sudo systemctl status pi-watcher.timer
```

Watch logs: `sudo journalctl -u pi-watcher.service -f`.

## rM-side push

On the reMarkable tablet (SSH in as `root`):

### 1. SSH client + keypair

The rM userland is **busybox + Dropbear**, not GNU coreutils + OpenSSH.
Practical consequences for this section:

- `/usr/bin/ssh` is dropbear's `dbclient`. Most OpenSSH flags work
  (`-p`, `-i`, `-l`), but **`-o StrictHostKeyChecking=...` is not
  supported** — use `-y` (accept new hostkeys, abort on mismatch) instead.
- `ssh-keygen` is **not installed**, and installing it on the rM is
  awkward (the rootfs is reset on firmware updates).
- `head` / `cut` / `sort` etc. are busybox builds — `head -1` is rejected,
  always pass `head -n 1`.

Generate the ed25519 keypair on the Pi (or any other OpenSSH host) and pull
it onto the rM.

On the Pi:

```bash
ssh-keygen -t ed25519 -f /tmp/id_diary -N "" -C "rM diary"
cat /tmp/id_diary.pub   # copy this; paste it into diary-sync's authorized_keys
                        # per "SSH hardening" step 3f, then come back here
```

On the rM:

```bash
mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh
scp <pi-user>@<pi-lan-ip>:/tmp/id_diary     /home/root/.ssh/id_diary
scp <pi-user>@<pi-lan-ip>:/tmp/id_diary.pub /home/root/.ssh/id_diary.pub
chmod 600 /home/root/.ssh/id_diary
```

Once both files are on the rM, scrub the Pi:

```bash
# back on the Pi:
rm /tmp/id_diary /tmp/id_diary.pub
```

Current-firmware Dropbear (v2022.83+) reads OpenSSH-format ed25519 keys
directly, so no conversion is needed. After "SSH hardening" step 3f is
applied, smoke-test from the rM:

```bash
ssh -p 2222 -i /home/root/.ssh/id_diary -y diary-sync@<pi-lan-ip> echo OK
```

If you see `OK`, you're set. If dropbear complains about the key format
(older firmware), convert it once:

```bash
dropbearconvert openssh dropbear /home/root/.ssh/id_diary /home/root/.ssh/id_diary.db
mv /home/root/.ssh/id_diary.db /home/root/.ssh/id_diary
chmod 600 /home/root/.ssh/id_diary
```

### 2. Push script

The script pushes **per-page** files to the Pi inbox, flat-named
`<page-uuid>.rm` + `<page-uuid>.metadata`. This matches the Pi watcher's
`<inbox>/*.metadata` glob (`pipeline/pi/inbox_watcher.py`) and the
downstream `s4_write` consumer, which reads `metadata["lastModified"]` to
derive Tomboy's `createDate` / `changeDate`.

Data model assumed on the rM (see `pipeline/pi/README.md` "rM-side"
section for the design intent):

- A folder visibly named **"Diary"** (`CollectionType`, `parent=""`) is
  the top-level container.
- Direct children are `DocumentType` notebooks (e.g. one per month).
- Each notebook's pages live as `<notebook-uuid>/<page-uuid>.rm`.
- rM has no per-page `.metadata` natively — the script **synthesizes**
  one stub per page from the `.rm` file's mtime.

Imported PDFs (`fileType: "pdf"` in the notebook's `.content`) are
skipped: they aren't handwritten diary entries.

Create `/home/root/diary-push.sh`:

```bash
#!/bin/sh
# Push each Diary-folder page (.rm) to the Pi inbox as a flat
# <page-uuid>.{rm,metadata} pair. Synthesizes the per-page .metadata stub
# that the Pi watcher globs and s4_write reads.
#
# rM userland is busybox + dropbear:
#   - `head -n 1` (busybox rejects `-1`)
#   - `-y` for accept-new-hostkey (dropbear has no `-o StrictHostKeyChecking`)

SRC=/home/root/.local/share/remarkable/xochitl/
DEST=diary-sync@<PI-HOST>:diary/inbox/
SSH_E="ssh -p 2222 -i /home/root/.ssh/id_diary -y"
STAGING=/tmp/diary-push-staging

# 1. Find the Diary FOLDER (CollectionType, visibleName "Diary").
DIARY_FOLDER_UUID=""
for meta in "$SRC"*.metadata; do
    if grep -q '"visibleName": "Diary"' "$meta" \
       && grep -q '"type": "CollectionType"' "$meta"; then
        DIARY_FOLDER_UUID="$(basename "$meta" .metadata)"
        break
    fi
done

if [ -z "$DIARY_FOLDER_UUID" ]; then
    echo "No Diary folder (CollectionType) found"
    exit 0
fi

# 2. Stage <page-uuid>.{rm,metadata} for every page in every native
#    DocumentType notebook directly inside the Diary folder. Skip PDFs.
rm -rf "$STAGING"
mkdir -p "$STAGING"

count=0
for meta in "$SRC"*.metadata; do
    grep -q '"type": "DocumentType"' "$meta" || continue
    grep -q "\"parent\": \"$DIARY_FOLDER_UUID\"" "$meta" || continue

    nb_uuid="$(basename "$meta" .metadata)"
    nb_dir="$SRC$nb_uuid"
    [ -d "$nb_dir" ] || continue

    content="$SRC$nb_uuid.content"
    if [ -f "$content" ] && grep -q '"fileType":[[:space:]]*"pdf"' "$content"; then
        continue
    fi

    for rm_file in "$nb_dir"/*.rm; do
        [ -f "$rm_file" ] || continue
        page_uuid="$(basename "$rm_file" .rm)"
        cp -p "$rm_file" "$STAGING/$page_uuid.rm"
        mtime_secs="$(stat -c %Y "$rm_file")"
        mtime_ms="$((mtime_secs * 1000))"
        cat > "$STAGING/$page_uuid.metadata" <<EOF
{
    "lastModified": "$mtime_ms",
    "notebookUuid": "$nb_uuid",
    "visibleName": "Diary",
    "type": "PageType"
}
EOF
        touch -r "$rm_file" "$STAGING/$page_uuid.metadata"
        count=$((count + 1))
    done
done

echo "Staged $count page(s) under $STAGING"
[ "$count" -eq 0 ] && exit 0

rsync -avz -e "$SSH_E" "$STAGING"/ "$DEST"
echo "Push complete: $count page(s) sent"
```

`chmod +x /home/root/diary-push.sh`

Notes on the staging+rsync pattern:

- `cp -p` and `touch -r "$rm_file" ...` propagate the `.rm` file's mtime
  to both staged files, so rsync's default mtime+size diff makes
  unchanged pages a no-op on subsequent runs.
- The script does NOT pass `--delete` to rsync — pages archived on the
  Pi side stay there even if the user later deletes them on the rM.

### 3. Schedule with a systemd timer

The rM has no cron daemon, but systemd is present, so use a timer unit.
Sanity check first:

```bash
systemctl --version | head -n 1   # should print `systemd 2xx (...)`
```

Keep canonical copies of the unit files under `/home/root/diary-push/` and
install them into `/etc/systemd/system/` via a small re-runnable script —
firmware updates wipe `/etc/`, so reinstall is part of the recovery loop
(see step 4):

```bash
mkdir -p /home/root/diary-push

cat > /home/root/diary-push/diary-push.service <<'EOF'
[Unit]
Description=Push reMarkable Diary pages to the Pi
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/home/root/diary-push.sh
StandardOutput=append:/home/root/diary-push.log
StandardError=append:/home/root/diary-push.log
EOF

cat > /home/root/diary-push/diary-push.timer <<'EOF'
[Unit]
Description=Run diary-push every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=diary-push.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /home/root/diary-push/install.sh <<'EOF'
#!/bin/sh
set -e
cp -f /home/root/diary-push/diary-push.service /etc/systemd/system/diary-push.service
cp -f /home/root/diary-push/diary-push.timer   /etc/systemd/system/diary-push.timer
systemctl daemon-reload
systemctl enable --now diary-push.timer
systemctl status diary-push.timer --no-pager
EOF

chmod +x /home/root/diary-push/install.sh
/home/root/diary-push/install.sh
```

Verify scheduling and watch the first run:

```bash
systemctl list-timers diary-push.timer --no-pager   # next-fire time
journalctl -u diary-push.service -f                  # live log (Ctrl-C to exit)
```

The first run is `OnBootSec=2min` from boot; thereafter every 5 minutes.
`Persistent=true` makes the timer catch up after the rM has been asleep
(missed runs fire once on wake).

### 4. Survival

rM firmware updates replace the rootfs (`/`, including `/etc/`). `/home/`
is on a separate partition and usually survives, but treat both as
suspect. After every firmware update:

1. Verify the persistent state on `/home/root/` is intact:

   ```bash
   ls /home/root/diary-push.sh /home/root/.ssh/id_diary* /home/root/diary-push/
   ```

   If any file is missing, redo the corresponding step in this README —
   the script and unit-file bodies are reproducible from this doc; the
   keypair can be re-pulled from the Pi (or regenerated and re-pasted
   into `diary-sync`'s `authorized_keys` per "SSH hardening" step 3f).

2. Re-install the systemd units (`/etc/` was wiped):

   ```bash
   /home/root/diary-push/install.sh
   ```

3. Smoke-test:

   ```bash
   /home/root/diary-push.sh                              # one manual run
   systemctl list-timers diary-push.timer --no-pager     # timer rearmed?
   ```

## Verify

Draw a new page on the rM in the Diary notebook. Within 5 minutes:

```bash
# On the Pi:
ls /home/diary-sync/diary/inbox/        # should contain <uuid>.rm + <uuid>.metadata
cat /home/diary-sync/diary/state/index.json   # should include the new uuid
```
