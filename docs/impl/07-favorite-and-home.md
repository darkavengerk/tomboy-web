# 7단계 — 즐겨찾기 + 홈 노트 지정

## 목표

- **즐겨찾기**: Tomboy `system:pinned` 태그로 토글. 목록에서 상단 고정/배지.
- **홈 노트**: 전역 단 1개. `appSettings`에 저장. 8단계의 홈 탭이 소비.

## 완료 조건

### 즐겨찾기

- [ ] `noteManager.toggleFavorite(guid)` 신규 — `system:pinned` 추가/제거.
- [ ] 액션 시트(#3)에 "⭐ 즐겨찾기" / "즐겨찾기 해제" 항목.
- [ ] 목록 정렬: pinned 먼저, 그 안에서 기존 정렬 유지.
- [ ] 리스트 항목에 ⭐ 배지 표시.

### 홈 지정

- [ ] 액션 시트에 "🏠 홈으로 지정" 항목.
- [ ] 이미 홈이면 "홈 해제".
- [ ] 지정 시 이전 홈 지정은 자동 해제(단일 홈 보장).
- [ ] `appSettings` 키 `'homeNoteGuid'`에 저장.
- [ ] 8단계 홈 탭에서 소비. 본 단계에서는 저장까지만.

## 선행 / 영향 범위

- 선행: 2단계(appSettings), 3단계(액션 시트).
- 수정: `noteManager.ts`, `NoteActionSheet.svelte`, 목록 컴포넌트(정렬/배지).
- 신규: `app/src/lib/core/home.ts` (홈 노트 resolve 로직).

## Red: 작성할 테스트

### `tests/unit/favorite.test.ts`

- `it('toggleFavorite adds system:pinned when absent')`
- `it('toggleFavorite removes system:pinned when present')`
- `it('toggle twice is idempotent (back to original)')`
- `it('sorting: pinned first then by changeDate desc')`

### `tests/unit/home.test.ts`

- `it('setHomeNote stores guid in appSettings')`
- `it('getHomeNote returns stored note when exists')`
- `it('getHomeNote falls back to most-recent note when unset')`
- `it('getHomeNote falls back to most-recent note when stored guid no longer exists')`
- `it('clearHomeNote removes the setting')`
- `it('getHomeNote returns null when no notes at all')`

### 샘플

```ts
// home.test.ts
it('falls back when stored guid missing', async () => {
  await setHomeNote('nonexistent');
  const a = await createNote('old');    // older changeDate
  await sleep(10);
  const b = await createNote('newer');
  const home = await getHomeNote();
  expect(home?.guid).toBe(b.guid);
});
```

## Green: 구현 포인트

### `noteManager.ts` 추가

```ts
const PINNED = 'system:pinned';

export async function toggleFavorite(guid: string): Promise<NoteData | undefined> {
  const n = await noteStore.getNote(guid);
  if (!n) return undefined;
  const i = n.tags.indexOf(PINNED);
  if (i >= 0) n.tags.splice(i, 1); else n.tags.push(PINNED);
  const now = formatTomboyDate(new Date());
  n.metadataChangeDate = now; // 내용 변경은 아니므로 changeDate는 건드리지 않는 편이 자연
  await noteStore.putNote(n);
  return n;
}

export function isFavorite(n: NoteData): boolean {
  return n.tags.includes(PINNED);
}
```

> **주의**: `changeDate`를 갱신하지 않으면 `.note` 파일의 `last-change-date`와 불일치할 수 있으나, Tomboy 원본도 pinning은 metadata change로 처리. 실제 XML 직렬화가 `metadataChangeDate`를 반영하는지 `noteArchiver.ts`를 확인하고 일관되게.

### 정렬 정책

```ts
export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
  return [...notes].sort((a, b) => {
    const pa = isFavorite(a) ? 1 : 0;
    const pb = isFavorite(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b[by] ?? '').localeCompare(a[by] ?? '');
  });
}
```

Tomboy 날짜 문자열은 ISO-ish이라 문자열 비교로 올바르게 정렬됨.

### `home.ts`

```ts
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import * as noteStore from '$lib/storage/noteStore.js';

const KEY = 'homeNoteGuid';

export async function setHomeNote(guid: string): Promise<void> {
  await setSetting(KEY, guid);
}
export async function clearHomeNote(): Promise<void> {
  await deleteSetting(KEY);
}
export async function getHomeNoteGuid(): Promise<string | undefined> {
  return getSetting<string>(KEY);
}
export async function getHomeNote(): Promise<NoteData | null> {
  const guid = await getHomeNoteGuid();
  if (guid) {
    const n = await noteStore.getNote(guid);
    if (n && !n.deleted) return n;
  }
  const all = await noteStore.getAllNotes(); // 템플릿 제외(5단계 이후)
  if (all.length === 0) return null;
  return [...all].sort((a, b) => (b.changeDate ?? '').localeCompare(a.changeDate ?? ''))[0];
}
```

### 액션 시트 항목 추가

`ActionKind`에 `'toggleFavorite' | 'setHome' | 'unsetHome'` 추가. 편집 페이지 핸들러:

```ts
case 'toggleFavorite':
  note = await toggleFavorite(note!.guid) ?? note;
  pushToast(isFavorite(note!) ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
  break;
case 'setHome':
  await setHomeNote(note!.guid);
  pushToast('홈 노트로 지정되었습니다.');
  break;
case 'unsetHome':
  await clearHomeNote();
  pushToast('홈 노트 지정이 해제되었습니다.');
  break;
```

현재 노트의 홈 여부는 `getHomeNoteGuid()` 조회 후 `$state`에 반영 — 시트 마운트 시 조회.

### 목록 배지

목록 아이템 컴포넌트에서 `isFavorite(n)` 이면 ⭐ 작게. 이후 8단계의 `NoteList.svelte` 공용 컴포넌트에서 재사용.

## Refactor / 엣지케이스

- **동기화 영향**: `system:pinned` 태그는 `.note` XML에 반영되므로 자연 동기화됨 → 기기 간 즐겨찾기 공유.
- **홈 노트 동기화 안 됨**: 설계상 로컬 전용. 기기별로 다르다는 점 설정 화면에서 1줄 안내(후속).
- **홈 지정된 노트 삭제** → `getHomeNote`가 fallback으로 최근 노트 반환 → 자연 복구.
- **pinned 상태와 템플릿**: 템플릿 노트는 목록에서 제외되므로 pinned여도 무시.

## 수동 확인

- [ ] 즐겨찾기 토글 → 목록 상단으로 이동, ⭐ 배지 노출.
- [ ] 즐겨찾기 다른 기기 동기화 시 유지.
- [ ] 홈 노트 지정 → 8단계 홈 탭이 해당 노트 렌더(또는 미구현 상태면 `getHomeNote()` 콘솔 호출로 확인).
- [ ] 홈 노트 삭제 → fallback으로 최근 노트로 대체.
