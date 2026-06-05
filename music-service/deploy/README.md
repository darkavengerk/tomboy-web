# music-service 배포 (데스크탑 전용)

yt-dlp 영상 → mp3 추출 후 브릿지 `/files`에 업로드. **개인·자기 호스팅, 권리 보유 콘텐츠 전제.**

## 선행
- 호스트에 `yt-dlp`, `ffmpeg` 설치 (`yt-dlp --version`, `ffmpeg -version`).
- `~/.config/music-service.env`:
  ```
  BRIDGE_SHARED_TOKEN=<= BRIDGE_SECRET 와 동일>
  BRIDGE_FILES_URL=https://<bridge-public-host>
  MUSIC_SERVICE_PORT=7844
  YTDLP_PATH=/usr/local/bin/yt-dlp   # PATH에 있으면 생략
  FFMPEG_PATH=/usr/bin/ffmpeg        # PATH에 있으면 생략
  MUSIC_MAX_FILESIZE=40M
  MUSIC_TIMEOUT_MS=180000
  ```
- 브릿지(Pi) `~/.config/term-bridge.env`에 `MUSIC_SERVICE_URL=http://<desktop-LAN-IP>:7844` 추가 후 브릿지 재기동.

## 빌드·기동
```bash
cd music-service && npm install && npm run build
cp deploy/music-service.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now music-service.service
systemctl --user status music-service.service
```

## 함정 (automation-service와 동일)
- **canonical 경로**: `/home`→`/var/home` 심볼릭링크 때문에 `.service`의 node·dist 경로는
  반드시 `/var/home/...` 실제 경로. 심볼릭 경로면 `import.meta.url` entry 가드가 깨져 서버가
  안 뜬다.
- **fnm node**: 시스템 node가 아니라 fnm default alias의 node 절대경로 사용.
- mp3 보관: 브릿지 `/files` 볼륨에 누적. 정리는 `/admin/files`에서 수동.
