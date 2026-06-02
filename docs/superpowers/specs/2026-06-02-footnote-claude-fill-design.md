# 각주 @claude 자동 채우기 (Footnote Claude Fill)

> 2026-06-02 · 설계 문서

## 요약

노트를 쓰다가 각주를 만들고, 각주 **정의 칸**에 자연어 지시 + `@claude ` 트리거를 적으면
(예: `좀 더 자세한 설명을 해줘 @claude `) Claude가 호출되어 그 정의를 채운다.
Claude에게는 **본문 참조 마커 위치까지의 텍스트** + 정의 칸의 지시문을 입력으로 주고,
생성된 응답으로 정의 칸을 **100% 대체**한다. 각주이므로 ~300자 이내(소프트)로 유도한다.

기존 두 시스템을 잇는 연동이며 **새 인프라가 없다**:

- 각주 기능: `app/src/lib/editor/footnote/` (`[^N]` 마커, 정의/참조 구분, 페어링 로직)
- Claude 백엔드: client `sendClaude()` → bridge `/claude/chat` → desktop `claude-service` → `claude -p` 스트리밍
- bridge URL·토큰: 노트 편집기가 이미 `getDefaultTerminalBridge()` / `getTerminalBridgeToken()`로 로드

## 동작 시나리오

1. 사용자가 본문에 각주 참조 마커 `[^1]`를 삽입(기존 insert 커맨드) → 하단에 정의 단락 자동 생성.
2. 정의 단락에 `좀 더 자세한 설명을 해줘 @claude ` 입력 (마지막 공백이 트리거).
3. 트리거 감지 → 정의 단락의 지시문 텍스트가 즉시 비워지고, 옆에 일시적 "생각 중" 상태 표시 등장.
4. Claude 응답 델타가 정의 칸에 실시간으로 흘러 들어옴(마커 `[^1]`은 유지).
5. 완료 → 정의 칸에는 답변만 남음. 상태 표시 사라짐.
6. (실패/중단) → 정의 칸에 **원래 지시문 복원** + 한국어 에러 토스트.

## 결정 사항 (확정)

| 항목 | 결정 |
|---|---|
| 트리거 | 정의 칸에서 `@claude ` (뒤 공백 포함) 자동 감지 |
| 컨텍스트 범위 | 제목 ~ 본문 **참조 마커 위치**까지 평문 (이후 본문·각주 정의 제외) |
| 출력 | 응답으로 정의 칸 100% 대체 (질문 문구·`@claude` 모두 제거) |
| 생각 과정 | 각주 옆 **일시적 상태 표시**(정의 텍스트엔 미포함). 완료 시 사라짐 — 안 A |
| 실패/중단 | **원래 지시문 복원** + 에러 토스트 |
| 글자수(~300자) | **시스템 프롬프트 소프트 유도** (하드 컷 없음) |
| 백엔드 | 기존 `sendClaude()` / `/claude/chat` 재사용. claude-service 데스크탑 전용 |

## 아키텍처

```
TomboyEditor (footnote 확장 번들)
  └─ footnoteClaudeTrigger plugin  ── 트랜잭션 감시, 정의 칸 @claude▮ 감지
        │  (진행 중 label 잠금: 재발화 방지)
        ▼
  claudeFill.ts  ── 컨텍스트 추출 → 프롬프트 조립 → sendClaude 스트리밍 → 정의 칸 mutate
        │                                   │
        │  bridge URL/token ◀─ getDefaultTerminalBridge()/getTerminalBridgeToken()
        │  model/effort     ◀─ getClaudeDefaultModel()/getClaudeDefaultEffort()
        ▼
  sendClaude()  (lib/chatNote/backends/claude.ts, 기존)
        ▼  POST /claude/chat (Bearer)
  bridge /claude/chat  →  claude-service /chat  →  claude -p (stream-json → SSE)
```

## 컴포넌트

### 1. `footnoteClaudeTrigger` 플러그인 (신규 또는 기존 plugin.ts 확장)
**역할:** 정의 칸에서 `@claude ` 트리거를 감지하고 채우기를 1회 발화.

- 매 트랜잭션(`docChanged`) 후, 변경이 닿은 **각주 정의 단락**을 검사.
  - 정의 단락 판정 = 첫 inline 자식이 정의용 `footnoteMarker` (기존 `isDefinitionResolved($pos)` 재사용).
- 단락의 마커 뒤 텍스트가 `/@claude\s/`로 새로 매치되면 트리거.
- 플러그인 state에 진행 중 `label`(또는 정의 위치) 집합을 두어 **중복 발화·재진입 방지**.
- 발화 시 `claudeFill(view, defParagraphPos, label)` 호출.
- 플러그인 `destroy` 시 진행 중인 모든 fill을 abort.

**의존:** `isDefinitionResolved`, ProseMirror plugin API.

### 2. `claudeFill.ts` (신규)
**역할:** 컨텍스트 추출 → 프롬프트 조립 → 스트리밍 → 정의 칸 mutate → 실패 복원.

핵심 흐름 `fillFootnote(view, defPos, label)`:

1. **짝 참조 마커 위치** 탐색: 기존 `footnotes.ts` 페어링 로직으로 `label`의 참조 마커 `refPos`를 찾음.
   - 없으면 폴백: 첫 각주 정의 섹션 시작(`---`/첫 정의 마커) 직전까지.
2. **컨텍스트** = `doc.textBetween(0, refPos, '\n')` (평문, 마커 atom 자연 제외).
3. **지시문** = 정의 단락 마커 뒤 텍스트에서 `@claude` 토큰 제거 후 trim.
4. **메시지** = `[{ role:'user', content:[{type:'text', text: `${context}\n\n[각주 요청] ${instruction}` }] }]`.
5. **스냅샷**: 원래 정의 텍스트(마커 뒤) 보관.
6. **시작**: 정의 단락 마커 뒤 텍스트 즉시 제거(빈 정의). 상태 표시 on.
7. `sendClaude({ url:`${bridge}/claude/chat`, token, body:{ messages, model, system, effort }, onToken, onStep, signal })`:
   - `onToken(delta)` → 정의 단락 끝(마커 뒤)에 델타 삽입.
   - `onStep(step)` → 일시적 상태 표시 갱신(정의 텍스트엔 미반영).
8. **done** → 정의 텍스트 trim 정리. 상태 표시 off. 잠금 해제.
9. **error/abort** → 정의 텍스트를 스냅샷 원문으로 복원. 한국어 토스트. 잠금 해제.

**의존:** `sendClaude`(기존), `footnotes.ts` 페어링, appSettings getters, ProseMirror `view.dispatch`.

**불변식:**
- 정의 단락의 `footnoteMarker` atom 노드는 절대 건드리지 않음 — 마커 뒤 텍스트만 교체.
- 스트리밍 중 사용자가 같은 정의를 다시 트리거하지 못하도록 잠금 유지.

### 3. 시스템 프롬프트 상수 (신규)
`claudeFill.ts` 내 상수 (또는 `defaults.ts`):

> "너는 각주(footnote)를 작성하는 도우미다. 주어진 본문 맥락과 요청을 바탕으로,
> 머리말·맺음말 없이 본문만, 한국어로, 300자 이내로 간결하게 작성한다."

- 모델/effort는 `getClaudeDefaultModel()` / `getClaudeDefaultEffort()` 재사용.
- (YAGNI) 전용 설정 키는 추가하지 않음. 필요 시 후속.

### 4. 일시적 상태 표시
- 채팅 노트의 step 표시와 유사한 경량 UI. 각주 정의 단락 근처에 "생각 중…" / 현재 step label 표시.
- 정의 텍스트에는 들어가지 않음(안 A). 완료/실패 시 제거.
- 구현 옵션: ProseMirror widget decoration 또는 정의 단락에 임시 `data-` 속성 + CSS. (계획 단계에서 확정.)

### 5. 가이드 카드 (필수)
`app/src/routes/settings/+page.svelte`, `guideSubTab: 'editor'`에 `<details class="guide-card">` 추가:
- summary: "각주를 Claude로 채우기"
- info-text: `@claude ` 트리거 설명
- snippet: 예시 (`좀 더 자세한 설명을 해줘 @claude `)
- guide-list: 컨텍스트 = 참조 마커까지, ~300자, 데스크탑 claude-service 필요, 실패 시 원문 복원.

## 데이터 흐름

```
입력: 정의 칸 "지시문 @claude "
  → 트리거 플러그인 감지
  → claudeFill: refPos 탐색, context=textBetween(0,refPos), instruction 추출
  → messages = [user: context + [각주 요청] instruction]
  → sendClaude (SSE)
      ├─ onToken → 정의 칸에 답변 델타 append
      └─ onStep  → 상태 표시 갱신
  → done: 정의 칸 = 답변만
  → error/abort: 정의 칸 = 원문 복원
```

## 에러 처리

| 상황 | 처리 |
|---|---|
| bridge 미설정/미도달 (모바일 등) | `sendClaude` throw → 원문 복원 + 토스트 "Claude 서비스에 연결할 수 없습니다" |
| claude-service 오류(SSE `error`) | 원문 복원 + 토스트(서버 메시지) |
| 사용자 중단 (Esc 또는 편집기 teardown) | abort → 원문 복원(가능 시) |
| 짝 참조 마커 없음 | 폴백 컨텍스트(각주 섹션 전 본문 전체)로 진행 |
| 응답 빈 문자열 | 원문 복원 + 토스트 |

## 테스트

- **단위 (vitest):**
  - 트리거 감지: 정의 칸 `@claude ` → 발화 / 본문 일반 단락의 `@claude `는 무시 / 참조 마커 위치는 무시.
  - 컨텍스트 추출: `textBetween(0, refPos)`가 제목~마커 직전만 포함, 이후·각주 정의 제외.
  - 지시문 추출: `@claude` 토큰 제거 + trim.
  - 페어링 폴백: 짝 마커 없을 때 폴백 경계.
  - 잠금: 진행 중 재발화 무시.
  - 복원: 에러/abort 시 원문 정의 텍스트 복구.
  - `sendClaude`는 목(mock)으로 onToken/onStep/done/error 시뮬레이션.
- **수동:** `npm run dev` + 데스크탑 claude-service 가동 후 실제 스트리밍/중단/복원 확인.

## 범위 밖 (YAGNI)

- 전용 설정 탭/키 (model/effort/system 오버라이드) — 후속.
- 이미지 컨텍스트 전달 — 텍스트만.
- 하드 글자수 컷 — 소프트만.
- 세션 resume — 매 호출 노트에서 재조립(채팅 노트와 동일 철학).
- 모바일에서의 claude-service 대체 경로 — 데스크탑 전용 유지.

## 영향 파일

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/footnote/claudeFill.ts` | 신규: 오케스트레이션 |
| `app/src/lib/editor/footnote/plugin.ts` 또는 신규 `claudeTriggerPlugin.ts` | 트리거 감지 |
| `app/src/lib/editor/footnote/footnotes.ts` | 페어링/위치 헬퍼 재사용(필요 시 보강) |
| `app/src/lib/editor/footnote/index.ts` | 플러그인 번들에 트리거 추가 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드(editor 탭) |
| `app/tests/unit/editor/footnote/*` | 단위 테스트 |
