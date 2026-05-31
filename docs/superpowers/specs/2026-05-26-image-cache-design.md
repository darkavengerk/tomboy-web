# 이미지 캐시 (IDB 영구 캐시 + LRU)

**날짜**: 2026-05-26
**상태**: 설계 승인 대기

## 문제

노트에 이미지를 붙여넣으면 다음 흐름으로 처리된다:

1. 클립보드 → `extractImageFile` → File/Blob
2. `uploadImageToDropbox` → Dropbox shared link URL 반환
3. 노트 본문에 `tomboyUrlLink` 마크 + 텍스트로 URL 삽입
4. `imagePreviewPlugin`이 URL을 스캔해 `<img src=URL>` 위젯 데코레이션 렌더
5. 브라우저가 Dropbox로 GET 요청 → 이미지 다운로드 → 표시

**비효율 지점**: 단계 2에서 우리는 이미 blob을 손에 쥐고 있었는데, 단계 5에서 같은 바이트를 다시 네트워크에서 받아온다. 그리고 같은 노트를 다시 열거나 reload할 때마다 또 받는다.

추가로 OCR 노트(`tomboy-ocr-note`)는 이미지를 다시 받으려고 `downloadImageFromDropboxUrl`(Dropbox SDK 경유, CORS 우회)을 호출하는데, 여기도 같은 캐시 혜택을 못 받는다.

## 목표

- 업로드한 이미지를 즉시 IDB에 저장해서 직후 렌더링에서 다운로드 0번
- 노트를 다시 열거나 reload해도 같은 디바이스라면 캐시 히트
- OCR 재실행도 캐시에서 즉시 가져옴
- 사용자가 캐시 사용량/한도를 보고 비울 수 있는 설정 UI

## 비목표

- 디바이스 간 prefetch (다른 기기에서 처음 여는 노트는 lazy로 채움)
- Service Worker fetch 인터셉트 (JS-level만)
- stale URL 검증 (HEAD 요청 등)
- claude 노트 이미지 패스스루 통합 (애초에 Dropbox URL을 거치지 않음)
- diary 파이프라인 통합 (별도 데스크탑 프로세스, 다른 IDB)

## 접근 (Approach A — JS-level 인터셉트)

새 모듈 `app/src/lib/imageCache/`가 IDB store + LRU + ObjectURL 풀을 캡슐화한다. 호출자 4곳(`imageUpload`, `imagePreviewPlugin`, `downloadImageFromDropboxUrl`, 설정 페이지)이 공개 API 두세 개만 호출한다.

Service Worker 기반 fetch 인터셉트(Approach B)도 검토했으나 기각:

- 이 프로젝트의 이미지 렌더링 진입점이 `imagePreviewPlugin` 단 한 곳이라 JS-level이 충분
- OCR은 `api.dropboxapi.com`을 거쳐서 SW로 못 잡음 → 어차피 별도 코드 필요
- 기존 SW는 푸시/PWA 관심사 — 이미지 캐시까지 얹으면 디버깅 복잡
- IDB로 통합 시 SW에서 IDB 접근 코드를 또 작성해야 함

## 아키텍처

```
app/src/lib/imageCache/
├── imageCacheStore.ts      # IDB store: open(), get(url), put(...), delete(url), evictLRU(...)
├── imageCache.ts           # 공개 API: lookupOrFetch, prime, getBlob, clearAll, getStats, setQuota
└── objectUrlPool.ts        # ObjectURL 라이프사이클: peek(url), getOrCreate(url, blob), revoke(url)
```

**의존성 방향** (단방향):

```
imageUpload.ts ─────────────┐
imagePreviewPlugin.ts ──────┼──> imageCache/ ──> idb (lib/storage/db.ts와 같은 DB)
downloadImageFromDropboxUrl ┤
settings/+page.svelte ──────┘
```

`imageCache`는 호출자를 모른다.

## IDB Schema

기존 `tomboy-web` DB에 새 store 추가:

```ts
interface ImageCacheRecord {
  url: string;           // primary key (Dropbox shared link, ?raw=1 포함 그대로)
  blob: Blob;
  contentType: string;   // 'image/png' 등
  size: number;          // blob.size, LRU 계산 + totalBytes 합산 회피
  lastAccess: number;    // ms timestamp, LRU 기준
  insertedAt: number;    // ms timestamp
}
```

**인덱스**: `by_lastAccess` (LRU evict 시 ascending cursor 스캔).

**보조 메타**: `appSettings`에 키 두 개

```
imageCacheTotalBytes: number   // 모든 record.size 합 (cursor scan 회피용 캐시; store가 권위)
imageCacheQuotaBytes: number   // 사용자 한도, 디폴트 500 * 1024 * 1024
```

`imageCacheTotalBytes`는 hint이고 정합성은 부팅 시 또는 `getStats` 호출 시 1회 cursor scan으로 보정한다.

## 공개 API

```ts
// imageCache.ts

async function lookupOrFetch(url: string): Promise<{
  src: string;        // ObjectURL (히트) 또는 원본 url (미스 후 fetch 실패)
  fromCache: boolean;
}>;

async function prime(url: string, blob: Blob, contentType: string): Promise<void>;

async function getBlob(url: string): Promise<Blob | null>;  // OCR이 ObjectURL→blob 복원 회피용

async function clearAll(): Promise<void>;

async function getStats(): Promise<{
  count: number;
  totalBytes: number;
  quotaBytes: number;
}>;

async function setQuota(bytes: number): Promise<void>;
```

```ts
// objectUrlPool.ts

function peek(url: string): string | null;            // 동기, in-memory만, 플리커 회피용
function getOrCreate(url: string, blob: Blob): string; // 같은 url은 같은 ObjectURL 재사용
function revoke(url: string): void;
```

## 통합 지점

### 3.1 `imageUpload.ts` (prime)

`uploadImageToDropbox` 끝, URL 반환 직전:

```ts
const url = toDirectImageUrl(sharedLinkUrl);
await imageCache.prime(url, file, file.type).catch(() => {
  // 캐시 실패는 업로드 성공을 가리지 않음 (로그만)
});
return url;
```

### 3.2 `imagePreviewPlugin.ts` (lookup)

현재 `renderImagePreview`는 `<img src={href}>`를 즉시 만든다. 변경:

```ts
const sync = objectUrlPool.peek(href);
img.src = sync ?? href;
if (!sync) {
  imageCache.lookupOrFetch(href).then(r => {
    if (r.fromCache && r.src !== img.src) img.src = r.src;
  });
}
```

- 동기 ObjectURL pool 히트 → 즉시 ObjectURL src (플리커 없음)
- 미스 → 원본 URL을 fallback으로 두고 비동기 lookup, 캐시 채워지면 src 교체
- 비동기 fetch 실패 → fallback URL 유지 (사용자는 현재와 동일 경험)

decoration spec key는 그대로 (URL 기반) — PM이 위젯 재생성하지 않음.

### 3.3 OCR `downloadImageFromDropboxUrl` (lookup + prime)

위치: `app/src/lib/ocrNote/runOcrInEditor.ts` 근처 (Explore 결과 line ~235 의 호출 layer).

```ts
const cached = await imageCache.getBlob(url);
if (cached) return cached;

const blob = await downloadImageFromDropboxUrlViaSdk(url);
await imageCache.prime(url, blob, blob.type).catch(() => {});
return blob;
```

`getBlob`을 사용해 ObjectURL→Blob 복원 단계를 피한다.

### 3.4 설정 페이지

`app/src/routes/settings/+page.svelte` 동기화 섹션 근처에 새 블록:

```
이미지 캐시
사용 중: 234.5 MB / 500 MB (412개)
한도: [____ MB ▾]   [캐시 비우기]
```

- 한도 입력: 100MB ~ 5GB. 축소 시 즉시 LRU evict로 새 한도에 맞춤
- "캐시 비우기": 확인 다이얼로그 → `clearAll()` → toast

`/admin/tools` 페이지에도 동일 액션 노출(관리자 도구 일관성).

## LRU 알고리즘

`prime` 또는 lookup-miss 후 put의 흐름. 모두 단일 `readwrite` 트랜잭션 내에서 실행해 race-free:

```
newSize = blob.size
old = store.get(url)
total = readMetaTotalBytes() - (old?.size ?? 0)

while (total + newSize > quota):
  victim = index('by_lastAccess').openCursor() 첫 항목
  if (!victim) break  // 빈 store인데 newSize > quota
  total -= victim.size
  store.delete(victim.url)
  objectUrlPool.revoke(victim.url)

if (total + newSize > quota):
  // 단일 이미지가 quota보다 큼 → 캐시 안 함, 에러 안 던짐
  return

store.put({ url, blob, contentType, size: newSize, lastAccess: now, insertedAt: now })
writeMetaTotalBytes(total + newSize)
```

**lastAccess 업데이트**: `lookupOrFetch` 히트 시 비동기 fire-and-forget으로 `lastAccess = Date.now()` 쓰기. 같은 URL은 60초 디바운스 (모듈-레벨 `Map<url, lastWriteTs>`).

**QuotaExceededError fallback**: `store.put`이 그래도 quota exceed를 던지면 catch해서 추가 evict 후 재시도(최대 3회). 실패 시 캐시 미적용으로 silent fallback.

## 동시성

- 같은 URL을 두 호출이 동시에 `lookupOrFetch`할 경우 `inflight: Map<url, Promise>`로 dedupe. 두 번째 호출은 첫 번째 Promise를 그대로 반환.
- IDB 트랜잭션은 evict + put을 한 묶음으로 (`readwrite`, 같은 store).

## Stale URL / 404 처리

- `lookupOrFetch`의 fetch 단계에서 non-OK 응답 → 캐시에 안 넣고 `{ src: url, fromCache: false }` 반환. `<img>`는 원본 URL을 src로 가지므로 현재와 동일하게 깨진 이미지로 표시.
- 이미 캐시에 있는데 원본이 Dropbox에서 삭제된 경우: 캐시 히트라 사용자는 모름. 다음 evict 때 비로소 깨짐. **의도된 트레이드오프** — 매번 HEAD로 검증하면 캐시 의미가 사라짐.
- 사용자가 "캐시 비우기" 누르면 stale 항목도 함께 제거.

## Migration

기존 노트는 이미 모두 Dropbox URL을 본문에 가진다. 캐시는 빈 상태로 시작 → 처음 렌더링될 때 lazy로 채워짐. 일회성 마이그레이션 작업 없음. **이전 동작과 100% 호환**.

## ObjectURL 라이프사이클

- 같은 페이지(탭) 수명 동안 같은 URL → 같은 ObjectURL을 재사용 (`Map<url, objectUrl>` 모듈-레벨)
- SPA 라우팅으로는 revoke 안 함 (다른 노트가 같은 이미지를 참조할 가능성)
- evict / `clearAll` / 명시적 cache delete 시 해당 url의 ObjectURL revoke
- 페이지 unload 시 브라우저가 자동 회수 (명시적 cleanup 불필요)

## 디폴트 quota

500MB. 비교:
- 스크린샷/사진 평균 300KB ~ 2MB → 250~1500장 캐시
- 브라우저 origin quota는 보통 수 GB → 충돌 위험 낮음

설정에서 100MB ~ 5GB 슬라이더로 조절.

## 테스트

### Unit (`app/tests/unit/imageCache/`)

`imageCacheStore.test.ts`:
- `put`/`get` 라운드트립 — blob 동일성 (size, type, 바이트)
- `delete` 후 `get`은 null
- `evictLRU(targetBytes)` — `lastAccess` 오름차순 회수
- `by_lastAccess` 인덱스 cursor

`imageCache.test.ts`:
- `prime` → `lookupOrFetch`가 `fromCache: true`
- 미스 → fetch mock 호출 → 결과 캐시
- 동시 호출 dedupe (fetch 1회만)
- non-OK 응답 → fallback URL, 캐시 미저장
- quota 초과 시 LRU evict + totalBytes 갱신
- 단일 이미지가 quota 초과 → 캐시 안 함, 에러 없음
- `clearAll` 후 `getStats`는 0/0
- `setQuota` 축소 → 즉시 evict로 새 한도에 맞춤
- `getBlob` — 캐시 히트면 blob, 미스면 null

`objectUrlPool.test.ts`:
- 같은 url 두 번 `getOrCreate` → 같은 ObjectURL
- `revoke` 후 `peek`은 null
- `URL.createObjectURL` / `revokeObjectURL` 호출 횟수

### Integration (`app/tests/unit/editor/imageCachePlugin.test.ts`)

- `imagePreviewPlugin` 위젯이 `lookupOrFetch` mock 호출
- 동기 pool 히트 → `<img src>`가 ObjectURL로 즉시 (플리커 없음)
- 비동기 미스 후 fetch resolve → src 교체
- fetch reject → src는 원본 URL 유지

### 수동 검증

설정 페이지 UI는 자동화 어려움. 수동 체크리스트:
- 큰 이미지 N개 붙여넣어 quota 초과 → LRU 동작
- "캐시 비우기" → 통계 0
- 한도 변경 → 즉시 evict

Dropbox URL 실제 fetch는 모두 mock. 네트워크 테스트는 없음.

## 영향받는 파일

**신규**:
- `app/src/lib/imageCache/imageCacheStore.ts`
- `app/src/lib/imageCache/imageCache.ts`
- `app/src/lib/imageCache/objectUrlPool.ts`
- `app/tests/unit/imageCache/imageCacheStore.test.ts`
- `app/tests/unit/imageCache/imageCache.test.ts`
- `app/tests/unit/imageCache/objectUrlPool.test.ts`
- `app/tests/unit/editor/imageCachePlugin.test.ts`

**수정**:
- `app/src/lib/storage/db.ts` — `imageCache` store + `by_lastAccess` 인덱스 추가
- `app/src/lib/storage/appSettings.ts` — `imageCacheTotalBytes`, `imageCacheQuotaBytes` 키
- `app/src/lib/sync/imageUpload.ts` — `prime` 호출
- `app/src/lib/editor/imagePreview/imagePreviewPlugin.ts` — `lookupOrFetch` 통합
- `app/src/lib/ocrNote/runOcrInEditor.ts` (또는 `downloadImageFromDropboxUrl` 정의 위치) — `getBlob` + `prime` 통합
- `app/src/routes/settings/+page.svelte` — 캐시 UI 블록
- `app/src/routes/admin/tools/+page.svelte` — "이미지 캐시 비우기" 액션

## Open Questions

없음. 모든 결정 사항 확정.
