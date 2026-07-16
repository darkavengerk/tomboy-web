# 데스크탑 달력 — 날짜 노트 열기 + 이전 년도 히스토리 기록

날짜: 2026-07-16
상태: 설계 (구현 전, 사용자 리뷰 대기)
범위: 데스크탑(`/desktop`) 전용 — 모바일(`/note/[id]`, `/calendar`)은 후속.

## 배경

데스크탑 달력(`CalendarWindow` → `CalendarView`)에서 날짜 셀을 클릭하면 지금은
**그날 생성된(createDate) 노트 목록**을 오른쪽 도킹 오버레이(`DayNotesBundleOverlay`)로
연다. 다이어리 모드가 켜지면 각 셀에 그달의 일정(사용자 지정 일정 노트) + 히스토리
(`히스토리 기록` 노트 = Ctrl-보내기 대상, `SEND_TARGET_GUID`) 항목을 표시한다.
단, **현재 년도만** — 이전 년도 같은 날짜 기록은 어디에도 안 보인다.

사용자는 달력을 "그날의 날짜 노트(제목 `YYYY-MM-DD`)로 들어가는 입구 + 여러 해에 걸친
같은 날짜 기록을 한눈에" 보는 도구로 바꾸고 싶어 한다.

### 히스토리 기록 노트 데이터 모델 (실측)

- **허브 노트** `히스토리 기록` (= `SEND_TARGET_GUID`): 첫 줄 제목, 이어서 `YYYY - 히스토리 기록`
  내부 링크 블록(2019 … 2025), 그다음 **현재 년도(2026)** 항목이 `월` 헤더 + `<list>` 형태로.
  - 링크 형식: `<link:internal>2025 - 히스토리 기록</link:internal>` (한 줄에 하나).
  - 현재 년도 항목 예: `1월` 아래 `3(토) 트리하우스`, `14(수) 예라 생일`.
- **년도 노트** `YYYY - 히스토리 기록`: 첫 줄 제목, `YYYY`(연도) 줄, `월` 헤더들(내림차순도
  가능) + 각 `<list>`. 항목 예: `9일(월) 물주기`, `12일(목) 대학 동창회` — 현재 년도와
  달리 **일자에 `일`이 붙는다**. 마커/변형: `9*(토)`, `25(월*)`, `5(화**)`, `(수, 한글날)`,
  `10일(수) - 15일(월)`(범위), 중첩 리스트, `<strikethrough>`, 항목 안 내부 링크.

### 재사용 가능한 기존 인프라

- `parseSchedule.ts` — `extractMonthListItems(doc, month)`(월 섹션 아래 리스트 항목 수집,
  월 순서 무관), `parseKoreanTime`, `linearizeDoc`. **단** `parseScheduleNote(doc, now)`는
  `now`의 달 + 다음 달만, 연도는 `now`에서 추론 → **다년도 히스토리엔 부적합**. 그리고
  `DAY_PREFIX_RE = /^\s*(\d{1,2})(?:\s*\([^)]*\))?\s*(.*)$/`는 현재 년도 `3(토)`는 되지만
  이전 년도 `9일(월)`의 `일`을 못 먹어 라벨이 깨진다. → **새 파서 필요**(알림 크리티컬한
  기존 파서는 건드리지 않는다).
- `backlinkIndex.ts:extractLinkTargets(xml): Set<string>` — 원문 XML에서 내부 링크 대상
  제목 전부 추출(정규식). 년도 링크 골라내기에 사용.
- `diaryEntries.ts` — 이미 일정/히스토리 노트를 파싱해 일별 버킷을 만든다(현재 년도).
- `session.svelte.ts` — `openWindow(guid)`, `openByTitle(title)`(없으면 토스트),
  `findNoteByTitle`, `openHistory(sourceGuid)`(영속 안 하는 임시 읽기전용 창 패턴).
- `DayNotesBundleOverlay` — 제목 배열 → `buildSyntheticBundleSpec(titles,'bundle')` →
  `NoteBundleCabinet`. 달력 오른쪽 도킹 portal 오버레이.

## 확정해야 할 결정 (사용자 리뷰에서 확인 — 아래는 현재 채택 기본값)

1. **범위** = 데스크탑 전용. (모바일은 로더/파서를 재사용해 후속 작업으로.)
2. **목록(req 4) 트리거** = **개수 배지**. 셀 본문 클릭=날짜 노트, 배지 클릭=목록 오버레이.
3. **이전 년도 흐린 기록(req 2 푸터 / req 3 달력) 출처** = **히스토리 링크 체인만**.
   이전 년도 날짜 제목 노트(`2025-07-16` 등)는 req 4 목록에만 포함.
4. **날짜 노트 푸터(req 2) 렌더** = **에디터 아래 별도 읽기전용 패널**(`.note` XML 불변,
   캐럿/영속 위험 없음). req 5 임시 노트는 이 패널이 본문 전체.

> 4개 중 하나라도 뒤집히면 해당 섹션만 재설계.

## 요구사항 → 구현 매핑

### Req 1. 셀 클릭 → 그날의 날짜 노트 열기
- `CalendarView.clickCell`: **개수와 무관하게** 모든 in-month 셀이 `onopendate(cell.key)`
  호출(현재는 `count>0`일 때만 `ondayselect`). `cell.key`는 `localDayKey` = `YYYY-MM-DD` =
  날짜 노트 제목(`formatDateTitle`)과 동일 포맷.
- `CalendarWindow.onopendate(title)`: `findNoteByTitle(title)` →
  - 있으면 `desktopSession.openWindow(note.guid)` (실제 노트 창; req 2 푸터 자동 표시).
  - 없으면 임시 오버레이(req 5).
- HTML 유효성: 현재 셀은 `<button>`. 배지를 별도 버튼으로 만들려면 버튼 중첩 불가 →
  **셀을 `<div role="button" tabindex="0">`으로**, 배지를 실제 `<button class="cell-count">`로
  바꾼다(배지 onclick은 `stopPropagation`).

### Req 2. 날짜 노트 하단에 이전 년도 같은 날짜 기록(우측정렬·흐리게)
- 새 컴포넌트 `DateNoteFooter.svelte`(제목 `title` 받음): `title`이 `^\d{4}-\d{2}-\d{2}$`이면
  `{year,month,day}` 파싱 → `loadHistoryChain()` → `recordsForDate(chain, year, month, day)`
  (연도 `< year`만, 연도 내림차순) → `<PrevYearRecords>` 렌더.
- `NoteWindow.svelte`: `.body` 안, `<TomboyEditor>` 블록 뒤(약 1478행)에서
  `isDateNote`일 때만 `<DateNoteFooter title={note.title}/>` 마운트. `flex-shrink:0`,
  스크롤 툴바 슬롯 위. 에디터 도큐먼트/`pendingDoc`엔 절대 손 안 댐.

### Req 3. 달력 셀에도 같은 이전 년도 기록 표시
- `CalendarView`: `loadHistoryChain()`을 mount + 캐시 무효화 시 1회 로드(년도 노트 ~8개
  read/parse — 저렴). `byMonthDay: Map<"MM-DD", HistoryEntry[]>` 보관.
- 각 셀 마크업에서 현재 다이어리 항목(`cell-entries`) 아래에 `year < viewYear`인 같은
  `(month,day)` 기록을 **흐리게·우측정렬**로 소수(예: 상위 2줄 + `+N`) 표시. 전용 클래스
  `cell-prev`(작은 폰트, `opacity`, `text-align:right`, `color` 흐림).

### Req 4. "그날 목록" = 별도 버튼 + 이전 년도 같은 날짜 노트 포함
- 트리거: 개수 배지(위 req 1). `ondayselect(dateKey, notesCreatedThatDay)` 유지.
- `CalendarWindow`: 목록 열 때 `chain`의 년도 집합으로 `YYYY-MM-DD` 후보 제목을
  만들어 존재하는 것만(`findNoteByTitle`) 모아 `prevYearTitles`로 오버레이에 전달.
- `DayNotesBundleOverlay`: `prevYearTitles?: string[]` prop 추가 → `titles`에 병합
  (그날 생성 노트 제목 + 이전 년도 날짜 노트 제목, 중복 제거) → 기존 번들 렌더 그대로.
  헤더 개수/빈-메시지도 병합 기준.

### Req 5. 날짜 노트 없을 때 임시 노트로 이전 년도 기록 표시(없으면 공백)
- 새 컴포넌트 `EphemeralDateOverlay.svelte`(portal, 달력 오른쪽 도킹 —
  `DayNotesBundleOverlay` 도킹 로직 재사용): 헤더=`YYYY-MM-DD`, 본문=`<PrevYearRecords>`
  (기록 없으면 "이 날짜의 이전 년도 기록이 없습니다." / 사실상 공백), 하단
  "이 날짜 노트 만들기" 버튼 → `createNote({title})`(날짜 제목이라 `년`+일정 시드됨) →
  `openWindow` → 오버레이 닫기.
- `CalendarWindow.onopendate`의 "없음" 분기가 이 오버레이를 연다.

## 새 모듈: `historyChain.ts`

`app/src/lib/desktop/calendar/historyChain.ts`

```ts
export interface HistoryEntry { year: number; month: number; day: number; label: string; }
export interface HistoryChain {
  entries: HistoryEntry[];
  byMonthDay: Map<string, HistoryEntry[]>; // key = `${MM}-${DD}`
}

// 이전 년도 형식(`9일(월)`) + 마커(`9*(토)`, `(월*)`, `(수, 한글날)`)까지 흡수.
// 기존 DAY_PREFIX_RE는 건드리지 않는다(알림 파이프라인 보호).
const HISTORY_DAY_RE = /^\s*(\d{1,2})일?\*{0,2}\s*(?:\([^)]*\))?\s*(.*)$/;

export function parseHistoryDayLine(text: string, year: number, month: number): { day: number; label: string } | null;
export function parseHistoryYearNote(doc: JSONContent, year: number): HistoryEntry[]; // 1..12월 전부
export function extractHistoryYearLinks(xml: string): { year: number; title: string }[]; // /^(\d{4}) - 히스토리 기록$/
export async function loadHistoryChain(): Promise<HistoryChain>;       // 허브→년도 링크→각 노트 파싱, 모듈 캐시
export function recordsForDate(chain: HistoryChain, year: number, month: number, day: number): HistoryEntry[]; // year 미만, 내림차순
```

- `loadHistoryChain`: `getNote(SEND_TARGET_GUID)` → `extractHistoryYearLinks(hub.xmlContent)` →
  각 `title` `findNoteByTitle` → `deserializeContent` → `parseHistoryYearNote(doc, linkYear)`.
  실패한 노트는 건너뜀. `byMonthDay`는 `${pad(month)}-${pad(day)}` 키.
- 캐시: 모듈 레벨 `Promise<HistoryChain>` 1개 + `onInvalidate`(noteListCache) 구독 시 폐기.
  (허브/년도 노트 편집 → 캐시 무효화 → 다음 로드에서 재파싱.)
- 허브 자신의 현재 년도(2026) 항목은 `byMonthDay`에서 제외(기존 다이어리 맵이 이미 담당;
  어차피 `recordsForDate`의 `year < target`에서 걸러짐). 링크 체인 노트만 대상.

## 새/수정 파일 요약

**신규**
- `calendar/historyChain.ts` — 위.
- `calendar/PrevYearRecords.svelte` — `records: HistoryEntry[]`(이미 필터/정렬됨) → 년도별
  그룹, 우측정렬·흐린 목록. 푸터(req 2)·임시 오버레이(req 5) 공유. (달력 셀 req 3은 공간이
  좁아 컴포넌트 대신 `CalendarView` 인라인 마크업.)
- `DateNoteFooter.svelte` — 제목 파싱 + 체인 로드 + `PrevYearRecords`.
- `EphemeralDateOverlay.svelte` — req 5.

**수정**
- `calendar/CalendarView.svelte` — `onopendate` prop; 모든 in-month 셀 클릭; 배지=별도 버튼
  (`<div role=button>` 전환); `byMonthDay` 로드 + 셀 이전 년도 라인.
- `CalendarWindow.svelte` — `onopendate` 배선(find→open/ephemeral); 목록에 `prevYearTitles`
  계산·전달; `EphemeralDateOverlay` 상태.
- `DayNotesBundleOverlay.svelte` — `prevYearTitles` prop 병합.
- `NoteWindow.svelte` — `isDateNote`일 때 `DateNoteFooter` 마운트.
- `settings/+page.svelte` — 가이드 카드(달력 새 동작). *(CLAUDE.md 불변식: 사용자 기능은
  설정 → 가이드에 문서화.)*

## 테스트 (vitest, `app/tests/unit/desktop/calendar/`)

- `historyChain.test.ts`
  - `parseHistoryDayLine`: `9일(월) 물주기`→{9,"물주기"}, `3(토) 트리하우스`→{3,...},
    `9*(토) X`·`25(월*) Y`·`(수, 한글날)` 마커, `10일(수) - 15일(월) Z`(범위 day=10),
    잘못된 일(32) → null.
  - `parseHistoryYearNote`: 월 내림차순 문서에서 전월 수집, 중첩 리스트 첫 문단만.
  - `extractHistoryYearLinks`: `2025 - 히스토리 기록`만, `2026년`·본문 링크 제외; 연도 파싱.
  - `recordsForDate`: `year < target` 필터 + 내림차순 정렬 + 같은 (월,일) 버킷.
- (선택) `CalendarView` 렌더 테스트: 배지 클릭=ondayselect, 셀 클릭=onopendate 분리.

## 불변식 / 주의

- 알림용 `parseScheduleNote`/`DAY_PREFIX_RE`는 **수정 금지** — 새 히스토리 파서로 분리.
- 날짜 노트 푸터는 에디터 밖 패널 — `.note` XML·`pendingDoc`·캐럿 불변.
- 셀 배지 버튼 중첩 방지(셀=div role=button, 배지=button).
- 히스토리 체인 로드는 캐시 1회 + 무효화 구독; 달 이동마다 재읽기 금지(버킷은 연도 보존,
  렌더에서 `year < viewYear` 필터).
- 모든 UI 문자열 한국어.
```
