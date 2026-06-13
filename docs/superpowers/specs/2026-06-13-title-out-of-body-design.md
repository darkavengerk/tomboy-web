# 타이틀 본문 분리 + 타이틀 다이얼로그 + 생성 로딩 표시 설계

- 날짜: 2026-06-13
- 브랜치: tigress
- 상태: 설계 승인 대기

## 1. 배경 / 문제

현재 노트의 **타이틀은 본문 첫 줄로 직접 편집**된다. 구조적으로:

- `note.title`(별도 필드) ≡ `<note-content>` 첫 줄 ≡ `.note` XML의 `<title>` 엘리먼트 — 셋이 항상 동일하게 유지된다.
- 에디터에는 별도 타이틀 헤더가 없고, **TipTap 문서의 첫 top-level 노드가 곧 타이틀**이다 (`extractTitleFromDoc`, `app/src/lib/core/noteContentArchiver.ts:451`).

이 불변식은 광범위하게 load-bearing 하다:

- **Dropbox/Tomboy 라운드트립** — `serializeNote`가 `<title>`(`noteArchiver.ts:80`)과 `<note-content>` 첫 줄(`:81`)을 둘 다 기록.
- **링크 정체성** — 내부 링크 마크가 대상 *타이틀*을 저장. autolink·backlink 인덱스가 타이틀로 키잉.
- **노트종류 트리거** — `자동화::`·`음악추출::`·`음악::`·`리마커블::`·`DATA::`·`Slip-Box`는 **타이틀 접두어**로, `ssh://`·`llm://`·`claude://`·`ocr://`·`keys://`·`remarkable://`는 **본문 첫 시그니처 줄**로 인식.
- **sleepnote 검증** — `validator.ts:243`이 `first-line == note.title`을 명시적으로 단언.
- **sync 머지** — `contentMerge.ts:54`가 타이틀 변경 시 자동 머지를 거부.

타이틀이 본문에도 보이는 것이 시각적 중복이라, 사용자는 타이틀을 본문에서 빼길 원한다. 더불어:

1. 본문에서 타이틀 제거
2. 타이틀 수정 수단 — "..." 메뉴 + 타이틀 영역 더블클릭
3. 새 노트 생성 시 타이틀 입력 팝업
4. 팝업에서 노트종류 드롭다운(스캐폴드 자동주입) + 노트북 선택
5. 생성 중 단계별 로딩 표시(병목 가시화)

## 2. 핵심 결정 (승인됨)

| 결정 | 선택 |
|---|---|
| 타이틀 "제거" 방식 | **데이터엔 유지, 화면에서만 분리.** 저장되는 첫 줄=타이틀 그대로. 에디터가 첫 줄을 숨기고, 상단에 읽기전용 타이틀 바 표시. |
| 드롭다운 깊이 | **스캐폴드 자동주입 + 도움말.** 종류 선택 시 타이틀 접두어/본문 시그니처 줄 자동 채움 + 짧은 형식 안내. 세부 폼은 v1 제외. |
| 로딩 표시 | **단계명 + ms 항상 표시.** `노트 생성 → 인덱스 갱신 → 에디터 여는 중` 체크마크 + 각 단계 소요시간. |
| 타이틀 바 위치(모바일) | `editor-meta-bar` 아래 **별도 줄**. |
| 빈 타이틀 | **불가.** 팝업에서 타이틀 비면 "만들기" 비활성. (기존 날짜-자동-타이틀 폴백은 팝업 경로에서 제거) |

**불변식 유지:** `note.title` ≡ `<note-content>` 첫 줄 ≡ `<title>`. **마이그레이션 없음.**

## 3. 구성요소

### A. 데이터 모델 — 변경 없음

`note.title`, `xmlContent` 첫 줄, `<title>` 모두 현행 유지. 라운드트립·링크·노트종류 트리거 전부 무영향. 기존 노트도 첫 줄이 곧 타이틀이라 변환 불필요.

### B. 에디터 — 타이틀 격리 + 타이틀 바

신규 ProseMirror 플러그인 **`titleIsolation`** (`app/src/lib/editor/titleIsolation/`), `TomboyEditor.svelte`에서 prop(`hideTitleLine: boolean`, 기본 true)로 활성화:

1. **첫 top-level 노드 숨김** — `Decoration.node`로 `display:none` 클래스 부여. 문서엔 그대로 남아 직렬화·`extractTitleFromDoc`·라운드트립 전부 무사.
2. **커서 가드** — `appendTransaction`/`filterTransaction`에서 선택이 노드 0에 들어가면 노드 1(첫 보이는 줄) 시작으로 클램프. ↑·Ctrl+Home·클릭으로 숨은 타이틀에 캐럿 진입 불가.
3. **Backspace 가드** — 키맵: 첫 보이는 줄 맨 앞에서 Backspace 시 타이틀로의 join 차단(이벤트 소비).
4. **빈 본문 보장** — 타이틀만 있는 노트도 노드 1(빈 paragraph)이 존재해야 캐럿 둘 자리가 있음. `createEmptyNote`가 이미 `title\n\n`(=타이틀+빈 줄)을 생성하므로 충족. 방어적으로 노드 1 부재 시 빈 paragraph 보강.

**타이틀 표시(호스트별):**

- **모바일 `app/src/routes/note/[id]/+page.svelte`** — `editor-meta-bar`(현 `:721`) 아래 **신규 타이틀 바** 줄: `note.title` 읽기전용 표시 + 수정 아이콘. **더블클릭 → 수정 다이얼로그**. 반응형 바 규약(`clamp`)을 따름.
- **데스크탑 `app/src/lib/desktop/NoteWindow.svelte`** — 윈도우 타이틀 바가 이미 `note.title` 표시(`:1060`). **더블클릭 → 수정 다이얼로그** 핸들러만 추가.

> 대안 검토: 타이틀을 별도 노드 타입으로 스키마 분리 → 직렬화·추출·검증·sync 전 경로 영향, 위험 큼. 데코레이션+가드가 데이터 무손상이라 채택.

### C. 노트종류 레지스트리 (신규)

`app/src/lib/noteTypes/registry.ts` — 단일 카탈로그. 항목 형태:

```ts
interface NoteTypeSpec {
  id: string;                       // 'terminal'
  label: string;                    // '터미널 (SSH)'
  trigger: 'title-prefix' | 'body-signature' | 'structural' | 'plain';
  scaffold: { titlePrefix?: string; bodyFirstLine?: string };
  help: string;                     // 팝업 안내 + 예시
  guideHref?: string;               // 설정 가이드 카드 앵커
}
```

카탈로그(기본값 `plain` = 일반 노트):

| id | label | trigger | scaffold |
|---|---|---|---|
| `plain` | 일반 노트 | plain | — |
| `terminal` | 터미널 (SSH) | body-signature | `ssh://user@host` |
| `keys` | 키 이벤트 | body-signature | `keys://user@host` |
| `chat-ollama` | 채팅 (Ollama) | body-signature | `llm://<model>` |
| `chat-claude` | 채팅 (Claude) | body-signature | `claude://` |
| `ocr` | OCR | body-signature | `ocr://claude` |
| `remarkable-wallpaper` | 리마커블 배경화면 | body-signature | `remarkable://<alias>` |
| `automation` | 데이터 자동화 | title-prefix | `자동화::` |
| `data` | 데이터/차트 | title-prefix | `DATA::` |
| `music-extract` | 음악 추출 | title-prefix | `음악추출::` |
| `music` | 음악 플레이리스트 | title-prefix | `음악::` |
| `remarkable-upload` | 리마커블 업로드 | title-prefix | `리마커블::` |
| `schedule` | 일정 | structural | (날짜 시드) |
| `slip` | Slip-Box | title-prefix | `Slip-Box::` |

각 항목의 `help`는 기존 `parseXxxNote`가 인식하는 최소 형식과 일치시킴 (parser 파일은 §부록 참조). 드롭다운·도움말·스캐폴드가 전부 이 한 곳에서 파생 → 단일 출처.

### D. 새 노트 다이얼로그 (생성 모드)

`app/src/lib/components/NoteTitleDialog.svelte` — `mode: 'create' | 'edit'`. **생성 모드 필드:**

- **타이틀** 텍스트 입력 (필수, 비면 "만들기" 비활성)
- **종류** 드롭다운 (레지스트리) → 선택 시 `help`/예시 표시. 스캐폴드는 확정 시점에 합성(미리보기로 안내만).
- **노트북** 드롭다운 (`listNotebooks()` + '없음' + 새로 만들기 입력). `/notes`에서 노트북 필터 활성 시 그 노트북 기본 선택.

확정 시 합성:
- title-prefix 타입: `finalTitle = titlePrefix + 입력타이틀`
- body-signature 타입: `finalTitle = 입력타이틀`, 본문 첫 줄 = `bodyFirstLine`
- plain: 입력타이틀 그대로

→ §F `createNote({ title, typeId, notebook })` 호출.

진입점: TopNav "+"(`TopNav.svelte:56`), 데스크탑 SidePanel "새 노트"(`SidePanel.svelte:131`). 실제 띄우기는 전역 플로우(§G)에 위임.

### E. 수정 다이얼로그 (편집 모드)

같은 컴포넌트, `mode: 'edit'`. **필드: 타이틀 + 노트북만** (종류 드롭다운 숨김 — 기존 노트 타입 변환은 v1 제외). 타이틀 입력에 기존 `note.title` 프리필.

진입점:
- **"..." 메뉴 `타이틀 수정` 항목** — 모바일 `NoteActionSheet.svelte`(ActionKind `'editTitle'` 추가) + 데스크탑 `NoteContextMenu.svelte`.
- **타이틀 바/윈도우 타이틀 더블클릭**.

확정 → §F `renameNote(guid, newTitle)` + 노트북 변경 시 `assignNotebook`.

### F. 백엔드 — `createNote` 확장 + `renameNote` 신규

`app/src/lib/core/noteManager.ts`:

- **`createNote` 확장** — 현재 시그니처는 `initialTitle?`(`:54`). `{ title: string; typeId?: string; notebook?: string | null }` 옵션 객체를 받도록 확장(기존 호출부 호환 유지). 타입 스캐폴드로 `xmlContent` 시드(타이틀 줄 + 필요 시 본문 시그니처 줄). 생성 후 `notebook` 지정 시 `assignNotebook`. 날짜형 타이틀 자동 시드(현 `:62-83`)는 plain/schedule 타입에서만 적용.
- **`renameNote(guid, newTitle)` 신규** — 단계:
  1. `titleUniqueGuard.checkTitleConflict` — 충돌 시 토스트 후 중단.
  2. `titleRewrite.rewriteTitleInNoteContentXml(xml, newTitle)`로 `xmlContent` 첫 줄 갱신 + `note.title` 갱신, `putNote`.
  3. `rewriteBacklinksForRename` 캐스케이드 (기존 함수 재사용).
  4. `noteReloadBus.emitNoteReload(affected)` — 열린 에디터가 stale doc 버리고 IDB 리로드.

  **기존 rename 기계 재사용** — `updateNoteFromEditor`의 타이틀-변경 분기(`:121-165`)와 동일 경로. 새 로직 최소.

타이틀이 더 이상 인라인 편집되지 않으므로 `updateNoteFromEditor`의 타이틀 추출/캐스케이드는 안전망으로 남되 평상시 발화하지 않음. 인라인 `titleUniqueGuard.handleTitleBlur`(블러 가드)는 숨은 타이틀에 대해 무력화(타이틀 줄에 더 이상 캐럿이 못 들어가므로 자연 비활성).

### G. 생성 플로우 + 로딩 진행 표시

`app/src/lib/stores/newNoteFlow.svelte.ts` (rune 모듈 상태) + 루트 레이아웃(`+layout.svelte`)에 1회 마운트되는 다이얼로그 호스트 → **네비게이션을 넘어 생존**.

- **2단계 다이얼로그**: ① 입력 단계(타이틀/종류/노트북) ② 진행 단계(생성 중 단계 표시).
- 진입점은 `newNoteFlow.open({ notebook? })` 호출 → 입력 단계 표시.
- 확정 → 진행 단계 전환, 단계 계측:

| 단계 | 측정 구간 |
|---|---|
| `노트 생성` | `createNote()` 시작~완료 (IDB put + 캐시 패치 + Firestore notify) |
| `인덱스 갱신` | `noteMutated`/타이틀·백링크 인덱스 갱신 |
| `에디터 여는 중` | `goto('/note/[id]')` 직후~`TomboyEditor`가 새 guid로 mount 완료 신호까지 |

- 각 단계: 체크마크 + ms를 **항상** 표시.
- `TomboyEditor`가 새 guid 첫 렌더 완료 시 `newNoteFlow.markEditorReady(guid)` 호출 → 마지막 단계 ms 확정 + 다이얼로그 닫힘.
- 시간 측정은 `performance.now()` (스크립트 환경 아님, 브라우저 OK).
- **단계 경계 주의**: `createNote`는 내부에서 `noteMutated`/`notifyNoteSaved`를 이미 호출한다(`noteManager.ts:95,99`). 단계를 깔끔히 분리하려면 `createNote`가 단계 콜백(`onStage?: (name) => void`)을 받아 IDB put 직후/인덱스 패치 직후 마커를 emit하도록 소폭 리팩터. 분리가 과하면 `노트 생성`(createNote 전체) + `에디터 여는 중` 2단계로 축소 가능 — 계측 자체가 목적이므로 경계는 구현 시 측정해보고 확정.

> 산출물은 **계측·가시화**. 실제 성능 최적화는 측정값을 보고 별도 후속.

### H. 가이드 카드 (CLAUDE.md 필수)

`app/src/routes/settings/+page.svelte`에 `<details class="guide-card">` 추가:

- **`editor` 탭** — "타이틀은 본문에서 분리됨": 첫 줄이 더 이상 본문에 안 보이고, 수정은 ··· 메뉴의 `타이틀 수정` 또는 타이틀 영역 더블클릭으로.
- **`notes` 탭** — "새 노트 만들기": 타이틀 필수 입력, 노트종류 드롭다운으로 스캐폴드 자동주입, 노트북 동시 지정, 생성 단계 로딩 표시.

기존 카드 패턴(짧은 `<summary>` + `<p class="info-text">` + 필요 시 `<pre class="snippet">` + `<ul class="guide-list">`) 미러링.

## 4. 데이터 흐름

```
[+] 버튼 ─▶ newNoteFlow.open() ─▶ NoteTitleDialog(create)
   타이틀/종류/노트북 입력 ─▶ [만들기]
      ├─ createNote({title,typeId,notebook})  ── 단계: 노트 생성
      ├─ (인덱스 갱신)                          ── 단계: 인덱스 갱신
      ├─ goto(/note/guid)                       ── 단계: 에디터 여는 중
      └─ TomboyEditor mount(guid) ─▶ markEditorReady ─▶ 다이얼로그 닫힘

타이틀 바 더블클릭 / ··· 메뉴 '타이틀 수정'
   ─▶ NoteTitleDialog(edit, 프리필) ─▶ [저장]
      └─ renameNote(guid,newTitle)  (충돌검사→첫줄재작성→백링크캐스케이드→리로드버스)
         + assignNotebook(변경 시)

에디터 렌더: titleIsolation 플러그인 ─▶ 노드0 display:none + 커서/Backspace 가드
                                       ─▶ 본문은 노드1부터 편집
```

## 5. 에러 처리

- **타이틀 충돌(생성/수정)** — `checkTitleConflict`로 사전 검사, 토스트 + 다이얼로그 유지(닫지 않음).
- **빈 타이틀** — "만들기"/"저장" 비활성으로 원천 차단.
- **생성 중 실패** — 진행 단계에서 에러 표시 + 재시도/닫기. 부분 생성(IDB put 성공·네비 실패) 시 노트는 남으므로 목록에서 접근 가능.
- **에디터-준비 신호 누락** — `markEditorReady` 타임아웃(예: 5s) 폴백으로 다이얼로그 닫힘(측정값엔 timeout 표기).

## 6. 테스트 (vitest + @testing-library/svelte)

- `titleIsolation`: 노드0 숨김 데코, 커서 클램프(↑/Ctrl+Home/클릭), 첫 보이는 줄 맨 앞 Backspace 차단. **`afterEach`에서 에디터 destroy 준수.**
- `renameNote`: 충돌 거부, 첫 줄+`note.title` 동기 갱신, 백링크 캐스케이드, **라운드트립**(`serializeNote`→`parseNote`로 `<title>`/첫 줄 일치).
- 레지스트리: 각 타입 스캐폴드 합성(title-prefix/body-signature/plain) 결과 검증.
- `createNote` 확장: typeId별 `xmlContent` 시드 + notebook 지정 호출.
- `newNoteFlow`: 단계 전환·ms 기록·`markEditorReady` 닫힘 (rune 스토어 단위 + 마운트 렌더 테스트).
- e2e 없음 — 크로스플로우는 `npm run dev` 수동.

## 7. 범위 밖 / 후속

- 데스크탑 Ctrl+L 추출 생성(본문 이미 존재) — 팝업 생략, 현행 유지.
- 편집 모드 노트 **타입 변환** — v1 제외.
- 측정 기반 **성능 최적화** — 별도 작업.
- 종류별 **맞춤 미니폼**(host/user/port 등) — v1 제외, 추후 자주 쓰는 종류부터.

## 부록: 관련 parser/파일 레퍼런스

| 영역 | 파일 |
|---|---|
| 노트 모델/생성 | `app/src/lib/core/note.ts:48` `createEmptyNote` |
| 직렬화/파싱 | `app/src/lib/core/noteArchiver.ts:76,15` |
| 타이틀 추출(doc) | `app/src/lib/core/noteContentArchiver.ts:451` `extractTitleFromDoc` |
| 생성/수정 매니저 | `app/src/lib/core/noteManager.ts:54,104` |
| 타이틀 재작성 | `app/src/lib/core/titleRewrite.ts:34` |
| 충돌 검사 | `app/src/lib/editor/titleUniqueGuard.ts:32` |
| 노트북 | `app/src/lib/core/notebooks.ts` (`listNotebooks`/`assignNotebook`/`filterByNotebook`) |
| "..." 메뉴 | `app/src/lib/editor/NoteActionSheet.svelte` / `NoteContextMenu.svelte` |
| 노트북 피커 | `app/src/lib/components/NotebookPicker.svelte` |
| 모바일 노트 페이지 | `app/src/routes/note/[id]/+page.svelte:717` (메타바/에디터영역) |
| 데스크탑 윈도우 | `app/src/lib/desktop/NoteWindow.svelte:1060` (윈도우 타이틀) |
| parser 모음 | `parseTerminalNote.ts:62` `parseChatNote.ts:58` `parseOcrNote.ts:46` `parseAutomationNote.ts:6` `parseExtractNote.ts:46` `parseMusicNote.ts:127` `parseRemarkableNote.ts:33` `parseRemarkableUploadNote.ts:33` `parseKeysNote.ts:30` `parseSchedule.ts:125` `sleepnote/validator.ts:45` `parseDataNote.ts:25` |
| 가이드 카드 | `app/src/routes/settings/+page.svelte` (guideSubTab notes/editor) |
