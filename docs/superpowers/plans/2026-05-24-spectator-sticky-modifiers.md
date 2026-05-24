# 관전 모드 sticky modifier 버튼 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관전 모드에서 Ctrl/Alt/Shift 토글 칩을 통해 modifier 키를 임의 키에 적용할 수 있게 하여, 데스크탑의 `Ctrl+L` pane-nav 충돌 같은 시나리오를 우회한다.

**Architecture:** 순수 함수 모듈(`stickyMods.ts`)이 키→바이트 매핑을 담당하고, `TerminalView.svelte`가 armed 상태(`$state`) + 칩 UI + 데스크탑/모바일 입력 경로 통합을 담당한다. 셸 모드/노트 포맷/브릿지에는 변경이 없다.

**Tech Stack:** Svelte 5 runes, xterm.js, vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-24-spectator-sticky-modifiers-design.md`

---

## 파일 구조

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/terminal/stickyMods.ts` | **신규** — `StickyMods` 타입, `computeStickyKeySequence`, `applyStickyToText` |
| `app/tests/unit/editor/stickyMods.test.ts` | **신규** — 매핑 단위 테스트 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | **수정** — sticky 상태 + 칩 UI + keydown 분기 + 팝업 통합 |
| `.claude/skills/tomboy-terminal/SKILL.md` | **수정** — sticky 섹션 + invariant 추가 |
| `CLAUDE.md` | **수정** — 터미널 노트 섹션 한 줄 추가 |

각 Task는 하나의 커밋으로 마무리한다.

---

## Task 1: `stickyMods.ts` 순수 함수 + 단위 테스트

**Goal:** 키→바이트 매핑 로직을 순수 함수로 분리하고 vitest로 검증한다.

**Files:**
- Create: `app/src/lib/editor/terminal/stickyMods.ts`
- Create: `app/tests/unit/editor/stickyMods.test.ts`

**Acceptance Criteria:**
- [ ] `StickyMods` 타입 export — `{ ctrl: boolean; alt: boolean; shift: boolean }`
- [ ] `computeStickyKeySequence(event, sticky)` 함수 — 모든 대응/비대응 케이스 동작
- [ ] `applyStickyToText(text, sticky)` 함수 — 첫 글자 변환 + 비대응 시 null
- [ ] `armed 없음`이면 두 함수 모두 null 반환
- [ ] `computeStickyKeySequence`는 `event.key` 기준 (case-insensitive for letter)
- [ ] 18개 이상 테스트 케이스 통과 (아래 Step 1 참고)

**Verify:** `cd app && npm run test -- stickyMods` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/stickyMods.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  computeStickyKeySequence,
  applyStickyToText,
  type StickyMods
} from '$lib/editor/terminal/stickyMods.js';

function ev(key: string): KeyboardEvent {
  return { key } as unknown as KeyboardEvent;
}

const NONE: StickyMods = { ctrl: false, alt: false, shift: false };
const CTRL: StickyMods = { ctrl: true, alt: false, shift: false };
const ALT: StickyMods = { ctrl: false, alt: true, shift: false };
const SHIFT: StickyMods = { ctrl: false, alt: false, shift: true };
const CTRL_ALT: StickyMods = { ctrl: true, alt: true, shift: false };
const CTRL_SHIFT: StickyMods = { ctrl: true, alt: false, shift: true };

describe('computeStickyKeySequence — letter', () => {
  it('Ctrl + l → \\x0c', () => {
    expect(computeStickyKeySequence(ev('l'), CTRL)).toBe('\x0c');
  });

  it('Ctrl + L (uppercase) → \\x0c', () => {
    expect(computeStickyKeySequence(ev('L'), CTRL)).toBe('\x0c');
  });

  it('Ctrl + a → \\x01', () => {
    expect(computeStickyKeySequence(ev('a'), CTRL)).toBe('\x01');
  });

  it('Alt + a → \\x1ba', () => {
    expect(computeStickyKeySequence(ev('a'), ALT)).toBe('\x1ba');
  });

  it('Alt + A (uppercase preserved) → \\x1bA', () => {
    expect(computeStickyKeySequence(ev('A'), ALT)).toBe('\x1bA');
  });

  it('Shift + a → A', () => {
    expect(computeStickyKeySequence(ev('a'), SHIFT)).toBe('A');
  });

  it('Ctrl+Alt + l → \\x1b\\x0c', () => {
    expect(computeStickyKeySequence(ev('l'), CTRL_ALT)).toBe('\x1b\x0c');
  });

  it('Ctrl+Shift + h → \\x08', () => {
    expect(computeStickyKeySequence(ev('h'), CTRL_SHIFT)).toBe('\x08');
  });
});

describe('computeStickyKeySequence — printable non-letter', () => {
  it('Alt + . → \\x1b.', () => {
    expect(computeStickyKeySequence(ev('.'), ALT)).toBe('\x1b.');
  });

  it('Alt + 1 → \\x1b1', () => {
    expect(computeStickyKeySequence(ev('1'), ALT)).toBe('\x1b1');
  });

  it('Ctrl + . → null (Ctrl+printable not supported)', () => {
    expect(computeStickyKeySequence(ev('.'), CTRL)).toBeNull();
  });

  it('Shift + 1 → "1" (shifted char already in event.key)', () => {
    expect(computeStickyKeySequence(ev('1'), SHIFT)).toBe('1');
  });
});

describe('computeStickyKeySequence — special keys', () => {
  it('Alt + Enter → \\x1b\\r', () => {
    expect(computeStickyKeySequence(ev('Enter'), ALT)).toBe('\x1b\r');
  });

  it('Alt + Backspace → \\x1b\\x7f', () => {
    expect(computeStickyKeySequence(ev('Backspace'), ALT)).toBe('\x1b\x7f');
  });

  it('Alt + Escape → \\x1b\\x1b', () => {
    expect(computeStickyKeySequence(ev('Escape'), ALT)).toBe('\x1b\x1b');
  });

  it('Alt + Tab → \\x1b\\t', () => {
    expect(computeStickyKeySequence(ev('Tab'), ALT)).toBe('\x1b\t');
  });

  it('Ctrl + Enter → null', () => {
    expect(computeStickyKeySequence(ev('Enter'), CTRL)).toBeNull();
  });

  it('Ctrl + Tab → null', () => {
    expect(computeStickyKeySequence(ev('Tab'), CTRL)).toBeNull();
  });

  it('Ctrl + ArrowLeft → null', () => {
    expect(computeStickyKeySequence(ev('ArrowLeft'), CTRL)).toBeNull();
  });
});

describe('computeStickyKeySequence — armed 없음', () => {
  it('no mods + l → null', () => {
    expect(computeStickyKeySequence(ev('l'), NONE)).toBeNull();
  });
});

describe('applyStickyToText', () => {
  it('Ctrl + "l" → "\\x0c"', () => {
    expect(applyStickyToText('l', CTRL)).toBe('\x0c');
  });

  it('Ctrl + "ls" → "\\x0cs" (first char transformed)', () => {
    expect(applyStickyToText('ls', CTRL)).toBe('\x0cs');
  });

  it('Alt + "." → "\\x1b."', () => {
    expect(applyStickyToText('.', ALT)).toBe('\x1b.');
  });

  it('Ctrl + "1ls" → null (first char not supported)', () => {
    expect(applyStickyToText('1ls', CTRL)).toBeNull();
  });

  it('no mods + "l" → null', () => {
    expect(applyStickyToText('l', NONE)).toBeNull();
  });

  it('any mods + "" → null', () => {
    expect(applyStickyToText('', CTRL)).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- stickyMods 2>&1 | tail -20`
Expected: FAIL — 모듈/함수가 정의되지 않음 ("Cannot find module" 또는 "is not a function")

- [ ] **Step 3: 모듈 구현**

`app/src/lib/editor/terminal/stickyMods.ts`:

```ts
export interface StickyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const SPECIAL_KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Escape: '\x1b',
  Tab: '\t'
};

function isLetter(key: string): boolean {
  return key.length === 1 && /[a-zA-Z]/.test(key);
}

function isPrintable(key: string): boolean {
  return key.length === 1;
}

function ctrlByteForLetter(letter: string): string {
  return String.fromCharCode(letter.toLowerCase().charCodeAt(0) & 0x1f);
}

function transformChar(key: string, sticky: StickyMods): string | null {
  const anyArmed = sticky.ctrl || sticky.alt || sticky.shift;
  if (!anyArmed) return null;

  if (isLetter(key)) {
    if (sticky.ctrl && sticky.alt) return '\x1b' + ctrlByteForLetter(key);
    if (sticky.ctrl) return ctrlByteForLetter(key);
    if (sticky.alt) return '\x1b' + key;
    if (sticky.shift) return key.toUpperCase();
    return null;
  }

  if (isPrintable(key)) {
    if (sticky.alt && !sticky.ctrl) return '\x1b' + key;
    if (sticky.shift && !sticky.ctrl && !sticky.alt) return key;
    return null;
  }

  const special = SPECIAL_KEY_BYTES[key];
  if (special !== undefined) {
    if (sticky.alt && !sticky.ctrl && !sticky.shift) return '\x1b' + special;
    return null;
  }

  return null;
}

export function computeStickyKeySequence(
  event: KeyboardEvent,
  sticky: StickyMods
): string | null {
  return transformChar(event.key, sticky);
}

export function applyStickyToText(
  text: string,
  sticky: StickyMods
): string | null {
  if (text.length === 0) return null;
  const first = text[0];
  const transformed = transformChar(first, sticky);
  if (transformed === null) return null;
  return transformed + text.slice(1);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- stickyMods 2>&1 | tail -30`
Expected: PASS — 모든 테스트 통과 (24개 이상)

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check 2>&1 | tail -20`
Expected: 새 오류 없음 (기존 경고는 무시)

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/terminal/stickyMods.ts app/tests/unit/editor/stickyMods.test.ts
git commit -m "feat(terminal): sticky modifier 키→바이트 매핑 + 단위 테스트"
```

---

## Task 2: 푸터 sticky 칩 UI + state

**Goal:** 관전 모드 푸터 윈도우 라벨 오른쪽에 Ctrl/Alt/Shift 토글 칩 3개를 렌더하고 클릭으로 armed 상태를 토글한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (state 추가, `.spec-windowbar` 마크업/CSS 변경)

**Acceptance Criteria:**
- [ ] `stickyMods = $state<StickyMods>({ ctrl: false, alt: false, shift: false })` 선언
- [ ] 관전 모드(`isSpectator === true`)에서 `.spec-windowbar` 안에 칩 3개 렌더
- [ ] 셸 모드에서는 칩이 렌더되지 않음 (`{#if isSpectator}` 가드 안)
- [ ] 칩 클릭 시 해당 mod 토글; armed 상태가 시각적으로 (filled 배경) 구분됨
- [ ] `aria-pressed`, `aria-label` 속성 정확
- [ ] 좁은 모바일 뷰포트(<= 360px)에서 칩이 줄바꿈됨 (flex-wrap)
- [ ] `status !== 'open'`일 때 칩 비활성화 (`disabled` 속성)

**Verify:** 수동 — `cd app && npm run dev`로 띄우고 관전 노트(`ssh://... + spectate: ...`)에서 칩 토글 확인. 셸 노트에서 칩이 없는지 확인.

**Steps:**

- [ ] **Step 1: state 선언 추가**

`TerminalView.svelte`의 기존 `let isMobile = $state(false);` 근처 (대략 줄 68–87)에 추가:

```svelte
import { type StickyMods } from './stickyMods.js';

let stickyMods = $state<StickyMods>({ ctrl: false, alt: false, shift: false });

function toggleStickyMod(mod: keyof StickyMods): void {
  stickyMods = { ...stickyMods, [mod]: !stickyMods[mod] };
}

function resetStickyMods(): void {
  stickyMods = { ctrl: false, alt: false, shift: false };
}
```

(`StickyMods` 타입 import 경로는 `.js` 확장자로 SvelteKit 컨벤션 따름.)

- [ ] **Step 2: `.spec-windowbar` 마크업 수정**

기존 (대략 줄 908–915):

```svelte
<div class="spec-windowbar" aria-live="polite">
  {#if spectatorWindowIndex || spectatorWindowName}
    <span class="win-idx">{spectatorWindowIndex}</span>
    <span class="win-name">{spectatorWindowName || '(이름 없음)'}</span>
  {:else}
    <span class="win-placeholder">윈도우 정보 대기 중…</span>
  {/if}
</div>
```

다음으로 교체:

```svelte
<div class="spec-windowbar" aria-live="polite">
  <div class="win-label">
    {#if spectatorWindowIndex || spectatorWindowName}
      <span class="win-idx">{spectatorWindowIndex}</span>
      <span class="win-name">{spectatorWindowName || '(이름 없음)'}</span>
    {:else}
      <span class="win-placeholder">윈도우 정보 대기 중…</span>
    {/if}
  </div>
  <div class="sticky-mods" role="group" aria-label="고정 modifier 키">
    <button
      type="button"
      class="sticky-chip"
      class:armed={stickyMods.ctrl}
      aria-pressed={stickyMods.ctrl}
      aria-label="Ctrl 키 고정"
      title="다음 키에 Ctrl 적용 (한 번 더 누르면 해제)"
      onclick={() => toggleStickyMod('ctrl')}
      disabled={status !== 'open'}
    >Ctrl</button>
    <button
      type="button"
      class="sticky-chip"
      class:armed={stickyMods.alt}
      aria-pressed={stickyMods.alt}
      aria-label="Alt 키 고정"
      title="다음 키에 Alt 적용"
      onclick={() => toggleStickyMod('alt')}
      disabled={status !== 'open'}
    >Alt</button>
    <button
      type="button"
      class="sticky-chip"
      class:armed={stickyMods.shift}
      aria-pressed={stickyMods.shift}
      aria-label="Shift 키 고정"
      title="다음 키에 Shift 적용"
      onclick={() => toggleStickyMod('shift')}
      disabled={status !== 'open'}
    >Shift</button>
  </div>
</div>
```

- [ ] **Step 3: CSS 추가**

`<style>` 블록의 `.spec-windowbar` 정의를 찾아 다음으로 변경 (없으면 추가):

```css
.spec-windowbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.win-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sticky-mods {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.sticky-chip {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  border-radius: 999px;
  cursor: pointer;
  line-height: 1;
  min-height: 1.5rem;
}

.sticky-chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sticky-chip.armed {
  background: currentColor;
  color: var(--terminal-bg, #1e1e1e);
}

.sticky-chip:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}
```

기존 `.spec-windowbar` 정의가 이미 다른 속성(background, padding 등)을 가지고 있으면 그것들은 보존하고 위 flex 규칙만 합친다. 정확한 기존 CSS는 파일을 읽어 확인할 것.

- [ ] **Step 4: 수동 검증 — 관전 모드 칩 렌더**

Run: `cd app && npm run dev`
브라우저에서 관전 노트 열기 (예: `ssh://you@host` 다음줄에 `spectate: <session>`).
관전 푸터의 윈도우 라벨 오른쪽에 [Ctrl] [Alt] [Shift] 칩 3개 보이는지 확인.
각 칩 클릭 → 배경이 채워지고 (armed 시각), 다시 클릭 → 비워지는지 확인.

- [ ] **Step 5: 수동 검증 — 셸 모드 칩 없음**

브라우저에서 일반 셸 노트 열기 (`ssh://you@host`만; `spectate:` 없음).
푸터 자체가 없거나, 있어도 sticky 칩은 없는지 확인 (`{#if isSpectator}` 가드).

- [ ] **Step 6: 타입 체크**

Run: `cd app && npm run check 2>&1 | tail -20`
Expected: 새 오류 없음

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 관전 모드 푸터에 sticky modifier 칩 UI"
```

---

## Task 3: 데스크탑 keydown sticky 분기

**Goal:** 데스크탑 관전 모드 keydown 리스너에 sticky 분기를 추가하여, armed 상태에서 키 입력 시 변환된 바이트가 셸로 전송되고 sticky가 자동 해제되도록 한다. 기존 pane-nav 단축키는 보존.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (`handleWindowKeydown` 함수 — 대략 줄 429–443)

**Acceptance Criteria:**
- [ ] sticky 분기가 pane-nav 검사 **이전**에 위치
- [ ] armed 상태에서 letter 키 → `computeStickyKeySequence` 결과를 `client.send`, sticky 모두 해제, `preventDefault`/`stopPropagation`
- [ ] armed 상태에서 비대응 키 (예: Tab) → sticky 유지, 이벤트 그대로 진행 (xterm이 처리)
- [ ] armed 없음 → 기존 pane-nav 분기 그대로 (실제 Ctrl+L → next-pane 작동)
- [ ] 재연결 시 sticky 리셋 (`resetStickyMods()` 호출)

**Verify:** 수동 — 데스크탑 관전 노트에서 (1) [Ctrl] 칩 클릭 후 `L` 키 누르면 원격 셸 클리어 + 칩 해제 (2) 실제 Ctrl+L (키보드) 누르면 next-pane 작동 (3) [Ctrl] 칩 클릭 후 Tab 누르면 셸이 탭 완성 + 칩 유지

**Steps:**

- [ ] **Step 1: `computeStickyKeySequence` import 추가**

`TerminalView.svelte` 상단 import 영역에:

```svelte
import {
  computeStickyKeySequence,
  applyStickyToText,
  type StickyMods
} from './stickyMods.js';
```

(Task 2에서 `StickyMods`만 import했다면 같은 라인을 확장.)

- [ ] **Step 2: `handleWindowKeydown` 수정**

기존 함수 (대략 줄 429–443)를 다음으로 교체:

```ts
function handleWindowKeydown(e: KeyboardEvent): void {
  if (!isSpectator || isMobile || !client || !pageEl) return;
  const active = document.activeElement;
  if (active && active !== document.body && !pageEl.contains(active)) return;

  // sticky 분기 — pane-nav 검사 이전
  if (stickyMods.ctrl || stickyMods.alt || stickyMods.shift) {
    const seq = computeStickyKeySequence(e, stickyMods);
    if (seq !== null) {
      client.send(seq);
      resetStickyMods();
      e.preventDefault();
      e.stopPropagation();
    }
    // 비대응 키: preventDefault/stopPropagation 안 함 →
    // xterm이 target 단계에서 정상 처리. sticky는 유지.
    return;
  }

  // 기존 pane-nav 단축키 (변경 없음)
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

- [ ] **Step 3: 재연결 시 sticky 리셋**

`reconnect()` 함수를 찾아 첫 줄에 추가:

```ts
function reconnect(): void {
  resetStickyMods();
  // ... 기존 로직
}
```

(파일에서 `function reconnect` 검색해서 정확한 위치 확인.)

- [ ] **Step 4: 수동 검증 — sticky-Ctrl + L = 클리어**

Run: `cd app && npm run dev`
데스크탑 관전 노트 열어 연결.
원격 셸에 `echo line1; echo line2` 등 출력 만들고 → [Ctrl] 칩 클릭 → 키보드에서 `L` 누름 → 화면 클리어되는지 확인.
[Ctrl] 칩이 자동으로 디스암(outline 상태)으로 돌아갔는지 확인.

- [ ] **Step 5: 수동 검증 — 실제 Ctrl+L = next-pane (회귀 없음)**

칩 모두 디스암 상태에서 키보드 Ctrl+L 누름 → 옆 패널로 이동(`›` 버튼과 동일 동작)되는지 확인.

- [ ] **Step 6: 수동 검증 — 비대응 키는 sticky 유지**

[Ctrl] 칩 클릭 → 칩이 armed 상태(filled). 키보드에서 `Tab` 누름 → 셸에서 탭 완성/자동완성 발생. [Ctrl] 칩이 여전히 armed인지 확인. 이후 `L` 누르면 클리어 + 디스암 정상 작동.

- [ ] **Step 7: 수동 검증 — Ctrl+Alt 조합**

[Ctrl] [Alt] 둘 다 클릭 → 둘 다 armed. 키보드에서 `l` 누름 → `\x1b\x0c` 전송 (Meta-Ctrl-L). 동작 가능한 시나리오는 셸에 따라 다르지만 둘 다 디스암으로 돌아왔는지 확인.

- [ ] **Step 8: 타입 체크**

Run: `cd app && npm run check 2>&1 | tail -20`
Expected: 새 오류 없음

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 데스크탑 관전 keydown에 sticky modifier 분기 추가"
```

---

## Task 4: 모바일 보내기 팝업 sticky 통합

**Goal:** 모바일 보내기 팝업이 현재 armed 상태를 표시하고, 텍스트 입력 첫 바이트에 modifier를 적용한다. 퀵키 버튼은 sticky를 무시하되 armed 상태는 보존.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (`sendPopupSubmit` 함수, 팝업 마크업, CSS)

**Acceptance Criteria:**
- [ ] 팝업 헤더 영역에 armed 뱃지: `[Ctrl+] [Alt+] [Shift+] 다음 키에 적용됩니다` (해당하는 mod만)
- [ ] armed가 모두 false면 뱃지 영역 자체를 렌더 안 함
- [ ] "타이핑만" / "엔터로 실행" 양쪽 모두 `applyStickyToText`로 변환 시도
- [ ] 첫 글자 대응 → 변환된 텍스트(+`\r` if 엔터) 전송, sticky 해제, 팝업 닫음
- [ ] 첫 글자 비대응 → 원본 텍스트 전송, sticky 유지, 팝업 닫음
- [ ] 퀵키 버튼들 (`y`, `n`, `^C` 등) → 시퀀스 그대로 전송, sticky 변경 없음
- [ ] 팝업 취소(`닫기` 또는 Escape) → sticky 변경 없음

**Verify:** 수동 — 모바일 뷰포트(devtools에서 360x640 등)에서 관전 노트 열고 (1) [Ctrl] 칩 클릭 → 팝업 헤더에 뱃지 표시 (2) 텍스트 `l` 입력 + "엔터로 실행" → `\x0c\r` 전송 + Ctrl 디스암 (3) 퀵키 `^C` 누름 → ^C 전송, Ctrl 그대로 armed

**Steps:**

- [ ] **Step 1: `sendPopupSubmit` 수정**

기존 함수(대략 줄 184)를 다음으로 교체:

```ts
function sendPopupSubmit(autoExecute: boolean): void {
  const text = sendPopupText;
  if (!client) return;

  const anyArmed = stickyMods.ctrl || stickyMods.alt || stickyMods.shift;
  if (anyArmed && text.length > 0) {
    const transformed = applyStickyToText(text, stickyMods);
    if (transformed !== null) {
      client.send(autoExecute ? transformed + '\r' : transformed);
      resetStickyMods();
      closeSendPopup();
      return;
    }
    // 비대응 — 원본 전송, sticky 유지
  }

  if (text.length > 0) {
    client.send(autoExecute ? text + '\r' : text);
  } else if (autoExecute) {
    // 빈 텍스트 + 엔터 — Alt armed면 \x1b\r, 아니면 \r
    if (stickyMods.alt && !stickyMods.ctrl && !stickyMods.shift) {
      client.send('\x1b\r');
      resetStickyMods();
    } else {
      client.send('\r');
    }
  }
  closeSendPopup();
}
```

(기존 함수의 정확한 시그니처를 파일에서 확인하고 그에 맞춰 시그너처 유지.)

- [ ] **Step 2: 팝업 헤더에 armed 뱃지 추가**

기존 팝업 마크업 (대략 줄 970–1010 영역) 안에서 텍스트 입력 위에 추가:

```svelte
{#if stickyMods.ctrl || stickyMods.alt || stickyMods.shift}
  <div class="send-sticky-badge" aria-live="polite">
    {#if stickyMods.ctrl}<span class="badge-tag">Ctrl+</span>{/if}
    {#if stickyMods.alt}<span class="badge-tag">Alt+</span>{/if}
    {#if stickyMods.shift}<span class="badge-tag">Shift+</span>{/if}
    <span class="badge-desc">다음 키에 적용됩니다</span>
  </div>
{/if}
```

- [ ] **Step 3: 뱃지 CSS 추가**

`<style>` 블록에 추가:

```css
.send-sticky-badge {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8rem;
  padding: 0.25rem 0.5rem;
  background: rgba(255, 200, 0, 0.15);
  border-radius: 4px;
  margin-bottom: 0.5rem;
}

.badge-tag {
  font-family: monospace;
  font-weight: bold;
}

.badge-desc {
  opacity: 0.8;
}
```

- [ ] **Step 4: 퀵키 버튼 sticky 무시 확인**

기존 퀵키 버튼 핸들러들을 검토. 각 버튼은 `client.send('\x03')` 같이 직접 시퀀스를 보낸다. `sendPopupSubmit` 경로를 거치지 않으므로 자동으로 sticky를 무시하고 유지한다. **이 단계는 코드 변경 없이 동작 검증만**.

만약 퀵키가 `sendPopupSubmit`을 호출하도록 작성되어 있다면 별도의 `sendPopupQuick(seq)` 함수를 만들고 호출처를 바꿀 것:

```ts
function sendPopupQuick(seq: string): void {
  if (!client) return;
  client.send(seq);
  closeSendPopup();
}
```

(파일을 읽어 확인 후 필요한 경우에만 적용.)

- [ ] **Step 5: 수동 검증 — armed 뱃지 표시**

브라우저 devtools에서 모바일 뷰포트(예: iPhone 12)로 전환. 관전 노트 열어 연결. [Ctrl] 칩 클릭 → "보내기" 버튼 클릭 → 팝업 헤더에 `Ctrl+ 다음 키에 적용됩니다` 뱃지 보이는지 확인.

- [ ] **Step 6: 수동 검증 — 텍스트 입력 변환**

위 상태에서 텍스트 입력에 `l` 타이핑 → "엔터로 실행" 클릭 → 원격 셸이 클리어되고 새 프롬프트 보임. 팝업 닫힌 후 [Ctrl] 칩이 디스암 상태(outline)로 돌아갔는지 확인.

- [ ] **Step 7: 수동 검증 — 비대응 + 첫글자 (예: `1ls`)**

[Ctrl] 칩 다시 클릭 → 보내기 팝업 → 텍스트 `1ls` 타이핑 → "엔터로 실행" → 셸이 `1ls` 명령 실행(or not found). [Ctrl] 칩은 여전히 armed인지 확인.

- [ ] **Step 8: 수동 검증 — 퀵키 sticky 무시**

[Ctrl] armed 상태에서 보내기 팝업 → `^C` 퀵키 클릭 → ^C 전송, 팝업 닫힘, [Ctrl] 여전히 armed.

- [ ] **Step 9: 타입 체크**

Run: `cd app && npm run check 2>&1 | tail -20`
Expected: 새 오류 없음

- [ ] **Step 10: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "feat(terminal): 모바일 보내기 팝업에 sticky modifier 통합"
```

---

## Task 5: 스킬 / CLAUDE.md 문서 갱신

**Goal:** `tomboy-terminal` 스킬과 루트 `CLAUDE.md`에 sticky modifier 기능을 반영하여 향후 세션이 컨텍스트를 잃지 않도록 한다.

**Files:**
- Modify: `.claude/skills/tomboy-terminal/SKILL.md`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] `SKILL.md`의 "Spectator mode" 섹션 안에 sticky modifier 하위 섹션 추가 (UI 위치, 키 매핑 표, 데스크탑/모바일 동작 차이)
- [ ] `SKILL.md`의 invariants 목록에 "Sticky modifier는 관전 모드 전용" 줄 추가
- [ ] `SKILL.md`의 "Client side" 표에 `stickyMods.ts` 항목 추가
- [ ] 루트 `CLAUDE.md`의 "터미널 노트" 섹션에 sticky modifier 한 줄 언급 (자세한 내용은 스킬 참조)

**Verify:** 다음 명령 출력에 "sticky" 키워드가 포함되는지 확인:
```
grep -i "sticky" .claude/skills/tomboy-terminal/SKILL.md CLAUDE.md
```

**Steps:**

- [ ] **Step 1: SKILL.md "Client side" 표에 stickyMods.ts 추가**

`| File | Role |` 표 안에 `terminalBell.ts` 항목 근처에 다음 줄 삽입:

```
| `lib/editor/terminal/stickyMods.ts` | 순수 키→바이트 매핑 — `computeStickyKeySequence(event, mods)`, `applyStickyToText(text, mods)`, `StickyMods` 타입. 관전 모드에서만 사용. |
```

- [ ] **Step 2: SKILL.md "Spectator mode" 섹션에 sticky modifier 하위 섹션 추가**

"### Target-side tmux configuration" 섹션 **직전**에 다음 추가:

```markdown
### Sticky modifier 칩 (Ctrl / Alt / Shift)

데스크탑 관전 모드의 페이지-레벨 keydown 리스너가 `Ctrl+L`을 next-pane으로
가로채므로 셸의 "화면 클리어" 단축키를 직접 보낼 수 없다. Sticky modifier
칩은 이 충돌을 우회하는 명시적 opt-in 경로다.

**UI**: `.spec-windowbar` 안에 윈도우 라벨 오른쪽으로 [Ctrl] [Alt] [Shift]
토글 칩 3개. 클릭하면 해당 mod가 armed 상태(채워진 배경). 한 번 더 클릭하면
해제. 여러 mod 동시 armed 가능 (Ctrl+Alt+x 등). 관전 모드에서만 노출
(`{#if isSpectator}` 가드).

**키 매핑** (`stickyMods.ts:computeStickyKeySequence`):

| 키 종류 | Ctrl | Alt | Ctrl+Alt | Shift | Ctrl+Shift |
|---|---|---|---|---|---|
| letter (a-z) | `c & 0x1F` | `\x1b + c` | `\x1b + (c&0x1F)` | upper(c) | (c&0x1F) |
| printable | null | `\x1b + c` | null | c | null |
| Enter/BS/ESC/Tab | null | `\x1b + seq` | null | null | null |
| 그 외 | null | null | null | null | null |

null 반환 시 sticky 유지 + 원본 키 전송.

**데스크탑 통합**: `handleWindowKeydown` capture-phase 리스너에서 기존
pane-nav 분기 **이전**에 sticky 검사. armed + 대응 키 → 변환 바이트
`client.send`, sticky 해제, `preventDefault + stopPropagation`. 비대응 키
→ sticky 유지 + 이벤트 그대로 진행 (xterm이 target 단계에서 처리).

**모바일 통합**: 보내기 팝업에 armed 뱃지 표시. "타이핑만"/"엔터로 실행"
양쪽이 `applyStickyToText`로 첫 글자 변환. 비대응 첫 글자면 원본 전송 +
sticky 유지. 퀵키 버튼 (`y`, `n`, `^C` 등)은 sticky를 무시하고 유지한다.

**기존 Ctrl+H/L pane-nav 단축키는 그대로 유지.** Sticky는 추가 메커니즘.
실제 키보드 Ctrl+L → next-pane; sticky-Ctrl + 키보드 L → 셸로 \x0c.
재연결 시 sticky 리셋.
```

- [ ] **Step 3: SKILL.md "Spectator-mode constraints worth caching" 목록에 sticky 줄 추가**

목록 끝에 (또는 "Nav buttons drive both views" 다음에) 추가:

```markdown
- **Sticky modifier 칩은 관전 모드 전용 + 휘발성.** `stickyMods.ts`는 순수
  함수, `TerminalView.svelte`의 `$state`로만 보관. 노트 포맷 / 브릿지 /
  WS 프로토콜 변경 없음. 셸 모드에서는 칩 자체가 렌더되지 않는다 — 셸 모드는
  `term.onData` 직결이라 키 가로채기가 없어 충돌이 없기 때문.
```

- [ ] **Step 4: CLAUDE.md 터미널 노트 섹션 갱신**

`## 터미널 노트 (SSH terminal in a note)` 섹션 안의 "the **`tmux -CC` spectator mode**" 단락에 한 줄 추가. 기존:

> ...and **터미널 벨** (xterm `onBell` → Web Audio 비프 + 진동, 셸 모드 전용).

다음으로 변경:

> ...and **터미널 벨** (xterm `onBell` → Web Audio 비프 + 진동, 셸 모드 전용),
> **sticky modifier 칩** (관전 모드 전용 — Ctrl/Alt/Shift 토글 칩으로 다음
> 키에 modifier 적용, 데스크탑 Ctrl+L pane-nav 충돌 우회).

- [ ] **Step 5: CLAUDE.md "Quick map" 영역에 파일 추가**

`app/src/lib/editor/terminal/` 파일 목록에 `stickyMods.ts` 추가:

```
- `app/src/lib/editor/terminal/` — `parseTerminalNote.ts`, `wsClient.ts`,
  `TerminalView.svelte`, `bridgeSettings.ts`, `historyStore.ts`,
  `connectAutoRun.ts`, `oscCapture.ts`, `HistoryPanel.svelte`,
  `terminalBell.ts`, `imagePasteClient.ts`, `clipboardImage.ts`,
  `stickyMods.ts`.
```

- [ ] **Step 6: 검증**

Run: `grep -in "sticky" .claude/skills/tomboy-terminal/SKILL.md CLAUDE.md`
Expected: 둘 다에 sticky 관련 줄이 등장.

- [ ] **Step 7: 커밋**

```bash
git add .claude/skills/tomboy-terminal/SKILL.md CLAUDE.md
git commit -m "docs(terminal): sticky modifier 기능 스킬/CLAUDE.md 반영"
```

---

## Self-Review 체크리스트 (작성자가 완료 후 확인)

- 모든 spec 섹션이 task로 커버되는가:
  - UX 모델 → Task 1, 3, 4
  - 키 매핑 → Task 1
  - UI 배치 → Task 2
  - 데스크탑 통합 → Task 3
  - 모바일 통합 → Task 4
  - 파일 변경 표 → 모든 Task
  - 문서 갱신 → Task 5
- 모든 step에 실제 코드/명령이 들어있음 (TBD/placeholder 없음)
- 타입 일관성: `StickyMods`, `computeStickyKeySequence`, `applyStickyToText`, `resetStickyMods`, `toggleStickyMod` 모든 task에서 동일 시그너처
