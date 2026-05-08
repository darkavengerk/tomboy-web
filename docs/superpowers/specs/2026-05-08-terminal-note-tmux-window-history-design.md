# 터미널 노트 — tmux 윈도우별 히스토리 — 디자인

**날짜:** 2026-05-08
**상태:** 디자인 검토 대기
**스코프:** 기존 터미널 노트 명령어 히스토리(2026-05-08-terminal-note-history)를 확장하여, tmux 안에서는 윈도우별로 별도 버킷에 히스토리를 보관하고, tmux 외부에서는 기존대로 단일 버킷을 유지한다.

## 요약

작업 단위가 tmux 윈도우 단위인 환경에서, 윈도우별로 같은 명령이 반복되거나 컨텍스트가 갈리는 경우가 많다. 단일 히스토리는 노이즈가 되고 dedup도 의미를 잃는다. 이 변경은:

1. 노트 본문의 `history:` 섹션을 **윈도우 키별 다중 섹션**(`history:`, `history:tmux:@1:`, `history:tmux:@2:`)으로 확장.
2. 셸 스니펫 PS0 패스에서 tmux window id를 함께 캡처하여 OSC 133 `;C` 페이로드에 첨부.
3. `~/.tmux.conf`의 `after-select-window` 훅으로 OSC 133 `;W;<id>` 마커를 송출하여 윈도우 전환을 셸 명령 발생 없이 즉시 감지.
4. 패널이 "현재 윈도우"의 버킷만 렌더링; tmux 외부에서는 기존 `history:` 단일 버킷을 사용.

기존 `history:` 섹션을 가진 노트는 그대로 호환되며 non-tmux 버킷으로 의미 부여됨. 마이그레이션 코드 없음.

---

## 섹션 1 — 노트 포맷 확장

### 본문 구조

```
ssh://[user@]host[:port]
bridge: wss://...

history:                      ← non-tmux 버킷 (기존 호환)
- vim ~/.bashrc
- ls -la

history:tmux:@1:              ← tmux window @1 버킷
- htop
- tail -f /var/log/caddy.log

history:tmux:@2:              ← tmux window @2 버킷
- gdb ./a.out
- bt
```

### 규칙

- **헤더 텍스트는 fixed string**: `history:` 또는 `history:tmux:<key>:`. localized 안 함.
- 키 형식: `[A-Za-z0-9@$:_-]+`. 실제로는 `@1`, `@2` 같은 tmux `#{window_id}`. 다른 문자를 막는 게 아니라, 이 정규식에 걸리지 않는 헤더는 무시(섹션이 아닌 일반 단락)되도록 파서가 동작.
- 각 섹션 = `history:...` 헤더 단락 + 직후 `bulletList`. 그 사이 공백 단락은 허용.
- 섹션 간에는 공백 단락이 끼어도 좋음. 비-history 자유 단락이 metadata 이후에 끼면 → 기존 규칙대로 일반 노트로 폴백.
- 각 섹션 50개 cap, FIFO + move-to-top dedup **섹션 단위 독립**. cross-section dedup 안 함.

### 파서 반환 타입

```ts
export interface TerminalNoteSpec {
  target: string;
  host: string;
  port?: number;
  user?: string;
  bridge?: string;
  /** key '' = non-tmux bucket, 'tmux:@1' = tmux window @1, ... */
  histories: Map<string, string[]>;
  /** 후방호환을 위한 평탄화 — 모든 버킷 합쳐 most-recent-first 순서로 (UI는 사용 안 함, 마이그레이션 도구용). */
  history: string[];
}
```

`histories` 키 컨벤션: 빈 문자열 `''`이 non-tmux 단일 버킷, `tmux:@1`이 tmux 윈도우 @1.

### 호환성

- 기존 노트 (`history:` 1개 섹션만 있는) → `histories.get('') === [...]`, `histories.size === 1`. 동작 변화 없음.
- 노트에 `history:tmux:...` 섹션이 없는 상태에서 사용자가 tmux 안에서 명령을 처음 캡처하면, store가 새 섹션을 자연스럽게 생성.
- 모든 섹션이 비어 있고 헤더만 남은 케이스(현재처럼) — 기존과 같이 헤더만 떨궈둠. write 시 빈 섹션은 emit 안 함.

---

## 섹션 2 — 셸 스니펫 확장

### PS0 — window id 캡처

```bash
__th_state_file="${XDG_RUNTIME_DIR:-/tmp}/.th_state_$$"

__th_osc() {
  if [ -n "$TMUX" ]; then
    printf '\ePtmux;\e\e]133;%s\a\e\\' "$1"
  else
    printf '\e]133;%s\a' "$1"
  fi
}

__th_emit_C() {
  [ -e "$__th_state_file" ] || return
  rm -f "$__th_state_file"
  local hex win payload
  hex=$(printf '%s' "$1" | od -An -tx1 | tr -d ' \n')
  if [ -e "${__th_state_file}.win" ]; then
    win=$(cat "${__th_state_file}.win" 2>/dev/null)
    rm -f "${__th_state_file}.win"
  fi
  if [ -n "$win" ]; then
    payload="C;$hex;$win"
  else
    payload="C;$hex"
  fi
  __th_osc "$payload"
}

PS0='$(: > "$__th_state_file" 2>/dev/null
       [ -n "$TMUX" ] && tmux display -p "#{window_id}" \
         > "${__th_state_file}.win" 2>/dev/null)'
PS1='\[$(__th_osc A)\]'"$PS1"'\[$(__th_osc B)\]'
PROMPT_COMMAND='rm -f "$__th_state_file" "${__th_state_file}.win" 2>/dev/null
                __th_osc "D;$?"'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
trap '__th_emit_C "$BASH_COMMAND"' DEBUG
```

변경점은 **PS0의 추가 라인 1줄**과 **`__th_emit_C` 본문**과 **PROMPT_COMMAND의 cleanup 1줄**. 기존 production-tested 패턴(PS0 file marker, hex encoding, tmux DCS passthrough, arm/disarm)을 그대로 유지.

### tmux 훅

```tmux
# ~/.tmux.conf
set-hook -g after-select-window 'run-shell "printf \"\\ePtmux;\\e\\e]133;W;#{window_id}\\a\\e\\\\\" > #{client_tty}"'
```

`after-select-window`는 `next-window`, `previous-window`, `select-window`, `select-pane -t :N` 등 모든 윈도우 활성화 변경에서 발화. 별도로 `after-new-window`도 등록할 필요는 없음 (새 윈도우 생성은 자동으로 select-window 트리거).

`#{client_tty}`로 보간되는 path는 현재 attached 클라이언트의 PTY. 출력은 셸 stdout이 아니라 클라이언트 화면(=xterm)으로 흘러감 — 셸 입력이 깨지지 않음.

DCS passthrough(`\ePtmux;...\e\\`)로 감싸서 tmux가 OSC를 외부로 forward 하도록 한다. (tmux 옵션 `allow-passthrough on`이 이미 켜져 있어야 함 — 기존 OSC 133 캡처에서 이미 의존 중.)

설정 페이지의 셸 스니펫 박스 아래에 두 번째 코드블록으로 노출하고 안내문구 첨부.

### Fallback (훅을 안 깐 경우)

훅이 없어도 OSC 133 `;C;<hex>;<winId>` payload 안에 windowId가 들어가므로 명령 캡처 시점에 패널이 자동 따라옴 ("lazy" 동기화). 즉, 훅은 *전환 즉시 패널 갱신*을 위한 옵셔널 추가 신호다. 이 동작을 spec에 명시: **훅 미설치 = 명령을 칠 때까지 패널이 이전 윈도우 버킷을 표시.**

---

## 섹션 3 — xterm 핸들러 (oscCapture)

### 페이로드 파싱

```ts
export interface Osc133Event {
  kind: 'A' | 'B' | 'C' | 'D' | 'W';
  exitCode?: number;
  commandText?: string;
  /** tmux window id like '@1' (kind 'C' or 'W'). */
  windowId?: string;
}
```

`parseOsc133Payload` 변경:
- `W;<id>` → `{ kind: 'W', windowId }`. id가 비어 있으면 null.
- `C;<hex>;<id>` → `{ kind: 'C', commandText, windowId }`. hex 디코드 실패 시 `{ kind: 'C', windowId }` (windowId는 살림).
- `C;<hex>` → 기존과 동일.
- 그 외 알 수 없는 head 또는 형식 → null (현재와 동일).

`Osc133State`에 `currentWindowKey: string | null` 추가:
- `onWindowSelect(id)` → `currentWindowKey = 'tmux:' + id`. 이벤트 발화.
- `consumeCommandOnExecute` 시점에 `commandText` event에 `windowId`가 있으면 `currentWindowKey`도 갱신 (lazy 동기화).
- tmux 외부 (windowId 없음) — `currentWindowKey = null`.

### 핸들러 디스패치

`TerminalView.svelte`에서:
```ts
case 'C':
  const cmd = evt.commandText ?? scraped;
  const winKey = evt.windowId ? 'tmux:' + evt.windowId : null;
  if (winKey !== state.currentWindowKey) {
    state.currentWindowKey = winKey;
    panelRefresh();
  }
  if (cmd && shouldRecordCommand(cmd, blocklist)) {
    appendCommandToTerminalHistory(guid, cmd, winKey ?? undefined);
  }
  break;
case 'W':
  state.currentWindowKey = evt.windowId ? 'tmux:' + evt.windowId : null;
  panelRefresh();
  break;
```

---

## 섹션 4 — historyStore

시그니처 추가:
```ts
appendCommandToTerminalHistory(
  guid: string,
  command: string,
  windowKey?: string  // undefined / '' = non-tmux, 'tmux:@1' = tmux window @1
): void
```

내부:
- `pending` Map 키를 `${guid}:${windowKey ?? ''}` 컴포지트로 변경. 디바운스 / 직렬화는 (guid, windowKey) 쌍 단위. 동일 guid의 다른 윈도우가 동시에 쏟아내도 큐가 섞이지 않음.
- `applyBatch` 시 `splitTerminalDocByKey(doc)` → `Map<string, { headerIdx, list, items }>` 으로 모든 섹션 추출, 해당 windowKey 섹션을 read-modify-write, 다른 섹션은 손대지 않음.
- 빈 섹션은 write 시 헤더까지 통째로 제거. 기존 단일 섹션 동작(`clearHistoryFromDoc`이 섹션을 통째로 드롭)과 일치.
- `removeCommandFromTerminalHistory`, `clearTerminalHistory` 도 `windowKey` 인자 추가. 미지정 시 non-tmux 섹션.

`splitTerminalDoc` 도 다중 섹션 지원으로 확장 (기존 `splitTerminalDoc(doc)` 시그니처는 유지하되 `histories: Map<string, string[]>` 필드 추가, `historyItems`는 deprecated/aliased to `histories.get('') ?? []`).

write 시 섹션 순서: `''`(non-tmux) 먼저, 그 다음 키 정렬(`localeCompare`) 순. 결정론적이라 sync 충돌 줄임.

---

## 섹션 5 — TerminalView / HistoryPanel UI

### 상태

```ts
let currentWindowKey: string | null = $state(null);  // null = non-tmux
let allHistories: Map<string, string[]> = $state(new Map());
```

`currentWindowKey`는 OSC `W` 또는 `C+windowId`로 갱신. tmux 외부에서는 `null`로 머무름.

### 패널 렌더링

```svelte
{#snippet items()}
  {@const key = currentWindowKey ?? ''}
  {@const list = allHistories.get(key) ?? []}
  ...
{/snippet}
```

패널 헤더(작은 chip):
- `null` (tmux 외부) → "히스토리"
- `'tmux:@1'` → "히스토리 · tmux @1"

### 빈 상태

`currentWindowKey`에 해당하는 버킷이 비어 있는 경우 — "이 윈도우에서 캡처된 명령이 없습니다" 같은 안내 (기존 빈 상태와 동일한 톤). 다른 윈도우에 항목이 있어도 영향 없음.

### 노트 reload sync

`noteReloadBus.subscribeNoteReload`로 IDB 변경 받아서 `allHistories`를 다시 빌드 — 기존 패턴 그대로. windowKey별 분리된 view라서 디바운스 race도 영향 없음.

### 클릭 동작

기존과 동일 (click = stage to prompt, Shift+click = stage + send `\r`). 윈도우 키와 무관.

---

## 섹션 6 — 설정 페이지

`/settings → 터미널` 탭의 셸 스니펫 박스를 새 버전(섹션 2)으로 교체. 그 아래에:

> **tmux 사용자 (선택):** 윈도우 전환 즉시 패널을 동기화하려면 다음을 `~/.tmux.conf` 에 추가:
>
> ```tmux
> set-hook -g after-select-window 'run-shell ...'
> ```
>
> 추가하지 않아도 명령을 입력하는 시점에는 자동으로 동기화됩니다.

복사 버튼 동일 패턴.

---

## 섹션 7 — 불변식 (CLAUDE.md 추가)

새로 추가될 invariants:

- **`history:` (non-tmux) 와 `history:tmux:<key>:` 는 독립 버킷.** dedup·cap·디바운스 모두 버킷별. cross-bucket dedup 절대 도입하지 않는다.
- **윈도우 키 = `@<window_id>` 만.** session_id를 키에 섞지 않는다 — 키 안정성을 window 수명에 묶기 위함.
- **OSC 133 `;W;<id>` 는 옵셔널 신호.** 미수신 시 `;C;<hex>;<id>` payload의 windowId만으로도 동작해야 함.
- **`after-select-window` 훅은 사용자 책임.** 기본 셸 스니펫만 깔아도 lazy 동기화로 동작; 훅은 즉시 동기화용 부가 옵션.
- **빈 섹션은 직렬화 시 헤더까지 통째로 제거.** `clearTerminalHistory(guid, key)`도 같은 결과 — 해당 섹션 흔적이 본문에서 사라진다.

---

## 섹션 8 — 테스트 전략

- `parseTerminalNote.test.ts` — 멀티 섹션 케이스 추가 (3개 섹션, 빈 섹션, 잘못된 키 헤더 fallback, 기존 단일 섹션 호환).
- `oscCapture.test.ts` — `W;<id>` 파싱, `C;<hex>;<id>` 파싱, malformed id, 빈 id rejection.
- `historyStore.test.ts` — `(guid, windowKey)` 디바운스 분리, 섹션별 cap, 다른 섹션 수정 시 비-수정 섹션 unchanged, splitTerminalDocByKey 라운드트립.
- 통합 smoke: tmux 안에서 `ls` → `history:tmux:@1:` 에 추가; 윈도우 2 전환 + `pwd` → `history:tmux:@2:` 에 추가; tmux 종료 후 `echo` → `history:` 에 추가.

훅 자체의 동작은 실제 tmux + 브릿지가 필요해 자동화 테스트에서 제외; 수동 smoke 단계에서 검증.

---

## 섹션 9 — Out of Scope

- **session_id 분리** — 같은 window_id가 다른 session에서 충돌할 수 있으나, 실사용에서 한 노트는 단일 호스트의 단일 tmux 서버에 붙는 게 일반이라 무시.
- **윈도우 이름 표시** — 패널 헤더에 `@1` 대신 사용자가 붙인 이름(`#W`)을 보여주는 건 추후 작업. 현 변경은 ID만.
- **윈도우 종료 시 버킷 cleanup** — 자동 GC 안 함. 사용자가 패널의 "이 버킷 비우기" 컨텍스트 메뉴로 수동 정리. (별도 윈도우 목록 UI도 out of scope.)
- **pane 단위** — 사용자 명시적 결정으로 제외.

---

## 작업 분해 (예비)

1. `parseTerminalNote` 다중 섹션 + `histories: Map`.
2. `oscCapture` `W` 이벤트 + `C;hex;id` 페이로드.
3. `historyStore` 멀티-키 분기 + `splitTerminalDocByKey` + 빈 섹션 처리.
4. `TerminalView` + `HistoryPanel`: `currentWindowKey` state, W 핸들러, 헤더 chip, 빈상태.
5. 설정 페이지: 새 셸 스니펫 + tmux 훅 안내 블록.
6. CLAUDE.md + tomboy-terminal SKILL.md: 새 invariants 반영.

각 task는 TDD로 따로 묶이고 commit 단위.
