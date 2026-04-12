# 1단계 — 내부 링크 스텁 생성 방지

## 목표

내부 링크를 클릭했을 때 **없는 노트를 새로 만들지 않는다**. 대신 토스트로 "없음"을 안내한다.

## 완료 조건

- [ ] `noteManager.resolveOrCreateNoteByTitle` 제거(또는 `findNoteByTitle`로 인라인 대체). 호출부 0건.
- [ ] `/note/[id]/+page.svelte`의 `handleInternalLink(title)`:
  - 제목 일치 노트가 있으면 `goto('/note/'+guid)`.
  - 없으면 토스트 `'{title}' 노트를 찾을 수 없습니다.` 노출, 페이지 이동 없음.
- [ ] 토스트 컴포넌트 1개(`Toast.svelte`) + 스토어 1개(`toast.ts`) 추가. `+layout.svelte`에서 마운트.
- [ ] 기존 테스트 전부 통과(`npm run test`), `svelte-check` 에러 0.

비고 — 기존 스텁 정리 UI는 본 단계에서 하지 않음. 후속(설정 화면 필터)으로 분리.

## 선행 / 영향 범위

- 선행: 없음.
- 수정: `app/src/lib/core/noteManager.ts`, `app/src/routes/note/[id]/+page.svelte`, `app/src/routes/+layout.svelte`.
- 신규: `app/src/lib/stores/toast.ts`, `app/src/lib/components/Toast.svelte`.

## Red: 작성할 테스트

신규 `app/tests/unit/toastStore.test.ts`:

- `it('push() adds a toast with auto-generated id')`
- `it('dismiss(id) removes only that toast')`
- `it('push(msg, { timeoutMs }) auto-removes after timer')` — `vi.useFakeTimers()`
- `it('subscribe() delivers snapshots on each mutation')`

신규 `app/tests/unit/noteManager.internalLink.test.ts`:

- `it('findNoteByTitle returns undefined for unknown title (sanity)')`
- `it('resolveOrCreateNoteByTitle is no longer exported')` — `import * as mod`; `expect(mod).not.toHaveProperty('resolveOrCreateNoteByTitle')`.

> 편집 페이지의 라우팅 동작(`goto` 호출/미호출)은 컴포넌트 테스트 없이 본 단계에선 수동 확인으로 남긴다. `@testing-library/svelte`는 3단계에서 도입.

### 샘플

```ts
// tests/unit/toastStore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toasts, pushToast, dismissToast } from '$lib/stores/toast.js';
import { get } from 'svelte/store';

beforeEach(() => {
  // reset between tests — expose a _resetForTest() if needed
  for (const t of get(toasts)) dismissToast(t.id);
});

it('push adds a toast with generated id', () => {
  const id = pushToast('hello');
  expect(get(toasts)).toHaveLength(1);
  expect(get(toasts)[0]).toMatchObject({ id, message: 'hello' });
});

it('auto-removes after timeout', () => {
  vi.useFakeTimers();
  pushToast('bye', { timeoutMs: 1000 });
  expect(get(toasts)).toHaveLength(1);
  vi.advanceTimersByTime(1000);
  expect(get(toasts)).toHaveLength(0);
  vi.useRealTimers();
});
```

## Green: 구현 포인트

### `app/src/lib/stores/toast.ts`

```ts
import { writable } from 'svelte/store';

export interface Toast { id: number; message: string; kind?: 'info' | 'error'; }
export const toasts = writable<Toast[]>([]);
let nextId = 1;

export function pushToast(message: string, opts: { timeoutMs?: number; kind?: Toast['kind'] } = {}): number {
  const id = nextId++;
  const kind = opts.kind ?? 'info';
  toasts.update((ts) => [...ts, { id, message, kind }]);
  const t = opts.timeoutMs ?? 2500;
  if (t > 0) setTimeout(() => dismissToast(id), t);
  return id;
}

export function dismissToast(id: number): void {
  toasts.update((ts) => ts.filter((x) => x.id !== id));
}
```

### `app/src/lib/components/Toast.svelte` (최소)

```svelte
<script lang="ts">
  import { toasts, dismissToast } from '$lib/stores/toast.js';
</script>

<div class="toast-layer" aria-live="polite">
  {#each $toasts as t (t.id)}
    <button class="toast" data-kind={t.kind ?? 'info'} onclick={() => dismissToast(t.id)}>
      {t.message}
    </button>
  {/each}
</div>

<style>
  .toast-layer { position: fixed; left: 0; right: 0; bottom: calc(16px + var(--safe-area-bottom)); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; z-index: 1000; }
  .toast { pointer-events: auto; background: #333; color: white; border-radius: 999px; padding: 10px 16px; font-size: 0.9rem; border: none; }
  .toast[data-kind='error'] { background: #c92a2a; }
</style>
```

### `+layout.svelte` 장착

`<Toast />`를 최상위에 1회 렌더.

### `routes/note/[id]/+page.svelte` 변경

```ts
async function handleInternalLink(target: string) {
  const title = target.trim();
  if (!title) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flushSave(); }
  const linked = await findNoteByTitle(title);
  if (!linked) { pushToast(`'${title}' 노트를 찾을 수 없습니다.`, { kind: 'error' }); return; }
  if (linked.guid === noteId) return;
  goto(`/note/${linked.guid}`);
}
```

`findNoteByTitle`은 기존 `noteManager`에 이미 존재. `resolveOrCreateNoteByTitle` import 제거.

### `noteManager.ts`

`resolveOrCreateNoteByTitle` 삭제. 호출부는 위 하나뿐이므로 삭제 후 grep으로 확인.

## Refactor / 엣지케이스

- 공백만 있는 링크 타겟 — 기존처럼 조기 반환.
- `findNoteByTitle`은 **대소문자 무시 + trim** 매치(기존 동작 유지).
- 삭제 대기(`deleted=true`) 노트는 `findNoteByTitle`이 이미 제외(현행 구현 기준 재확인).
- 토스트 중복 방지(같은 타이틀 연타) — 1차는 단순 누적으로 두고 거슬리면 후속.
- 접근성: `aria-live="polite"`, ESC로 닫힘은 후속.

## 수동 확인

- [ ] 있는 제목 링크 클릭 → 해당 노트로 이동.
- [ ] 없는 제목 링크 클릭 → 토스트 뜨고 현재 페이지 유지.
- [ ] 스텁 생성 0건(IDB inspector로 확인).
- [ ] 자기 자신 링크 클릭 시 변화 없음.
