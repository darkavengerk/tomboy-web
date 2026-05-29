# 노트 → 역터널 → 폰 SSH 설계

작성일: 2026-05-29

## 1. 목적

기존 **터미널 노트**(본문이 `ssh://host`면 xterm.js 세션으로 변신)와 **동일한 방식**으로 LG V30(Termux)에 SSH 접속한다. 폰을 자주 들고 나가므로(LTE·외부 WiFi) 네트워크 위치와 무관하게 닿아야 하고, 폰 재부팅 후에도 사람 개입 없이 자동 복구되어야 한다.

## 2. 배경 / 제약

- 터미널 노트는 이미 임의 `ssh://user@host:port`를 지원한다. bridge가 `ssh -p <port> -o StrictHostKeyChecking=accept-new user@host`를 PTY로 띄우고 인증은 PTY로 직접 흐른다(자격증명 비중개).
- bridge는 RPi(192.168.219.110)에서 **rootless Podman + Quadlet**으로 돌고 `Network=host`다 → 컨테이너의 `localhost` = Pi 호스트의 `localhost`. 호스트 `~/.ssh`를 RO 마운트해 SSH 키/`known_hosts`를 공유한다.
- RPi는 집의 **SSH 게이트웨이**이자 상시 ON, `umayloveme.duckdns.org:22`로 외부 노출.
- 폰 Termux **sshd는 재부팅마다 죽는다**. 데스크탑의 `v30ssh`는 adb 트릭으로 그때그때 살리지만 bridge(Pi)엔 adb가 없다. Termux:Boot 애드온은 서명 충돌로 설치 불가 → root(Magisk) 경로로 자동 기동.
- 폰은 DHCP라 LAN IP가 바뀔 수 있다.

**핵심 전환**: bridge가 폰을 찾아 들어가는 대신, **폰이 RPi로 역방향 SSH 터널을 다이얼 아웃**한다. 폰이 어느 네트워크에 있든 터널은 살아있고, bridge는 항상 고정된 `localhost:18022`로 폰 sshd에 닿는다.

## 3. 결정 사항

| 항목 | 결정 | 근거 |
|---|---|---|
| 연결 모델 | 역방향 SSH 터널 (autossh) | 폰이 외부망에 있어도 NAT 무관하게 도달 |
| 폰 Termux 로그인 인증 | **키 인증** | 노트 열면 비번 없이 바로 셸 진입(데스크탑 터미널과 동일 경험) |
| 폰→RPi 터널 종단 주소 | **항상 `umayloveme.duckdns.org`** | 집/LTE/외부 단일 경로. (집 안에선 NAT 헤어핀 의존 — §8 참고) |
| 노트 별칭 | **`ssh://phone` 별칭을 bridge에 추가** | 가독성 + "터널 끊김" 친절 에러. reMarkable 호스트맵 패턴 미러링 |
| 재부팅 자동 기동 | Magisk `service.d` 부팅 스크립트 | Termux:Boot 사용 불가, root 경로가 유일하게 견고 |

## 4. 토폴로지

```
[폰 Termux]                                      [RPi (게이트웨이+bridge)]            [노트앱(외부/내부)]
 sshd :8022                                                                                 │
   │  autossh -N -R 127.0.0.1:18022:127.0.0.1:8022                                          │
   └──── 폰이 밖으로 다이얼 ────▶ RPi sshd :22 (duckdns 노출, tunnel 유저)                  │
                                       │  결과: Pi의 localhost:18022 → 폰 sshd               │
                                [term-bridge 컨테이너, Network=host]                         │
                                       │  ssh -p 18022 termux@localhost ◀── wss(Caddy) ──────┘
                                       ▼
                                  폰 셸 등장
```

3중 인증 레이어(서로 독립):
1. 노트앱 → bridge WS: 기존 bridge HMAC 토큰(`/login`).
2. bridge → 폰 sshd: Pi 유저 `~/.ssh` 키 (이 설계에서 폰 `authorized_keys`에 등록).
3. 폰 → RPi 터널: 별도의 포워딩 전용 제한 키.

## 5. 컴포넌트

### 5.1 폰 측 (Termux + Magisk) — 운영/런북

- **sshd** :8022 — `pkg install openssh`, 키만 허용(`PasswordAuthentication no` 권장, §3 키 인증).
- **autossh 역터널**:
  ```sh
  autossh -M 0 -N \
    -R 127.0.0.1:18022:127.0.0.1:8022 \
    -i $HOME/.ssh/tunnel_key \
    -p 22 tunnel@umayloveme.duckdns.org \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new
  ```
  네트워크 전환/절전 복귀 시 autossh가 끊김 감지 후 재연결.
- **부팅 자동 기동** — `/data/adb/service.d/tomboy-tunnel.sh` (root, 부팅 시 실행):
  ```sh
  #!/system/bin/sh
  until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 2; done
  sleep 30   # WiFi/복호화 안정화 대기
  # Termux uid 환경에서 sshd + autossh 기동 (정확한 incantation은 구현 단계에서 실기 검증)
  su -lp <TERMUX_UID> -c '
    export PREFIX=/data/data/com.termux/files/usr HOME=/data/data/com.termux/files/home
    export PATH=$PREFIX/bin LD_LIBRARY_PATH=$PREFIX/lib
    pgrep -x sshd >/dev/null || sshd
    pgrep -f "autossh.*18022" >/dev/null || \
      autossh -M 0 -N -R 127.0.0.1:18022:127.0.0.1:8022 -i $HOME/.ssh/tunnel_key \
        -p 22 tunnel@umayloveme.duckdns.org \
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new &
  '
  ```
  `<TERMUX_UID>`는 폰에서 `stat -c %u /data/data/com.termux/files/home`로 확인. service.d에서 Termux 바이너리 기동은 환경 변수가 까다로워 실기 검증 필요(폰이 adb로 붙어 있음).

### 5.2 RPi (터널 종단) 측 — 운영/런북

- 전용 `tunnel` 유저 생성, 셸 불필요.
- `~tunnel/.ssh/authorized_keys`에 폰 공개키를 **포워딩 전용 제한**으로 등록:
  ```
  restrict,port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... phone-tunnel
  ```
  `restrict`가 기본 전부 차단 후 `port-forwarding`만 허용 → 셸 없이 `-R`만 가능.
- sshd 기본값으로 `-R 127.0.0.1:18022`는 localhost 바인딩(원격 클라이언트 노출 없음). `GatewayPorts` 불필요.

### 5.3 bridge 측 — **코드 변경**

reMarkable 호스트맵(`remarkableHosts.ts` + `remarkable.json` 마운트)과 동일 패턴으로 SSH 별칭 맵을 추가한다.

- **새 파일 `bridge/src/sshHosts.ts`** — `loadSshHosts(path)` / `lookupSshHost(alias): {host, user?, port?} | null`. `hosts.ts`(WoL)·`remarkableHosts.ts`와 같은 로더 구조(JSON object, 검증, 결측 시 비활성 로그).
- **`bridge/src/server.ts`** — `parseSshTarget` 직후, WoL 조회 **앞**에서 별칭 치환(`lookupWolTarget`이 이미 여기 있으므로 같은 자리). 별칭이면 `{host:'localhost', port:18022, user:'termux'}`로 교체. user가 채워지므로 `isLocalTarget`은 false → 정상 ssh 경로. `pty.ts`는 순수 함수로 유지(별칭 미인지). `startSession`·`startSpectator` 양쪽에 적용.
- **`bridge/src/server.ts`** — 해석된 타깃이 별칭 출신이고 `probePort(localhost,18022)`(기존 `wakeIfNeeded` 내부 헬퍼 재사용)가 실패하면 일반 "connection refused" 대신 `{type:'error', message:'폰 터널이 연결되어 있지 않습니다 (폰이 깨어 있고 네트워크에 연결됐는지 확인)'}` 송신.
- **Quadlet 마운트 추가** (`bridge/deploy/term-bridge.container`): `Volume=%h/.config/term-bridge/ssh-hosts.json:/etc/term-bridge/ssh-hosts.json:ro,z` + `Environment=BRIDGE_SSH_HOSTS_FILE=...`. 파일 내용 예:
  ```json
  { "phone": { "host": "localhost", "port": 18022, "user": "termux" } }
  ```
- **앱 코드 변경 없음.** 노트는 `ssh://phone`(host=`phone`, SSH_RE 통과) — 앱은 터미널 노트로 인식해 raw target을 bridge로 보내고, 별칭 해석은 전적으로 bridge에서.

### 5.4 노트 형태 (사용자)

```
폰
ssh://phone
bridge: wss://term.<도메인>/ws
```
(첫 줄은 제목. `bridge:` 줄은 앱 기본 bridge면 생략 가능.)

## 6. 일회성 셋업 순서 (런북)

1. **폰**: `pkg install openssh autossh` → sshd 키 인증 설정 → `tunnel_key` 키쌍 생성.
2. **폰→RPi**: `tunnel_key.pub`를 RPi `~tunnel/.ssh/authorized_keys`에 제한 옵션으로 등록.
3. **RPi→폰**: bridge 컨테이너가 쓰는 Pi 유저 `~/.ssh` 공개키를 폰 Termux `~/.ssh/authorized_keys`에 등록(§3 키 인증).
4. 폰에서 autossh 수동 1회 기동 → 터널 확립 확인.
5. **RPi(호스트)**: 터널 살아있는 동안 `ssh-keyscan -p 18022 localhost >> ~/.ssh/known_hosts` (RO 마운트라 첫 접속 시 기록 불가 대비 — reMarkable과 동일).
6. **bridge**: `~/.config/term-bridge/ssh-hosts.json` 작성 + Quadlet 마운트 추가 → 이미지 재빌드 → `systemctl --user restart term-bridge`.
7. 노트 `ssh://phone` 작성 → 셸 진입 확인.
8. **폰**: `/data/adb/service.d/tomboy-tunnel.sh` 설치 + 실행권한 → 재부팅 → 무개입 복구 확인.

## 7. 실패 모드 & 동작

| 상황 | 동작 |
|---|---|
| 폰 절전/네트워크 전환 | autossh가 끊김 감지 후 재연결. 그 사이 노트 열면 §5.3 친절 에러. 재연결 후 다시 열면 정상. |
| sshd 죽음 | service.d wrapper / autossh 재기동 시 `pgrep -x sshd \|\| sshd`로 살림. |
| 폰 재부팅 | service.d 스크립트가 sshd + autossh 재기동. |
| RPi 재부팅 | bridge·sshd 자동 기동(linger). 폰 autossh가 재연결. |
| 터널 미연결 상태로 노트 열기 | `probePort(localhost,18022)` 실패 → 한국어 친절 에러(connection refused 노출 안 함). |

## 8. 알려진 한계 / 비범위(YAGNI)

- **NAT 헤어핀 의존**: 집 안에서도 폰이 `duckdns.org:22`(외부 IP)로 다이얼한다. 대부분 공유기가 헤어핀을 지원하지만, 안 되면 (a) 라우터 헤어핀 설정, (b) 향후 split-DNS로 집 안에선 LAN IP 해석 — v1 비범위.
- **bridge HMAC 토큰은 그대로** — 노트앱 인증 모델 변경 없음.
- **양방향 제어(영상 스트림·위치 push 등)는 별도 스펙** — 본 스펙은 SSH 셸 접속만. 단, 이 역터널 인프라가 후속 기능의 토대가 됨.
- 폰이 **모바일 데이터에서도** 항상 RPi로 다이얼 — 데이터 사용량/배터리는 sshd 유휴 연결 수준(무시 가능). 필요 시 향후 WiFi-only 조건 추가.

## 9. 테스트 / 검증

- bridge 별칭 로직: `bridge/src/sshHosts.test.ts` (`node --test`) — 로더 파싱/검증, alias 치환, 결측 파일 비활성. `hosts.test.ts`/`remarkableHosts.test.ts` 미러링.
- 친절 에러: `probePort` 실패 경로 단위 테스트(기존 `probePort` 모킹 패턴 따름).
- E2E: 실기. ① 터널 확립 후 `ssh://phone` 노트 → 셸 진입. ② autossh kill → 노트 열기 → 친절 에러. ③ 폰 재부팅 → 무개입 복구(가장 중요한 수용 기준).
