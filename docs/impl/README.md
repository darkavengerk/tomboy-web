# 구현 참고 문서 (TDD)

`docs/plan-ux-improvements.md`에서 확정된 9단계의 세부 구현 가이드.
각 문서는 **테스트 먼저 → 구현 → 리팩터/수동확인** 순서(TDD 사이클)를 따른다.

## 공통 규칙

- 각 단계의 **"Red" 섹션에 나열된 테스트부터 작성**한다. 테스트가 실패하는 것을 확인한 뒤(구현 0%) 다음 섹션으로 이동.
- 테스트는 `app/tests/unit/**/*.test.ts` 네이밍을 따른다. 기존 예시: `tests/unit/syncManager.test.ts`.
- 컴포넌트 UI 테스트는 vitest + jsdom + `@testing-library/svelte` (미도입 — 필요 시 각 단계에서 도입 메모).
- 단위 테스트가 어려운 영역(실제 TipTap 편집 동작, 실제 Dropbox I/O)은 **수동 확인 체크리스트**로 대체한다. 문서에 명시.
- Svelte 5 runes 규칙 유지. UI 문자열은 한국어.
- 모든 커밋은 **Red(실패) → Green(통과) → Refactor** 단위로 쪼개 남긴다. 한 커밋에 테스트와 구현을 같이 넣지 않는다.

## 순서 (의존 관계)

| # | 파일 | 요약 | 선행 |
|---|------|------|------|
| 1 | [01-empty-stub-fix.md](./01-empty-stub-fix.md) | 내부 링크 스텁 생성 방지 + 토스트 | — |
| 2 | [02-app-settings-store.md](./02-app-settings-store.md) | `appSettings` IDB 스토어, DB v3 | — |
| 3 | [03-note-action-sheet.md](./03-note-action-sheet.md) | 노트 액션 바텀시트 (삭제/다시받기) | 2 |
| 4 | [04-scroll-restoration.md](./04-scroll-restoration.md) | 목록 캐시 + 스크롤 복원 | — |
| 5 | [05-notebooks.md](./05-notebooks.md) | 노트북(카테고리) 핵심 | 3 |
| 6 | [06-per-note-category.md](./06-per-note-category.md) | 노트 화면의 노트북 표시/변경 | 3, 5 |
| 7 | [07-favorite-and-home.md](./07-favorite-and-home.md) | 즐겨찾기(pinned), 홈 노트 지정 | 2, 3 |
| 8 | [08-tab-navigation.md](./08-tab-navigation.md) | 4탭 하단 네비 + 정렬 + 랜덤 | 5, 7 |
| 9a | [09a-sync-plan-preview.md](./09a-sync-plan-preview.md) | `computePlan` + 읽기전용 미리보기 | — (독립) |
| 9b | [09b-sync-plan-selection.md](./09b-sync-plan-selection.md) | 체크박스 선택 + 충돌 해결 | 9a |
| 10 | [10-global-navigation.md](./10-global-navigation.md) | 전역 상단 네비 통합 + 하단 탭 제거 + 실제 뒤/앞으로 | 8(대체) |

## 문서 템플릿

각 단계 문서는 다음 섹션으로 구성된다.

1. **목표** — 한 줄.
2. **완료 조건(Acceptance)** — 외부에서 관찰 가능한 체크리스트.
3. **선행 / 영향 범위** — 의존 단계, 건드리는 파일.
4. **Red: 작성할 테스트** — `it(...)` 문안 리스트와 샘플 테스트 코드.
5. **Green: 구현 포인트** — 필요한 최소 코드 스니펫/시그니처.
6. **Refactor / 엣지케이스** — 놓치지 말아야 할 항목.
7. **수동 확인 체크리스트** — 브라우저에서 실제로 확인할 것.

## 공통 헬퍼 / 미정 결정

- **테스트 라이브러리 도입**: 컴포넌트 렌더 테스트는 3단계(#3 액션 시트)부터 필요. 이 시점에 `@testing-library/svelte` + `@testing-library/user-event` 추가한다.
- **IDB 테스트**: `fake-indexeddb` 도입을 2단계에서 함께 결정. (현재 `noteStore` 계열은 순수 함수 위주라 별도 테스트 없음 — 새 스토어 추가 시 추가.)
- **토스트 컴포넌트**: #1에서 최소 구현. 이후 단계들이 재사용.
