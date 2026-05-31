# 브릿지 파일 업로드 — 설계

- **상태**: 디자인 확정, 구현 대기
- **작성일**: 2026-05-29
- **범위**: v1. 비이미지 파일을 브릿지에 업로드하고 노트에 다운로드 링크를 남긴다. 이미지 흐름(Vercel Blob → Dropbox 승격)은 그대로 둔다. 자동 정리, 진행률 바, orphan 스캔, 시간 만료, 진행 중 업로드 큐는 모두 명시적 후속.

## 1. 의도

현재 노트에 콘텐츠를 paste 하면 이미지만 잡힌다 (`extractImageFile`은 `image/*` MIME만 통과). PDF, zip, 소스 코드, 작은 영상 등의 비이미지 파일을 노트에 첨부할 방법이 없다.

이 작업은 **paste/drop/picker로 비이미지 파일을 받아 브릿지에 업로드하고, 노트에 다운로드 링크를 남기는 채널**을 추가한다.

저장소 선택의 근거:

- **Vercel Blob 아님** — 사용자가 의도적으로 자기 인프라(브릿지)에 두기를 요청.
- **Dropbox 아님** — Dropbox 쿼터 회피, 브릿지가 이미 존재하는 영속 인프라.
- **브릿지에 새 영속 볼륨** — 현재 브릿지 컨테이너는 `ReadOnly=true` + `Tmpfs=/tmp:rw,size=64m`로 영속 저장소가 없다. 새 Quadlet `Volume=` 마운트 필요.

## 2. 사용자 시나리오

### 2.1 비이미지 paste (기본 흐름)

1. 사용자가 노트 편집 중 PDF를 클립보드에서 paste 한다.
2. `extractAnyFile`이 이미지가 아니라고 판정 → `uploadBridgeFile(file)` 호출.
3. 토스트: "<filename> 업로드 중…".
4. 업로드 성공 → 응답 URL(`https://<bridge>/files/<uuid>/<filename>`)을 기존 `tomboyUrlLink` 마크로 감싸 에디터에 insert(이미지 흐름과 동일 패턴).
5. `filePreviewPlugin`이 URL을 보고 `[📎 filename]` 클릭 가능 뱃지를 widget decoration으로 렌더.
6. 사용자는 뱃지를 클릭하면 브라우저가 직접 파일을 다운로드한다.

### 2.2 파일 픽커

- **툴바**: 기존 이미지 업로드 버튼 옆에 "파일 첨부" 버튼. 클릭 → 숨겨진 `<input type="file" accept="*/*">` 트리거 → 위 paste 흐름과 동일.
- **우클릭 메뉴**: `EditorContextMenu`에 "파일 첨부" 항목. 동일 콜백.

### 2.3 이미지 + 비이미지 동시 paste

`extractAnyFile`은 이미지 우선 — 클립보드에 둘 다 있으면 이미지로 처리(기존 Vercel Blob 흐름). 비이미지만 있을 때 브릿지 흐름.

### 2.4 /admin/files

1. `/admin` → "파일" 탭으로 이동.
2. 브릿지에 업로드된 모든 파일을 테이블로 표시 (filename / size / mtime / 다운로드 링크 / 삭제 버튼).
3. mtime desc 기본 정렬, filename 부분 일치 검색.
4. 삭제는 confirm 다이얼로그 → DELETE 호출 → 즉시 목록 갱신.

### 2.5 토큰/설정 미구성 상태

기존 터미널 브릿지 토큰(`terminalBridgeToken`)과 URL(`defaultTerminalBridge`)을 재사용. 둘 중 하나라도 비어 있으면 paste/picker 시 토스트로 안내 "브릿지 설정이 필요해요." 에디터 무변경.

## 3. 아키텍처 개요

```
┌── 클라이언트 (TomboyEditor) ───────────────────────────────┐
│ paste/drop/picker → extractAnyFile(dt) → isImage?         │
│   yes → 기존 Vercel Blob 경로 (uploadTempImage)            │
│   no  → uploadBridgeFile(file)                             │
│         POST <bridgeHttp>/files                            │
│         Authorization: Bearer <terminalBridgeToken>        │
│         Content-Type: <file.type>                          │
│         X-Filename: <urlencode(file.name)>                 │
│         body: raw bytes                                    │
│   응답 url을 tomboyUrlLink 마크로 감싸 editor에 insert     │
└──────────────────────────────────────────────────────────┘
                            ↑ HTTPS (Caddy reverse proxy)
┌── Bridge (term-bridge container, 새 Volume mount) ────────┐
│ POST /files (Bearer)                                       │
│   1. Bearer 검증 → 401                                     │
│   2. Content-Length > 50 MiB → 413                         │
│   3. X-Filename → sanitize                                 │
│   4. uuid v4 발급                                          │
│   5. mkdir -p $BRIDGE_FILES_DIR/<uuid>                     │
│   6. stream req body → <uuid>/<sanitized-filename>         │
│   7. → { url, filename, size, uuid }                       │
│                                                            │
│ GET /files/<uuid>/<filename>  (인증 없음, 추측 불가 ID)    │
│   - 파일 + 이름 일치 검증 → 404                            │
│   - Content-Type 추론 + Content-Disposition attachment     │
│   - ETag: "<uuid>", Cache-Control: immutable               │
│                                                            │
│ GET /files                    (Bearer, /admin 용)          │
│   - readdir → [{ uuid, filename, size, mtime }]            │
│                                                            │
│ DELETE /files/<uuid>          (Bearer, /admin 용)          │
│   - rm -rf <uuid>/                                         │
└──────────────────────────────────────────────────────────┘
                            ↓
          %h/.local/share/term-bridge/files/<uuid>/<filename>
          (Quadlet Volume, rw,z, 호스트 영속)
```

## 4. 컴포넌트

### 4.1 Bridge (`bridge/src/`)

- **`files.ts`** (신규)
  - `handleFileUpload(req, res, secret, baseDir)`
  - `handleFileDownload(req, res, baseDir)`
  - `handleFileList(req, res, secret, baseDir)`
  - `handleFileDelete(req, res, secret, baseDir)`
  - `sanitizeFilename(raw): string` — export. basename → NFC → 제어문자/path 분리자 제거 → trim → 255 byte 컷 → 빈 결과면 `untitled`.
- **`server.ts`** — 라우트 4개 등록. `BRIDGE_FILES_DIR` 환경변수 부팅 시 검증(없으면 부팅 거부, `OCR_SERVICE_URL`과 같은 패턴).
- **`files.test.ts`** (신규, `node --test`) — sanitize, 401, 413, 라운드트립, list, delete, path traversal 방어.
- **`deploy/term-bridge.container`**
  - `Volume=%h/.local/share/term-bridge/files:/var/lib/term-bridge/files:rw,z`
  - `Environment=BRIDGE_FILES_DIR=/var/lib/term-bridge/files`
  - README: 사전 `mkdir -p ~/.local/share/term-bridge/files`(`hosts.json` 패턴 — 디렉토리 없으면 podman이 파일로 만들어 마운트 깨짐).

### 4.2 App — 클라이언트 SDK (`app/src/lib/sync/`)

- **`bridgeFileUpload.ts`** (신규)
  - `uploadBridgeFile(file: File): Promise<{ url: string; filename: string; size: number; uuid: string }>`
  - `bridgeSettings`에서 token/URL read.
  - 50 MiB 클라 사전 컷.
  - 에러 분류: `network` / `unauthorized` (401) / `too_large` (413) / `server` (5xx) / `bridge_not_configured`.
- **`bridgeFileAdmin.ts`** (신규)
  - `listBridgeFiles(): Promise<BridgeFileMeta[]>`
  - `deleteBridgeFile(uuid: string): Promise<void>`
  - `BridgeFileMeta = { uuid: string; filename: string; size: number; mtime: string }` — filename은 디스크에 저장된 post-sanitize 이름.

### 4.3 App — 에디터 통합 (`app/src/lib/editor/`)

- **`extractFile.ts`** (신규)
  - `extractAnyFile(dt: DataTransfer | null): { file: File; isImage: boolean } | null`
  - 이미지 우선.
- **`TomboyEditor.svelte`** — `handlePaste` / `handleDrop`에서 이미지 분기 후 fall-through로 `uploadAndInsertFile(file)` 추가. 새 함수가 `uploadBridgeFile` 호출 → 응답 URL을 `tomboyUrlLink` 마크로 감싸 insert (이미지 흐름과 동일 — `TomboyEditor.svelte:1127-1134`).
- **`Toolbar.svelte`** — 기존 이미지 input 옆에 `<input type="file" accept="*/*">` + 새 버튼 + `onuploadfile` 이벤트.
- **`EditorContextMenu.svelte`** — "파일 첨부" 항목 추가, `onuploadfile`로 부모에 위임.
- **`filePreview/`** (신규 디렉토리)
  - `filePreviewPlugin.ts` — ProseMirror Plugin. 정규식으로 `https?://<bridgeHost>/files/<uuid>/<name>` 검출 → widget decoration으로 `[📎 filename]` 클릭 가능 `<a href>` 렌더. 호스트는 plugin `view()` lifecycle에서 `getDefaultTerminalBridge()` + `bridgeToHttpBase()`로 비동기 resolve, resolve 완료 시 `setMeta('rebuild')`로 재빌드.
  - `fileBadge.ts` — `createFileBadgeElement(url)` 순수 헬퍼.
  - 테스트: URL 파싱, decoration 위치, 비-bridge URL 무시, badge href.

### 4.4 App — /admin (`app/src/routes/admin/files/`)

- **`+page.svelte`** — 파일 목록 테이블 (filename / size / mtime / 다운로드 링크 / 삭제 버튼). mtime desc 기본, filename 부분 일치 검색. 삭제 confirm 다이얼로그.
- 단위 테스트: list mock → 테이블 렌더 / empty state / 삭제 confirm → delete 호출.

### 4.5 설정

- 신규 설정 없음.
- 기존 `terminalBridgeToken` / `defaultTerminalBridge` 재사용.

## 5. 핵심 invariants

- **추측 불가 ID에 다운로드 보안 의존.** UUID v4 = 122-bit 엔트로피. URL이 유출되면 파일 노출 — Dropbox 공유 링크와 동일 모델. 사용자가 이해해야 함.
- **업로드는 Bearer 보호.** 무단 업로드 방지.
- **노트 source = URL 텍스트 + 기존 `tomboyUrlLink` 마크.** 이미지 흐름과 같은 패턴(`TomboyEditor.svelte:1127-1134`). 새 mark/node 정의 없음(`tomboyUrlLink`는 이미 존재). `noteContentArchiver`도 한 줄도 변경하지 않음 → Tomboy XML 라운드트립은 기존 `<link:url>` 경로 그대로 사용 → 무손상.
- **이미지 흐름 무변경.** `imageUpload.ts`, `tempImageUpload.ts`, `imagePreviewPlugin.ts` 0줄 변경. paste 분기 단 한 곳에서 fall-through 추가.
- **브릿지 URL 변경 시 기존 링크 깨짐.** 알려진 한계. 자동 마이그레이션 없음. README에 명시.
- **`<bridge>/files/<uuid>` host + path 매칭으로만 `filePreviewPlugin` 활성.** 다른 호스트의 `/files/...`는 무시 → 오작동 방지.
- **파일 dedupe 없음.** 같은 파일 두 번 업로드 = UUID 두 개. /admin에서 수동 정리.
- **자동 만료/정리 없음.** orphan 스캔도 없음. 사용자의 명시적 행동으로만 정리.
- **`BRIDGE_FILES_DIR`이 비어 있으면 브릿지 부팅 거부.** OCR_SERVICE_URL과 같은 패턴 — 운영 실수 사전 차단.
- **파일명 sanitize는 서버 측에서만 신뢰.** 클라이언트가 보낸 X-Filename은 검증 통과 후 저장. path.resolve 결과가 baseDir 시작인지 2차 검증.
- **응답 URL의 filename은 post-sanitize 결과를 percent-encode 한 값.** 클라이언트가 보낸 X-Filename과 다를 수 있음(sanitize로 잘리거나 정규화될 때). 노트에 박히는 URL은 이 값. `filePreviewPlugin`이 뱃지 표시할 때 `decodeURIComponent(lastSegment)`로 복원.
- **Caddyfile 변경 없음.** 기존 `reverse_proxy 127.0.0.1:3000`이 모든 path를 그대로 전달. 새 `/files/*` 라우트도 자동 처리. `/files/<uuid>/<name>`는 우리 핸들러가 `Cache-Control: public, immutable`로 응답하므로 Caddy의 `/login`/`/health` no-store 규칙과 충돌 없음.

## 6. 에러 & 엣지케이스

### 6.1 업로드 실패

| 케이스 | 응답 | UI |
|---|---|---|
| Bearer 누락/만료 | 401 | 토스트 "브릿지 토큰이 만료됐어요. 설정에서 다시 로그인하세요." 에디터 무변경 |
| 50 MiB 초과 | 413 (또는 클라 사전 컷) | 토스트 "파일이 너무 커요 (50 MiB 한도)." 에디터 무변경 |
| 네트워크/5xx | — | 토스트 "브릿지에 업로드 실패 — 다시 시도해주세요." 에디터 무변경 |
| 빈 파일 | 클라 사전 거부 | 토스트 "빈 파일은 업로드할 수 없어요." |
| 디스크 풀 (`ENOSPC`) | 500 | 토스트 "브릿지 디스크가 가득 찼어요." 부분 디렉토리 정리 |
| 설정 미구성 | — (클라에서 차단) | 토스트 "브릿지 설정이 필요해요." |

### 6.2 다운로드

- 인증 없음(추측 불가 ID 의존).
- 디스크의 sanitized 파일명과 URL의 filename 부분 불일치 → 404. URL 유추로 다른 파일 접근 불가.
- 알려지지 않은 확장자 → `application/octet-stream`.
- `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>` — 한글 파일명 안전.
- `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<uuid>"`.

### 6.3 Path traversal 방어

- 다운로드/삭제 경로의 `<uuid>` — 정규식 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` 통과 필수. 실패 시 400.
- 업로드 X-Filename — sanitize 후 `path.resolve(baseDir, uuid, name)`이 `baseDir`로 시작하는지 2차 검증. 실패 시 400.

### 6.4 동시성

- 동시 업로드 N개 = Node 자연 동시성으로 처리.
- Stream 도중 실패 → `try/finally`로 부분 UUID 디렉토리 정리.
- 같은 파일 두 번 업로드 = UUID 두 개 (dedupe 없음).

### 6.5 노트 측 엣지

- 이미지 + 비이미지 동시 paste → 이미지 우선 (기존 Vercel Blob 흐름).
- `filePreviewPlugin` host 매칭은 runtime resolve. 첫 doc render 시점에는 base가 아직 빈 문자열이라 매칭 0개; plugin `view()` lifecycle에서 base가 resolve되면 `setMeta('rebuild')`로 한 번 재빌드. 알려진 작은 지연.
- 브릿지 URL이 바뀌면 기존 노트의 모든 파일 링크 끊김. 알려진 한계.

## 7. 테스트 전략

### 7.1 Bridge (`bridge/`, `node --test`)

`files.test.ts` — 기존 `ocr.test.ts` mock 패턴(`Readable.from`, response capture) 재사용.

- `sanitizeFilename`: path 컴포넌트 제거, NFC, 255-byte 컷, 빈 결과 → `untitled`, 제어문자 제거
- upload 401 (no bearer) / 413 (Content-Length 초과) / 200 + JSON + 디스크 확인 (tmpdir)
- upload 빈 X-Filename → `untitled` 폴백
- download 200 + Content-Disposition / 404 (uuid 미존재) / 404 (filename 불일치)
- download path traversal — uuid `../etc` / filename `../passwd` → 400
- list Bearer + 빈 디렉토리 / 파일 여러 개
- delete 200 + 디렉토리 제거 확인 / 404 (uuid 미존재)
- 라운드트립: upload → download → byte-identical 응답

### 7.2 App (`app/`, vitest)

| 모듈 | 테스트 |
|---|---|
| `sync/bridgeFileUpload.test.ts` | fetch mock — Bearer/Content-Type/X-Filename, 50 MiB 사전 컷, 에러 분류 |
| `sync/bridgeFileAdmin.test.ts` | list / delete fetch mock |
| `editor/extractFile.test.ts` | DataTransfer mock: image 우선, image+file → image, file only → file, 빈 dt → null |
| `editor/filePreview/filePreviewPlugin.test.ts` | bridge URL → decoration 정확, non-bridge URL → 무시, host 미스매치 → 무시, badge href = URL |
| `editor/filePreview/fileBadge.test.ts` | filename 추출(URL의 마지막 segment, decodeURIComponent), 빈 filename 폴백 |
| `routes/admin/files/+page.test.ts` | mock list → 테이블 렌더 / empty / 삭제 confirm → delete 호출 |
| `editor/Toolbar.test.ts` (확장) | 파일 첨부 버튼 클릭 → input.click() → onuploadfile fired |
| `editor/EditorContextMenu.test.ts` (확장) | 파일 첨부 항목 표시, 클릭 → 콜백 fired |

### 7.3 Tomboy XML 라운드트립

editor에 URL 텍스트 insert → `archiveNoteContent` → `unarchiveNoteContent` → URL byte-identical assert. 기존 image URL 테스트가 이미 같은 보장이므로 동일 패턴 한 줄.

### 7.4 수동 검증 (CLAUDE.md "No e2e" 원칙)

1. `~/.local/share/term-bridge/files/` mkdir → `podman build` → Quadlet reload → `systemctl --user restart term-bridge.service`.
2. `npm run dev` → 노트 열기 → toolbar 파일 첨부 → PDF 픽업 → 토스트 → URL plain text 삽입 + 뱃지 렌더.
3. 뱃지 클릭 → 브라우저 다운로드 (Content-Disposition 동작).
4. 드래그&드롭 / Ctrl+C → Ctrl+V 변형 검증.
5. `/admin/files` 목록 확인 → 삭제 → 뱃지 클릭 → 404.
6. 50 MiB 초과 파일 → 토스트, 에디터 무변경.
7. 토큰 일부러 깸 → 401 토스트.
8. Pi 재시작 → 파일 영속 확인.

## 8. 변경되지 않는 것 (의도적)

- `imageUpload.ts`, `tempImageUpload.ts`, `imagePromotion.ts`, `imagePreviewPlugin.ts` — 0줄 변경.
- `noteContentArchiver.ts` — 0줄 변경.
- 기존 모든 mark/node 정의 — 0줄 변경.
- `tomboyUrlLink`, `tomboyInternalLink` — 0줄 변경.
- `terminalBridgeToken` / `defaultTerminalBridge` 설정 — 그대로 재사용 (새 키 없음).
- 기존 모든 브릿지 라우트 (`/ocr`, `/claude/chat`, `/gpu/*`, `/remarkable/*`, `/ws`) — 0줄 변경.

## 9. 명시적 후속 (v1 범위 밖)

- 업로드 진행률 바.
- 자동 만료 / 시간 기반 정리.
- Orphan 스캔 (디스크에 있지만 노트가 참조하지 않는 파일).
- 자동 retry 큐.
- Dedupe (content hash 기반).
- 인-에디터 우클릭으로 파일 삭제.
- 브릿지 URL 변경 시 자동 마이그레이션.
- 미리보기 (PDF, 이미지가 아닌 미디어).
- 파일별 access 로그.
- 확장자별 아이콘 (📎 외).

## 10. Out of Scope

- 다른 디바이스에서 같은 파일에 접근 — URL이 노트에 박혀 있으므로 자동으로 동작(브릿지가 외부에서 접근 가능하다는 전제 하).
- 외부 사용자와 파일 공유 — 노트에 박힌 URL을 외부에 노출하면 그대로 다운로드 가능(Dropbox 공유 링크와 같은 모델). 별도 ACL 없음.
- 이미지를 브릿지로 옮기는 마이그레이션 — 기존 이미지 흐름은 그대로.

## 11. Tomboy desktop interop

URL은 plain text로 `<note-content>`에 들어가므로 Dropbox 동기화 후 Tomboy desktop에서 노트를 열어도 XML은 정상적으로 파싱된다. desktop 측에서는 뱃지 대신 raw URL이 보이지만, URL 자동 감지 기능으로 클릭 가능 — 브라우저가 열리고 다운로드된다. 의도된 graceful degradation.
