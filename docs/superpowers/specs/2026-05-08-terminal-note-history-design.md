# 터미널 노트 명령어 히스토리 — 디자인

**날짜:** 2026-05-08
**상태:** 디자인 검토 대기
**스코프:** 터미널 노트(`ssh://...`)에 명령어 히스토리 패널 추가. xterm.js 위에서 OSC 133 셸 통합 마커로 명령어를 캡처하고, 노트 본문에 최대 50개를 보관하며, 패널에서 클릭으로 재입력할 수 있게 한다.

## 요약

현재 터미널 노트는 본문이 정확히 1~2 단락(SSH URL [+ bridge URL])일 때만 활성화된다. 본 변경은 본문 끝에 선택적 `history:` 헤더 + bulletList 블록을 허용하여 명령어 히스토리를 보관한다. xterm.js 위에서 OSC 133 시퀀스를 가로채 명령 경계를 인식하고, 버퍼에서 명령어를 추출한 뒤, 디바운스된 read-modify-write로 노트 본문에 prepend한다 (최대 50, 같은 명령은 move-to-top). UI는 데스크톱 우측 사이드 패널 / 모바일 하단 바텀 시트로 토글된다. Shift+클릭은 즉시 실행, 일반 클릭은 입력만.

저장이 노트 본문이므로 Dropbox/Firebase 동기화가 그대로 적용되어 모든 디바이스에서 공유된다.

---

## 섹션 1 — 노트 포맷 & 파서

### 확장된 본문 구조

```
ssh://[user@]host[:port]          ← 단락 1 (필수)
bridge: wss://...                 ← 단락 2 (옵션, 기존과 동일)
                                  ← 빈 단락 (옵션 구분자, 무시됨)
history:                          ← 헤더 단락 — 정확히 이 텍스트
- ls -la /var/log                 ← bulletList, 최대 50항목
- sudo systemctl restart caddy
- tail -f /var/log/messages
```

### 규칙

- 본문이 `(SSH 1줄) [+ bridge 1줄]` 까지면 기존 동작 그대로 (히스토리 비어있는 새 노트와 동등)
- 그 다음에 `history:` 단락이 오고 그 직후 `bulletList` 블록이 오면 히스토리로 인식
- `history:` 헤더 없는 자유 단락이 끼면 → 일반 노트로 폴백 (현재와 동일)
- 불릿 항목 텍스트만 추출 (마크 무시); 빈 항목·중첩 리스트 무시
- 50개 초과 시 가장 오래된(리스트 끝) 항목부터 잘라냄. 새 명령은 **맨 위에 prepend**

### 왜 `history:` 헤더가 필요한가

헤더 없이 그냥 bulletList만 따라오면 사용자가 의도치 않게 만든 글머리 기호 노트가 우연히 터미널 노트로 인식될 위험이 있다. 헤더로 명시적 opt-in 마커.

### 파서 시그니처

```ts
export interface TerminalNoteSpec {
  target: string;
  host: string;
  port?: number;
  user?: string;
  bridge?: string;
  history: string[];   // ← 추가. 비어있으면 [].
}

export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null;
```

호출부 호환 유지 — 기존 호출자는 `history`를 무시해도 동작.

---

## 섹션 2 — 명령어 캡처 (OSC 133 + 버퍼 스크레이프)

### OSC 133 마커

| 시퀀스 | 의미 | 우리가 하는 일 |
|---|---|---|
| `ESC ] 133 ; A ST` | 프롬프트 시작 | 무시 |
| `ESC ] 133 ; B ST` | 명령 입력 시작 | 현재 커서 좌표 기록: `(promptRow, promptCol)` |
| `ESC ] 133 ; C ST` | 명령 실행됨 | 명령어 추출 → 필터 → 큐 |
| `ESC ] 133 ; D [;exitcode] ST` | 명령 종료 | 무시 (추후 종료코드 표시 확장 여지) |

### 파싱 위치

들어오는 WS 바이너리 청크를 xterm에 `term.write()` 하기 *전*에 OSC 133을 가로챈다. xterm.js의 `parser.registerOscHandler(133, handler)` API로 등록. handler는 `true`를 반환해 xterm이 시퀀스를 화면에 출력하지 않도록 한다.

### 명령어 추출 (;C 시점)

1. xterm 버퍼에서 `(promptRow, promptCol)`부터 현재 커서 위치까지의 텍스트를 읽는다.
2. 줄 래핑 처리: `term.buffer.active.getLine(y).isWrapped`가 true면 이전 줄과 이어 붙임. 위로 거슬러 올라가 `promptRow`에 도달하면 멈춤.
3. **trim 전에** 첫 글자가 공백/탭이면 폐기 (`HISTCONTROL=ignorespace` 관행).
4. `trim()`. 빈 문자열이면 폐기.
5. 첫 토큰(공백 분할) 추출 → 블록리스트(섹션 6의 설정값)에 있으면 폐기.
6. 통과한 명령어를 메모리 큐에 적재 → 섹션 3의 저장 파이프라인으로.

### 셸 통합 스니펫 (사용자가 원격에 1회 설치)

```bash
# ~/.bashrc (zsh도 거의 동일)
__th_osc() {
  if [ -n "$TMUX" ]; then
    printf '\ePtmux;\e\e]133;%s\a\e\\' "$1"
  else
    printf '\e]133;%s\a' "$1"
  fi
}
PS1='\[$(__th_osc A)\]'"$PS1"'\[$(__th_osc B)\]'
PROMPT_COMMAND='__th_osc "D;$?"; '"${PROMPT_COMMAND:-}"
trap '__th_osc C' DEBUG
```

`trap ... DEBUG`이 명령 실행 직전에 발화 → ;C 송출. tmux 안에서는 DCS 패스스루로 자동 래핑되어 외부 xterm까지 전달된다.

### 미감지 처리

첫 OSC 133을 본 시점에 `shellIntegrationDetected = true`. 세션 시작 후 30초가 지나도록 false면 패널 상단에 작은 배너:

> "셸 통합이 감지되지 않았습니다. 명령어가 자동으로 기록되지 않습니다. **[설정 안내 보기]**"

배너는 닫기 가능. dismiss 상태는 전역 — `appSettings.terminalShellIntegrationBannerDismissed`.

### 한계 (디자인 명시, 구현은 NO-OP)

- 셸 통합 미설치 시 캡처 NO-OP, 30s 후 배너
- `su -` / `sudo -i` 등 셸 점프 후 새 셸이 OSC 미송출 → 그 셸의 명령은 캡처 안 됨
- `bash -c "..."` 비대화형 단발 호출은 PS1 안 타므로 캡처 안 됨
- 풀스크린 TUI(vim/less/htop) 내부 키 입력은 OSC 사이클 밖이라 캡처 안 됨
- 다줄 heredoc 명령은 ;C 한 번만 발화 → 첫 줄만 추출되는 한계 (OSC 633 ;E 도입 시 후속 개선 여지)

---

## 섹션 3 — 저장 & 동기화 파이프라인

### 새 모듈 `lib/editor/terminal/historyStore.ts`

```ts
export async function appendCommandToTerminalHistory(
  guid: string,
  command: string
): Promise<void>;

export async function removeCommandFromTerminalHistory(
  guid: string,
  index: number
): Promise<void>;

export async function clearTerminalHistory(guid: string): Promise<void>;
```

### append 내부 동작 (per-guid 직렬화된 promise chain)

1. `getNote(guid)` → IDB에서 현재 노트 로드
2. `parseTerminalNote(parsedDoc)` 호출 → null이면 ABORT (사용자가 그동안 노트를 일반 노트로 변환했거나 삭제됨 — 캡처 그냥 버림)
3. 도큐먼트 mutation:
   - `history:` 헤더 + bulletList가 없으면 새로 만들어 본문 끝에 append
   - 새 명령을 bulletList의 **첫 항목**으로 prepend
   - 이미 동일 텍스트 항목이 있으면 그 위치에서 제거 후 prepend (move-to-top, bash `HISTCONTROL=erasedups` 동작)
   - 50개 초과 시 끝에서 잘라냄
4. 변경된 doc → `noteContentArchiver` 통해 XML 직렬화 → `noteStore.putNote` (이게 `localDirty=true`로 마킹하고 Dropbox 동기화 큐에도 들어감)
5. `notifyNoteSaved(guid)` 호출 → Firebase 실시간 동기화에 반영
6. `noteReloadBus.emitNoteReload(guid)` 호출 → 다른 윈도우(편집 모드로 같은 노트를 열어둔 경우) 새 본문을 다시 읽도록

### 디바운스/배치

명령마다 IDB write 한 번 = 부담스러움. 각 터미널 세션은 큐에 쌓고 **500ms 디바운스 + max 5개 배치**로 flush. 마지막 미발화 큐는 `beforeunload` / `pagehide`에 동기 flush 시도 (best-effort).

### 동시성

- *같은 디바이스, 다른 윈도우* (A 터미널 / B 편집): A의 매 append는 fresh-read-then-write. B의 저장 직후라면 B의 변경 위에 prepend. `noteReloadBus.emitNoteReload`로 B 에디터에도 즉시 반영(B의 pendingDoc은 drop).
- *다른 디바이스 동시 캡처*: Firebase realtime sync의 `changeDate` LWW. 양쪽 명령이 거의 동시면 한쪽 손실 가능. 후속 명령에서 자연스럽게 다시 head로 들어가므로 실용상 무해.
- *Dropbox `지금 동기화` 실행 중 캡처*: `syncManager`는 노트 단위 atomic. localDirty가 sync 시작 후에 set되면 다음 sync에서 처리됨.

### Dropbox 자동 동기화 부활 안 함

이 모든 mutation은 `localDirty=true`만 마킹. 사용자가 명시적으로 "지금 동기화"를 누를 때까지 Dropbox로 안 나간다 (CLAUDE.md 불변식 준수).

### Firebase

`notifyNoteSaved` 호출로 자동 푸시. 사용자가 Firebase 동기화 끔 상태면 NO-OP (기존 게이팅 그대로).

---

## 섹션 4 — UI 패널

### 토글 버튼

`TerminalView.svelte`의 `.terminal-header`에 토글 버튼 추가. 라벨 `히스토리 (N)` — 괄호 안은 현재 항목 수. 클릭 시 패널 열림/닫힘 토글.

### 토글 상태 키 (appSettings)

- `terminalHistoryPanelOpenDesktop` — default `true`
- `terminalHistoryPanelOpenMobile` — default `false`

뷰포트 분기는 `window.matchMedia('(min-width: 768px)')` (또는 기존 데스크톱 모드 라우트 분기).

### 데스크톱 — 열림이 기본

```
┌─ ssh://you@host ──────────────────┬─ 히스토리 ─┐
│ you@host:~$ ls -la                 │ 12개       │
│ total 48                           │────────────│
│ drwxr-xr-x ...                     │ ls -la     │
│ you@host:~$ cd /etc                │ cd /etc    │
│ you@host:/etc$ _                   │ tail -f .. │
│                                    │ docker ps  │
│                                    │ ⋮ (스크롤) │
└────────────────────────────────────┴────────────┘
                                      width: 240px
```

### 모바일 — 닫힘이 기본

```
열림 시:
┌─ ssh://you@host ──────────┐
│ [히스토리 ▾ 12]            │
├────────────────────────────┤
│ you@host:~$ _              │  ← 터미널 영역 ~50%
│                            │
├─ 히스토리 ───────── 닫기 ─┤
│ ls -la                    │  ← 시트 ~50%
│ cd /etc                   │
│ tail -f /var/log/syslog   │
│ docker ps                 │
└────────────────────────────┘
```

### 항목 row 동작

- **클릭** — `client.sendCommand(item, false)` — Enter 없이 텍스트만 전송
- **Shift+클릭** — `client.sendCommand(item, true)` — `\r` 포함 즉시 실행
- **우클릭(데스크톱) / long-press(모바일)** — 컨텍스트 메뉴: 복사 / 삭제 (이 항목만) / 편집 모드로 이동
  - long-press: `pointerdown` + 500ms 타이머. `pointerup`이 그 전에 오면 일반 탭. 일반 탭 시 `navigator.vibrate(20)`.
- 클릭 후 자동으로 `term.focus()`
- 클릭 시 0.15s 동안 항목 highlight 펄스 (CSS transition)

### 패널 헤더

- `⌫ 비우기` — 확인 다이얼로그 후 `clearTerminalHistory(guid)` 호출
- `×` — 패널 닫기 (전역 토글 OFF)

### 실시간 동기화 (UI 측)

`TerminalView`가 `subscribeNoteReload(guid)`로 `noteReloadBus`를 구독 → 다른 디바이스에서 들어온 변경, 또는 편집 모드 윈도우에서의 수동 편집이 즉시 패널에 반영.

### 컴포넌트

`lib/editor/terminal/HistoryPanel.svelte` 새 컴포넌트.
Props: `{ guid, history: string[], onsend, onsendNow, ondelete, onclear, onclose }`.

---

## 섹션 5 — 재입력 동작

### TerminalWsClient에 메서드 추가

```ts
sendCommand(text: string, autoExecute: boolean): void {
  this.send(text + (autoExecute ? '\r' : ''));
}
```

### 의도적 단순화

- **현재 입력 줄이 비어있는지 보장하지 않는다.** Ctrl+U 자동 송출 안 함. 사용자가 prefix를 타이핑한 후 히스토리로 인자 부분을 채우는 패턴(`sudo ` + `[systemctl restart caddy]`)을 깨지 않기 위함.
- **풀스크린 TUI 안에서 클릭 시** 텍스트가 그 앱의 입력으로 전달됨 — 사용자 책임.
- **Shift+클릭 즉시 실행은 위험성을 사용자 의지에 위임.** `rm -rf` 같은 명령도 기본은 입력만 → 사용자가 Enter로 명시적 실행.

---

## 섹션 6 — 설정 페이지 재구성

### 신규 "터미널" 탭

탭 순서: `[Dropbox 계정] [동기화 설정] [터미널] [기본 노트] [정보]`

기존 동기화 설정 탭의 **터미널 브릿지** 영역을 떼어 새 탭으로 옮긴다.

### 탭 구성 (4개 섹션)

```
▸ 브릿지 연결
  - 기본 브릿지 URL (입력)
  - 현재 상태 (로그인/만료)
  - [로그인] [로그아웃]

▸ 명령어 히스토리
  - ☐ 데스크톱에서 패널 기본 열림   (default checked)
  - ☐ 모바일에서 패널 기본 열림     (default unchecked)
  - 최대 보관 개수: 50 (고정, 표시만)
  - 기록하지 않을 명령어 (textarea, 콤마 구분, 첫 토큰 기준)
  - [기본값으로 되돌리기]

▸ 셸 통합 (OSC 133)
  - 안내 문구
  - 스니펫 코드 블록 + [복사] 버튼
  - tmux 자동 감지 안내 (별도 설정 불필요)

▸ 보안
  - 비밀번호 인라인 사용 금지 경고
  - 공백 시작 명령은 캡처되지 않음 안내 (bash ignorespace 관행)
```

### appSettings 추가 키

```ts
{
  // 기존
  terminalBridgeUrl: string;
  terminalBridgeToken: string;

  // 신규
  terminalHistoryPanelOpenDesktop: boolean;   // default true
  terminalHistoryPanelOpenMobile: boolean;    // default false
  terminalHistoryBlocklist: string[];         // default ['ls','cd','pwd','clear','cls','exit','logout','whoami','date','history']
  terminalShellIntegrationBannerDismissed: boolean;  // default false
}
```

---

## 섹션 7 — 엣지 케이스 & 불변식

### 캡처 정확도 한계

| 시나리오 | 동작 |
|---|---|
| 셸 통합 미설치 | NO-OP, 30s 후 배너 |
| `su -` 후 새 셸이 OSC 미송출 | 캡처 안 됨, 외부 셸 복귀 시 자동 재개 |
| `bash -c "..."` 비대화형 호출 | 캡처 안 됨 |
| TUI 내부 (vim/less/htop) | 캡처 안 됨 |
| TUI 안에서 히스토리 클릭 | TUI 입력으로 전달 — 사용자 책임 |
| sudo 비밀번호 프롬프트 | OSC 사이클 밖 → 캡처 안 됨 (안전) |
| paste of multi-line | 각 라인마다 OSC ;C → 별 항목 |
| 빈 Enter | 추출 결과 ''면 폐기 |
| heredoc 다줄 명령 (`<<EOF`) | ;C 한 번 → 추출 결과에 연속 프롬프트(`> `) 본문이 섞여 들어감. 정확한 다줄 캡처 불가 (한계 명시) |

### 노트 형식 변환 시

| 시나리오 | 동작 |
|---|---|
| 편집 모드에서 `history:` 헤더 제거 | 다음 캡처 시 새로 생성 |
| 편집 모드에서 SSH URL 망가뜨림 | 일반 노트로 복귀, append ABORT |
| 편집 모드에서 50개 이상 손으로 추가 | 자동 trim 안 함 (의도 존중). 다음 prepend가 51개째 일으키면 그때 trim |
| 노트 삭제 | append 시 getNote 실패 → ABORT |

### 동시성

| 시나리오 | 동작 |
|---|---|
| 같은 디바이스, A 터미널 / B 편집 모드 | fresh-read-then-write + noteReloadBus로 B 에디터 갱신 |
| 다른 디바이스 동시 캡처 | Firebase LWW. 한쪽 명령 손실 가능, 후속 명령에서 회복 |
| Dropbox `지금 동기화` 진행 중 캡처 | 다음 sync 사이클에 포함됨 |

### 보안

| 시나리오 | 동작 |
|---|---|
| `echo myPassword` 같은 평문 비밀번호 입력 | 그대로 캡처 + Dropbox/Firestore에 평문. 설정 탭 경고문 |
| 공백 시작 명령 (`HISTCONTROL=ignorespace` 관행) | 추출 텍스트가 공백으로 시작하면 폐기 |
| append 실패 (IDB 에러 등) | 콘솔 warn만, 사용자 토스트 안 띄움 |

### 불변식 (CLAUDE.md "터미널 노트" 섹션에 추가)

- **`history:` 헤더는 정확히 이 텍스트.** 다국어화 안 함.
- **히스토리 항목은 단순 텍스트만.** 마크 무시, 중첩 리스트 무시.
- **재입력은 Enter 자동 전송 안 함** (Shift+클릭 제외).
- **공백으로 시작하는 명령은 캡처되지 않음.**
- **노트 본문 = 평문.** 비밀번호 인라인 금지.
- **셸 통합 미설치 시 NO-OP.** 기존 동작과 100% 동일.

---

## 영향받는 파일 (요약)

**신규:**
- `app/src/lib/editor/terminal/historyStore.ts`
- `app/src/lib/editor/terminal/HistoryPanel.svelte`
- `app/tests/unit/editor/historyStore.test.ts`
- (선택) `app/src/lib/components/settings/TerminalSettings.svelte`
- 디자인 문서: 본 파일

**수정:**
- `app/src/lib/editor/terminal/parseTerminalNote.ts` — history 인식
- `app/src/lib/editor/terminal/wsClient.ts` — `sendCommand` 추가
- `app/src/lib/editor/terminal/TerminalView.svelte` — OSC 133 hook + 패널 토글 + HistoryPanel 통합
- `app/src/lib/storage/appSettings.ts` — 신규 키 4개
- `app/src/routes/settings/+page.svelte` — 터미널 탭 신설, 기존 위치에서 브릿지 부분 제거
- `CLAUDE.md` — "터미널 노트" 섹션 확장
- tomboy-terminal 스킬 — 동일 변경 반영

**삭제:** 없음.

---

## 후속/스코프 외

- **OSC 633 (VS Code 확장) ;E 명령어 직접 전달** — heredoc/다줄 명령 정확도 개선 여지.
- **종료코드 시각화 (OSC 133 ;D)** — 히스토리 항목 옆에 ✓/✗ 표시.
- **명령어 검색/필터** — 50개 cap 안에서는 큰 가치 없음.
- **세션별 그룹화** — 현재 디자인은 평면 리스트.
- **모바일 Ctrl 잠금 통합** — schedule 기능과 공유 가능성. 본 스펙 외.
- **데스크톱 패널 너비 사용자 리사이즈** — 240px 고정으로 시작, 추후 추가 여지.

## 결정 로그

| 결정 | 선택 | 대안 |
|---|---|---|
| 명령 캡처 방식 | OSC 133 셸 통합 | 키 입력 누적 / 버퍼만 스크레이프 |
| 저장 위치 | 노트 본문 (50 cap, FIFO) | 로컬 IDB / 명시적 저장 버튼 |
| 재입력 동작 | 클릭=입력, Shift+클릭=실행 | 항상 입력만 / 항상 즉시 실행 |
| 패널 배치 | 우측 사이드(데스크톱) + 하단 시트(모바일) | 하단 칩 스트립 / 도킹 가능 패널 |
| 데스크톱 기본 | 열림 | 닫힘 |
| 필터 정책 | 블록리스트 + 사용자 편집 가능 | 고정 블록리스트 / 길이 기반 |
| 설정 위치 | 신규 "터미널" 탭 | 동기화 설정 탭에 추가 |
