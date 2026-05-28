# 관전 모드 패널 하단 정렬 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 노트 관전 모드에서 스케일된 tmux 패널을 `.xterm-host` 하단에 정렬해, 노트 높이가 낮아도 프롬프트·커서·최근 출력이 항상 보이게 한다.

**Architecture:** `TerminalView.svelte`의 `<style>` 블록만 수정한다. `.terminal-page.spectator .xterm-host`를 세로 플렉스(`justify-content: flex-end`)로 만들어 스테이지를 바닥에 붙이고, `.xterm-stage`에 `flex-shrink: 0`을 줘 명시 높이를 유지(축소가 아닌 상단 넘침 → `overflow: hidden` 클립)하게 한다. `applySpectatorFit()` JS·DOM 구조·WS 프로토콜은 변경 없음.

**Tech Stack:** Svelte 5, CSS (컴포넌트 scoped), xterm.js, SvelteKit.

설계 문서: `docs/superpowers/specs/2026-05-22-spectator-bottom-anchor-design.md`

---

### Task 1: 관전 패널을 CSS 플렉스로 하단 정렬

**Goal:** 관전 모드 `.xterm-host`를 하단 정렬 플렉스 컨테이너로 만들고 `.xterm-stage`가 축소되지 않게 고정한다.

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` (`<style>` 블록, `.terminal-page.spectator .xterm-host` ≈ L1124, `.terminal-page.spectator .xterm-stage` ≈ L1135)

**Acceptance Criteria:**
- [ ] `.terminal-page.spectator .xterm-host`가 `display: flex; flex-direction: column; justify-content: flex-end`를 가짐 (`overflow-x/y: hidden` 유지)
- [ ] `.terminal-page.spectator .xterm-stage`가 `flex-shrink: 0`을 가짐 (`position: relative` 유지)
- [ ] 베이스 `.xterm-host`(`flex: 1; padding: 4px; overflow: hidden`)와 비관전 셀렉터는 변경 없음
- [ ] 낮은 노트: 스케일된 패널이 바닥에 붙고 상단이 잘림 — 프롬프트·커서 보임
- [ ] 높은 노트: 패널이 바닥에 붙고 위쪽에 여백
- [ ] `applySpectatorFit()`, DOM 3-레이어 구조, WS 프로토콜 미변경
- [ ] `npm run check` 신규 오류 없음

**Verify:** `cd app && npm run check` → 신규 svelte-check 오류 0건. 이후 아래 수동 검증 절차.

**Steps:**

- [ ] **Step 1: `.xterm-host` 규칙에 플렉스 하단 정렬 추가**

`app/src/lib/editor/terminal/TerminalView.svelte`에서 다음 블록을 찾는다:

```css
	.terminal-page.spectator .xterm-host {
		overflow-x: hidden;
		overflow-y: hidden;
	}
```

다음으로 교체한다:

```css
	.terminal-page.spectator .xterm-host {
		/* Bottom-anchor the scaled pane: when it's taller than the host
		   the TOP overflows and is clipped, keeping prompt/cursor visible. */
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		overflow-x: hidden;
		overflow-y: hidden;
	}
```

- [ ] **Step 2: `.xterm-stage` 규칙에 `flex-shrink: 0` 추가**

같은 파일에서 다음 블록을 찾는다:

```css
	.terminal-page.spectator .xterm-stage {
		/* width / height set inline by applySpectatorFit. */
		position: relative;
	}
```

다음으로 교체한다:

```css
	.terminal-page.spectator .xterm-stage {
		/* width / height set inline by applySpectatorFit. */
		position: relative;
		/* Keep the explicit scaled height — never let the flex parent
		   shrink the stage. A taller-than-host pane must overflow the TOP
		   (clipped), not compress; compression would desync the absolute
		   .xterm-mount and the touch-scroll pxPerLine math. */
		flex-shrink: 0;
	}
```

- [ ] **Step 3: 타입체크**

Run: `cd app && npm run check`
Expected: 신규 오류 0건 (CSS 변경이라 svelte-check 영향 없음 — 기존 baseline 대비 증가 없음 확인).

- [ ] **Step 4: 수동 검증 (dev 서버)**

Run: `cd app && npm run dev` 후 브라우저에서 관전(`spectate:`) 노트를 연다.

확인 항목:
1. 데스크탑 `NoteWindow`에서 관전 노트 창을 **세로로 짧게** 줄인다 → 하단(프롬프트·커서)이 보이고 상단이 잘리는지.
2. normal-screen 셸에서 버퍼를 위로 스크롤(휠/터치) → 잘렸던 상단 내용이 가시 창으로 들어오는지.
3. 노트 창을 다시 키웠다 줄였다 리사이즈 → 항상 하단 정렬 유지되는지.
4. 노트가 패널보다 충분히 클 때 → 패널이 바닥에 붙고 위쪽에 여백이 생기는지.
5. 모바일 `/note/[id]` 라우트에서 관전 노트 동일 확인 (터치 드래그 스크롤 정상).
6. 비관전(셸 모드) 터미널 노트를 열어 레이아웃·FitAddon 정상 동작 확인 — 회귀 없음.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "$(cat <<'EOF'
feat(spectator): 관전 패널 하단 정렬 — 낮은 노트에서 프롬프트가 잘리지 않게

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 검증 요약

- 자동: `cd app && npm run check` (svelte-check) — 신규 오류 없음.
- 수동: Task 1 Step 4의 6개 항목 (CSS 시각 변경이라 유닛 테스트 없음).
