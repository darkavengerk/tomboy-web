# 리스트 마커 체크박스/라디오 설계 (`[[ ]]` / `(( ))`)

날짜: 2026-06-12
상태: 승인됨

## 목표

리스트 항목 시작에서 `[[ ]]`(또는 `[[x]]`) / `(( ))`(또는 `((o))`)를 입력하면
그 항목의 불릿 표시를 **항목 단위** 체크박스 / 라디오 버튼으로 교체한다.
기존 `체크리스트:` 영역(헤더 단위로 켜지는 li-체크박스)과 독립적으로 공존한다.

## 배경 — 현재 구현

- **인라인 atom** (`lib/editor/inlineCheckbox/`, `inlineRadio/`): `[ ]`/`[x]`,
  `( )`/`(o)` → 텍스트 중간 인라인 노드. 불릿은 그대로 남는다.
- **체크리스트 영역** (`lib/editor/checklist/`): `체크리스트:` 문단 + 연속
  bulletList 영역의 모든 li에 데코레이션(불릿 숨김 + 위젯). 상태는
  `listItem.attrs.checked`. 항목 단위로는 못 켠다.
- **XML 마커** (`noteContentArchiver.ts`): 영역 li는 `[[ ]] `/`[[X]] `로
  직렬화. 인라인 체크박스 InputRule이 lookbehind `(?<!\[)`로 `[[ ]]`를
  일부러 무시 → 에디터에서 `[[ ]]` 입력은 무반응 (입력 경로 부재).
- **충돌**: 인라인 라디오 InputRule에는 lookbehind가 없어 `(( ))` 타이핑
  중간에 `( )` 부분이 인라인 라디오로 먼저 변환된다.

## 확정 요구사항

| 항목 | 결정 |
|---|---|
| 범위 | 독립 항목 단위 — 아무 리스트에서나; 기존 체크리스트: 영역과 공존 |
| 라디오 그룹 | 같은 bulletList 직계 형제끼리만 상호배타; 중첩 리스트는 별도 그룹 |
| 해제 | 항목 내용 맨 앞에서 Backspace → 일반 불릿 복원 |
| Enter | 같은 종류 상속, 체크 상태는 미체크로 리셋 |
| 체크 변형 입력 | `[[x]]`/`[[X]]`, `((o))`/`((O))` → 체크/선택된 상태로 생성 |

## 설계

### 1. 데이터 모델 (`lib/editor/extensions/TomboyListItem.ts`)

```ts
boxKind: { default: null, rendered: false }   // 'checkbox' | 'radio' | null
checked: { default: false, rendered: false, keepOnSplit: false }  // 기존 attr에 keepOnSplit 추가
```

- 라디오 선택 상태도 `checked` 재사용 (attr 하나로 통일).
- TipTap 3 `splitListItem`은 `keepOnSplit`을 따른다 — `boxKind`는 기본값
  (true)으로 상속, `checked`는 false 리셋. **커스텀 Enter 키맵 불필요.**
- 부수 효과(의도됨): 체크리스트 영역에서도 체크된 항목 Enter 시 새 항목이
  미체크로 시작 (기존엔 체크 상태가 상속되던 자잘한 버그).

### 2. 입력 규칙 — 신규 모듈 `lib/editor/listBox/`

- InputRule `^\[\[([ xX])\]\]$` → `boxKind='checkbox'` (+`checked`),
  `^\(\(([ oO])\)\)$` → `boxKind='radio'` (+`checked`). 매치 텍스트 삭제.
- 발화 조건: 커서가 **listItem 첫 문단의 블록 시작부터 친 텍스트**일 때만
  (li 안 + 첫 문단 + 블록 시작 anchored). 일반 문단에서는 무반응.
- 체크리스트: 영역 / 프로세스 스테이지 리스트 안에서는 발화하지 않는다
  (그 영역은 기존 의미론이 소유; `findChecklistRegions` /
  `findProcessBlocks`로 막판 멤버십 확인 — 발화 빈도가 낮아 비용 무시 가능).
- **선행 수정**: `inlineRadio`의 InputRule·paste 정규식에
  `(?<!\()` … `(?!\))` 추가 — 인라인 체크박스가 `[[ ]]`에 대해 이미 쓰는
  정책과 동일. 이것 없이는 `(( ))` 타이핑이 인라인 라디오로 샌다.

### 3. 렌더링 — 데코레이션 플러그인 (체크리스트 패턴 재사용)

새 플러그인(`lib/editor/listBox/plugin.ts`)이 doc 스캔, `boxKind` 있는 li에:

- **체크박스**: 기존 `tomboy-checkbox-item` 노드 클래스(불릿 숨김 + 체크 시
  직계 문단 흐림) + `buildCheckbox` 위젯 재사용. 토글은 기존
  `toggleCheckboxAt`.
- **라디오**: 새 `tomboy-radio-item` 클래스(불릿 숨김, **흐림 없음** —
  선택이지 완료가 아님) + 원형 위젯 `tomboy-radio-box`(`is-selected`).
  클릭 → `toggleRadioAt`: 같은 리스트 직계 형제 라디오 해제 + 자신 선택;
  선택된 것 재클릭 → 해제 (none-selected 허용, 인라인 라디오와 동일 규칙).
- 체크리스트: 영역·프로세스 스테이지 리스트는 스캔 제외 (이중 위젯 방지).
- CSS는 `TomboyEditor.svelte`의 기존 체크리스트 블록 옆에 추가.

### 4. 해제 — Backspace 키맵

커서가 boxKind li 첫 문단 시작(parentOffset 0, 빈 선택)이면 Backspace →
`boxKind: null`, `checked: false`로 일반 불릿 복원, handled. 그 외는 기존
리스트 Backspace 체인으로 폴스루.

### 5. XML 라운드트립 (`noteContentArchiver.ts`)

- **직렬화** (`serializeListItem`): 영역 마커(`markerAt`)가 **우선**. 영역
  마커가 없을 때만 attr 기반 per-item 마커:
  - `boxKind='checkbox'` → `[[ ]] ` / `[[X]] ` (기존 문법 재사용)
  - `boxKind='radio'` → `(( )) ` / `((O)) ` (신규 문법; `(`/`)`는 XML-safe)
- **파싱**: 체크리스트 영역 패스 → 프로세스 패스 후 **전역 패스 추가** —
  두 패스가 소비하지 않은 리스트의 li 첫 문단 머리 마커를 떼고
  `boxKind`+`checked` 설정. 영역 안 li는 기존대로 `checked`만 (boxKind 없음).
- 아카이버 인라인 3-pass 분할의 라디오 정규식에도 §2와 동일한
  lookbehind/lookahead 추가 — `(( ))` 마커가 인라인 라디오로 쪼개지지 않게.
- Tomboy 데스크탑에서는 마커가 일반 텍스트로 보인다 (체크리스트 영역
  마커와 동일한 기존 트레이드오프).
- 주의: 영역 그룹핑 구현이 4곳이라는 기존 경고 주석(archiver 1108행 부근)에
  전역 패스 추가를 반영한다.

### 6. 부대 작업

- `copyFormatted.ts` 4종 직렬화기: 체크박스 li → Markdown `- [ ]`/`- [x]`
  태스크 문법; plain/structured는 `[ ] `/`[x] ` 접두. 라디오 →
  `( ) `/`(o) ` 접두 (Markdown 표준 부재 → 리터럴).
- 설정 → 가이드 editor 탭에 `<details class="guide-card">` 추가
  (CLAUDE.md 필수 요건: 문법, 해제법, Enter 상속, 라디오 그룹 규칙,
  체크리스트: 영역과의 차이).
- 스케줄 `extractUncheckedFromDoc`(체크리스트 영역 기반 시드)은 변경 없음 —
  영역 전용 유지.
- 클립보드 fidelity(`data-tomboy-slice`)는 attr이 슬라이스 JSON에 실려
  자동으로 보존됨 — 변경 불필요.

### 7. 테스트 (`app/tests/unit/` 미러 경로)

- 아카이버 왕복: 영역 밖 `[[ ]]`/`[[X]]`/`(( ))`/`((O))` ↔ attr;
  영역 우선순위(영역 안은 boxKind 미설정); 기존 영역·프로세스 회귀 없음;
  마커가 인라인 atom으로 안 쪼개지는지.
- InputRule: li 첫 문단 시작에서만 발화; 일반 문단/영역 안 무반응;
  `(( ))` 타이핑이 인라인 라디오로 새지 않는지; 체크 변형 입력.
- 라디오 상호배타: 직계 형제만, 중첩 리스트 독립, 재클릭 해제.
- Backspace 해제, Enter 상속(boxKind 유지 + checked 리셋).
- 인라인 라디오 회귀: `( )`/`(o)` 단독 입력은 여전히 동작.
- `new Editor(...)` 쓰는 테스트는 afterEach에서 destroy 필수
  (teardown flake 방지 — ff9f04f 참조).

## 범위 밖 (명시)

- 체크리스트: 영역 기능의 대체/마이그레이션 — 두 메커니즘 공존.
- 스케줄 시드의 standalone 항목 인식.
- 우클릭 컨텍스트 메뉴 항목 추가 (Backspace로 충분).
