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

In `/etc/ssh/sshd_config.d/diary.conf`:

```
Port 2222
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers diary-sync
```

Restart sshd. Authorize the rM's ed25519 public key in `/home/diary-sync/.ssh/authorized_keys`.

Install fail2ban with the default `sshd` jail enabled.

Open port 2222 on your home router, pointing at the Pi.

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

### 1. Generate a key pair (rM-side)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_diary -N ""
cat ~/.ssh/id_diary.pub  # copy and add to Pi's diary-sync authorized_keys
```

### 2. Push script

Create `/home/root/diary-push.sh`:

```bash
#!/bin/sh
# Push the configured Diary notebook's pages to the Pi.
DIARY_PARENT_UUID="$(grep -l '"visibleName": "Diary"' /home/root/.local/share/remarkable/xochitl/*.metadata | head -1 | xargs -I{} basename {} .metadata)"
[ -z "$DIARY_PARENT_UUID" ] && { echo "No Diary notebook found"; exit 0; }
SRC=/home/root/.local/share/remarkable/xochitl/
DEST=diary-sync@<PI-WAN-HOST>:diary/inbox/
# Match every page whose .metadata has parent == DIARY_PARENT_UUID
for meta in "$SRC"*.metadata; do
    if grep -q "\"parent\": \"$DIARY_PARENT_UUID\"" "$meta"; then
        page="$(basename "$meta" .metadata)"
        rsync -avz -e "ssh -p 2222 -i /home/root/.ssh/id_diary -o StrictHostKeyChecking=accept-new" \
              "$SRC$page".* "$DEST"
    fi
done
```

`chmod +x /home/root/diary-push.sh`

### 3. Cron

`crontab -e` and add:

```
*/5 * * * * /home/root/diary-push.sh > /tmp/diary-push.log 2>&1
```

### 4. Survival

rM firmware updates wipe `/home/root` modifications. After every rM update:

1. Re-run `crontab -e` to verify the cron entry survived.
2. Re-check `~/.ssh/id_diary` and `~/.ssh/authorized_keys` exist.
3. Re-run the push script once manually to confirm it still works: `sh /home/root/diary-push.sh`.

## Verify

Draw a new page on the rM in the Diary notebook. Within 5 minutes:

```bash
# On the Pi:
ls /home/diary-sync/diary/inbox/        # should contain <uuid>.rm + <uuid>.metadata
cat /home/diary-sync/diary/state/index.json   # should include the new uuid
```
