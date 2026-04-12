# 6단계 — 개별 노트의 노트북 표시/변경

## 목표

편집 화면에서 현재 노트의 노트북을 보여주고, 탭으로 변경(지정/해제/신규 생성)할 수 있게 한다.

## 완료 조건

- [ ] `.editor-header`의 제목 오른쪽(또는 그 아래)에 **노트북 칩** — 노트북 미지정이면 "📓 없음" 또는 숨김.
- [ ] 칩 탭 시 `NotebookPicker.svelte` 모달: 목록 + "새 노트북 만들기" + "해제".
- [ ] 노트 액션 시트(#3)에 "노트북 이동" 항목 추가 — 같은 Picker 오픈.
- [ ] 변경 즉시 헤더 칩 갱신, 토스트 "노트북이 변경되었습니다".
- [ ] 변경은 `assignNotebook` 경유 → `.note` XML의 `<tags>`에 반영되고 `localDirty=true` 찍힘(기존 흐름).

## 선행 / 영향 범위

- 선행: 3단계(액션 시트), 5단계(notebooks 모델).
- 수정: `app/src/routes/note/[id]/+page.svelte`, `app/src/lib/editor/NoteActionSheet.svelte`.
- 신규: `app/src/lib/components/NotebookPicker.svelte`.

## Red: 작성할 테스트

`tests/unit/NotebookPicker.test.ts`:

- `it('lists existing notebooks')`
- `it('shows "해제" when current is set and "없음 (선택됨)" when null')`
- `it('creates a new notebook when typing new name and clicking 만들기')`
- `it('emits onselect(name | null) on choice and closes')`

`tests/unit/notePage.notebookChip.test.ts`(가능 범위 내):

- `it('노트 태그에서 현재 노트북 이름을 계산한다 (getNotebook)')` — 헤더 표시용 유도 값 테스트.
- 실제 헤더 렌더는 수동 확인.

## Green: 구현 포인트

### `NotebookPicker.svelte`

```svelte
<script lang="ts">
  import { listNotebooks, createNotebook } from '$lib/core/notebooks.js';

  interface Props {
    current: string | null;
    onselect: (name: string | null) => void;
    onclose: () => void;
  }
  let { current, onselect, onclose }: Props = $props();

  let names = $state<string[]>([]);
  let newName = $state('');

  $effect(() => { (async () => { names = await listNotebooks(); })(); });

  async function handleCreate() {
    const n = newName.trim();
    if (!n) return;
    await createNotebook(n);
    onselect(n);
  }
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="picker" role="dialog" aria-modal="true">
  <button class:active={current === null} onclick={() => onselect(null)}>없음{current === null ? ' (선택됨)' : ''}</button>
  {#each names as n (n)}
    <button class:active={current === n} onclick={() => onselect(n)}>📓 {n}</button>
  {/each}
  <div class="create">
    <input bind:value={newName} placeholder="새 노트북 이름" />
    <button onclick={handleCreate} disabled={!newName.trim()}>만들기</button>
  </div>
</div>
```

### 편집 페이지 통합

```ts
import { assignNotebook, getNotebook } from '$lib/core/notebooks.js';

let pickerOpen = $state(false);
const currentNotebook = $derived(note ? getNotebook(note) : null);

async function handleNotebookSelect(name: string | null) {
  if (!note) return;
  await assignNotebook(note.guid, name);
  note = await getNote(note.guid);
  pickerOpen = false;
  pushToast('노트북이 변경되었습니다.');
}
```

헤더 칩:

```svelte
<button class="notebook-chip" onclick={() => (pickerOpen = true)}>
  📓 {currentNotebook ?? '없음'}
</button>
{#if pickerOpen}
  <NotebookPicker current={currentNotebook} onselect={handleNotebookSelect} onclose={() => (pickerOpen = false)} />
{/if}
```

### 액션 시트 메뉴 확장

`NoteActionSheet.svelte`에 `'pickNotebook'` 액션 추가. 부모는 `pickerOpen = true`로 위임.

## Refactor / 엣지케이스

- 노트가 저장 대기 중(`pendingDoc` 있음)일 때 `assignNotebook` 직전에 `flushSave()` 한 번 돌려야 태그/내용이 같은 레코드에 합류됨.
- Picker는 포커스가 `<input>`으로 가도 `onclose`가 배경 탭에서만 트리거되게 한다(입력 중 포커스 이동에 닫히면 안 됨).
- 동명 노트북 생성 시 `createNotebook`은 no-op(5단계 계약) → 사용자 UX상 "선택" 동작과 구분 불가 → 성공 토스트만.

## 수동 확인

- [ ] 노트북 지정/변경/해제가 헤더 칩에 즉시 반영.
- [ ] 지정된 노트북이 홈 필터와 일치.
- [ ] 새 노트북 만들기 → 칩 목록과 홈 필터 모두 갱신.
- [ ] 저장 대기 상태에서 변경해도 내용 손실 없음.
