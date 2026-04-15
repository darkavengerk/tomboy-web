# 11 — new_implements_spec.md 진행 추적

`docs/new_implements_spec.md`의 항목들을 TDD로 차근차근 구현하면서 상태를 기록한다. 세션이 끊기면 이 문서를 보고 이어서 작업.

## 작업 원칙

- 각 항목: **실패 테스트 작성 → (서브에이전트) 구현 → `npm run test`/`npm run check` 통과 → CLAUDE.md 갱신 → 본 문서의 체크박스 업데이트 → 커밋**.
- 테스트 작성과 계획 문서는 메인 세션이 직접, 실제 코드 구현은 서브에이전트(`Agent` 도구) 위임.
- 모든 UI 문자열 한국어 유지.

## 사용자 결정 (Q&A 요약)

1. **부제 줄**: 본문 *첫 paragraph 하나*에만 작은 폰트/줄높이 적용. 저장 형식(`.note` XML) **변경 없음**, 스타일만.
2. **항상 위(데스크탑)**: `lib/desktop/session.svelte.ts`의 윈도우 z-order에서 핀된 윈도우는 항상 다른 윈도우들 위. UI는 타이틀바 토글 버튼.
3. **상하좌우 리사이즈**: `NoteWindow` + `SettingsWindow` 모두 8방향(상/하/좌/우 + 4모서리) 핸들. 모바일은 그대로.
4. **우클릭 메뉴 데스크탑**: 항목 = 잘라/복사/붙여, 형식 복사(HTML / plain / Markdown), 날짜 삽입, 리스트로 만들기, 깊이 ↑/↓, 링크 열기.
5. **마우스 가운데 버튼 → 가장 뒤로**: "현재 열려있는 노트들 중에서 가장 낮은 z-index". 즉, 핀된 윈도우 그룹은 별도 — 핀이 안 된 일반 노트들만 비교 대상으로.
6. **Tab vs Alt 깊이**: Tab/Shift+Tab은 기존(자식 포함) 동작 유지. **Alt+←/→ 만** 선택 항목만 sink/lift.
7. **형식 복사**: HTML, plain text, Markdown 3종.

## 단계 (제안된 순서)

진행 순서: 격리도 높고 위험 낮은 것부터 → 시스템에 영향이 큰 것 순.

| #  | 항목                                    | 상태       | 비고 |
|----|-----------------------------------------|------------|------|
| 0  | 스킬 추출 + CLAUDE.md 슬림화            | ✅ 완료    | `tomboy-graph`, `tomboy-admin`, `tomboy-autolink` |
| 1  | 날짜 삽입 (Ctrl+D)                      | ✅ 완료    | `yyyy-mm-dd`. 우클릭 메뉴는 단계 5에서 |
| 2  | Alt+←/→ 리스트 깊이 (선택만)            | ✅ 완료    | Tab 동작은 유지. 16개 엣지케이스 통과 |
| 3  | 부제 줄 스타일                          | ✅ 완료    | `.tiptap > p:nth-child(2)` 작은 폰트/muted 색 |
| 4  | 데스크탑 툴바 높이 미세조정              | ✅ 완료    | `@media (pointer: fine)` 로 버튼 28px/패딩 축소 |
| 5  | 데스크탑 우클릭 커스텀 메뉴              | ✅ 완료    | EditorContextMenu + copyFormatted 22개 테스트 |
| 6  | NoteWindow 8방향 리사이즈                | ⏳ 대기    | SettingsWindow 동일 |
| 7  | 항상 위 / 가장 뒤로 (z-order)            | ⏳ 대기    | 핀 토글 + 가운데 클릭 |
| 8  | 형식 선택 복사 (HTML/plain/MD)           | ✅ 완료    | `copyFormatted.ts`에 구현, 메뉴로 노출 (단계 5와 함께) |

상태 표시: ⏳ 대기 / 🛠 진행중 / ✅ 완료 / ⛔ 막힘

## 단계별 세부 계획

### 1. 날짜 삽입 — `yyyy-mm-dd`

- **테스트 파일**: `app/tests/unit/editor/insertDate.test.ts`
- **테스트 케이스**:
  - `formatDate(new Date(2026, 3, 15))` → `'2026-04-15'` (월/일 zero-pad)
  - 0시·9시·12월 등 경계값
- **구현 위치**:
  - `lib/editor/insertDate.ts` — pure `formatDate` + TipTap command 헬퍼
  - `lib/editor/TomboyEditor.svelte` — Ctrl+D 키 바인딩 (`editor.commands.insertContent(formatDate(new Date()))`)
  - `lib/editor/NoteContextMenu.svelte` — 메뉴 항목 추가 ("오늘 날짜 삽입")
- **주의**: Ctrl+D는 브라우저 북마크 단축키 → `event.preventDefault()` 필수.

### 2. Alt+←/→ — 선택 li만 깊이 조정

- **테스트 파일**: `app/tests/unit/editor/listItemOnlySink.test.ts`
- TipTap `liftListItem`/`sinkListItem`은 자식까지 같이 움직임. 선택 항목만 분리하려면:
  - 자식 li들을 일시적으로 분리(`splitListItem` + 형제로 이동) 후 sink/lift 후 재결합 — 복잡.
  - 또는 ProseMirror transform으로 해당 li의 children 보존하면서 자기만 wrapping 변경.
- **테스트 케이스**:
  - `- A`/`  - B` 에서 A 선택 후 sink → `  - A`/`    - B` 가 아니라 `  - A`/`  - B` (B 깊이 유지)
  - lift도 동일 검증
- **단축키**: Alt+→ = sink-only, Alt+← = lift-only. Tab/Shift+Tab은 기존 유지.

### 3. 부제 줄 스타일

- **테스트 파일**: `app/tests/unit/editor/subtitleStyle.test.ts` (DOM 렌더링 검증)
- **구현**: `TomboyEditor` CSS — `.ProseMirror > p:first-of-type { font-size: 0.85em; line-height: 1.3; color: #666 }` 정도. **본문의 첫 paragraph**만이므로, `<note-content>` 안의 첫 자식이 첫 노드. (TipTap은 doc 전체가 ProseMirror; title은 별도라면 `:first-of-type`로 충분.) → 실제 구조 확인 후 selector 결정.
- 저장 시 스타일 attribute 들어가지 않게 `tomboy-size` 마크와 무관해야 함.

### 4. 데스크탑 툴바 높이

- 현재 `Toolbar.svelte` 높이를 측정 후 4–6px 줄임. 모바일 라우트에서는 변하지 않게 데스크탑 컨테이너 한정 selector.
- 테스트는 시각적이라 단순 CSS 변수 변경; 회귀 방지로 최소한의 unit test (computed style) 추가.

### 5. 데스크탑 우클릭 커스텀 메뉴

- 모바일은 `NoteContextMenu.svelte` 이미 존재. 데스크탑 NoteWindow에서 `contextmenu` 이벤트 hook → 메뉴 컴포넌트 표시.
- 항목: 잘라/복사/붙여, 형식 복사 ▸ HTML/plain/Markdown, 오늘 날짜 삽입, 리스트로 만들기, 깊이 ↑/↓ (Alt+← / Alt+→), 링크 열기.
- 테스트: 메뉴 표시 + 각 항목 클릭 시 editor command 호출 확인 (mock).

### 6. NoteWindow 8방향 리사이즈

- `dragResize.ts`에 핸들 종류 추가 (`'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'`).
- 위/왼쪽 리사이즈는 위치(top/left)도 같이 변경 — 테스트로 회귀 방지.
- 최소 width/height 클램프 유지.

### 7. 항상 위 / 가장 뒤로

- `session.svelte.ts`에 `pinned: Set<id>` 추가.
- z-order 정렬 시 pinned가 항상 unpinned보다 위.
- 가운데 클릭 핸들러: pinned가 아닌 윈도우들 중 최저값 - 1을 부여.
- 타이틀바에 압정 토글 버튼.

### 8. 형식 선택 복사

- `lib/editor/copyFormatted.ts` — TipTap JSON → `{ html, plain, markdown }`.
- Markdown 변환 범위: 단순 마크(굵게/기울임/취소선/링크/리스트/모노스페이스). Tomboy 사이즈 마크는 Markdown으로 표현 안 되므로 무시.
- 클립보드 API: `navigator.clipboard.write(new ClipboardItem({...}))` (HTML+plain) 또는 `writeText` (plain/MD).
- 컨텍스트 메뉴 ▸ "형식 복사" 서브메뉴.

## 변경 사항 누적 기록

- `2026-04-15`: 단계 0 완료. CLAUDE.md를 598 → 183줄로 슬림화. 세 개의 스킬 파일 추출. 본 문서 생성.
- `2026-04-15`: 단계 1 완료. `lib/editor/insertDate.ts` 추가, `TomboyEditor.svelte`에 Ctrl/Cmd+D 바인딩. 삽입된 날짜는 `tomboyDatetime` 마크로 감싸 Tomboy `<datetime>` 라운드트립 보존. 마크는 삽입 직후 해제되어 이후 타이핑은 plain. 테스트 7개 통과 (`tests/unit/editor/insertDate.test.ts`).
- `2026-04-15`: 단계 2 완료. `lib/editor/listItemDepth.ts`에 `sinkListItemOnly`/`liftListItemOnly` 추가. 알고리즘: sink 시 자식 li들을 먼저 부모 리스트의 형제로 분리(operated li 직후) 후 표준 sinkListItem; lift 시 자식 li들을 operated li 직전(부모 li 안)에 분리 후 표준 liftListItem. `TomboyEditor.svelte`의 handleKeyDown에 Alt+ArrowRight/Left 바인딩, 성공 시에만 preventDefault. Tab/Shift+Tab은 변경 없음. 테스트 16개 통과.
- `2026-04-15`: 단계 2 버그픽스. prev sibling X가 이미 중첩 리스트를 갖고 있을 때 자식 없는 A를 sink하면 A가 X의 기존 자식들을 "입양"하던 버그 수정. 회귀 테스트 3개 추가 (총 20개). round-trip 테스트는 자식 없는 leaf 케이스로 한정.
- `2026-04-15`: 단계 2 다중 선택 지원 추가. `findOperationRange(editor)` 헬퍼: `$from.sharedDepth($to.pos)` 에서 위로 걸어가 첫 리스트 노드를 찾고, `[startIndex..endIndex]`를 작업 범위로 반환. 단일 커서는 자연스럽게 `startIndex===endIndex`로 흡수됨. 선택 범위 내 비선택 중간 항목도 블록으로 함께 이동(표준 에디터 동작). 테스트 10개 추가 (총 30개), 전체 428개 통과.
- `2026-04-15`: 단계 2 선택 유지 + 추가 회귀 테스트. 범위 선택 후 Alt+←/→ 시 동일 논리 범위가 선택 상태로 유지(이전엔 단일 커서로 collapse 됐음). 각 operated 항목의 innerItems 내 인덱스를 트래킹해 paragraph 절대 위치를 재계산, `TextSelection.create(tr.doc, newFrom, newTo)` 로 범위 복원. 사용자 보고 swap 버그(`11111 / • 22222 / ○ 33333 / • 44444`에서 33333 lift 시 33333/44444 순서 뒤집힘) 재현 시도 — 커서 위치 4가지(시작/끝/중간 range/full name range), trailing empty paragraph 유무, 전체 확장 세트 포함 7개 시나리오 모두 통과, 재현 실패. 총 테스트 40개.
- `2026-04-15`: 단계 3+4+5(+8) 완료.
  - 단계 3: 본문 첫 paragraph(title)를 제외한 두 번째 paragraph에 작은 폰트/줄높이/muted 색 적용 (`TomboyEditor.svelte` CSS `.tiptap > p:nth-child(2)`). 저장 형식 변경 없음.
  - 단계 4: `Toolbar.svelte`에 `@media (pointer: fine)` 분기 추가. 데스크탑은 버튼 28px/패딩 축소, 모바일은 기존 44px 탭 타깃 유지.
  - 단계 5 + 8: `lib/editor/copyFormatted.ts`에 `tiptapToPlainText` / `tiptapToHtml` / `tiptapToMarkdown` / `copySelectionAsJson` 구현. `lib/editor/EditorContextMenu.svelte` 새 컴포넌트 — 잘라/복사/형식 복사(HTML/plain/MD 서브메뉴)/붙여/오늘 날짜/리스트로 만들기/깊이 ↑↓/링크 열기 9개 항목, ESC·외부 클릭 닫힘. `TomboyEditor.svelte`에 `enableContextMenu` prop 추가(기본 false, 모바일 영향 없음), `NoteWindow`만 true로 전달. 테스트 22개 추가. 전체 523개 통과.
- `2026-04-15`: 단계 2 NodeSelection 예외 버그 수정. 사용자의 "계속 에러가 나는데" 보고의 원인 — 리스트 항목 불릿 등을 클릭해 NodeSelection이 활성화된 상태에서 Alt+←/→ 를 누르면 `$to.index(listDepth)`가 범위 밖 값을 반환해 `parentList.child(i)` 에서 `Index N out of range` throw. `findOperationRange`에서 startIndex/endIndex를 `[0, childCount-1]` 로 clamp, `startIndex > endIndex` 시 swap, 빈 리스트는 `null` 반환. `TomboyEditor`의 keydown 핸들러도 강화: Alt+←/→ 는 항상 preventDefault (브라우저 기본 뒤로/앞으로 이동 방지), 내부 연산은 try/catch로 감싸 console.error만 남기고 전파 안 함. 엣지케이스 테스트 약 40개 추가 (NodeSelection, 3/4단계 중첩, ol/ul 혼합, 범위 경계, 반복 호출, 빈 항목, trailing paragraph 등). 총 테스트 86개, 전체 484개 통과.
