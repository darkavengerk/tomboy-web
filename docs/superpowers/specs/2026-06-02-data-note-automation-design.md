# 데이터 노트 자동화 설계

작성일: 2026-06-02

## 배경

`DATA::` 차트 노트는 본문의 ```` ```csv ```` 코드펜스를 데이터 소스로 차트를 그린다.
지금은 그 CSV를 사람이 직접 채운다. 예: `~/loc-history.py` 가 git 커밋 히스토리를
훑어 날짜별 소스 LOC를 CSV로 뽑아주지만, 그 결과를 노트에 붙여넣는 건 수작업이다.

이 작업을 자동화한다. **독립된 "자동화 노트"의 버튼을 누르면 → 브릿지를 거쳐 →
데스크탑에서 설정된 스크립트가 실행되고 → 결과가 돌아오면 → 응답에 담긴 프로젝트명마다
`DATA::<프로젝트명>` 노트의 CSV 블록이 자동 갱신**되고, **자동화 노트에는 실행 내역이
기록**된다.

설계 원칙: **자동화 명령과 데이터를 분리한다.** DATA:: 노트는 순수 데이터만 담고,
트리거·내역은 별도의 자동화 노트가 담당한다.

## 기존 자산 (그대로 미러링)

이 설계는 새 패턴을 만들지 않는다. 이미 있는 경로들을 합쳐 따른다.

- **`claude://` 챗노트 경로** — 앱 → 브릿지 `/claude/chat` → 데스크탑 `claude-service`
  → `spawn` → 결과. 인증·프록시·Quadlet 배포의 템플릿.
  - 앱 클라이언트: `app/src/lib/chatNote/backends/claude.ts`
  - 브릿지 프록시(스트리밍): `bridge/src/claude.ts`, (비스트리밍) `bridge/src/ocr.ts`
  - 브릿지 라우팅/인증: `bridge/src/server.ts`, `bridge/src/auth.ts`
  - 데스크탑 서비스: `claude-service/src/{server,runner,auth}.ts`
  - Quadlet: `claude-service/deploy/claude-service.container`, `ocr-service/deploy/ocr-service.container`
- **footnote `claudeFill`** — 브릿지 호출 결과를 노트에 써넣는 완성된 모델.
  - `app/src/lib/editor/footnote/claudeFill.ts` (`view.dispatch` 써넣기 + 파괴된 view 가드)
- **차트 블록 플러그인** — 에디터에 인터랙티브 위젯을 마운트하는 패턴(노트 형식 감지 + 위젯).
  - `app/src/lib/editor/chartBlock/chartBlockPlugin.ts`, `findChartRegions.ts`
  - 데이터 노트 파싱: `app/src/lib/chart/parseDataNote.ts`
- **노트 영속화 초크포인트** — `app/src/lib/core/noteManager.ts`
  - `createNote(initialTitle?)`, `getNoteEditorContent(note)`, `updateNoteFromEditor(guid, doc)`,
    `findNoteByTitle(title)`
- **브릿지 설정 접근자** — `app/src/lib/editor/terminal/bridgeSettings.ts`
  - `getDefaultTerminalBridge()`, `getTerminalBridgeToken()`, `bridgeToHttpBase(bridge)`

## 결정 사항 (브레인스토밍 확정)

1. **등록된 명령 ID** — 데스크탑 서비스가 registry(설정 파일)를 들고 `command id → 실제
   스크립트 invocation`을 매핑한다. 노트는 command id만 보낸다. registry가 신뢰 경계다.
2. **자동화 명령과 데이터 분리** — 자동화는 독립된 **자동화 노트**가 담당한다. DATA:: 노트는
   순수 데이터(CSV 블록 + 차트 블록)만 담는다.
3. **자동화 노트 = 제목 `자동화::<command-id>`** — `DATA::` 와 같은 `::` 계열 제목 접두사로
   식별. `::` 뒤 텍스트가 command id (예: `자동화::loc-history` → `loc-history`).
   에디터가 이 노트를 감지해 **트리거 버튼 + 실행 내역 로그**를 다룬다.
4. **CSV 데이터 블록만 교체** — 대상 DATA:: 노트의 첫 ```` ```csv ```` 펜스 내용만 갈아끼운다.
   제목·차트 블록은 보존. 스크립트는 `--csv-only`로 돌린다.
5. **새 automation 서비스** — claude-service와 같은 스택의 소형 Fastify 서비스를 신설.
   registry를 소유하고 향후 다른 자동화에도 재사용한다.
6. **파라미터는 데스크탑 고정** — 경로·제외 등 인자는 registry에만 있다. 노트는 경로를
   넘기지 않는다. 결과는 `{프로젝트명: CSV}` 형태(프로젝트명은 registry config가 부여).
7. **프로젝트명 → 노트 제목 팬아웃** — 응답은 `{프로젝트명: CSV}` 맵. 앱은 각 키마다
   `DATA::<프로젝트명>` 노트를 찾아 갱신한다. 한 번의 트리거로 여러 노트 갱신 가능.
8. **대상 노트 없으면 새로 생성** — `DATA::<프로젝트명>` 노트가 없으면 스킵하지 않고
   `createNote`로 만든 뒤 CSV를 채운다.
9. **실행 내역 = 리스트 항목 누적** — 매 실행마다 자동화 노트 본문에 리스트 항목 한 줄
   추가(최신이 위). 최근 N개(기본 50)만 유지(무한 증가 방지).
10. **비스트리밍** — 스크립트는 수 초 내 한 번에 출력. SSE 없이 plain request/response
    (`ocr.ts` 패턴).

## 전체 흐름

```
[자동화::loc-history 노트의 ⟳ 실행 버튼]
   │ click → runAutomation({command:"loc-history"})  + Bearer(terminalBridgeToken)
   ▼
앱   POST {httpBase}/automation/run     {command:"loc-history"}
   ▼
브릿지(Pi)  bridge/src/automation.ts   → verifyToken 후 프록시(Bearer=BRIDGE_SECRET)
   ▼
데스크탑  automation-service  POST /run {command:"loc-history"}
   │   registry에서 command → [{project, exec[]}] 조회
   │   각 exec를 spawn(셸 미경유) → stdout 수집(타임아웃 + 크기 상한)
   ▼
응답   { results: { "tomboy": "<csv>", "robotC": "<csv>" }, errors: { ... } }
   ▼
앱   (1) results 각 project: DATA::<project> 노트 찾기 → 없으면 createNote
           → 첫 ```csv 블록 교체(없으면 추가) → 저장
       (2) 자동화 노트 본문 로그에 실행 내역 항목 prepend(최신 위, 최근 50개 유지) → 저장
```

## 보안 / 신뢰 경계

- 노트가 브릿지로 보내는 것은 **command id 하나뿐**. `exec` 배열(스크립트 경로·인자)은
  **데스크탑 registry에만** 존재한다. 동기화된 악성/오염 노트가 할 수 있는 최대치는
  "이미 등록·신뢰된 명령 실행". 경로·인자 주입 불가.
- 모르는 command id → 400 거부.
- `spawn`은 인자 배열로 호출(셸 미경유) → 셸 인젝션 없음.
- 전 구간이 기존 브릿지 Bearer 토큰으로 게이트된다:
  `terminalBridgeToken`(앱) → `verifyToken(BRIDGE_SECRET)`(브릿지) → 프록시 시
  `BRIDGE_SECRET`을 outbound Bearer로 재사용 → `verifyToken(BRIDGE_SHARED_TOKEN)`(서비스,
  `BRIDGE_SHARED_TOKEN === BRIDGE_SECRET`).
- 명령당 **출력 크기 상한 + 타임아웃**. 한 프로젝트 실패가 배치 전체를 죽이지 않는다.

## 컴포넌트

### (A) 데스크탑: `automation-service/` (신규)

claude-service를 미러링한 소형 Fastify + Node 서비스.

- **엔드포인트**: `POST /run` · 본문 `{ command: string }` · `Authorization: Bearer <BRIDGE_SHARED_TOKEN>`.
  인증은 `claude-service/src/auth.ts` 의 `extractBearer` + 상수시간 비교 재사용.
- **registry 설정파일** `~/.config/tomboy-automation.json`:
  ```json
  {
    "commands": {
      "loc-history": [
        { "project": "tomboy",
          "exec": ["python3", "/home/umayloveme/loc-history.py",
                   "/var/home/umayloveme/workspace/tomboy-web",
                   "--csv-only", "--exclude", "graphify-out/"] },
        { "project": "robotC",
          "exec": ["python3", "/home/umayloveme/loc-history.py",
                   "/var/home/umayloveme/workspace/robotC", "--csv-only"] }
      ]
    }
  }
  ```
- **실행**: command 조회 → 각 entry를 `spawn(exec[0], exec.slice(1), { cwd: HOME })`(셸 미경유)
  → stdout 수집 → `{ results: { [project]: csv }, errors: { [project]: message } }`.
  타임아웃(기본 30s)·출력 상한 초과·비정상 종료는 해당 project를 `errors`에 넣고 계속.
- **스크립트 수정 불필요** — `~/loc-history.py`의 `--csv-only` 출력을 그대로 쓰고,
  project명은 config가 부여한다.
- **배포**: Quadlet `automation-service/deploy/automation-service.container`. 비스트리밍이라
  `PublishPort=7843:7843`(rootless OK), `Network=host` 불필요. 포트 7843은 claude-service(7842)·
  ocr-service(8080)와 비충돌. env `~/.config/automation-service.env`:
  - `BRIDGE_SHARED_TOKEN` (= `BRIDGE_SECRET`)
  - `AUTOMATION_SERVICE_PORT` (기본 7843)
  - `AUTOMATION_CONFIG` (registry 경로, 기본 `~/.config/tomboy-automation.json`)
  - `AUTOMATION_MAX_OUTPUT_BYTES`
  - `AUTOMATION_TIMEOUT_MS`
- **deploy README** — claude-service/ocr-service 패턴대로 `automation-service/deploy/README.md`.

### (B) 브릿지: `bridge/src/automation.ts` (신규)

`bridge/src/ocr.ts`(비스트리밍 프록시)를 복제.

- `handleAutomationRun(req, res, secret, automationServiceUrl)`:
  - `verifyToken(secret, extractBearer(req.headers.authorization))` → 실패 401.
  - `readJson(req)`(크기 상한) → 파싱 실패 400.
  - `automationServiceUrl` 비어있으면 503 `{error:'automation_service_not_configured'}`.
  - `fetch(\`${automationServiceUrl}/run\`, { method:'POST', headers:{ Authorization:\`Bearer ${secret}\`, 'Content-Type':'application/json' }, body })`
    → 네트워크 오류 503 `{error:'automation_service_unavailable'}`.
  - 업스트림 status/content-type 그대로 `res.end(await upstream.text())`.
- `bridge/src/server.ts`: import + 라우트
  `if (url === '/automation/run' && req.method === 'POST') { await handleAutomationRun(req, res, SECRET, AUTOMATION_SERVICE_URL); return; }`
  + `const AUTOMATION_SERVICE_URL = process.env.AUTOMATION_SERVICE_URL ?? '';`
  (선택 env이므로 `requireEnv` 아님; `~/.config/term-bridge.env`에
  `AUTOMATION_SERVICE_URL=http://<desktop-LAN-IP>:7843`).
- 테스트 `bridge/src/automation.test.ts` (`node --test`, `mintToken(SECRET)`): 인증·프록시·503·400.

### (C) 앱: `lib/automation/`

- **`parseAutomationNote.ts`** — `parseAutomationNote(doc): { commandId: string } | null`.
  첫 줄(제목)이 `자동화::` 로 시작하면 `::` 뒤 트림된 텍스트를 command id로 반환. 아니면 null.
  (DATA:: 감지와 동형.)
- **`runAutomation.ts`** — `runAutomation({ command, signal }): Promise<{ results: Record<string,string>, errors: Record<string,string> }>`.
  `bridgeSettings`에서 bridge/token 획득 → `bridgeToHttpBase` 정규화 →
  `POST {httpBase}/automation/run` Bearer. 에러 매핑은 `sendClaude`의 `STATUS_TO_KIND`
  모델 재사용(401 unauthorized / 503 service_unavailable / ≥500 upstream_error / 그 외 bad_request),
  abort는 throw 대신 조용히 종료.
- **`findDataBlockRegion.ts`** — 라이브 PMNode에서 첫 ```` ```csv ````/```` ```tsv ````
  펜스 본문의 노드 범위 `{ from, to, format }`를 산출(`findChartRegions` 미러; 실제
  `nodeSize` 오프셋 사용). 블록이 없으면 `null`. (본문 펜스는 `inlineCheckbox` 아톰과 무관.)
- **`applyDataNoteCsv.ts`** — `applyDataNoteCsv(project, csv): Promise<'updated'|'created'>`.
  대상은 **항상 DATA:: 노트**(자동화 노트 아님). 트리거한 자동화 노트가 열린 에디터이므로
  대상 DATA:: 노트는 보통 닫힌/다른 창 → noteManager 경로 사용:
  1. `findNoteByTitle("DATA::" + project)`.
  2. **없으면 `createNote("DATA::" + project)`** → `'created'`, 있으면 `'updated'`.
  3. `getNoteEditorContent(note)` → `findDataBlockRegion`으로 첫 csv 블록 찾기 → **있으면
     본문 교체, 없으면 `DATA::` 줄 아래에 새 ```` ```csv ```` 블록 추가**.
  4. `updateNoteFromEditor(guid, doc)` 후 `noteReloadBus.emitNoteReload([guid])` +
     `desktopSession.reloadWindows([guid])`(교차창 불변식 — 열려있는 대상 노트가 갱신 반영).
- **`appendRunHistory.ts`** — `appendRunHistory(view, entry: string)`.
  자동화 노트는 버튼 클릭 시점에 **열린 에디터**이므로 라이브 `view.dispatch`로 본문 로그를
  편집(claudeFill 패턴 + 파괴된 view 가드). 첫 top-level `bulletList`(로그 리스트)를 찾아 맨 앞에
  `listItem` 추가, 없으면 제목 아래에 새 `bulletList` 생성. 항목 50개 초과 시 오래된 것 제거.

### (D) 앱 에디터 플러그인: `lib/editor/automationNote/`

- `parseAutomationNote(doc)`로 자동화 노트를 감지 → 제목 단락 뒤에 `Decoration.widget`로
  `contentEditable=false` **버튼**(`⟳ 실행`) 마운트(chartBlockPlugin 패턴).
- 차트의 체크박스 토글과 달리 **일회성 클릭 실행**(영속 상태 없음).
- onclick 핸들러:
  1. 버튼 비활성 + 스피너.
  2. `runAutomation({ command: commandId })`.
  3. `results` 각 항목 `applyDataNoteCsv(project, csv)`.
  4. `appendRunHistory(view, "<시각> — <요약>")` (성공/부분실패/생성 요약, 아래 형식).
  5. 성공/부분실패 한국어 토스트 → 버튼 복귀.

### (E) 문서: 설정 → 가이드

`app/src/routes/settings/+page.svelte` 의 **`notes` 서브탭**(새 노트 형식)에
`<details class="guide-card">` 추가. 기존 카드 패턴(짧은 `<summary>`, `<p class="info-text">`
인트로, `<pre class="snippet">` 예시, `<ul class="guide-list">` 제약/주의) 그대로.
`DATA::` 차트 카드와 인접 배치하고, 데스크탑 registry 설정·브릿지 env 선행조건을 명시.

## 노트 표기

두 노트가 분리된다.

**데이터 노트 (순수 데이터):**
```
DATA::tomboy

```csv
날짜,합계,TypeScript,Svelte,Python,JS,CSS,HTML
2026-06-02,116959,85017,24414,7169,266,71,22
```

[x]Chart:area 코드 라인 수 추이
- DATA::tomboy
- y:TypeScript,Svelte,Python,JS,CSS,HTML
- stacked, 곡선, 범례
```

**자동화 노트 (트리거 + 내역):**
```
자동화::loc-history

[⟳ 실행]   ← 위젯 버튼 (제목 아래 렌더)

- 2026-06-02 15:30 — tomboy·robotC 갱신
- 2026-06-01 09:12 — tomboy 갱신, robotC 실패(타임아웃)
- 2026-05-31 22:05 — DATA::robotC 생성, tomboy 갱신
```

버튼을 누르면 `loc-history` 트리거 → 응답의 모든 `DATA::<project>` 노트(tomboy·robotC)가
갱신(없으면 생성)되고, 이 자동화 노트의 리스트 맨 위에 실행 항목이 추가된다.

## 실행 내역 항목 형식

`<yyyy-mm-dd HH:MM> — <요약>` (로컬 시각). 요약 규칙:

- 전부 성공: `tomboy·robotC 갱신`
- 일부 생성: `DATA::robotC 생성, tomboy 갱신`
- 부분 실패: `tomboy 갱신, robotC 실패(타임아웃)`
- 연결/인증 실패(결과 0건): `실패: 자동화 서비스 연결 불가`

## 에러 처리 (전부 한국어 토스트 + 로그 항목)

- 브릿지/서비스 불통·미설정(503) → 토스트 "자동화 서비스에 연결할 수 없습니다" + 로그 `실패: …`.
- 401 → 토큰 안내 토스트 + 로그 `실패: 인증`.
- 모르는 command(400) → "등록되지 않은 명령입니다" + 로그 `실패: 등록되지 않은 명령`.
- `results`는 모두 적용하되, `errors`의 프로젝트는 개별 토스트 + 로그 요약에 `실패(…)` 포함
  (나머지는 정상 갱신).
- **`DATA::<project>` 노트 없음 → 새로 생성** 후 CSV 채움. 로그에 `… 생성`.
- 생성 자체 실패(IDB 오류 등)만 개별 토스트로 보고.
- 스크립트 타임아웃·출력 초과·비정상 종료 → 서비스가 해당 project를 `errors`로 분류.
- 쓰기 직전 view 파괴(자동화 노트가 닫힘) → 가드 후 로그 쓰기 스킵(DATA:: 갱신은 영향 없음).

## 테스트

- **브릿지** `automation.test.ts` (`node --test`): 인증 통과/실패, 프록시 정상, 503(미설정/불통),
  400(잘못된 본문). `mintToken(SECRET)`로 Bearer 생성, 업스트림은 목.
- **automation-service**: registry 조회, `spawn` 목으로 결과 집계, 부분 실패(`errors`) 처리,
  타임아웃/출력 상한.
- **앱** (vitest + @testing-library/svelte):
  - `parseAutomationNote` — `자동화::loc-history` → commandId, 비자동화 노트 → null.
  - `findDataBlockRegion` — csv/tsv 펜스 위치 정확도, 블록 없음 → null.
  - `runAutomation` — fetch 목으로 응답 파싱 + 에러 매핑.
  - `applyDataNoteCsv` — fake-indexeddb로 (a) 기존 노트 블록 교체, (b) 노트 없음 → 생성,
    (c) 블록 없는 노트 → 블록 추가.
  - `appendRunHistory` — 빈 노트(리스트 생성)/기존 리스트(prepend)/50개 초과(트림).

## 비목표 / 추후

- 스케줄/주기 실행(현재는 버튼 수동 트리거만). 추후 `/schedule`·cron으로 확장 가능.
- registry를 앱에서 편집하는 UI(현재는 데스크탑 설정 파일 직접 편집).
- 스트리밍 진행률(현재 비스트리밍; 필요 시 claude.ts SSE 패턴으로 전환).
- `loc-history.py` 자체 변경 없음.

## 검토했으나 뺀 대안

- **DATA:: 노트 본문에 `자동화::` 지시줄 내장** — 데이터와 자동화가 한 노트에 섞임. 분리된
  자동화 노트가 트리거·내역을 따로 담는 편이 깔끔(현 설계).
- **노트에 생명령 직접 기입** — 동기화된 노트가 임의 셸 실행 가능 → 보안상 기각.
- **claude-service 재사용** — 'claude' 전용 서비스에 성격이 다른 기능이 섞임 → 기각.
- **노트 본문 전체 교체** — 사용자가 손본 차트 설정이 매 실행마다 유실 → 기각.
- **SSE 스트리밍** — 스크립트가 수 초 내 일괄 출력이라 불필요한 복잡도 → 기각.
- **표/마지막 실행만 로그** — 리스트 누적이 이력 추적과 단순함의 균형이 좋음(현 설계).
