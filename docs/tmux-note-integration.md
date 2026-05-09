# tmux 노트 통합 설계 보고서

## 1. 요약

터미널 노트 기능은 현재 OSC 133 셸 통합을 통해 tmux 윈도우별 명령어 히스토리를 노트에 자동 기록하는 수준까지 구현되어 있다. 이 보고서는 그 위에서 tmux와의 연동을 어떻게 깊게 가져갈 수 있는지, 단기적으로 비용 대비 효과가 높은 개선부터 장기적으로 노트 앱이 tmux를 구동하는 양방향 시나리오까지 체계적으로 검토한다.

---

## 2. 현재 통합 지점

- **OSC 133 A** — 프롬프트 시작. `Osc133State.onPromptStart()`가 호출되어 셸 통합 감지 플래그를 세운다.
- **OSC 133 B** — 커서가 입력 영역 시작으로 이동. `Osc133State.onCommandStart(row, col)`이 좌표를 기록한다.
- **OSC 133 C** — 명령 실행. 페이로드가 `C;<hex>;<winId>` 형태면 명령어 텍스트를 직접 수신하고, 그렇지 않으면 B에서 저장한 좌표로 버퍼를 스크래핑한다. `windowId`가 있으면 `currentWindowKey`를 `tmux:@N`으로 전환하고, 없으면 `null`(비-tmux 버킷)로 리셋한다 (`TerminalView.svelte` 161~196행).
- **OSC 133 W** — PS1이 매 프롬프트에서 발행. `W;<id>` 형태로 tmux 윈도우 전환을 실시간으로 반영한다. 이 단일 시그널로 `tmux attach`, `tmux exit`, 윈도우 이동을 모두 처리한다.
- **per-window 버킷** — `historyStore.ts`의 `HISTORY_CAP = 20`, 500ms 디바운스, move-to-top 중복 제거, `history:tmux:@N:` 섹션으로 직렬화.
- **blocklist** — `shouldRecordCommand`는 선행 공백(`HISTCONTROL=ignorespace`)과 blocklist 첫 토큰을 걸러낸다 (`oscCapture.ts:shouldRecordCommand`).
- **tmux 훅 (사용자 설치 권장)** — `after-select-window`, `client-attached` 훅으로 `run-shell "tmux-integration-snippet"`을 등록해 아이들 상태에서도 `OSC 133 W`가 즉시 발행되도록 하는 방식. 현재 문서 수준 권장 사항이며 플러그인으로 자동화되지 않았다.

---

## 3. 알려진 한계

- **윈도우 전환 후 패널 지연**: `tmux select-window` 이후 다음 프롬프트가 출력될 때까지 `OSC 133 W`가 발행되지 않는다. 훅 없이 수동 전환만 했을 경우 패널은 이전 윈도우 버킷을 표시한 채 멈춘다. `after-select-window` 훅을 설치하면 즉시 갱신되나, 이를 모르는 사용자는 패널이 오래된 상태임을 알아채기 어렵다.
- **tmux detach 후 잔류 상태**: `client-detached` 이벤트에 해당하는 OSC가 없다. 클라이언트가 tmux에서 분리되면 외부 셸의 다음 프롬프트가 나올 때까지 패널은 마지막으로 활성화된 tmux 윈도우 버킷을 계속 표시한다. 비-tmux 버킷으로 전환되지 않는다.
- **윈도우·세션 이름 미반영**: 버킷 키는 `tmux:@N` 형태로 고정된다. 사용자가 `tmux rename-window work`를 실행해도 패널의 레이블은 여전히 `tmux @1`로 표시된다. 사용자가 여러 윈도우를 작업 단위로 명명하는 경우 어느 버킷이 어느 작업인지 구분이 어렵다.
- **히스토리의 로컬성**: 히스토리는 IDB → Dropbox/Firebase 경로로 다른 기기에도 전달되지만, `currentWindowKey`와 "현재 접속 중인 tmux 윈도우"의 대응은 해당 기기의 활성 세션에서만 유효하다. 다른 기기에서 같은 노트를 열어도 어느 버킷이 활성인지 알 수 없다.
- **패널 동기화 실패 감지 없음**: 패널이 오래된 버킷을 표시하고 있어도 사용자에게 시각적 경고가 없다. 마지막 OSC 수신 시각이나 "N초 전 동기화" 지표가 없다.

---

## 4. 단기 개선안 (low-cost wins)

### 4-1. 패널 "↻ 새로 고침" 버튼 및 키보드 단축키

**문제**: `after-select-window` 훅 미설치 환경에서, 또는 연결이 오래되어 패널이 stale 상태일 때 사용자가 현재 윈도우 컨텍스트를 강제로 재동기화할 방법이 없다.

**제안**: `HistoryPanel.svelte`에 `onrefresh` 콜백 prop을 추가한다. `TerminalView.svelte`에서 이를 다음과 같이 구현한다.

```ts
function refreshBucket(): void {
  // 브릿지 → PTY → 셸에 OSC W 재발행 요청 전송
  // 가장 간단한 방식: PS1 재출력을 유도하는 무해한 ANSI 시퀀스 전송
  client?.sendCommand('', true); // 빈 Enter → 프롬프트 재출력
}
```

빈 Enter는 대부분의 셸에서 빈 명령으로 처리되어 즉시 프롬프트를 재출력하고, PS1에 `OSC 133 W`가 포함되어 있으면 `currentWindowKey`가 갱신된다. `shouldRecordCommand`가 빈 문자열을 이미 걸러내므로 히스토리에는 기록되지 않는다.

`TerminalView.svelte` 헤더 영역의 `actions` 섹션에 `↻` 버튼을 추가하고, `HistoryPanel.svelte`의 상단 액션 바에도 동일 버튼을 노출한다.

**수용 기준**: tmux 윈도우를 전환한 뒤 패널이 이전 버킷을 표시하는 상태에서 버튼을 누르면 즉시 올바른 윈도우의 버킷으로 전환된다.

---

### 4-2. 마지막 동기화 지표

**문제**: 패널이 stale 상태인지 사용자가 알 방법이 없다.

**제안**: `TerminalView.svelte`에 `lastOscAt: number | null = $state(null)` 를 추가하고 `OSC 133 W` 또는 `C` 수신 시마다 `Date.now()`로 갱신한다. 헤더의 버킷 레이블 옆에 `$derived`로 계산한 상대 시각을 렌더링한다.

```svelte
const staleSec = $derived(lastOscAt ? Math.floor((Date.now() - lastOscAt) / 1000) : null);
```

60초 이상이면 레이블 색상을 회색으로 바꿔 시각적으로 구별한다. 1초 `setInterval`로 파생값을 갱신하되, `onDestroy`에서 정리한다.

**수용 기준**: 접속 후 60초 이상 OSC를 수신하지 못한 상태에서 레이블이 회색 `(N초 전)` 표시로 변한다.

---

### 4-3. `connect:` 섹션으로 자동 실행 명령어 지정

**문제**: 접속 후 매번 동일한 준비 명령어(`tmux attach -t main`, `cd ~/project` 등)를 수동으로 입력해야 한다.

**제안**: 노트 형식에 `connect:` 섹션을 추가한다. `parseTerminalNote.ts`에 `CONNECT_HEADER_RE = /^connect:$/` 를 추가하고 `TerminalNoteSpec`에 `connectCommands: string[]` 필드를 추가한다. `TerminalView.svelte`의 `onStatus` 콜백에서 `s === 'open'`일 때 배열을 순서대로 `client.sendCommand(cmd, true)`로 전송한다.

```
ssh://you@host
bridge: wss://bridge.example.com/ws

connect:
- tmux attach -t main
```

`connect:` 섹션은 `history:` 섹션보다 앞에, 2번째 메타 단락(bridge 줄) 뒤에 위치하며, 이 섹션이 존재해도 3번째 자유 단락으로 간주하지 않도록 파서에서 명시적으로 허용한다. 자동 실행 명령어는 히스토리에 기록하지 않는다(접속 시 자동 실행되는 명령은 사용자가 직접 실행한 것이 아니므로).

**수용 기준**: `connect:` 섹션이 있는 노트를 열면 접속 직후 해당 명령어들이 자동으로 실행된다. 섹션이 없는 기존 노트는 동작 변화가 없다.

---

### 4-4. `tmux rename-window` 후 패널 레이블 보정 (클라이언트 사이드 맵)

**문제**: 패널 레이블이 `tmux @1`처럼 표시되어 사용자가 작업 단위별로 명명한 윈도우 이름을 볼 수 없다.

**제안**: `TerminalView.svelte`에 `windowNames: Map<string, string> = $state(new Map())` 를 추가한다. `OSC 133 C` 또는 `W` 이벤트에 윈도우 이름 필드를 추가하는 것은 셸 스니펫 수정이 필요하므로 단기 개선안으로는 대신 다음 방식을 사용한다: 사용자가 패널 레이블을 클릭하면 인라인 편집 필드가 활성화되고 입력한 별칭을 `Map<windowId, alias>`에 저장한다. 이 맵은 세션 메모리에만 존재하고 `.note` 파일에는 쓰지 않는다(Tomboy 데스크톱 호환성 보존).

`bucketLabel` `$derived`를 `windowNames.get(currentWindowKey ?? '') ?? currentWindowKey?.replace(/^tmux:/, 'tmux ') ?? '기본'` 형태로 수정한다.

**수용 기준**: 사용자가 패널 레이블을 `work`로 변경하면 해당 세션 동안 `tmux @1` 대신 `work`로 표시된다. 재접속 후에는 기본 레이블로 복원된다.

---

### 4-5. 포커스 복구 시 `W` 재확인 요청

**문제**: 브라우저 탭을 다른 곳으로 이동했다가 돌아오거나, 모바일에서 앱을 백그라운드에 뒀다가 복귀하면 패널이 stale일 수 있다.

**제안**: `TerminalView.svelte`의 `onMount`에서 `document.addEventListener('visibilitychange', ...)` 를 등록한다. `document.visibilityState === 'visible'`로 전환될 때 4-1과 동일한 방식으로 빈 Enter를 전송한다. `client`가 `open` 상태일 때만 실행한다.

**수용 기준**: 탭 전환 후 복귀 시 현재 tmux 윈도우와 패널 버킷이 일치한다.

---

## 5. 중기 개선안 (tmux 플러그인 영역)

### 5-1. `tomboy-tmux.tmux` TPM 플러그인

**문제**: `after-select-window`, `client-attached`, `client-detached`, `session-renamed`, `after-rename-window` 훅을 사용자가 수동으로 `.tmux.conf`에 추가해야 한다. 설치 방법도 각 훅마다 셸 스니펫이 달라 관리가 번거롭다.

**제안**: TPM 플러그인 `tomboy-tmux.tmux`를 `bridge/tmux-plugin/` 아래에 추가한다. 플러그인은 다음 훅을 일괄 등록한다:

```tmux
set-hook -g after-select-window  "run-shell 'printf \\033]133;W;#{window_id}\\007'"
set-hook -g client-attached       "run-shell 'printf \\033]133;W;#{client_current_window}\\007'"
set-hook -g client-detached       "run-shell 'printf \\033]133;W;\\007'"
set-hook -g after-rename-window   "run-shell 'printf \\033]133;N;#{window_id};#{window_name}\\007'"
set-hook -g session-renamed       "run-shell 'printf \\033]133;S;#{session_name}\\007'"
```

`client-detached`의 bare `W` 시그널은 비-tmux 버킷으로 복귀하는 기존 로직(`oscCapture.ts:parseOsc133Payload` — `id` 없는 `W` → `windowId: undefined`)을 그대로 활용한다.

`after-rename-window` 는 새로운 `N` 이벤트 종류를 도입한다. `parseOsc133Payload`에 `N;<windowId>;<name>` 파싱을 추가하고, `TerminalView.svelte`의 OSC 핸들러에서 `windowNames` 맵을 갱신한다.

**수용 기준**: TPM `prefix + I` 후 `.tmux.conf`에 별도 훅 없이도 윈도우 전환/분리/이름 변경이 즉시 패널에 반영된다.

---

### 5-2. 커스텀 OSC로 윈도우 이름 푸시

**문제**: `W;<id>` 페이로드는 윈도우 ID만 전달한다. 사용자가 명명한 윈도우 이름(`work`, `deploy` 등)을 패널 레이블에 표시하려면 클라이언트 사이드에서 별도로 추적해야 한다.

**제안**: `OSC 133 N;<windowId>;<hex-encoded-name>` 를 새로운 시그널로 정의한다. 셸 스니펫과 5-1 플러그인 모두 `after-rename-window` 훅에서 이를 발행한다.

```bash
# PS1 스니펫 확장 — tmux 내부일 때
printf '\033]133;W;%s\007' "$(tmux display-message -p '#{window_id}')"
# 이름 변경 훅 (5-1 플러그인이 담당)
printf '\033]133;N;%s;%s\007' "#{window_id}" "$(printf '%s' '#{window_name}' | xxd -p -c 256)"
```

`parseOsc133Payload`에 `N` 케이스를 추가하고 `Osc133Kind`에 `'N'` 을 포함시킨다. `TerminalView.svelte`의 OSC 핸들러에서 `windowNames.set(windowId, name)` 으로 갱신한다.

`W` 이벤트에도 선택적으로 이름 필드를 포함시켜 `W;<id>;<hex-name>` 로 확장할 수 있다. 이름 없는 `W;<id>` 는 기존대로 동작한다(하위 호환).

**수용 기준**: `tmux rename-window work` 실행 직후 패널 레이블이 `tmux @1 (work)` 형태로 갱신된다.

---

### 5-3. 스냅샷 OSC — 윈도우 목록 패널 전송

**문제**: 현재 패널은 단일 버킷의 히스토리만 표시한다. tmux 세션 전체에서 어느 윈도우에서 무슨 명령을 최근에 실행했는지 한눈에 볼 수 없다.

**제안**: `prefix + ?` (기본 바인딩)를 tmux 플러그인에서 등록하여 `OSC 133 P;<json-hex>` 를 발행한다. JSON 내용은 `tmux list-windows -F "#{window_id} #{window_name} #{window_activity}"` 출력을 구조화한 것이다.

```
OSC 133 P;<hex(JSON)> ST
```

JSON 구조:

```json
{
  "windows": [
    { "id": "@1", "name": "work", "activitySec": 12 },
    { "id": "@2", "name": "deploy", "activitySec": 3600 }
  ]
}
```

브라우저 측에서는 `parseOsc133Payload`에 `P` 케이스를 추가하고, `HistoryPanel.svelte` 상단에 윈도우 목록 요약을 접을 수 있는 섹션으로 렌더링한다. 윈도우 이름 클릭 시 해당 버킷으로 `currentWindowKey`를 직접 전환한다(패널이 터미널 출력 없이도 원하는 버킷으로 이동할 수 있게 한다).

**수용 기준**: `prefix + ?` 실행 시 패널에 윈도우 목록이 표시되고, 항목 클릭으로 해당 버킷으로 전환된다.

---

### 5-4. 멀티-클라이언트 / 다중 기기 훅

**문제**: 두 개의 브라우저 창 또는 기기가 같은 터미널 노트에 접속하면 각각 독립된 `currentWindowKey` 상태를 가진다. 한 클라이언트가 윈도우를 전환해도 다른 클라이언트의 패널은 갱신되지 않는다.

**제안**: 브릿지에 서버 사이드 `tmux`-상태 캐시를 추가한다. `/ws` 핸들러에 `type: 'query_tmux_state'` 메시지를 추가하고, 브릿지는 `child_process.execSync('tmux display-message ...')`로 현재 세션 상태를 반환한다. `TerminalView.svelte`가 `onMount` 시 이 쿼리를 실행해 초기 `currentWindowKey`를 세션 상태에서 가져온다.

이렇게 하면 접속 즉시 올바른 버킷이 표시된다. 단, 이 개선은 브릿지 변경이 필요하며, 브릿지가 실행 중인 호스트에 tmux가 설치되어 있어야 한다는 가정이 생긴다. 노트 형식 변경은 없다.

**수용 기준**: 새 브라우저 탭에서 터미널 노트를 열면 첫 프롬프트가 출력되기 전에도 올바른 tmux 윈도우 버킷이 선택되어 있다.

---

## 6. 장기 비전 (양방향 시나리오)

### 6-1. "이 세션 상태를 노트로 스냅샷"

패널의 버튼 클릭 시 브릿지가 `tmux list-windows -F "#{window_id} #{window_name}"` 와 각 윈도우의 최근 명령어를 조합해 구조화된 텍스트 블록을 생성한다. 이 블록은 현재 노트의 `history:` 섹션과 별도로, 읽기 전용 `snapshot:` 단락으로 노트 본문에 삽입된다.

구현 시 주의 사항: `snapshot:` 단락은 Tomboy 데스크톱에서도 평문으로 보여야 하므로 특수 포맷을 최소화한다. 파서 규칙은 `snapshot:` 헤더가 있어도 3번째 자유 단락으로 취급하지 않도록 명시적으로 허용해야 하며, 이는 현재 "3번째 자유 단락 → 일반 노트로 폴백" 규칙의 예외가 된다. 이 트레이드오프는 설계 시 명확히 결정해야 한다.

---

### 6-2. `connect:` 섹션의 tmux 네임스페이스 명령

`connect:` 섹션에서 `tmux:` 접두어로 시작하는 줄은 PTY로 전송하지 않고 브릿지 사이드에서 `child_process.exec('tmux ...')`로 직접 실행한다.

```
connect:
- tmux: new-session -As main
- cd ~/project
```

첫 줄은 브릿지가 `tmux new-session -As main`을 실행하고, 둘째 줄은 PTY로 `cd ~/project\r`을 전송한다. 이를 통해 접속할 때마다 특정 tmux 세션이 보장되어 있고, 원하는 디렉터리에서 바로 시작한다.

구현은 `server.ts:startSession`에서 `connect` 프레임 처리 직후 `connectCommands` 배열을 순회하며 `tmux:` 접두사 여부로 분기한다. 브릿지 변경과 노트 형식 명세 업데이트가 함께 필요하다.

---

### 6-3. 크로스-디바이스 윈도우 상태 동기화 (Firestore)

`currentWindowKey`를 Firestore의 `users/{uid}/terminalState/{guid}` 에 저장하면 두 기기에서 같은 노트를 보더라도 어느 버킷을 표시할지 동기화할 수 있다.

**트레이드오프**: 구현 복잡도가 상당하고, 사용 시나리오가 좁다(같은 tmux 세션에 두 기기가 동시에 접속하는 경우). Firestore 비용 증가(소규모이지만 실시간 쓰기가 늘어남), 그리고 "히스토리는 노트에, 실시간 상태는 Firestore에" 라는 분리가 아키텍처를 복잡하게 만든다. 단기~중기 개선만으로 이 시나리오를 80%는 해결할 수 있으므로 구현 우선순위는 낮다.

---

### 6-4. "이 윈도우의 히스토리를 다른 노트로 보내기"

특정 tmux 윈도우 버킷의 명령어 목록을 선택해 별도 노트에 복사하는 기능. 패널의 버킷 액션 메뉴에 "이 버킷을 새 노트로 내보내기" 항목을 추가하고, `noteManager.createNote`로 빈 노트를 만든 뒤 `history:` 섹션 포맷으로 내용을 채운다. 일반 노트이므로 Tomboy 데스크톱 호환성 문제가 없다. 아카이빙 용도로 유용하다.

---

## 7. 유틸리티 비교표

| 항목 | 작업량 | 의존성 | 사용자 영향도 |
|------|--------|--------|--------------|
| 4-1 패널 새로 고침 버튼 | S | 없음 | Med |
| 4-2 마지막 동기화 지표 | S | 없음 | Low |
| 4-3 `connect:` 자동 실행 | M | 노트 형식 변경 | High |
| 4-4 클라이언트 사이드 윈도우 별칭 | S | 없음 | Low |
| 4-5 visibilitychange 재확인 | S | 없음 | Low |
| 5-1 `tomboy-tmux.tmux` TPM 플러그인 | M | tmux 플러그인 필요 | High |
| 5-2 커스텀 OSC 윈도우 이름 | M | tmux 플러그인 필요 | Med |
| 5-3 스냅샷 OSC 윈도우 목록 | M | tmux 플러그인 필요 | Med |
| 5-4 브릿지 초기 상태 쿼리 | M | 브릿지 변경 필요 | Med |
| 6-1 세션 스냅샷 노트 삽입 | L | 브릿지 변경 + 노트 형식 변경 | Med |
| 6-2 `connect:` tmux 네임스페이스 | L | 브릿지 변경 + 노트 형식 변경 | High |
| 6-3 Firestore 윈도우 상태 동기화 | L | 브릿지 변경 필요 | Low |
| 6-4 버킷 → 새 노트 내보내기 | S | 없음 | Low |

---

## 8. 위험 / 비기능 요구사항

- **tmux 비인지 셸 경로 유지**: `OSC 133 W` 없이 동작하는 셸(tmux 미사용, 셸 통합 미설치)에서도 터미널 노트는 완전히 정상 동작해야 한다. 모든 개선안은 `shellIntegrationDetected === false` 경로에서 무해해야 한다.
- **OSC 133 기준선 계약**: `A/B/C/D` 의미는 변경하지 않는다. 새로운 `N`, `P` 등의 이벤트는 기존 `parseOsc133Payload`가 `return null`을 반환하는 미인식 케이스로 처리되어야 하므로, 파서 확장 시 기존 `null` 반환 경로가 깨지지 않도록 주의한다.
- **`.note` 파일 Tomboy 데스크톱 호환성**: `connect:`, `pinned:` 등 새 섹션 헤더는 일반 텍스트로 저장된다. 데스크톱 Tomboy에서 열면 평문으로 보이는 것이 의도된 동작이다. 단, tmux 상태(`currentWindowKey`, 세션 스냅샷 등)를 `.note` 파일의 메타데이터로 구조화하는 시도는 하지 않는다 — 데스크톱 호환성을 해치고 Dropbox sync 경로에서 노이즈를 유발한다.
- **브릿지 인증 footprint 유지**: Bearer 토큰 + `BRIDGE_SECRET` 모델은 변경하지 않는다. tmux 쿼리 엔드포인트(5-4)나 브릿지 직접 실행 명령(6-2)은 기존 WS 세션 안에서 처리하고, 새로운 HTTP 엔드포인트나 인증 경로를 추가하지 않는다.
- **노트 크기 한도**: `noteToFirestorePayload`의 900 KB 한도는 스냅샷 삽입(6-1)으로 인해 초과될 수 있다. 스냅샷 삽입 전 크기를 예측 계산하고 초과 시 거부하거나 잘라낸다.
- **브릿지의 셸 접근 권한**: 6-2의 `tmux:` 접두어 명령은 브릿지가 `tmux`를 실행할 수 있는 환경에서만 동작한다. 컨테이너 환경에서 `tmux`가 없으면 조용히 건너뛰고 오류 메시지를 WS로 반환한다.

---

## 9. 추천 순서

1. **4-1 패널 새로 고침 버튼**: 작업량이 가장 적고(S), 추가 의존성이 없으며, 현재 가장 많이 마주치는 "패널이 왜 업데이트 안 되지?" 상황을 즉각 해결한다. `HistoryPanel.svelte`와 `TerminalView.svelte`만 수정하면 된다.

2. **4-3 `connect:` 자동 실행**: 매 접속마다 `tmux attach -t main`을 수동으로 입력하는 반복을 없애는 가장 큰 UX 개선. `parseTerminalNote.ts`와 `TerminalView.svelte` 수정 범위가 명확하고, 기존 노트에 영향이 없다.

3. **5-1 `tomboy-tmux.tmux` TPM 플러그인**: 훅 수동 설치의 진입 장벽을 없애는 중기 개선 중 ROI가 가장 높다. 플러그인이 한 번 설치되면 4-1의 수동 새로 고침 필요성 자체도 크게 줄어든다.
