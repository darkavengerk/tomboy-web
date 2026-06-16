# 노트 배경 메뉴 + 가독성 그림자

날짜: 2026-06-16 · 브랜치: po

## 문제

데스크탑 노트는 배경 이미지를 가질 수 있으나:

1. 배경이 깔리면 본문 글자(어두운 `#111`)가 잘 안 보임 — 가독성 보완 없음.
2. 배경 지정 진입점이 `ImageActionMenu.doSetNoteBg()` 하나뿐 → **노트 안에 이미 이미지가 있어야** 함 (`href` 필요). 이미지 없는 노트엔 배경 못 깖.

## 목표

1. 배경이 지정된 노트는 본문 텍스트에 흰색 외곽선 그림자를 **자동** 적용해 가독성 확보.
2. 우클릭 메뉴에서 직접 배경 지정 — URL 입력 **또는** 현재 캐시 이미지 그리드에서 선택.

## 설계

### 1. 진입점 — NoteContextMenu

- 새 `ActionKind: 'setBackground'`.
- 메뉴 버튼 **"노트 배경 지정"** 추가 — 항상 표시(이미지 유무 무관). 기존 "노트 배경 해제"는 `hasBackground` 게이트 유지.
- 클릭 시 메뉴 닫고 NoteWindow가 picker 연다.

### 2. NoteBackgroundPicker.svelte (신규)

`ImageActionMenu` 패턴 모델: fixed positioning + backdrop + `--z-menu` 토큰(루트 경쟁 → 토큰화).

내용:
- **URL 입력칸** + `[적용]`.
- **캐시 그리드**: 캐시 이미지 썸네일. `lastAccess` 내림차순 정렬, 최대 60개 cap. 초과 시 "총 N개 중 60개 표시" 노출(무음 truncate 금지). 클릭 = 선택.
- **모드 선택** 5버튼(cover/contain/fill/center/tile). 기본 **cover**(배경 용도엔 cover가 자연스러움; 기존 이미지-메뉴 기본 `contain`과 의도적으로 다름).
- 적용:
  - URL 경로: `resolveImageBlob(url)` → `setNoteBg(guid, blob, mode)`.
  - 캐시 경로: `getBlob(url)` → `setNoteBg(guid, blob, mode)`.
  - 성공/실패 한국어 토스트. 둘 다 기존 `setNoteBg`(noteChromeEpoch bump 포함) 재사용.
- 닫을 때 썸네일용 ObjectURL 전부 revoke.

### 3. imageCache 열거 API (신규)

- `imageCacheStore.ts`: `getAllImageRecords(): Promise<ImageCacheRecord[]>` — 커서 기반 열거(evictLRU 커서 패턴 재사용).
- `imageCache.ts`: `listCached(): Promise<ImageCacheRecord[]>` 공개. 레코드 = `{ url, size, lastAccess, contentType }`.

### 4. 가독성 그림자 (자동)

- `.note-window`에 `data-has-bg={!!noteBgUrl}` 부여.
- CSS: `data-has-bg='true'`일 때 `.tomboy-editor .tiptap`에 흰색 다겹 외곽선 그림자(예: `text-shadow: 0 0 2px #fff, 0 0 4px #fff, 0 0 3px #fff`). `.tiptap` 한 곳에 걸면 inherit로 자식 전파.
- 타이틀바(별도 dark 요소)·배경 미설정 시엔 미적용. 배경 해제 시 자동 제거.

### 5. 가이드 + 테스트

- 설정 → 가이드(editor 탭)에 `<details class="guide-card">` 추가(CLAUDE.md 필수 불변식).
- 테스트: `imageCache.listCached`/`getAllImageRecords` 단위(커서 열거+정렬), 기존 setNoteBg/noteChrome 테스트 재사용. picker 적용 헬퍼는 가능하면 단위 테스트로, UI는 `npm run dev` 수동 검증.

## 범위 밖 (YAGNI)

- 그림자 색/세기 커스터마이즈, 그림자 on/off 토글(자동만).
- 모바일 라우트(NoteContextMenu는 데스크탑 NoteWindow 전용).
- 캐시 검색/페이징.

## 불변식

- 배경/그림자 데이터는 로컬 전용(`note:bg:*`) — Dropbox/Firestore 동기화 안 함(현 동작 유지).
- 캐시 cap은 무음 금지 — 잘리면 개수 표시.
- 신규 ObjectURL은 picker 닫힘/언마운트 시 revoke.
