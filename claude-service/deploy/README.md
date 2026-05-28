# claude-service 셋업

데스크탑(Ollama, ocr-service 와 같은 머신)에서 돌린다.
브릿지(Pi)에는 절대 깔지 않는다.

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

## 브릿지 설정

Pi 브릿지의 환경변수 파일에 추가:

```
CLAUDE_SERVICE_URL=http://<데스크탑-LAN-IP>:7842
```

이후 브릿지 재시작:

```bash
systemctl --user restart term-bridge.service
```

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
- OAuth credentials는 컨테이너 안에서 read-only 로 마운트해도 됨
  (Volume 옵션에 `:ro` 추가). 단, `claude login` 으로 갱신할 땐 host에서
  실행 후 컨테이너 재시작.
