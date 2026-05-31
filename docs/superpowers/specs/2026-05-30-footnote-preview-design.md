# 각주 미리보기(중간 단계) 설계

날짜: 2026-05-30
영역: `app/src/lib/editor/footnote/`

## 배경

현재 각주는 참조 마커(`[^N]`, 작은 위첨자)나 설명 마커(`[^N]`, 단락 맨 앞)를
누르면(`mousedown`) 곧바로 짝으로 스크롤 이동한다(`plugin.ts`의 `mousedown` →
`findFootnotePartner` → `scrollToMatch`). 이동 전에 "각주 내용 미리보기"라는
중간 단계를 넣어, 참조를 실수로 눌렀을 때 맥락을 잃지 않고 설명을 미리 볼 수
있게 한다.

기존 구조: 데코레이션 전용 ProseMirror 플러그인(문서 미변형, Svelte 비결합).
이 경계를 그대로 유지한다.

## 동작 매트릭스

| 마커 | 플랫폼 | 동작 | 결과 |
|---|---|---|---|
| 참조 `[^N]`(위첨자) | 데스크탑 | hover | 미리보기 표시(설명 일부, 버튼 없음) |
| 참조 | 데스크탑 | 클릭 | 짝(설명)으로 이동 (기존과 동일) |
| 참조 | 모바일 | 탭 | 미리보기 + **이동** 버튼 (탭만으로는 이동 안 함) |
| 참조 | 모바일 | 이동 버튼 탭 | 짝으로 이동 + 미리보기 닫힘 |
| 참조 | 모바일 | 바깥 탭 / 스크롤 | 미리보기 닫힘 |
| 설명 `[^N]`(단락 앞) | 양쪽 | 클릭/탭 | 짝(참조)으로 즉시 이동, 미리보기 없음 |
| 참조(설명 없음) | 양쪽 | hover/탭 | "설명을 찾을 수 없습니다" 안내 문구, 모바일 이동 버튼 숨김 |

데스크탑/모바일 판별은 기존 CSS 컨벤션과 동일하게 런타임에서
`matchMedia('(hover: none), (pointer: coarse)')`로 한다. matchMedia 미지원/예외
시 데스크탑으로 폴백한다(기존 jsdom 테스트에서 참조 mousedown이 여전히 이동
경로를 타도록 보존).

## 모듈 구조

### `footnotes.ts` (기존, 순수 함수 — 추가)

기존 매칭 로직 유지. 추가:

```ts
getDefinitionPreviewText(doc: PMNode, defMatch: FootnoteMatch, maxLen = 120): string
```

- `defMatch`(설명 마커)가 위치한 textblock의 `textContent`를 가져온다.
- 선행 `[^label]` 마커 토큰을 제거하고 trim.
- `maxLen`(기본 120자) 초과 시 잘라내고 `…`를 붙인다.
- 순수 함수 → 단위 테스트 대상.

### `preview.ts` (신규 — 순수 DOM 컨트롤러)

PM 비의존. `document.body`에 `position: fixed` 플로팅 요소를 명령형으로 관리해
에디터 overflow 클리핑을 회피한다.

```ts
class FootnotePreview {
  show(anchorEl: HTMLElement, text: string,
       opts: { withJumpButton: boolean; missing?: boolean; onJump?: () => void }): void
  hide(): void
}
```

- 배치: 마커 기준 위쪽, 공간 부족 시 아래로 플립. `anchorEl.getBoundingClientRect()`
  사용. 폭 제한 ~300px, 다중 줄 허용.
- `withJumpButton`(모바일)일 때만 "이동" 버튼 렌더 → 클릭 시 `onJump()` 호출.
- 모바일 표시 중에는 바깥 `pointerdown` / `scroll`에 자동 닫힘 리스너를 1회성
  등록하고 `hide()` 시 해제한다.
- `missing` 상태는 회색 톤 안내 문구, 버튼 숨김.

### `plugin.ts` (수정)

데코레이션 빌드는 그대로. 이벤트 배선 확장:

- `mousedown`:
  - 설명 마커 hit → 기존 이동(양쪽 플랫폼).
  - 참조 hit → 데스크탑은 기존 이동, 모바일은 미리보기 표시(이동 안 함,
    `withJumpButton: true`, `onJump`은 `scrollToMatch(view, partner)` + `hide`).
  - 짝 없음 → 모바일은 안내 문구 미리보기, 데스크탑 클릭은 기존 `onMissing` 토스트.
- `mouseover` / `mouseout` (데스크탑 한정, `isTouch`면 무시):
  - 참조 마커에 hover → 짝 설명 미리보기(`withJumpButton: false`) 또는 안내 문구.
  - 짧은 표시 지연(~120ms)으로 깜빡임 방지. `mouseout`은 같은 마커 내부 이동이면
    무시(relatedTarget 검사), 그 외 `hide()`.
  - 설명 마커에는 미리보기 없음.

`scrollToMatch`(기존, smooth scroll + 1.2초 flash)는 모든 이동 경로에서 재사용.

플러그인 인스턴스는 자체 `FootnotePreview` 인스턴스를 보유하고, 플러그인 파괴
시(view destroy) `hide()`로 정리.

### `TomboyEditor.svelte` (수정)

미리보기 요소 CSS만 추가(전역 클래스). 기존 `onMissing` 토스트 설정 유지.

## 데이터 흐름

```
hover/tap 참조 마커
  → posAtDOM → findFootnoteAt → hit
  → findFootnotePartner(설명)
      ├ 있음 → getDefinitionPreviewText(doc, partner) → preview.show(...)
      └ 없음 → preview.show(anchor, "설명을 찾을 수 없습니다", { missing:true })
  (모바일) onJump = () => { scrollToMatch(view, partner); preview.hide() }
```

## 스타일

- 흰 배경, 옅은 테두리/그림자, 둥근 모서리, 작은 폰트, 2~3줄 wrap 허용.
- `z-index`는 토스트(1000) 아래.
- 데스크탑 미리보기: `pointer-events: none`(버튼 없어 마커 클릭 방해 없음).
- 모바일 미리보기: 인터랙티브, "이동" 버튼 포함.
- 안내 문구 상태: 회색 톤.

## 테스트

- `footnotes.test.ts`: `getDefinitionPreviewText` — 마커 토큰 제거, trim,
  120자 말줄임, 짧은 설명 그대로.
- `preview` 컨트롤러(jsdom): `show`가 요소 생성, `withJumpButton` 시 버튼 렌더 +
  클릭이 `onJump` 호출, `hide`가 요소 제거, missing 상태 버튼 숨김.
- 기존 `footnotePlugin.test.ts`: 데스크탑 폴백에서 참조 mousedown이 여전히 이동.

## 비목표 (YAGNI)

- 미리보기 안에서의 편집/링크 클릭.
- 설명 마커 hover 미리보기(사용자 요구상 불필요).
- 미리보기 위치의 정교한 화살표/꼬리 표시(단순 박스로 시작).
- `.note` XML 라운드트립 영향 없음(데코레이션 전용 유지).
