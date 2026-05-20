# 각주 + 인용 기능 설계 (Footnote + Blockquote)

- **날짜:** 2026-05-20
- **상태:** 승인됨 (브레인스토밍 완료)
- **대상:** Tomboy Web 노트 에디터 (`app/src/lib/editor/`)

## 1. 개요

노트 에디터에 두 개의 독립적인 마커 기반 기능을 추가한다.

1. **각주(footnote)** — 본문에 `[^7]` 형태로 넣으면 작은 위첨자 숫자로
   표시되고, 클릭하면 같은 라벨의 설명 단락으로 스크롤한다. 설명 단락은
   사용자가 직접 작성하며 `[^7]` 로 시작한다.
2. **인용(blockquote)** — 단락이 `> ` 로 시작하면 왼쪽 테두리 + 들여쓰기로
   인용처럼 표시된다. `>` 단락이 연속되면 한 인용 블록으로 보인다.

두 기능 모두 **순수 표시 계층(decoration-only)** 으로 구현한다. 마커
텍스트(`[^7]`, `> `)는 라이브 ProseMirror 문서와 `.note` XML 양쪽에
평범한 텍스트로 그대로 남고, ProseMirror 플러그인이 화면에만 각주/인용으로
그린다. **아카이버(`noteContentArchiver.ts`)와 스키마는 전혀 건드리지
않는다.**

### 1.1 왜 decoration 방식인가

체크박스 기능은 클릭 대상 위젯이 필요해 아카이버 합성(마커를 XML에만 두고
라이브 문서에서는 스키마 속성으로 변환)을 택했다. 각주·인용은 표시만
바꾸면 되므로 합성이 불필요하다. decoration 방식의 이점:

- 라운드트립 핵심 파일인 아카이버를 안 건드림 → `.note` XML 라운드트립이
  자동으로 byte-stable (마커가 그냥 텍스트라서).
- 스키마 변경 없음 → 복사/붙여넣기, 자동링크 등과 충돌 없음.
- 코드베이스의 `---` → 가로줄(hrSplit)이 이미 쓰는 패턴과 동일한 계열.

**트레이드오프(알려진 한계):** 숨겨진 마커가 커서 위치를 차지한다. 마커
안쪽을 잘못 편집하면(예: 인용 줄 맨 앞에 글자 삽입) 표시가 깨질 수 있다.
단, 화면에 즉시 보이고 마커를 고치면 복구된다. 이 트레이드오프는 사용자가
명시적으로 수용했다.

## 2. 각주 (footnote)

### 2.1 마커 형식

`[^<label>]` — `<label>` 은 `]` 와 공백이 아닌 문자 1자 이상.

- 탐색 정규식: `/\[\^([^\]\s]+)\]/g`
- 잘못된 형태(`[^]`, 닫는 `]` 없음, `[^ ]`)는 매치되지 않고 평범한
  텍스트로 남는다.
- 라벨은 사용자가 정하는 임의 토큰이다. 자동 번호 매김·재번호 없음.
  예시 입력의 `[^7]`, `[^8]` 처럼 큰 문서의 일부 번호를 그대로 쓸 수 있다.

### 2.2 두 가지 역할

`[^N]` 매치는 역할에 따라 다르게 표시된다 — 참조는 작은 위첨자 숫자,
설명 마커는 일반 크기 숫자. 역할은 표시 크기와 클릭 시 짝(스크롤 대상)
결정에 쓰인다.

- **참조(reference)** — 단락 중간 어디든 나오는 `[^N]`.
- **설명 마커(definition marker)** — **최상위 단락**의 맨 앞(선행 공백
  무시)에 오는 `[^N]`. 사용자가 직접 작성하는 설명 단락의 첫머리.

판정 규칙: 어떤 `[^N]` 매치의 시작 위치가, 그것을 담은 최상위 단락의 텍스트
내용에서 (선행 공백을 제외하고) 맨 앞이면 설명 마커, 아니면 참조다.
리스트 항목 안의 `[^N]` 은 항상 참조로 본다(설명 마커는 최상위 단락
한정). 제목(0번 단락)의 `[^N]` 은 장식·탐색 대상에서 제외한다.

### 2.3 렌더링

각 `[^N]` 매치(4자 이상: `[`, `^`, 라벨, `]`)에 대해 인라인 데코레이션을
부착한다.

- `[^` 2자 → 클래스 `tomboy-fn-bracket` (CSS로 폭 0으로 접음)
- 라벨 부분 — 역할에 따라 다르게:
  - **참조** → `Decoration.inline(..., { nodeName: 'sup', class:
    'tomboy-fn-ref' })` → `<sup class="tomboy-fn-ref">7</sup>` (작은 위첨자)
  - **설명 마커** → `Decoration.inline(..., { class: 'tomboy-fn-def' })`
    → `<span class="tomboy-fn-def">7</span>` (일반 크기·기준선)
- 닫는 `]` 1자 → 클래스 `tomboy-fn-bracket`

화면 결과: 본문 참조는 캡쳐 이미지의 `진술하였다:⁷`, `나섰지요.⁸` 처럼
작은 위첨자 숫자로 보인다. 설명 단락의 맨 앞 `[^N]` 은 일반 크기 숫자로
보인다 — 작은 위첨자면 설명 문장의 시작이 어색하기 때문이다.

### 2.4 클릭 → 스크롤

플러그인은 매 doc 변경 시 모든 `[^N]` 매치 범위를 플러그인 상태에 보관한다.
`editorProps.handleClick(view, pos, event)` 에서 클릭 위치 `pos` 가 어느
매치 범위 안인지 판정한다.

- **참조 클릭** → 같은 라벨의, **자신보다 뒤에 오는 첫 설명 마커**로 스크롤.
- **설명 마커 클릭** → 같은 라벨의, **자신보다 앞에 오는 마지막 참조**로
  스크롤.
- 한 노트에 여러 문서가 있어 각주 라벨이 겹칠 수 있다. 문서끼리
  인터리브하지 않는다고 가정하고 설명은 각 문서 끝에 모이므로, 위치
  기준으로 가장 가까운 짝을 고르면 라벨이 겹쳐도 올바른 문서끼리 연결된다.
- 스크롤은 대상 매치 시작 위치의 DOM 노드를 `view.domAtPos` 로 찾아
  `scrollIntoView({ behavior: 'smooth', block: 'center' })`. 노트 라우트와
  `/desktop` 윈도우 모두 가장 가까운 스크롤 조상에서 동작한다.
- 도착한 대상에 약 1.2초 하이라이트 깜빡임(임시 CSS 클래스 부착 후
  `setTimeout` 으로 제거).
- 짝을 찾지 못하면 `onMissing(label, kind)` 콜백 호출. `TomboyEditor` 가
  토스트로 연결한다. 메시지: 참조 클릭인데 설명이 없으면
  `각주 ‘7’ 설명을 찾을 수 없습니다`, 설명 마커 클릭인데 참조가 없으면
  `각주 ‘7’ 참조를 찾을 수 없습니다`.

### 2.5 모듈 구조

```
app/src/lib/editor/footnote/
├── footnotes.ts   # 순수 함수: 매치 탐색, 역할 분류, 짝 찾기
├── plugin.ts      # PM 플러그인: 데코레이션 빌드 + handleClick
└── index.ts       # TomboyFootnote 확장 + re-export
```

`footnotes.ts` 가 제공하는 순수 함수(제안 API):

- `findFootnoteMatches(doc)` → 모든 `[^N]` 매치 `{ from, to, label,
  isDefinitionMarker }[]`. 제목(0번 단락) 제외.
- `findFootnotePartner(matches, clickedMatch)` → 짝 매치 또는 `null`.

`TomboyFootnote` 는 `Extension.create` 로, 옵션 `onMissing` 을 받아
플러그인에 전달한다(체크리스트 `onToggle` 패턴과 동일).

## 3. 인용 (blockquote)

### 3.1 마커

**최상위 단락**의 텍스트 내용이 `> `(꺾쇠 + 공백 1개)로 시작하면 인용
단락이다.

- 판정: `/^> /` 를 단락의 `textContent` 에 적용.
- 제목(0번 단락)은 제외.
- 리스트 항목 안의 단락은 대상이 아니다(인용은 최상위 단락 한정).

### 3.2 렌더링

각 인용 단락에 대해 —

- `Decoration.node(paraStart, paraEnd, { class: 'tomboy-quote' })` →
  `<p>` 에 왼쪽 테두리 + 왼쪽 패딩/들여쓰기 + 살짝 흐린 글자색.
- `Decoration.inline(textStart, textStart + 2, { class:
  'tomboy-quote-marker' })` → 맨 앞 `> ` 2자를 CSS로 폭 0으로 숨김.

### 3.3 연속 인용

연속된 `>` 단락은 별도 자료구조 없이 CSS 인접 형제 선택자로 처리한다.

```css
.tomboy-quote + .tomboy-quote { margin-top: 0.2em; }
```

(정확한 값은 구현 시 캡쳐 이미지에 맞춰 미세 조정.)

이로써 연속 인용 단락들의 왼쪽 테두리가 거의 이어진 한 덩어리로 보이고
줄 사이엔 작은 간격만 남는다 — "다음 줄도 `>` 로 시작하면 계속 이어서
하나의 인용으로, 줄바꿈 처리에 약간의 간격" 이라는 요구와 일치한다.

### 3.4 동작 / 편집 UX

- 단락 앞에 `> ` 를 입력하면 다음 doc 변경 때 플러그인이 자동 감지해
  인용으로 표시한다. **입력 규칙·명령·단축키 없음.**
- Enter 는 `> ` 없는 새 단락을 만들어 자연히 인용이 끝난다. 이어가려면
  새 단락에 `> ` 를 다시 입력하면 연속 인용으로 합쳐 보인다.
- 인용 해제: 줄 맨 앞에서 Backspace. 첫 Backspace 로 공백이 지워지면
  `> ` 가 더 이상 매치되지 않아 인용이 풀리고 숨겨졌던 `>` 가 다시 보인다.
  한 번 더 누르면 `>` 까지 지워진다.

### 3.5 모듈 구조

```
app/src/lib/editor/blockquote/
├── blockquote.ts  # 순수 함수: 인용 단락 탐색
├── plugin.ts      # PM 플러그인: 노드 데코 + 마커 숨김 데코
└── index.ts       # TomboyBlockquote 확장 + re-export
```

`blockquote.ts` 가 제공하는 순수 함수(제안 API):

- `isQuotedParagraphText(text)` → `/^> /` 판정.
- `findQuotedParagraphs(doc)` → 인용 최상위 단락들의
  `{ paraPos, paraNode, textStart }[]`. 제목(0번) 제외.

`TomboyBlockquote` 는 `Extension.create` 로 옵션 없이 플러그인만 등록한다.

## 4. 라운드트립 / `.note` XML

`[^7]` 와 `> ` 는 라이브 문서와 `.note` XML 양쪽에 평범한 텍스트로 그대로
존재한다. 아카이버는 이 마커를 일반 텍스트로만 본다.

- **아카이버 변경 없음** — `noteContentArchiver.ts` 미수정.
- **스키마 변경 없음** — 새 노드/마크/속성 없음.
- Tomboy 데스크톱과 byte-stable 라운드트립이 자동으로 성립한다.
- 복사/붙여넣기(`copyFormatted.ts`), 자동링크도 마커를 일반 텍스트로
  처리하므로 영향이 없다.

## 5. 에디터 연결

`app/src/lib/editor/TomboyEditor.svelte`:

- 확장 배열(`TomboyChecklist` 부근)에 `TomboyFootnote.configure({
  onMissing })` 와 `TomboyBlockquote` 를 등록.
- `onMissing` → `lib/stores/toast.ts` 의 토스트 호출.
- CSS 추가:
  - `.tomboy-fn-ref` — 위첨자 작은 숫자, 클릭 가능 커서.
  - `.tomboy-fn-bracket` — 폭 0(브래킷 숨김).
  - `.tomboy-quote` — 왼쪽 테두리 + 왼쪽 패딩/들여쓰기 + 흐린 색.
  - `.tomboy-quote-marker` — 폭 0(`> ` 숨김).
  - `.tomboy-quote + .tomboy-quote` — 연속 인용 위 여백 축소.
  - 스크롤 도착 하이라이트용 임시 클래스.

모바일 라우트(`note/[id]/+page.svelte`)와 `/desktop`(`NoteWindow.svelte`)
모두 같은 `TomboyEditor` 를 쓰므로 동작·외형이 동일하다.

## 6. 테스트

`app/tests/unit/editor/` 아래:

- `footnotes.test.ts` — 매치 탐색(잘못된 형태 무시, 제목 제외), 참조 vs
  설명마커 분류, 짝 찾기(라벨 일치, 다중 매치 시 첫 번째, 짝 없음).
- `footnotePlugin.test.ts` — 인용 단락/참조에 올바른 데코레이션 생성,
  클릭 위치 → 스크롤 대상 해석.
- `blockquote.test.ts` — 인용 단락 감지(`> ` 필수, 제목 제외, 리스트 내부
  제외).
- `blockquotePlugin.test.ts` — 인용 단락에 노드 데코 + 마커 숨김 데코,
  비인용 단락은 미장식.

스크롤 자체(DOM 동작)는 단위 테스트가 어려우므로 짝-해석 로직만 순수
함수로 검증한다. 실제 스크롤·하이라이트는 수동 확인.

## 7. 범위에서 제외 (YAGNI)

- 각주 자동 번호 매김 / 재번호
- 각주 설명 단락 자동 생성 (사용자가 직접 작성 — Markdown 방식)
- 중첩 인용(`>>`)
- 인용을 단일 구조 노드(blockquote 노드)로 만들기
- 각주 호버 미리보기 / 팝오버
- `## 제목` 같은 Markdown 헤딩 (예시 텍스트의 `##` 는 부수적이며 무관)
- 키보드 단축키 (`> ` / `[^N]` 직접 입력이 트리거)

## 8. 알려진 한계

decoration 방식의 트레이드오프: 숨겨진 마커(`[^`, `]`, `> `)가 ProseMirror
문서에서 커서 위치를 차지한다. 마커 안쪽을 잘못 편집하면 표시가 깨질 수
있으나, 화면에 즉시 보이고 마커를 고치면 복구된다. 사용자가 이 한계를
명시적으로 수용하고 Option A 를 선택했다.
