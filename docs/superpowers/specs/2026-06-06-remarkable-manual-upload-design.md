# 리마커블 수동 업로드 (`리마커블::`) — 설계 문서

## 목적

기존 일기 파이프라인은 리마커블 → Pi 동기화 데몬 → Pi inbox → 5분 timer → 데스크탑 OCR 흐름이라 즉시성이 없다. 사용자가 *지금* 가져오길 원할 때 사용할 수 있는 수동 트리거 채널을 추가한다.

핵심 차이:
- **트리거 주체**: 톰보이 노트에 위치한 사용자 버튼.
- **데이터 가져오는 주체**: 브릿지가 리마커블에 직접 SSH 접속해서 페이지를 복사 (기존엔 Pi의 별도 동기화 데몬).
- **즉시성**: 데스크탑 파이프라인을 5분 timer 대기 없이 즉시 트리거.

전제: 클라이언트(브라우저), 브릿지, 리마커블, 데스크탑이 모두 **같은 LAN**에 있어야 한다. 외부 네트워크에서는 SSH/HTTP 연결이 실패하므로 자연스럽게 에러 응답된다.

## 아키텍처

```
브라우저 노트              브릿지 (Pi)                       데스크탑
[리마커블::오늘 일기]      POST /remarkable/upload          automation-service:7843
[📥 업로드] ────────────►  ├─ ssh rmrk → page list
                           ├─ rsync 새 페이지 → Pi inbox
                           ├─ update inbox/state/index.json
                           └─ POST /commands/pipeline-run ──► systemctl start
   ◄────── SSE: status, done, error ───────                  desktop-pipeline.service
                                                              ├─ s1 fetch (Pi inbox)
                                                              ├─ s2 → s3 (Claude)
                                                              └─ s4 Firestore
                                                                    │
   ◄──── 결과 노트 등장 (기존 Firestore→Tomboy 흐름) ─────────────────┘
```

3가지 책임 경계:
- **브릿지** = SSH 페치 + Pi inbox 적재 + 트리거 발사. OCR/저장 책임 없음.
- **automation-service** = 단일 책임 trigger 라우트 (`systemctl --user start`).
- **데스크탑 파이프라인** = 기존 그대로 재사용. 5분 timer cycle도 그대로 살아있고, 수동 트리거는 같은 진입점을 즉시 호출하는 것뿐.

## 컴포넌트

자동화 노트(`자동화::`) 패턴을 1:1 미러한다. 검증된 구조 + 신규 위험 최소.

| Layer | 파일 (신규 / 수정) | 책임 |
|---|---|---|
| 노트 모델 | `app/src/lib/remarkable/parseRemarkableNote.ts` (신규) | `리마커블::<제목>` 시그니처 인식. `폴더: <이름>` 헤더 파싱. |
| 브릿지 호출 | `app/src/lib/remarkable/uploadRemarkable.ts` (신규) | `POST {bridgeUrl}/remarkable/upload` (Bearer). SSE 수신. `RemarkableUploadError` 열거. |
| 에디터 위젯 | `app/src/lib/editor/remarkableNote/remarkableNotePlugin.ts` (신규) | TipTap plugin. 첫 줄이 `리마커블::`이면 본문 맨 위에 Decoration 위젯으로 "📥 업로드" 버튼 렌더. `.note` XML에 포함되지 않음 (Tomboy 라운드트립 안전). |
| 클릭 핸들러 | `app/src/lib/editor/remarkableNote/runRemarkableUpload.ts` (신규) | 버튼 클릭 → `uploadRemarkable` 호출 → placeholder/로그 라인 노트 본문에 prepend. |
| 에디터 등록 | `app/src/lib/editor/TomboyEditor.svelte` (수정) | 새 plugin/extension 등록. |
| 브릿지 라우트 | `bridge/src/remarkableUpload.ts` (신규) | SSH 페치 → inbox rsync → automation-service POST. SSE로 단계별 status emit. |
| 브릿지 등록 | `bridge/src/server.ts` (수정) | `/remarkable/upload` 라우트 등록 + Bearer 검증. |
| automation-service | `automation-service/src/...` (신규 명령 핸들러) | `pipeline-run` 명령: `systemctl --user start desktop-pipeline.service`. 코드 위치는 plan 작성 시 기존 명령 레지스트리 패턴에 맞춰 확정. |
| 파이프라인 | 변경 없음 | s1_fetch가 inbox 새 페이지 자동 감지 — 이미 동작 중. |
| 가이드 카드 | `app/src/routes/settings/+page.svelte` (수정) | `설정 → 가이드 → 노트` 탭에 `<details class="guide-card">` 추가 (CLAUDE.md 의무). |
| 브릿지 env | `bridge/deploy/...` 문서 (수정) | `REMARKABLE_SSH_HOST/USER/KEY_PATH`, `REMARKABLE_NOTEBOOK_NAME` (기본 `Diary`), `AUTOMATION_SERVICE_URL/TOKEN` 추가. |

책임 경계 self-check:
- 노트 모델은 시그니처 파싱만, UI 모름. 브릿지 호출 코드는 fetch만, 에디터 모름. 위젯은 렌더만, 호출/상태 모름. 클릭 핸들러가 셋을 조립.
- 브릿지 라우트 안에서도 (SSH 페치 / inbox 적재 / automation 트리거)가 함수 단위로 분리되어 각자 단위 테스트 가능.

## 인터페이스 / 계약

### 노트 본문 형태

```
리마커블::오늘 일기
폴더: Diary

📥 업로드

2026-06-06 11:23 — Diary, 2건
  → [[2026-06-06 리마커블([b636753f...])]]
  → [[2026-06-06 리마커블([abc12345...])]]
2026-06-06 10:47 — Diary, 1건
  → [[2026-06-06 리마커블([95aba822...])]]
```

- 첫 줄 = 시그니처 + 자유 라벨.
- `폴더: <이름>` 헤더 = 가져올 리마커블 노트북 이름. 생략 시 브릿지 env `REMARKABLE_NOTEBOOK_NAME` 기본값(`Diary`).
- 버튼은 TipTap Decoration 위젯 — DOM에만 존재하고 노트 본문에는 저장되지 않음. Tomboy 라운드트립 안전.
- 로그 라인 = 클릭 1회 = 헤더 라인 1개 + `→ [[...]]` N개. 최신 클릭이 위. 누적.
- 결과 노트 제목은 yaml `tomboy.title_format` 그대로 유지 (`{date} 리마커블([{page_uuid}])`). 로그 라인의 폴더 정보로 사람이 출처 식별.

### `POST {bridgeUrl}/remarkable/upload`

```http
POST /remarkable/upload
Authorization: Bearer <bridge token>
Content-Type: application/json
Accept: text/event-stream

{ "notebook": "Diary" }
```

`notebook`은 노트 헤더에서 추출. 헤더가 없으면 클라이언트는 필드를 생략하고 브릿지가 env 기본값 사용.

응답: `text/event-stream` (SSE).

### SSE 이벤트 스키마

```
event: status
data: {"step":"ssh_connect"}

event: status
data: {"step":"list_pages","notebook":"Diary","total":5,"new":2}

event: status
data: {"step":"trigger_pipeline"}

event: done
data: {"notebook":"Diary","page_uuids":["b636753f-...","abc12345-..."]}
```

에러:

```
event: error
data: {"kind":"<enum>","message":"<한국어 또는 영어 디테일>"}
```

`kind` 열거 (닫힌 집합):

| kind | 의미 |
|---|---|
| `unauthorized` | Bearer 토큰 검증 실패. |
| `ssh_connect_failed` | 리마커블 SSH 접속 실패 (timeout/refused/key 거부). |
| `notebook_not_found` | 지정한 노트북 이름이 리마커블에 없음. |
| `rsync_failed` | 페이지 복사 실패. |
| `automation_unreachable` | automation-service 호출 실패. |
| `internal` | 그 외 예상치 못한 오류. |

### 클라이언트 → 노트 반영 규칙

- 진행 중: 위젯 아래 1줄 placeholder. status 단계별로 교체:
  - `ssh_connect` → `리마커블 접속 중…`
  - `list_pages` → `{notebook} 페이지 {new}건 가져오는 중…`
  - `trigger_pipeline` → `파이프라인 트리거…`
- `event: done`: placeholder 제거 후 영구 헤더 라인 prepend (**위치**: 헤더 라인들 — 시그니처 + `폴더:` — 직후, 본문 시작 부분. 이전 로그 라인이 있으면 그 위에):
  ```
  YYYY-MM-DD HH:mm — {notebook}, {N}건
  ```
  그 아래 `→ [[제목]]` N개. 제목 포맷 = **클라이언트 하드코딩** `{date} 리마커블([{page_uuid}])` (현재 yaml `tomboy.title_format`과 byte-identical). 이 두 곳은 **항상 동기화 유지** — title_format 변경 시 양쪽 동시에 갱신해야 함. 결과 노트가 아직 만들어지지 않은 시점이므로 일시적으로 broken-link이고, 파이프라인이 노트를 생성하면 `tomboy-backlinkindex` 동작으로 자동 해소.
- `event: error`: placeholder 제거, 그 자리에 한국어 매핑 1줄 (`[업로드 오류: …]`). 위젯은 다시 활성.

### automation-service `pipeline-run` 명령

```http
POST {AUTOMATION_SERVICE_URL}/commands/pipeline-run
Authorization: Bearer <AUTOMATION_SERVICE_TOKEN>
Content-Type: application/json

{}
```

핸들러:

```ts
await execAsync('systemctl --user start desktop-pipeline.service');
return { ok: true };
```

`systemctl start`는 즉시 리턴(서비스 시작만 트리거하고 완료를 기다리지 않음). 브릿지는 200만 확인하고 `event: done` 발사. 파이프라인 완료를 기다리지 않으므로 SSE는 신속히 닫힘.

### 리마커블 SSH 페치 흐름

대략적 단계 (정확한 명령은 plan에서 `ref/` 또는 실제 리마커블 파일 구조 확인 후 확정):

1. 노트북 이름 → 노트북 UUID 변환 (xochitl 메타데이터 grep).
2. 노트북에 속한 페이지 UUID 목록.
3. Pi inbox `state/index.json`에 없는 UUID만 선별.
4. 새 UUID마다 `<uuid>.metadata` + `<uuid>.rm` 등을 rsync로 Pi inbox에 복사.
5. `state/index.json`에 entry 추가 (`{"present": true, "mtime": <epoch>, "received_at": <iso>}`).

## 에러 / 부분 실패

- **부분 실패 (페이지 N개 중 M개 rsync 성공)**: 성공한 M개로 inbox/index 갱신 → automation 트리거 → `event: done`에 성공한 UUID만 포함. 실패는 브릿지 로그에만(SSE는 보내지 않음). 사용자 관점은 "M건 가져옴"으로 정확하게 표시.
- **automation 트리거 실패 (inbox 적재는 성공)**: `event: error` `kind=automation_unreachable` + 부가 문구 "5분 내 자동 처리됩니다" (다음 timer cycle이 처리).
- **클라이언트 SSE 연결 중단** (네트워크/탭 백그라운드): placeholder를 `[업로드 상태 알 수 없음 — 결과 노트로 확인]`으로 교체, 위젯은 활성. 브릿지 측은 fire-and-forget으로 계속 진행.
- **재시도**: 같은 노트에서 다시 클릭해도 안전. 이미 처리된 페이지는 inbox index에 있어 skip → "0건"으로 done.

## 테스트

### 웹 앱 (`app/tests/unit/`)

- `remarkable/parseRemarkableNote.test.ts` — 시그니처 인식, `폴더:` 헤더 파싱, 잘못된 형식 무시. (`parseAutomationNote.test.ts` 미러)
- `remarkable/uploadRemarkable.test.ts` — fetch/SSE 모킹. status/done/error 이벤트 흐름. kind enum별 분류. abort.
- `editor/remarkableNote/runRemarkableUpload.test.ts` — `uploadRemarkable` 모킹. 노트 본문 prepend 동작. placeholder 교체 흐름. 부분 실패 표시.

### 브릿지 (`bridge/`, `node --test`)

- `remarkableUpload.test.ts` — `mintToken` 헬퍼로 인증된 호출. `child_process.spawn` 모킹으로 SSH/rsync 시뮬레이션. 단계별 SSE emit 순서 확인. 에러 enum 매핑. automation-service 호출은 `fetch` 모킹.

### automation-service

- 명령 핸들러 단위 테스트 — `child_process.exec` 모킹. exit code 0/non-zero에 따른 응답.
- 기존 명령 레지스트리 패턴을 따르므로 추가 비용 작음.

### 파이프라인

변경 없음. 신규 테스트 없음.

### 수동 통합 (e2e)

리마커블에서 페이지 1장 작성 → `리마커블::테스트` 노트에서 업로드 클릭 → 검증:

1. claude-service `podman logs claude-service`에 새 `/chat` 요청 + `user[image,text]` shape.
2. `journalctl --user -u desktop-pipeline.service`에 `s3_ocr: 1 pages OCR'd`.
3. 톰보이에 새 결과 노트 등장 + `리마커블::` 노트의 broken-link가 해소.

## 가이드 카드 (CLAUDE.md 의무)

`설정 → 가이드 → 노트` 서브탭에 `<details class="guide-card">` 추가. 시그니처 예시 + `폴더:` 헤더 옵션 + 로컬 네트워크 전제 + 결과 링크 누적 동작 + 위 통합 검증 흐름 요약.

## 변경 범위 / 비범위

**범위 (v1):**
- `리마커블::` 노트 + 헤더 + 위젯 + SSE.
- 브릿지 `/remarkable/upload` 라우트 + 리마커블 SSH 페치 + Pi inbox 적재 + automation 트리거.
- automation-service `pipeline-run` 명령.
- 가이드 카드 + 브릿지 env 문서.

**비범위 (별도 작업):**
- 노트 헤더에서 여러 폴더를 동시에 트리거 (현재는 단일 폴더).
- 페이지 단위 수동 선택.
- 결과 노트 제목 포맷 변경.
- 외부 네트워크(WAN) 지원.
- 파이프라인 timer 주기 단축 (수동 트리거가 즉시성을 해결하므로 굳이 불필요).
