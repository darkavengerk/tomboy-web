# 5단계 — 노트북(카테고리) 기능

## 목표

Tomboy 태그 규칙(`system:notebook:<이름>`) 기반으로 노트북을 조회·생성·지정·해제.

## 완료 조건

- [ ] `notebooks.ts` 모듈:
  - `listNotebooks(): Promise<string[]>`
  - `createNotebook(name): Promise<void>` — 템플릿 노트 생성.
  - `deleteNotebook(name): Promise<void>` — 템플릿 삭제 + 일반 노트의 해당 태그 제거.
  - `assignNotebook(guid, name | null): Promise<void>` — 한 노트에 단 1개.
  - `getNotebook(note): string | null` — 단일 노트에서 태그 추출.
- [ ] `noteStore.getAllNotes()` 결과에서 `system:template` 태그 노트 제외.
- [ ] 홈 목록 상단에 **칩 필터 바**(`NotebookChips.svelte`). 선택 상태는 URL 쿼리 `?nb=<name>`로 반영(뒤로가기 호환).
- [ ] 단위 테스트 그린.

## 선행 / 영향 범위

- 선행: 3단계(액션 시트) — 후속 6단계에서 "노트북 이동" 항목으로 합류. 본 단계는 순수 모델 + 홈 목록 필터까지.
- 수정: `app/src/lib/storage/noteStore.ts`, `app/src/routes/+page.svelte`.
- 신규: `app/src/lib/core/notebooks.ts`, `app/src/lib/components/NotebookChips.svelte`.

## 데이터 규칙

- 태그 네이밍: `system:notebook:<이름>`. 이름은 콜론 사용 금지. 앞뒤 공백 trim.
- **하나의 노트 = 0~1개 노트북**. 여러 개 붙은 레거시 데이터는 `assignNotebook` 또는 읽기 경로에서 첫 번째만 인정.
- 템플릿 노트: `system:template` + `system:notebook:<이름>` 둘 다 가진 노트. 내용 비어도 OK.

## Red: 작성할 테스트

`tests/unit/notebooks.test.ts` (IDB 모킹: `fake-indexeddb/auto`):

- `it('listNotebooks returns unique sorted names from all notes including templates')`
- `it('createNotebook creates a template note with proper tags')`
- `it('createNotebook is idempotent (creating existing notebook does not duplicate)')`
- `it('assignNotebook(guid, "Work") replaces any existing system:notebook:* tag')`
- `it('assignNotebook(guid, null) removes all system:notebook:* tags')`
- `it('deleteNotebook removes template note and strips tag from member notes')`
- `it('getAllNotes excludes system:template notes')`
- `it('getNotebook(note) returns first system:notebook:* tag, or null')`

### 샘플

```ts
it('assignNotebook replaces existing', async () => {
  const n = await createNote('hello');
  await assignNotebook(n.guid, 'Work');
  await assignNotebook(n.guid, 'Home');
  const updated = await getNote(n.guid);
  expect(getNotebook(updated!)).toBe('Home');
  expect(updated!.tags.filter((t) => t.startsWith('system:notebook:'))).toHaveLength(1);
});
```

## Green: 구현 포인트

### `notebooks.ts`

```ts
const PREFIX = 'system:notebook:';
const TEMPLATE = 'system:template';

export function getNotebook(note: NoteData): string | null {
  const t = note.tags.find((x) => x.startsWith(PREFIX));
  return t ? t.slice(PREFIX.length) : null;
}

export async function listNotebooks(): Promise<string[]> {
  const all = await noteStore.getAllNotesIncludingTemplates(); // see below
  const set = new Set<string>();
  for (const n of all) {
    for (const t of n.tags) if (t.startsWith(PREFIX)) set.add(t.slice(PREFIX.length));
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

export async function createNotebook(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean.includes(':')) throw new Error('Invalid notebook name');
  const existing = await listNotebooks();
  if (existing.includes(clean)) return;
  const n = createEmptyNote(generateGuid());
  n.title = clean;
  n.tags = [TEMPLATE, PREFIX + clean];
  await noteStore.putNote(n);
}

export async function assignNotebook(guid: string, name: string | null): Promise<void> {
  const note = await noteStore.getNote(guid);
  if (!note) return;
  note.tags = note.tags.filter((t) => !t.startsWith(PREFIX));
  if (name) note.tags.push(PREFIX + name.trim());
  note.changeDate = formatTomboyDate(new Date());
  note.metadataChangeDate = note.changeDate;
  await noteStore.putNote(note);
}

export async function deleteNotebook(name: string): Promise<void> {
  const all = await noteStore.getAllNotesIncludingTemplates();
  for (const n of all) {
    const isTemplate = n.tags.includes(TEMPLATE) && n.tags.includes(PREFIX + name);
    if (isTemplate) { await noteStore.deleteNote(n.guid); continue; }
    if (n.tags.includes(PREFIX + name)) {
      n.tags = n.tags.filter((t) => t !== PREFIX + name);
      await noteStore.putNote(n);
    }
  }
}
```

### `noteStore.ts` 변경

- 새 export: `getAllNotesIncludingTemplates()` (원래 `getAllNotes()` 구현을 개명).
- `getAllNotes()`는 `.filter((n) => !n.tags.includes('system:template'))` 결과 반환.
- 테스트에서 템플릿 포함이 필요한 케이스가 있으니 두 함수를 모두 노출.

### `NotebookChips.svelte`

```svelte
<script lang="ts">
  interface Props { names: string[]; selected: string | null; onselect: (n: string | null) => void; }
  let { names, selected, onselect }: Props = $props();
</script>

<div class="chips" role="tablist">
  <button class:active={selected === null} onclick={() => onselect(null)}>📓 전체</button>
  {#each names as name (name)}
    <button class:active={selected === name} onclick={() => onselect(name)}>📓 {name}</button>
  {/each}
</div>
```

홈(`/`)에서 사용:

```ts
let selectedNotebook = $state<string | null>(new URL(page.url).searchParams.get('nb'));
const filtered = $derived(
  selectedNotebook
    ? notes.filter((n) => getNotebook(n) === selectedNotebook)
    : notes
);
function selectNotebook(n: string | null) {
  selectedNotebook = n;
  const url = new URL(location.href);
  if (n) url.searchParams.set('nb', n); else url.searchParams.delete('nb');
  history.replaceState({}, '', url);
}
```

## Refactor / 엣지케이스

- **레거시 멀티 노트북 태그**: 표시 경로에서는 첫 번째만, 쓰기 경로에서는 치환으로 자연 정규화.
- **이름 정합성**: 공백/콜론 거부 외 `Object.freeze`된 예약어(`Templates`, `All Notes`)는 Tomboy 데스크톱 표기와 충돌. 1차에서는 자유 입력, 후속에서 검증.
- **빈 노트북(템플릿만 존재)** — `listNotebooks()`에 포함됨(템플릿에도 태그가 있어서).
- **노트북 이름 변경**: 1차 범위 밖. "생성→이동→삭제" 조합으로 우회 가능.
- **삭제 시 확인**: UI에서 반드시 확인 다이얼로그(노트 손실은 없지만 태그 제거됨).

## 수동 확인

- [ ] 노트북 A 생성 → 홈 상단 칩 "📓 A" 노출.
- [ ] 노트 1개에 A 지정 → 칩 A 선택 시 해당 노트만 보임.
- [ ] A 지정된 노트에 B 지정 → A 태그 제거, B만 남음.
- [ ] A 삭제 → A 템플릿 사라짐, 해당 노트의 A 태그 제거됨, 노트 자체는 유지.
- [ ] 새로고침 후에도 `?nb=A` 쿼리 유지 시 필터 유지.
