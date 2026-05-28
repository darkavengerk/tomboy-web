# 관전 모드 패널 하단 정렬 설계

날짜: 2026-05-22
대상: `app/src/lib/editor/terminal/TerminalView.svelte`

## 배경

터미널 노트의 관전(spectator) 모드는 tmux 패널을 미러링한다. `applySpectatorFit()`이
xterm을 **가로폭 기준**으로만 `transform: scale` 하여 노트 폭에 맞춘다. 3-레이어 DOM:

- `.xterm-host` — 플렉스 아이템(`flex: 1`), `overflow: hidden`. 스크롤 표면 아님.
- `.xterm-stage` — `applySpectatorFit`이 스케일된 픽셀 크기(`naturalW*scale × naturalH*scale`)를
  인라인으로 지정. 호스트의 레이아웃 박스를 차지.
- `.xterm-mount` — `position: absolute; top:0; left:0`, 자연 크기 + `transform: scale(s)`.

스케일이 가로폭만으로 정해지므로, 노트 높이가 낮으면 스테이지의 세로 길이
(`naturalH*scale`)가 `.xterm-host`보다 길어진다. 현재 스테이지는 호스트 **상단**에
놓이고 호스트가 `overflow: hidden`이라, **하단(프롬프트·커서·최근 출력이 있는 쪽)이
잘린다.** 관전의 핵심 정보가 안 보이는 셈이다.

## 목표

관전 패널을 `.xterm-host`의 **하단**에 정렬한다. 패널이 노트보다 길면 상단이 잘리고,
프롬프트·커서·최근 출력은 항상 보인다. 패널이 노트보다 짧을 때도 하단에 붙인다
(항상 하단 정렬 — 사용자 확정).

normal-screen에서는 최근 도입된 freeze-스크롤(`spectatorScroll.ts` / `term.scrollLines`)로
버퍼를 위로 올리면 잘린 상단 내용이 가시 창으로 들어오므로, 하단 정렬 + 기존 스크롤로
자연스럽게 처리된다.

## 설계

### 변경 범위

`TerminalView.svelte`의 `<style>` 블록만 수정한다. `applySpectatorFit()` 로직,
DOM 구조, WebSocket 프로토콜, 스크롤 로직은 건드리지 않는다. JS 변경 0.

### CSS 변경

1. `.terminal-page.spectator .xterm-host`에 다음을 추가:
   ```css
   display: flex;
   flex-direction: column;
   justify-content: flex-end;
   ```
   기존 `overflow-x: hidden; overflow-y: hidden`, 베이스 규칙의 `flex: 1`,
   `padding: 4px`는 유지.

2. `.terminal-page.spectator .xterm-stage`에 `flex-shrink: 0`을 추가.
   기존 `position: relative`는 유지.

3. 셀렉터가 `.terminal-page.spectator`로 한정되므로 비관전 모드의
   `.xterm-host` / `.xterm-stage`(100%×100%, FitAddon 경로)는 영향받지 않는다.

### 왜 `flex-shrink: 0`이 필수인가

플렉스 아이템은 기본 `flex-shrink: 1`이라, 컨테이너(호스트)가 스테이지의 명시
높이보다 짧으면 스테이지가 **축소된다** — 넘쳐서 잘리는 게 아니라 줄어든다.
그러면:

- 스테이지가 레이아웃 박스인데 실제 크기와 어긋나 `.xterm-mount`(절대 배치, 자연
  크기 유지)가 어긋난 박스 위에 렌더된다.
- 모바일 터치 스크롤의 `pxPerLine = xtermStageEl.clientHeight / term.rows`가
  틀어진다.

`flex-shrink: 0`으로 스테이지가 명시 높이를 유지하고, `justify-content: flex-end`가
이를 바닥에 붙여 초과분이 **상단으로 넘쳐 `overflow: hidden`에 잘리게** 한다.
호스트는 스크롤 표면이 아니므로(`overflow: hidden`) 플렉스의 "시작 측 초과는
스크롤로 못 닿음" 알려진 이슈는 해당 없음 — 잘리는 것이 의도된 동작이다.

### 동작 요약

| 상황 | 결과 |
|------|------|
| 패널이 노트보다 짧음 | 하단 정렬, 위쪽에 여백 |
| 패널이 노트보다 김 | 하단 정렬, 상단이 잘림 — 프롬프트·커서 항상 보임 |
| 노트 리사이즈 | CSS가 상시 하단 정렬 유지 (`applySpectatorFit` 호출과 무관) |
| 비관전 터미널 노트 | 영향 없음 |

## 알려진 제약

- **alt-screen TUI**(claude code·vim·htop 등)는 xterm 스크롤백이 없어, 잘린 상단은
  노트를 키우기 전엔 볼 수 없다. 단 현재(상단 기준)는 활성 입력부인 **하단**이
  잘려 더 나쁘다 — 이 변경은 alt-screen에서도 순개선이다. (보내기 팝업의
  PgUp/PgDn은 앱 레벨 스크롤이며 별개.)
- 버퍼 스크롤 위치는 강제로 바꾸지 않는다. freeze 상태는 보존되고, CSS는 시각적
  하단 정렬만 담당한다.

## 검증

CSS 단독 변경이라 유닛 테스트 없음. 수동 확인:

1. 데스크탑 `NoteWindow`와 모바일 `/note/[id]` 라우트 양쪽에서 관전 노트를 작은
   창/낮은 높이로 연다.
2. 하단(프롬프트·커서)이 보이고 상단이 잘리는지 확인.
3. normal-screen에서 버퍼를 위로 스크롤하면 잘렸던 상단 내용이 가시 창으로
   들어오는지 확인.
4. 노트를 리사이즈해도 하단 정렬이 유지되는지 확인.
5. 비관전 터미널 노트(셸 모드)가 정상 동작하는지 확인.

## 범위 외

- 호스트를 `overflow-y: auto` 스크롤 표면으로 만드는 것 — 커밋 5776d9d에서 xterm
  터치 스크롤과 충돌해 제거됐다. freeze-스크롤이 세로 스크롤을 전담한다.
- `applySpectatorFit`의 `clientWidth` 패딩 포함 오차(기존 8px 이슈) — 본 작업과
  무관, 손대지 않는다.
