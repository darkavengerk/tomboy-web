# 인라인 라디오/체크박스 삽입 단축키 (Alt+R / Alt+C)

날짜: 2026-06-02
상태: 승인됨

## 목표

본문에 인라인 라디오(`( )`)와 인라인 체크박스(`[ ]`) atom을 키보드 단축키로 삽입한다.
현재는 `( )` / `[ ]`를 직접 타이핑해야 InputRule이 atom으로 변환해 주는데, 단축키로
한 번에 삽입할 수 있게 한다.

- **Alt+R** → 인라인 라디오 (미선택 상태) 삽입
- **Alt+C** → 인라인 체크박스 (미체크 상태) 삽입

## 동작

- 커서 위치에 atom 하나를 삽입한다 (선택지 1: 가장 단순한 형태, 공백/라벨 자동 추가 없음).
- 제목 줄(top-level index 0)에서는 삽입을 거부한다 — InputRule의 제목 차단 정책과 동일.
- 삽입 후 커서는 atom 바로 뒤에 위치한다 (이어서 라벨 타이핑 가능).

## 키 판별 방식

`event.code === "KeyR"` / `"KeyC"` 사용 (물리 키 기준).

이유:
- macOS에서 Option+R/C는 `event.key`가 `®`/`ç`로 변형됨 → `event.key` 비교 실패.
- 한글 IME 모드에서 `event.key`가 자모(`ㄱ`/`ㅊ`)로 올 수 있음.
- CapsLock 상태와 무관.

같은 이유로 기존 Alt+J(각주) / Alt+P(프로세스 블록)의 `event.key` 비교도
`event.code === "KeyJ"` / `"KeyP"`로 통일한다 (동작 변화 없음).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/inlineRadio/index.ts` | `insertInlineRadio(editor)` 헬퍼 export |
| `app/src/lib/editor/inlineCheckbox/index.ts` | `insertInlineCheckbox(editor)` 헬퍼 export |
| `app/src/lib/editor/TomboyEditor.svelte` | handleKeyDown Alt 섹션에 KeyR/KeyC 와이어링 + 기존 KeyJ/KeyP 통일 |
| `app/src/routes/settings/+page.svelte` | 단축키 탭 "삽입" 테이블에 Alt+R / Alt+C 두 줄 추가 |
| `app/tests/unit/editor/inlineRadio/node.test.ts` | 헬퍼 테스트 추가 |
| `app/tests/unit/editor/inlineCheckbox/node.test.ts` | 헬퍼 테스트 추가 |

## 테스트

각 헬퍼에 대해:
1. 본문 커서 위치에 미선택/미체크 atom이 삽입된다.
2. 제목 줄에서는 삽입이 거부된다 (문서 불변).
3. 삽입된 atom 의 attrs 가 `selected: false` / `checked: false` 이다.

## 비범위 (YAGNI)

- 줄 단위 토글 동작 (선택지 3) — 안 함.
- 자동 공백/라벨 삽입 (선택지 2) — 안 함.
- 모바일 UI 버튼 — 안 함 (InputRule 타이핑이 이미 모바일 경로).
- 컨텍스트 메뉴 항목 추가 — 안 함.
