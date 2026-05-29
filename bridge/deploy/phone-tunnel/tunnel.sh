#!/data/data/com.termux/files/usr/bin/bash
# tomboy 역터널 keepalive (폰 Termux, ~/tunnel.sh).
#   폰 → RPi(bridge) 로 ssh -R 역터널을 상시 유지한다.
#   bridge(Network=host)가 localhost:18022 로 폰 sshd(8022)에 도달 → 노트 ssh://phone.
#   autossh 가 비대화형 채널에서 불안정해 평문 ssh -N -R keepalive 루프로 대체함.
#
# 전제: ~/.ssh/tunnel_key (폰→RPi 포워딩 전용 키, RPi umayloveme authorized_keys 에
#       restrict,port-forwarding 로 등록). RPi sshd 는 :2222.
pgrep -x sshd >/dev/null 2>&1 || sshd
while true; do
  pgrep -x sshd >/dev/null 2>&1 || sshd          # sshd 사망 시 self-heal
  ssh -N -R 127.0.0.1:18022:127.0.0.1:8022 \
    -i "$HOME/.ssh/tunnel_key" -p 2222 umayloveme@192.168.219.110 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes >> "$HOME/tunnel.log" 2>&1
  echo "[$(date)] tunnel dropped rc=$?, retry in 5s" >> "$HOME/tunnel.log"
  sleep 5
done
