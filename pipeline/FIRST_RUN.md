# 첫 실행 체크리스트

리마커블 일기 OCR 파이프라인 수동 e2e 테스트 단계. 재부팅 후 위에서부터 순서대로.

---

## 0. 재부팅 후: 시스템 헤더 적용 + rmrl 설치

`rpm-ostree`는 reboot 후에 적용되니까 재부팅 끝나고 바로:

```bash
cd ~/workspace/tomboy-web/pipeline
source .venv/bin/activate
pip install -e .[rmrl]
```

이게 통과하면 `.rm` → PDF/PNG 렌더링이 가능해진 상태.

검증:
```bash
python -c "import rmrl; print(rmrl.__version__)"
```

---

## 1. 부트스트랩 (1회만)

```bash
python -m desktop.bootstrap
```

준비물:
- **Dropbox 앱 키** — `PUBLIC_DROPBOX_APP_KEY` (Tomboy 웹앱과 같은 값). 브라우저로 OAuth 진행.
- **Firebase 서비스 계정 JSON 경로** — Firebase Console → 프로젝트 설정 → 서비스 계정에서 다운로드해 두기.
- **Pi SSH 접속 정보** — 호스트, 포트, 사용자, ed25519 키 경로.

결과: `pipeline/config/pipeline.yaml` 생성됨 (gitignore). 인쇄되는 `firebase_uid`(`dbx-...`)가 Tomboy 웹앱에서 쓰는 uid와 일치해야 함.

미리보기만 하고 싶으면:
```bash
python -m desktop.bootstrap --dry-run
```

---

## 2. Pi 측 + rM 측 설치

`pipeline/pi/README.md` 전체를 따라가세요. 두 디바이스에 모두 설정 필요.

### 2-A. Pi 쪽 (Pi에 SSH로 들어가서)
- `diary-sync` 사용자 + `~/diary/{inbox,archive,state}` 디렉토리
- pipeline 패키지 설치 (`pip install -e .`)
- sshd 하드닝: ed25519 키만, 비표준 포트, `AllowUsers diary-sync`, fail2ban
- 라우터 포트포워딩 (WAN 노출용)
- `pi-watcher.service` + `pi-watcher.timer` 등록 (5분 주기 인덱스 갱신)

### 2-B. rM 쪽 (rM에 `ssh root@<rm-ip>` 접속해서) — **필수, 옵션 아님**

rM이 능동적으로 Pi에게 푸시합니다. Pi는 rM에 접속 안 합니다. 따라서 rM에 다음 3개가 있어야 자동화가 시작됩니다:

1. **ed25519 키페어 생성** (`~/.ssh/id_diary`) → 공개키를 Pi의 `diary-sync` 사용자 `authorized_keys`에 추가
2. **`/home/root/diary-push.sh`** — `Diary` 노트북의 모든 페이지를 Pi 인박스로 rsync (스크립트 본문은 `pipeline/pi/README.md`)
3. **cron 등록**:
   ```
   */5 * * * * /home/root/diary-push.sh > /tmp/diary-push.log 2>&1
   ```

**rM 펌웨어 업데이트 주의:** 업데이트하면 `/home/root` 변경사항이 날아갑니다. 업데이트마다 cron + 키 + 스크립트 다시 확인 (체크리스트는 `pi/README.md` 4단원).

### 검증
데스크탑에서 Pi 타이머 살아있나:
```bash
ssh -p <port> -i <key> diary-sync@<pi-host> "systemctl --user status pi-watcher.timer"
```

rM에서 cron 살아있나:
```bash
ssh root@<rm-ip> "crontab -l"
ssh root@<rm-ip> "tail /tmp/diary-push.log"
```

---

## 3. 테스트 페이지 1장 준비

rM 태블릿에서:
1. `Diary` 폴더(또는 부트스트랩 때 지정한 노트북 이름) 안에 페이지 1장 작성 — 한국어 손글씨 짧게.
2. WiFi/USB 동기화로 Pi 인박스까지 도달.

Pi 인박스 도착 확인:
```bash
ssh -p <port> -i <key> <user>@<pi-host> "ls ~/diary/inbox/"
# <uuid>.metadata + <uuid>.rm 가 보여야 함
```

---

## 4. 단계별 수동 실행 (디버깅에 유리)

```bash
cd ~/workspace/tomboy-web/pipeline
source .venv/bin/activate

# S1: Pi 인박스 → 데스크탑 raw/
python -m desktop.stages.s1_fetch
ls ~/.local/share/tomboy-pipeline/raw/

# S2: .rm → PNG (rmrl 호출)
python -m desktop.stages.s2_prepare
ls ~/.local/share/tomboy-pipeline/png/

# S3: PNG → OCR (Qwen2.5-VL-7B 첫 로드 시 ~10GB 다운로드, 수 분 소요)
python -m desktop.stages.s3_ocr
cat ~/.local/share/tomboy-pipeline/ocr/<uuid>.json

# S4: Dropbox 업로드 + Firestore 쓰기
python -m desktop.stages.s4_write
```

한 번에:
```bash
python -m desktop.run_pipeline
```

특정 페이지만 강제로 다시:
```bash
python -m desktop.stages.s4_write --force <rm-uuid>
```

---

## 5. 결과 확인 — 3곳

| 위치 | 확인 사항 |
|------|----------|
| **Firestore 콘솔** | `users/dbx-<uid>/notes/<guid>` 문서 존재, `xmlContent`에 `<note-content>` 들어있음 |
| **Dropbox** | `/Apps/Tomboy/diary-images/yyyy/mm/dd/<rm-uuid>/page.png` 업로드됨 |
| **Tomboy 웹앱** | 설정 → 동기화 설정 → **Firebase 실시간 동기화 ON** 상태에서 `일기` 노트북에 새 노트 |

새 노트 확인 포인트:
- 제목: `2026-05-10 리마커블([<rm-uuid>])`
- 본문: Dropbox 이미지 링크 + `---` + OCR 텍스트

---

## 6. 교정 흐름 검증 (보호 신호 테스트)

1. Tomboy 웹앱에서 노트 본문 OCR 부분 수정.
2. **제목에서 `[<rm-uuid>]` 부분 삭제** — 이게 보호 신호.
3. 같은 rM 페이지에 대해 다시 실행:
   ```bash
   python -m desktop.run_pipeline
   ```
4. 기대 결과: 같은 노트는 그대로, 새 노트도 안 생김 (uuid 매핑 못 찾음 + 이미 처리됨).
5. 교정 데이터 추출:
   ```bash
   python -m desktop.tools.extract_corrections
   cat ~/.local/share/tomboy-pipeline/corrections/corrections.jsonl
   ```

---

## 7. 문제 진단 빠른 표

| 증상 | 확인 |
|------|------|
| `torch.cuda.OutOfMemoryError` | `vlm.max_image_px` 1568 → 1024, `nvidia-smi`로 다른 프로세스 점검 |
| Pi SSH 실패 | `ssh -p <port> -i <key> <user>@<pi-host> echo ok` 직접 시도 |
| `PermissionDenied` (Firestore) | 서비스 계정 JSON 경로 + `firebase_uid` 일치 확인 |
| 앱에 노트 안 보임 | Firebase 실시간 동기화 ON 여부, `dropbox_account_id` ↔ 앱 로그인 계정 일치 확인 |
| `import rmrl` 실패 | `[rmrl]` 설치 안 됐거나 freetype-devel 미반영 — 재부팅 했는지 확인 |

자세한 케이스는 `pipeline/README.md`의 Troubleshooting 섹션.

---

## 8. 만족하면 자동화

```bash
cp pipeline/desktop/deploy/desktop-pipeline.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now desktop-pipeline.timer
journalctl --user -u desktop-pipeline.service -f   # 로그 따라가기
```

30분마다 `run_pipeline` 자동 실행. 필요 없으면:
```bash
systemctl --user disable --now desktop-pipeline.timer
```
