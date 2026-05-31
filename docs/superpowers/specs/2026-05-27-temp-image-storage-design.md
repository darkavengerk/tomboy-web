# 이미지 임시 저장소 (Vercel Blob) — 설계

- **상태**: 디자인 확정, 구현 대기
- **작성일**: 2026-05-27
- **범위**: v1. 모든 신규 paste를 Vercel Blob에 보관 + admin에서 수동으로 Dropbox 승격/삭제. 자동 만료·시간 기반 정리·in-editor 우클릭 승격 메뉴는 명시적 후속.

## 1. 의도

현재 노트에 이미지를 붙여넣으면 모두 Dropbox에 업로드된다 (`lib/sync/imageUpload.ts`).
"이 이미지는 보관할 만큼 중요한가?"를 paste 시점에 판단하기 어렵고,
대부분의 스크린샷·임시 이미지가 Dropbox 백업 채널을 영구적으로 점유한다.

이 작업은 저장소를 **두 채널**로 분리한다:

- **Dropbox (보관 채널)** — 사용자가 명시적으로 "이 이미지는 보관" 결정한 것
- **Vercel Blob (임시 채널)** — 그 외 모든 paste의 기본 행선지

기본은 임시고, admin 페이지에서 사용자가 가치 있다고 판단한 이미지만
"Dropbox로 저장"을 눌러 승격한다 (URL 교체 + Vercel blob 정리).
자동 만료 정책은 없다 — 정리는 사용자의 명시적 행동(개별 승격 또는 개별 삭제)으로만 일어난다.

## 2. 사용자 시나리오

### 2.1 새 이미지 paste (기본 흐름)

1. 사용자가 노트 편집 중 이미지를 paste 한다.
2. 이미지가 Vercel Blob에 업로드되고 URL이 노트에 박힌다 (오늘과 동일하게 `tomboyUrlLink` mark로 감싼 텍스트).
3. `imagePreviewPlugin`이 URL을 보고 `<img>` widget을 그린다.
4. 사용자는 동작상 차이를 느끼지 않는다 — 이미지가 보인다는 사실만 그대로.

### 2.2 임시 이미지 관리 (admin)

1. `/admin` → "이미지" 탭으로 이동.
2. 노트에 박힌 모든 이미지 + Vercel에 있는 오펀 blob까지 그리드로 표시.
3. 각 카드: 썸네일 + badge (`임시` / `저장됨` / `외부`) + 사용 노트 목록.
4. `임시` 카드에서 "Dropbox로 저장" 클릭 → 승격 진행 → 카드가 `저장됨`으로 갱신됨.
5. `임시` 카드에서 "삭제" 클릭 → 사용 중이면 confirm → blob 삭제 (노트의 URL은 그대로 두어 의도적으로 깨진 이미지 상태).

### 2.3 토큰 미설정 상태

설정 페이지에 "이미지 서버 토큰" 입력 필드가 새로 생긴다 (터미널 브릿지 토큰 옆).
토큰이 비어 있으면 paste 시 토스트로 안내하고 paste 자체는 실패한다 (이미지 안 박힘, 텍스트 상태 무변경).

## 3. 아키텍처 개요

```
[1] 업로드 (editor paste)
   브라우저 → POST /api/temp-image (Bearer 검증, 토큰 발급)
          → @vercel/blob/client.upload() → Vercel Blob (직접 PUT)
          → 노트에 URL 텍스트 + tomboyUrlLink mark

[2] Admin 인벤토리 (/admin/images)
   loadImageInventory()
     ├─ scanNotesForImages()         ── 로컬 IDB의 모든 노트 xmlContent 스캔
     └─ GET /api/temp-image/list     ── Vercel Blob list() (오펀 검출용)
   → 합집합 → 카드 그리드

[3] 승격 (Dropbox로 저장)
   promoteImageToDropbox(tempUrl)
     1. fetch(tempUrl) → 바이트
     2. uploadImageToDropbox(bytes)        ── 기존 함수 그대로
     3. scanNotesForImages()로 affected 노트 확정
     4. for each affected: load → string-replace URL → putNote (localDirty=true)
     5. noteReloadBus.emitNoteReload(affectedGuids)
     6. DELETE /api/temp-image?url=…       ── Vercel blob 정리
```

### 3.1 핵심 invariant

- **기존 Dropbox 이미지는 그대로 둔다.** 마이그레이션 없음. 변경은 "앞으로의 paste"에만 적용.
- **터미널 노트 이미지 paste / 일기 파이프라인 / OCR 노트는 영향 없음.** 각각 SSH ControlMaster · 데스크탑 파이프라인 · 기존 Dropbox 경로를 따로 사용한다.
- **노트가 single source of truth, blob은 dumb byte store.** Vercel 측에 사이드 메타데이터(노트 매핑 등) 안 저장.
- **CLAUDE.md "No server runtime" invariant 수정 필요.** 이 작업은 단일 함수 endpoint(`/api/temp-image/*`)를 도입한다. 그 외 모든 라우트는 static 유지. CLAUDE.md 문구를 같이 갱신해야 한다.

### 3.2 빌드 측 변경

- adapter 교체: `@sveltejs/adapter-static` → `@sveltejs/adapter-vercel`.
  adapter-vercel은 `prerender = true`인 라우트는 그대로 static으로 빌드하고 `/api/*`만 함수로 빌드한다.
  클라이언트 단의 동작은 동일.
- 신규 의존성: `@vercel/blob`
- env vars:
  - `BLOB_READ_WRITE_TOKEN` — Vercel Blob integration 활성화 시 자동 주입.
  - `IMAGE_STORAGE_TOKEN` — 우리가 정한 Bearer 시크릿. 클라이언트의 `appSettings.imageStorageToken`과 byte-identical.

## 4. 컴포넌트 / 파일 책임

### 4.1 클라이언트 (신규 모듈)

| 파일 | 책임 |
|---|---|
| `app/src/lib/sync/tempImageUpload.ts` | `uploadTempImage(file)` / `deleteTempImage(url)` / `listTempImages()` — `/api/temp-image/*` 래퍼. Bearer 토큰을 `appSettings`에서 읽어 헤더로 첨부. `@vercel/blob/client`의 `upload()`를 호출. |
| `app/src/lib/sync/imageInventory.ts` | `scanNotesForImages()` — 모든 노트의 xmlContent에서 이미지 URL 추출 (`isImageUrl` 재사용). `classifyImageUrl(url)` — host로 `'temp' \| 'dropbox' \| 'external'` 반환. `loadImageInventory()` — note-scan + Vercel list 합쳐 `ImageInventoryItem[]` 반환. |
| `app/src/lib/sync/imagePromotion.ts` | `promoteImageToDropbox(tempUrl)` — fetch → Dropbox 업로드 → 노트 URL rewrite → Vercel 삭제 트랜잭션. 영향 받은 guid 목록 리턴. |

### 4.2 클라이언트 (기존 파일 수정)

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/TomboyEditor.svelte:1088` | `uploadImageToDropbox(file)` → `uploadTempImage(file)`. 호출부 한 줄 교체. URL 삽입 로직은 그대로. |
| `app/src/lib/storage/appSettings.ts` | `imageStorageToken: string` 키 추가. |
| `app/src/routes/settings/+page.svelte` | "이미지 서버 토큰" 입력 필드 추가 (터미널 브릿지 토큰 옆, 같은 디자인 패턴). |
| `app/src/routes/admin/+layout.svelte` | sub-nav에 "이미지" 항목 추가. |
| `app/src/lib/ocrNote/runOcrInEditor.ts:7` | `downloadImageFromDropboxUrl` 호출을 `downloadImageFromUrl`로 변경. 후자는 `lib/sync/imageUpload.ts`에 새로 추가 — host가 dropbox면 기존 SDK 경로, 아니면 plain `fetch()` (Vercel Blob은 CORS 열려 있음). |
| `CLAUDE.md` | "No server runtime" invariant 문구 갱신. |

### 4.3 클라이언트 (신규 라우트)

| 파일 | 책임 |
|---|---|
| `app/src/routes/admin/images/+page.svelte` | 그리드 UI. 카드: 썸네일 + badge + 사용 노트 목록 + 액션 버튼. `임시`만 "Dropbox로 저장" / "삭제" 노출. `저장됨` / `외부`는 표시만. |

### 4.4 서버 (신규)

`app/src/routes/api/temp-image/` 아래 SvelteKit 함수. 모두 `Authorization: Bearer <env.IMAGE_STORAGE_TOKEN>` 검증을 같은 헬퍼 `requireBearer(req)`로 처리. 모두 `export const prerender = false;`.

| 파일 | 메서드 |
|---|---|
| `+server.ts` | `POST` — `@vercel/blob`의 `handleUpload()`로 단발성 클라이언트 업로드 토큰 발급. `DELETE ?url=…` — `del(url)` 호출. |
| `list/+server.ts` | `GET` — `list()` 결과를 `{ url, size, uploadedAt }[]`로 정규화해 반환. |

## 5. 데이터 모델

### 5.1 노트 본문 안의 이미지 URL — 스키마 변경 없음

오늘과 동일. URL이 plain text로 들어가고 `tomboyUrlLink` mark로 감싸진다.
`imagePreviewPlugin`이 URL을 보고 `<img>` widget을 렌더한다.
.note round-trip · Dropbox sync · Firebase sync 모두 URL을 "일반 외부 링크"로만 보므로 변경 없음.
승격 후에는 같은 자리에 Dropbox URL이 들어가 있을 뿐.

```xml
<note-content>
  ...
  <link:url>https://i65f7yzcrcl5ufx7.public.blob.vercel-storage.com/temp-images/abc123.png</link:url>
  ...
</note-content>
```

### 5.2 Vercel Blob 객체 — 메타데이터 없음

```
{BLOB_HOST}/temp-images/{uuid}.{ext}
```

- pathname prefix `temp-images/` — 향후 같은 Blob 스토어에 다른 용도가 생기면 격리.
- Vercel Blob에 사이드 메타데이터 저장 안 함.

### 5.3 Admin 인벤토리 타입 (in-memory only)

```ts
type ImageStorage = 'temp' | 'dropbox' | 'external';

interface ImageInventoryItem {
  url: string;              // 노트에 박혀 있는 URL (또는 오펀이면 blob URL)
  storage: ImageStorage;    // host 기반 분류
  size?: number;            // Vercel list()에서 옴; Dropbox/외부는 undefined
  uploadedAt?: string;      // Vercel list()에서 옴
  usedIn: Array<{
    guid: string;
    title: string;
  }>;
  isOrphan: boolean;        // storage === 'temp' && usedIn.length === 0
}
```

영속화 없음. admin 페이지 열 때마다 `loadImageInventory()`로 재계산.
캐시는 `adminCache.svelte.ts`에 다른 admin 페이지들과 같은 패턴으로 잠깐만 보관.

### 5.4 `appSettings` 추가 키

```ts
interface AppSettings {
  // ...existing...
  imageStorageToken?: string;
}
```

기본값 없음. 미설정 상태에서 paste 시도 시 토스트로 설정 페이지 안내, paste 취소.

### 5.5 URL host → storage 분류 규칙

| 패턴 | 분류 |
|---|---|
| `*.public.blob.vercel-storage.com` | `temp` |
| `*.dropbox.com`, `*.dropboxusercontent.com` | `dropbox` |
| 그 외 (http(s)://...) | `external` |

`external`은 사용자가 직접 노트에 붙여 넣은 외부 이미지 URL.
admin에서 표시만 하고 액션 버튼은 안 보인다.

## 6. 에러 처리

### 6.1 업로드 (editor paste)

| 실패 | 사용자 경험 |
|---|---|
| `imageStorageToken` 미설정 | 토스트 "설정에서 이미지 서버 토큰을 입력하세요" + 설정 페이지 링크. paste 자체는 취소 (커서 위치만 보존). |
| 토큰 검증 실패 (401) | 토스트 "이미지 서버 토큰이 잘못되었습니다". 이미지 안 박힘. |
| 토큰 발급 성공 + Vercel 직접 PUT 실패 | 토스트 "이미지 업로드 실패 (네트워크)". 이미지 안 박힘. SDK가 throw하는 메시지를 그대로 보여줌. |
| 파일이 이미지가 아님 (`extractImageFile` null) | 기존 동작 유지 (paste 무시). |

paste handler 안에서 try/catch — 부분 상태(텍스트만 들어가고 URL이 안 박힌) 절대 만들지 않음.
실패하면 깔끔히 throw, 사용자가 다시 시도하면 됨.

### 6.2 승격 (admin → Dropbox로 저장)

단계별 실패 처리:

```
1. fetch(tempUrl) → bytes              실패: 토스트, 종료. blob/노트 모두 무변경.
2. uploadImageToDropbox(bytes)         실패: 토스트, 종료. blob/노트 모두 무변경.
3. scanNotesForImages()로 affected 확정
4. for each affected note:
     load → string-replace → putNote   실패 (어느 노트든): 이미 처리한 노트는 새 URL,
                                          처리 못한 노트는 옛 URL. 양쪽 URL 모두 유효한
                                          이미지 (둘 다 살아있음). 토스트 "일부 노트
                                          갱신 실패 — 재시도 가능". Vercel 삭제 건너뜀.
5. noteReloadBus.emitNoteReload(affected)
6. DELETE /api/temp-image?url=tempUrl  실패: 토스트 "Dropbox 저장 완료, 임시 이미지
                                          정리 실패. admin에서 다시 시도".
```

**핵심 안전성**: 4단계가 부분 실패해도 양쪽 URL이 모두 살아있으므로 노트가 깨지지 않음.
사용자가 같은 승격 액션을 다시 누르면 멱등하게 진행됨 (Dropbox에 같은 바이트가 새 path로 한 번 더 업로드되는 비용은 미세 — YAGNI dedup).

### 6.3 삭제 (admin → 삭제 버튼)

```
1. 인벤토리 항목 보고 usedIn.length > 0이면 confirm:
   "이 이미지는 N개 노트에서 사용 중입니다. 삭제하면 노트의 이미지가 깨집니다. 진행할까요?"
2. DELETE /api/temp-image?url=tempUrl
3. 노트 URL은 손대지 않음 — 깨진 채로 둠 (사용자가 의도적으로 결정한 것).
```

### 6.4 인벤토리 로딩

| 실패 | 동작 |
|---|---|
| 노트 스캔만 실패 | 거의 불가능 (IDB 로컬). 그래도 에러면 빈 그리드 + 에러 배너. |
| `/api/temp-image/list` 실패 | 노트 스캔 결과만 보여줌 + 상단 경고 배너 "오펀 임시 이미지를 확인할 수 없습니다". 사용자는 여전히 노트에 박힌 이미지들은 관리 가능. |

### 6.5 서버 측

세 라우트 모두:
- Bearer 없음 / 잘못됨 → 401
- `BLOB_READ_WRITE_TOKEN` 환경변수 미설정 → 500 + 명확한 에러 로그
- Vercel Blob SDK throw → 502 + 에러 메시지 passthrough

## 7. 테스트

### 7.1 단위 테스트 (vitest)

| 테스트 파일 | 대상 |
|---|---|
| `app/tests/unit/sync/tempImageUpload.test.ts` | `uploadTempImage` 토큰 헤더 부착, 발급된 토큰으로 SDK 호출, 에러 메시지 매핑. `@vercel/blob/client` mock. `fetch` mock. |
| `app/tests/unit/sync/imageInventory.test.ts` | `classifyImageUrl` 테이블 드리븐 (vercel/dropbox/external/잘못된 URL). `scanNotesForImages` — fixture xmlContent 여러 개로 URL 추출 + usedIn 집계 검증. `loadImageInventory` — 노트 스캔 ∪ blob list 합집합 + orphan 분류. |
| `app/tests/unit/sync/imagePromotion.test.ts` | happy path. 각 단계별 실패 시나리오 — 1번 실패 무변경, 2번 실패 무변경, 4번 부분 실패는 양쪽 URL 살아있음, 6번 실패는 노트는 갱신됐는데 blob 남음. mock: `fetch`, `uploadImageToDropbox`, `noteStore`, `tempImageUpload.deleteTempImage`, `noteReloadBus`. |

### 7.2 통합 테스트

실제 Vercel Blob을 치는 테스트는 만들지 않음 (CI 토큰 관리 부담).
대신 manual test plan을 plan 단계에서 verify 단계로 포함:

- 설정에서 토큰 입력 → paste 동작 확인
- admin 인벤토리 로딩 (노트 스캔 + Vercel list 합집합 확인)
- "Dropbox로 저장" 클릭 → 노트 reload 후 URL이 dropbox로 바뀌었는지
- 삭제 후 노트 이미지 깨지는지
- 두 번째 디바이스에서 같은 노트 열어 URL이 Dropbox로 sync됐는지 (Firebase 실시간 노트 동기화 켜진 경우)

### 7.3 회귀 점검

- `app/tests/unit/editor/` 안 기존 이미지 paste 테스트가 있으면 mock 대상만 교체 (Dropbox → tempImage).
- `lib/ocrNote/runOcrInEditor.ts` 변경: `downloadImageFromUrl` 새 헬퍼 테스트 추가 (host별 dispatch).

### 7.4 비테스트 검증

- `cd app && npm run check` — svelte-check 통과
- `cd app && npm run build` — adapter-vercel로 빌드 성공 + `.vercel/output/functions/api/temp-image/` 생성 확인

## 8. 명시적 비범위 (out of scope, follow-up 후보)

- **자동 만료 / 시간 기반 정리.** 사용자가 "수동 정리만"으로 결정.
- **In-editor 우클릭 "이거 보관" 메뉴.** admin 단일 진입점으로 충분. 사용 패턴 보고 추가 검토.
- **기존 Dropbox 이미지를 Vercel로 옮기는 마이그레이션.** 의미 없음 (반대 방향이 보관).
- **승격 시 Dropbox dedup.** 같은 이미지를 두 번 승격하면 Dropbox에 두 번 올라감. 비용 미세.
- **다른 백엔드 (Cloudflare R2 등) 지원.** 단일 백엔드로 고정. 추상화 안 함.
- **이미지 크기 제한 / 압축.** Vercel Blob 자체 한도(현재 약 500MB)에 맡김.
- **Public 공유 / 사용자 간 공유.** 단일 사용자 PWA의 기본 모델 유지.
