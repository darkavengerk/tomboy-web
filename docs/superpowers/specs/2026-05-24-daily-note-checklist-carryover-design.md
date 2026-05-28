# 일일노트: 체크리스트 시드 + 어제 미체크 캐리오버

날짜: 2026-05-24

## 배경

`createNote` 가 제목 `yyyy-mm-dd` 형식의 노트를 만들 때, 현재는
schedule 노트에서 그 날짜 일정 라벨을 뽑아 본문 상단에 `TODO:` 헤더 +
bulletList 로 시드한다. 구현은 `app/src/lib/schedule/dateNoteSeed.ts`
의 `buildDateNoteScheduleSeed` + `buildTodoBlocks` 가 담당하고,
`noteManager.createNote` 가 호출한다.

두 가지 보완 요구:

1. **TODO → 체크리스트.** 시드되는 항목들을 "그냥 bullet"이 아니라
   인터랙티브 체크박스(클릭으로 체크/해제, XML 라운드트립까지) 로 만든다.
2. **어제 미체크 캐리오버.** 캘린더상 정확히 1일 전 제목(`yyyy-mm-dd`)의
   노트가 있으면, 거기에 있는 체크리스트 영역의 미체크 항목을 가져와
   오늘 시드에 함께 넣는다. 의도는 "어제 못 한 것 상기".

## 기존 인프라 (재사용)

체크리스트 인프라는 이미 갖춰져 있다. **새로 만들 필요 없다.**

- **헤더 규칙** (`app/src/lib/editor/checklist/regions.ts:11`):
  최상위 paragraph 의 trim 된 텍스트가 `체크리스트:` 로 시작하면 헤더.
  그 다음 오는 1개 이상의 연속 `bulletList` 가 영역.
- **체크 상태 모델**: `listItem.attrs.checked: boolean`. ProseMirror
  플러그인이 영역 안의 listItem 을 체크박스 UI 로 렌더링한다.
- **XML 라운드트립** (`app/src/lib/core/noteContentArchiver.ts`):
  직렬화 시 영역 안 항목은 첫 텍스트 앞에 `[ ]` (미체크) / `[X]` (체크)
  마커가 붙고, 역직렬화 시 `applyChecklistMarkersOnParse` 가 마커를
  떼고 `attrs.checked` 를 복원한다.

따라서 1번(TODO → 체크리스트)은 **시드 헤더 텍스트를 `TODO:` →
`체크리스트:` 로 바꾸기만 하면 된다**. 그러면 기존 플러그인이 자동으로
체크박스로 렌더링하고 XML 라운드트립도 작동한다.

## 변경 범위

- `app/src/lib/schedule/dateNoteSeed.ts` — 기존 파일 안에서 함수 분해,
  신규 캐리오버 추출 함수 추가, `buildTodoBlocks` → `buildChecklistBlocks`
  교체. 외부 API 시그니처 `buildDateNoteScheduleSeed(y, m, d)` 는 유지.
- `app/src/lib/core/noteManager.ts` — **변경 없음**. `createNote` 가
  `buildDateNoteScheduleSeed` 를 부르는 코드는 그대로.
- `app/tests/unit/schedule/dateNoteSeed.test.ts` — 신규 또는 기존 확장.

## 동작 정의

### 어제 날짜 계산

`new Date(year, month - 1, day - 1)` 후 `yyyy-mm-dd` 로 포맷. JS Date
산술이 월/년 경계를 자동 처리하므로 별도 로직 불필요.

### 어제 노트 조회

`findNoteByTitle(yesterdayTitle)`. 제목이 정확히 `yyyy-mm-dd` 일 때만
매치 (`createNote` 기본 제목 형식 그대로). 일치하는 노트가 없거나
`note.deleted === true` 면 캐리오버 = `[]`.

### 체크리스트 영역 스캔 (JSONContent 위)

deserialize 된 doc 의 `content` 배열에서:

1. 최상위 paragraph 중 plain text 가 `체크리스트:` 로 시작하는 것을 헤더로 인식.
2. 헤더 직후 오는 1개 이상의 연속 `bulletList` 가 그 영역.
3. doc 안의 **모든** 체크리스트 영역을 발견 순서대로 처리하여 결과를 합친다.

규칙은 `editor/checklist/regions.ts:findChecklistRegions` (PM 노드 버전)
및 `noteContentArchiver.ts:applyChecklistMarkersOnParse` (직렬화 버전)
와 의미적으로 동일하다. **세 곳이 모두 같은 규칙을 따라야 한다는 점을
새 함수 위에 코멘트로 명시한다** (기존 `applyChecklistMarkersOnParse`
위의 코멘트 패턴과 일치).

### 미체크 가지 추출

각 영역의 bulletList 안 listItem 트리를 재귀로 순회. 결과 단위는
listItem 별로 `null | JSONContent | JSONContent[]`:

- `attrs.checked === false` 인 listItem → **자기 보존**. 자식
  bulletList 가 있으면 재귀 결과로 교체한다. 자식 리스트의 모든 항목이
  사라지면 자식 list 자체를 제거한다. 자기의 `attrs.checked` 는 `false`
  로 그대로 유지된다.
- `attrs.checked === true` 인 listItem → **자기 버림**. 자식 트리에서
  추출된 미체크 listItem 들을 **상위 listItem 배열에 평탄화로 끼워**
  올린다. (사용자가 선택한 "부모 체크-자식 미체크면 자식만 최상위로
  올림" 규칙.)

영역 내 최상위 listItem 들에 대해 위 함수를 호출한 뒤, 결과를 평탄화한
`JSONContent[]` (listItem 들) 이 그 영역의 캐리오버 항목 집합이다.
모든 영역의 결과를 발견 순서대로 이어붙인다.

### 시드 블록 조립

`buildChecklistBlocks(scheduleLabels: string[], carryoverItems: JSONContent[])`:

1. `scheduleLabels` 가 0 개이고 `carryoverItems` 도 0 개면 `[]` 반환
   (기존 "시드 없음" 동작 유지 — `createNote` 가 빈 본문으로 떨어진다).
2. 그렇지 않으면 다음 2-블록 시퀀스를 반환:
   - `{ type: 'paragraph', content: [{ type: 'text', text: '체크리스트:' }] }`
   - `{ type: 'bulletList', content: [ ...scheduleItems, ...filteredCarryover ] }`
3. scheduleItems: 각 label 에 대해 `{ type: 'listItem', attrs: { checked: false },
   content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] }`.
4. **중복 제거**: carryover 의 최상위 listItem 중, 첫 paragraph 의
   `getPlainText()` 결과를 trim 한 값이 어떤 schedule label 과 정확히
   일치하면 그 carryover 항목을 통째로 (자식 포함) 스킵한다.
5. carryover 의 모든 listItem 은 `attrs.checked: false` 로 강제 설정
   (영역 안에 있어야 체크박스로 인식되므로, 잠재적 누락 방지). 자식
   bulletList 안의 보존된 자식들은 이미 미체크였으므로 그대로.

### `buildDateNoteScheduleSeed` 동작

내부적으로:

1. `extractScheduleLabelsForDate(...)` (기존) 으로 schedule 라벨 추출.
2. `extractUncheckedFromYesterdayNote(y, m, d)` 로 어제 미체크 추출
   (실패 시 `[]`).
3. `buildChecklistBlocks(labels, carryover)` 로 머지.
4. 결과 반환.

전체를 감싸는 try/catch 는 기존과 동일 (어떤 실패도 `[]` 로 떨어져
`createNote` 는 정상 진행).

## 데이터 흐름

```
createNote("2026-05-24")
  └─ buildDateNoteScheduleSeed(2026, 5, 24)
       ├─ extractScheduleLabelsForDate(scheduleEntries) → ["회의", "병원"]
       ├─ extractUncheckedFromYesterdayNote(2026, 5, 24)
       │     ├─ findNoteByTitle("2026-05-23")
       │     ├─ deserializeContent(note.xmlContent) → doc
       │     ├─ 영역 스캔 (체크리스트: 헤더 + 연속 bulletList)
       │     └─ 각 listItem 트리에서 미체크 가지만 보존/끌어올림
       │        → JSONContent[] (listItem들)
       └─ buildChecklistBlocks(labels, carryoverItems)
            → [headerParagraph, bulletList{ schedule + filtered carryover }]
```

## 엣지 케이스

| 상황 | 동작 |
|------|------|
| 어제 노트 없음 | carryover = []. schedule 만 있으면 schedule 만 시드. 둘 다 없으면 시드 생략. |
| 어제 노트가 `note.deleted === true` | 동일 (없는 것으로 취급). |
| 어제 노트는 있지만 `체크리스트:` 헤더가 없음 | carryover = []. |
| 어제 노트 체크리스트가 다 체크됨 | carryover = []. |
| 어제 노트에 `체크리스트:` 영역이 2 개 이상 | 발견 순서대로 모두 합쳐 carryover 에 포함. |
| 어제 영역의 부모 체크-자식 미체크 | 자식만 최상위로 끌어올려 단일 listItem 로 시드. |
| 어제 영역의 부모 미체크-자식 부분체크 | 부모 보존 + 자식 bulletList 에 미체크 자식만 남김. |
| schedule label 과 carryover 최상위 텍스트(trim)가 일치 | 그 carryover 항목 통째 스킵 (자식 포함). |
| 어제 노트 deserialize 에러 | try/catch 안에서 `console.warn` + carryover = []. |
| 일일노트 제목이 충돌해 `(2)` 가 붙음 | 제목이 `yyyy-mm-dd` 정규식에 안 맞아 시드 자체 미적용 (기존 동작). |
| 월/년 경계 (2026-01-01 → 어제는 2025-12-31) | `new Date(y, m-1, d-1)` 자동 처리. |

## 에러 / 실패 처리

- `extractUncheckedFromYesterdayNote` 는 try/catch 로 감싸 모든 예외를
  swallow 하고 `[]` 반환. `console.warn('[dateNoteSeed] yesterday
  carryover failed', err)`.
- `buildDateNoteScheduleSeed` 전체에도 기존 try/catch 가 있어 이중 안전망.
- 일일노트 생성 자체는 어떤 경우에도 막지 않는다 (현재 동작 그대로).

## 마크/링크 보존

carryover listItem 들은 어제 노트의 JSONContent 를 그대로 들고 온다
(text 마크, internal-link, url-link, monospace 등). 텍스트 추출/재조립
없음. 트리 가지치기만 한다.

## Title uniqueness / rename 인터랙션

캐리오버는 listItem 의 **content** 만 옮기므로 title-rewrite 경로에는
영향 없다. internal-link 마크가 어제 노트에서 오늘 노트로 그대로
복사되더라도 `rewriteBacklinksForRename` 의 invariant 는 깨지지 않는다
(링크는 title 텍스트를 가리키고, 오늘 노트는 그 title 에 영향을 주지
않는 새 노트일 뿐).

## 테스트 계획

`app/tests/unit/schedule/dateNoteSeed.test.ts` (없으면 신규):

**`extractUncheckedFromDoc` (순수 함수)**

1. 빈 doc → `[]`.
2. 헤더 없음 → `[]`.
3. 헤더 + 미체크 3개 → 3개.
4. 헤더 + 미체크 2 / 체크 1 → 미체크 2 개.
5. 부모 체크, 자식 미체크 1개 → 자식 1개 (평탄화).
6. 부모 미체크, 자식 미체크 1 / 자식 체크 1 → 부모 + 자식 미체크 1.
7. 영역 2개 (헤더 + 연속 bulletList 가 두 번 등장) → 양쪽 미체크 합침.
8. 헤더 다음에 bulletList 가 아닌 블록 (예: 그냥 paragraph) → 그
   헤더의 영역은 비어 있음 / 다음 영역은 정상 인식.

**`buildChecklistBlocks` (순수 함수)**

1. schedule = ["a"] / carryover = [] → 헤더 + listItem("a").
2. schedule = [] / carryover = [{li("x")}] → 헤더 + listItem("x", checked=false).
3. schedule = ["a"] / carryover = [{li("x")}] → 헤더 + [li("a"), li("x")].
4. schedule = ["a"] / carryover = [{li("a")}] (중복) → 헤더 + [li("a")] 한 번만.
5. schedule = ["a"] / carryover = [{li("a") with 자식 미체크}] (최상위 중복) → 통째 스킵, [li("a")] 만.
6. schedule = [] / carryover = [] → `[]`.

**`buildDateNoteScheduleSeed` (integration, fake-indexeddb)**

1. schedule 노트만 시드 + 어제 노트 없음 → 헤더 + schedule 라벨들.
2. 어제 노트만 (체크리스트 영역에 미체크 1개) → 헤더 + 미체크 1개.
3. 둘 다 시드 → 합쳐서 schedule 먼저, carryover 다음.
4. 어제 노트는 있는데 deserialize 실패 (xmlContent 망가뜨림) → schedule 만.
5. schedule 도 없고 어제도 비어 있음 → `[]` (시드 생략).

## 비목표 (out of scope)

- 7일 전, 2일 전 등 **여러 날** 거슬러 올라가는 캐리오버 — 캘린더상 정확히 1일 전 고정.
- 캐리오버 항목에 "출처: 어제" 같은 라벨/메타 마킹 — 사용자가 수동으로 보고 필요없으면 삭제.
- 일일노트 제목 형식 (`yyyy-mm-dd`) 의 변경 — 기존 그대로.
- 체크리스트 영역 스캔 규칙 자체의 변경 — 세 구현체(regions.ts /
  archiver / dateNoteSeed) 모두 동일 규칙 유지.
- ProseMirror 체크박스 UI 의 변경 — 기존 인프라 그대로 사용.

## 작업 순서 (구현 계획에 넘김)

1. `buildTodoBlocks` 제거, `buildChecklistBlocks` 신규 (헤더 `체크리스트:`).
2. `extractUncheckedFromDoc` 신규 (순수, JSONContent 위).
3. `extractUncheckedFromYesterdayNote` 신규 (IDB 어댑터).
4. `buildDateNoteScheduleSeed` 내부에서 1+3 호출 후 2 호출하도록 변경.
5. 테스트 추가.
6. 수동 검증: 오늘 일일노트 + 어제 일일노트 두 개 만들고 어제 일부
   체크/일부 미체크 후 오늘 노트 재생성해 시드 확인 (개발 서버).
