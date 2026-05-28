# 관전 모드 패널 선택기 확장 + 활성 패널 표시 설계

날짜: 2026-05-23
대상: `bridge/src/spectatorSession.ts`, `bridge/src/server.ts`,
`app/src/lib/editor/terminal/wsClient.ts`,
`app/src/lib/editor/terminal/TerminalView.svelte`

## 배경

터미널 노트의 관전(spectator) 모드 푸터에는 tmux 윈도우의 N번째 패널로
점프하는 절대 순번 버튼이 있다. 현재 `1·2·3·4` 네 개뿐이고, 어느 패널이
지금 화면에 보이고 있는지 시각적 표시가 없다.

푸터 버튼 `n`은 `selectPane(n)` → WS `tmux-nav` 절대 점프 프레임을 보내고,
브릿지 `spectatorSession.selectPane(ordinal)`이 `list-panes -F '#{pane_id}'`
출력의 `(ordinal-1)`번째 pane id로 `select-pane`을 건다. 즉 버튼 번호는
tmux의 `pane-base-index`와 무관한 **목록상 1-based 위치(순번)**다.

브릿지는 패널 전환·부트스트랩 시 `pane-switch` WS 프레임을 보내며 현재
`{ paneId, cols, rows, altScreen, windowIndex, windowName }`를 싣는다.
`paneId`(`%3` 같은 tmux pane id)는 들어 있지만 **순번**은 없다. 클라이언트는
`paneId`만으로는 그것이 몇 번 버튼인지 알 수 없다.

## 목표

1. 푸터 패널 버튼을 `1~4` → `1~5`로 확장한다.
2. 현재 관전 중인 패널에 해당하는 숫자 버튼을 액센트 색으로 하이라이트한다.
3. 관전 윈도우의 패널 개수보다 큰 번호의 버튼은 dim 처리 + 클릭 비활성화한다.

데스크탑 사용자가 직접, 또는 `Ctrl+H/L`·`«»`로 패널/윈도우를 옮길 때도
하이라이트가 따라가야 하므로, 활성 패널 정보는 브릿지가 권위 있게 보고한다
(클라이언트 낙관적 표시는 이 경우들을 못 잡아 탈락).

## 설계

### 데이터 흐름

브릿지가 `pane-switch` 프레임에 두 필드를 추가한다:

- `paneOrdinal: number` — 활성 패널의 `list-panes` 상 1-based 위치.
  찾지 못하면 `0`.
- `paneCount: number` — 윈도우의 전체 패널 수.

`selectPane`이 순번을 푸는 방식(`list-panes -F '#{pane_id}'` 위치)과 정확히
대칭이므로 버튼 번호 ↔ 하이라이트가 항상 일치한다.

### 1. 브릿지 (`bridge/src/spectatorSession.ts`)

부트스트랩과 패널 전환은 모두 `activateAndSeed`로 모인다. 여기서:

- `list-panes -t <session> -F '#{pane_id}'`를 조회한다. 이미 수행하는
  `capture-pane` 호출과 **병렬**(`Promise.all`)로 돌려 추가 지연이 없게 한다.
- `paneOrdinal = lines.indexOf(activePaneId) + 1` (없으면 `0`),
  `paneCount = lines.length`를 계산한다.
- `this.cb.paneSwitch({ ... , paneOrdinal, paneCount })`로 넘긴다.

`SpectatorCallbacks.paneSwitch` 인자 타입에 `paneOrdinal: number`,
`paneCount: number`를 추가한다.

`list-panes` 조회가 실패하면 `paneOrdinal = 0`, `paneCount = 0`으로 두고
나머지 패널 전환 흐름은 그대로 진행한다(하이라이트만 생략, 관전 자체는 정상).

### 2. WS 프레임 (`bridge/src/server.ts`)

`server.ts`의 `paneSwitch` 콜백은 `send({ type: 'pane-switch', ...info })`로
`info`를 그대로 스프레드한다. 따라서 `info`에 `paneOrdinal`·`paneCount`가
들어가면 WS 프레임에 자동 포함된다 — `server.ts`는 수정 불필요.

### 3. WS 클라이언트 (`app/src/lib/editor/terminal/wsClient.ts`)

- `PaneSwitchInfo`에 `paneOrdinal: number`, `paneCount: number` 추가.
- `ServerMsg`에 `paneOrdinal?: number`, `paneCount?: number` 추가.
- `pane-switch` 핸들러에서 두 값을 `onPaneSwitch`로 전달한다. 프레임에 없으면
  (구버전 브릿지) 각각 `0`으로 기본 처리 — graceful degradation.

### 4. TerminalView (`app/src/lib/editor/terminal/TerminalView.svelte`)

- 새 상태: `spectatorPaneOrdinal = $state(0)`, `spectatorPaneCount = $state(0)`.
- `onPaneSwitch` 콜백은 두 군데(초기 연결·재연결 경로)에 있다. **둘 다**에서
  `spectatorPaneOrdinal`·`spectatorPaneCount`를 갱신한다.
- 푸터: `{#each [1, 2, 3, 4] as n}` → `{#each [1, 2, 3, 4, 5] as n}`.
- 패널 버튼:
  - `class:active={n === spectatorPaneOrdinal}`
  - `disabled={status !== 'open' || (spectatorPaneCount > 0 && n > spectatorPaneCount)}`
  - `spectatorPaneCount`가 `0`(정보 미수신·구버전 브릿지)이면 개수 기반
    비활성화는 적용하지 않는다 — 5개 버튼 모두 살아 있음(현행 동작 유지).
- CSS — 패널 버튼의 3가지 시각 상태:
  - 평상시: 기존 `.spec-footer button.pane-num` 스타일.
  - 활성(`.active`): 채워진 액센트 배경 + 대비되는 글자색. 푸터 toolbar에서
    한눈에 띄게.
  - 비활성(`:disabled`): 기존 dim 스타일(`.spec-footer button:disabled`)
    그대로 — 추가 규칙 불필요.

## 동작 요약

| 상황 | 결과 |
|------|------|
| 활성 패널이 1~5번 | 해당 숫자 버튼 액센트 하이라이트 |
| 패널 개수 < 5 | 초과 번호 버튼 dim + 클릭 비활성 |
| 활성 패널이 6번 이상 | 하이라이트 없음 (버튼은 5까지) |
| 구버전 브릿지 (필드 없음) | 5개 버튼 표시, 하이라이트·개수 비활성화 없음 |

## 알려진 제약

- **순번 일시 어긋남**: `pane-switch` 프레임은 포커스 변화에만 발생한다.
  포커스 변화 없이 *비활성* 패널이 추가/제거되면 순번이 밀려, 다음 포커스
  변경 전까지 하이라이트가 잠깐 어긋날 수 있다. 드문 경우라 범위 외로 둔다
  (`%layout-change` 훅으로 재조회하는 것은 별도 프레임 설계가 필요해 미포함).
- **활성 패널이 6번 이상**: 버튼은 5까지이므로 하이라이트가 없다. 의도된
  제약 — 요구는 "5까지 확장"이다.
- 브릿지 변경이 포함되므로 **term-bridge 컨테이너 재배포**가 필요하다
  (`systemctl --user restart term-bridge`). 재배포 전에는 5개 버튼은 보이되
  하이라이트·개수 비활성화는 동작하지 않는다(하위호환).

## 검증

- 자동: `wsClient`의 `pane-switch` 파싱 패스스루를 유닛 테스트(`paneOrdinal`·
  `paneCount`가 `onPaneSwitch`로 전달되는지, 누락 시 `0` 기본값). `npm run check`
  타입 통과.
- 브릿지: `node:test` 기반 테스트로 `activateAndSeed`의 순번/개수 계산을
  검증(가능 범위 내). 실제 tmux 대상 통합 테스트는 인프라 부재로 불가.
- 수동: 실제 관전 노트를 열어 ① 활성 패널 버튼 하이라이트, ② 데스크탑에서
  패널 전환·`Ctrl+H/L`·`«»` 시 하이라이트 추종, ③ 패널 < 5 윈도우에서 초과
  버튼 dim+비활성, ④ 모바일/데스크탑 라우트 양쪽, ⑤ 비관전 셸 모드 회귀 없음
  확인.

## 범위 외

- `%layout-change` 시 순번 재조회 (위 "알려진 제약" 참조).
- 패널 6개 이상 지원 / 동적 버튼 개수.
- 윈도우바(`[idx] name`)에 활성 패널을 텍스트로 추가 표기 — 버튼 색상으로
  충분하다는 사용자 확정.
