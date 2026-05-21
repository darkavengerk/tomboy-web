# 리마커블 배경화면 노트

**날짜:** 2026-05-20
**상태:** 디자인 검토 대기
**스코프:** 본문 첫 줄이 `remarkable://<호스트별칭>` 시그니처인 노트를 "리마커블 배경화면 노트"로 인식하고, 정해진 섹션 라벨(`절전 중:` / `부팅 중:` / `전원 꺼짐:` 등) 아래의 이미지 URL을 수집한다. 노트 상단 [적용] 버튼 → 기존 terminal bridge 컨테이너에 `/remarkable/wallpaper` endpoint 1개를 추가해, 브릿지가 이미지를 페치·변환(1404×1872 그레이스케일 PNG)·SSH로 리마커블 `/usr/share/remarkable/<file>.png`에 기록한다. 동기 push — 클릭 시점에 그 자리에서 적용되고 슬롯별 성공/실패가 즉시 응답된다.

## 요약

리마커블(reMarkable 2, 펌웨어 3.x)의 시스템 스플래시 스크린을 노트에서 교체하는 기능. 브라우저는 SSH/SCP를 할 수 없으므로 전달은 **무조건 브릿지(라즈베리파이) 경유**이며, 다행히 `bridge/`에 이미 SSH 인프라와 Bearer 인증·Caddy 노출 표면이 있어 endpoint 1개 확장으로 끝난다. terminal / OCR / 일정 노트와 같은 "특수 노트 family" 패턴(첫 줄 시그니처 + 헤더/섹션)을 그대로 따른다.

전달 모델은 세 후보(브릿지 동기 push / 앱 변환 후 중계 / 리마커블 측 에이전트 pull)를 검토한 끝에 **브릿지 동기 push**로 잠갔다. 리마커블 측 pull 에이전트는 — OTA가 에이전트 자신을 초기화하는 자기모순, 배터리 폴링 비용, 자격증명의 태블릿 이동, 즉시 피드백 부재 때문에 — 비-목표. pull이 노리던 "주기적 재적용 / OTA 자동복구"의 좋은 성질은 **v2에서 파이 측 `systemd` 타이머**(태블릿이 아닌, 항상 켜진 파이가 폴링)로 별도 확보한다.

핵심 결정 잠금:

| | |
|---|---|
| UX 모양 | 특수 노트 family (terminal / OCR / 일정 노트와 동형) — `TomboyEditor` 유지 + 상단 액션 바 |
| 노트 형식 | `remarkable://<호스트별칭>` 시그니처 + 섹션 라벨 아래 이미지 URL |
| 호스트 식별 | 노트에는 **별칭만** — IP·자격증명 노출 없음 (terminal note 불변식과 동일) |
| 전달 경로 | 기존 `bridge/` 컨테이너에 `/remarkable/wallpaper` endpoint 확장 |
| 전달 모델 | **브릿지 동기 push** — 클릭 시점에 페치·변환·SSH push, 슬롯별 결과 즉시 응답 |
| 자동화 트리거 | **없음** — [적용]은 명시적 버튼, 노트에 적힌 모든 슬롯 일괄 push |
| 이미지 변환 | 브릿지에서 `sharp`로 1404×1872 그레이스케일 PNG (기본 `cover` 핏) |
| 인증 | Caddy + Bearer + TLS — terminal / LLM note와 동일 표면, 기존 토큰 재사용 |
| 리마커블 SSH 자격증명 | 브릿지 측 설정 파일, **SSH 키 인증 권장** (파이→리마커블 키 등록은 1회 수동) |
| 부분 실패 | 슬롯별 독립 — 한 슬롯 실패해도 배치 중단 안 함 |
| 비-목표 (v2) | 주기적 재적용 / OTA 자동복구 (파이 `systemd` 타이머), 오프라인 큐, 리마커블 측 에이전트 |

대상 기기: reMarkable 2, 펌웨어 3.x, 디스플레이 1404×1872 16-레벨 그레이스케일.

---

## 섹션 1 — 노트 형식 / 파서

### 본문 구조

```
리마커블 배경                        ← 단락 1 — 사용자 자유 제목 (선택)
remarkable://rm2                     ← 시그니처 (1줄, content[0] 또는 content[1])

절전 중:                             ← 섹션 라벨
https://www.dropbox.com/s/.../sleep.png?dl=1

부팅 중:
https://.../boot.png

전원 꺼짐:
https://.../off.png
```

### 규칙

- 시그니처는 `remarkable://<별칭>` — `<별칭>`은 브릿지 설정에 정의된 호스트 키. `content[0]` 또는 `content[1]`에 위치(제목 줄 한 개 허용 — `parseOcrNote`와 동형).
- 시그니처가 있으면 리마커블 배경화면 노트로 인식. 유효 슬롯이 0개여도 인식(액션 바는 "적용할 화면 없음" 표시). 시그니처가 없으면 평범한 노트.
- 섹션 라벨은 인식 집합(섹션 2)에 한정, 트림·대소문자 무시 매칭. 라벨 뒤 `:` 허용.
- 한 섹션의 이미지 URL = 그 라벨 이후 ~ 다음 라벨/문서 끝 사이에서 발견되는 **첫 `https?://` 토큰**. `<link:url>` 마크로 감싼 URL이든 평문 URL이든 무관(파서는 텍스트만 본다).
- 같은 라벨이 중복되면 첫 번째만 채택. 인식되지 않는 라벨/단락은 조용히 무시(노트 family 탈락 사유 아님).

### 산출물

새 모듈 `app/src/lib/remarkable/parseRemarkableNote.ts`:

```ts
interface RemarkableSlotEntry { slot: RmSlot; imageUrl: string }
interface RemarkableNoteSpec  { host: string; slots: RemarkableSlotEntry[] }
function parseRemarkableNote(doc: JSONContent | null): RemarkableNoteSpec | null
```

`null` = 리마커블 노트 아님. 파서는 순수 함수 — TipTap JSON in, 스펙 out, I/O 없음.

---

## 섹션 2 — 슬롯 매핑

상수 모듈 `app/src/lib/remarkable/slots.ts` — 라벨 ↔ 기기 파일 ↔ xochitl 재시작 필요 여부. 앱과 브릿지가 같은 매핑을 공유해야 하므로, 브릿지 측에도 동일 표를 둔다(번들 분리상 복제; 둘이 어긋나면 안 됨 — 주석으로 명시).

| 라벨 | 기기 파일 (`/usr/share/remarkable/`) | xochitl 재시작 | v1 |
|---|---|---|---|
| 절전 중 | `suspended.png` | 예 | 포함 |
| 부팅 중 | `starting.png` | 아니오 | 포함 |
| 전원 꺼짐 | `poweroff.png` | 아니오 | 포함 |
| 재부팅 중 | `rebooting.png` | 아니오 | 포함 (옵션 라벨) |
| 배터리 없음 | `batteryempty.png` | 아니오 | 포함 (옵션 라벨) |

5개 슬롯 모두 v1에 포함하되 매핑이 단순 상수라 추가 비용이 거의 없음. 재시작이 필요한 슬롯이 배치에 하나라도 있으면 브릿지가 push 후 1회 `systemctl restart xochitl`.

---

## 섹션 3 — 앱 UI

리마커블 노트는 평범하게 `TomboyEditor`로 열린다(사용자가 URL을 직접 타이핑/붙여넣기). 터미널 노트처럼 별도 전용 뷰로 전환하지 **않음** — OCR 노트가 에디터에 머무는 방식과 동일.

- 새 컴포넌트 `RemarkableActionBar.svelte` — 에디터 상단 배너:
  - `리마커블 배경화면 · <별칭>` + 인식된 슬롯 목록 + `[적용]` 버튼.
  - `[적용]` 클릭 → 브릿지로 POST, 슬롯별 상태(⏳ 전송 중 / ✓ 성공 / ✗ 실패 + 사유)를 배너에 인라인 표시 + 전체 결과 토스트.
  - 적용 중에는 버튼 비활성.
- 분기 지점: `routes/note/[id]/+page.svelte`와 `lib/desktop/NoteWindow.svelte` — 각 파일이 이미 `parseTerminalNote`로 분기 중. 평행하게 `parseRemarkableNote` 분기를 추가해 액션 바를 끼운다. 모바일·데스크탑 양쪽 지원.
- 브릿지 URL·Bearer 토큰은 기존 `lib/editor/terminal/bridgeSettings.ts` / `appSettings.terminalBridgeToken` 재사용 — 새 설정 항목 없음.
- 노트는 자격증명을 담지 않는다(불변식) — 호스트 별칭만.

---

## 섹션 4 — 브릿지 endpoint

`POST /remarkable/wallpaper` — Bearer 인증, `/ocr`·`/llm/chat`와 동일 패턴(`server.ts`의 `if (url === '...' && method === 'POST')` 라우팅). 새 모듈 `bridge/src/remarkable.ts`.

### 요청 / 응답

```jsonc
// 요청
{ "host": "rm2", "screens": [ { "slot": "suspended", "imageUrl": "https://..." } ] }

// 응답 (동기, 슬롯별 독립 결과)
{ "results": [ { "slot": "suspended", "status": "ok" },
               { "slot": "starting", "status": "error", "message": "image fetch 404" } ] }
```

### 슬롯당 처리

1. **호스트 해석** — `host` 별칭 → SSH 타겟(IP·user·키). 미정의 별칭 → 400.
2. **이미지 페치** — `imageUrl` GET. Dropbox 공유 링크 정규화(`?dl=1` / `dl.dropboxusercontent.com`). 용량 상한 ~10 MB 초과 시 거부.
3. **변환** — `sharp`로 1404×1872 그레이스케일 PNG. 핏 모드 기본 `cover`(꽉 채우고 넘침 크롭). 잘못된 이미지 → 슬롯 error.
4. **전송** — SSH로 리마커블에 PNG 기록. 대상 경로 `/usr/share/remarkable/<file>.png`. `/usr`가 읽기전용이면 push 명령이 `mount -o remount,rw /usr` 선행(셸 한 줄).
5. **재시작** — 배치에 재시작 필요 슬롯이 있으면 모든 push 후 1회 `systemctl restart xochitl`.

배치는 슬롯별 독립 — 한 슬롯이 실패해도 나머지는 계속 진행하고 각자 결과를 응답에 담는다.

### 리마커블 SSH 자격증명

브릿지 측 새 설정 파일, env `BRIDGE_REMARKABLE_HOSTS_FILE` → JSON:

```jsonc
{ "rm2": { "host": "10.0.0.42", "user": "root", "keyPath": "/config/rm2_id_ed25519" } }
```

- **SSH 키 인증 권장** — 파이 → 리마커블 공개키 등록(`ssh-copy-id`)은 1회 수동 사전 작업. `keyPath` 대신 `password`도 허용(폴백).
- 미설정 시 endpoint는 비활성(`/health`에는 영향 없음) — WOL 호스트 파일 부재 시 동작과 동형.
- WOL용 기존 `hosts.json`과는 **별도 파일** — 역할(WOL MAC ↔ SSH 자격증명)이 다르고 보안 등급도 다름.

### 새 의존성

브릿지 `package.json`에 `sharp` 추가(네이티브 모듈 — `Containerfile` 빌드 단계 확인 필요).

---

## 섹션 5 — 에러 처리

| 상황 | 처리 |
|---|---|
| 리마커블 SSH 불가 (꺼짐/절전/네트워크) | 해당 배치 슬롯 전부 `error` "기기에 연결할 수 없음", 토스트 |
| 이미지 페치 실패 (404 / 타임아웃 / 과대) | 그 슬롯만 `error` + 사유 |
| 이미지 변환 실패 (손상 파일) | 그 슬롯만 `error` |
| 미정의 호스트 별칭 | 브릿지 400, 액션 바에 명시 |
| `BRIDGE_REMARKABLE_HOSTS_FILE` 미설정 | endpoint 503 "리마커블 브릿지 미구성" |
| `/usr` 읽기전용 | push 명령이 remount 선행; 그래도 실패하면 슬롯 `error` |
| 부분 성공 | 슬롯별 독립 보고 — 배치 중단 없음, 액션 바가 슬롯마다 ✓/✗ 표시 |

---

## 섹션 6 — 테스트

- **파서** (`app/tests/unit/remarkable/parseRemarkableNote.test.ts`) — vitest. 노트 JSON → 스펙 매핑, 시그니처 위치(content[0]/[1]), 미인식 라벨 무시, 평문 URL vs `<link:url>` 마크, 슬롯 중복. `parseOcrNote` 테스트와 동형.
- **슬롯 매핑** — 라벨 ↔ 파일명 ↔ 재시작 플래그 일관성.
- **브릿지 endpoint** (`bridge/src/remarkable.test.ts`) — `node:test` + `mintToken`(브릿지 규약, vitest 아님). 이미지-페치와 SSH-push를 주입 가능한 인터페이스로 두고 페이크로 대체 → 실기기·네트워크 불필요. 인증 거부, 미정의 호스트, 부분 실패 응답 형태를 검증.

리마커블 실기기 대상 자동 테스트는 없음 — 수동 검증(설정된 별칭으로 [적용] 후 기기에서 스플래시 확인).

---

## 섹션 7 — 알려진 한계 (코드로 해결하지 않음, 문서화)

- **펌웨어 3.x 절전 화면** — `suspended.png` 교체는 리마커블 설정의 절전 화면이 *정적 화면*으로 지정돼 있을 때만 반영된다. "마지막 필기 페이지" 같은 동적 옵션이면 파일을 바꿔도 안 먹힌다. 코드로 강제하지 않고 사용자 설정 안내로 처리. 부팅/전원 끔 스플래시는 비교적 안정적.
- **OTA 펌웨어 업데이트가 splash 파일을 초기화** — 펌웨어 A/B 파티션 교체로 `/usr/share/remarkable/*.png`가 기본값으로 돌아간다. v1 대응은 "업데이트 후 [적용] 다시 누르기". v2에서 파이 측 `systemd` 타이머가 마지막 적용 상태(desired state)를 주기적으로 재-push해 자동 복구.
- **동기 push의 본질적 제약** — [적용] 클릭 시점에 리마커블이 깨어 있고 SSH가 닿아야 한다. 꺼져 있으면 실패하고 다시 눌러야 한다. v2의 파이 타이머가 이 제약도 함께 해소(다음 주기에 자동 재시도).

## 비-목표 (이번 스펙 제외)

- 리마커블 측 에이전트 / pull 모델 — 검토 후 기각(요약 참조).
- 주기적 재적용 / OTA 자동복구 / 오프라인 큐 — v2 (파이 `systemd` 타이머).
- 배경화면 외 리마커블 제어(전원, 노트 동기화 등). `remarkable://` 시그니처는 향후 확장 여지를 남기되 이번 스펙은 배경화면만.
- 리마커블 측 이미지 변환 / `sharp` 외 변환 경로.
