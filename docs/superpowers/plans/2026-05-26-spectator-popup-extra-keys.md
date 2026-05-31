# Spectator 보내기 팝업 단독 특수키 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관전 모드 보내기 팝업의 빠른 키 라인에 `Tab / ⌫ / ← / ↓ / ↑ / →` 버튼 6개를 추가해, 모바일 OSK 로 보낼 수 없는 단독 특수키를 한 탭으로 송신할 수 있게 한다.

**Architecture:** `TerminalView.svelte` 한 파일만 수정한다. 기존 `<div class="send-quick">` 라인의 PgDn 버튼 뒤에 6개 `<button>` 요소를 추가하고, 각 버튼은 기존 `sendQuickKey(bytes)` 헬퍼에 raw byte 시퀀스를 그대로 넘긴다. CSS 의 `.send-quick` 은 이미 `flex-wrap: wrap`(line 1553) 이라 추가 스타일 변경 없음. sticky modifier 합성은 비범위 — `sendQuickKey` 의 현행 raw-send 동작과 일관.

**Tech Stack:** Svelte 5 runes, TipTap 와 무관, 순수 UI 추가. 변경은 단일 `.svelte` 파일.

---

### Task 1: 보내기 팝업 빠른 키 라인에 단독 특수키 6개 추가

**Goal:** `Tab / ⌫ / ← / ↓ / ↑ / →` 6개 버튼이 빠른 키 라인 끝에 자연 wrap 으로 추가되어, 모바일 보내기 팝업에서 각 키의 표준 시퀀스를 활성 pane 으로 전송한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte:1125` (PgDn 버튼 바로 뒤에 6개 button 삽입)

**Acceptance Criteria:**
- [ ] 보내기 팝업의 빠른 키 라인에 다음 6개 버튼이 라벨 그대로 보임: `Tab`, `⌫`, `←`, `↓`, `↑`, `→`.
- [ ] 클릭 시 각 버튼이 다음 시퀀스를 송신: `Tab → \t`, `⌫ → \x7f`, `← → \x1b[D`, `↓ → \x1b[B`, `↑ → \x1b[A`, `→ → \x1b[C`.
- [ ] 라인 폭이 좁아지면 자연 줄넘김 발생 (`.send-quick` 의 `flex-wrap: wrap` 활용).
- [ ] sticky 칩 armed 상태에서 새 버튼 클릭 → 합성 없이 raw 시퀀스만 송신 (현행 `sendQuickKey` 동작 유지).
- [ ] `npm run check` (svelte-check) 0 errors.

**Verify:** `cd app && npm run check` → no new errors. 그 후 데스크탑 + 모바일 한 쌍의 spectator 세션 대상으로 아래 매뉴얼 확인.

**Steps:**

- [ ] **Step 1: `TerminalView.svelte:1125` 의 PgDn 버튼 바로 뒤에 6개 button 추가**

기존 라인 (line 1118-1126):

```svelte
<div class="send-quick">
    <span class="send-quick-label">빠른 키</span>
    <button type="button" onclick={() => sendQuickKey('y\r')}>y ↵</button>
    <button type="button" onclick={() => sendQuickKey('n\r')}>n ↵</button>
    <button type="button" onclick={() => sendQuickKey('1\r')}>1 ↵</button>
    <button type="button" onclick={() => sendQuickKey('\r')}>↵</button>
    <button type="button" onclick={() => sendQuickKey('\x1b')}>Esc</button>
    <button type="button" onclick={() => sendQuickKey('\x03')}>^C</button>
    <button type="button" title="Page Up (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[5~')}>PgUp</button>
    <button type="button" title="Page Down (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[6~')}>PgDn</button>
</div>
```

수정 후 (PgDn 뒤에 6개 추가):

```svelte
<div class="send-quick">
    <span class="send-quick-label">빠른 키</span>
    <button type="button" onclick={() => sendQuickKey('y\r')}>y ↵</button>
    <button type="button" onclick={() => sendQuickKey('n\r')}>n ↵</button>
    <button type="button" onclick={() => sendQuickKey('1\r')}>1 ↵</button>
    <button type="button" onclick={() => sendQuickKey('\r')}>↵</button>
    <button type="button" onclick={() => sendQuickKey('\x1b')}>Esc</button>
    <button type="button" onclick={() => sendQuickKey('\x03')}>^C</button>
    <button type="button" title="Tab (자동완성)" onclick={() => sendQuickKey('\t')}>Tab</button>
    <button type="button" title="Backspace" onclick={() => sendQuickKey('\x7f')}>⌫</button>
    <button type="button" title="Page Up (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[5~')}>PgUp</button>
    <button type="button" title="Page Down (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[6~')}>PgDn</button>
    <button type="button" title="왼쪽 화살표" onclick={() => sendQuickKey('\x1b[D')}>←</button>
    <button type="button" title="아래 화살표" onclick={() => sendQuickKey('\x1b[B')}>↓</button>
    <button type="button" title="위 화살표" onclick={() => sendQuickKey('\x1b[A')}>↑</button>
    <button type="button" title="오른쪽 화살표" onclick={() => sendQuickKey('\x1b[C')}>→</button>
</div>
```

배치 근거:
- `Tab`, `⌫` 는 명령 입력 흐름의 일부 → `^C` 뒤, 페이지 스크롤 키(`PgUp`/`PgDn`) 앞.
- 화살표는 이동/탐색 그룹 → 라인 끝에 `← ↓ ↑ →` 순서로. 가로 한 줄에서 left→up→right 형태로 자연스럽게 위/아래 가운데로 인식되도록 좌→하→상→우 순서를 따른다 (게임패드/모바일 D-pad 관습).

- [ ] **Step 2: svelte-check 실행**

```bash
cd app && npm run check
```

Expected: 새 errors / warnings 없음. 기존 baseline 과 동일.

- [ ] **Step 3: 매뉴얼 검증 (데스크탑 + 모바일 spectator)**

데스크탑 1대(타깃 tmux 세션 실행 중)와 모바일 1대(같은 세션 spectate) 준비.

`bash` 프롬프트에서:
- 긴 줄(`echo aaa bbb ccc ddd`) 타이핑 후 모바일 ← → 로 글자 단위 커서 이동 확인.
- 모바일 ⌫ 로 한 글자씩 삭제 확인.
- 빈 프롬프트에서 `gi` 입력 후 모바일 Tab → `git ` 등으로 자동완성 발동 확인.

`claude` 또는 다른 TUI 실행:
- 모바일 ↑ ↓ 로 메뉴 / 히스토리 이동 확인.

DevTools(데스크탑 보내기 팝업 페이지 또는 모바일 원격 디버깅):
- 모바일 폭(<420px) 에뮬레이션 시 14개 버튼이 라인 끝에서 다음 줄로 wrap 되는지 확인.
- sticky 칩 `Alt` armed 상태 → 모바일 `←` 클릭 → WS 프레임 payload 가 `\x1b[D` 만(접두 `\x1b` 없이) 인지 확인.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "$(cat <<'EOF'
feat(terminal): spectator 보내기 팝업에 Tab/⌫/화살표 빠른 키 추가

모바일 OSK 로는 보낼 수 없는 단독 특수키 6개를 빠른 키 라인에
추가. 각 버튼은 표준 시퀀스(\t, \x7f, \x1b[A-D)를 raw 로 송신하며
sticky modifier 합성은 적용하지 않음 (현행 sendQuickKey 동작 유지).

Spec: docs/superpowers/specs/2026-05-26-spectator-popup-extra-keys-design.md
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- 보내기 팝업 빠른 키 6개 추가 → Task 1 Step 1 ✓
- Tab 시퀀스 `\t` → Task 1 Step 1 ✓
- ⌫ 시퀀스 `\x7f` → Task 1 Step 1 ✓
- 화살표 CSI 시퀀스 → Task 1 Step 1 ✓
- flex-wrap 자연 줄넘김 → AC + Step 3 ✓
- sticky modifier 비조합 → AC + Step 3 ✓
- 데스크탑 spectator 직접 입력 경로 무변경 → 변경 파일이 popup 마크업뿐이므로 자동 충족 ✓
- 매뉴얼 검증 (TUI, 좁은 폭, sticky 무영향) → Step 3 ✓

**Placeholder scan:** 없음.

**Type consistency:** `sendQuickKey(bytes: string): void` — 모든 새 버튼이 string literal 한 개만 전달. 일관 ✓.

**User-gate detection:** 사용자 브리프에 verify/prove/validate/smoke/E2E/before-proceeding 등 게이트 키워드 없음. 단순 UI 추가. tagging 안 함.
