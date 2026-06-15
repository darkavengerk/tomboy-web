# 노트 리비전 히스토리 (desktop-only)

Date: 2026-06-15
Status: approved-for-planning

## Goal

특정 노트의 Dropbox 리비전 히스토리를 데스크탑에서 열람한다. 노트 메뉴의
`🕘 히스토리` 버튼 → 원본 노트 **옆에 같은 크기**로 임시 창이 뜨고, 상단
드롭다운으로 과거 버전을 고른다. 기본 선택은 **현재 버전 바로 직전**. 본문은
**선택할 때만** 다운로드한다(전체 버전을 미리 받지 않음). 버튼으로 현재 라이브
노트와의 **diff** 도 볼 수 있다.

데스크탑 전용. 모바일 단일 노트 플로우(`/note/[id]`)는 건드리지 않는다.

## Non-goals

- **복원 없음.** 보기 + diff 만. (admin 의 "이 버전을 로컬에 복원"은 그대로 두고
  여기서는 제공하지 않는다.)
- 모바일 지원 없음.
- 본문 일괄 프리페치 없음.

## Storage model (기존)

- 노트 버전 = 그 노트가 커밋된 서버 rev. 파일 경로
  `/{rev/100}/{rev}/{guid}.note` (rev = 노트 자신의 rev, `noteRevisionPath`).
- 루트 `manifest.xml` = 최신 서버 rev 의 guid→rev 스냅샷.
- 따라서 한 노트의 전체 히스토리 = 이름이 `{guid}.note` 인 파일들의 집합.

## 핵심 결정 — 히스토리 열거는 manifest 스캔이 아니라 Dropbox 파일 검색

각 버전은 **서로 다른 경로의 별개 파일**이므로, 파일명 검색 한 번으로 전부
나온다. 매 리비전 manifest 를 받는 O(서버 rev) 스캔을 피한다.

```
dbx.filesSearchV2({
  query: guid,
  options: { path: notesRoot, filename_only: true, max_results: 1000 }
})
→ matches[].metadata['.tag'] === 'file'
  metadata.path_lower / path_display = "/{N/100}/{N}/{guid}.note"  → rev = path 에서 파싱
  metadata.server_modified                                          → 날짜(무료)
has_more → filesSearchContinueV2(cursor) 로 페이지네이션
```

이점:
- 호출 1번(+버전 수백 개일 때만 continue 커서). manifest N개 다운로드 불필요.
- **날짜가 검색 메타데이터(`server_modified`)에서 공짜로 옴** → 드롭다운이 바로
  날짜 라벨을 보여줌(지연-날짜 타협 불필요).
- 본문은 여전히 lazy — 검색은 경로/메타만 주고 `.note` 내용은 안 줌.

### Safeguards

1. **정확 일치 후필터.** guid 에 하이픈이 있어 Dropbox 가 토큰화하므로 검색이
   느슨할 수 있다. 결과 중 `basename(path) === ${guid}.note` 인 것만 채택.
2. **인덱스 지연 보정.** 검색 인덱스는 eventually-consistent → 최신 rev 가 누락될
   수 있다. 어차피 "현재 버전"을 알기 위해 루트 `downloadServerManifest()` 를
   호출하므로, 그 guid 의 현재 rev 가 검색 결과에 없으면 주입한다.
3. **폴백.** 검색이 0건(인덱스 미스/미지원)이면, 기존 admin 식 **bounded lazy
   manifest 스캔**으로 폴백한다(`downloadRevisionManifest` 내림차순, distinct
   noteRev 수집, "더 불러오기"로 확장). 정확성은 어느 경로든 보장.

## Components

### 1. `lib/desktop/noteHistory.svelte.ts` (신규) — 데이터 모듈

윈도우별 `$state` 팩토리 `createNoteHistory(guid)`. **전역 adminCache 와 별개**
(admin 대시보드 상태를 끌어오지 않음).

State:
- `versions: HistoryVersion[]` — `{ rev: number; date: string }` rev 내림차순.
  `versions[0]` = 현재 Dropbox 버전, `versions[1]` = 직전.
- `loading: boolean`, `error: string`, `usedFallback: boolean`,
  `hasMore: boolean`(폴백 스캔용).
- `bodies: Map<rev, NoteData | null>` — fetch 캐시.

API:
- `async load()` — 루트 manifest 로 현재 rev 확인 → `filesSearchV2` 열거 →
  후필터/주입/정렬. 0건이면 `loadFallback()`.
- `async loadFallback()` / `async loadMore()` — manifest 내림차순 스캔(admin
  per-note 페이지 로직 재사용 가능).
- `async fetchBody(rev): Promise<NoteData | null>` — `fetchNoteAtRevision(guid,
  rev)` (adminClient) 캐시. 드롭다운 선택 시에만 호출.

재사용: `downloadServerManifest`, `downloadRevisionManifest`,
`fetchNoteAtRevision`, `getClient` (search 호출), `noteRevisionPath` 파싱 로직.

### 2. `lib/desktop/HistoryWindow.svelte` (신규) — 창 UI

Props: 다른 창과 동일한 `x,y,width,height,z,pinned,active,onfocus,onclose,
onmove,onresize`. `sourceGuid` 는 창 guid 에서 파생: `guid.slice('__history__'.length)`.

레이아웃(기존 NoteWindow 의 타이틀바/리사이즈/드래그 골격 재사용):
- **타이틀바**: 제목 "히스토리 — {원본 제목}", 핀/닫기.
- **툴바**: 버전 `<select>` (라벨 = `rev N · {날짜}`; 본문 fetch 후 노트
  `changeDate` 로 보강 가능, 기본은 `server_modified`) + `↔ diff` 토글 버튼 +
  로딩/에러/폴백 안내. 폴백 모드에서만 "더 불러오기".
- **본문**:
  - 일반: 읽기 전용 `TomboyEditor` (`readOnly`, `content =
    getNoteEditorContent(fetchedNote)`). 선택 버전 본문은 `fetchBody(rev)`.
  - diff 모드: `lineDiff(currentText, selectedText)` (`diffNote.ts`) 결과를
    added/removed/equal 라인으로 색칠 렌더. `*Text` = 각 NoteData 를
    `getNoteEditorContent` → `tiptapToPlainText`(copyFormatted) 로 변환한 평문.
    `current` = **라이브 노트** = `noteStore.getNote(sourceGuid)`.

마운트 시 `history.load()` → 완료되면 기본 선택 = `versions[1] ?? versions[0]`
→ `fetchBody` → 렌더. diff 토글은 현재 노트 평문을 한 번 캐시.

### 3. `lib/desktop/session.svelte.ts` — 창 종류 추가

- `DesktopWindowKind` 에 `'history'` 추가.
- `HISTORY_GUID_PREFIX = '__history__'`. 히스토리 창 guid =
  `${HISTORY_GUID_PREFIX}${sourceGuid}` (노트당 싱글턴; 재오픈 시 focus).
- `openHistory(sourceGuid: string)`:
  - 원본 창 geometry 조회 → 없으면 토스트/return.
  - 배치 = `openRightOf` 클램프 로직 재사용: `x = clamp(source.x +
    source.width, 0, viewportW - width)`, `y = source.y`, **width/height =
    원본 창과 동일**.
  - 이미 열린 히스토리 창이면 bumpZ + focus.
- **영속성 제외**: 히스토리 창은 ephemeral. 직렬화(`schedulePersist` 직렬화
  지점)에서 `kind === 'history'` 를 필터 → 새로고침 후 빈 창으로 부활하지 않음.
  (현재 rev 가 닫힘 시 사라지는 게 의도.)

### 4. `lib/desktop/DesktopWorkspace.svelte` — 렌더 분기

`{:else if win.kind === 'history'}` → `<HistoryWindow .../>` (settings/admin
분기와 동일한 prop 전달; `onopenlink` 등 노트 전용 prop 은 불필요).

### 5. `lib/editor/NoteContextMenu.svelte` — 메뉴 항목

- `ActionKind` 에 `'history'` 추가.
- "원본 XML 보기"/"원본과 비교하기" 근처에 `🕘 히스토리` 버튼 추가
  (`onaction('history')`).

### 6. `lib/desktop/NoteWindow.svelte` — 액션 배선

`handleAction` 에 `if (kind === 'history') { desktopSession.openHistory(guid);
return; }`.

### 7. `lib/editor/TomboyEditor.svelte` — 읽기 전용 prop

- `readOnly?: boolean` (기본 false → **기존 호출부 동작 불변**).
- Editor 생성 시 `editable: !readOnly`; prop 변화 시 `editor.setEditable`.
- `readOnly` 면 autolink 스캔 스케줄링 skip(마크는 저장된 대로 렌더되므로 표시엔
  영향 없음; 성능/부작용만 제거).
- 저장 배선은 호스트 측(NoteWindow saveTimer/pendingDoc)이라 변경 불필요 —
  HistoryWindow 는 `onchange` 를 저장으로 연결하지 않으므로 자동으로 비저장.

### 8. 설정 → 가이드 카드 (문서화 불변식)

`app/src/routes/settings/+page.svelte` 적절한 sub-tab(`notes` 권장: 노트 포맷류)
에 `<details class="guide-card">` 추가: 데스크탑에서 노트 `⋯` → 히스토리,
드롭다운으로 과거 버전 열람, diff 버튼, Dropbox 동기화 필요, 복원은 admin 에서
한다는 안내.

## Data flow 요약

```
NoteContextMenu(히스토리) → NoteWindow.handleAction('history')
  → desktopSession.openHistory(guid)            // kind:'history' 창, 옆에 동일 크기
  → DesktopWorkspace → HistoryWindow(sourceGuid)
      mount → createNoteHistory(guid).load()
              filesSearchV2(guid, filename_only) → versions[](rev+date)
                fallback: manifest 내림차순 스캔
      기본 선택 versions[1] → fetchBody(rev) → 읽기전용 TomboyEditor 렌더
      ↔ diff 토글 → lineDiff(현재 라이브 노트 평문, 선택 버전 평문)
```

## 불변식 / 주의

- **본문은 선택 시에만 다운로드.** 검색/스캔은 경로+메타만.
- **현재 = 라이브 노트.** diff 기준은 `noteStore.getNote(sourceGuid)` (저장 안 된
  로컬 편집도 diff 에 반영). versions[0] 의 Dropbox 현재본과 다를 수 있음 —
  의도된 동작.
- **히스토리 창은 영속화하지 않음**(reload 시 사라짐).
- **TomboyEditor `readOnly` 기본 false** → 기존 사용처 무변화.
- **데스크탑 전용** — TopNav/모바일 라우트 무관.
- guid 후필터로 검색 토큰화 오탐 제거.

## Files

신규:
- `app/src/lib/desktop/noteHistory.svelte.ts`
- `app/src/lib/desktop/HistoryWindow.svelte`

수정:
- `app/src/lib/desktop/session.svelte.ts` (kind, openHistory, persist 필터)
- `app/src/lib/desktop/DesktopWorkspace.svelte` (렌더 분기)
- `app/src/lib/editor/NoteContextMenu.svelte` (ActionKind + 항목)
- `app/src/lib/desktop/NoteWindow.svelte` (handleAction)
- `app/src/lib/editor/TomboyEditor.svelte` (readOnly prop)
- `app/src/lib/sync/dropboxClient.ts` (filesSearchV2 래퍼: `searchNoteRevisions(guid)`)
- `app/src/routes/settings/+page.svelte` (가이드 카드)

재사용(무변경): `fetchNoteAtRevision`(adminClient), `downloadServerManifest` /
`downloadRevisionManifest` / `downloadNoteAtRevision`(dropboxClient),
`getNoteEditorContent`(core), `tiptapToPlainText`(copyFormatted),
`lineDiff`(diffNote), `openRightOf` 클램프 로직(session).

## Testing

- `noteHistory` 단위: 검색 결과 → versions 파싱/정렬/후필터/현재rev 주입;
  검색 0건 → 폴백 스캔; rev 경로 파서. (`fake-indexeddb` + Dropbox 클라이언트 목)
- `dropboxClient.searchNoteRevisions` 단위: continue-cursor 페이지네이션,
  basename 후필터.
- `session.openHistory` 단위: 옆 배치 좌표/동일 크기, 싱글턴 focus,
  persist 직렬화에서 history 창 제외.
- `TomboyEditor` readOnly: editable=false, autolink 스캔 미스케줄, 기존 동작 회귀
  없음(기본 false).
- e2e/수동: `npm run dev` 데스크탑에서 메뉴→히스토리→드롭다운→diff.

## Open SDK note

`dropbox` 패키지의 `filesSearchV2`/`filesSearchContinueV2` 정확한 인자/응답 형태는
구현 시 타입으로 확정(`SearchV2Result`, `SearchMatchV2`,
`metadata.metadata['.tag']==='file'`의 중첩 구조 주의). 폴백이 있으므로 검색이
기대와 다르면 폴백 경로로 안전.
