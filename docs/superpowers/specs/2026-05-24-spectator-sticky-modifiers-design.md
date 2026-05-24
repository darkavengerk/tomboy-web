# 관전 모드 sticky modifier 버튼 설계

> 2026-05-24

## 배경

데스크탑 관전 모드의 capture-phase keydown 리스너 (`TerminalView.svelte:handleWindowKeydown`,
줄 429–443)는 `Ctrl+H`/`Ctrl+L`을 prev/next-pane으로,
`Ctrl+Shift+H`/`Ctrl+Shift+L`을 prev/next-window로 가로챈다. xterm의
textarea 핸들러보다 먼저 발화하므로 이 조합들은 절대 셸에 도달하지 못한다.

문제는 `Ctrl+L`이 셸의 표준 "화면 클리어" 단축키와 정면충돌한다는 점이다.
관전 노트에서 셸을 클리어할 방법이 없다 — 모바일이라면 보내기 팝업의
텍스트 입력에 `l`을 입력하고 사후 Ctrl과 조합해서 보낼 방법조차 현재 없다
(팝업 퀵키는 `^C`만 명시 시퀀스로 제공).

본 설계는 관전 모드 전용 **sticky modifier** 메커니즘을 도입한다 — 푸터
오른쪽에 토글 칩 3개(Ctrl/Alt/Shift)를 두고, 칩을 눌러 무장한 상태에서
다음 키 한 번에 modifier가 적용된다. 일반 OS의 "고정 키" 접근성 기능과 동일한
멘탈 모델이며, 데스크탑 관전 모드의 pane-nav 단축키를 우회하는 명시적
opt-in 경로를 제공한다.

## 비목표

- 셸 모드(`ssh://`)에 칩 노출 — 셸 모드는 `term.onData` 직결이라 충돌 없음
- 일반 노트 / 비관전 터미널에 sticky 키 도입
- 노트 포맷 변경 (sticky는 순수 휘발성 UI 상태)
- 숫자행/기호의 Ctrl 매핑 (예: `Ctrl+@`=`\x00`) — v1에서는 글자 위주
- 기존 `Ctrl+H`/`Ctrl+L`/`Ctrl+Shift+H`/`Ctrl+Shift+L` pane-nav 단축키
  제거 — sticky는 **추가 메커니즘**이지 대체가 아니다

## UX 모델

### 무장/해제

- 칩 클릭 = 해당 mod의 armed 상태 토글 (한 번 더 누르면 해제)
- 여러 mod 동시 armed 가능 (Ctrl+Alt+x 등)
- "다음 키 한 번에 소비" 의미론. 단, 비대응 키 조합에서는 **유지**.

### 키 소비 규칙

| armed mods + 입력 키 | 동작 |
|---|---|
| 글자 `a`–`z` + Ctrl | `letter & 0x1F` 전송, 모든 armed 해제 |
| 글자 + Alt | `\x1b` + 글자(케이스 적용) 전송, 모든 armed 해제 |
| 글자 + Ctrl+Alt | `\x1b` + Ctrl 바이트 전송, armed 해제 |
| 글자 + Shift 단독 | 대문자 글자 전송, armed 해제 |
| 글자 + Ctrl+Shift | Ctrl 바이트 전송 (ASCII 컨트롤은 shift 구분 안 됨), armed 해제 |
| Enter/Backspace/ESC/Tab + Alt | `\x1b` + 원래 시퀀스 전송, armed 해제 |
| 비대응 조합 (예: armed Ctrl + Tab) | **armed 유지** + 원래 키 정상 전송 |
| armed 없음 | 기존 동작 (pane-nav 단축키 + xterm 기본 처리) |

비대응 조합에서 armed를 유지하는 이유: 사용자가 의도치 않은 키를 누른
경우(예: 관전 중 ESC) sticky가 자동 소비되어 사라지면 더 혼란스럽다.
시각적 armed 표시가 켜진 채 남아 있으니 사용자는 칩을 다시 눌러 해제하거나
실제 의도한 글자 키를 이어 누르면 된다.

### 기존 pane-nav 단축키와의 관계

- 실제 키보드 `Ctrl+L` (real ctrlKey=true) → 기존 그대로 next-pane
- sticky Ctrl armed + 키보드 `L` (real ctrlKey=false) → 셸로 `\x0c` 전송
- sticky Ctrl armed + 키보드 `Ctrl+L` (둘 다 true) → sticky 분기가 먼저
  매치하므로 셸로 `\x0c` 전송, sticky 해제 (사용자가 명시적으로 sticky를
  켰다는 점을 의도로 해석)

이는 sticky가 pane-nav 단축키 검사 **이전에** 배치되기 때문이다. 단축키
삭제 없이 우회 경로만 추가한다.

## UI 배치

`.spec-windowbar` (관전 푸터 윗줄) 내부에 윈도우 라벨 오른쪽으로 칩 3개:

```
┌─ .spec-footer ──────────────────────────────────────────┐
│  .spec-windowbar  [3] dev          [Ctrl] [Alt] [Shift] │
│  .spec-controls   « ‹ › »                       [보내기] │
└─────────────────────────────────────────────────────────┘
```

- `.spec-windowbar`를 `display: flex; justify-content: space-between`로
  변경하고, 칩 그룹은 `.sticky-mods` 컨테이너로 묶음
- 좁은 모바일에서 윈도우 이름이 길면 칩 그룹이 자동 줄바꿈 (flex-wrap)
- 칩 시각:
  - 디스암: outline (`border`, 투명 배경)
  - 암: filled (배경 강조 색상, 텍스트 반전)
- `aria-pressed={mods.ctrl}` / `aria-label="Ctrl 키 sticky"` 등
- `disabled={status !== 'open'}` — 연결되지 않은 상태에서는 비활성

칩은 셸 모드에서는 렌더되지 않음 (`{#if isSpectator}` 안에 위치하므로 자연 해결).

## 데스크탑 통합 (`handleWindowKeydown`)

기존 함수를 다음 구조로 변경:

```ts
function handleWindowKeydown(e: KeyboardEvent): void {
  if (!isSpectator || isMobile || !client || !pageEl) return;
  const active = document.activeElement;
  if (active && active !== document.body && !pageEl.contains(active)) return;

  // 1. sticky 분기 — 무장된 mod가 있으면 먼저 시도
  if (stickyMods.ctrl || stickyMods.alt || stickyMods.shift) {
    const seq = computeStickyKeySequence(e, stickyMods);
    if (seq !== null) {
      client.send(seq);
      stickyMods = { ctrl: false, alt: false, shift: false };
      e.preventDefault();
      e.stopPropagation();
    }
    // 비대응 키(seq === null)면 preventDefault/stopPropagation 안 함
    // → 캡처가 끝나고 target 단계에서 xterm이 정상 처리.
    // pane-nav 분기로는 떨어지지 않게 무조건 return.
    return;
  }

  // 2. 기존 pane-nav 분기 (변경 없음)
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'h' && k !== 'l') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) {
    tmuxNav(k === 'h' ? 'prev-window' : 'next-window');
  } else {
    tmuxNav(k === 'h' ? 'prev-pane' : 'next-pane');
  }
}
```

**비대응 키 처리 동작**: capture-phase에서 `preventDefault`/`stopPropagation`
없이 함수만 종료하면 이벤트가 그대로 진행되어 xterm의 textarea 리스너가
target 단계에서 정상 처리한다. 결과:

- armed Ctrl + Tab → Ctrl sticky 유지, Tab은 xterm을 통해 셸로 전송 (탭 완성)
- armed Ctrl + ESC → Ctrl sticky 유지, ESC는 셸로 전송
- armed Alt + 글자 → 매칭 → `\x1b + 글자` 전송, sticky 해제

## 모바일 통합 (보내기 팝업)

### 팝업 UI

- 팝업 헤더 영역에 현재 armed 상태 뱃지:
  ```
  ┌─ 보내기 ──────────────────────┐
  │ [Ctrl+] 다음 키에 적용됩니다  │  ← armed 상태가 있을 때만 표시
  │ ─────────────────────────── │
  │ [텍스트 입력란]              │
  │ y ↵ n ↵ 1 Esc ^C PgUp PgDn  │
  │ [취소] [타이핑만] [엔터로 실행] │
  └─────────────────────────────┘
  ```
- 푸터 칩은 팝업이 열려 있어도 동일하게 보이고 토글 가능 (모달이지만
  비차단 — 칩은 .spec-footer에 있고 팝업은 별도 overlay)

### 퀵키 동작 (변경 없음)

- `y / ↵ / n / 1 / Esc / ^C / PgUp / PgDn` 모두 명시적 시퀀스 — armed mod는
  **무시되고 유지**됨
- 사용자가 sticky를 활성화한 채 퀵키를 누르면 sticky는 그대로 남고
  퀵키만 보냄. 의도된 동작 (UX 답변 #2 "sticky 유지").

### 텍스트 입력 동작

- "타이핑만" / "엔터로 실행" 양쪽 모두 armed 적용
- **첫 바이트에만** modifier 적용, 나머지는 원본 그대로
  - 예: armed Ctrl + 텍스트 `"l"` + "엔터로 실행" → `\x0c\r`
  - 예: armed Ctrl + 텍스트 `"ls"` + "엔터로 실행" → `\x0c` + `s\r`
    (실제 효과: 클리어 → `s` 실행. 예외적 케이스로 가이드 문서화)
  - 예: armed Alt + 텍스트 `"."` + "엔터로 실행" → `\x1b.\r`
    (이전 인자 — zsh/bash에서 유용)
- 첫 바이트가 비대응 조합이면 sticky 유지 + 텍스트 그대로 전송
- 전송 성공(대응 조합) → sticky 해제

### 빈 텍스트 + 엔터로 실행

- 텍스트가 비어 있고 "엔터로 실행"만 누른 경우 → `\r` 한 바이트
- `\r`은 비대응 (글자 아님, Alt+Enter는 대응이지만 Ctrl+Enter는 아님)
- Alt armed라면 `\x1b\r` 전송 후 해제
- Ctrl/Shift만 armed라면 `\r` 그대로 전송, sticky 유지

## `computeStickyKeySequence` 명세

새 모듈 `app/src/lib/editor/terminal/stickyMods.ts`:

```ts
export interface StickyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Compute the byte sequence to send for `event` when one or more
 * sticky modifiers are armed. Returns null when the combination is not
 * supported (caller should leave sticky armed and let the key fall
 * through to its default handling).
 *
 * Reads only `event.key`, never `event.code`. Real modifier keys
 * (`event.ctrlKey` / `altKey` / `shiftKey`) are NOT consulted — if you
 * need real modifiers to combine with armed sticky state, merge them
 * into `sticky` at the call site before invoking. In practice the
 * spectator integration enters this branch only when no real Ctrl is
 * pressed (the pane-nav check below `e.ctrlKey`), so additive merging
 * is not needed for the actual use case.
 */
export function computeStickyKeySequence(
  event: KeyboardEvent,
  sticky: StickyMods
): string | null;

/**
 * Mobile-popup variant. Same rules but operates on the first character
 * of a string. Returns the full transformed string (first byte
 * modified, rest verbatim) when the first byte is supported; null
 * otherwise.
 *
 * Empty input returns null (caller sends as-is).
 */
export function applyStickyToText(
  text: string,
  sticky: StickyMods
): string | null;
```

### 대응 키 표

`event.key`의 종류로 분류. **letter** = `a`–`z`/`A`–`Z` 한 글자.
**printable** = letter가 아니지만 `key.length === 1` (숫자, 기호, 공백 등).

| 키 종류 | Ctrl | Alt | Ctrl+Alt | Shift 단독 | Ctrl+Shift |
|---|---|---|---|---|---|
| letter | `c & 0x1F` | `\x1b` + c | `\x1b` + (c&0x1F) | `upper(c)` | (c&0x1F) |
| printable (숫자/기호) | null | `\x1b` + c | null | c 그대로 | null |
| `Enter` | null | `\x1b\r` | null | null | null |
| `Backspace` | null | `\x1b\x7f` | null | null | null |
| `Escape` | null | `\x1b\x1b` | null | null | null |
| `Tab` | null | `\x1b\t` | null | null | null |
| 그 외 (화살표, F-키 등) | null | null | null | null | null |

null = 비대응 → 데스크탑에서는 fall-through, 모바일에서는 sticky 유지 + 원본 전송.

`Shift 단독 + printable`이 `c 그대로`인 이유: 모바일에서 사용자가 키보드로
이미 대문자 `S`를 입력했다면 그대로 보내면 됨. `c`가 이미 shifted 문자라는
가정. (브라우저의 `event.key`는 shift 상태를 반영한 값을 제공.)

`Alt + printable`이 유용한 이유: zsh/bash의 `Alt+.` (이전 인자), `Alt+#`
(주석 처리) 등이 `\x1b<char>` 시퀀스로 전송됨. 실제 키보드의 Alt는 우리
핸들러가 가로채지 않아도 xterm이 처리하지만, sticky-Alt로 한 손가락
입력하는 경로를 제공.

### 테스트 케이스 (`app/tests/unit/editor/stickyMods.test.ts`)

- letter:
  - `Ctrl + l` → `\x0c`
  - `Ctrl + a` → `\x01`
  - `Ctrl + L` (대문자 입력) → `\x0c` (대소문자 무시)
  - `Shift + a` → `A`
  - `Ctrl+Shift + h` → `\x08`
  - `Ctrl+Alt + l` → `\x1b\x0c`
  - `Alt + a` → `\x1ba`
- printable:
  - `Alt + .` → `\x1b.`
  - `Alt + 1` → `\x1b1`
  - `Ctrl + .` → null
  - `Shift + 1` → `1` (이미 shift 적용된 문자라 가정)
- 특수 키:
  - `Alt + Enter` → `\x1b\r`
  - `Alt + Backspace` → `\x1b\x7f`
  - `Ctrl + Enter` → null
  - `Ctrl + Tab` → null
- armed 없음:
  - `Ctrl: false, ... + l` → null (sticky 무장 안 됨)
- `applyStickyToText`:
  - armed Ctrl + `"l"` → `"\x0c"`
  - armed Ctrl + `"ls"` → `"\x0cs"` (첫 글자만 변환)
  - armed Alt + `"."` → `"\x1b."`
  - armed Ctrl + `"1ls"` → null (첫 글자 비대응)
  - armed 없음 + `"l"` → null
  - 빈 문자열 + 어떤 armed든 → null

## 데이터 / 상태

- `TerminalView.svelte`의 `let stickyMods = $state<StickyMods>({ ctrl: false, alt: false, shift: false })`
- 영속화 없음 — 노트 닫으면 휘발
- 재연결 시 reset (혼동 방지)
- 셸 모드로 모드 전환 (이론적; 현재 코드에서는 모드 전환 없음) 시 reset

## 파일 변경 요약

| 파일 | 변경 종류 | 내용 |
|---|---|---|
| `app/src/lib/editor/terminal/stickyMods.ts` | 신규 | `computeStickyKeySequence`, `applyStickyToText`, `StickyMods` 타입 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | 수정 | `stickyMods` state, 푸터 칩 UI, `handleWindowKeydown` sticky 분기, `sendPopupSubmit` sticky 적용, 팝업 헤더 armed 뱃지 |
| `app/tests/unit/editor/stickyMods.test.ts` | 신규 | 매핑 규칙 단위 테스트 |
| `.claude/skills/tomboy-terminal/SKILL.md` | 수정 | sticky modifier 섹션 추가, 관전 모드 invariant 갱신 |
| `CLAUDE.md` | 수정 | 터미널 노트 섹션의 관전 모드 설명에 sticky 메커니즘 한 줄 추가 |

## 마이그레이션 / 호환성

- 기존 동작은 변경되지 않음 (sticky가 무장 안 된 기본 경로는 그대로)
- 노트 포맷 변경 없음
- 브릿지 변경 없음 — WS 프로토콜은 기존 `{type:'data', d:...}` 그대로 사용

## 향후 작업 (out of scope)

- 숫자/기호의 Ctrl 매핑 (`Ctrl+@`=`\x00`, `Ctrl+[`=`\x1b`, `Ctrl+]`=`\x1d`,
  `Ctrl+\\`=`\x1c`, `Ctrl+/`=`\x1f`, `Ctrl+_`=`\x1f`)
- F1–F12 + sticky
- 화살표 + Alt (xterm 시퀀스 `\x1b\x1b[A` 형태)
- 노트별 sticky 기본값 (예: 노트 메타에 `sticky: ctrl` 명시)
