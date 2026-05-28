# 모바일 모디파이어 바 좌측 고정 + Alt+J 각주 삽입

## 배경

모바일 노트 편집 화면 하단 `dock` 의 단축키 트레이에는 Ctrl / Alt 잠금 버튼이 있다.
사용자가 잠금 버튼을 탭하면 해당 모디파이어에 묶인 단축키들이 트레이에 노출된다.

현재 동작 (`app/src/lib/editor/Toolbar.svelte:198-245`):

- Ctrl 잠금 시: `[Ctrl] [↵ D S H M O K]` — 잠금 버튼이 **왼쪽**, 단축키들이 오른쪽으로 펼쳐짐. 직관적.
- Alt 잠금 시: `[← ↑ ↓ →] [Alt]` — 단축키들이 **왼쪽**, 잠금 버튼이 오른쪽. 비대칭/비직관적.

원인: DOM 순서가 `[Ctrl-tog] [Ctrl-row] [Alt-row] [Alt-tog]` 로 Ctrl 만 좌측 고정 패턴이고
Alt 는 거꾸로 박혀있음.

동시에 사용자가 최근 추가한 각주 기능 (`app/src/lib/editor/footnote/`) 을 단축키로
호출하고 싶어 한다. 현재 각주 모듈은 데코레이션 + 클릭 점프만 있고 **삽입 명령이 없어
사용자가 `[^N]` 을 손으로 타이핑**해야 한다.

## 결정 사항

### A. 모디파이어 바 — Alt 잠금 버튼을 좌측 고정

- `Toolbar.svelte` 의 `{#if altLocked} <div class="key-row">` 블록과
  `{#if !ctrlLocked} <button class="mod-toggle">Alt</button>` 블록의 자리를 교환.
- 새 DOM 순서: `[Ctrl-tog] [Ctrl-row] [Alt-tog] [Alt-row]`.
- 세 상태가 자연스럽게 모두 일관:
  - 둘 다 off: `[Ctrl] [Alt]`
  - Ctrl 잠금: `[Ctrl] [↵ D S H M O K]`
  - Alt 잠금: `[Alt] [← ↑ ↓ → J]` (J 는 아래 C 에서 추가)
- CSS, state, 이벤트 핸들러 변경 없음. 순수 마크업 재배치.

### B. 각주 삽입 명령 — 그룹 단위 자동 리넘버

`TomboyFootnote` extension 에 `insertFootnote` 명령 추가. 로직은
`app/src/lib/editor/footnote/insertCommand.ts` 신규 모듈의 순수 함수
`buildInsertFootnoteTransaction(state)` 에 캡슐화.

**알고리즘 (단일 트랜잭션, 원자적 undo):**

1. **Guard**:
   - 커서가 0번 단락(제목) 안 → abort, 토스트
     "각주는 본문에서만 삽입할 수 있습니다".
   - `findFootnoteAt(matches, cursor)` 가 truthy (커서가 기존 `[^N]` 내부) →
     abort, 토스트 "기존 각주 안에서는 삽입할 수 없습니다".
   - 셀렉션 (`from !== to`) 은 셀렉션 영역을 새 참조로 대체 (PM 기본 동작).

2. **그룹 식별 (라벨 단위)**: `findFootnoteMatches(doc)` 결과 중 숫자 라벨만
   대상. 같은 라벨의 모든 매치 (참조 N개 + 정의 0–1개) 는 한 그룹.
   새 참조도 `__NEW__` 그룹으로 가짜 등록, 첫 등장 위치는 커서 위치.

3. **라벨 재할당**: 그룹들을 "첫 등장 위치 오름차순" 으로 정렬, 1부터 순서대로
   새 라벨 부여. `oldToNew: Map<string, string>`.

4. **치환 + 삽입 작업을 역순 적용**:
   - 모든 기존 숫자 매치 → `tr.insertText('[^newLabel]', m.from, m.to)`.
   - 새 참조 → `tr.insertText('[^newLabel]', state.selection.from, state.selection.to)`.
     `from === to` 면 zero-width 삽입, `from !== to` 면 셀렉션 영역 대체 — 동일
     코드 경로로 자연스럽게 처리.
   - 작업들을 `from` 내림차순 + `to` 내림차순 (tiebreaker) 으로 정렬해 적용하면
     뒤따르는 위치들이 안 어긋남. 커서가 기존 매치의 경계 (`from` 또는 `to`) 와
     일치할 때도 정렬 안정성 덕에 새 참조가 자연스러운 쪽 (경계 바깥) 으로 배치됨.
   - 비숫자 라벨은 필터에 안 잡혀 그대로 보존.

5. **정의 단락 (+ 첫 각주면 `---`) 추가**:
   - `hasExisting = matches.some(m => m.isDefinitionMarker)` (변환 전 doc 기준).
   - 첫 각주면 `---` 단락 + 새 정의 단락 `[^N] ` 을 본문 끝에 추가.
   - 아니면 정의 단락만 추가.
   - `tr.insert(tr.doc.content.size, Fragment.fromArray(...))`.

6. **커서 이동**: `tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size - 1)))`
   — 새 정의 단락의 close 직전 (즉 `[^N] ` 의 공백 뒤). `tr.scrollIntoView()`.

**반환 타입**:

```ts
type InsertFootnoteResult =
  | { ok: true; tr: Transaction }
  | { ok: false; reason: 'in-title' | 'inside-existing-marker' };
```

extension 의 `addCommands()` 래퍼는 `ok === false` 면 reason 별 토스트만
띄우고 트랜잭션은 dispatch 하지 않음.

### C. 모바일 버튼 + 키보드 단축키

- `Toolbar.svelte` Alt-row 의 `→` 다음에 한 칸 추가:
  `<button class="key-btn" onclick={() => runAlt('footnote')} title="각주 (Alt+J)">J</button>`.
- `runAlt` 시그니처 확장: `'left' | 'right' | 'up' | 'down' | 'footnote'`.
  `'footnote'` 분기는 `editor.chain().focus().insertFootnote().run()`.
- `footnote/index.ts` 에 `addKeyboardShortcuts() { return { 'Alt-j': () => this.editor.commands.insertFootnote() }; }` 추가.
- 라벨 글자는 단축키 글자를 그대로 노출하는 기존 Ctrl-row 규약 (`D`, `S`, `M` 등) 과 일치.

## 엣지 케이스

| 케이스 | 동작 |
|---|---|
| 커서가 제목(0번 단락) | abort + 토스트 |
| 커서가 기존 `[^N]` 내부 | abort + 토스트 |
| 셀렉션 영역 | 셀렉션을 새 참조로 대체 |
| 빈 문서 (제목만) | 제목 뒤에 `---` + 정의 단락 |
| 같은 라벨 다중 참조 (`[^1]` 가 본문에 N번) | 같은 그룹 → 모두 같은 새 라벨로 치환 (공유 보존) |
| 비숫자 라벨 (`[^abc]`, `[^*]`) 혼재 | 비숫자 매치는 oldToNew 에 없어서 그대로 |
| 본문 중간 `---` (컬럼 분할 마커 등) | 무시. 끝에 새 `---` 별도 추가 |
| 기존 각주 정의가 이미 있음 | `hasExisting = true` → 새 `---` 안 만들고 정의 단락만 append |
| 고아 정의 (매칭 참조 없음) | 자기 그룹으로 번호 받음, 그대로 유지 |
| 고아 참조 (매칭 정의 없음) | 자기 그룹으로 번호 받음, 정의 자동 생성 안 됨 |
| Hard-break 으로 끊긴 마커 | 기존 모듈의 알려진 한계 (`footnotes.ts:11-13`) — 이 디자인의 범위 밖 |

## 비목표

- 정의 단락을 전용 노드 타입 / 리스트 구조로 만드는 것: 현 파서가 "top-level
  paragraph 의 첫 매치 = 정의 마커" 규칙에 의존하므로 그대로 단락으로 둠.
- 본문 편집 도중 자동 리넘버: 사용자가 라벨을 손으로 바꾸면 그 상태 유지,
  다음 Alt+J 호출 시점에 비로소 전체 재계산.
- 각주 라벨 prefix/suffix 커스터마이즈, 알파벳 / 로마자 라벨링.
- 본문 길이가 큰 노트에서의 리넘버 perf 최적화 (현 알고리즘은 매치 수 × log
  수준; 일반 노트 크기에서 무시 가능).

## 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/Toolbar.svelte` | (A) Alt-row / Alt-tog `{#if}` 블록 자리 교환. (C) Alt-row 끝에 `J` 버튼 추가, `runAlt` 시그니처 / 본문 확장. |
| `app/src/lib/editor/footnote/index.ts` | (B) `addCommands().insertFootnote`, `addKeyboardShortcuts()` 의 `Alt-j` 매핑. ok=false 분기에서 toast 호출. |
| `app/src/lib/editor/footnote/insertCommand.ts` | (B) **신규**. `buildInsertFootnoteTransaction(state): InsertFootnoteResult`. |
| `app/tests/unit/editor/footnote/insertCommand.test.ts` | (B) **신규**. 알고리즘 단위 테스트 (빈 문서, 중간 삽입, 공유 참조, 비숫자 보존, 제목 abort, 마커 안 abort, 셀렉션 대체, 커서 위치 검증). |

## 테스트

### 단위 (vitest)

`buildInsertFootnoteTransaction` 이 순수 함수라 EditorState 만 빌드해서
호출하고 `tr.doc.textContent` / `tr.selection.from` 을 검사. schema 는
기존 `TomboyEditor` 의 extension set 으로부터 `getSchema(...)` 로 생성 (안전).

테스트 케이스:

- 빈 문서 → 첫 각주는 `---` + 정의 단락 추가.
- 기존 각주 있으면 `---` 안 만들고 정의 단락만 append.
- 본문 중간 삽입 — 라벨 시퀀스 재계산 (커서가 `[^1]` 과 `[^2]` 사이면
  새 라벨이 `[^2]` 가 되고 기존 `[^2]` 가 `[^3]` 으로 밀림).
- 같은 라벨 다중 참조 — 한 그룹으로 묶여 함께 리넘버.
- 비숫자 라벨 (`[^abc]`) 보존.
- 커서가 제목 안 → `ok: false, reason: 'in-title'`.
- 커서가 기존 `[^N]` 안 → `ok: false, reason: 'inside-existing-marker'`.
- 셀렉션이 있으면 셀렉션을 새 참조로 대체.
- 셀렉션 위치 검증: `tr.selection.from === tr.doc.content.size - 1`.

### 수동 (모바일 + 데스크탑)

- **모바일**: dev 서버를 폰 브라우저로 → 노트 → Alt 잠금 → Alt-row 가
  `[Alt] [← ↑ ↓ → J]` 순서로 나오는지 (A 확인). `J` 탭 → 참조 즉시
  삽입, 본문이 끝으로 스크롤, 새 정의 단락에 키보드 자동 팝업, 커서가
  `[^N] ` 뒤에 위치.
- **데스크탑**: Alt+J → 동일 시나리오.
- **첫 vs N번째 각주**: 처음엔 `---` 자동 추가, 이후엔 정의 단락만 이어붙음.
- **리넘버 시각 확인**: `[^1]`, `[^2]` 두 개 있는 노트에서 그 사이에 커서
  두고 Alt+J → 본문이 `[^1] … [^2] … [^3]` 로 즉시 바뀜.
- **각주 클릭 → 정의 점프 회귀 없음**: 기존 `tomboy-fn-flash` 하이라이트 동작.

## 회귀 확인 포인트

- 기존 footnote 데코레이션 / 클릭 처리 (`plugin.ts`) 무변경.
- `noteContentArchiver` 영향 없음 — `[^N]` 은 평범한 텍스트로 라이브 문서와
  `.note` XML 모두에 남으며 아카이버는 footnote 모듈을 안 거침
  (`footnotes.ts:9-10` 주석 명시).
- `hrSplit` 무영향 — 새로 추가되는 `---` 단락은 일반 단락이며, 사용자가
  명시적으로 Ctrl/Cmd+클릭해서 컬럼 분할로 토글하기 전까지는 일반 HR 처럼
  동작. (참고: hrSplit 자체가 Firefox-only 이며 `about:config` 토글이
  필요한 실험 기능이므로 일반 사용자에겐 영향 없음.)
- 다른 Alt+ 단축키 (`Alt-←`, `Alt-→`, `Alt-↑`, `Alt-↓`) 와 충돌 없음 —
  `Alt-j` 는 글자 키라서 별개.
- macOS 의 `Option+J` (∆ 입력) 충돌: TipTap/PM 의 keymap 이 keydown 단계에서
  `true` 반환하면 default (∆ 입력) 가 suppress 되므로 안전.
