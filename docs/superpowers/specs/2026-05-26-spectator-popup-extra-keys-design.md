# Spectator 보내기 팝업 — 단독 특수키 보강

관전 모드(보내기 팝업)는 모바일에서 OSK로 입력할 수 없는 단독 특수키를 빠른 키
버튼으로 노출한다. 현재 라인은 `y↵ / n↵ / 1↵ / ↵ / Esc / ^C / PgUp / PgDn` 8개로,
편집·이동에 필요한 키 일부가 빠져 있다. 본 변경은 라인에 6개를 추가한다.

## 변경 범위

- 파일: `app/src/lib/editor/terminal/TerminalView.svelte` 만.
- 스타일은 같은 파일의 `.send-quick` 블록.

다른 모듈(`stickyMods`, `wsClient`, bridge 등)은 손대지 않는다.

## 추가 버튼

기존 8개 라인 뒤에 이어 붙인다.

| 라벨 | 시퀀스 | 메모 |
|---|---|---|
| `Tab` | `\t` | bash/zsh 자동완성, TUI 메뉴 |
| `⌫` | `\x7f` (DEL) | xterm/readline 표준. `\x08`(BS) 은 셸별로 동작이 갈려서 비채택 |
| `←` | `\x1b[D` | normal cursor mode (CSI) |
| `↓` | `\x1b[B` | 〃 |
| `↑` | `\x1b[A` | 〃 |
| `→` | `\x1b[C` | 〃 |

최종 라인:

```
y↵  n↵  1↵  ↵  Esc  ^C  Tab  ⌫  PgUp  PgDn  ←  ↓  ↑  →
```

좁은 폭에선 `flex-wrap: wrap` 으로 자연 줄넘김.

### 왜 이 인코딩

- **Backspace `\x7f`**: 현행 xterm/VTE/iTerm/Alacritty 의 기본. readline 은
  둘 다 받지만 일부 셸(예: dash 의 readline-less 모드)은 `\x08` 을 다르게
  처리. sticky-mods 의 기존 `SPECIAL_KEY_BYTES.Backspace` 와도 일치
  (`stickyMods.ts:16`).
- **Tab `\t`**: sticky-mods 의 기존 매핑과 일치 (`stickyMods.ts:18`).
- **화살표 `\x1b[X` (CSI)**: normal cursor mode. application keypad 모드의
  `\x1bOX` 도 있지만 거의 모든 readline/vim/tmux 조합이 CSI 를 안전하게
  처리하므로 normal 로 일관.

## sticky modifier 와의 조합

`sendQuickKey(bytes)` 는 현재 sticky 를 무시하고 raw bytes 만 송신
(`TerminalView.svelte:231-233`). 본 변경도 같은 패턴을 유지한다. 즉
sticky `Alt` 칩 armed 상태에서 `←` 버튼을 눌러도 `\x1b\x1b[D` 로 합성되지
않고 그냥 `\x1b[D` 만 전송된다.

이는 의도된 단순화다. `Alt+←` (readline 단어 점프) 같은 조합이 실제로
필요해질 때 별도 PR 로:

1. `stickyMods.ts` 에 화살표 4종 + Home/End 등을 `SPECIAL_KEY_BYTES` 와
   유사한 CSI 모디파이어 모델로 매핑.
2. `sendQuickKey` 가 sticky 를 소비하도록 확장 (현행 keydown 분기와
   동일한 시그니처).

이번 PR 의 범위에는 포함하지 않는다.

## 레이아웃 / CSS

- 버튼은 기존 `.send-quick > button` 스타일 그대로 (별도 클래스 없음).
- `.send-quick` 가 이미 flex 컨테이너이지만 `flex-wrap` 이 지정되어
  있지 않다면 `flex-wrap: wrap` 한 줄 추가.

## 검증

데스크탑 1대 + 모바일 1대, 같은 tmux 세션 spectate.

1. 데스크탑에서 `bash` 프롬프트 띄우고, 긴 명령(`echo aaaa bbbb cccc`) 타이핑.
   - 모바일 ←/→: 커서가 글자 단위로 좌우 이동.
   - 모바일 ⌫: 한 글자씩 지워짐.
2. 데스크탑에서 `claude` (또는 다른 TUI) 실행.
   - 모바일 ↑/↓: 메뉴 / 히스토리 이동.
   - 모바일 Tab: 자동완성 후보 토글.
3. 모바일 폭을 줄여(개발자도구 모바일 에뮬레이션) 보내기 팝업 열면, 14개 버튼이
   라인 끝에서 자연 줄넘김.
4. sticky `Alt` 칩 armed 상태에서 `←` 버튼 → `\x1b[D` 만 전송 (DevTools
   Network → WS 메시지로 확인).

데스크탑(직접 키보드 입력) 동작은 변경 없음 — 본 변경은 모바일 보내기 팝업
한정.

## 비범위 (Out of scope)

- Home / End / Delete(forward) / F-keys — 사용자가 이번에는 필요 없다고 결정.
  필요해지면 같은 패턴으로 추가.
- sticky 칩 + 빠른 키 조합 (Alt+←, Ctrl+Backspace 등) — 위 "sticky 와의 조합"
  섹션 참조.
- 데스크탑 spectator 의 직접 키 입력 경로(`term.onData → client.send`) 는
  손대지 않음.
