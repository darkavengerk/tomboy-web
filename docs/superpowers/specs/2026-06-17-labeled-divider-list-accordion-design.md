# 제목 수평선 리스트 아코디언 (labeled-divider list accordion)

날짜: 2026-06-17

## 목표

리스트가 커지면 한눈에 보기 어렵다. 여러 리스트를 한 노트에 두고
**한 번에 한 리스트만** 펼쳐 보기 위한 기능. 제목이 달린 수평선
(`텍스트 ---`, 이하 **제목 수평선**) 바로 아래에 리스트가 올 때, 그
수평선을 클릭하면 그 리스트만 남고 같은 그룹의 다른 리스트는 접힌다.

## 배경 — 기존 자산

- **`labeledDivider` 플러그인** (`app/src/lib/editor/labeledDivider/`)
  은 이미 `텍스트 ---`(left) / `-- 텍스트 --`(center) 를 라벨 달린
  꾸밈선으로 렌더한다. **decoration-only, 접기 없음.** 새 기능은 여기에
  아코디언 접기를 얹는다.
- 제목 수평선은 `isDashParagraph`(순수 `-{3,}` 만 매치) 가 **아니다**.
  따라서 기존 `---` 의 분할(hrSplit) / 섹션 접기(hrFold) ordinal 공간과
  **완전히 분리**되어 있다. 새 아코디언은 그 위에 평행하게 얹히는
  독립 시스템이다.
- 리스트 노드 타입명 = `bulletList` / `orderedList`.
- 플러그인 등록·영속 패턴은 `hrFold`(`hrFoldPlugin.ts` +
  `hrFoldStore.ts` + `TomboyEditor.svelte` 의 Extension 래퍼 / onChange
  영속 / 노트 로드 시 `replace` meta)를 그대로 따른다.

## 모델

### 그룹 (mutual-exclusion 범위)

순수 `---` HR 마커가 그룹 경계다. 노트는 `---` 들에 의해 여러 영역으로
나뉜다:

- 영역 0: 헤더(앞 2줄) 다음 ~ 첫 `---` 전
- 영역 k: k번째 `---` 다음 ~ (k+1)번째 `---` 전
- 마지막 영역: 마지막 `---` 다음 ~ 문서 끝

각 영역이 **독립 아코디언 그룹**이다. `---` 경계를 넘어 서로 영향을 주지
않는다. (`---` 가 하나도 없으면 노트 전체가 한 그룹.)

### 멤버 / 접기 단위

- **멤버** = 제목 수평선(라벨 디바이더 문단) 중 **바로 다음 top-level
  블록이 리스트(`bulletList`/`orderedList`)인 것.**
- 그 수평선이 **소유**하는 접기 대상 = 직후의 **연속 리스트 블록 런**
  (보통 1개). 리스트 런이 끝나는 곳(다음 문단/수평선/`---`/끝)까지.
- **리스트만 접는다.** 수평선 자체, 그리고 리스트 뒤의 비-리스트 블록은
  절대 숨기지 않는다. 숨김 = 리스트 블록에 `display:none` 클래스.
- **비멤버** = 다음 블록이 리스트가 아닌 제목 수평선 → 접기 UI 없음.
  지금처럼 평범한 꾸밈선으로만 렌더.

### 포커스 모델 (동작)

상태 = `focused: Set<number>` — 펼쳐서 "포커스"된 제목 수평선의 ordinal
집합. **불변식: 한 그룹당 최대 1개.**

ordinal = 헤더 제외 **모든** 라벨 디바이더(멤버/비멤버 무관)를 문서
순서로 센 인덱스. (멤버만 세면 리스트를 붙였다 뗄 때 후속 ordinal 이
흔들리므로, 모든 라벨 디바이더 기준으로 번호를 매겨 안정성을 높인다.)

**렌더 규칙** — 그룹 g, 그 그룹의 포커스 ordinal `f`(없으면 null),
그룹의 멤버 수 `n`:

- `n < 2` → 접기 UI 없음, 모든 리스트 보임. (리스트 여럿이 아니면
  "하나만 보기"가 의미 없음. 외톨이 리스트는 접지 않는다.)
- `n >= 2` → 멤버 m 의 리스트는 **`f !== null && m !== f` 일 때만 숨김.**
  - `f === null`(기본/미상호작용) → 그룹의 **모든 리스트 보임**.
  - `f === m` → m 보임, 같은 그룹의 다른 멤버 리스트 숨김.

**토글 / 순환** — 멤버 m 클릭. 그룹 g 의 멤버를 ordinal 오름차순으로
`m_0 < m_1 < … < m_{k-1}`, 현재 포커스 = `f`(없으면 null):

- `f === null`(기본, 다 펼침) → m 포커스. (m 만 보이고 형제 접힘.)
- `f !== null`, **`m === f`(현재 유일하게 열린 리스트를 닫음)** → 포커스가
  **그룹 내 다음 멤버로 순환 이동**. 즉 `f` 를 빼고 `next(f)` 추가
  (`next(m_{k-1}) = m_0`, 끝이면 처음으로 래핑). all-open 으로 돌아가지
  **않는다** — 항상 정확히 하나가 열려 있는 상태가 유지된다.
- `f !== null`, `m !== f`(닫힌 멤버 클릭) → 그 멤버로 점프(`f` 빼고 m 추가).

정리:
- **접기는 "펼침(포커스)" 으로만 트리거**된다. 로드·타이핑 등 다른 상황은
  무동작.
- 기본 상태(아무 멤버도 포커스 안 됨)에서는 **모든 리스트가 보인다** —
  작성 중 `제목 ---`+리스트를 타이핑해도 숨지 않는다.
- **all-open(포커스 없음)은 노트 로드 시의 초기 상태일 뿐**, 일단 한 멤버를
  포커스하면 클릭 제스처로는 all-open 으로 복귀하지 않는다. 포커스 모드에
  들어가면 닫기=다음 순환 / 다른 것 클릭=점프 로 항상 하나가 열려 있다.

### 제스처 / 버튼

- **버튼 전용 토글.** 수평선 오른쪽 끝에 작은 `+/−` 위젯 버튼. 위젯의
  `toDOM` 콜백이 살아있는 `EditorView` 를 받아 토글 meta 를 dispatch
  (hrFold 와 동일, 모듈 전역 상태 없음 → 데스크탑 다중 창 크로스토크 없음).
- **라인 plain-클릭 토글은 쓰지 않는다 / `handleClick` 없음.** hrFold 의
  `---` 마커는 편집할 실제 텍스트가 없어 라인 전체 클릭이 안전했지만,
  제목 수평선은 **라벨 텍스트가 편집 대상**이다. 라인 클릭을 토글로 쓰면
  라벨에 캐럿을 놓고 고칠 수 없게 된다(캐럿 트랩). 그래서 토글은 버튼만.
  Ctrl/Cmd 도 가로채지 않음(hrSplit 분할용).
- 버튼 글리프: 해당 멤버 리스트가 **보이면 `−`, 숨겨졌으면 `+`**. 기본
  상태에선 모든 멤버가 `−`(다 열림); 하나 클릭하면 그것만 `−` 유지,
  형제는 `+`. 포커스 모드에서 열린 `−` 를 누르면 `−` 가 다음 멤버로
  옮겨간다(순환). 항상 정확히 하나만 `−`.
- 접기 버튼은 **`n >= 2` 인 그룹의 멤버에만** 붙는다.

### 상호배제 — hrSplit 분할

hrSplit 분할이 활성(`activeOrdinals.size > 0`)이면 그리드 배치가 모든
블록 visible 을 가정한다. 숨긴 리스트는 엉뚱한 열에 떨어지고 divider 높이
측정을 오염시킨다. 따라서 **분할 활성 중엔 이 플러그인이 데코를 전부
끈다**(버튼·숨김 클래스 없음, 모든 리스트 펼쳐 보임). 포커스 상태는
보존(inert)되고 분할 해제 시 복귀. hrFold 의 split-inert 규칙을 그대로
미러.

### hrFold(`---` 섹션 접기)와의 관계

독립. 저장 키도 ordinal 공간도 다르다. `---` 섹션이 접히면 그 안의
라벨 디바이더·리스트는 hrFold 의 `display:none` 으로 이미 숨는다 —
아코디언 클래스는 무의미해지지만 충돌 없음(둘 다 클래스만 추가).

### 모바일

게이트 없음 — hrFold 처럼 모바일/데스크탑 모두 동작. (큰 리스트를
다루는 기능이라 모바일에서 특히 유용.)

## 컴포넌트

`app/src/lib/editor/labeledDivider/` 에 추가:

1. **`assignAccordion.ts`** — 순수 함수. 입력: 헤더 제외 top-level
   블록 descriptor 배열 `{ isHr; isLabeledDivider; isList }`. 출력: 각
   라벨 디바이더에 대해 `{ ord, group, isMember, listIndices }` + 그룹별
   멤버 수. `assignSections.ts` 처럼 순수·빡세게 테스트 가능.
2. **`labeledFoldPlugin.ts`** — ProseMirror 플러그인.
   - state `focused: Set<number>`, meta `toggle(ord)` / `replace(set)`.
   - apply: 토글 시 그룹당-1 불변식 유지; `replace` 는 노트 로드;
     `docChanged` 시 reconcile(범위 밖 / 더 이상 멤버 아닌 ordinal 제거,
     그룹당 ≥2 위반 시 첫 포커스만 유지).
   - decorations: 멤버 수평선에 `+/−` 위젯 버튼; 숨길 리스트 블록에
     `.tomboy-labeled-fold-hidden`.
   - props: `decorations` 만(split 활성 시 null). `handleClick` 없음 —
     토글은 위젯 버튼의 click 핸들러가 dispatch.
   - 라벨 디바이더 판별 = `parseLabeledDivider`, `---` 판별 =
     `isDashParagraph`, 리스트 판별 = node.type.name, 헤더 스킵 =
     `HEADER_COUNT`(hrSplitPlugin 재사용).
   - `onChange` 콜백으로 영속.
3. **`labeledFoldStore.ts`** — per-guid `localStorage`
   `tomboy.labeledFold.<guid>`. `loadFocusedOrdinals`/`saveFocusedOrdinals`.
   비동기화·XML 아님. `hrFoldStore.ts` 미러.
4. **`TomboyEditor.svelte`** — `tomboyLabeledFold` Extension 등록(기존
   `tomboyLabeledDivider` 옆); CSS `.tomboy-labeled-fold-btn`(+`-folded`) /
   `.tomboy-labeled-fold-hidden`; 노트 로드 시 `replace` meta(hrFold 의
   두 reseed 지점 ~1297/~1337 패턴, 두 곳 모두); onChange →
   `saveFocusedOrdinals(lastAppliedGuid, …)`.
5. **설정 → 가이드 카드** — `app/src/routes/settings/+page.svelte`
   `guideSubTab: editor` 에 `<details class="guide-card">` 추가
   (CLAUDE.md 필수). 기존 labeled-divider 카드가 있으면 그 근처/그 안에
   아코디언 동작 설명 추가.

## 테스트

`app/tests/unit/editor/` 에:

- `labeledFoldAccordion.test.ts` — `assignAccordion` 순수 로직: 그룹
  분할(`---` 경계), 멤버/비멤버 판정(다음 블록 리스트 여부), 연속 리스트
  런, 그룹별 멤버 수, ordinal 번호, 엣지(헤더 경계 / 외톨이 멤버 /
  리스트 없는 라벨 디바이더 / `---` 만 / 빈 그룹).
- `labeledFoldStore.test.ts` — 영속 round-trip.
- `labeledFoldPlugin.test.ts` — 실제 TipTap Editor 로 데코 출력, 토글
  의미(기본 전체 보임 / 포커스 시 형제만 숨김 / 열린 것 닫기 = 다음
  멤버 순환·끝→처음 래핑 / 닫힌 멤버 클릭 = 점프), 그룹 간 독립(한 그룹
  순환이 다른 `---` 그룹 안 건드림), `n<2` 무-UI, split-active inert.
  토글 의미는 plugin state 의 `apply`(toggle meta) 를 직접 호출해 검증
  (DOM 버튼 클릭 대신 meta dispatch).

## 불변식 (요약)

- 제목 수평선은 `---` ordinal 공간과 분리된 별도 시스템.
- 그룹 = `---` 경계. 그룹당 포커스 ≤ 1.
- 리스트**만** 숨김. 수평선·기타 블록 불변.
- 접기 트리거 = **펼침(포커스)뿐.** 그 외 무동작.
- 포커스 모드에선 항상 그룹당 1개 열림. 열린 것 닫기 = 다음 멤버로 순환
  (끝→처음). all-open 은 로드 초기값일 뿐 클릭 복귀 없음.
- 접기 UI = 멤버 ≥2 그룹에만.
- 영속 = per-guid localStorage, 비동기화, XML 불변.
- 분할 활성 중 inert.
- decoration-only — DOM 재구조화 없음(NodeView/래퍼 금지, hrsplit 스킬
  불변식 준수).
