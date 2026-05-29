#!/data/data/com.termux/files/usr/bin/bash
# tomboy 역터널 keepalive (폰 Termux, ~/tunnel.sh). 매 반복 sshd 보장 + ssh -R.
echo "[$(date)] tunnel.sh start (pid $$)" >> "$HOME/tunnel.log"
while true; do
  if ! pgrep -x sshd >/dev/null 2>&1; then
    echo "[$(date)] starting sshd" >> "$HOME/tunnel.log"
    sshd >> "$HOME/tunnel.log" 2>&1
    sleep 1
  fi
  ssh -N -R 127.0.0.1:18022:127.0.0.1:8022 \
    -i "$HOME/.ssh/tunnel_key" -p 2222 umayloveme@192.168.219.110 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes >> "$HOME/tunnel.log" 2>&1
  echo "[$(date)] tunnel dropped rc=$?, retry in 5s" >> "$HOME/tunnel.log"
  sleep 5
done
