# 폰 역터널 셋업 (LG V30 Termux → RPi bridge)

노트 `ssh://phone` 이 동작하려면 폰이 RPi(`bridge`, 192.168.219.110:2222)로 ssh `-R`
역터널을 유지해야 한다. bridge(`Network=host`)가 `localhost:18022` → 폰 sshd(8022)로
도달하고, `ssh-hosts.json` 의 `phone` 별칭이 이를 가리킨다.

설계·근거: `docs/superpowers/specs/2026-05-29-phone-ssh-reverse-tunnel-design.md` (§10 실기 보정).

## 확정 좌표

| | 값 |
|---|---|
| 폰 Termux user / uid | `u0_a186` / 10186 |
| 폰 sshd | `:8022` |
| RPi(bridge) 종단 | `umayloveme@192.168.219.110:2222` (포워딩 전용 키) |
| 역터널 바인드 | RPi `127.0.0.1:18022` → 폰 `127.0.0.1:8022` |
| bridge→폰 인증 | `umayloveme@bridge` 의 `~/.ssh/id_ed25519.pub` (폰 authorized_keys) |
| RPi ssh-hosts.json | `{"phone":{"host":"localhost","port":18022,"user":"u0_a186"}}` |

## 일회성 셋업 (완료된 것 / TODO)

완료(2026-05-29):
1. 폰: `pkg install openssh autossh`, `~/.ssh/tunnel_key` 생성.
2. 폰 authorized_keys ← RPi `id_ed25519.pub` (bridge→폰 키 인증).
3. RPi `~umayloveme/.ssh/authorized_keys` ← 폰 `tunnel_key.pub` (`restrict,port-forwarding,no-pty,...`).
4. 폰: `~/tunnel.sh` 배치(이 디렉토리의 `tunnel.sh`).
5. RPi: `~/.config/term-bridge/ssh-hosts.json` 작성 + bridge 재빌드(브랜치)·재시작.
6. 검증: 폰에서 `nohup ~/tunnel.sh &` → RPi `ss -tln|grep 18022` LISTEN, `ssh -p 18022 u0_a186@localhost` 셸. 앱 `ssh://phone` 노트 OK.

TODO — 부팅 자동기동 (Termux:Boot):
- **Magisk service.d 는 SELinux 도메인 문제로 불가** (§10.4). Termux:Boot 사용.
- 현 Termux 가 GitHub 디버그 빌드(서명 `db86cf3c`)라 F-Droid Termux:Boot 충돌.
  → 같은 서명의 **GitHub Termux:Boot APK** 우선 시도(재설치·키 손실 없음).
  → 불가 시 Termux+Termux:Boot 을 동일 소스로 재설치 후 위 1~5 재셋업.
- Termux:Boot 설치 후: `mkdir -p ~/.termux/boot && cp start-tunnel.sh ~/.termux/boot/ && chmod +x ~/.termux/boot/start-tunnel.sh`
- 재부팅 → 잠금 해제 → RPi 에서 `ssh -p 18022 u0_a186@localhost 'echo ok'` 무개입 확인.

## 절전(Doze) 주의
폰 깊은 절전 시 WiFi/Termux 가 죽어 터널이 끊긴다. keepalive 루프가 깨어나면 5s 내
재연결하지만, 안정성을 위해 **설정 → 배터리 → Termux 최적화 해제** 권장. `termux-wake-lock`
은 termux-api 필요(GitHub 빌드는 애드온 서명 충돌 — Termux:Boot 도입 시 함께 해결 가능).
