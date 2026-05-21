# 관전 모드 스크롤백 열람 — 클라이언트 설계 문서

- 작성일: 2026-05-21
- 대상: 터미널 노트 **관전(spectator) 모드** — 모바일/데스크탑에서 스크롤백 열람
- 선행:
  - `docs/tmux-spectator-scroll-analysis.md` — 원인 분석
  - `docs/superpowers/specs/2026-05-21-spectator-scrollback-seed-design.md` — 브릿지 시드(라운드 1)
  - `docs/tmux-spectator-scrollback-client-feasibility.md` — 본 작업 타당성 분석

## 1. 배경

라운드 1에서 브릿지에 `capture-pane -S -1000`을 추가해 스크롤백 1000줄이
시드에 담겨 `term.write()`로 **xterm 내부 버퍼에는 정상 도착**한다. 그러나
관전 모드의 스크롤 면이 그걸 노출하지 못한다 — `applySpectatorFit()`이 스크롤
영역(`.xterm-stage`)을 `.xterm-screen`의 높이(= 보이는 화면 `rows ×
cellHeight`)로만 잡고, xterm 스크롤백은 `.xterm-screen`를 늘리지 않기
때문이다. 결과적으로 시드된 1000줄이 버퍼에 **갇혀** 있다. 이 문서는 그
**클라이언트 측 수정**의 설계다.

## 2. 목표 / 비목표

**목표** — 일반 화면 패널(claude code 포함)의 스크롤백을 모바일·데스크탑 관전
화면에서 스크롤해 열람한다. 패널이 멈춰 있을 때와 출력이 흐르는 중 **둘 다**
동작한다.

**비목표**
- alt-screen 풀스크린 TUI(vim·htop·less 등) — 스크롤백이 원천적으로 없어
  대상이 아니다. 별도 처리도 하지 않는다.
- 데스크탑 사용자의 copy mode 스크롤 *위치* 추종 — 별건(타당성 보고서의
  방식 A). 이번 범위 아님.
- 라이브 출력과 과거를 *동시에 실시간* 표시 — 살아있는 미러에서 불가능.
  §4의 freeze 패턴으로 "한 번에 한 모드"로 해결한다.

## 3. 범위 — 일반 화면 패널

normal-screen 패널만 대상이다(셸·로그·빌드 출력·claude code). claude code는
alt screen을 쓰지 않는다 — 끝난 메시지가 일반 화면 확정 출력으로 남아 xterm
스크롤백에 쌓인다.

alt-screen 패널은 스크롤백이 없어 기능이 **자연히 무력화**된다(스크롤할 내용이
없으면 스크롤 면이 움직이지 않을 뿐). 따라서 `altScreen` 분기 가드 코드는
**불필요**하다 — 가드 없이도 해를 끼치지 않는다.

## 4. UX 모델 — freeze 패턴

살아있는 미러에서 "과거 읽기"와 "현재 미러링"의 충돌을, 업계 표준
freeze 패턴으로 해소한다.

- **맨 아래에 있을 때** — 기존대로 라이브 추종. 새 `%output`이 화면을 맨
  아래에 고정한다.
- **위로 스크롤하면** — 라이브 추종이 자동 해제된다. xterm은 사용자가 둔
  스크롤 위치를 유지하고(xterm 기본 동작 — write가 들어와도 스크롤업
  상태면 끌어내리지 않음), 새 `%output`은 버퍼 아래에 누적된다.
- **스크롤업 상태 동안** — 떠 있는 **"↓ 맨 아래로"** 버튼을 표시한다. 그
  사이 도착한 새 출력 줄 수 N을 함께 보인다 — `↓ 새 출력 N줄`. 탭하면
  `term.scrollToBottom()` + 라이브 추종 재개.
- **맨 아래로 복귀** — 버튼을 숨기고 추종을 재개한다.

→ 멈춘 패널은 자유 스크롤, 스트리밍 중에는 위로 올리는 순간 freeze되어 방해
없이 읽는다. "둘 다 동등하게"를 "한 번에 한 모드"로 충족한다.

## 5. 접근

### 5a. 접근 A — xterm 네이티브 뷰포트 스크롤 (주력)

xterm 자체의 `.xterm-viewport`(내부 overflow-y 스크롤 요소, 전체 버퍼 높이의
sizer를 가짐)가 스크롤백 스크롤을 담당하게 한다. 관전 모드의 width-fit
`transform: scale`된 3-레이어 DOM 안에서 모바일 터치가 `.xterm-viewport`에
닿도록 보장한다(필요 시 `.xterm-host`/CSS 소폭 조정).

freeze 상태와 인디케이터는 `term.onScroll`과 buffer 좌표(`term.buffer.active`의
`viewportY` / `baseY`)로 "맨 아래인가"를 판정해 구동한다.

### 5b. 스파이크 (1단계 — go/no-go 게이트)

전체 구현 전에, 타당성 보고서의 핵심 불확실성 R1~R3(`transform: scale` +
모바일 터치 스크롤)을 실기기로 먼저 해소한다.

- **방법** — 접근 A의 최소 코어만 붙이고(네이티브 뷰포트 스크롤 노출), 더미
  ~1000줄을 xterm에 주입하거나 실제 관전 세션으로, 실제 모바일 기기에서 터치
  스크롤이 매끄러운지 확인한다.
- **산출** — go/no-go 판정 + 관찰 메모. 프로덕션 산출물이 아니라 결정이
  산출물이다(접근 A가 통과하면 이 코어가 2단계의 토대가 된다).
- **go** → 접근 A로 2단계(헬퍼 + 인디케이터) 진행.
- **no-go** → 접근 B로 피벗하거나, B도 R2/R3가 심하면 더 보수적인
  "히스토리 보기 모드"(라이브를 멈추고 스냅샷을 일반 스크롤)를 재설계.

### 5c. 접근 B — 커스텀 스크롤 면 (폴백)

스파이크가 실패할 때만. `.xterm-host`를 단일 스크롤 면으로 두고 `.xterm-stage`
높이를 전체 버퍼(`term.buffer.active.length × cellH × scale`)로 잡으며,
`.xterm-host`의 `scrollTop`을 버퍼 줄로 변환해 `term.scrollToLine()` 호출,
마운트는 `position: sticky`. 라이브 출력으로 버퍼가 자랄 때 위치가 어긋나지
않도록 **줄(line) 기준 앵커링**으로 보정한다. (상세 설계는 no-go 시 별도.)

## 6. 컴포넌트 & 파일

- **`app/src/lib/editor/terminal/spectatorScroll.ts`** (신규, 순수 헬퍼) —
  "현재 맨 아래인가" 판정과 "스크롤업 이후 새로 도착한 줄 수" 카운트 로직.
  입력은 buffer 좌표/이전 상태 같은 순수 값, 출력은 `{ atBottom,
  newLineCount }` 형태. 순수 함수라 vitest 단위 테스트가 가능하고
  `TerminalView.svelte`의 비대화를 막는다.
- **`app/src/lib/editor/terminal/TerminalView.svelte`** — 접근 A의 스크롤 면
  배선, `term.onScroll` 구독, freeze 상태(`$state`), "↓ 맨 아래로" 인디케이터
  버튼의 마크업·스타일·탭 핸들러.
- **변경 없음** — 브릿지, WS 프로토콜, `parseTerminalNote`.

## 7. 테스트

- `spectatorScroll.ts` 순수 헬퍼 → vitest 단위 테스트 (`app/tests/unit/editor/`).
- 스크롤 동작(스케일 DOM + 터치)은 자동 테스트가 어렵다 → 실기기 수동 스모크,
  스파이크 단계와 최종 모두:
  1. 멈춘 일반 화면 패널 — 스크롤백을 위로 자유 스크롤.
  2. 스트리밍 중 — 위로 스크롤 시 freeze, "↓ 새 출력 N줄" 버튼 표시, 탭 시
     맨 아래 복귀 + 추종 재개.
  3. claude code 패널 — 대화 히스토리 스크롤 가능.
  4. alt-screen 패널(vim 등) — 깨지지 않음(스크롤백이 없어 무력일 뿐).
  5. 데스크탑 관전 — 휠 스크롤 + 인디케이터 정상.

## 8. 위험

타당성 보고서 §4의 R1~R8 참조.

- **R1~R3**(`transform: scale` + 모바일 터치 스크롤 / 관성 ↔ 프로그래매틱
  동기화 / DOM 렌더러 perf) — **스파이크(5b)로 해소.** 이번 설계의 핵심
  불확실성.
- **R5/R6**(프로그램의 `clear`/RIS, 페인 전환 재시드가 스크롤백을 리셋) —
  수용. 불가피하거나 설계상 타당.
- **R7**(시드는 attach 시점 과거 1000줄 한도) — 수용.
- **R8**(alt-screen 무대상) — §3대로 가드 없이 자연 무력.

## 9. 단계 (구현 플랜 예고)

1. **스파이크** — 접근 A 최소 코어 + 실기기 검증 (go/no-go 게이트).
2. (go) **`spectatorScroll.ts`** — 순수 헬퍼 + 단위 테스트.
3. (go) **`TerminalView.svelte`** — 스크롤 면 배선 + freeze + "↓ 맨 아래로"
   인디케이터.

스파이크가 no-go면 §5c(접근 B) 또는 보수안으로 재설계 후 플랜을 다시 짠다.
