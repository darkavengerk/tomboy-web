# 데스크탑 시계 + 달력 위젯 설계

날짜: 2026-07-06
대상: 데스크탑 워크스페이스(`/desktop`) SidePanel 좌측 레일

## 목적

데스크탑 좌측 레일 하단의 `고급` 버튼을 실시간 시계로 바꾸고, 그 버튼이 여는
고급 메뉴에 `달력` 항목을 추가한다. 달력은 노트가 아니라 **위젯** — IndexedDB에
저장되지 않고 다른 기기와 동기화되지 않는다. 달력 창은 월별 그리드로 날짜를
보여주고, 각 날짜 셀에 그날 생성된 노트 개수를 배지로 표시한다. 날짜를 클릭하면
그날 생성된 노트들을 역참조 번들과 동일한 방식(별도의 떠다니는 창)으로 묶어서
보여준다.

부수 요구: 노트북(카테고리)이 많아도 스크롤 영역이 시계 버튼(옛 고급 버튼)을
가리지 않도록 두 영역을 분리 하드닝한다.

## 배경 / 기존 구조

- **레일 버튼**: `app/src/lib/desktop/SidePanel.svelte`
  - `.rail-advanced` 버튼(현재 라벨 `고급`), 클릭 시 `.advanced-menu` 토글.
  - 메뉴 항목: 그래프 / 코드 그래프 / 설정 / 관리자 / 펼쳐보기(F4).
  - `.rail-chips`(노트북 목록, `flex:1` 자체 스크롤)와 `.rail-advanced`
    (`margin-top:auto`로 하단 고정)는 같은 flex 컬럼의 별도 레이어.
- **데스크탑 창 시스템**: `app/src/lib/desktop/session.svelte.ts`
  - `DesktopWindowKind = 'note' | 'settings' | 'admin' | 'history'`.
  - `settings`/`admin`은 sentinel guid를 가진 **노트 아닌 위젯 창** 패턴 —
    `geometryByGuid`에 pose 캐시 + `PersistedV4`로 영속(리로드 후 복원).
  - `history`는 영속 제외(`session.svelte.ts:373`에서 필터).
  - `openSettings()`/`openAdmin()`: 존재하면 포커스, 없으면 cached-or-default
    geometry로 창 생성 + 영속.
  - `DesktopWorkspace.svelte`가 `win.kind`로 분기 렌더.
- **역참조 번들**: `app/src/lib/editor/noteBundle/BacklinkBundleOverlay.svelte`
  - `windowed` 모드 = `use:portal`로 body에 `--z-modal` 밴드, 타이틀바 드래그 +
    8방향 리사이즈하는 떠다니는 창. **desktopSession에 등록 안 됨 → 닫으면 소멸.**
  - `buildSyntheticBundleSpec(titles, 'bundle')` + `NoteBundleCabinet`로 렌더.
  - `NoteBundleCabinet`의 `hostGuid`는 자기참조 제외 + 음악/에디터 origin에만
    쓰이고 IDB 로드는 안 함 → `null` 전달 안전.
- **노트 생성 시각**: `app/src/lib/core/note.ts:17` `createDate: string`
  (ISO-8601 Tomboy 포맷, 예 `2024-01-15T10:30:45.0000000+09:00`).
  파서 `parseTomboyDate()`. 전체 목록 = `noteManager.listNotes()`.

## 결정

- 날짜 클릭 표시: **역참조 번들 재사용 + 별도의 떠다니는 창** (사용자 선택).
- 시계 형식: **24시간 `HH:MM`** (사용자 선택).

## 컴포넌트 설계

### 1. 시계 (SidePanel `.rail-advanced`)

- 버튼 라벨 `고급` → 실시간 `HH:MM`(24시간). 클릭 동작·메뉴 그대로.
  접근성 위해 `title`/`aria-label="고급 메뉴"` 유지.
- 시간 소스: `lib/desktop/clock.svelte.ts` — 모듈 rune `$state`로 현재 `HH:MM`
  문자열 노출. 다음 분 경계까지 `setTimeout` 정렬 후 60초 `setInterval`.
  SSR 가드(`typeof window`). 단일 모듈 타이머(여러 구독자 공유).
- SidePanel은 이 스토어를 읽어 라벨 렌더. 언마운트 시 타이머는 모듈 수명 →
  레일 상시 존재이므로 유지(또는 마지막 구독 해제 시 정리; v1은 모듈 상시).

### 2. 고급 메뉴 항목

- `.advanced-menu`에 `달력` 항목 추가. onclick → `desktopSession.openCalendarWidget()`
  후 메뉴 닫기. SidePanel이 이미 desktopSession을 참조하면 직접 호출, 아니면
  `oncalendar` 콜백 prop을 DesktopWorkspace에서 배선.

### 3. session.svelte.ts 확장

- `CALENDAR_WIDGET_GUID = '__calendar__'` sentinel export.
- `DesktopWindowKind`에 `'calendar'` 추가.
- `defaultGeometry('calendar')` → 적당한 기본 크기(예 360×440) centered.
- `openCalendarWidget()`: `openSettings()`와 동일 패턴(존재 시 포커스, 없으면
  cached-or-default geometry로 `kind:'calendar'` 창 push + `cacheGeometry` +
  `schedulePersist`).
- **영속**: settings/admin과 동일 — `history` 필터에 추가하지 않음 → 창 자체가
  리로드 후 복원되고 pose도 기억됨. (요구: 크기·위치 기억 충족.)

### 4. CalendarWindow.svelte

- 창 크롬: `SettingsWindow.svelte` API 미러 — props `x,y,width,height,z,pinned,
  active,onfocus,onclose,onmove,onresize` + 타이틀바 드래그 + `ResizeHandles`.
- 본문:
  - 헤더: `◀`/`▶` 연·월 네비, `YYYY년 M월` 라벨, 오늘로 점프(선택).
  - 요일 헤더(일~토) + 6주 × 7일 그리드.
  - 각 셀: 날짜 숫자 + 개수 배지(그날 생성 노트 수, 0이면 배지 숨김).
    오늘 날짜 강조. 이전/다음 달 넘침 셀은 흐리게.
  - 개수 > 0 셀 클릭 → `selectedDate = 'YYYY-MM-DD'`.
- 데이터: 마운트 + 월 변경 + 포커스 복귀 시 `listNotes()` →
  `groupNotesByCreateDay()`로 `Map<'YYYY-MM-DD', NoteSummary[]>` 1회 계산.
  배지/리스트 모두 이 맵에서 읽음.
- `selectedDate`가 있으면 `<DayNotesBundleOverlay>` 렌더(달력 창이 소유하는
  단일 오버레이). 오버레이 닫기 → `selectedDate = null`.

### 5. DayNotesBundleOverlay.svelte (역참조 번들 재사용)

- `BacklinkBundleOverlay`의 `windowed` 오버레이를 본떠 새로 작성(기존 파일 수정
  아님 — 동작 중인 역참조 기능 보호). 재사용하는 실제 심은
  `buildSyntheticBundleSpec` + `NoteBundleCabinet`.
- Props: `date: 'YYYY-MM-DD'`, `notes: NoteSummary[]`(달력이 이미 계산한 그날
  노트), `onclose`, `onopennote: (guid) => void`.
- 렌더: `use:portal` → body, `--z-modal` 밴드, 드래그 + `ResizeHandles`. 헤더
  태그 `YYYY-MM-DD`, 개수 `N개`.
- `titles = notes.map(n => n.title.trim()).filter(Boolean)` →
  `buildSyntheticBundleSpec(titles, 'bundle')` → `<NoteBundleCabinet
  spec view={null} hostGuid={null} variant="dedicated"
  EditorComponent={TomboyEditor} oninternallink={eject} />`.
- `eject(title)`: `onclose()` 후 제목→guid(`findNoteByTitle`) →
  `onopennote(guid)`. CalendarWindow가 `onopennote`를
  `desktopSession.openWindow` 로 배선(캔버스에 노트 창 오픈).
- 영속 없음(닫으면 소멸) — 요구 그대로.

### 6. groupNotesByCreateDay.ts (순수 함수)

- `lib/desktop/calendar/groupNotesByCreateDay.ts`.
- 입력: `{ guid, title, createDate }[]`(NoteSummary 부분집합).
- 각 노트의 `createDate`를 `parseTomboyDate` → 로컬 타임존 기준
  `YYYY-MM-DD` 버킷. `Map<string, NoteSummary[]>` 반환(값은 createDate 오름/
  내림 정렬).
- 순수·부작용 없음 → vitest 단위 테스트 대상.

### 7. 카테고리 ↔ 시계 겹침 분리

- 현재 `.rail-chips`/`.rail-advanced` CSS 실측 후:
  - `.rail-chips { flex:1; min-height:0; overflow-y:auto }` 보장(`min-height:0`
    없으면 flex 아이템이 콘텐츠로 부풀어 하단 버튼을 밀어냄).
  - `.rail-advanced { flex-shrink:0; margin-top:auto }` 보장.
- 노트북이 많아도 목록만 스크롤하고 시계 버튼은 항상 하단 고정.

### 8. 가이드 카드

- `app/src/routes/settings/+page.svelte` 가이드 탭(env 또는 notes 서브탭)에
  `<details class="guide-card">` 추가: 데스크탑 레일 시계 → 고급 메뉴 → 달력,
  일별 생성 노트 개수, 날짜 클릭 시 그날 노트 묶음, **노트로 저장/동기화 안 됨**.
  기존 카드 패턴(summary + info-text + guide-list) 답습.

## 데이터 흐름

```
레일 시계 클릭 → 고급 메뉴 → 달력
  → desktopSession.openCalendarWidget()  (kind:'calendar', pose 영속)
CalendarWindow 마운트
  → listNotes() → groupNotesByCreateDay() → Map<YYYY-MM-DD, notes[]>
  → 그리드 렌더(셀 배지 = map.get(day)?.length)
날짜 셀 클릭(개수>0) → selectedDate=day
  → <DayNotesBundleOverlay notes={map.get(day)} />
     → buildSyntheticBundleSpec + NoteBundleCabinet (역참조와 동일)
행 꺼내기 → findNoteByTitle → desktopSession.openWindow(guid)
```

## 에러 / 엣지

- `parseTomboyDate` 실패/누락 createDate → 해당 노트는 버킷에서 제외(크래시 금지).
- 월 그리드는 항상 6주(42셀) — 넘침 셀은 이전/다음 달, 흐리게, 클릭 시 해당 달로
  이동 후 그 날짜 처리(또는 클릭 무시 — v1은 이동).
- 제목 전역 유일 가정 → 제목→guid 1:1. `findNoteByTitle` miss면 무시.
- 개수 0인 날 클릭 무시(오버레이 안 뜸).
- SSR: 시계·`window.inner*` 접근 가드.

## 테스트

- `groupNotesByCreateDay` 단위 테스트: 타임존 경계, 다중 노트 같은 날, 잘못된
  날짜 제외, 빈 입력. (vitest)
- `CalendarWindow` 마운트 스모크(@testing-library/svelte): 현재 달 렌더, 월
  네비로 라벨 변경, 개수 배지 표시. `afterEach`에서 destroy(에디터 누수 방지).
- `DayNotesBundleOverlay` 스모크: notes 주입 시 개수 헤더 + 항목 렌더.
- 수동: `npm run dev` → 데스크탑에서 레일 시계 확인, 달력 열기/리사이즈/리로드 후
  pose 유지, 날짜 클릭 → 번들 창, 노트 열기.

## 파일

신규:
- `app/src/lib/desktop/CalendarWindow.svelte`
- `app/src/lib/desktop/DayNotesBundleOverlay.svelte`
- `app/src/lib/desktop/calendar/groupNotesByCreateDay.ts`
- `app/src/lib/desktop/clock.svelte.ts`
- `app/tests/unit/desktop/groupNotesByCreateDay.test.ts` (+ 컴포넌트 스모크)

수정:
- `app/src/lib/desktop/session.svelte.ts` (kind, sentinel, defaultGeometry, openCalendarWidget)
- `app/src/lib/desktop/DesktopWorkspace.svelte` (calendar 분기 렌더)
- `app/src/lib/desktop/SidePanel.svelte` (시계 라벨, 달력 메뉴 항목, chips/advanced CSS 하드닝)
- `app/src/routes/settings/+page.svelte` (가이드 카드)

## 비목표 (YAGNI)

- 달력에 노트 생성/편집 없음(읽기 전용 위젯).
- changeDate 기준 뷰 없음(생성일 전용).
- 여러 날짜 오버레이 동시 표시 없음(한 번에 하나).
- 모바일 지원 없음(데스크탑 레일 전용).
- 공휴일/일정 표시 없음.
