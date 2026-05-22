# 터미널 노트 — 이미지 붙여넣기 & 터미널 벨

날짜: 2026-05-22
상태: 설계 승인됨 (구현 계획 대기)

## 배경

터미널 노트(`ssh://` 본문 → xterm.js 세션, `tomboy-terminal` 스킬)에서 두 가지를
원한다:

1. **이미지 붙여넣기** — 노트에서 접속한 상태로 클로드 코드 등 터미널 프로그램에
   이미지를 전달.
2. **터미널 벨** — 터미널이 `\x07`로 울리는 벨(클로드 코드 작업 완료음 등)을
   노트에서 소리/진동으로 알림.

### 현재 상태 (왜 추가 구현이 필요한가)

- **이미지**: 지금은 불가능. 클로드 코드 같은 CLI는 이미지를 받을 때 ① 실행
  머신의 OS 클립보드를 직접 읽거나 ② 이미지 파일 *경로*를 입력받는다. 터미널
  데이터 스트림(키 입력 바이트)에는 이미지가 실리지 않는다. 노트의 xterm.js는
  키스트로크만 WS로 전달하고, 클로드 코드는 SSH **원격 호스트**에서 돌기 때문에
  Ctrl+V를 눌러도 원격 호스트의 (관계없는/빈) 클립보드를 읽는다. 브라우저
  클립보드의 이미지는 도달하지 못한다.
- **벨**: `\x07`은 이미 데이터 스트림에 바이트로 실려 노트까지 도착하고 있다.
  xterm.js `onBell` 이벤트만 연결하면 된다. 브릿지 변경 불필요.

## 범위

독립적인 두 기능이 터미널-노트 스택을 공유한다.

- **벨**: 클라이언트 전용. 브릿지 변경 없음.
- **이미지 붙여넣기**: 브릿지 + 클라이언트 양쪽.

둘 다 공유 컴포넌트 `TerminalView.svelte`에 들어가므로 **모바일 노트 라우트와
데스크탑 `NoteWindow` 양쪽에서 자동으로** 동작한다.

**두 기능 모두 shell 모드 한정.** 관전(`tmux -CC`) 모드는 제외한다:

- 벨 — 관전은 데스크탑을 보는 모드라 데스크탑이 직접 소리를 낸다.
- 이미지 — 관전엔 PTY가 없고 `send-keys` 경로뿐이다. 이미지는 데스크탑에서 직접
  붙여넣으면 된다.

비목표(이번 범위 아님):

- 원격 호스트에서 실제 재생되는 오디오(음악, `aplay`, 시스템 알림음) 스트리밍.
  이는 원격의 사운드 출력을 캡처(PipeWire monitor)해 스트리밍하는 별도의 큰
  기능이며 터미널과 무관하다.
- 백그라운드/시스템 알림(노트 탭이 죽어 있을 때의 푸시). 벨은 노트가 살아 있는
  동안의 소리+진동으로 한정한다.

## 채택한 접근 — SSH ControlMaster 멀티플렉싱

이미지 전송의 어려운 부분은 **이미지 바이트를 원격 호스트 파일시스템에 올리는
것**이다(그래야 경로를 주입할 수 있다). 검토한 후보:

- **A. SSH ControlMaster 멀티플렉싱 (채택)** — 브릿지가 PTY용 ssh를
  `-o ControlMaster=auto -o ControlPath=<소켓>`으로 띄운다. 사용자가 PTY에서 한
  번 인증하면 제어 소켓이 생기고, 이미지가 도착하면 브릿지가
  `ssh -o ControlPath=<소켓>`으로 **재인증 없이** 파일을 올린다. SSH 프로토콜은
  하나의 연결 안에 여러 채널을 다중화하므로, 파일 전송은 PTY stdin과 완전히
  분리된 별도 채널을 탄다 — 포그라운드에 클로드 코드가 떠 있어도 PTY 입력을
  건드리지 않는다.
- **B. PTY로 base64 흘려보내기 (기각)** — `base64 -d > file`을 PTY에 직접 쓴다.
  하지만 PTY 입력은 포그라운드 앱이 먹는다. 클로드 코드가 떠 있으면 base64가
  클로드 코드 입력창으로 들어가 깨진다. 이 기능의 목적과 정면 모순.
- **C. 전송용 ssh를 새로 인증해 엶 (기각)** — 새 연결은 새 인증을 한다. 키
  인증이면 자동일 수 있으나 비밀번호 인증이면 사용자에게 비번을 다시 물어야
  한다(브릿지는 비번을 저장하지 않음). 또한 "브릿지는 자격증명을 중개하지
  않는다"는 불변식(`bridge/src/pty.ts`, CLAUDE.md)을 깬다.

`ssh://localhost`(컨테이너 로컬 셸) 타깃은 원격이 없으니 ControlMaster 분기를
타지 않고, 브릿지가 로컬 임시 파일에 직접 쓴다 — A의 자연스러운 특수 케이스.

## 파일 맵

**신규**

- `app/src/lib/editor/terminal/terminalBell.ts` — 벨 사운드/진동/스로틀
- `app/src/lib/editor/terminal/imagePasteClient.ts` — 클라이언트 이미지
  헬퍼(파일→페이로드, 검증, 클립보드/드롭 추출)
- `bridge/src/imageTransfer.ts` — 브릿지 이미지 수신 + 원격 전송
- `app/tests/unit/editor/terminalBell.test.ts` — vitest
- `app/tests/unit/editor/imagePasteClient.test.ts` — vitest
- `bridge/src/imageTransfer.test.ts` — node:test

**수정**

- `bridge/src/pty.ts` — ControlMaster 플래그
- `bridge/src/server.ts` — `image` 메시지 처리, `maxPayload`, 경로 주입, 소켓 정리
- `app/src/lib/editor/terminal/wsClient.ts` — `sendImage`, `onImageResult`
- `app/src/lib/editor/terminal/TerminalView.svelte` — onBell 연결,
  붙여넣기/드롭/버튼 트리거, 업로드 상태
- `app/src/lib/storage/appSettings.ts` — `terminalBellEnabled` getter/setter
- `app/src/routes/settings/+page.svelte` — 벨 토글

## 기능 1 — 터미널 벨

### 동작

1. **연결**: `TerminalView` `onMount`에서 `!isSpectator`일 때 `term.onBell(...)`
   연결. `\x07`은 이미 데이터 스트림으로 도착 중 — 추가 프로토콜 불필요.
2. **`terminalBell.ts`**:
   - **비프음**: Web Audio `OscillatorNode`로 짧은 톤(~150ms, 사인파) 합성.
     클릭음 방지용 attack/decay 엔벨로프. 정적 PWA라 에셋 파일/네트워크 없음.
   - `AudioContext`는 지연 생성 + 첫 사용 시 `resume()`(자동재생 정책 — 사용자는
     노트를 열고 타이핑하며 이미 상호작용했으므로 통과).
   - **진동**: `navigator.vibrate(200)` — 모바일만, 데스크탑은 자동 무시.
   - **스로틀**: 프로그램이 `\x07`을 연타해도 스팸 안 되게 ~300ms당 1회로 합침.
     결정 로직은 순수 함수 `shouldRing(lastAt, now)`로 분리 → 테스트 가능.
3. **설정**: `appSettings`에 `terminalBellEnabled`(기본 on). 설정 페이지 "터미널
   브릿지" 섹션에 토글 추가. off면 핸들러에서 재생 생략.

### 한계 / 주의 (정직하게)

- 노트 탭이 백그라운드면 브라우저가 오디오를 일시중단하거나 진동을 무시할 수
  있다 — 백그라운드 알림을 받지 않기로 했으므로 수용한다.
- 원격이 tmux 안이면 tmux의 `bell-action`/`visual-bell` 설정에 의존한다. 기본
  설정은 벨을 클라이언트로 전달하므로 동작하나, `visual-bell on`이면 소리가 죽는다.

## 기능 2 — 이미지 붙여넣기

### 브릿지 측

#### ControlMaster 적용 (`pty.ts`, `server.ts`)

- `server.ts`의 `startSession`이 세션마다 고유 소켓 경로를 생성:
  `/tmp/tomboy-ctl/<랜덤>.sock`. 디렉터리는 브릿지 부팅 시 `mkdir -p`. Unix 소켓
  경로 길이 제한 때문에 `/tmp` 아래 짧게 둔다.
- `spawnForTarget(target, cols, rows, controlPath?)` — 원격 타깃이면 ssh 인자에
  `-o ControlMaster=auto -o ControlPath=<소켓>` 추가. 로컬 셸 타깃이면
  `controlPath`를 무시한다. `ControlPersist`는 불필요 — 마스터=PTY가 세션 내내
  살아 있다.
- `startSession`이 `controlPath`를 클로저에 보관(이미지 전송 시 필요).
- `ws.close` 시 best-effort `unlink(소켓)`.

#### 새 WS 메시지 — `image`

```
client → server : {type:'image', name, mime, data}   // data = base64
server → client : {type:'image-ok', path}            // 주입된 원격 경로
                  {type:'image-error', message}
```

- `WebSocketServer`에 `maxPayload` ~16 MB 설정(10 MB 이미지의 base64 ≈ 13.3 MB를
  수용). 일반 터미널 `data` 프레임은 작으므로 영향 없음.
- 관전 모드 브랜치는 `image` 메시지를 무시한다(PTY 없음).

#### `imageTransfer.ts` — 전송

`transferImage({ target, controlPath, image })`:

1. base64 디코딩 → 브릿지 로컬 임시 파일.
2. **안전한 파일명 직접 생성**: `tomboy-<unix-ms>-<랜덤>.<ext>`. `ext`는 mime에서
   매핑(`image/png`→png, `image/jpeg`→jpg, `image/webp`→webp, `image/gif`→gif).
   미지원 mime은 거부. **클라이언트가 보낸 `name`은 경로/명령에 절대 쓰지
   않는다**(셸 인젝션 방지).
3. 전송:
   - **원격**: `ssh -o ControlPath=<소켓> -o BatchMode=yes user@host
     'mkdir -p /tmp/tomboy-images && cat > /tmp/tomboy-images/<안전한이름>'` —
     임시 파일을 stdin으로 파이프. 마스터 연결을 재사용해 재인증 0회.
     `BatchMode=yes`라 마스터가 없으면 프롬프트 없이 즉시 실패한다. 원격 경로의
     파일명은 브릿지가 만든 안전한 값이라 셸 메타문자가 없다.
   - **로컬 셸 타깃**: 전송 없이 브릿지 호스트 `/tmp/tomboy-images/<이름>`에 직접
     기록(그 파일시스템이 곧 타깃).
4. 브릿지 로컬 임시 파일 삭제.
5. 원격 경로 반환.

#### 경로 주입

전송 성공 시 `server.ts`가 PTY에 bracketed-paste로 써넣는다:

```
pty.write('\x1b[200~' + 원격경로 + '\x1b[201~')
```

→ 포그라운드 클로드 코드가 붙여넣어진 이미지 경로를 첨부로 인식. **Enter는 자동
입력하지 않는다** — 사용자가 텍스트 프롬프트를 덧붙이고 직접 전송하도록.

이미지 여러 장은 각각 독립된 `image` WS 메시지로 전송된다. 브릿지는 메시지마다
전송 + 경로 주입을 독립적으로 처리하고, 주입한 경로 뒤에 공백 한 칸을 붙여
연속 이미지의 경로가 서로 구분되게 한다.

### 클라이언트 측

#### 트리거 (`TerminalView.svelte`, shell 모드만)

- **데스크탑 Ctrl+V**: xterm 컨테이너에 capture-phase `paste` 리스너.
  `clipboardData.items`에 `image/*`가 있으면 `preventDefault()` 후 전송. 이미지가
  없으면(텍스트만) xterm 기본 붙여넣기로 통과시킨다.
- **데스크탑 드래그앤드롭**: xterm 호스트에 `dragover`(preventDefault) + `drop`
  리스너. `dataTransfer.files`의 이미지 파일을 전송.
- **버튼 (모바일+데스크탑 공용)**: 헤더에 "이미지" 버튼 → 숨겨진
  `<input type="file" accept="image/*" multiple>`를 트리거. 모바일에선
  카메라/사진첩 선택지를 제공한다.

#### `imagePasteClient.ts` — 순수 헬퍼

- `fileToImagePayload(file)` → `{name, mime, data}`(`FileReader` dataURL → base64
  추출).
- `isImageFile(file)`, 크기 검증(>10 MB 거부).
- `extractImagesFromClipboard(DataTransfer)` / `extractImagesFromDrop(DataTransfer)`.

#### `wsClient.ts`

- `sendImage({name, mime, data})` → `image` 프레임 전송.
- `image-ok`/`image-error` 수신 → 새 옵션 콜백 `onImageResult?(ok, info)`.

#### 피드백

- 업로드 중: 헤더 버튼/상태에 "업로드 중…" 표시.
- 결과: 앱의 토스트(`lib/stores/toast.ts`)로 성공("이미지 전송됨") / 실패(사유)
  표시.

## 데이터 흐름 (이미지, 원격 타깃)

```
[브라우저]                    [브릿지 (라즈베리파이)]            [원격 호스트 sshd]
    │                              │                                  │
    │  (연결 시) ssh -o ControlMaster=auto -o ControlPath=<소켓>  ──────▶ 인증 1회
    │                              │  ◀── 제어 소켓 생성              채널 1: PTY 셸
    │                              │                                  │
 Ctrl+V / 드롭 / 파일선택           │                                  │
    │  WS {type:'image',data}  ───▶ base64 디코딩 → 로컬 임시파일       │
    │                              │  ssh -o ControlPath=<소켓> 'cat>'─▶ 채널 2: 파일 수신
    │                              │  로컬 임시파일 삭제              /tmp/tomboy-images/x.png
    │                              │  pty.write('\x1b[200~경로\x1b[201~')─▶ 채널 1로 경로 주입
    │  WS {type:'image-ok'}    ◀───┤                                  클로드 코드가 첨부 인식
 토스트 "이미지 전송됨"             │                                  │
```

## 오류 처리 & 보안

| 상황 | 처리 |
|---|---|
| 인증 완료 전 붙여넣기 | 제어 소켓 없음 → `BatchMode` ssh 즉시 실패 → `image-error` → "원격 연결이 아직 준비되지 않았습니다" 토스트 |
| 이미지 과대(>10 MB) | 전송 전 클라이언트에서 거부 + 토스트 |
| 미지원 mime | 브릿지에서 거부, `image-error` 회신 |
| 파일명 인젝션 | 클라이언트 `name` 미사용, 브릿지가 안전한 이름 자체 생성 |
| scp/ssh 전송 실패 | stderr를 `image-error` 메시지로 회신 |
| 원격 임시 파일 정리 | 세션 종료 시 best-effort `rm`, 그 외 OS의 `/tmp` 청소에 위임 |

## 테스트

- **브릿지** (`node:test`, `imageTransfer.test.ts`): mime→ext 매핑, 안전 파일명
  생성, 전송 명령 구성, 미지원 mime 거부.
- **클라이언트** (vitest):
  - `imagePasteClient.test.ts`: `fileToImagePayload`, 크기 검증, 클립보드/드롭
    이미지 추출.
  - `terminalBell.test.ts`: `shouldRing` 스로틀 결정 로직.
- **수동 QA**: 실제 브릿지로 클로드 코드에 이미지 붙여넣기(데스크탑 Ctrl+V·드롭,
  모바일 파일선택), 실제 `\x07`로 벨 소리/진동.

## 검증 항목 (외부 가정 1개)

**클로드 코드가 bracketed-paste된 이미지 파일 경로를 첨부로 인식하는지** — 구현
계획의 이른 단계에서 실제 확인이 필요하다. 만약 경로 인식이 안 되면(클립보드
바이트만 받는 등) 주입 방식을 조정한다. 경로 인식은 클로드 코드가 지원하는 것으로
보이나, 구현 계획에 QA 체크포인트로 명시한다.

## 후속 (이번 범위 밖, 메모)

- 구현 완료 후 `tomboy-terminal` 스킬 + CLAUDE.md의 터미널 노트 섹션/Quick map
  갱신.
