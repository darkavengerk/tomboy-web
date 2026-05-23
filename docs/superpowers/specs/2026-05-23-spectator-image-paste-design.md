# 관전 모드 이미지 붙여넣기 설계

> 2026-05-23

## 배경

셸 모드(`ssh://`) 노트의 이미지 붙여넣기는 이미 구현되어 있다 — Ctrl+V /
드래그앤드롭 / 헤더 "이미지" 버튼을 통해 클라이언트가 base64로 인코딩한
바이트를 WS로 보내면, 브릿지가 ControlMaster 멀티플렉싱 ssh로 타깃 호스트의
`/tmp/tomboy-images/`에 파일을 쓰고 그 경로를 PTY에 bracketed-paste로
주입한다. 활성 TUI(예: 클로드 코드)는 그 경로를 첨부 파일로 인식한다.

**관전 모드(`spectate:`) 노트에서는 이 패스가 통째로 막혀 있다.** 현재 코드:

- `TerminalView.svelte`의 paste/dragover/drop 핸들러 셋이 모두 첫 줄에
  `if (isSpectator) return;`로 종료한다.
- 헤더 "이미지" 버튼은 `{#if !isSpectator}` 게이트 안에 있어 관전 모드에서는
  렌더되지 않는다.
- 브릿지 `handleImageMessage`는 `if (!pty || !sessionTarget) return;`로 무음
  종료한다 — 관전 세션은 `pty`도 `sessionTarget`도 없다.
- `startSpectator`는 `controlPath`를 생성하지 않아 `imageTransfer`가 사용할
  ssh 마스터 소켓이 존재하지 않는다.

이전 검증("Ctrl+V로 잘 됨")은 데스크탑 + 로컬 호스트 조합에서 우리 패스가 아닌
타깃 터미널 내부 클라이언트(클로드 코드)가 OS 클립보드를 직접 잡아 동작한
케이스였다. 우리 우회 경로는 한 번도 실행된 적 없다.

따라서 본 작업의 목표는:

1. **모바일 관전 모드에서 보내기 팝업을 통한 이미지 전송 입구** 추가
2. **데스크탑 관전 모드에서 셸 모드와 동일한 트리거**(Ctrl+V / 드롭 / 헤더 버튼) 활성화
3. **브릿지 데이터 패스를 관전 모드까지 확장** — 셸 모드의 ControlMaster 패턴
   복제, `SpectatorSession.sendInput`을 경로 주입 채널로 사용

## 비목표

- 셸 모드 이미지 흐름 변경 (그대로 둠)
- 셸 모드 보내기 팝업 도입 (셸 모드 모바일은 키보드 + 헤더 버튼으로 충분)
- 이미지 형식 변환 / 리사이즈 / 압축
- `imageTransfer`의 업로드 타임아웃 추가 (기존 follow-up과 동일하게 별도 작업)

## 아키텍처

```
폰 (보내기 팝업)                       브릿지                                      타깃 호스트
─────────────────                     ──────────────                              ────────────
[📋 이미지 붙여넣기] ──┐
[📷 이미지 불러오기]  ─┼─ ws image{mime,data}→ handleImageMessage
[textarea onpaste]   ──┘                          │
                                                   ├── 셸 분기 (pty 있음)
                                                   │     ├ transferImage(target, controlPath, ...) ──┐
                                                   │     └ pty.write(bracketedPaste(path) + ' ')      │
                                                   │                                                    │
                                                   └── 관전 분기 (spectator 있음)                       │
                                                         ├ transferImage(target, controlPath, ...) ──┤
                                                         └ spectator.sendInput(                       │
                                                             bracketedPaste(path) + ' '               │
                                                           )                                          │
                                                                                                       │
                                                                                                       ▼
                                                                                  ssh -o ControlPath=<sock>
                                                                                  cat > /tmp/tomboy-images/X
                                                                                  (ControlMaster 재사용 — 재인증 없음)
                                              ws image-ok{path} ──────────────→ "이미지 전송됨" 토스트
```

`SpectatorSession.sendInput`은 이미 임의 바이트를 hex 토큰으로 인코딩해서
`send-keys -t <activePane> -H <hex>`로 활성 패널에 주입한다 — bracketed-paste
마커도 통제 문자도 모두 안전하게 전달된다. 따라서 경로 주입은 셸 모드의
`pty.write(...)` 한 줄을 `spectator.sendInput(...)`으로 치환만 하면 된다.

## 컴포넌트별 변경

### 브릿지 (`bridge/src/`)

#### `server.ts` — `startSpectator`

`startSession`이 하는 것과 동일하게 `controlPath` 생성:

```ts
async function startSpectator(target: SshTarget, session: string) {
  sessionTarget = target;                                      // 신규
  if (!isLocalTarget(target)) {                                // 신규
    controlPath = `${CTRL_DIR}/${randomUUID().slice(0, 8)}.sock`;  // 신규
  }
  // ... 기존 WOL / spawn 로직
  spectator = new SpectatorSession({
    target,
    session,
    controlPath: controlPath ?? undefined,                     // 신규: SpectatorSession이 자기 ssh를 마스터로 띄우게
    callbacks: { /* unchanged */ }
  });
  // ...
}
```

`sessionTarget`을 spectator도 세팅하는 게 핵심 — `handleImageMessage`가
`transferImage`에 넘길 타깃을 단일 변수에서 읽도록 통일.

#### `server.ts` — `handleImageMessage`

가드와 분기 재작성:

```ts
async function handleImageMessage(mime: string, dataB64: string) {
  if (!sessionTarget) {
    send({ type: 'image-error', message: '세션 준비 안 됨' });
    return;
  }
  const bytes = ... // base64 decode (기존 로직)
  try {
    const { remotePath } = await transferImage({
      target: sessionTarget, controlPath, mime, bytes
    });
    const paste = bracketedPaste(remotePath) + ' ';
    if (pty) {
      pty.write(paste);
    } else if (spectator) {
      spectator.sendInput(paste);
    } else {
      send({ type: 'image-error', message: '세션 준비 안 됨' });
      return;
    }
    send({ type: 'image-ok', path: remotePath });
  } catch (err) {
    send({ type: 'image-error', message: (err as Error).message });
  }
}
```

`controlPath`가 null이면 (로컬 타깃이면) `imageTransfer`가 그 분기를 알아서
처리(`isLocalTarget` 경로) — 기존 동작 유지.

#### `pty.ts` — ControlMaster 플래그 추출 (소 리팩터)

현재 `buildSshArgs(t, controlPath?)`가 ControlMaster 플래그를 내장하고 있다.
이를 분리해서 spectator도 재사용:

```ts
// pty.ts (신규 export)
export function controlMasterArgs(controlPath: string): string[] {
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ControlPersist=60',
  ];
}

// buildSshArgs는 controlMasterArgs를 호출하도록 내부 수정 (동작 불변)
```

#### `spectatorSession.ts` — ControlMaster 마스터 옵션

`SpectatorSession`은 자체 ssh 인자를 인라인으로 만든다(`-tt`, `stty cols/rows`,
인라인 `tmux -CC attach ...` 명령) — `buildSshArgs`를 그대로 못 쓰지만,
`controlMasterArgs(controlPath)`만 적절한 위치에 끼워 넣으면 된다:

```ts
// 기존 (spectatorSession.ts:125~)
const args: string[] = ['-tt'];
if (opts.target.port) args.push('-p', String(opts.target.port));
args.push('-o', 'StrictHostKeyChecking=accept-new');
+ if (opts.controlPath) args.push(...controlMasterArgs(opts.controlPath));
args.push(
  opts.target.user ? `${opts.target.user}@${opts.target.host}` : opts.target.host
);
args.push(
  `stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t ${opts.session}`
);
```

생성자 시그니처에 `controlPath?: string` 추가. ControlMaster 마스터가
이 ssh 프로세스에 붙으므로, ssh가 살아 있는 동안 (= spectator 세션이 활성
동안) 다른 ssh 클라이언트가 `-o ControlPath=<sock>`으로 인증 없이 멀티플렉싱
가능하다 — 정확히 셸 모드 PTY ssh가 마스터 역할을 하는 것과 동일.

### 프론트엔드 (`app/src/lib/editor/terminal/`)

#### `TerminalView.svelte` — 데스크탑 관전 활성화

4개 `if (isSpectator) return;` 가드 제거:

```ts
function handleImagePaste(e: ClipboardEvent) {
  // (가드 제거)
  const file = extractImageFile(e.clipboardData);
  if (!file) return;
  e.preventDefault();
  e.stopPropagation();
  void sendImageFile(file);
}
// handleImageDragOver, handleImageDrop도 동일
```

헤더 "이미지" 버튼 게이트 풀기:

현재 헤더 액션 영역의 단일 `{#if !isSpectator}` 블록 안에 두 버튼(히스토리,
이미지)이 같이 들어 있다. 히스토리 버튼은 셸 모드 전용으로 유지하고 이미지
버튼을 밖으로 꺼낸다:

```svelte
{#if !isSpectator}
  <button type="button" class="toggle" onclick={togglePanel}>
    히스토리 ({currentItems.length})
  </button>
{/if}
<!-- 신규 위치: 셸/관전 둘 다 표시 -->
<button type="button" class="toggle"
        onclick={openImagePicker}
        disabled={status !== 'open' || imageUploadCount > 0}>
  {imageUploadCount > 0 ? '업로드 중…' : '이미지'}
</button>
```

#### `TerminalView.svelte` — 모바일 보내기 팝업 확장

기존 팝업 마크업:

```svelte
{#if sendPopupOpen}
  <div class="send-popup">
    <input type="text" bind:value={sendPopupText} ... />
    <button>닫기</button> <button>타이핑만</button> <button>전송</button>
  </div>
{/if}
```

확장:

```svelte
{#if sendPopupOpen}
  <div class="send-popup">
    <input type="text"
           bind:value={sendPopupText}
           onpaste={onSendPopupPaste}                          <!-- 신규 -->
           ... />
    <div class="send-popup-image-row">                         <!-- 신규 -->
      <button type="button"
              onclick={onClickPasteImage}
              disabled={imageUploadCount > 0 || status !== 'open'}>
        {imageUploadCount > 0 ? '업로드 중…' : '📋 이미지 붙여넣기'}
      </button>
      <button type="button"
              onclick={openImagePicker}
              disabled={imageUploadCount > 0 || status !== 'open'}>
        📷 이미지 불러오기
      </button>
    </div>
    <button>닫기</button> <button>타이핑만</button> <button>전송</button>
  </div>
{/if}
```

세 신규 핸들러:

```ts
/** textarea/input의 paste — 클립보드에 이미지가 있으면 가로채 전송. */
function onSendPopupPaste(e: ClipboardEvent) {
  const file = extractImageFile(e.clipboardData);
  if (!file) return;       // 이미지 없음 → 평문 paste fall-through
  e.preventDefault();
  void sendImageFile(file);
}

/** "📋 이미지 붙여넣기" 버튼 — navigator.clipboard.read() 시도. */
async function onClickPasteImage() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const file = new File([blob], 'pasted', { type });
          void sendImageFile(file);
          return;
        }
      }
    }
    pushToast('클립보드에 이미지가 없습니다.', { kind: 'error' });
  } catch (err) {
    pushToast(
      (err as Error).name === 'NotAllowedError'
        ? '클립보드 접근 권한이 거부되었습니다.'
        : '클립보드를 읽을 수 없습니다.',
      { kind: 'error' }
    );
  }
}
```

`openImagePicker`(헤더 버튼이 쓰는 함수)와 `imageFileInput`(숨은 `<input
type="file">`)은 이미 존재 — 팝업의 "이미지 불러오기" 버튼이 같은 함수를
재사용한다. 다중 선택 + 검증 + 전송 흐름이 그대로 흘러간다.

### `app/src/lib/editor/terminal/imagePasteClient.ts`

변경 없음. `extractImageFile`, `validateImageFile`, `imageFilesFromList`,
`fileToImagePayload`가 그대로 사용된다.

### `app/src/lib/editor/terminal/wsClient.ts`

변경 없음. `sendImage({mime, data})` 메서드와 `onImageResult` 콜백이 그대로.

## 데이터 흐름 (관전 모드)

```
1. 폰 — 보내기 팝업 열림
2. 사용자 액션:
   (a) "📋 이미지 붙여넣기" 클릭
       → navigator.clipboard.read() → 이미지 ClipboardItem → File
   (b) "📷 이미지 불러오기" 클릭
       → imageFileInput.click() → <input type="file">의 onchange → File들
   (c) textarea에 이미지 paste (모바일 키보드의 "이미지 삽입" / 데스크탑 Ctrl+V)
       → onpaste → extractImageFile → File
3. sendImageFile(file)
   → validateImageFile 검증
   → fileToImagePayload(file) → base64
   → wsClient.sendImage({ mime, data })
   → ws 메시지 {type:'image', mime, data}
4. 브릿지 onmessage → handleImageMessage(mime, data)
   → sessionTarget, controlPath 확인
   → transferImage(...) → /tmp/tomboy-images/tomboy-<ts>-<hex>.png 생성
   → spectator.sendInput(bracketedPaste(remotePath) + ' ')
   → SpectatorSession.sendInput → tmux send-keys -t <activePane> -H <hex>
   → 활성 패널의 TUI(클로드 코드 등)가 bracketed-paste 마커 사이의 경로 인식
5. 브릿지 → ws image-ok{path}
6. 폰 → "이미지 전송됨" 토스트
```

## 에러 처리

| 상황 | 어디서 | 사용자 피드백 |
|------|--------|---------------|
| 클립보드 권한 거부 | 폰 (clipboard API) | "클립보드 접근 권한이 거부되었습니다." |
| 클립보드에 이미지 없음 | 폰 (clipboard API) | "클립보드에 이미지가 없습니다." |
| 검증 실패 (타입/크기) | 폰 (`validateImageFile`) | "이미지 형식이 아닙니다." / "10 MB 초과" |
| WS 미연결 | 폰 (`sendImageFile`) | "터미널이 연결되어 있지 않습니다." |
| 세션 미준비 (race) | 브릿지 (`handleImageMessage`) | "세션 준비 안 됨" |
| 활성 패널 모름 | 브릿지 (`sendInput` no-op) | (no-op — `image-ok` 보내지만 주입 안 됨) ⚠ |
| ssh 업로드 실패 | 브릿지 (`transferImage` throw) | "이미지 전송 실패: <error>" |

⚠ "활성 패널 모름" 케이스가 issue가 될 수 있다. 관전 세션 시작 직후 첫
`pane-switch` 프레임이 오기 전에 이미지를 보내면 `SpectatorSession.sendInput`이
`!this.activePaneId`로 조용히 빠져나간다. 보호를 위해:

- 클라이언트의 `sendImage` 호출 시점에 이미 `status === 'open'` 가드를 통과
  하지만, `open` ≠ "활성 패널 확인됨".
- 보강책: `handleImageMessage`가 spectator 분기에서 `spectator.sendInput` 호출
  **직전**에 `spectator.hasActivePane()`(신규 메서드, 1줄) 확인 → 없으면
  `image-error: '활성 패널을 아직 인식하지 못했습니다'`.

## 보안

- 셸 모드와 동일한 모델 — 사용자 자격증명은 PTY/spectator의 ssh 핸드셰이크에서
  검증되고, 이미지 업로드는 그 검증된 ControlMaster 소켓을 재사용한다. 브릿지가
  자격증명을 새로 받지도 저장하지도 않는다.
- 원격 파일명은 브릿지가 생성(`safeImageName`): `tomboy-<unix-ms>-<4바이트 hex>.<ext>` —
  클라이언트가 보낸 이름은 사용하지 않는다 (shell injection 차단).
- 16 MB WS payload 상한, 10 MB 이미지 크기 상한 (셸 모드와 동일).

## 테스트

### 신규

**`bridge/src/spectatorSession.image.test.ts`**:
- `SpectatorSession`이 `controlPath` 옵션을 받았을 때 spawn된 ssh 명령에
  `-o ControlMaster=auto -o ControlPath=<path>`가 포함되는지 (pure
  `buildSshArgs` 호출로 검증).
- `sendInput`이 bracketed-paste 마커 + 경로 + 공백을 hex로 인코딩해서
  `send-keys -H ...` 명령을 만드는지.
- `activePaneId === null`일 때 `sendInput`이 no-op인지.

**`bridge/src/server.spectator-image.test.ts`**:
- ws에 `{type:'image', mime, data}` 메시지 → spectator 분기로 들어가
  `transferImage` 호출 + `spectator.sendInput(bracketedPaste(path) + ' ')`
  호출되는지 (fake transferImage + fake SpectatorSession으로 단위 테스트).
- `sessionTarget`이 null이면 `image-error` 회신.

**`app/tests/unit/editor/sendPopupImageButtons.test.ts`**:
- 팝업 textarea의 `onpaste` 핸들러: 이미지 ClipboardItem 있으면
  `sendImage` 호출 + `preventDefault`, 없으면 fall-through.
- `onClickPasteImage` 핸들러: clipboard.read 성공 시 `sendImage` 호출,
  `NotAllowedError` 시 권한 거부 토스트, 이미지 없으면 "이미지 없음" 토스트.

### 기존 (회귀 방지)

- `bridge/src/server.ts`의 셸 모드 image 처리 회귀 없음 확인 (기존 테스트 통과).
- `TerminalView.svelte`의 데스크탑 셸 모드 Ctrl+V/드롭/헤더 동작 회귀 없음
  확인 (기존 통합 행동 변경 없음 — 가드만 빠짐).

## 마이그레이션 / 호환성

- 노트 포맷 변경 없음. `spectate:` 키만 있는 기존 노트가 자동으로 새 기능
  대상이 된다.
- 브릿지 신/구 호환: 구 브릿지 + 신 클라이언트 조합에서는 spectator 모드
  image 메시지가 무음 무시된다 (기존 가드). 클라이언트는 일정 시간 안에
  `image-ok`/`image-error`가 안 오면 `imageUploadCount`를 풀 메커니즘이 이미
  없다 — 이는 셸 모드도 동일한 한계이고 별도 follow-up. 본 작업의 스코프에는
  영향 없음 (재연결 시 `imageUploadCount = 0` 리셋은 이미 있음).
- 클라이언트 신/구 호환: 구 클라이언트는 spectator 모드에서 image 메시지를
  보내지 않으므로 영향 없음.

## 배포 / 운영 노트

- 타깃 호스트 요구사항 변경 없음 — 셸 모드 이미지가 이미 작동하는 호스트면
  관전 모드 이미지도 작동한다. (필요 사항: `/tmp/tomboy-images/` 쓰기 가능,
  tmux 3.0+, `send-keys -H`.)
- 원격 `/tmp/tomboy-images/` 파일 누적 정리는 OS 자동 정리에 맡김 (기존 한계
  동일).

## CLAUDE.md / 스킬 문서 갱신

- `CLAUDE.md`의 "터미널 노트" 섹션 — "이미지 붙여넣기" 줄에 "관전 모드에서도
  지원 (모바일 보내기 팝업 + 데스크탑 동일 트리거)" 한 줄 추가.
- `.claude/skills/tomboy-terminal/SKILL.md` — 관전 모드 이미지 입구 두 곳
  (모바일 팝업 / 데스크탑 가드 해제) 명시. Quick map에 신규 핸들러
  `onSendPopupPaste`, `onClickPasteImage` 위치 추가.
