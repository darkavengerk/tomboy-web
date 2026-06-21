# 브릿지 대시보드 서비스 드릴다운 — 설계 (Phase 1: 일기 파이프라인)

날짜: 2026-06-21
상태: 설계 승인 대기 → 구현 계획
관련 스킬: `tomboy-bridgedash`, `tomboy-diary`

## 배경 / 문제

`브릿지::` 노트(`tomboy-bridgedash`)는 현재 `GET /status` 한 방으로 시스템/서비스
도달성/파일/연결을 스냅샷 렌더한다. 서비스 칸은 **도달성(up/down/unconfigured)만**
보여준다 — "그 서비스가 마지막으로 무언가를 처리한 게 언제인지", "최근 에러가 있었는지"
같은 운영 신호는 없다.

직접 계기: 일기 파이프라인의 rM→Pi push가 3일간 조용히 멈춘 사건(멈춘 oneshot이
매분 타이머를 영구 블록). 대시보드만 봐서는 "도달 가능"으로 보였고 정체를 알 수 없었다.

목표: 각 서비스의 **최근 처리 시점 + 정리된 로그 분석**을 대시보드에서 드릴다운으로
확인. 서비스마다 중요한 신호가 달라 **개별 처리**가 필요하다. 이 스펙은 그 골격 +
**첫 서비스(일기)** 까지를 다룬다.

## 목표 (Phase 1)

- 대시보드 서비스 항목을 **클릭** → 그 서비스 특화 상세가 **읽기전용 오버레이**로 팝업.
- 상세는 raw 로그 덤프가 아니라 **정리된 표 + 가벼운 차트 + 한눈 배지**.
- **데이터 흐름은 브릿지 허브(A안)**: 오버레이는 브릿지하고만 통신, 브릿지가 서비스별로
  팬아웃. `브릿지::` 의 "노트는 브릿지 한 곳만 본다" 불변식 유지.
- 첫 서비스 = **일기 파이프라인**: 마지막 push 신선도, 폴더별 inbox backlog, 마지막 OCR
  실행 결과/로그 꼬리.
- 후속 서비스(music추출/automation/ocr·claude·ollama)가 같은 골격에 렌더러만 추가하면
  되도록 **렌더러 레지스트리**로 설계.

## 비목표 (Phase 1)

- music추출/automation/ocr/claude/ollama 의 상세 뷰 — Phase 2+ (각자 스펙).
- 일기 신호 중 **rM `diary-push.log` 직접 파싱** — rM은 브릿지에서 도달 불가. push
  신선도는 inbox 최신 mtime으로 **간접 추론**(파일이 도착했다 = push가 돌았다).
- Firestore 상태 미러(`diary-pipeline-pages`) 를 브릿지가 읽기 — Firebase Admin creds를
  브릿지에 두는 새 인프라. Phase 1 범위 밖(필요해지면 후속).
- 오버레이에서의 **액션**(재처리 트리거 등) — 읽기전용. 트리거는 기존 `/admin/remarkable`.
- 에디터 chartBlock 파이프라인 재사용 — PM 노드뷰에 묶여 모달에 부적합. 아래 차트 결정 참조.

## 아키텍처

```
브릿지:: 노트 (대시보드)
  └─ 서비스 항목 클릭(data-bridge-detail="diary")
       └─ BridgeDetailOverlay.svelte (모달, --z-modal, portal, 읽기전용)
            └─ fetchBridgeDetail('diary')  (app statusClient)
                 └─ GET /status/diary  (Bearer)
                      └─ 브릿지 handleDiaryStatus (status_diary.ts)
                           ├─ inbox-local: 마운트된 inbox glob
                           │    → {count, newest_mtime, per_folder{Diary,Notes,Slip-Notes}}
                           └─ ocr-proxy(선택): GET {DIARY_TRIGGER_URL}/status (Bearer)
                                → {running, finishedAt, exitCode, stdoutTail, stderrTail}
            └─ 렌더러 레지스트리[key] → DiaryDetailView
                 (push 신선도 배지 · 폴더별 backlog 막대 · 마지막 OCR 표)
```

데이터 출처 사실(검증됨 2026-06-21):

- 브릿지 컨테이너(`term-bridge`, rootless podman, 호스트 유저 `umayloveme`)는 호스트
  유저 권한으로 **diary-sync inbox를 읽을 수 있다**(`/home/diary-sync` 에 umayloveme
  traverse ACL + `inbox` 가 `drwxr-xr-x`). 단 컨테이너 안에서 보이려면 **마운트 필요**.
- `state/index.json` 은 `0600 diary-sync` → 읽기 불가. 하지만 불필요 — inbox를 직접
  glob 해서 동일 정보(개수·최신 mtime·폴더별)를 얻는다(`status.ts:gatherFiles` 와 동형).
- desktop `trigger_server`(`pipeline/desktop/trigger_server.py`)의 `GET /status` 는
  `{running, jobId, startedAt, finishedAt, exitCode, stderrTail, stdoutTail}` 를 반환 —
  "최근 OCR 실행 시점 + 결과 + 로그 꼬리" 그대로.

## 컴포넌트 상세

### A. 브릿지: `GET /status/diary` (신규)

파일: `bridge/src/status_diary.ts` (신규), `bridge/src/server.ts` 라우트 등록.

요청: `GET /status/diary`, `Authorization: Bearer <secret>` (기존 `/status` 와 동일
`verifyToken`). 인증 실패 → 401.

응답 `DiaryDetail`:

```ts
interface DiaryDetail {
  fetched_at: string;                 // ISO
  inbox: {
    count: number;                    // inbox 안 .rm 페이지 수
    newest_mtime: string | null;      // ISO, 가장 최근 도착 = 마지막 push
    stale_minutes: number | null;     // now - newest_mtime (분). null=빈 inbox
    per_folder: Array<{               // sourceFolder 별 (Diary/Notes/Slip-Notes)
      folder: string;
      count: number;
      newest_mtime: string | null;
    }>;
    error?: string;                   // 마운트 부재/읽기 실패 시(우아한 표기)
  };
  ocr: {
    status: 'ok' | 'unconfigured' | 'unreachable';
    running?: boolean;
    last_run_at?: string | null;      // finishedAt(없으면 startedAt)
    exit_code?: number | null;
    result?: 'success' | 'failed' | 'running' | 'unknown';
    summary?: string | null;          // stdoutTail 에서 "Push complete: N" 등 파싱한 한 줄
    log_tail?: string;                // stdoutTail+stderrTail 최근 N줄(정리)
  };
}
```

집계 로직:

- **inbox**: 마운트 경로(`DIARY_INBOX_DIR` env, 기본 `/var/lib/diary-inbox`)를 `readdirSync`.
  `<uuid>.rm` 마다 stat → count++, newest_mtime 갱신. `<uuid>.metadata` JSON 읽어
  `sourceFolder` → per_folder 버킷. 디렉터리 부재/미마운트면 `inbox.error` 채우고 0으로
  폴백(throw 안 함). `status.ts:gatherFiles` 패턴 재사용/공유.
- **ocr**: `DIARY_TRIGGER_URL` 비어 있으면 `status:'unconfigured'`. 있으면
  `GET {url}/status` (`Authorization: Bearer {DIARY_TRIGGER_TOKEN}`, `AbortSignal.timeout`
  재사용). 응답 파싱 → result/summary/log_tail. fetch throw/타임아웃 → `status:'unreachable'`.
  summary 파싱: stdoutTail 줄 중 `Push complete:`/`page(s)`/`OCR`/`Wrote`/`Error`/`Traceback`
  패턴을 한 줄로 요약(best-effort, 못 찾으면 마지막 비어있지 않은 줄).
- 전체 best-effort — inbox/ocr 한쪽이 실패해도 200 + 부분 데이터.

### B. 배포 (브릿지 재빌드 + Pi 재배포)

`bridge/deploy/term-bridge.container`:

- 마운트 추가: `Volume=/home/diary-sync/diary/inbox:/var/lib/diary-inbox:ro`
  — 공유 디렉터리이므로 **`z`/`Z` 리라벨 금지**(diary-sync 접근 깨질 수 있음). 읽기전용만.
- env 추가(선택, 둘 다 없으면 ocr 섹션이 `unconfigured`):
  `Environment=DIARY_INBOX_DIR=/var/lib/diary-inbox`,
  `Environment=DIARY_TRIGGER_URL=...`, 시크릿은 `term-bridge.env` 에
  `DIARY_TRIGGER_TOKEN=...` (기존 env 파일 패턴).
- 신규 라우트라 `bridge/` 빌드 + Pi 재배포 후 활성(`tomboy-bridgedash` 배포 함정 동일).

### C. 앱: statusClient 확장

파일: `app/src/lib/bridgeStatus/statusClient.ts`.

- `DiaryDetail` 인터페이스 추가(위 shape 미러).
- `fetchBridgeDetail(key: 'diary', opts?): Promise<DiaryDetail>` — `fetchBridgeStatus` 와
  동일한 bridge/token 해석 + `BridgeStatusError` 분류. URL = `{base}/status/{key}`.
- (확장 대비) 반환 타입은 키별 유니온으로 두되 Phase 1 은 `'diary'` 만.

### D. 앱: 대시보드 클릭 가능화

파일: `app/src/lib/editor/bridgeNote/bridgeNotePlugin.ts`,
`app/src/lib/bridgeStatus/buildBridgeDashboard.ts`.

- 대시보드에 일기 항목을 드릴다운 가능 표시로 노출. 후보 두 가지(구현 계획에서 택1):
  1. `buildBridgeDashboardNodes` 에 `📓 일기` 줄/섹션을 추가하고, bridgeNotePlugin 이
     해당 텍스트 위치에 **클릭 위젯 데코**(⟳ 버튼과 동형)를 얹어 핸들러 연결.
  2. 서비스 섹션 행에 `data-bridge-detail` 마킹 후 plugin 의 `handleClick` prop 에서
     좌표→서비스키 매핑.
  - 권장: (1) — 위젯 데코가 ⟳ 버튼에서 이미 검증된 패턴. tableBlock(제너릭 CSV)에
    브릿지 의미를 주입하지 않음(결합 회피).
- 클릭 → `openBridgeDetailOverlay('diary')` (전역 오버레이 상태 or 직접 마운트).

### E. 앱: 읽기전용 오버레이 + 일기 렌더러

파일(신규): `app/src/lib/bridgeStatus/detail/BridgeDetailOverlay.svelte`,
`app/src/lib/bridgeStatus/detail/DiaryDetailView.svelte`,
`app/src/lib/bridgeStatus/detail/registry.ts`.

- `BridgeDetailOverlay.svelte` — 모달 셸. `--z-modal`, `use:portal` to `<body>`(데스크탑
  NoteWindow 안에서도 밴드 탈출). 백드롭 클릭/Esc 닫기. 열릴 때 `fetchBridgeDetail(key)`
  → 로딩/에러/성공 3상태. 에러는 `KIND_MESSAGES`(runBridgeButtonClick 패턴) 한국어 표기.
- `registry.ts` — `key → { title, component }`. Phase 1 = `{ diary: { title:'📓 일기 파이프라인', component: DiaryDetailView } }`. 후속 서비스는 여기 엔트리만 추가.
- `DiaryDetailView.svelte` (props: `DiaryDetail`):
  - **Push 신선도 배지**: "마지막 push N분 전" + 색(정상/경고/정체). `stale_minutes`
    임계(예: >30분 경고, >180분 정체) — 임계는 상수로.
  - **폴더별 backlog 막대**: Diary/Notes/Slip-Notes count 를 **가벼운 인라인 SVG/CSS
    막대**로(3개라 라이브러리 불필요). 옆에 표(폴더·개수·최신시각).
  - **마지막 OCR 실행 표**: 시각/결과/exit code/summary. `log_tail` 은 접이식
    `<details>` 에 monospace.
  - `unconfigured`/`unreachable` 섹션은 회색 안내로 대체.

### F. 차트 결정

에디터 `chartBlock` 은 ProseMirror 노드뷰 + `lib/chart` 파서에 묶여 있고 독립
`<Chart>` Svelte 컴포넌트가 없다 → 모달 재사용 부적합. Phase 1 backlog 는 막대 3개뿐이라
**오버레이 내 인라인 SVG/CSS 막대**로 자족 구현. 후속에서 더 복잡한 차트가 필요하면 그때
공유 차트 컴포넌트를 별도 추출(이 스펙 범위 밖).

## 에러 처리

- 브릿지 `/status/diary`: 인증 실패만 401, 그 외 항상 200 + 부분/폴백 데이터.
  inbox 미마운트 → `inbox.error`, ocr 미설정 → `ocr.status:'unconfigured'`.
- 앱: `BridgeStatusError` 분류 재사용. 오버레이는 전체 실패 시 토스트 대신 모달 내
  인라인 에러(닫기 가능). 부분 데이터는 가능한 섹션만 렌더.

## 테스트

- 브릿지(`node --test`): inbox glob 집계(임시 dir + .rm/.metadata fixture), sourceFolder
  버킷팅, 미마운트 폴백; trigger 프록시 파싱(mock fetch: success/failed/running),
  unconfigured/unreachable 분기; 401 인증.
- 앱(vitest): `fetchBridgeDetail` URL/토큰/에러 분류; `DiaryDetailView` 렌더(신선도 배지
  임계 색, per_folder 막대, ocr 표/`unconfigured`); 오버레이 로딩→성공/에러 전이;
  대시보드 클릭→오버레이 오픈.

## 가이드 문서 (필수)

`설정 → 가이드` (`app/src/routes/settings/+page.svelte`, `guideSubTab`)에 브릿지 노트
드릴다운 카드 추가/갱신 — 서비스 클릭 시 상세 오버레이가 뜬다는 점 + 일기 상세가 보여주는
신호(push 신선도/backlog/OCR 실행) 설명. (프로젝트 불변식: 사용자 대면 기능은 가이드 탭에
문서화.)

## 단계화 (이 스펙 이후)

- **Phase 2**: music추출 — service `/status` 상세 엔드포인트 + `MusicDetailView`(마지막
  추출 성공/실패, 트랙 수).
- **Phase 3**: automation — 마지막 실행/결과, 등록 커맨드.
- **Phase 4**: ocr/claude/ollama — 마지막 요청, 모델 로드/VRAM.
- 각 단계는 레지스트리에 렌더러 + 브릿지 팬아웃 분기 추가. 골격(오버레이/레지스트리/
  fetchBridgeDetail/클릭)은 Phase 1 에서 고정.

## 미해결 / 확인 필요

- `DIARY_TRIGGER_URL` 로 브릿지(Pi)가 desktop trigger_server 에 실제 도달 가능한지(LAN
  IP/리버스 프록시) — 구현 시 확인. 미설정이면 ocr 섹션은 우아하게 생략되므로 Phase 1
  배포는 inbox 섹션만으로도 출하 가능.
- desktop OCR 자동 실행 여부(타이머 vs 수동) — `/status` 는 마지막 트리거 실행을 반영하므로
  수동이어도 동작. 정보 표기에만 영향.
