# Inline Radio Atomic Node — Design Spec

## Goal

노트 본문 어디에서든 `( )` 를 입력하면 클릭으로 토글 가능한 라디오
버튼으로 변환되는 inline atomic ProseMirror 노드 `inlineRadio` 를
도입한다. 같은 텍스트 블록 (paragraph / list-item 본체) 안의 다른
라디오와 자동으로 연동되어, 하나를 선택하면 같은 블록의 다른 라디오는
자동 해제된다. 토글 상태는 `( )` (해제) / `(o)` (선택) 텍스트로
라운드트립되어 `.note` XML 호환성과 Tomboy desktop 상호운용을 모두
보존한다.

## Why

`inlineCheckbox` 와 같은 atomic 노드 패턴을 라디오 그룹 UX 에 적용한
다. 체크박스와의 차이는 단 두 가지:

1. **그룹 동작** — 같은 텍스트 블록 안의 다른 `inlineRadio` 와 상호
   배타적으로 동작 (하나 선택 시 나머지 해제)
2. **외관** — 원형 표시

나머지 (atomic 노드, paste 변환, 입력 규칙, 라운드트립, 제목 가드,
mark 차단) 는 체크박스 패턴 그대로 미러링한다.

그룹 ID 같은 별도 식별자는 두지 않는다. ProseMirror 의 자연 구조
(`$pos.parent` = 텍스트 블록) 가 그룹 경계와 일치한다 — list item
본체와 nested item 의 paragraph 는 서로 다른 parent 이므로 자동으로
별개 그룹이 된다.

## Model

### 노드 정의 (`app/src/lib/editor/inlineRadio/node.ts`)

```ts
const InlineRadio = Node.create({
  name: 'inlineRadio',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '',
  addAttributes() {
    return {
      selected: { default: false }
    };
  },
  // parseHTML / renderHTML / addInputRules / addProseMirrorPlugins /
  // addNodeView — 아래 절에서 상세
});
```

### 입력 규칙

```
/\(([ oO])\)$/
```

매칭 시 텍스트를 `inlineRadio` 노드로 치환. `o` / `O` 둘 다 selected
로 인정 (`inlineCheckbox` 의 `[ ]` / `[x]` / `[X]` 와 일관).

### Paste 변환

`createPasteTransformPlugin` 미러링. 정규식 `/\(([ oO])\)/g` 로
텍스트 안의 패턴을 모두 노드로 치환.

### 제목 가드

체크박스와 동일하게 top-level idx 0 (제목) 에서는 입력 규칙과 paste
변환 모두 차단.

## 그룹 동작 (NodeView 클릭 핸들러)

```ts
dom.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const pos = getPosFn();
  if (pos == null) return;
  const current = view.state.doc.nodeAt(pos);
  if (!current || current.type.name !== 'inlineRadio') return;

  const $pos = view.state.doc.resolve(pos);
  const parent = $pos.parent;             // textblock
  const parentStart = $pos.start();       // textblock 내용 시작 pos
  const wasSelected = current.attrs.selected;
  const tr = view.state.tr;

  if (wasSelected) {
    // toggle off — 자기만 해제
    tr.setNodeAttribute(pos, 'selected', false);
  } else {
    // 자기 선택 + 같은 textblock 안의 다른 inlineRadio 해제
    parent.forEach((child, offset) => {
      if (child.type.name !== 'inlineRadio') return;
      const childPos = parentStart + offset;
      if (childPos === pos) {
        tr.setNodeAttribute(childPos, 'selected', true);
      } else if (child.attrs.selected) {
        tr.setNodeAttribute(childPos, 'selected', false);
      }
    });
  }
  view.dispatch(tr);
});
```

**그룹 경계 = `$pos.parent` (텍스트 블록).** ProseMirror 모델에서
list item 의 본체는 그 안의 paragraph 이고 nested item 의 paragraph
는 서로 다른 parent 이므로 별개 그룹이 된다. 별도 그룹 ID 불필요.

**Toggle off 허용** — 선택된 라디오를 다시 클릭하면 해제되어 "아무것도
선택 안 됨" 상태로 돌아간다. 체크박스 UX 와 일관.

**체크박스와 공존** — 같은 텍스트 블록 안에 라디오와 체크박스가
섞여 있어도 타입이 다르므로 서로 영향 없음.

## 라운드트립 (`noteContentArchiver.ts`)

체크박스가 처리되는 모든 지점에 라디오 처리를 미러링한다.

### 파싱 (텍스트 → 노드)

`splitInlineCheckboxesInText` (line 99–) 와 짝이 되는
`splitInlineRadiosInText` 추가. 정규식 `/\(([ oO])\)/g`. `selected`
attr 으로 노드 생성. `inline` 텍스트 분할 호출지점 (line 432 부근)
에서 체크박스 split 후 라디오 split 도 실행 (순서 무관, 두 패턴이
겹치지 않음).

### 직렬화 (노드 → 텍스트)

라인 280–283, 785–788, 976–977 의 `inlineCheckbox` emit 케이스
3 곳에 라디오 분기를 추가:

```ts
} else if (inline.type === 'inlineRadio') {
  // 모든 mark 닫고 (o)/( ) emit
  closeAllOpenMarks();
  result += inline.attrs?.selected ? '(o)' : '( )';
}
```

### 체크리스트 prefix 마커 (line 858) 는 변경 없음

라인 858 의 `[X] ` / `[ ] ` prefix 는 영역 기반 `TomboyChecklist`
의 list-item attribute 직렬화이며 inline 노드가 아니다. 라디오는
inline 만이므로 영향 없음.

## CSS (`TomboyEditor.svelte`)

`.tomboy-inline-checkbox` CSS 옆에 `.tomboy-inline-radio` 추가.
체크박스와 동일한 크기/패딩, `border-radius: 50%` 로 원형. selected
상태는 내부 dot (after pseudo) 로 표현.

## NodeView 외관

```ts
dom.className = 'tomboy-inline-radio';
dom.setAttribute('data-selected', node.attrs.selected ? 'true' : 'false');
dom.contentEditable = 'false';
```

`parseHTML` / `renderHTML` 도 `span.tomboy-inline-radio` +
`data-selected` 속성으로 통일.

## 등록 (`TomboyEditor.svelte`)

```ts
// line 94 부근
import { TomboyInlineRadio } from './inlineRadio';
// line 527 부근, extensions 배열에:
...TomboyInlineRadio,
```

## 파일 구조

```
app/src/lib/editor/inlineRadio/
├── index.ts        # export { InlineRadio }; export const TomboyInlineRadio = [InlineRadio];
└── node.ts         # Node.create({...}) + paste plugin + nodeView
```

## 테스트 (`app/tests/unit/editor/inlineRadio/`)

체크박스 테스트 (`app/tests/unit/editor/inlineCheckbox/`) 가 있다면
미러링. 없다면 다음 케이스를 신규 작성:

1. **입력 규칙** — `( )` / `(o)` / `(O)` 타이핑 → `inlineRadio` 노드
   변환, `selected` 속성 정확. 제목에서는 변환되지 않음.
2. **Paste 변환** — `"답: ( ) A (o) B"` 붙여넣기 → 텍스트 + 노드 2 개
   로 분할. 제목 영역 paste 는 변환 skip.
3. **라운드트립** — editor JSON → `noteContentArchiver` 직렬화 → 다시
   파싱 → JSON 동일. `<note-content>` XML 안에 `( )` / `(o)` 텍스트로
   저장 확인.
4. **그룹 동작 — 같은 paragraph**
   - 라디오 A, B 둘 다 미선택 상태에서 B 클릭 → B selected, A 미선택
     유지.
   - B selected 상태에서 A 클릭 → A selected, B 자동 해제.
   - A selected 상태에서 A 재클릭 → A 해제, 둘 다 미선택.
5. **그룹 동작 — list-item 분리** — list item 본체에 A (selected), B
   가 있고 nested item 에 C, D 가 있을 때, C 를 selected 로 만들어도
   A 는 그대로 selected. 반대 방향도 동일.
6. **체크박스 공존** — 같은 paragraph 안에 체크박스 `[x]` 와 라디오
   `( )` 가 섞여 있을 때 라디오 클릭이 체크박스에 영향 없음.

## 비-목표 (Non-goals)

- **그룹 이름 / ID 지정 기능** — `$pos.parent` 기반 자동 그룹으로 충분.
- **DOM wrap (e.g. `<fieldset>`) 으로 그룹 표시** — 시각적 표시는
  사용자의 의도된 배치 (같은 줄에 놓는 행위) 자체가 함.
- **시각적 wrap line 단위 그룹** — 폰트/창 너비 변경에 따라 그룹이
  바뀌어 예측 불가능.
- **키보드 단축키** — 1차 범위 외. 필요 시 후속 작업.
- **`TomboyChecklist` 영역 안에서의 라디오 list-item** — 라디오는
  inline 만. 체크리스트는 list-item attribute 기반 별개 기능.
