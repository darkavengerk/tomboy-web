# 일정 노트 반복 마커 세분화 (positional `*` + `^N`)

날짜: 2026-05-29

## 배경

일정 노트의 리스트 항목에는 "보내기" 버튼이 있다. 누르면 항목을 도착 노트로
옮기고, 원본 줄에 `*`가 있으면 **다음 달 같은 날짜**에 동일 항목을 다시
추가해 매달 반복되게 한다. 현재 트리거는 `text.includes('*')` — 줄 어디든
`*`가 있으면 발동하고, 항상 "다음 달 같은 날짜"만 만든다.

이 동작을 마커의 **위치**에 따라 세 가지로 세분화한다.

## 목표 동작

prefix 형식은 `<일 번호>(<요일>) <라벨>` (autoWeekday가 자동으로 `(요일)`을 채움).

| 입력 | 의미 | 복제 결과 |
|---|---|---|
| `25*(수) 가스점검` | 날짜 옆 `*` = **월간** | 다음 달 25일에 추가 (일 번호 유지, 월 +1) |
| `25(수)* 화분 물주기` | 요일 옆 `*` = **주간** | 다음 주 같은 요일(+7일)에 추가 |
| `25(수)^2 책반납` | 요일 옆 `^N` = **N주** | N주 뒤(+7N일)에 추가 |

세 가지 모두 **계속 반복**된다 — 복제본도 같은 위치에 마커를 그대로 보존하므로
다음 "보내기" 때 또 추가된다. 기준 날짜는 항상 **항목에 적힌 날짜**(섹션 월 +
일 번호, 올해)이며 오늘 날짜와 무관하다.

## 확정된 결정

1. **세 마커 모두 계속 반복** (복제본에 마커 보존).
2. **라벨 텍스트 안의 `*`는 무시** — 위치 마커(날짜 옆 / 요일 옆)만 인식.
   현재의 "줄 아무 데나 `*`" 동작을 대체한다 (동작 변경).
3. **도착 노트로 보낸 복제본은 마커를 원본 그대로 유지** (현재 동작 유지, 단순).
4. **autoWeekday를 `25*(수)` 형태도 처리하도록 확장** — 월간 마커가 있어도
   요일 자동 채우기/교정이 동작.
5. 같은 달 내 주간 복제는 리스트 끝에 append → 날짜 순서가 어긋날 수 있으나
   기존 동작과 동일하게 **정렬하지 않음** (허용).

## 접근: 통합 (목표 절대 날짜 → 그 월 섹션에 삽입)

세 마커를 모두 "목표 절대 날짜 계산 → 해당 월 섹션에 삽입"으로 통일한다.
- 월간 = 일 번호 유지, 월 +1 (캘린더 월 덧셈)
- 주간 = 기준일 + 7일 (JS Date 덧셈, 월·연 넘어감 자동)
- N주 = 기준일 + 7N일

`planNextMonthInsert`는 이미 월을 인자로 받으므로 `planMonthInsert(targetMonth)`
로 일반화하면 된다. 새로 추가되는 조각은 (a) 위치 마커 파서, (b) 목표 절대 날짜
계산뿐이다.

## 컴포넌트 설계

### 1. 마커 파서 — `recurringCopy.ts`

단일 prefix 정규식으로 위치 마커를 인식한다:

```
/^(\s*)(\d{1,2})(\*)?\(([^)]*)\)(?:(\*)|\^(\d{1,2}))?\s*(.*)$/
```

| 그룹 | 의미 |
|---|---|
| 1 | 선행 공백 |
| 2 | 일 번호 |
| 3 | 월간 `*` (날짜 옆, 선택) |
| 4 | 요일 글자(파렌 안) |
| 5 | 주간 `*` (요일 옆, 선택) |
| 6 | `^N`의 N (선택) |
| 7 | 라벨 |

```ts
type RecurrenceSpec =
  | { kind: 'monthly' }
  | { kind: 'weekly' }
  | { kind: 'everyNWeeks'; weeks: number };

// null = 위치 마커 없음 (라벨 안의 * 는 무시)
function parseRecurrence(text: string): RecurrenceSpec | null;
```

규칙:
- 그룹 3이 있으면 `monthly`.
- 아니고 그룹 5가 있으면 `weekly`.
- 아니고 그룹 6이 있으면 `everyNWeeks` (weeks = 그룹 6, ≥ 1).
- 둘 다 있으면(`25*(수)*`) **monthly 우선**.
- 정규식 자체가 매치 안 되면(파렌 없음, 일 번호 없음 등) `null`.
- 라벨(그룹 7) 안의 `*`/`^`는 캡처되지 않으므로 자동으로 무시된다.

기존 `containsRecurringMarker`(substring)는 제거하고 `parseRecurrence`로 대체.

### 2. 목표 날짜 계산 — `computeTargetDate`

```ts
function computeTargetDate(
  baseYear: number, baseMonth: number, baseDay: number, spec: RecurrenceSpec
): { year: number; month: number; day: number };
```

- `monthly`: `nextMonthOf(baseMonth)`로 월/연 오프셋 계산, 일 번호 유지.
  목표 일이 해당 월에 유효하지 않으면(예: 1/31 → 2/31) **일 번호 그대로 두고
  요일 재계산 생략** (기존 `transformDayPrefixLine`의 invalid-date 패스와 동일).
- `weekly` / `everyNWeeks`: `new Date(baseYear, baseMonth-1, baseDay + 7*weeks)`로
  계산 후 `getFullYear/getMonth/getDate` 추출. weekly는 weeks=1.

`baseYear`는 파서와 동일하게 "올해"(`new Date().getFullYear()`). 월간 12월→1월은
`nextMonthOf`의 yearOffset로 처리, 주간/N주의 연 넘어감은 JS Date가 처리.

### 3. 복제본 생성 — `buildRecurredLiJson`

기존 `buildNextMonthLiJson`을 대체/일반화.

```ts
function buildRecurredLiJson(
  liJson: JSONContent,
  target: { year: number; month: number; day: number },
  spec: RecurrenceSpec
): JSONContent;
```

- li JSON 깊은 복제.
- 첫 문단 첫 텍스트 노드의 prefix를 재작성: 일 번호 → `target.day`,
  요일 → `target` 날짜로 재계산한 글자.
- **마커는 원위치 보존**: monthly `*`는 날짜와 파렌 사이, weekly `*`/`^N`은
  파렌 뒤. 위 정규식의 그룹을 재조립해 출력.
- 라벨(그룹 7)은 그대로.
- 유효하지 않은 목표 날짜면 요일 재계산을 생략하고 일 번호만 갱신(또는 monthly
  invalid 케이스는 일 번호도 그대로).

### 4. 삽입 플래너 — `planNextMonthInsert` → `planMonthInsert`

함수 본문은 그대로(이미 월 파라미터화돼 있음), 이름만 일반화하고 호출부에서
`target.month`를 넘긴다. 해당 월 섹션이 있으면 리스트 끝에 append, 없으면
`new-section-at-end`로 새 섹션 생성.

### 5. transferListItem.ts — `applySourceSideEdits`

```ts
const spec = parseRecurrence(firstLineTextOf(current));
if (spec) {
  const base = { year: currentYear, month: findContainingMonth(state.doc, liPos), day: parsedDay };
  const target = computeTargetDate(base.year, base.month, base.day, spec);
  const liJson = buildRecurredLiJson(current.toJSON(), target, spec);
  const plan = planMonthInsert(state.doc, target.month);
  const nodes = buildInsertionNodes(state.schema, plan, liJson, target.month);
  if (nodes) { tr.insert(insertPos, nodes); didRecur = spec.kind; }
}
```

`recurring` 불리언 대신 `RecurrenceSpec | null`을 전달. 반환 outcome도
`'sent'` + 반복 종류를 담아 토스트를 분기.

도착 노트로 보내는 `liJson`은 **원본 그대로**(마커 포함) — 변경 없음.

### 6. autoWeekday 확장 — `autoWeekday.ts`

`WITH_PARENS_RE`와 `SPACE_BEFORE_PARENS_RE`가 일 번호와 `(` 사이의 선택적 `*`를
허용하도록 수정하고, 출력에 그 `*`를 보존한다.

```
WITH_PARENS_RE        : /^(\s*)(\d{1,2})(\*?)(\([^)]*\))(.*)$/
SPACE_BEFORE_PARENS_RE: /^(\s*)(\d{1,2})(\*?)(\s+)(\([^)]*\))(.*)$/
```

출력 재조립 시 `*` 그룹을 일 번호와 `(` 사이에 다시 넣는다. weekly `*`/`^N`은
파렌 뒤(rest)에 있어 기존 `(.*)$` rest 캡처로 이미 보존되므로 변경 불필요.

### 7. 토스트 메시지 — `transferListItem.ts`

| 반복 | 메시지 |
|---|---|
| monthly | `보냈습니다. 다음 달에도 추가했어요.` |
| weekly | `보냈습니다. 다음 주에도 추가했어요.` |
| everyNWeeks | `보냈습니다. {N}주 뒤에도 추가했어요.` |
| 없음 | `보냈습니다.` |
| 원본 위치 변경 | `보냈습니다. 원본 위치가 바뀌어 수동으로 정리하세요.` (기존) |

## 데이터 흐름

```
보내기 클릭
  → transferListItem(sourceEditor, liPos, liNode)
    → writeToDestination(liJson 원본 그대로)
    → applySourceSideEdits:
        spec = parseRecurrence(firstLineText)
        if spec:
          base  = { year: 올해, month: findContainingMonth, day }
          target= computeTargetDate(base, spec)
          liJson= buildRecurredLiJson(원본, target, spec)   // 마커 보존
          plan  = planMonthInsert(doc, target.month)
          tr.insert(...)
        tr.delete(원본 li)
        dispatch(tr)   // 삽입+삭제 단일 트랜잭션 (undo 1회)
    → 토스트 (반복 종류별)
```

## 엣지 케이스 / 알려진 한계

- **파렌 없는 줄**: 위치 마커 인식 불가 → 반복 안 됨. autoWeekday가 파렌을
  자동으로 채우므로 정상 사용에선 문제 없음.
- **월간 31일 → 짧은 달**: 목표 일이 무효 → 일 번호 유지, 요일 재계산 생략
  (기존 동작과 동일).
- **같은 달 내 주간**: 리스트 끝에 append → 날짜 순서 어긋날 수 있음(정렬 안 함).
- **연도 경계 섹션**: 기준 연도는 올해 가정. 12월 항목의 다음 달(1월)은
  monthly yearOffset, 주간/N주는 JS Date가 처리. 파서의 기존 implicit-year
  한계와 동일 범위.
- **마커 둘 다(`25*(수)*`)**: monthly 우선.

## 테스트 계획

`app/tests/unit/editor/recurringCopy.test.ts` 확장 + autoWeekday 테스트 보강.

- `parseRecurrence`: 월간/주간/N주/없음, 라벨 안 `*` 무시, 둘 다일 때 monthly,
  파렌 없는 줄.
- `computeTargetDate`: 월간(일 번호 유지, 12월→1월), 주간(+7, 월 넘어감),
  N주(+7N, 다다음 달까지), 무효 일.
- `buildRecurredLiJson`: 세 종류 각각 prefix 재작성 + 마커 위치 보존 + 요일
  재계산 + 라벨 보존 + 입력 비변형.
- `planMonthInsert`: 기존 `planNextMonthInsert` 테스트를 임의 월로 일반화.
- autoWeekday: `25*(수)` 형태에서 요일 교정 + `*` 보존, idempotency.

Cloud Function / Firestore 푸시 로직은 **변경 없음** — 이 기능은 에디터의
"보내기" 시점 텍스트 변형이며, 변형된 줄은 일반 저장 경로(`syncScheduleFromNote`)
를 그대로 탄다.

## 영향 파일

| 파일 | 변경 |
|---|---|
| `lib/editor/sendListItem/recurringCopy.ts` | `parseRecurrence`, `computeTargetDate`, `buildRecurredLiJson`, `planMonthInsert` 추가/일반화; `containsRecurringMarker`/`buildNextMonthLiJson` 제거 |
| `lib/editor/sendListItem/transferListItem.ts` | spec 기반 `applySourceSideEdits`, 토스트 분기 |
| `lib/schedule/autoWeekday.ts` | prefix 정규식에 선택적 `*` 허용 |
| `app/tests/unit/editor/recurringCopy.test.ts` | 신규 함수 테스트 |
| `app/tests/unit/...autoWeekday...` | `*` 형태 테스트 보강 |
