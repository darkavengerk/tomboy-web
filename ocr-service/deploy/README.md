# ocr-service 배포 (데스크탑)

이 서비스는 **데스크탑(RTX 3080) 에서만** 돌린다. Pi 브릿지는 별도 머신이며 GPU가 없다. 브릿지에서 `OCR_SERVICE_URL=http://<desktop-host-ip>:8080` 환경변수로 이 컨테이너를 가리킨다.

## 머신 분리 invariant

- **Pi (브릿지)**: GPU 없음. 모델 호스팅 안 함. 라우팅·인증·SSH 터미널만.
- **데스크탑 (이 서비스)**: RTX 3080. Ollama + ocr-service 둘 다 호스팅.

같은 머신을 가정한 채로 작업하다 두 번 실수한 적이 있다. 이 단락이 그 invariant를 시각적으로 박아두기 위한 것.

## 사전 요구

- Fedora / Bazzite (테스트 환경) + rootless Podman 5+
- `nvidia-container-toolkit` CDI 모드 — `/etc/cdi/nvidia.yaml` 생성 완료
- 데스크탑과 Pi가 같은 LAN
- 방화벽에서 `8080` 포트는 LAN 만 허용 (외부 인터넷 노출 금지)

## 빌드 + 첫 부팅

1. **이미지 빌드** — CUDA 베이스 이미지 다운로드로 5~10분 소요:
   ```bash
   cd ocr-service && podman build -t ocr-service:latest .
   ```

2. **Quadlet 유닛 설치**:
   ```bash
   cp deploy/ocr-service.container ~/.config/containers/systemd/
   ```

3. **환경변수 파일**:
   ```bash
   cat > ~/.config/ocr-service.env <<EOF
   BRIDGE_SHARED_TOKEN=<bridge 와 동일한 32자+ 랜덤 토큰>
   OCR_IDLE_UNLOAD_S=300
   OCR_MODEL_ID=stepfun-ai/GOT-OCR2_0
   EOF
   chmod 600 ~/.config/ocr-service.env
   ```

4. **부팅**:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now ocr-service.service
   loginctl enable-linger $USER   # 로그아웃 후에도 컨테이너 유지
   ```

5. **검증** (LAN 의 다른 머신 또는 데스크탑 자체에서):
   ```bash
   curl -fsS http://localhost:8080/healthz   # → {"ok":true}
   curl -fsS -H "Authorization: Bearer <token>" http://localhost:8080/status
   ```

## 모델 가중치

첫 번째 `/ocr` 호출에서 HuggingFace 에서 `stepfun-ai/GOT-OCR2_0` (~1.2GB) 가 자동 다운로드된다. Volume 마운트(`~/.cache/huggingface`) 덕분에 컨테이너 재시작/재빌드 후에도 캐시 유지됨.

## 운영 메모

- `idle_unload_s` 기본값 300초 (5분). 사용 패턴에 따라 조정. 짧을수록 다른 모델(Ollama) 에 VRAM 자리 양보가 빠름.
- 컨테이너 안에서 `nvidia-smi` 가 안 보이면 CDI 설정 문제. `podman run --rm --device nvidia.com/gpu=all docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi` 로 격리 진단.
- 로그: `journalctl --user -u ocr-service.service -f`
