# claude-service 셋업

`claude -p` 는 Anthropic API 로 스트리밍하는 **얇은 클라이언트**다(로컬 추론/GPU 없음).
따라서 데스크탑·Pi(arm64) 어느 쪽에서도 돈다.

- **데스크탑** (Ollama, ocr-service 와 같은 머신): 일기 OCR 파이프라인이 호출. 아래 "데스크탑 셋업".
- **Pi(브릿지)**: `claude://` 채팅 노트용. 브릿지가 `localhost:7842` 로 프록시. 아래 "Pi(브릿지) 배포".

두 곳을 동시에 굴려도 된다(현재 구성). 단 같은 OAuth creds 사본을 공유하므로 회전 주의 — 맨 아래 참조.

## 데스크탑 셋업

## 사전 조건

- Podman 4+ (Quadlet 지원)
- `claude` CLI를 host에서 한 번 로그인하기 위한 GUI/터미널 접근
- `BRIDGE_SHARED_TOKEN` 값 (Pi 브릿지의 `BRIDGE_SECRET` 과 동일)

## 셋업

```bash
# 1. host에서 claude login (OAuth credentials 생성)
claude login
# → ~/.claude/credentials.json (또는 유사한 파일) 생성됨

# 2. 이미지 빌드
cd claude-service
podman build -t localhost/claude-service:latest .

# 3. Quadlet unit 설치
mkdir -p ~/.config/containers/systemd
cp deploy/claude-service.container ~/.config/containers/systemd/

# 4. 환경변수 파일
cat > ~/.config/claude-service.env <<EOF
BRIDGE_SHARED_TOKEN=<바꿔라 — 브릿지 BRIDGE_SECRET 과 동일 값>
CLAUDE_SERVICE_PORT=7842
EOF

# 5. 활성화
systemctl --user daemon-reload
systemctl --user enable --now claude-service.service
loginctl enable-linger $USER

# 6. 헬스 체크
curl -i -H "Authorization: Bearer $BRIDGE_SHARED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}' \
  http://localhost:7842/chat
# → 400 (bad_request: messages required) 가 정상.
#   401 이 나오면 토큰 확인.
```

## 브릿지 설정 (claude-service 가 데스크탑일 때)

Pi 브릿지의 환경변수 파일에 추가:

```
CLAUDE_SERVICE_URL=http://<데스크탑-LAN-IP>:7842
```

이후 브릿지 재시작:

```bash
systemctl --user restart term-bridge.service
```

## Pi(브릿지) 배포 — claude-service 를 Pi 에서 (always-on)

`claude://` 채팅을 데스크탑 의존 없이 항상 쓰려면 claude-service 를 Pi 에 올린다.
요지: ① creds 복사 ② Pi 에서 arm64 이미지 빌드 ③ Quadlet(`:Z` 없이) ④ 브릿지를 `localhost` 로.

```bash
# 0. (데스크탑) 이미 로그인된 creds 를 Pi 로 복사 — 재로그인 불필요
ssh -p 2222 user@pi 'mkdir -p ~/claude-service/.claude'
scp -P 2222 ~/.claude/.credentials.json user@pi:claude-service/.claude/
scp -P 2222 ~/.claude/settings.json     user@pi:claude-service/.claude/
scp -P 2222 ~/.claude.json              user@pi:claude-service/.claude.json
#   (권장) settings.json 의 hooks/statusLine/enabledPlugins/extraKnownMarketplaces 는
#   Pi 에 없어 stop-hook-error/노이즈 → 제거:
#     jq 'del(.hooks,.statusLine,.enabledPlugins,.extraKnownMarketplaces)' 로 덮어쓰기

# 1. (Pi) 소스 받아 arm64 이미지 빌드 (node:22-bookworm-slim 멀티아치 + npm i -g claude-code)
rsync -az -e 'ssh -p 2222' --exclude node_modules --exclude dist claude-service/ user@pi:claude-service-src/
ssh -p 2222 user@pi 'cd ~/claude-service-src && podman build -t localhost/claude-service:latest .'

# 2. (Pi) env — BRIDGE_SHARED_TOKEN = 브릿지 term-bridge.env 의 BRIDGE_SECRET 과 동일
cat > ~/.config/claude-service.env <<EOF
BRIDGE_SHARED_TOKEN=<BRIDGE_SECRET 값>
CLAUDE_SERVICE_PORT=7842
CLAUDE_MAX_REQUEST_BYTES=2097152
EOF
chmod 600 ~/.config/claude-service.env

# 3. (Pi) Quadlet — claude-service.container 를 ~/.config/containers/systemd/ 에.
#    ⚠️ Debian(SELinux 없음) → Volume 에서 `:Z` 제거. creds 쓰기 가능(토큰 갱신) → :ro 금지.
#      Volume=%h/claude-service/.claude:/data/.claude
#      Volume=%h/claude-service/.claude.json:/data/.claude.json
systemctl --user daemon-reload && systemctl --user start claude-service.service
loginctl enable-linger $USER   # 브릿지로 이미 켜져 있으면 생략

# 4. (Pi) 헬스 — Bearer 는 평문 공유토큰(= BRIDGE_SECRET). 빈 messages → 400 이 정상
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H "Content-Type: application/json" -d '{"messages":[]}' http://localhost:7842/chat

# 5. (Pi) 브릿지를 localhost 로 플립 + 재시작
sed -i 's#^CLAUDE_SERVICE_URL=.*#CLAUDE_SERVICE_URL=http://localhost:7842#' ~/.config/term-bridge.env
systemctl --user restart term-bridge.service
```

검증: 클라이언트 토큰(`<ms>.<hmac-sha256(BRIDGE_SECRET, ms)>`)으로 `POST http://localhost:3000/claude/chat`
→ SSE delta 스트림 + `{"done":true,"reason":"success"}`.

**롤백**: `term-bridge.env` 의 `CLAUDE_SERVICE_URL` 을 데스크탑 IP 로 되돌리고 `systemctl --user restart term-bridge.service`.
데스크탑 claude-service 는 **끄지 말 것** — 일기 OCR 파이프라인도 그걸 호출하고, 채팅 롤백 경로다.

**메모리(1 GB Pi)**: idle ~68 MB, 채팅 1회 피크 ~360 MB(claude spawn ~293 MB). 단일 동시성은 편안,
동시 2개는 swap, 3개+ 는 OOM 위험. 일기 OCR(순차) + 개인 채팅이라 실사용은 사실상 1개.

## 트러블슈팅

- **401 unauthorized**: `BRIDGE_SHARED_TOKEN` 이 브릿지 `BRIDGE_SECRET` 과
  byte-identical 이어야 함. 앞뒤 공백, 줄바꿈 없는지 확인.
- **claude not found** (stderr에 출력): 컨테이너 안에 `@anthropic-ai/claude-code`
  가 설치 안 됐음. `podman exec -it claude-service which claude` 확인.
  이미지를 다시 빌드해야 할 수 있음.
- **OAuth credentials missing**: `~/.claude/` 디렉토리가 비어 있거나
  volume mount 실패. host에서 `ls ~/.claude/` 후 `claude login` 재실행.
  `podman inspect claude-service | grep -A5 Mounts` 로 마운트 경로 확인.
- **`claude` 가 API key 모드로 빠짐**: 컨테이너 환경변수에서 host의
  `ANTHROPIC_API_KEY` 가 leak 되지 않는지 `~/.config/claude-service.env` 확인.
  해당 변수가 없어야 OAuth 모드로 동작함.
- **컨테이너가 시작되지 않음**: `journalctl --user -u claude-service -n 100`
  으로 로그 확인. EnvironmentFile 경로와 Volume 경로 모두 실존하는지 확인.

## 보안

- 7842 포트를 외부에 노출하지 말 것. LAN only.
- Bearer 토큰이 유일한 보호 수단.
- OAuth credentials 마운트 권한:
  - **데스크탑**: host 에서 `claude login` 으로 갱신하므로 `:ro` 마운트해도 됨.
  - **Pi**: 인터랙티브 `claude login` 이 없어 서비스가 직접 access token 을
    갱신해 `.credentials.json` 에 써야 한다 → **쓰기 가능 마운트 필수**(`:ro` 금지).
- **공유 creds 회전 caveat**: 데스크탑과 Pi 가 같은 OAuth creds 사본을 쓰면
  refresh-token 회전 시 한쪽이 로그아웃될 수 있다. claude-code 는 멀티기기
  설계라 대개 괜찮지만, 한쪽이 갑자기 "Not logged in" 이 되면 Pi 에 독립
  `claude login`(헤드리스 OAuth — SSH 포트포워드 또는 코드 페이스트)으로 완전 분리.
