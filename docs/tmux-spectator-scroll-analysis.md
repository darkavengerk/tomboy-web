# tmux 관전 모드 스크롤 미갱신 — 동작 분석 보고서

- 작성일: 2026-05-21
- 대상: 터미널 노트 **관전(spectator) 모드**
- 관련 파일:
  - 브릿지: `bridge/src/spectatorSession.ts`, `bridge/src/tmuxControlClient.ts`, `bridge/src/server.ts`
  - 클라이언트: `app/src/lib/editor/terminal/wsClient.ts`, `app/src/lib/editor/terminal/TerminalView.svelte`

> 이 문서는 **원인 분석 전용**이다. 수정 방안 설계는 의도적으로 다루지 않는다.

---

## 0. 관찰된 증상

데스크탑에서 돌아가는 tmux 세션을 모바일 노트의 관전 모드로 보고 있을 때,
**데스크탑 사용자가 tmux 화면을 위로 스크롤(스크롤백 조회)하면 모바일 노트는
따라가지 않고 "현재(라이브) 터미널 데이터"만 계속 보여준다.**

아래 세 가지를 분석한다.

1. tmux가 화면 스크롤(copy mode)을 처리하는 방식
2. 톰보이 앱이 tmux로부터 데이터를 받아 화면을 갱신하는 방식
3. 스크롤 시 갱신이 안 되는 근본 원인

---

## 1. tmux의 화면 스크롤(copy mode) 처리 방식

### 1.1 tmux의 페인 화면 모델

tmux는 각 페인(pane)마다 문자 그리드를 둘로 나눠 관리한다.

- **visible region** — 지금 보이는 `width × height` 화면. 페인 안 프로그램이
  pty로 내보낸 바이트가 여기에 반영된다.
- **history(scrollback)** — visible region 위로 밀려 올라간 과거 줄들의 버퍼.

프로그램이 출력을 내면 visible region이 갱신되고, 줄이 위로 밀리면 history에
쌓인다. 이게 "라이브 화면"이다.

### 1.2 copy mode란

copy mode는 사용자가 `prefix + [` 로 진입하는 **클라이언트/페인의 표시
상태(오버레이)**다. copy mode에서 위로 스크롤하면 tmux는 history 버퍼의 과거
줄들을 그 클라이언트 화면에 보여준다.

핵심 성질:

- copy mode 진입·스크롤은 **프로그램을 실행시키지 않는다.** pty에 새 바이트가
  생기지 않는다.
- 페인의 visible region(라이브 grid)은 **변하지 않는다.** 단지 "그 클라이언트가
  화면의 어느 부분을 보고 있는가"만 바뀐다.
- copy mode 중에도 페인 안 프로그램은 계속 돌고, 출력하면 라이브 grid는 계속
  갱신된다. copy mode는 그 클라이언트의 *표시*만 과거에 묶어둘 뿐 페인 출력을
  막지 않는다.

### 1.3 일반 클라이언트 vs control mode 클라이언트

tmux에 붙는 방식이 두 가지이고, 화면을 받는 방식이 근본적으로 다르다.

| | 일반 클라이언트 (`tmux attach`) | control mode 클라이언트 (`tmux -CC attach`) |
|---|---|---|
| tmux가 보내는 것 | **렌더링된 화면**을 escape sequence로 그려줌. copy mode면 스크롤된 viewport가 그대로 그려짐 | **구조화된 프로토콜.** 렌더링된 화면은 보내지 않음 |
| 스크롤(copy mode) | tmux가 알아서 그려줌 | 클라이언트에게 push되지 않음 |
| 용도 | 사람이 보는 터미널 | iTerm2 같은 **터미널 에뮬레이터**가 소비 |

control mode(`-CC`)가 보내는 주요 프레임:

- `%output %<pane> <bytes>` — 페인 안 프로그램이 pty로 낸 **출력 바이트 스트림**
- `%window-pane-changed`, `%session-window-changed`, `%layout-change`,
  `%pane-mode-changed`, `%begin/%end`(명령 응답) 등 구조 알림

control mode는 에뮬레이터가 `%output`을 재생해 **페인별 가상 터미널을 자체적으로
유지**하도록 설계된 프로토콜이다. 스크롤백·copy mode도 에뮬레이터가 자기 로컬
버퍼로 직접 구현한다. (참고: iTerm2의 tmux 통합은 tmux의 copy mode를 아예 쓰지
않고 자체 네이티브 스크롤백을 제공한다 — 그래서 이 문제 자체가 발생하지 않는다.)

### 1.4 핵심 결론 — copy mode는 control mode에 비가시(invisible)다

§1.2 + §1.3을 합치면:

- copy mode 스크롤 → `%output` 없음 (프로그램이 안 돌았으므로)
- copy mode 스크롤 → 페인 grid 변화 없음
- tmux가 control 클라이언트에게 알려주는 것은 기껏해야 `%pane-mode-changed`
  (모드 진입/이탈 **신호만**, 스크롤 내용·위치 없음)

→ **control mode 클라이언트 입장에서 데스크탑 사용자의 copy mode 스크롤은
완전히 보이지 않는 사건이다.**

### 1.5 copy mode 상태를 알려면 — pull만 가능

control 클라이언트가 copy mode를 알려면 **능동적으로 질의**해야 한다. tmux가
먼저 알려주지 않는다(push 아님, pull만 가능).

- `#{pane_in_mode}` — 페인이 모드 중인지(1/0)
- `#{pane_mode}` — 모드 이름(`copy-mode` 등)
- `#{scroll_position}` — copy mode 스크롤 위치
- `capture-pane -p -S <start> -E <end>` — `-S`로 스크롤백 포함 임의 구간 캡처
  (`-S -` = history 시작, 음수 = N줄 위)

---

## 2. 톰보이 앱이 tmux로부터 데이터를 받아 갱신하는 방식

### 2.1 전체 경로

```
데스크탑 tmux 서버
   │  ssh -tt + tmux -CC attach
   ▼
브릿지 SpectatorSession  ── TmuxControlClient가 control 프로토콜 파싱
   │  WebSocket (data / pane-switch / pane-resize 프레임)
   ▼
모바일 wsClient → TerminalView.svelte → xterm.js
```

### 2.2 브릿지 — 세션 수립 (`spectatorSession.ts:84-176`)

ssh `-tt`로 타깃에 접속하고 원격에서 다음을 실행한다(`:122`):

```
stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t <session>
```

ssh stdout은 `TmuxControlClient.feed()`로 흘러 들어가 control 프로토콜로 파싱된다
(`:131`).

### 2.3 브릿지 — 초기 시드 (`bootstrap`, `spectatorSession.ts:178-223`)

1. `refresh-client -C 500x200` — 클라이언트 크기를 500×200으로 선언
2. `display-message -p` 로 현재 세션/윈도우/**활성 페인**/크기/alt-screen/커서를 질의
3. `activateAndSeed(...)` 호출

### 2.4 브릿지 — 시드 빌드 (`activateAndSeed`, `spectatorSession.ts:289-336`)

활성 페인의 화면을 만들어 클라이언트에 한 번 밀어 넣는다.

```
\e[?1049l\ec            리셋(스크롤백+속성 초기화)
[alt-screen이면 \e[?1049h]
capture-pane -epJ -t <pane> 결과     ← 페인 캡처
\e[<y>;<x>H             커서 위치 복원
```

**중요: `capture-pane`에 `-S` 옵션이 없다(`:319`).** 따라서 시드는 항상
**보이는 영역(visible region)만** 캡처하고, history(스크롤백)는 포함하지 않는다.

### 2.5 브릿지 — 라이브 스트리밍 (`onPaneOutput`, `spectatorSession.ts:225-239`)

`%output` 이벤트 중 **활성 페인의 것만** WS `data` 프레임으로 전달한다. 비활성
페인 출력은 드롭한다(`:226` `if (paneId !== this.activePaneId) return`).

### 2.6 브릿지 — 포커스 추적

- `%window-pane-changed` / `%session-window-changed` → 100ms 디바운스 →
  `switchTo()` → 새 활성 페인을 다시 `activateAndSeed`로 재시드
- `%layout-change` → 페인 크기 재질의 → 바뀌었으면 `pane-resize` 프레임

### 2.7 브릿지가 구독하는 이벤트 — 그리고 구독하지 않는 것

`SpectatorSession` 생성자(`spectatorSession.ts:160-173`)가 구독하는 것:

- `output`, `windowPaneChanged`, `sessionWindowChanged`, `layoutChange`, `exit`

구독하지 **않는** 것:

- `notification` — `tmuxControlClient.ts:284-287`에서 미지정 태그(예
  `%pane-mode-changed`)는 전부 `notification` 이벤트로 떨어진다. `SpectatorSession`은
  이 이벤트를 듣지 않으므로 **`%pane-mode-changed`는 도달조차 하지 않고 버려진다.**

→ 브릿지의 화면 모델은 사실상 "활성 페인 `%output` 라이브 전달 + 페인 전환 시
visible 영역 재시드"가 전부다. **copy mode / 스크롤 위치라는 개념 자체가 없다.**

### 2.8 클라이언트 — 렌더링 (`TerminalView.svelte`)

- `onData: (chunk) => term?.write(chunk)` (`:419`) — 받은 바이트를 xterm에 그대로 write
- `pane-switch` / `pane-resize` 콜백 → `term.resize(cols, rows)` (`:432-447`)
- xterm 옵션 `scrollback: 5000` (`:332`)
- 모바일은 `.xterm-host { overflow-y: auto; -webkit-overflow-scrolling: touch }`
  (`:1019`)로 **네이티브 터치 스크롤**

→ 모바일에서 손으로 위로 스크롤하면, xterm은 **attach 이후 `%output`으로 자기가
쌓은 로컬 스크롤백**을 보여준다. 이 버퍼는 데스크탑의 tmux copy mode 스크롤백과
완전히 별개이며, 동기화된 적이 없다.

---

## 3. 스크롤 시 갱신이 안 되는 근본 원인

데스크탑 사용자가 copy mode로 스크롤 → 모바일 노트가 안 따라간다. 원인을
계층별로 분해한다.

### 원인 A — 프로토콜: copy mode는 control mode에 비가시 (1차 원인)

§1.4 그대로다. copy mode 스크롤은 `%output`을 만들지 않고 페인 grid도 바꾸지
않는다. 브릿지의 ssh control 스트림에는 **0바이트가 도착한다.** 받지 못한 것을
전달할 수는 없다. 이것이 가장 근본적인 원인이다.

`tmux -CC` control mode는 본질적으로 **"프로그램의 출력 바이트 스트림"을 주는
프로토콜**이지 **"렌더링된 화면(스크롤 뷰 포함)"을 주는 프로토콜이 아니다.**
copy mode는 정의상 후자에 속하므로 현재 데이터 경로로는 절대 전달될 수 없다.

### 원인 B — 브릿지: copy mode 개념의 부재

설령 신호가 와도 받을 곳이 없다.

- `%pane-mode-changed`(모드 진입/이탈 신호)는 `notification` 이벤트로 떨어지는데
  `SpectatorSession`이 이를 구독하지 않는다(§2.7).
- `#{scroll_position}`을 폴링하지도, `#{pane_in_mode}`를 질의하지도 않는다.

즉 브릿지는 copy mode를 **알 수도, 반응할 수도 없는 구조**다.

### 원인 C — 시드: 스크롤백을 캡처하지 않고, 스크롤 때 트리거되지도 않음

- 시드의 `capture-pane -epJ`에 `-S`가 없어(§2.4) 항상 visible 영역만 캡처한다.
  브릿지는 데스크탑 페인의 스크롤백을 단 한 번도 가져온 적이 없다.
- 게다가 시드는 **페인 전환 시에만** 발생한다. 스크롤은 시드를 트리거하지 않는다.

### 원인 D — 클라이언트: 별개의 스크롤 버퍼

모바일 xterm의 네이티브 스크롤은 "attach 이후 받은 `%output` 누적분"을 보여줄
뿐이다(§2.8). 데스크탑 copy mode 스크롤백과는 **다른 버퍼**다. 그래서 모바일에서
스크롤이 "되는 것처럼 보여도" 데스크탑 사용자가 보고 있는 내용과 다르다.

### 원인 E — 일부는 설계상 의도된 동작

`server.ts:243-251` 주석이 명시한다:

> Scrolling is purely client-side over xterm.js's local scrollback ... the
> bridge doesn't try to drive tmux copy-mode anymore: copy-mode operates on
> the desktop's pane grid which the mobile has no access to, and disturbing
> the desktop view for our scroll is worse than not scrolling at all.

즉 브릿지는 **의도적으로** tmux copy mode를 건드리지 않는다. 관전 스크롤을
"클라이언트 로컬 xterm 스크롤백"으로 한정한 것이 현재 설계다. 사용자가 겪는
"버그"는 사실 그 설계의 *반대 방향* 요구다 — 독립 스크롤이 아니라 **데스크탑의
스크롤을 따라가기**를 원하는 것이고, 그건 §원인 A 때문에 현재 경로로는 불가능하다.

### 증상 대응 및 발산(divergence)

데스크탑이 copy mode로 과거를 보는 동안에도, 페인 안 프로그램이 출력하면
`%output`은 계속 흐른다(copy mode는 페인 출력을 막지 않음, §1.2). 따라서 모바일은
라이브 화면을 계속 보여주거나 마지막 상태에 머문다 — 사용자가 말한 **"노트에는
터미널의 현재 데이터만 보임"** 이 정확히 이것이다. 데스크탑은 과거를, 모바일은
현재를 — 두 뷰가 발산한다.

### 예외 — alt-screen TUI는 정상 동작

claude code, vim 등 **alt-screen** 앱 *안에서의* 스크롤은 앱이 화면을 다시 그리며
`%output`을 만든다 → 관전에 정상 전파된다. 깨지는 것은 **non-alt 화면에서의 tmux
네이티브 copy mode**에 한정된다.

---

## 4. 정리

| 계층 | 무엇이 빠졌나 |
|---|---|
| tmux 프로토콜 | copy mode는 control mode에 push되지 않음 — pull만 가능 |
| 브릿지 | copy mode 인지·질의 메커니즘 부재, `%pane-mode-changed` 미구독 |
| 시드 | `capture-pane`가 visible 영역만 캡처, 스크롤 시 트리거 안 됨 |
| 클라이언트 | xterm 로컬 스크롤백 ≠ 데스크탑 copy mode 스크롤백 (별개 버퍼) |
| 설계 | 데스크탑 뷰 보호를 위해 copy mode 연동을 의도적으로 배제 |

**근본 원인은 A다.** `tmux -CC` control mode의 데이터 경로는 "프로그램 출력
바이트"만 전달하며, copy mode 스크롤은 그 경로에 어떤 바이트도 만들지 않는다.
copy mode를 관전 모드에 반영하려면 — 그것이 다음 단계의 설계 과제다 — 데이터
경로에 **copy mode 상태를 능동적으로 pull하는 메커니즘**(`#{pane_in_mode}` /
`#{scroll_position}` 폴링 + `capture-pane -S`로 스크롤백 구간 캡처)을 새로
추가해야 한다. 본 보고서의 범위(원인 분석)를 넘어서므로 설계는 별도 문서로 다룬다.
