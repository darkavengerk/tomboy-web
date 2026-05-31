# Inline Checkbox Atomic Node — Design Spec

## Goal

노트 본문 어디에서든 `[ ]` 를 입력하면 클릭으로 토글 가능한 체크박스
로 변환되는 inline atomic ProseMirror 노드 `inlineCheckbox` 를 도입한
다. 토글 상태는 `[ ]` (해제) / `[x]` (체크) 텍스트로 라운드트립되어
`.note` XML 호환성과 Tomboy desktop 상호운용을 모두 보존한다.

## Why

각주 마커 (`footnoteMarker`) 전환에서 검증된 atomic 노드 패턴을 두 번
째 인-라인 컨트롤에 재적용한다. 각주처럼 토글 가능한 UI 요소는 데코레
이션-기반 구현일 때 (1) 캐럿이 내부에 침투하여 의도치 않은 부분 편집,
(2) 잔해 텍스트 누적, (3) 클릭 핸들러와 PM transaction 의 동기화 복잡
도 — 세 가지 문제를 동반한다. atomic 노드는 세 문제를 모두 구조적으
로 차단한다.

기존 `TomboyChecklist` 와는 의도와 모델이 다르다. `TomboyChecklist`
는 "체크리스트:" 헤더 + bulletList 영역의 `listItem.attrs.checked` 를
관리하는 **영역 기반** 모델이다. 본 기능은 inline 어디에서든 짧은
todo 체크가 필요할 때 쓰는 **인-라인 컨트롤**이며, 두 기능은 같은 노트
에서 공존할 수 있다.

## Model

### 노드 정의 (`app/src/lib/editor/inlineCheckbox/node.ts`)

```ts
const InlineCheckbox = Node.create({
  name: 'inlineCheckbox',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '', // 어떤 mark 도 적용되지 않음
  addAttributes() {
    return {
      checked: { default: false }
    };
  },
  parseHTML() {
    return [{
      tag: 'span.tomboy-inline-checkbox',
      getAttrs: (el) => ({
        checked: (el as HTMLElement).getAttribute('data-checked') === 'true'
      })
    }];
  },
  renderHTML({ node }) {
    return ['span', {
      class: 'tomboy-inline-checkbox',
      'data-checked': node.attrs.checked ? 'true' : 'false'
    }];
  }
});
```

- `nodeSize === 1` (atomic). 캐럿 진입 / 부분 삭제 모두 차단.
- `marks: ''` — bold / italic / monospace / link 등 어떤 mark 도 받지
  않는다. 시각 일관성 + 라운드트립 단순성.

### Input rule

```ts
addInputRules() {
  return [
    new InputRule({
      find: /\[([ xX])\]$/,
      handler: ({ state, range, match }) => {
        const $from = state.doc.resolve(range.from);
        // 제목 (top-level idx 0) 차단 — 각주와 동일.
        if ($from.index(0) === 0) return null;
        const checked = match[1] === 'x' || match[1] === 'X';
        state.tr.replaceWith(range.from, range.to, type.create({ checked }));
      }
    })
  ];
}
```

- 대문자 `[X]` 도 입력 시 받지만 저장은 항상 `[x]`.
- 제목 (`$from.index(0) === 0`) 에서는 변환 안 함 (각주 패턴).

### Paste 변환

```ts
// transformPasted: fragment 안의 텍스트에서 \[([ xX])\] 패턴 split
// → inlineCheckbox 노드 삽입. 좌우 텍스트의 마크는 보존.
```

- 외부에서 `[ ]` / `[x]` 가 든 텍스트를 paste 하면 노드로 변환.
- destination 이 제목 라인일 때는 변환 skip — `view.state.selection.
  $from.index(0) === 0` 체크 후 원본 slice 반환.

### NodeView — 클릭 토글

```ts
addNodeView() {
  return ({ node, getPos, editor }) => {
    const dom = document.createElement('span');
    dom.className = 'tomboy-inline-checkbox';
    dom.setAttribute('data-checked', String(node.attrs.checked));
    dom.contentEditable = 'false'; // PM 가 자동이지만 명시.
    dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos == null) return;
      const next = !editor.view.state.doc.nodeAt(pos)?.attrs.checked;
      editor.view.dispatch(
        editor.view.state.tr.setNodeAttribute(pos, 'checked', next)
      );
    });
    return {
      dom,
      update(updatedNode) {
        if (updatedNode.type.name !== 'inlineCheckbox') return false;
        dom.setAttribute('data-checked', String(updatedNode.attrs.checked));
        return true;
      }
    };
  };
}
```

- `mousedown` + `preventDefault` 로 selection 이동을 차단하면서 토글.
  클릭 후 캐럿이 노드 옆으로 점프하지 않도록.
- 키보드 단축키 없음. NodeSelection + Space 같은 컨벤션은 지원하지
  않는다.

## Round-trip (`.note` XML)

`noteContentArchiver.ts` 에서 inline atomic 노드를 `[ ]` / `[x]`
텍스트로 직렬화 / 역직렬화. 각주의 `[^N]` 패턴 그대로 미러.

### 쓰기 (노드 → XML 텍스트)

`serializeInlineContent` / 최상위 직렬화 루프에 분기 추가:

```ts
if (child.type === 'inlineCheckbox') {
  appendTextWithNewlines(child.attrs.checked ? '[x]' : '[ ]', currentMarks);
  continue;
}
```

마크는 인접 텍스트로부터 분리. atomic 노드 자체는 mark 를 못 받지만,
직렬화 시 좌우 텍스트의 mark 흐름은 유지된다 (각주와 동일 처리).

### 읽기 (XML 텍스트 → 노드)

`appendInlineNodes` / `splitInlineCheckboxesInText` 헬퍼:

```ts
const RE = /\[([ xX])\]/g;
function splitInlineCheckboxesInText(text, marks): JSONContent[] {
  // text 를 \[([ xX])\] 로 split, 각 매치마다 inlineCheckbox 노드 emit,
  // 좌우 텍스트는 marks 부여하여 emit.
}
```

- 기존 `[ ]` / `[x]` 텍스트가 든 노트는 다음 열림 때 자동으로 노드화
  (별도 마이그레이션 불필요).
- mark-crossing 케이스: `<bold>중요 [ ] 작업</bold>` 같은 마크 안의
  체크박스도 split → mark 가 좌우 두 텍스트 조각으로 나뉘면서 노드가
  중간에 들어감 (각주와 동일한 의도된 split semantics).

### `getPlainText` (in archiver)

각주처럼 마커 노드를 `[ ]` / `[x]` 로 반환.

## Copy formatting (`copyFormatted.ts`)

- **plainText**: `[ ]` / `[x]`
- **structuredText**: `[ ]` / `[x]`
- **markdown**: `[ ]` / `[x]` (GFM task list 호환)
- **html**: `<input type="checkbox" disabled>` 또는 `<input type="checkbox" checked disabled>` — 외부 에디터 / 메일 클라이언트로 paste 시 시각 보존

`getTextNodes` 워커에 분기 추가, 4개 serializer 각자 분기.

## Visual

```css
.tomboy-inline-checkbox {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border, #888);
  border-radius: 2px;
  vertical-align: -2px; /* baseline 정렬 */
  margin: 0 2px;
  cursor: pointer;
  background: transparent;
  user-select: none;
}

.tomboy-inline-checkbox[data-checked='true'] {
  background: var(--accent, #555);
  border-color: var(--accent, #555);
  background-image: url("data:image/svg+xml;utf8,<svg ...>"); /* white check */
  background-size: 10px 10px;
  background-position: center;
  background-repeat: no-repeat;
}
```

- 정확한 픽셀/색 값은 구현 단계에서 조정. 본 spec 은 의도만 고정.
- 기존 `TomboyChecklist` 의 체크박스 스타일 (`.tomboy-checklist-...`)
  과 시각적으로 명확히 구별 (영역 기반은 listItem 앞, inline 은 텍스
  트 흐름 안 14px 박스).

## File structure

```
app/src/lib/editor/inlineCheckbox/
├── node.ts          # 노드 정의 + input rule + paste transform + NodeView
└── index.ts         # export TomboyInlineCheckbox = [InlineCheckbox]
```

각주처럼 배열 export (`...spread` 로 등록). 현재는 노드 하나뿐이라 별
도 Extension 은 두지 않는다. 영역 감지 같은 후속 기능이 필요해지면
그때 Extension 추가.

## Integration points

- `app/src/lib/core/noteContentArchiver.ts` — read split, write
  serialize, getPlainText 세 곳에 분기 추가.
- `app/src/lib/editor/copyFormatted.ts` — 4개 serializer 분기.
- `app/src/lib/schedule/parseSchedule.ts` — `inlineText` 워커에서
  `inlineCheckbox` 만나면 텍스트로 처리 (`[ ]` / `[x]`).
- `app/src/lib/editor/TomboyEditor.svelte` — `...TomboyInlineCheckbox`
  extension 등록 + `.tomboy-inline-checkbox` CSS.

## Non-goals

- 키보드 단축키 토글 (NodeSelection + Space 등).
- mark 적용 (bold inlineCheckbox 등).
- 텍스트 mid-paragraph 외의 위치 — 제목 라인 변환 차단.
- 기존 `TomboyChecklist` 와의 자동 변환 / 마이그레이션 — 두 모델은 별
  도로 유지.
- find/search 가 `[ ]` / `[x]` 텍스트로 매치 — 노드라서 text scan 안
  됨. 각주와 동일한 trade-off.
- 모바일 long-press 등 특수 인터랙션.

## Compatibility / migration

- **신규 기능, 마이그레이션 불필요**. 기존 `[ ]` / `[x]` 텍스트가 든
  노트는 다음 열림 때 archiver 가 자동으로 노드로 변환. 저장 시 다시
  텍스트로 직렬화되므로 Tomboy desktop / 모바일 호환 유지.
- **외부 noise 변환 가능성**: 우연히 본문에 `[ ]` 텍스트를 쓴 기존 노
  트가 있으면 다음 열림 때 모두 체크박스로 변환됨. 이건 의도된 동작
  — 사용자가 원하지 않으면 변환된 체크박스를 backspace 로 지우면 됨.
- 챗 노트 (`claude://` / `llm://`) — chat send 시 노트가 텍스트 직렬
  화되므로 `[ ]` / `[x]` 로 전달됨. AI 모델 입장에서 의미 있는 패턴.
- 터미널 노트, OCR 노트, 일정 노트 — 모두 첫 줄 시그니처 기반 파싱.
  `[ ]` 와 충돌 없음.

## Risks / open questions

- **paste destination 검사**: PM `transformPasted` 의 `view` 인자를
  쓰면 destination 의 `$from.index(0)` 체크 가능. 단 PM 버전에 따라
  `(slice, view) => slice` 시그니처 보장 확인 필요. 보장 안 되면
  `handlePaste` 로 전환.
- **모바일 터치 영역**: 14px 박스는 터치 hit-target 으로 작음. 모바일
  에서만 padding 으로 hit-area 키우는 것 검토 (구현 단계).
- **archiver 에서 mark 흐름 중간에 노드 emit 시 직렬화된 XML 의 mark
  열림/닫힘 순서**: 각주에서 이미 검증된 패턴 (`splitFootnotesInText`)
  이라 동일 헬퍼 패턴 사용. 신규 위험 없음.
