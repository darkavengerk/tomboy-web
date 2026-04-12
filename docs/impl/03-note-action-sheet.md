# 3단계 — 노트 액션 시트 (뼈대: 삭제 / 다시 다운받기)

## 목표

편집 화면 우측 상단 아이콘 → 바텀 시트. 1차 항목은 **삭제**와 **다시 다운받기**. 즐겨찾기/홈 지정/노트북 이동은 후속 단계(7, 6)에서 항목만 추가한다.

## 완료 조건

- [ ] `.editor-header`에 우측 "⋮" 버튼 추가.
- [ ] 바텀시트 컴포넌트 `NoteActionSheet.svelte` 렌더. 배경 탭 시 닫힘, ESC 닫힘.
- [ ] 삭제: confirm UI(시트 내 인라인) → `deleteNoteById` → 홈(`/`)으로 이동 + 토스트 `"삭제되었습니다"`.
- [ ] 다시 다운받기: 현재 노트의 `localManifest.noteRevisions[guid]`를 제거 후 `sync()` 실행 → 토스트로 결과.
  - 편집 중 변경사항이 있으면(`localDirty` 또는 `pendingDoc`) "저장되지 않은 변경사항이 있습니다"로 막고 취소.
- [ ] 테스트 그린. `svelte-check` 에러 0.

## 선행 / 영향 범위

- 선행: 2단계(필요 시 `appSettings` 사용), 1단계(토스트).
- 수정: `app/src/routes/note/[id]/+page.svelte`, `app/src/lib/sync/manifest.ts`(헬퍼 필요 시).
- 신규: `app/src/lib/editor/NoteActionSheet.svelte`, 테스트.
- 신규 devDep: `@testing-library/svelte`, `@testing-library/user-event`.

## Red: 작성할 테스트

### 유닛

`tests/unit/noteActions.test.ts`:

- `it('markNoteForRedownload(guid) deletes that guid from manifest.noteRevisions')`

  → `manifest.ts`에 `removeNoteRevision(guid)` 또는 `markForRedownload(guid)` 신규 헬퍼를 만들고 단위 테스트.

### 컴포넌트 (신규 도입 라이브러리)

`tests/unit/NoteActionSheet.test.ts`:

- `it('renders "삭제" and "다시 다운받기" buttons')`
- `it('clicking delete asks for confirm inline, then fires onaction("delete") after confirm")`
- `it('clicking re-download fires onaction("redownload") when note is clean')`
- `it('clicking re-download shows guard message when note is dirty')`
- `it('clicking backdrop fires onclose')`
- `it('Escape key fires onclose')`

### 편집 페이지 통합 (선택)

`tests/unit/notePage.actions.test.ts`(가능 범위 내):

- 컴포넌트 렌더 없이 삭제/재다운 핸들러 순수 함수만 추출해 단위 테스트.
- TipTap 인스턴스가 필요한 흐름은 수동 체크로 남김.

### 샘플

```ts
// NoteActionSheet.test.ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import NoteActionSheet from '$lib/editor/NoteActionSheet.svelte';

it('fires onaction("delete") after confirm', async () => {
  const onaction = vi.fn();
  render(NoteActionSheet, { props: { note: stubNote(), onaction, onclose: vi.fn() } });
  await userEvent.click(screen.getByRole('button', { name: '삭제' }));
  await userEvent.click(screen.getByRole('button', { name: /정말 삭제/ }));
  expect(onaction).toHaveBeenCalledWith('delete');
});
```

## Green: 구현 포인트

### 컴포넌트 시그니처

```ts
type ActionKind = 'delete' | 'redownload'; // 후속: 'toggleFavorite' | 'setHome' | 'pickNotebook'
interface Props {
  note: NoteData;
  dirty: boolean; // 저장 대기 중인지 (부모가 넘김)
  onaction: (kind: ActionKind) => void;
  onclose: () => void;
}
```

- 열림 상태는 부모가 `$state` 로 소유. 시트 내부는 확인 단계(confirm)만 로컬 상태.
- 접근성: `role="dialog"` + `aria-modal="true"`, 포커스 트랩은 1차 생략.

### `manifest.ts` 신규 헬퍼

```ts
export async function removeNoteRevision(guid: string): Promise<void> {
  const m = await getManifest();
  if (m.noteRevisions[guid] !== undefined) {
    delete m.noteRevisions[guid];
    await saveManifest(m);
  }
}
```

### 편집 페이지 핸들러

```ts
async function handleAction(kind: ActionKind) {
  actionSheetOpen = false;
  if (kind === 'delete') {
    await deleteNoteById(note!.guid);
    pushToast('삭제되었습니다.');
    goto('/');
    return;
  }
  if (kind === 'redownload') {
    if (pendingDoc || saving) { pushToast('저장되지 않은 변경사항이 있습니다.', { kind: 'error' }); return; }
    await removeNoteRevision(note!.guid);
    // noteStore에서도 로컬본을 지워야 완전한 재다운이 된다.
    await deleteNoteById(note!.guid); // soft-delete → sync 전 purge 필요?
    // 대안: 새 함수 noteStore.purgeForRedownload(guid) 를 만들어 tombstone 없이 즉시 제거
    const r = await sync();
    if (r.status === 'success') pushToast('다시 다운로드 완료.');
    else pushToast('동기화 실패: ' + r.errors[0], { kind: 'error' });
    goto('/'); // 동일 guid로 돌아올 수도 있으나 목록 경유로 단순화
  }
}
```

> **주의**: 로컬 재다운 흐름은 `soft-delete(tombstone) → sync` 로 가면 서버 쪽에서도 삭제되어 버린다. 따라서 **tombstone 없이 로컬 레코드만 제거**하는 경로가 필요하다. `noteStore.ts`에 `purgeLocalOnly(guid)`를 신규 추가하거나, `purgeNote`를 사용. 이 결정은 구현 시점에 테스트로 고정:
>
> - `it('redownload clears local row but does NOT create a tombstone that would delete server copy')`

### 헤더 아이콘

`.editor-header`에 오른쪽 버튼 추가. 제목 표시 블록의 오른쪽.

## Refactor / 엣지케이스

- 재다운 직후 사용자가 현재 편집 페이지에 머무르면, `$effect`가 `id` 변화가 없으니 리로드 안 됨 → `/`로 이동 후 사용자가 다시 열도록 단순화.
- 삭제 직후 pending save timer가 남아있지 않도록 `handleAction` 초입에 `clearTimeout(saveTimer)`.
- 시트가 열린 채로 뒤로가기 하면 히스토리 상 시트가 먼저 닫혀야 자연스럽다 → 후속(popstate 후킹).

## 수동 확인

- [ ] 시트 열기/닫기(⋮ 버튼, 배경 탭, ESC) 모두 동작.
- [ ] 삭제 → 목록에서 사라지고 토스트.
- [ ] 다시 다운받기 (변경사항 없음) → 노트 다시 생김.
- [ ] 다시 다운받기 (저장 대기 중) → 가드 토스트.
- [ ] 오프라인에서 다시 다운받기 → 동기화 실패 토스트.
