# Spectator 패널 고정 (pin)

날짜: 2026-05-24
대상: `app/src/lib/editor/terminal/` (TerminalView spectator 모드)

## 배경

터미널 노트의 spectator 모드는 현재 데스크탑의 활성 tmux 패널을 자동으로
따라간다. 사용자가 데스크탑에서 패널을 옮기면 모바일 view도 따라 옮겨가
버린다. 특정 패널(예: claude code 세션)을 모바일에서 계속 지켜보고 싶을 때
이 자동 따라가기가 방해된다.

footer 1~5 버튼으로 패널을 **고정**할 수 있게 한다. 고정되면 데스크탑이 다른
패널로 가도 view는 그 패널에 머무른다. 모바일에서 입력하거나 클릭하면 그
패널이 다시 데스크탑의 활성 패널이 된다.

## 결정사항 요약

| 항목 | 정책 |
|---|---|
| Pin 토글 | 활성 패널 버튼을 한 번 더 → 고정. 자물쇠 표시. 자물쇠를 다시 누르면 해제. |
| 영속 저장 | `spectate: main:3` 형식. 자물쇠 토글 시 노트 자동 저장. |
| 클릭/타이핑 | 고정 패널 N에 `select-pane` 호출 (활성으로 끌어옴). 고정 유지. |
| 1~5 (다른 번호) | 고정 중에는 disabled. |
| « » 윈도우 이동 | 고정 유지. 새 윈도우의 N번 패널을 보여줌. |
| 고정한 패널 없음 | "패널 N번 없음" 배너 + 스트림 멈춤. 자동 복귀 없음. |
| 동시 관전 | 각 노트가 독립 SpectatorSession → 서로 안 섞임. |

## 아키텍처 — 클라이언트 전담 (A안)

Pin 결정은 전부 `TerminalView.svelte` 안에서. Bridge (`SpectatorSession`)는
**변경 없음**. 새 WS 메시지 타입 없음.

### 흐름

- `pane-switch` 프레임은 늘 그대로 옴 (`paneOrdinal`, `paneCount` 포함).
- Pin 활성이면 클라이언트가 `paneOrdinal === pinnedOrdinal` 비교로 `pinDetached`
  플래그를 결정.
- `pinDetached=true`이면 들어오는 `data` 프레임을 xterm에 쓰지 않음 (마지막
  본 N번 화면이 정지).
- 클릭/타이핑 시 `client.selectPane(N)` → bridge가 `%window-pane-changed` →
  `pane-switch` 회신 → `pinDetached=false` 자동 복귀.

### 장점
- Bridge 코드 0줄 변경.
- 모든 결정이 한 컴포넌트 안에 있어 디버깅 쉬움.
- 노트별 pin이 독립 — 같은 세션을 두 노트로 봐도 충돌 없음.

### 단점 (수용)
- pin 중 안 보이는 패널의 출력 트래픽은 WS로 계속 옴 (버려짐). 일반적으로
  spectator 노트 트래픽은 작아서 무시 가능.

## 1. 데이터 모델 & 노트 포맷

### Spec 확장 (`parseTerminalNote.ts`)

`TerminalNoteSpec`에 `pinnedPane?: number` 필드 추가.

`spectate:` 메타 라인 파싱:

- `spectate: main` → `spectate = "main"`, `pinnedPane = undefined`
- `spectate: main:3` → `spectate = "main"`, `pinnedPane = 3`

규칙: **마지막 콜론 이후 토큰이 `/^\d+$/` 매칭**이면 ordinal로 해석, 그 외엔
세션 이름 전체로 둠.

유효 ordinal: 1..5. 그 외 (`0`, `99`) → `pinnedPane = undefined` (파싱은 받되
무시).

알려진 제약: 세션 이름이 정확히 `foo:3` 형태(콜론 + 숫자로 끝)면 ordinal로
오인됨. 흔치 않은 케이스라 문서 명시만 함.

### Serialize 헬퍼 (`parseTerminalNote.ts`)

```ts
export function rewriteSpectateLine(
  xmlContent: string,
  session: string,
  pinnedPane: number | null
): string
```

- 기존 `<note-content>` 내부에서 첫 번째 `spectate:` 라인을 찾아 in-place 치환.
- ProseMirror JSON으로 round-trip 하지 않고 raw XML 텍스트 노드만 치환
  (`spectate:\s*([^<]+)` 매칭).
- 라인이 없으면 no-op (= 원본 그대로 반환).
- `pinnedPane = null`이면 `:N` 부분 제거 (`spectate: main`).
- `pinnedPane = 3`이면 `spectate: main:3`.

### Component state (`TerminalView.svelte`)

```ts
let pinnedOrdinal: number | null = $state(spec.pinnedPane ?? null);
let pinDetached = $state(false);
```

## 2. 런타임 동작

### 마운트

`pinnedOrdinal !== null`이면 WS open 직후 `client.selectPane(pinnedOrdinal)` 1회
호출. bridge가 회신하는 `pane-switch`가 자연스럽게 attach.

### `onPaneSwitch` 분기

```ts
onPaneSwitch: (info) => {
  if (pinnedOrdinal === null) {
    applyPaneSwitch(info);
    term?.resize(info.cols, info.rows);
    applySpectatorFit();
    return;
  }
  // pin 모드 — paneCount/Ordinal/window 정보는 항상 갱신
  spectatorPaneOrdinal = info.paneOrdinal;
  spectatorPaneCount = info.paneCount;
  spectatorWindowIndex = info.windowIndex;
  spectatorWindowName = info.windowName;
  // 구버전 bridge(=0) 또는 unknown(=0): detach 결정 보류, 화면 그대로.
  if (info.paneOrdinal === 0) return;
  if (info.paneOrdinal === pinnedOrdinal) {
    spectatorPaneId = info.paneId;
    spectatorCols = info.cols;
    spectatorRows = info.rows;
    pinDetached = false;
    term?.resize(info.cols, info.rows);
    applySpectatorFit();
  } else {
    // 동기적으로 set — 이어서 bridge가 보내는 새 패널의 seed `data` 프레임이
    // `onData`에 도달할 때 이미 pinDetached=true 라서 xterm에 쓰이지 않음.
    // 그 결과 마지막 본 N번 패널의 화면이 그대로 멈춰 보임.
    // spectatorPaneId/Cols/Rows는 일부러 옛 값 유지 — 헤더가 "어디서 멈췄나"
    // 를 계속 보여주도록.
    pinDetached = true;
  }
}
```

### `onData` 분기

```ts
onData: (chunk) => {
  if (pinDetached) return;
  term?.write(chunk, () => { if (isSpectator) recomputeScroll(); });
}
```

### Re-attach 트리거

```ts
function reattachIfPinned(): void {
  if (pinnedOrdinal !== null && pinDetached) {
    client?.selectPane(pinnedOrdinal);
  }
}
```

호출 지점:
- `handlePageClick` 끝.
- `term.onData` 콜백 진입 시 (데스크탑 입력 경로).
- 모바일 보내기 popup의 `sendPopupSubmit` / `sendQuickKey` / `sendImageFile`.

`selectPane(N)`이 패널 없음으로 silent no-op이면 `pinDetached`가 영원히 안 풀림
→ 사용자에게는 detach 배너 계속 보임 (의도).

### `onPaneResize`

`pinDetached`이면 무시. attach 상태일 때만 `term.resize` + fit.

## 3. UI (footer)

### 버튼

```svelte
{#each [1,2,3,4,5] as n}
  <button class="icon pane-num"
    class:active={n === spectatorPaneOrdinal && pinnedOrdinal === null}
    class:pinned={n === pinnedOrdinal}
    class:detached={n === pinnedOrdinal && pinDetached}
    disabled={status !== 'open'
              || (spectatorPaneCount > 0 && n > spectatorPaneCount)
              || (pinnedOrdinal !== null && n !== pinnedOrdinal)}
    onclick={() => onPaneNumClick(n)}
    title={n === pinnedOrdinal ? `패널 ${n} 고정 (해제하려면 다시 누르세요)` : `패널 ${n}`}>
    {#if n === pinnedOrdinal}🔒{/if}{n}
  </button>
{/each}
```

### 클릭 핸들러

```ts
function onPaneNumClick(n: number): void {
  if (pinnedOrdinal === n) {
    unpinPane();
    return;
  }
  if (pinnedOrdinal === null && n === spectatorPaneOrdinal) {
    pinPane(n);
    return;
  }
  client?.selectPane(n);
}

function pinPane(n: number): void {
  pinnedOrdinal = n;
  pinDetached = false;
  void persistPinToNote(n);
}

function unpinPane(): void {
  pinnedOrdinal = null;
  pinDetached = false;
  void persistPinToNote(null);
}
```

### 시각 상태 (CSS)

| 상태 | 클래스 | 모양 |
|---|---|---|
| 일반 active (pin 없음) | `.pane-num.active` | 파란 배경 (기존) |
| 고정 + attached | `.pane-num.pinned` | 파란 배경 + 🔒 |
| 고정 + detached | `.pane-num.pinned.detached` | 파란 배경 + 🔒 + 빨간 테두리 |
| pin 중 다른 번호 | `disabled` | 반투명 (기존) |

### Detach 배너

```svelte
{#if pinDetached}
  <div class="banner banner-pin-detached">
    패널 {pinnedOrdinal}번 고정 — 현재 비활성. 화면을 클릭하면 다시 부착됩니다.
  </div>
{/if}
```

### 키보드 단축키 (데스크탑)

`handleWindowKeydown`에 pin 가드:
- `Ctrl+H/L` (prev/next-pane): pin 중 무효 (1~5 비활성과 같은 정책).
- `Ctrl+Shift+H/L` (prev/next-window): 그대로 동작 (« » 와 같은 정책).

## 4. 노트 저장

### `persistPinToNote` 헬퍼

```ts
async function persistPinToNote(n: number | null): Promise<void> {
  const note = await getNote(guid);
  if (!note) return;
  const updated = rewriteSpectateLine(note.xmlContent, spec.spectate!, n);
  if (updated === note.xmlContent) {
    // spectate 라인이 사라진 노트로 편집됨 → 저장할 곳이 없음
    pushToast('고정을 저장할 수 없습니다 (노트 형식이 바뀌었습니다)', { kind: 'error' });
    return;
  }
  const now = nowTomboyDate();
  await putNote({
    ...note,
    xmlContent: updated,
    changeDate: now,
    metadataChangeDate: now
  });
}
```

- `putNote` 사용 (localDirty=true → Dropbox/Firebase로 propagate).
- `changeDate` + `metadataChangeDate` 갱신해야 firebase realtime sync도
  자기 변경으로 인식.
- `noteReloadBus.emitNoteReload`는 호출하지 않음 — 자기 자신이 부른 거고,
  history reloader가 spec을 재파싱하지 않으므로 안전.

### 경합

- 빠른 토글 → 토글 핸들러는 `await persistPinToNote(...)`로 직렬화 (UI는
  옵티미스틱 업데이트).
- 다른 곳에서 동시 편집 → 일반 노트 편집과 같은 race 수준. 무시.

### 동일 노트가 두 군데에 열린 경우

각 TerminalView는 독립 state. A에서 토글 → 노트 저장 → B에 안 반영. 사용자가
혼자 쓰는 환경 + 이중 열기 희박 → 허용 가능한 분기.

## 5. 엣지 케이스

| 케이스 | 동작 |
|---|---|
| `spectate: main:0` / `main:99` | `pinnedPane = undefined`. 본문 보존, UI는 unpin 상태로 시작. |
| `spectate: foo:bar` | session=`foo:bar`. ordinal 없음. |
| `spectate: grp:web:2` | session=`grp:web`, pin=2. |
| Pin 토글 시 spectate 라인 없음 | no-op + 에러 토스트. |
| 구버전 bridge (paneOrdinal=0 / paneCount=0) | `pinDetached` 변화 보류 (직전 값 유지). |
| WS 재연결 | `pinnedOrdinal` 유지, `pinDetached`는 false로 리셋 후 `selectPane` 자동 호출. |
| 재연결 first frame이 active≠N | 잠시 detach → `selectPane` → 두 번째 프레임으로 정정. 미미한 깜빡임. |
| 고정 패널이 닫힘 | 다음 `pane-switch` 프레임으로 paneCount 갱신. 그 때 detach 결정. 폴링 없음. |
| 같은 노트 이중 열기 | 각자 독립 state. 분기 허용. |

## 6. 테스트

### Unit tests

**`app/tests/unit/editor/terminal/parseTerminalNote.test.ts`** (확장):

- `spectate: main` → `pinnedPane: undefined`
- `spectate: main:3` → `pinnedPane: 3`, session=`main`
- `spectate: main:0` → `pinnedPane: undefined`
- `spectate: main:99` → `pinnedPane: undefined`
- `spectate: main:foo` → session=`main:foo`, pin 없음
- `spectate: grp:web:2` → session=`grp:web`, pin=2

**`app/tests/unit/editor/terminal/rewriteSpectateLine.test.ts`** (새 파일):

- 라인 있음 + pin 추가 (null→3) → `spectate: main` → `spectate: main:3`
- 라인 있음 + pin 제거 (3→null) → `spectate: main:3` → `spectate: main`
- 라인 있음 + pin 교체 (3→5)
- 라인 없음 → 원본 그대로 (no-op)
- 라인 안에 마크가 있는 경우 → 텍스트 노드만 교체, 마크 보존
- 콜론 포함 세션 이름 보존 (`grp:web:2` → `grp:web:5`)

### Manual QA

- 자물쇠 토글 → admin/browse에서 노트 본문에 `:3` 추가 확인.
- 데스크탑에서 다른 패널로 이동 → detach 배너 표시, view 멈춤.
- 클릭 또는 키 입력 → re-attach.
- « »로 윈도우 이동 → 새 윈도우 N번 표시, 패널 없으면 detach.
- pin 중 1~5의 다른 번호 disabled 확인.
- 노트 다시 열어서 pin 유지되는지 확인.

## 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/terminal/parseTerminalNote.ts` | `pinnedPane` 필드 + parsing + `rewriteSpectateLine` 헬퍼 |
| `app/src/lib/editor/terminal/TerminalView.svelte` | pin state, footer 클릭 분기, onPaneSwitch/onData 분기, re-attach 트리거, persist 헬퍼, detach 배너, CSS |
| `app/tests/unit/editor/terminal/parseTerminalNote.test.ts` | 신규 케이스 추가 |
| `app/tests/unit/editor/terminal/rewriteSpectateLine.test.ts` | 신규 파일 |
| `bridge/` | **변경 없음** |
| `CLAUDE.md` | `tomboy-terminal` 섹션 또는 `app/src/lib/editor/terminal/SKILL.md` 에 pin 동작 1~2단락 추가 |
