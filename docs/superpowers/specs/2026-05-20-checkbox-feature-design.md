# 체크박스(체크리스트) 기능 설계

- 날짜: 2026-05-20
- 상태: 설계 승인됨, 구현 계획 작성 중
- 갱신: 2026-05-20 — 구현 방식을 "아카이버 경계 마커 합성"으로 확정 (아래 9절).

## 1. 목적

노트 안에서 할 일 목록을 체크박스로 관리한다. `체크리스트:` 로 시작하는
헤더 줄 다음에 오는 리스트 항목들이 불릿 대신 클릭 가능한 체크박스로
표시되고, 클릭하면 완료/미완료가 토글된다. `Ctrl+P` 단축키로 체크리스트
블록을 빠르게 삽입할 수 있다.

기존 `TODO`/`Done` 영역 기능(`lib/editor/todoRegion/`)과는 **완전히 별개의
독립 기능**이다. 서로 감지 키워드가 다르고 동작도 겹치지 않는다.
체크박스 기능은 항목을 이동시키지 않고 제자리에서 상태만 토글한다.

## 2. 동작 모델

### 2.1 체크리스트 영역 감지

- 노트의 최상위 문단(제목 줄 제외) 중 `trim()` 한 텍스트가 `체크리스트:`
  로 **시작**하는 문단이 헤더다. 콜론은 필수이며, 콜론 뒤에 설명 텍스트가
  올 수 있다 (예: `체크리스트: 장보기`, `체크리스트: 2026 1분기 목표`).
- 헤더 문단 **바로 다음**에 오는 1개 이상의 연속된 `bulletList` 블록이 그
  영역의 리스트가 된다. `orderedList` 는 제외 — 아카이버(`serializeContent`)가
  최상위 `orderedList` 를 직렬화하지 않아 저장 시 내용이 사라지기 때문이다.
- 연속된 리스트 여러 개는 논리적으로 하나의 영역으로 묶는다.
- 헤더 다음에 리스트가 없으면 영역이 아니다 (그냥 일반 문단).
- 감지 구조는 기존 `todoRegion/regions.ts` 의 `findTodoRegions` 를
  그대로 미러링한다. 차이는 감지 정규식뿐: `/^체크리스트:/`.

### 2.2 체크리스트 항목

- 영역의 리스트 안에 있는 모든 `listItem` 이 체크리스트 항목이다.
  **중첩 항목 포함** — 깊이 제한 없이 재귀적으로 모두 체크박스가 된다.
  (todoRegion 은 깊이 1/2 만 다루지만, 체크박스는 단순 토글이라 깊이
  제한이 불필요하다.)

## 3. 데이터 모델 — 체크 상태 저장

체크 상태는 **두 가지 표현**을 가지며, `noteContentArchiver.ts` 가 둘
사이를 변환한다.

| 계층 | 표현 |
|------|------|
| 라이브 ProseMirror 문서 | `listItem` 노드의 `checked` 불리언 속성 |
| `.note` XML 파일 | 항목 첫 문단 본문 맨 앞의 4글자 텍스트 마커 |

마커 형식:

| 상태 | 마커 |
|------|------|
| 미체크 | `[ ] ` (대괄호, 공백, 대괄호, 공백) |
| 체크   | `[X] ` (대괄호, 대문자 X, 대괄호, 공백) |

- **라이브 문서에는 마커 텍스트가 없다.** 항목 문단 텍스트는 순수
  내용("우유 사기")뿐이고, 체크 여부는 `listItem.attrs.checked` 에 산다.
  덕분에 커서·선택·타이핑이 전부 평범한 리스트 항목과 동일하게 동작한다
  (마커 주변 커서 처리 같은 게 필요 없다).
- **`.note` XML 파일에는 마커 텍스트가 박힌다.** `serializeContent` 가
  체크리스트 영역 항목을 직렬화할 때 `checked` 값에 따라 `[ ] `/`[X] ` 를
  앞에 붙이고, `deserializeContent` 가 역으로 떼어내며 `checked` 를
  설정한다. 따라서 저장 파일을 열어 보면 `[X] 빨래 돌리기` 처럼 보이고,
  이는 사용자가 승인한 형식이다.
- 마커 파싱 정규식: `/^\[([ xX])\] /`. 캡처가 `x` 또는 `X` 면 체크 상태.
  읽을 때는 소문자 `[x]` 도 체크로 인정하고, 쓸 때는 항상 `[X]` 로
  정규화한다.
- 체크리스트 영역 **밖**의 일반 리스트 항목은 이 변환을 거치지 않는다.
  영역 밖에서 우연히 `[ ]` 로 시작하는 텍스트는 그대로 평문으로 둔다.

## 4. 화면 표시

- 체크리스트 영역의 `listItem` 은 리스트 불릿을 숨긴다 (`list-style: none`).
  ProseMirror 플러그인이 영역 안의 각 항목에
  `Decoration.node(liPos, liEnd, { class: 'tomboy-checkbox-item' })` 로
  클래스를 부여하고 CSS 에서 처리한다 (기존 todoRegion 패턴).
- 항목 첫 문단 시작 위치(`liPos + 2`)에 위젯 데코레이션으로 체크박스
  컨트롤(`<button>`)을 그린다. `checked` 속성에 따라 ☐/☑ 모양.
  `contenteditable="false"`, 클릭 시 토글. 위젯 빌더는 todoRegion 의
  `buildButton` 패턴을 미러링.
- 체크된 항목은 자기 문단 텍스트를 살짝 흐리게 표시한다
  (`li.tomboy-checkbox-item.is-checked > p { opacity: 0.6 }` — 직계 문단만,
  중첩 자식은 제외). **취소선은 적용하지 않는다.** — 요청대로
  "그냥 체크박스만".
- `체크리스트:` 헤더 문단 자체는 일반 텍스트로 둔다 (별도 스타일 없음).
- 마커 텍스트가 라이브 문서에 없으므로 **숨김·커서 처리가 전혀 필요 없다.**

## 5. 커서 동작

체크리스트 항목은 라이브 문서 기준으로 평범한 `listItem` 이다 (마커 텍스트
없음, `checked` 는 비표시 속성). 따라서 커서·선택·타이핑·Backspace·화살표가
일반 리스트 항목과 100% 동일하게 동작한다. 별도 처리 없음.

체크박스 위젯은 데코레이션이라 문서 위치를 차지하지 않는다 — 위젯 클릭은
`onToggle` 로만 흐르고 커서에 영향을 주지 않는다.

## 6. 자동 부착 ("자동으로 붙는")

- 어떤 `listItem` 이 체크리스트 영역 안에 있으면 **그 사실만으로** 체크박스
  위젯이 렌더링된다. 별도의 마커 삽입 트랜잭션이 없다 — 렌더링은 영역
  소속 여부에서 순수하게 파생된다.
- 따라서 영역 안에서 Enter 로 새 항목을 만들면 즉시 체크박스가 되고,
  항목을 붙여넣어도 마찬가지다.
- `.note` 파일 쪽 "자동 부착"은 저장 시점에 일어난다: `serializeContent`
  가 영역 항목마다 `[ ] `/`[X] ` 를 붙이므로, `체크리스트:` 아래에
  마커 없이 직접 타이핑한 기존 항목도 다음 저장 때 파일에서 마커를
  얻는다 (`checked` 기본값 false → `[ ] `).

## 7. 단축키 `Ctrl+P`

- 커서가 있는 최상위 블록 다음에 `체크리스트:` 문단 + 항목 하나짜리
  `bulletList` 를 삽입하고, 커서를 그 항목 안에 둔다.
- 커서가 빈 비제목 문단에 있으면 그 문단을 대체한다 — 기존
  `insertTodoBlock`(Ctrl+O)의 "빈 줄을 블록으로 바꾸기" 동작을 미러링.
- 브라우저 기본 인쇄 단축키(Ctrl/Cmd+P)는 `event.preventDefault()` 로
  막는다 — `TomboyEditor` 의 `handleKeyDown` Ctrl/Cmd 스위치에
  `case "p"` 추가.

## 8. 파일 구성

기존 `todoRegion/` 과 `autoWeekday/` 구조를 미러링한다.

신규:

- `app/src/lib/editor/checklist/regions.ts` — `isChecklistHeaderText`,
  `findChecklistRegions(doc)`, `findChecklistItems(regions)`,
  `findChecklistItemAt`. 순수 함수, 단위 테스트 대상.
- `app/src/lib/editor/checklist/plugin.ts` — ProseMirror 플러그인:
  영역 항목마다 불릿 숨김 노드 데코 + 체크박스 위젯 데코를 그린다.
  문서를 변형하지 않는 데코레이션 전용 플러그인.
- `app/src/lib/editor/checklist/commands.ts` — `toggleCheckboxAt(editor,
  liPos)` (`checked` 속성 토글), `insertChecklistBlock(editor)` (Ctrl+P).
- `app/src/lib/editor/checklist/index.ts` — `TomboyChecklist` Extension
  + 재export.

수정:

- `app/src/lib/editor/extensions/TomboyListItem.ts` — `checked` 스키마
  속성 추가 (`default: false`, `rendered: false`).
- `app/src/lib/core/noteContentArchiver.ts` — 직렬화 시 체크리스트 영역
  항목에 마커를 붙이고, 역직렬화 시 떼어내며 `checked` 를 설정.
- `app/src/lib/editor/TomboyEditor.svelte` — `TomboyChecklist` 확장 등록,
  `handleKeyDown` 에 `Ctrl+P` 케이스 추가, 체크리스트 CSS 추가.

테스트 (`app/tests/unit/editor/`, 기존 테스트 평면 배치 관례):

- `checklistRegions.test.ts` — 영역/항목 감지, `checked` 속성 읽기.
- `checklistArchiver.test.ts` — XML↔JSON 마커 합성 라운드트립.
- `checklistPlugin.test.ts` — 데코레이션 렌더, 위젯 클릭→onToggle.
- `checklistCommands.test.ts` — `toggleCheckboxAt`, `insertChecklistBlock`.

## 9. 구현 방식 결정 — 아카이버 경계 마커 합성 (채택됨)

브레인스토밍 단계에서는 마커를 라이브 PM 문서 안의 실제 텍스트로 들고
화면에서 `display: none` 으로 숨기는 방식을 1안으로 두었다. 그러나 구현
계획 작성 중, 숨긴 텍스트와 PM 커서의 상호작용(화살표 트랩, Backspace,
마커 앞 타이핑이 마커를 깨뜨림)이 견고한 계획으로 풀기 어렵다고 판단해
**마커를 `listItem.checked` 속성으로 들고 아카이버 경계에서 텍스트로
합성하는 방식**을 채택했다.

장점:

- 라이브 문서가 깨끗해 커서·편집이 평범한 리스트와 동일 — 특수 처리 0.
- 렌더링이 "영역 소속 여부 + `checked` 속성"에서 순수 파생 — 마커 삽입
  트랜잭션 불필요.
- 토글이 `setNodeMarkup` 한 번 — 텍스트 치환 없음.

비용:

- `noteContentArchiver.ts` 에 체크리스트 영역 인지 + 마커 합성 로직이
  들어간다. 직렬화/역직렬화 양쪽에 영역 감지가 필요하다.
- 완화책: 마커 합성은 순수 함수로 격리하고 XML↔JSON 라운드트립 테스트로
  강하게 보증한다 (`checklistArchiver.test.ts`).

사용자가 보는 결과(`.note` 본문의 `[ ]`/`[X]`, 화면의 깔끔한 체크박스,
양쪽 웹 모드 동일)는 1안과 9안이 완전히 같다.

## 10. 범위 밖 (YAGNI)

- 체크 시 항목 이동·정렬 (그건 기존 `TODO`/`Done` 영역 기능의 역할).
- 별도의 "완료" 영역, 진행률(n/m) 표시.
- `.note` XML 에 커스텀 태그/속성 추가 (마커는 평범한 텍스트로만 박힌다).
- 완료 항목 취소선.
- 체크박스 영역 외(일반 리스트)에서의 체크박스.

## 11. 불변식 / 주의

- 기존 `todoRegion` 기능은 일절 건드리지 않는다. 두 기능은 감지 키워드
  (`TODO`/`Done` vs `체크리스트:`)가 달라 한 노트에서 공존 가능하다.
- `체크리스트:` 영역 항목의 XML 직렬화/역직렬화는 반드시 짝이 맞아
  XML→JSON→XML 이 바이트 동일해야 한다 — 라운드트립 테스트가 게이트.
- 영역 밖의 일반 리스트는 마커 변환을 거치지 않으므로 라운드트립이
  종전과 동일하게 유지된다.
- 모든 UI 문자열은 한국어 (CLAUDE.md 관례).
- `autoWeekday` 와 무간섭: autoWeekday 는 `N월` 헤더 아래에서만 동작하며
  `체크리스트:` 영역과 겹치지 않는다.
