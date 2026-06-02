# 데이터 노트 자동화 설계

작성일: 2026-06-02

## 배경

`DATA::` 차트 노트는 본문의 ```` ```csv ```` 코드펜스를 데이터 소스로 차트를 그린다.
지금은 그 CSV를 사람이 직접 채운다. 예: `~/loc-history.py` 가 git 커밋 히스토리를
훑어 날짜별 소스 LOC를 CSV로 뽑아주지만, 그 결과를 노트에 붙여넣는 건 수작업이다.

이 작업을 자동화한다. **데이터 노트의 버튼을 누르면 → 브릿지를 거쳐 → 데스크탑에서
설정된 스크립트가 실행되고 → 결과가 돌아오면 → 해당 `DATA::` 노트의 CSV 블록이
자동 갱신**된다.

## 기존 자산 (그대로 미러링)

이 설계는 새 패턴을 만들지 않는다. 이미 있는 두 경로를 합쳐 따른다.

- **`claude://` 챗노트 경로** — 앱 → 브릿지 `/claude/chat` → 데스크탑 `claude-service`
  → `spawn` → 결과. 인증·프록시·Quadlet 배포의 템플릿.
  - 앱 클라이언트: `app/src/lib/chatNote/backends/claude.ts`
  - 브릿지 프록시(스트리밍): `bridge/src/claude.ts`, (비스트리밍) `bridge/src/ocr.ts`
  - 브릿지 라우팅/인증: `bridge/src/server.ts`, `bridge/src/auth.ts`
  - 데스크탑 서비스: `claude-service/src/{server,runner,auth}.ts`
  - Quadlet: `claude-service/deploy/claude-service.container`, `ocr-service/deploy/ocr-service.container`
- **footnote `claudeFill`** — 브릿지 호출 결과를 노트에 써넣는 완성된 모델.
  - `app/src/lib/editor/footnote/claudeFill.ts` (`view.dispatch` 써넣기 + 파괴된 view 가드)
- **차트 블록 플러그인** — 에디터에 인터랙티브 위젯을 마운트하는 패턴.
  - `app/src/lib/editor/chartBlock/chartBlockPlugin.ts`, `findChartRegions.ts`
  - 데이터 노트 파싱: `app/src/lib/chart/parseDataNote.ts`
- **노트 영속화 초크포인트** — `app/src/lib/core/noteManager.ts`
  - `createNote(initialTitle?)`, `getNoteEditorContent(note)`, `updateNoteFromEditor(guid, doc)`
- **브릿지 설정 접근자** — `app/src/lib/editor/terminal/bridgeSettings.ts`
  - `getDefaultTerminalBridge()`, `getTerminalBridgeToken()`, `bridgeToHttpBase(bridge)`

## 결정 사항 (브레인스토밍 확정)

1. **등록된 명령 ID** — 데스크탑 서비스가 registry(설정 파일)를 들고 `command id → 실제
   스크립트 invocation`을 매핑한다. 노트는 command id만 보낸다. registry가 신뢰 경계다.
2. **CSV 데이터 블록만 교체** — 노트의 첫 ```` ```csv ```` 펜스 내용만 갈아끼운다.
   제목·차트 블록·자동화 표기는 보존. 스크립트는 `--csv-only`로 돌린다.
3. **새 automation 서비스** — claude-service와 같은 스택의 소형 Fastify 서비스를 신설.
   registry를 소유하고 향후 다른 자동화에도 재사용한다.
4. **파라미터는 데스크탑 고정** — 경로·제외 등 인자는 registry에만 있다. 노트는 경로를
   넘기지 않는다. 스크립트는 `{프로젝트명: CSV}` 형태로 결과를 돌려준다(프로젝트명은
   registry config가 부여).
5. **프로젝트명 → 노트 제목 팬아웃** — 응답은 `{프로젝트명: CSV}` 맵. 앱은 각 키마다
   `DATA::<프로젝트명>` 노트를 찾아 갱신한다. 한 번의 트리거로 여러 노트 갱신 가능.
6. **노트 없으면 새로 생성** — `DATA::<프로젝트명>` 노트가 없으면 스킵하지 않고
   `createNote`로 만든 뒤 CSV를 채운다.
7. **비스트리밍** — 스크립트는 수 초 내 한 번에 출력. SSE 없이 plain request/response
   (`ocr.ts` 패턴).

## 전체 흐름

```
[DATA::tomboy 노트의 ⟳ 버튼]
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
앱   results 각 project마다:
        DATA::<project> 노트 찾기 → 없으면 createNote → 첫 ```csv 블록 교체(없으면 추가) → 저장
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

- **`runAutomation.ts`** — `runAutomation({ command, signal }): Promise<{ results: Record<string,string>, errors: Record<string,string> }>`.
  `bridgeSettings`에서 bridge/token 획득 → `bridgeToHttpBase` 정규화 →
  `POST {httpBase}/automation/run` Bearer. 에러 매핑은 `sendClaude`의 `STATUS_TO_KIND`
  모델 재사용(401 unauthorized / 503 service_unavailable / ≥500 upstream_error / 그 외 bad_request),
  abort는 throw 대신 조용히 종료.
- **`findDataBlockRegion.ts`** — 라이브 PMNode에서 첫 ```` ```csv ````/```` ```tsv ````
  펜스 본문의 노드 범위 `{ from, to, format }`를 산출(`findChartRegions` 미러; 실제
  `nodeSize` 오프셋 사용). 블록이 없으면 `null`. (본문 펜스는 `inlineCheckbox` 아톰과 무관.)
- **`applyDataNoteCsv.ts`** — `applyDataNoteCsv(project, csv, view?)`:
  1. `findNoteByTitle("DATA::" + project)`.
  2. **없으면 `createNote("DATA::" + project)`** 로 신규 생성 → doc 확보.
  3. `findDataBlockRegion`으로 첫 csv 블록 범위 찾기 → **있으면 본문 교체, 없으면(신규
     노트 등) `DATA::` 줄 아래에 새 ```` ```csv ```` 블록 추가**.
  4. 저장:
     - **호스트(현재 열린 에디터) 노트**면 라이브 `view.dispatch`로 범위 교체(claudeFill
       패턴, 파괴된 view 가드 포함).
     - **닫혔거나 다른 창**이면 `getNoteEditorContent → 블록 교체/추가 → updateNoteFromEditor`
       후 `noteReloadBus.emitNoteReload([guid])` + `desktopSession.reloadWindows([guid])`
       (교차창 불변식). 신규 생성 노트는 보통 닫힌 상태 → 이 경로.

### (D) 앱 에디터 플러그인: `lib/editor/automationButton/`

- 문서에서 `자동화::<command-id> <라벨>` 형태 단락을 스캔 → 그 뒤에 `Decoration.widget`로
  `contentEditable=false` **버튼**(`⟳ <라벨>`) 마운트(chartBlockPlugin 패턴).
- 차트의 체크박스 토글과 달리 **일회성 클릭 실행**(영속 상태 없음).
- onclick → 버튼 비활성 + 스피너 → `runAutomation({ command })` → `results` 각 항목을
  `applyDataNoteCsv(project, csv, view)`(현재 노트가 그 project면 view 전달) → 성공/부분
  실패 한국어 토스트 → 버튼 복귀.

### (E) 문서: 설정 → 가이드

`app/src/routes/settings/+page.svelte` 의 `notes`(또는 `editor`) 서브탭에
`<details class="guide-card">` 추가. 기존 카드 패턴(짧은 `<summary>`, `<p class="info-text">`
인트로, `<pre class="snippet">` 예시, `<ul class="guide-list">` 제약/주의) 그대로.
`DATA::` 차트 카드와 인접 배치하고, 데스크탑 registry 설정·브릿지 env 선행조건을 명시.

## 노트 표기

DATA:: 노트 안에 데이터 블록과 자동화 표기를 함께 둔다:

```
DATA::tomboy

```csv
날짜,합계,TypeScript,Svelte,Python,JS,CSS,HTML
2026-06-02,116959,85017,24414,7169,266,71,22
```

자동화::loc-history 코드 라인 갱신
```

- `자동화::` 는 `DATA::` 와 같은 `::` 계열 표기.
- 그 줄 뒤에 `[⟳ 코드 라인 갱신]` 버튼이 렌더된다.
- 누르면 `loc-history` 트리거 → 응답의 모든 `DATA::<project>` 노트(여기선 tomboy·robotC)
  가 갱신된다(없으면 생성).

## 에러 처리 (전부 한국어 토스트)

- 브릿지/서비스 불통·미설정(503) → "자동화 서비스에 연결할 수 없습니다"
- 401 → 토큰 안내 토스트.
- 모르는 command(400) → "등록되지 않은 명령입니다"
- `results`는 모두 적용하되, `errors`에 담긴 프로젝트는 개별 토스트로 보고(나머지는 정상 갱신).
- **`DATA::<project>` 노트 없음 → 새로 생성** 후 CSV 채움. 토스트 "DATA::X 노트를 생성했습니다".
- 생성 자체 실패(IDB 오류 등)만 개별 토스트로 보고.
- 스크립트 타임아웃·출력 초과·비정상 종료 → 서비스가 해당 project를 `errors`로 분류.
- 쓰기 직전 view 파괴 → 가드 후 스킵(claudeFill 패턴).

## 테스트

- **브릿지** `automation.test.ts` (`node --test`): 인증 통과/실패, 프록시 정상, 503(미설정/불통),
  400(잘못된 본문). `mintToken(SECRET)`로 Bearer 생성, 업스트림은 목.
- **automation-service**: registry 조회, `spawn` 목으로 결과 집계, 부분 실패(`errors`) 처리,
  타임아웃/출력 상한.
- **앱** (vitest + @testing-library/svelte):
  - `findDataBlockRegion` — csv/tsv 펜스 위치 정확도, 블록 없음 → null.
  - `runAutomation` — fetch 목으로 응답 파싱 + 에러 매핑.
  - `applyDataNoteCsv` — fake-indexeddb로 (a) 기존 노트 블록 교체, (b) 노트 없음 → 생성,
    (c) 블록 없는 노트 → 블록 추가, (d) 호스트/비호스트 경로 분기.

## 비목표 / 추후

- 스케줄/주기 실행(현재는 버튼 수동 트리거만). 추후 `/schedule`·cron으로 확장 가능.
- registry를 앱에서 편집하는 UI(현재는 데스크탑 설정 파일 직접 편집).
- 스트리밍 진행률(현재 비스트리밍; 필요 시 claude.ts SSE 패턴으로 전환).
- `loc-history.py` 자체 변경 없음.

## 검토했으나 뺀 대안

- **노트에 생명령 직접 기입** — 동기화된 노트가 임의 셸 실행 가능 → 보안상 기각.
- **claude-service 재사용** — 'claude' 전용 서비스에 성격이 다른 기능이 섞임 → 기각.
- **노트 본문 전체 교체** — 사용자가 손본 차트 설정이 매 실행마다 유실 → 기각.
- **SSE 스트리밍** — 스크립트가 수 초 내 일괄 출력이라 불필요한 복잡도 → 기각.
