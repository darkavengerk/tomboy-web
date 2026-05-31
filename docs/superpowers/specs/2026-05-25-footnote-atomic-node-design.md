# 각주 마커 atomic 노드 전환 설계

**날짜**: 2026-05-25
**상태**: 설계 완료, plan 대기

## 배경

각주 마커 `[^N]` 은 현재 평문 텍스트 + ProseMirror 인라인 데코레이션으로 시각만 다르게 렌더한다 (`app/src/lib/editor/footnote/plugin.ts`). 이 데코레이션-only 방식은 캐럿이 마커 내부의 PM 위치들로 진입할 수 있어 다음 문제를 일으킨다:

- **캐럿 사라짐**: `[^1]` 의 4글자 사이 3개 PM 위치는 모두 0폭/0높이 영역 (font-size:0 브래킷, line-height:0 sup) 안 → 캐럿이 그려질 픽셀 없음. 사용자 입장에서 마커 통과 시 3 step 캐럿 invisible, 4 step 째 마커 우측에 나타남.
- **부분 삭제 잔해**: 사용자가 `[`, `^`, 라벨, `]` 중 하나만 지우면 `^1]`, `[^1`, `[1]` 등 깨진 잔해가 남음. 직전 작업으로 `cleanupPlugin.ts` 를 추가해 잔해를 자동 정리하지만, 본질적 해결은 아님.

유사한 데코레이션-only 한계는 다른 기능에도 존재 (URL 마크 + 이미지 표시 등). 이 작업은 footnote 를 첫 사례로 **atomic ProseMirror 노드** 패턴을 도입한다.

## 목표

- 캐럿이 마커 내부에 **진입할 수 없게** 만들어 캐럿 사라짐을 구조적으로 해결.
- 부분 삭제가 **불가능** 해지므로 `cleanupPlugin` 삭제.
- `.note` XML 파일 포맷 **변경 없음** — 라운드트립 보존.
- 사용자 기존 노트 **무중단 마이그레이션** — archiver 가 자동 변환.
- 다른 데코레이션-only 기능에도 재사용 가능한 패턴 확립.

## 비목표

- 새 시각 디자인 도입 (`¹` 위첨자 / `1 설명` 일반 크기 유지).
- 사용자가 `[^N]` 메타 텍스트를 의도적으로 쓰는 경우 escape 문법 도입 (필요시 후속).
- 다른 기능 (URL/이미지) 동시 전환 (패턴 검증 후 후속).
- Plain paste (Ctrl+Shift+V) 처리 (필요시 후속).

## 아키텍처

### 스키마

```ts
footnoteMarker: {
  group: 'inline',
  inline: true,
  atom: true,            // 캐럿 진입 차단 — 핵심
  selectable: true,
  attrs: { label: { default: '' } }
}
```

라벨만 저장하는 단일 노드. ref/def 구분은 위치 기반 (스키마에 kind 속성 없음).

### NodeView 위치 기반 렌더

`getPos()` 로 노드의 절대 위치를 얻어 부모 단락을 검사:

- 같은 단락의 **첫 비공백 인라인 자식** 이면 → `<span class="tomboy-fn-def">N</span>` (일반 크기, 정의 마커).
- 아니면 → `<sup class="tomboy-fn-ref">N</sup>` (위첨자, 참조 마커).
- 리스트 내부의 마커는 항상 ref (현재 동작과 동일).
- 제목 (top-level idx 0) 안의 마커는 항상 ref 로 렌더 (input rule 에서 차단되지만 import 경로로 들어올 수 있음).

`update(node)` 콜백에서 위치를 다시 검사 → 필요하면 DOM 갱신 (예: 단락 앞에 텍스트 삽입되어 def → ref 전환).

### 라운드트립 (Archiver)

파일 포맷은 변경 없음. 모든 노트는 여전히 `<note-content>본문 [^1] 끝</note-content>` 형태로 저장.

**읽기** (`appendInlineNodes` hook in `noteContentArchiver.ts`):
텍스트 노드 내용을 `[^N]` 정규식으로 split → `text` + `footnoteMarker { label: N }` 시퀀스. 마크는 split 의 좌우 텍스트에만 전달 — 마커 노드는 atomic 이라 마크 못 받음.

**쓰기** (`serializeInlineContent` hook):
`footnoteMarker` 노드를 만나면 `[^${label}]` 텍스트로 직렬화.

### 사용자 입력 → 노드 변환

- **Input rule**: `addInputRules` 에서 정규식 `/\[\^([^\]\s]+)\]$/` 매치 → replace with 마커 노드. 제목 단락에서는 차단.
- **Paste**: `editorProps.transformPasted` 에서 paste fragment 의 텍스트 노드를 동일 변환.
- **Alt+J 명령**: 기존 `insertCommand` 의 알고리즘 그대로, 텍스트 op 만 노드 op 로 변경.

## 데이터 흐름

| 진입 | 처리 |
|---|---|
| IDB 로드 / Dropbox pull / `.note` import | `deserializeContent()` → archiver hook 이 텍스트 노드 안의 `[^N]` 을 노드로 split |
| 사용자 타이핑 `[^1]` | input rule 매치 → `replaceWith(footnoteMarker)` |
| Paste | `transformPasted` → 동일 변환 적용 |
| Alt+J 명령 | `insertCommand` (노드 op 로 재작성) → 직접 노드 생성 |
| Firebase 실시간 동기화 pull | `applyIncomingRemoteNote` 가 결국 archiver 거치므로 동일 처리 |
| 저장 (모든 경로) | `serializeContent()` → 노드를 `[^N]` 텍스트로 직렬화 |

**경계 안전성**: archiver 한 곳이 외부 텍스트 ↔ 노드 변환의 단일 경계. IDB 직접 쓰는 경로 없음 (`noteManager` 도 archiver 사용). Input rule + transformPasted 는 에디터 내부 보호막.

## 동작 보존 & UX

| 액션 | 동작 |
|---|---|
| ← / → 화살표 | 마커 통째 한 번에 건너뜀 (캐럿 깜빡임 없음 — 목표 달성) |
| 마커 우측에서 Backspace | 첫 번째: 마커 통째 select. 두 번째: 삭제. PM 기본 동작. |
| 마커 영역 클릭 | 노드 select. 짝(ref↔def) 스크롤은 NodeView 의 클릭 핸들러에서 직접. |
| 마커 포함 selection 복사 | plain text: `[^N]`. HTML: NodeView 렌더 결과. |
| Shift+화살표 | atomic 이라 부분 선택 불가능. selection 경계는 마커 좌/우. |
| Alt+J 삽입 | 기존 알고리즘 (group renumber + def 단락 재정렬) 그대로, 노드 op 로. |

## 비전형 케이스

| 케이스 | 동작 |
|---|---|
| `<monospace>[^1]</monospace>` (마크 안 마커) | 마커 노드는 마크 못 받음. monospace 는 좌우 텍스트에만. 시각적으로 마커는 모노스페이스 아님. 호환성 의도된 손실. |
| `[^]`, `[^ x]` malformed | 정규식 매치 안 됨, 텍스트로 남음 (현재 동작과 동일). |
| 사용자가 `[^N]` 메타 텍스트 의도 | input rule 이 노드화. 회피 불가 — Q1 답이 옵션 B. 필요시 escape 문법 후속. |
| 비ASCII 라벨 (`[^참고1]`, `[^abc]`) | 매치됨, label='참고1' 노드 생성, 렌더 OK. |
| 제목에 마커 import | 노드로 변환은 됨. 렌더만 됨. input rule 은 제목에서 차단 — 새로 생성 안 됨. |
| Undo/redo | 노드 삽입/삭제가 한 step → undo 한 번에 통째 복원. 더 직관적. |

## 알려진 라운드트립 차이 (의도)

마크가 마커를 가로지르는 경우 직렬화 결과가 split 됨:

- **이전**: `<bold>전 [^1] 후</bold>` (한 bold 마크).
- **이후**: `<bold>전 </bold>` + 마커 + `<bold> 후</bold>` (두 bold 마크).

시각/의미 동일, XML diff 만 발생. 라운드트립 자체는 깨지지 않음 (재로드 시 동일 doc 복원). 사용자가 raw XML 비교할 때만 보이는 차이로, 호환성 수용.

## 영향 받는 파일

### 신규
- `app/src/lib/editor/footnote/node.ts` — Node Extension (스키마 + NodeView + input rule + paste hook). ~150 LOC.

### 재작성
- `app/src/lib/editor/footnote/footnotes.ts` — 정규식 → 노드 walk. API 시그니처 유지. ~50 LOC.
- `app/src/lib/editor/footnote/insertCommand.ts` — 텍스트 op → 노드 op. 알고리즘 유지. ~100 LOC.
- `app/src/lib/editor/footnote/plugin.ts` — 데코레이션 빌더 삭제, 클릭 핸들러만 유지. ~50 LOC.
- `app/src/lib/editor/footnote/index.ts` — extension 등록 재구성.
- `app/src/lib/core/noteContentArchiver.ts` — 두 hook 추가 (각 ~30 LOC).

### 삭제
- `app/src/lib/editor/footnote/cleanupPlugin.ts` — atomic 노드는 부분 삭제 불가, 불필요.
- `app/tests/unit/editor/footnote/cleanupPlugin.test.ts`

### 영향 검토 & 보강
- `app/src/lib/editor/TomboyEditor.svelte` — `.tomboy-fn-bracket` CSS 규칙 삭제 (브래킷 DOM 없음).
- `app/src/lib/core/noteContentArchiver.ts` 의 `getPlainText()` — 노드 → `[^N]` 텍스트.
- `app/src/lib/schedule/parseSchedule.ts` 의 `linearizeDoc()` — 노드 평탄화.
- `app/src/lib/editor/copyFormatted.ts` — 4가지 직렬화에 마커 처리 (plain → `[^N]`, structured → `[^N]`, HTML → `<sup>N</sup>`, Markdown → `[^N]`).
- `app/src/lib/search/noteSearch.ts` — xmlContent 기반이라 대부분 OK, doc 기반 경로 있으면 노드 처리.

## 테스트 전략

### 재작성 (기존)
- `footnotes.test.ts` (14개): 텍스트 doc → 노드 직접 삽입, 어설션을 노드 attrs 기반으로.
- `insertCommand.test.ts` (13개): `paragraphTexts()` 헬퍼를 `getPlainText` 기반으로 (`[^N]` 형태 출력).
- `extensionCommand.test.ts` (3개): 토스트 동작 그대로.

### 신규: `node.test.ts` (~15개)
- 스키마 정의 (group/inline/atom).
- NodeView 렌더 — 첫 inline이면 def, 아니면 ref.
- 위치 변경 시 update() — def↔ref 전환.
- Input rule — 본문 매치, 제목 차단.
- `transformPasted` — paste 변환.
- 화살표 통째 건너뜀.
- Backspace 통째 삭제.
- 비숫자 라벨.

### 신규: `archiverFootnote.test.ts` (~12개)
- 양방향 round-trip 본문 케이스.
- 정의 단락 변환.
- 비숫자/한글/긴 라벨.
- 마크 가로지름 (split 결과 확인).
- malformed 보존.
- `<monospace>[^N]</monospace>` 마크 손실.

### 기존 통합 테스트 보강
- `noteContentArchiver.test.ts` — 마커 섞인 round-trip 1~2개.
- `copyFormatted.test.ts` — 4 직렬화에 마커 케이스 각 1개.

### 삭제
- `cleanupPlugin.test.ts` (11개).

## 작업량 추정

| 항목 | LOC | 비고 |
|---|---|---|
| 신규 코드 (node.ts + archiver hooks) | ~250 | |
| 재작성 코드 | ~250 | 기존 ~450 LOC 의 정리 |
| 신규 테스트 (node + archiver) | ~400 | |
| 기존 테스트 재작성 | ~350 | 어설션 형태 변경 |
| 삭제 (cleanupPlugin + test) | -290 | |
| **순증** | **~+960 LOC** | |

예상 시간: 1.5~2일 (TDD + 검토 포함).

## 결정 사항 요약

| # | 질문 | 답 |
|---|---|---|
| 1 | `[^N]` 텍스트 → 노드 변환 경계 | Archiver + paste + input rule (모든 진입점에서 즉시 노드화) |
| 2 | ref/def 구분 방법 | 단일 노드 + NodeView 위치 기반 렌더 (kind attr 없음) |

## 후속 검토 / 별도 작업

- 같은 패턴 (atomic 노드 + archiver 라운드트립) 으로 URL+이미지 케이스 전환.
- `[^N]` escape 문법 (메타 텍스트 사용자 지원, 필요시).
- Plain paste (Ctrl+Shift+V) 처리.
