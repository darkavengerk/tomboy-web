# 즐겨찾기 로컬 전용화 + 정렬 우선순위 제거

## 배경

현재 즐겨찾기는 `NoteData.tags` 안의 `'system:pinned'` 문자열로 표현된다.
`tags`는 `.note` XML의 일부이므로 Dropbox 동기화와 Firebase 실시간 동기화의
페이로드에 그대로 실려 모든 기기에서 동일한 상태를 공유한다. 또한 두
정렬 경로(`sortForList`, `SidePanel`의 `keyed.sort`)가 즐겨찾기를 최상단에
강제로 띄우는 비교를 한다.

새 요구사항은:

1. 노트 목록은 즐겨찾기 우선 정렬 없이 **순수히 최근 변경순**으로만 정렬한다.
   - 데스크탑 워크스페이스 2번(슬립노트 워크스페이스, `SLIPNOTE_WORKSPACE_INDEX = 1`)
     은 기존대로 `recentOpens` 키를 우선 쓰고 fallback이 `changeDate`인 동작을
     유지하되, 즐겨찾기 우선 가산만 제거한다.
2. 즐겨찾기 상태는 **기기별 로컬에만** 저장한다. Dropbox/Firebase 어느 쪽으로도
   동기화되지 않는다.

## 결정 사항

- **저장소**: `lib/storage/favoriteStore.svelte.ts` (신규). `recentOpens.svelte.ts`
  와 동일한 패턴 — Svelte 5 `$state` 모듈 + `appSettings`의 단일 키 persist +
  300ms 디바운스. 즐겨찾기 set은 `Record<string, true>`로 보관한다 (Set 직렬화
  핸들링을 피하기 위함; recentOpens와 동일 결).
- **마이그레이션 정책**: **초기화**. 기존 노트의 `'system:pinned'` 태그는 더 이상
  읽지도 쓰지도 않는다. 일괄 strip은 수행하지 않는다 (모든 즐겨찾기 노트가
  `localDirty=true`가 되며 sync 업로드 폭주가 발생). 죽은 태그는 무해한 채로
  잔존한다.
- **`toggleFavorite` 시그니처 변경**: `async (guid) => NoteData | undefined`에서
  `(guid) => boolean`로. 노트 IDB write도, `notifyNoteSaved`도, `invalidateCache`도
  호출하지 않는다 — 로컬 메모리 + appSettings persist만.
- **`isFavorite` 시그니처 유지**: `(n: NoteData) => boolean`. 내부 구현만
  `favoriteStore.has(n.guid)`로 교체. 호출처는 변경 불필요.
- **`sortForList` 시그니처 유지**: pinned 우선 비교 두 줄만 삭제 → 날짜 desc.
  호출처는 변경 불필요.
- **삭제 cascade**: `favoriteStore.forget(guid)` API는 노출하지만 자동 호출은
  하지 않는다. 이유: 기존 `recentOpens.forget`도 export만 되어있고 호출처가 없는
  것과 정책을 맞춘다. `favoriteStore.has`는 표시되는 노트(살아있는 NoteData)에
  대해서만 호출되므로 deleted guid가 set에 남아도 UI에 노출되지 않음 → 무해. 후속
  cleanup이 필요해지면 별도 PR.

## 아키텍처

### `lib/storage/favoriteStore.svelte.ts` (신규)

`lib/desktop/recentOpens.svelte.ts`의 거의 정확한 복제. 차이점:

- 값 타입: `Record<string, true>` (timestamp 불필요, 멤버십만 의미).
- 저장 키: `'local:favorites'`.
- API:
  - `favoriteStore.has(guid: string): boolean` — 반응형 read.
  - `favoriteStore.toggle(guid: string): boolean` — 새 상태(현재 즐겨찾기 여부)
    반환.
  - `favoriteStore.forget(guid: string): void` — 노트 삭제 시 호출.
  - `favoriteStore.load(): Promise<void>` — 앱 진입 시 1회 호출. 멱등.
  - `favoriteStore._reset(): void` — 테스트 전용.
- 상한: `MAX_ENTRIES = 1000`, 초과 시 가장 오래된 항목 트림은 없음 (사용자가
  명시적으로 토글한 데이터이므로 LRU 트림은 부적절). 1000 도달 시 새 toggle은
  허용하되 토스트로 경고하는 대신, 그냥 상한 없이 둔다 — 즐겨찾기는 한 사람이
  수동 토글하는 데이터라 폭주 위험이 낮음.

> 트림은 없음으로 결정. recentOpens는 자동 기록이라 cap이 필요하지만,
> 즐겨찾기는 명시적 사용자 액션이므로 그대로 보관.

### `lib/core/noteManager.ts` 변경

기존 코드:

```ts
export async function toggleFavorite(guid: string): Promise<NoteData | undefined> {
  const n = await noteStore.getNote(guid);
  if (!n) return undefined;
  const i = n.tags.indexOf('system:pinned');
  if (i >= 0) n.tags.splice(i, 1);
  else n.tags.push('system:pinned');
  const now = formatTomboyDate(new Date());
  n.metadataChangeDate = now;
  await noteStore.putNote(n);
  notifyNoteSaved(guid);
  invalidateCache();
  return n;
}

export function isFavorite(n: NoteData): boolean {
  return n.tags.includes('system:pinned');
}

export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
  return [...notes].sort((a, b) => {
    const pa = isFavorite(a) ? 1 : 0;
    const pb = isFavorite(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b[by] ?? '').localeCompare(a[by] ?? '');
  });
}
```

변경 후:

```ts
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';

export function toggleFavorite(guid: string): boolean {
  return favoriteStore.toggle(guid);
}

export function isFavorite(n: NoteData): boolean {
  return favoriteStore.has(n.guid);
}

export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
  return [...notes].sort((a, b) => (b[by] ?? '').localeCompare(a[by] ?? ''));
}
```

### `lib/desktop/SidePanel.svelte` 변경

`keyed.sort` 비교 함수에서 pinned 가산 두 줄 제거:

```ts
keyed.sort((a, b) => {
  // const pa = isFavorite(a.n) ? 1 : 0;   // ❌ 삭제
  // const pb = isFavorite(b.n) ? 1 : 0;   // ❌ 삭제
  // if (pa !== pb) return pb - pa;         // ❌ 삭제
  return b.key - a.key;
});
```

`isFavorite` import도 더 이상 정렬에서 쓰이지 않지만, ⭐ 배지나 다른 표시에서
계속 쓰일 수 있으므로 import 유지 (NoteList.svelte와 같은 처리).

### 노트 삭제 cascade — 의도적 미구현

`favoriteStore.forget(guid)` API는 export하되 호출처를 추가하지 않는다.
근거는 위 "결정 사항" 섹션 참조. `noteManager.deleteNoteById` /
`notebooks.deleteNotebook` 같은 삭제 경로 어디에도 hook을 추가하지 않는다.

### 초기화

`routes/+layout.svelte`의 `onMount` 또는 모듈-스코프 초기화에 한 줄:

```ts
void favoriteStore.load();
```

레이스: `load()` 완료 전에 `isFavorite()`가 호출되면 `false`를 반환한다 (빈
객체). 일반적으로 첫 렌더에서 즐겨찾기 표시가 한 tick 늦게 칠해지는 정도의 영향.
recentOpens도 동일 특성이므로 신규 위험은 없다.

### `routes/note/[id]/+page.svelte` 호출 변경

```ts
// 기존
if (kind === 'toggleFavorite') {
  const updated = await toggleFavorite(note!.guid);
  // ...
  pushToast(isFavorite(note!) ? '추가' : '해제');
}

// 변경 후
if (kind === 'toggleFavorite') {
  const nowFav = toggleFavorite(note!.guid);
  pushToast(nowFav ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
}
```

`await` 제거. `updated` 반환 객체 사용처가 있었다면 검토 후 제거. 토스트 메시지
근거를 `toggleFavorite`의 반환값(`boolean`)으로 직접 결정.

### `lib/desktop/NoteWindow.svelte`

동일 패턴으로 변경.

## 데이터 흐름

1. 앱 부팅 → `+layout.svelte` → `favoriteStore.load()` → appSettings의
   `local:favorites` 읽어 메모리 `$state`에 채움.
2. 사용자 토글 → `toggleFavorite(guid)` → `favoriteStore.toggle(guid)` → `$state`
   업데이트 → 300ms 디바운스 후 appSettings에 persist. Dropbox/Firebase는 전혀
   건드리지 않음.
3. UI 표시 (`isFavorite(note)`, ⭐ 배지, TopNav 시트 등) → 반응형으로 `$state`
   읽음 → 토글 즉시 화면 반영.
4. 노트 삭제 → favoriteStore에는 hook 없음. 죽은 guid는 메모리/persist에
   남지만 표시되지 않음.

## 동기화 영향

- Dropbox sync: `noteStore.putNote(n)` 호출이 사라지므로 즐겨찾기 토글 시
  `localDirty` flag가 세팅되지 않음 → 다음 sync에 업로드 대상 아님. ✅
- Firebase note sync: `notifyNoteSaved` 호출이 사라지므로 push queue에 추가되지
  않음. ✅
- 외부 기기에서 같은 노트를 받아도 (Dropbox pull 또는 Firebase incremental sync)
  로컬 favoriteStore는 영향 없음. ✅
- 다른 기기의 dead `system:pinned` tag 변화는 무시 (어차피 안 읽음). ✅

## 테스트

신규: `app/tests/unit/storage/favoriteStore.test.ts`

- `load()` 후 `has` 동작.
- `toggle` 멱등성과 반환값.
- `forget`이 멤버십과 persist 양쪽 반영.
- persist는 디바운스 동안 1회 호출 (`vi.useFakeTimers` + `vi.advanceTimersByTime`).
- 두 번째 `load()`는 no-op (멱등).

기존 (있다면): `sortForList` 정렬 테스트. pinned 우선 가정한 케이스가 있다면
삭제하고, 날짜 desc만 기대하는 케이스로 교체.

## 결정하지 않은 것 (의도적)

- `system:pinned` 태그의 일괄 cleanup → **하지 않음**. 죽은 데이터로 잔존.
- 즐겨찾기 IDB export/import 기능 → 범위 외.
- 새 기기 자동 발견 후 onboarding flow → 없음. 비어있는 채 시작.

## 영향 받는 파일 (요약)

신규:
- `app/src/lib/storage/favoriteStore.svelte.ts`
- `app/tests/unit/storage/favoriteStore.test.ts`

수정:
- `app/src/lib/core/noteManager.ts` (toggleFavorite / isFavorite / sortForList 본체)
- `app/src/lib/desktop/SidePanel.svelte` (sort 비교에서 pinned 가산 제거)
- `app/src/routes/note/[id]/+page.svelte` (await 제거 + 토스트 분기)
- `app/src/lib/desktop/NoteWindow.svelte` (await 제거 + 토스트 분기)
- `app/src/routes/+layout.svelte` (`favoriteStore.load()` 호출 추가)

호출처 그대로 (시그니처 유지):
- `app/src/lib/components/NoteList.svelte`
- `app/src/lib/components/TopNav.svelte`
- `app/src/lib/editor/NoteActionSheet.svelte`
- `app/src/lib/editor/NoteContextMenu.svelte`
