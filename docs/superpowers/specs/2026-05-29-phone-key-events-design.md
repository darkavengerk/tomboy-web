# 폰 키 이벤트 노트 설계 (`keys://phone`)

> tomboy-web ↔ LG V30 연동 2탄. 특수 노트를 열면 폰에 보낼 수 있는 키들이 버튼으로 뜨고, 누르면 폰에 키 이벤트가 주입된다. v1 범위: 볼륨 업/다운.

**날짜:** 2026-05-29
**브랜치:** `phone-key-events` (base: `phone-ssh-reverse-tunnel`)
**선행 기능:** 노트 `ssh://phone` 역터널 (`2026-05-29-phone-ssh-reverse-tunnel-design.md`) — bridge↔폰 ssh 경로·별칭·터널 도달성 probe 재사용.

---

## 1. 목표 / 범위

- 새 특수 노트 프로토콜 `keys://[user@]host[:port]`. 본문 첫 줄이 이 형식이면 일반 에디터 대신 **키패드 뷰**를 띄운다.
- v1 키 세트: **볼륨 업(keycode 24) / 볼륨 다운(keycode 25)** 2버튼 고정 패드.
- 누르면 폰 볼륨이 실제로 바뀐다. 반복 입력도 빠르게.

**비범위 (YAGNI):**
- 볼륨 외 키(전원/홈/미디어 등) — 화이트리스트에 코드만 추가하면 되도록 설계하되 v1엔 안 넣음.
- 노트 본문으로 키 목록 선언 — v1은 빌트인 고정 패드.
- 데스크탑 멀티윈도우(`NoteWindow.svelte`) 패리티 — 필요 시 후속.

## 2. 핵심 기제 (검증됨)

- 폰은 루팅(Magisk). `su -c 'input keyevent 24'` → rc=0, 볼륨 변경 확인 (adb shell uid 2000 경유).
- 평문 `input`은 Termux 앱 uid(10186)에 `INJECT_EVENTS` 권한이 없어 실패 → **반드시 `su -c`** 경유.
- bridge↔폰 경로: 기존 역터널(`ssh://phone` → RPi `localhost:18022` → 폰 sshd 8022, Termux user `u0_a186`).

## 3. 아키텍처

```
keys://phone 노트
   │ parseKeysNote → KeysNoteSpec{host,user?,port?}
   ▼
KeysView.svelte ──WS /ws──▶ bridge server.ts
   ▲   buttons ▲▼              │ mode:'keys' 분기
   │                           ├ 토큰 검증 (기존)
   │                           ├ applySshAlias: ssh://phone → localhost:18022 (기존)
   │                           ├ 터널 도달성 probe (기존)
   │                           ├ ControlMaster 프리웜: ssh … true → {ready}
   │  {type:'key',code:24} ───▶├ isAllowedKeyCode(code) (keyEvents.ts)
   │                           └ ssh -o ControlPath=<sock> phone 'su -c "input keyevent 24"'
   │  ◀── {key-ok,code} / {key-error,code,message}
```

와이어상 타깃은 `ssh://phone`(scheme 동일)이고 `mode:'keys'`만 추가 → bridge의 `parseSshTarget`/`applySshAlias`/probe를 **무수정 재사용**. `keys://`는 프론트엔드 전용 마커.

## 4. 컴포넌트 / 파일

### 프론트엔드 (`app/`)

**`app/src/lib/editor/keyRemote/parseKeysNote.ts`** (신규)
- `export interface KeysNoteSpec { host: string; user?: string; port?: number; raw: string }`
- `export function parseKeysNote(doc): KeysNoteSpec | null`
- 정규식 `^keys:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$` — `parseTerminalNote.ts`의 `SSH_RE` 미러(첫 메타 줄에서 추출하는 방식도 동일).
- 포트 범위(1–65535) 밖이면 무시(null) — terminal 파서 동작과 일치.

**`app/src/lib/editor/keyRemote/keysClient.ts`** (신규)
- 얇은 WS 클라이언트. `bridgeSettings`의 `getDefaultTerminalBridge`/`getTerminalBridgeToken` + `bridgeToWsUrl` 재사용.
- API: `connect(target, callbacks)`, `sendKey(code)`, `close()`.
- 콜백: `onReady()`, `onKeyOk(code)`, `onKeyError(code, message)`, `onError(message)`, `onClose()`.
- 터미널 `wsClient.ts`는 PTY data 프레임 전용이라 재사용하지 않고 별도 경량 구현.

**`app/src/lib/editor/keyRemote/KeysView.svelte`** (신규)
- props: `spec: KeysNoteSpec`, `guid`.
- 고정 버튼 패드: `[{label:'🔊 볼륨 업', code:24}, {label:'🔉 볼륨 다운', code:25}]` (코드 상수 1곳).
- 연결 상태 표시(연결 중/준비됨/에러). 버튼 누름마다 일시 피드백(✓ / ✗ + 메시지).
- 마운트 시 `keysClient.connect('ssh://'+target, …)`, 언마운트 시 `close()`.

**`app/src/routes/note/[id]/+page.svelte`** (수정)
- `parseKeysNote` + `KeysView` import.
- `let keysSpec = $state(null)`; 로드/편집/리로드 시 `keysSpec = parseKeysNote(editorContent)` (terminalSpec 옆에서).
- "접속" 게이팅 + 렌더 분기: `{:else if showKeys && keysSpec}<KeysView … />` — terminalSpec 패턴 미러.
- terminal/keys 동시 매칭 불가(프로토콜 배타적)지만, 안전하게 keys 분기를 terminal 분기와 동급으로 둠.

### 브리지 (`bridge/`)

**`bridge/src/keyEvents.ts`** (신규, 순수 함수, 테스트가능)
- `export const KEY_WHITELIST: Record<number,string> = { 24:'VOLUME_UP', 25:'VOLUME_DOWN' }`
- `export function isAllowedKeyCode(code: unknown): code is number` — 정수 & 화이트리스트 키일 때만 true.
- `export function buildKeyCommand(code: number): string` — `isAllowedKeyCode` 가정, 고정 템플릿 `` `su -c 'input keyevent ${code}'` `` (정수만 보간; 호출 전 검증 필수).

**`bridge/src/server.ts`** (수정)
- `ClientMsg`: `type`에 `'key'` 추가, `mode?: 'shell' | 'spectate' | 'keys'`, `code?: number`.
- `ServerMsg`: `type`에 `'key-ok' | 'key-error'` 추가.
- connect 핸들러: `msg.mode === 'keys'` → `startKeys()` (PTY/spectator 대신).
  - 기존 토큰 검증·`applySshAlias`·터널 probe 그대로 통과 후,
  - keys 모드는 **원격 타깃 전용**: `isLocalTarget(target)`면 `{type:'error', message:'keys 모드는 원격 폰 타깃 전용'}` + close.
  - ControlMaster 소켓 경로 생성(기존 `/tmp/tomboy-ctl/{uuid}.sock` 패턴) → 프리웜 `ssh <opts> <target> true` 실행. 성공 → `{type:'ready'}`; 실패(인증/도달) → `{type:'error', message}` + close.
- `key` 메시지 핸들러(keys 모드에서만): `isAllowedKeyCode(msg.code)` 거짓 → `{type:'key-error', code, message:'허용되지 않은 키코드'}` (연결 유지). 참 → `ssh -o ControlMaster=auto -o ControlPath=<sock> -o ControlPersist=60 <target> buildKeyCommand(code)` 실행 → exit 0이면 `{type:'key-ok', code}`, 아니면 `{type:'key-error', code, message:<stderr 요약>}`.
- WS close 시 master 소켓 정리(`ssh -O exit -S <sock> <target>` best-effort).
- ssh argv 빌더는 기존 `pty.ts`의 원격 옵션 구성과 동형(같은 키/호스트키/타임아웃 옵션). 공유 헬퍼로 뽑거나 keys 전용으로 최소 복제.

## 5. 보안

- 와이어로 오는 건 **정수 keycode뿐**. 원격 명령은 고정 템플릿에 검증된 정수만 보간 → 셸 인젝션 불가.
- 비화이트리스트 코드는 거부(연결 유지, 해당 키만). 임의 문자열·음수·범위 외 모두 차단.
- 토큰 인증은 기존 WS connect 경로 그대로.

## 6. 에러 처리

| 상황 | 동작 |
|---|---|
| 토큰 불량 | 기존 에러 + close |
| 타깃 파싱 실패 / 로컬 타깃 | `{error}` + close |
| 터널 끊김 | 기존 친절 probe 에러("폰이 깨어/연결됐는지") + close |
| 프리웜 ssh 실패(인증/도달) | `{error}` + close |
| 비화이트리스트 keycode | `{key-error}`, 연결 유지 |
| ssh/su 실패(grant 거부 등) | `{key-error, message:<stderr>}`, 연결 유지 |

KeysView는 연결 단계 에러는 상태 배너로, 키 단위 에러는 버튼 옆 일시 ✗+메시지로 표시.

## 7. 테스트

- **bridge 단위** (`node --test`, `sshHosts.test.ts` 패턴): `keyEvents.ts` — 24/25 통과, 비화이트리스트(0/99/전원코드) 거부, 비정수/문자열/음수/소수 거부, `buildKeyCommand(24)` === `su -c 'input keyevent 24'`.
- **프론트 단위** (vitest): `parseKeysNote.ts` — `keys://phone`, `keys://u@h:9999`, 포트 범위 외 null, 비-keys(`ssh://…`/평문) null, 필드 추출 정확.
- **수동 E2E (사용자 게이트)**: 앱에서 `keys://phone` 노트 열고 ▲/▼ → 폰 볼륨 OSD 변화 확인.

## 8. 구현 중 검증 리스크

- **Termux uid su grant**: 역터널 로그인은 `u0_a186`. 그 uid가 Magisk에서 root 허용돼 있어야 `su -c`가 통과. adb shell(uid 2000)은 확인됨; Termux uid는 첫 실제 키에서 확인(미허용 시 폰 Magisk에서 Termux/shell grant). 프리웜 단계에서 `ssh phone 'su -c id'`로 조기 확인하는 옵션도 가능.
- **ControlMaster 첫 키 지연**: 프리웜으로 master를 미리 띄워 둘째 키부터(그리고 프리웜이 성공하면 첫 키부터) 저지연.
