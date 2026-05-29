#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot 부팅 스크립트 — 폰의 ~/.termux/boot/start-tunnel.sh 로 배치.
#   Termux:Boot 은 부팅 시 이 스크립트를 Termux 앱 컨텍스트(정상 SELinux 도메인)
#   에서 실행하므로, Magisk service.d 의 su <uid> 가 부딪힌 untrusted_app 도메인/
#   inet 그룹 문제를 우회한다. (자세한 배경: docs/superpowers/specs 의 §10.4)
termux-wake-lock 2>/dev/null || true   # termux-api 있으면 절전 중 터널 유지
pgrep -x sshd >/dev/null 2>&1 || sshd
nohup "$HOME/tunnel.sh" >/dev/null 2>&1 &
