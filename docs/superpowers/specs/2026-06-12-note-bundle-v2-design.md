# 노트 묶음 v2 — 타이틀 윈도우 + 유연 트리거 설계

> v1 스펙: `2026-06-12-note-bundle-design.md`. 이 문서는 v1 위 델타만 다룬다.
> 변경 없는 부분(위젯 데코레이션, 임베디드 에디터 로드/저장, 라디오 영속,
> 높이 쓰기백, 격벽, 중첩 가드)은 v1 그대로.

## 배경

v1 은 활성 노트 **위로만** 접힌 바를 표시한다 (`MAX_COLLAPSED_BARS=4`).
첫 노트가 활성이면 타이틀이 1개만 보여 "파일철 훑기" 취지가 죽는다.
또 트리거가 `[ ]노트 묶음:` 한 줄 시작 고정이라 TODO/Process 류 prefix
플러그인과 조합할 수 없다.

## 1. 타이틀 윈도우 (WINDOW_SIZE = 5)

`stackMath.ts` 재작성. `MAX_COLLAPSED_BARS`/`collapsedBarStart` 폐기.

- **윈도우** = 활성 노트 포함 연속 `min(5, N)` 개 타이틀. 인덱스는
  resolved 배열 기준 0-based, `start..start+W-1` (`W = min(5, N)`).
- **레이아웃** (위→아래):
  1. 상단 접힌 바들: `start .. active-1`
  2. 활성 바 (`.expanded-bar`)
  3. 콘텐츠 (임베디드 에디터)
  4. 하단 접힌 바들: `active+1 .. start+W-1`
  5. 리사이즈 핸들
- **불변**: `start ≤ active ≤ start+W-1`, 그리고 활성의 이전/다음 노트가
  존재하면 항상 윈도우 안 (`active-1 ≥ start`, `active+1 ≤ start+W-1`,
  각각 해당 이웃이 존재할 때만).

### 이동 알고리즘 (순수 함수, 0-based)

```ts
const W = Math.min(5, N);
const maxStart = Math.max(0, N - W);

// 불변 강제 클램프 (점프: 바 탭 / 외부 라디오 변경에도 그대로 사용)
// active 의 prev/next 가 윈도우 안에 들어오도록 start 를 최소 이동.
clampWindow(start, active, N):
  if (N <= W) return 0;
  s = clamp(start, active - (W - 2), active - 1);  // 활성 위치 ∈ [1, W-2]
  return clamp(s, 0, maxStart);                    // 양 끝 고정이 우선

// 한 칸 이동 (휠/스와이프): eager 슬라이드 1 + 불변 클램프.
// active' 가 broken 스킵으로 여러 칸 점프해도 클램프가 따라잡는다.
stepWindow(start, active', dir, N) = clampWindow(start + dir, active', N)

// 마운트 초기값: start = clamp(active - 1, 0, maxStart) (활성 위 1개)
```

- 정상상태: 내려갈 땐 위 1 + 아래 3, 올라갈 땐 위 3 + 아래 1 —
  진행 방향의 노트들이 미리 보인다.
- 끝 도달 (`start == maxStart` 또는 `0`): 윈도우 고정, 활성만 이동.
- `active'` 자체는 v1 `nextValidIndex` 그대로 (broken 스킵). 윈도우는
  broken 포함 단순 인덱스 — 깨진 링크 타이틀도 바로는 보인다.
- 윈도우 `start` 는 `NoteBundleStack` 컴포넌트 `$state` — 영속 안 함.
  라디오(=활성)만 v1 대로 영속. 외부에서 라디오가 바뀌어 `k` 가 점프하면
  점프 클램프로 따라간다 (`$effect` 또는 `$derived` 후처리).

## 2. 숨김 카운트 배지

- 위 숨김 = `start`, 아래 숨김 = `N - (start + W)`.
- 위 숨김 > 0 → **가장 위에 보이는 바**에 `+{start}` 배지.
  아래 숨김 > 0 → **가장 아래 바**에 `+{N-start-W}` 배지.
  활성 바가 가장자리면 활성 바가 배지를 가진다.
- 바 내부: `<span class="bar-title">` (ellipsis) + `<span class="bar-badge">`
  (`flex-shrink: 0`, muted). 예: `[이런 저런 노트들 묶음… +5]`.

## 3. 타이틀 더블클릭/더블탭 → 노트 열기

- `dblclick` 이벤트 사용 불가 — 포인터 캡처가 파생 click 을 retarget
  (v1 함정 #2). **pointerup 수동 판정**: 직전 탭과 같은 바 인덱스 +
  간격 < 300ms → 더블탭.
- 동작: 해당 entry 의 `oninternallink(title)` 호출 (모바일 = 라우팅,
  데스크탑 = 새 창 — 호스트의 기존 핸들러 그대로). **첫 탭의 활성 전환은
  유지** (부수효과: 라디오가 그 노트로 이동 — 묶음이 마지막 본 노트 기억).
- broken entry: 무시.

## 4. Ctrl+wheel 전역 플립

- `.bundle-stack` 루트에 direct wheel 리스너: `e.ctrlKey`(또는 metaKey)
  이면 `preventDefault()`(브라우저 줌 차단) + `stopPropagation` + 플립
  누적 (`wheelAcc` 공유).
- 일반 wheel 은 바 영역(상·하단 모두)에서만 플립 — v1 동작 유지.
  콘텐츠 위 일반 wheel = 임베디드 스크롤 그대로.
- 스와이프는 양쪽 바 영역에서 동작 (기존 핸들러를 상·하단 컨테이너에
  공통 부착, 또는 단일 컨테이너 구조라면 바 요소 기준 판정).

## 5. 유연한 트리거 (prefix)

`parser.ts` `parseKeywordParagraph` 완화:

- "체크박스가 첫 자식" 제약 제거. 새 규칙:
  **paragraph 안에서, 뒤따르는 텍스트가 `KEYWORD_RE` 에 매칭되는
  inlineCheckbox** 를 찾는다 (앞에서부터 스캔, 첫 매칭 사용).
- 그 체크박스 **앞쪽 텍스트** (`textBetween` 상당 — inline 워크로 수집,
  atom 은 빈 문자열): trim 후 **비었거나 `:` 로 끝나야** 유효.
  - `Done:[ ]노트 묶음:3` ✓ / `A:B:[ ]노트묶음:` ✓ / `[x]Done:[ ]노트묶음:` ✓
    (두 번째 체크박스 채택) / `메모 [ ]노트묶음:` ✗
- 체크박스 뒤 텍스트는 v1 그대로 `KEYWORD_RE = /^\s*노트\s*묶음:(\d+)?\s*$/`.
  `digitsFrom/To` 는 체크박스 abs pos 기준으로 재계산 (prefix 길이 반영 —
  `textBase = checkboxPos + 1`).
- prefix 에 marks(bold 등) 허용 — 텍스트 내용만 본다.
- doc index 0 (제목 라인) 제외는 유지.

## 6. 슬라이드 애니메이션

- 바들은 **단일 keyed `{#each}`** (윈도우 항목 전체, 활성 포함 전부
  button), 콘텐츠 패널은 each **바깥** 단일 요소. 배치는 flex `order` 로:
  바 i → `order: i*2`, 콘텐츠 → `order: (active-start)*2 + 1` — 활성 바
  바로 아래 끼워진다.

```svelte
<div class="bundle-list"> <!-- flex column -->
  {#each winEntries as e, i (e.originalIndex)}
    <button class="bundle-bar" class:expanded-bar={…} style:order={i * 2}
            animate:flip={{ duration: 150 }}>…</button>
  {/each}
  <div class="bundle-body" style:order={(k - winStart) * 2 + 1}>…</div>
</div>
```

- `animate:flip` 은 keyed each 의 직계 자식이어야 한다 — `{#if}` 래퍼
  금지가 button 통일({`class:expanded-bar`})의 이유.
- 콘텐츠 패널은 **단일 인스턴스 유지** (임베디드 에디터 리마운트 방지 —
  파일철 빠르게 넘길 때 TipTap 재초기화 비용 회피). 페이드 없음;
  윈도우 슬라이드 시 바 flip(150ms)이 넘김 효과를 담당한다.
- 콘텐츠 패널 높이는 flex `1` 유지 — 바 수가 상·하로 변해도 스택 전체
  높이(`stackH`)는 불변.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `lib/editor/noteBundle/stackMath.ts` | 재작성: `WINDOW_SIZE`, `stepWindow(start, active', dir, N)`, `clampWindow(start, active, N)`, 카운트 헬퍼. `nextValidIndex`/`firstValidIndex` 유지 |
| `lib/editor/noteBundle/parser.ts` | `parseKeywordParagraph` prefix 완화 |
| `lib/editor/noteBundle/NoteBundleStack.svelte` | 레이아웃 단일 keyed each + 상·하 바, 배지, 더블탭, ctrl+wheel, flip 애니메이션 |
| `tests/unit/editor/noteBundle/stackMath.test.ts` | 윈도우 알고리즘 테이블 테스트 |
| `tests/unit/editor/noteBundle/parser.test.ts` | prefix 케이스 추가 |
| `routes/settings/+page.svelte` | 가이드 카드 갱신 (prefix 문법, 더블클릭, ctrl+wheel) |

플러그인(`noteBundlePlugin.ts`), 임베디드 로드/저장, 격벽, 중첩 가드,
높이 쓰기백, 라디오 자동 삽입 — 변경 없음.

## 테스트 계획

- `stackMath`: N=10/W=5 시나리오 — 아래로 연속 스크롤 정상상태(위1/아래3),
  위로 정상상태(위3/아래1), 양 끝 고정, 점프 클램프, N<5 전부 표시,
  N=1, broken 스킵과 윈도우 독립성.
- `parser`: prefix 유효/무효 케이스, 다중 체크박스 라인, digits 오프셋
  (prefix 있는 라인에서 높이 쓰기백 좌표 검증), marks 포함 prefix.
- 브라우저 스모크 (fake host mode, 네트워크 차단): 윈도우 슬라이드,
  배지 숫자, 더블탭 열기, ctrl+wheel, prefix 트리거, 애니메이션 동작.
