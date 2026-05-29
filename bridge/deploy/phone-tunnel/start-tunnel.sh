#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot 부팅 스크립트 — 폰의 ~/.termux/boot/start-tunnel.sh 로 배치.
#   Termux:Boot 은 부팅 시 이 스크립트를 Termux 앱 컨텍스트(정상 SELinux 도메인)
#   에서 포그라운드 서비스로 실행한다. tunnel.sh 는 무한 keepalive 루프이므로
#   백그라운드(&)로 띄우고 종료하면 Android 가 고아 프로세스를 죽인다 → 반드시
#   foreground 로 exec 해서 boot 서비스가 살아있는 동안 sshd+터널을 유지한다.
termux-wake-lock 2>/dev/null || true
exec "$HOME/tunnel.sh"
