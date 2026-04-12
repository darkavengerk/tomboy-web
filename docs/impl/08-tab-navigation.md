# 8단계 — 4탭 하단 네비게이션 + 정렬 + 랜덤

규모가 크므로 **3개 서브 단계**로 쪼갠다.

- 8-1. 라우트·탭바 골격 (홈 / 전체 / 노트북 / 랜덤 라우트가 존재하고 전환됨).
- 8-2. 리스트형 공용 컴포넌트 `NoteList.svelte` + 정렬 드롭다운.
- 8-3. 노트형 뷰(홈·랜덤)와 편집 화면에서의 탭바 숨김.

각 서브 단계를 **별도 커밋 세트(Red→Green→Refactor)**로 진행.

## 공통 완료 조건

- [ ] 하단 탭바: 🏠 홈 / 📄 전체 / 🗂 노트북 / 🎲 랜덤.
- [ ] `/note/[id]` 화면에서는 탭바 숨김(편집 툴바와의 충돌 방지).
- [ ] 라우트 직접 URL 새로고침에서도 각 탭 정상 동작.
- [ ] 리스트형 뷰에 정렬 드롭다운("최근 수정순" / "생성순"). 선택 값은 `appSettings` 또는 URL 쿼리 `?sort=`에 저장.

## 선행 / 영향 범위

- 선행: 5단계(노트북), 7단계(홈 노트 resolve).
- 수정: `app/src/routes/+layout.svelte`, `app/src/routes/+page.svelte` (홈 탭으로 전환), `app/src/routes/note/[id]/+page.svelte` (탭바 레이아웃 여백 조정).
- 신규:
  - `app/src/lib/components/TabBar.svelte`
  - `app/src/lib/components/NoteList.svelte`
  - `app/src/routes/notes/+page.svelte`
  - `app/src/routes/notebooks/+page.svelte`
  - `app/src/routes/notebooks/[name]/+page.svelte`
  - `app/src/routes/random/+page.svelte`

---

## 8-1. 라우트·탭바 골격

### Red

`tests/unit/tabBar.test.ts`:

- `it('renders 4 tabs with correct hrefs')`
- `it('marks the active tab based on prop currentPath')`
- `it('tab item receives role="tab" and aria-current when active')`

라우트 존재성은 수동 확인(SvelteKit 라우트 스모크).

### Green

`TabBar.svelte`:

```svelte
<script lang="ts">
  interface Props { currentPath: string }
  let { currentPath }: Props = $props();
  const items = [
    { href: '/', label: '홈', icon: '🏠' },
    { href: '/notes', label: '전체', icon: '📄' },
    { href: '/notebooks', label: '노트북', icon: '🗂' },
    { href: '/random', label: '랜덤', icon: '🎲' }
  ];
  function isActive(href: string): boolean {
    if (href === '/') return currentPath === '/';
    return currentPath === href || currentPath.startsWith(href + '/');
  }
</script>

<nav class="tab-bar" role="tablist">
  {#each items as it (it.href)}
    <a role="tab" href={it.href} class:active={isActive(it.href)} aria-current={isActive(it.href) ? 'page' : undefined}>
      <span class="icon">{it.icon}</span>
      <span class="label">{it.label}</span>
    </a>
  {/each}
</nav>
```

`+layout.svelte`:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  const hideTabBar = $derived(page.url.pathname.startsWith('/note/'));
</script>

<slot />
{#if !hideTabBar}
  <TabBar currentPath={page.url.pathname} />
{/if}
```

각 새 라우트는 빈 스캐폴드로 먼저 작성 (e.g. `<h1>전체 목록</h1>`) — 8-2, 8-3에서 채움.

### Refactor

- 편집 화면에서 기존 `.toolbar-area`가 `safe-area-bottom`을 이미 쓰고 있음. 탭바가 붙을 때 중복되지 않게 레이아웃 확인.
- 탭 전환 애니메이션은 후속.

---

## 8-2. `NoteList.svelte` + 정렬

### Red

`tests/unit/NoteList.test.ts`:

- `it('renders notes in the order given by sortBy=changeDate desc')`
- `it('sortBy=createDate produces different order')`
- `it('pinned notes come first regardless of sortBy')` — 7단계 로직 재사용(`sortForList`).
- `it('changing sort dropdown emits onsortchange')`
- `it('empty state renders "노트가 없습니다"')`

### Green

```svelte
<script lang="ts">
  import type { NoteData } from '$lib/core/note.js';
  import { sortForList } from '$lib/core/noteManager.js'; // 7단계에서 export

  type SortKey = 'changeDate' | 'createDate';
  interface Props { notes: NoteData[]; sortBy: SortKey; onsortchange: (k: SortKey) => void; }
  let { notes, sortBy, onsortchange }: Props = $props();

  const sorted = $derived(sortForList(notes, sortBy));
</script>

<div class="note-list-toolbar">
  <select value={sortBy} onchange={(e) => onsortchange((e.currentTarget as HTMLSelectElement).value as SortKey)}>
    <option value="changeDate">최근 수정순</option>
    <option value="createDate">생성순</option>
  </select>
</div>

{#if sorted.length === 0}
  <p class="empty">노트가 없습니다.</p>
{:else}
  <ul class="note-list">
    {#each sorted as n (n.guid)}
      <!-- 기존 리스트 아이템 마크업 재사용 -->
    {/each}
  </ul>
{/if}
```

`/notes/+page.svelte`:

```ts
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
const SORT_KEY = 'listSort:all';
let sortBy = $state<SortKey>('changeDate');
$effect(() => { (async () => { sortBy = (await getSetting<SortKey>(SORT_KEY)) ?? 'changeDate'; })(); });
function handleSort(k: SortKey) { sortBy = k; setSetting(SORT_KEY, k); }
```

`/notebooks/[name]/+page.svelte`는 동일 패턴, 키를 `'listSort:notebook:' + name`로.

### Refactor

- 4단계 스크롤 캐시 컨슈머를 `/`(홈 노트 뷰)에서 `/notes`로 이동.
- 공통 리스트 아이템을 `<NoteListItem>` 으로 더 쪼갤지는 중복 발생 후 결정(지금은 `#each` 내 인라인 OK).

---

## 8-3. 노트형 뷰 (홈 / 랜덤)

### Red

`tests/unit/random.pick.test.ts`:

- `it('pickRandomNote() returns one of the given notes')`
- `it('pickRandomNote([]) returns null')`
- `it('excludes templates and deleted notes')`

`tests/unit/home.resolve.test.ts` — 7단계에서 이미 커버됨. 본 서브 단계에서는 렌더 통합만.

### Green

`/+page.svelte` (홈 탭):

```svelte
<script lang="ts">
  import { getHomeNote } from '$lib/core/home.js';
  import NoteViewer from '$lib/editor/NoteViewer.svelte'; // 또는 기존 편집 화면 재사용
  let note = $state<NoteData | null>(null);
  let ready = $state(false);
  $effect(() => { (async () => { note = await getHomeNote(); ready = true; })(); });
</script>

{#if !ready}
  <p>로딩 중...</p>
{:else if note}
  <NoteViewer {note} />
{:else}
  <p>노트가 아직 없습니다. 새 노트를 만들어 보세요.</p>
{/if}
```

> 편집 화면과 동일한 TipTap을 재사용해도 좋다. 이 경우 홈/랜덤에서 편집한 내용도 자동 저장됨 — 의도인지 확인 필요. 1차는 **읽기 전용 렌더**(`editable: false`)로 단순화 권장.

`/random/+page.svelte`:

```ts
import { pickRandomNote } from '$lib/core/random.js';
let note = $state<NoteData | null>(null);
async function reroll() { note = await pickRandomNote(); }
$effect(() => { reroll(); });
```

`random.ts`:

```ts
export async function pickRandomNote(): Promise<NoteData | null> {
  const all = await noteStore.getAllNotes(); // 템플릿 제외
  const alive = all.filter((n) => !n.deleted);
  if (alive.length === 0) return null;
  return alive[Math.floor(Math.random() * alive.length)];
}
```

### Refactor

- 편집/뷰어 분리 vs 통합 결정을 여기서 고정. 통합하려면 `TomboyEditor`에 `editable: boolean` prop 추가.
- 홈 노트가 삭제된 경우 `getHomeNote()` fallback이 처리 — 추가 로직 불필요.

## 수동 확인 (전체)

- [ ] 하단 탭바가 목록·노트북·홈·랜덤에서 보이고, `/note/[id]`에서 사라짐.
- [ ] 각 탭 URL 직접 새로고침에서 정상 렌더.
- [ ] 정렬 드롭다운 선택값이 다음 방문에도 유지.
- [ ] 홈 탭: 홈 지정 시 해당 노트, 미지정 시 최근 노트.
- [ ] 랜덤 탭: "🎲 다시 뽑기"마다 다른 노트(표본이 작으면 같을 수 있음).
- [ ] 노트북 탭: 노트북 목록 → 클릭 → 리스트 → 정렬 드롭다운 동작.
