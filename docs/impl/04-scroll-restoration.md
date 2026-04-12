# 4단계 — 목록 스크롤 복원 (A안: 캐시 + scrollTop 저장)

## 목표

노트 상세 → 뒤로가기 시 목록의 스크롤 위치 유지. 라우팅 구조는 그대로.

## 완료 조건

- [ ] 모듈 레벨 캐시(`noteListCache`)가 첫 렌더에 즉시 데이터를 제공 → DOM 높이가 mount 시점에 이미 완성.
- [ ] 목록 스크롤 위치를 navigation 직전에 저장 → mount 시 `scrollTop` 복원.
- [ ] 캐시는 다음 이벤트에서 무효화: `createNote`, `updateNoteFromEditor`, `deleteNoteById`, `sync()` 완료.
- [ ] 무효화 후에도 UI는 "stale-while-revalidate": 기존 캐시를 보여주면서 백그라운드 refresh.
- [ ] iOS Safari / Chrome 모바일에서 스크롤 위치가 돌아옴(수동).

## 선행 / 영향 범위

- 선행: 없음.
- 수정: `app/src/routes/+page.svelte`, `noteManager.ts`(무효화 훅), `syncManager.ts`(성공 후 무효화 호출), `noteStore` 호출부 전반.
- 신규: `app/src/lib/stores/noteListCache.ts`.

## Red: 작성할 테스트

`tests/unit/noteListCache.test.ts`:

- `it('starts empty')`
- `it('setCache(notes) stores value retrievable synchronously')`
- `it('invalidate() clears notes but keeps scrollTop')`
- `it('setScrollTop(n) / getScrollTop() roundtrip')`
- `it('onInvalidate listener fires once per invalidation')`

> 라우팅/스크롤 복원의 실제 픽셀 동작은 수동 확인. 단위 테스트는 캐시 계층만 커버.

### 샘플

```ts
import { _resetForTest, setCachedNotes, getCachedNotes, invalidateCache, setCachedScrollTop, getCachedScrollTop } from '$lib/stores/noteListCache.js';

beforeEach(_resetForTest);

it('invalidate preserves scrollTop', () => {
  setCachedNotes([{ guid: 'a' } as any]);
  setCachedScrollTop(123);
  invalidateCache();
  expect(getCachedNotes()).toBeNull();
  expect(getCachedScrollTop()).toBe(123);
});
```

## Green: 구현 포인트

### `noteListCache.ts`

```ts
import type { NoteData } from '$lib/core/note.js';

let cached: NoteData[] | null = null;
let scrollTop = 0;
const listeners = new Set<() => void>();

export function getCachedNotes(): NoteData[] | null { return cached; }
export function setCachedNotes(n: NoteData[]): void { cached = n; }
export function invalidateCache(): void {
  cached = null;
  for (const l of listeners) l();
}
export function getCachedScrollTop(): number { return scrollTop; }
export function setCachedScrollTop(n: number): void { scrollTop = n; }
export function onInvalidate(cb: () => void): () => void {
  listeners.add(cb); return () => listeners.delete(cb);
}
export function _resetForTest(): void { cached = null; scrollTop = 0; listeners.clear(); }
```

### 무효화 훅

`noteManager.ts`의 `createNote`, `updateNoteFromEditor`, `deleteNoteById` 끝에서 `invalidateCache()` 호출.
`syncManager.ts`의 성공 경로 말미에서도 호출.

### `+page.svelte` (목록) 수정

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { listNotes } from '$lib/core/noteManager.js';
  import {
    getCachedNotes, setCachedNotes,
    getCachedScrollTop, setCachedScrollTop,
    onInvalidate
  } from '$lib/stores/noteListCache.js';

  let notes = $state<NoteData[]>(getCachedNotes() ?? []);
  let loading = $state(getCachedNotes() === null);
  let container: HTMLElement | undefined;

  async function refresh() {
    const fresh = await listNotes();
    notes = fresh;
    setCachedNotes(fresh);
    loading = false;
  }

  onMount(() => {
    if (container) container.scrollTop = getCachedScrollTop();
    refresh();
    const off = onInvalidate(refresh);
    return () => off();
  });

  beforeNavigate(() => {
    if (container) setCachedScrollTop(container.scrollTop);
  });

  function handleScroll() {
    if (container) setCachedScrollTop(container.scrollTop);
  }
</script>

<div class="note-list" bind:this={container} onscroll={handleScroll}>
  {#each notes as n (n.guid)}
    <!-- ... -->
  {/each}
</div>
```

- 캐시가 있으면 `loading=false`로 즉시 렌더 → `scrollTop` 복원이 정상 동작.
- `refresh()`는 비동기라 화면은 이미 구버전을 보여줌 → 차이만 diff로 교체(Svelte `{#each}` key로 처리).

## Refactor / 엣지케이스

- **캐시 무효화 누락** 시 UX 드리프트. 무효화 포인트를 `noteStore.ts`의 put/delete 한 곳으로 모으는 것도 대안 — 단일 진입점. 1차 구현에서 선택.
- **탭/윈도우 복수**: 다른 탭에서 변경되면 이 탭은 모름. `BroadcastChannel` 도입은 후속.
- **홈 탭 전환(8단계)** 시에는 `/` 라우트가 노트형 뷰로 바뀔 수 있음 → 캐시 소비 위치를 `/notes`로 옮길 것. 8단계에서 리팩터.

## 수동 확인

- [ ] 목록에서 10번째 항목까지 스크롤 → 노트 열기 → 뒤로 → 같은 위치.
- [ ] 편집 후 뒤로 → 편집한 노트가 맨 위로 올라와 있고, 스크롤 위치는 유지.
- [ ] 동기화 직후 목록 자동 갱신.
- [ ] iOS Safari에서 `-webkit-overflow-scrolling: touch` 유지 확인.
