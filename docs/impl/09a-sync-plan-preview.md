# 9단계-a — 동기화 Plan 계산 + 읽기 전용 미리보기

## 목표

현재 `sync()`를 **Plan 계산**과 **Apply 실행**으로 분리. 먼저 Plan만 UI에 노출(체크박스 없음, 전부 진행).

## 완료 조건

- [ ] `computePlan(): Promise<SyncPlan>` — 순수 조회성. IDB 쓰기·커밋 없음.
- [ ] `applyPlan(plan, selection?): Promise<SyncResult>` — 기존 `sync()`의 step 2~5 수행. `selection`이 없으면 모두 적용.
- [ ] `sync()`는 `applyPlan(await computePlan())`의 얇은 래퍼로 유지(역호환).
- [ ] 설정 화면에 **[미리보기]** 버튼 → 결과를 `SyncPlanView.svelte`로 렌더. **[지금 동기화]** 버튼은 그대로 동작.
- [ ] 기존 `tests/unit/syncManager.test.ts`가 그린 상태로 유지.
- [ ] 신규 Plan 계산 테스트 그린.

## 선행 / 영향 범위

- 선행: 없음(다른 단계와 독립).
- 수정(주요): `app/src/lib/sync/syncManager.ts`.
- 수정: `app/src/routes/settings/+page.svelte`.
- 신규: `app/src/lib/components/SyncPlanView.svelte`.

## `SyncPlan` 타입

```ts
export interface SyncPlanItem { guid: string; title?: string; }

export interface SyncPlan {
  serverRev: number;
  serverId: string;
  serverWasWiped: boolean;   // serverId 변경 감지
  toDownload: Array<SyncPlanItem & { rev: number; reason: 'new' | 'updated' | 'conflict-remote-wins' }>;
  toUpload:   Array<SyncPlanItem & { reason: 'new' | 'updated' }>;
  toDeleteRemote: SyncPlanItem[]; // 로컬 tombstone → 서버 제거 예정
  toDeleteLocal:  SyncPlanItem[]; // 서버에서 사라짐 → 로컬 제거 예정
  conflicts: Array<SyncPlanItem & { localDate: string; remoteDate: string; suggested: 'local' | 'remote' }>;
}

export interface PlanSelection {
  download: Set<string>;
  upload: Set<string>;
  deleteRemote: Set<string>;
  deleteLocal: Set<string>;
  conflictChoice: Map<string, 'local' | 'remote'>;
}
```

9a에서는 `PlanSelection`을 **UI에서 노출하지 않음**(전부 선택된 것으로 간주). 타입만 미리 도입.

## Red: 작성할 테스트

`tests/unit/syncManager.plan.test.ts`(기존 mock 세팅 재사용):

- `it('returns empty plan when local and server are identical')`
- `it('lists notes newer on server under toDownload')`
- `it('lists locally-dirty notes under toUpload')`
- `it('lists local tombstones under toDeleteRemote')`
- `it('lists server-missing guids present in local manifest under toDeleteLocal')`
- `it('conflicts: both sides changed — suggested side is whichever changeDate is newer')`
- `it('serverWasWiped true when serverId mismatch and local has a stored serverId')`
- `it('computePlan does NOT call commitRevision or downloadNoteAtRevision')` — 순수성 보장.
- `it('computePlan does NOT mutate manifest in IDB')` — `saveManifest` 호출 0회.
- `it('applyPlan with full selection produces same outcome as current sync()')` — 회귀 가드.

### 샘플 (순수성)

```ts
it('computePlan does not mutate manifest', async () => {
  // 현 manifest를 리턴하는 mock 유지
  const saveSpy = vi.mocked(manifest.saveManifest);
  saveSpy.mockClear();
  await computePlan();
  expect(saveSpy).not.toHaveBeenCalled();
  expect(dropboxClient.commitRevision).not.toHaveBeenCalled();
  expect(dropboxClient.downloadNoteAtRevision).not.toHaveBeenCalled();
});
```

## Green: 구현 포인트

### 리팩터 전략

기존 `sync()`를 단일 함수로 유지하며 **복사→분리**보다, 내부를 두 함수로 쪼개고 `sync()`가 조합하는 형태로 전환.

```ts
export async function computePlan(): Promise<SyncPlan> {
  // 현재 sync()의 Step 1 + Step 2(계산만, download 호출 없음) + Step 3 + Step 4 의
  // "무엇이 바뀌는가"를 수집하는 부분만 수행. I/O는 server manifest 다운로드에 국한.
}

export async function applyPlan(plan: SyncPlan, selection?: PlanSelection): Promise<SyncResult> {
  // 기존 Step 2 (다운로드) / Step 4 (업로드 준비) / Step 5 (commit) 수행.
  // selection이 있으면 필터링.
}

export async function sync(): Promise<SyncResult> {
  const plan = await computePlan();
  return applyPlan(plan); // selection 없음 = 전체
}
```

### Plan 계산 알고리즘 (기존 로직 재해석)

1. `downloadServerManifest()` 호출.
2. `null`이면 `toUpload = allLocal.filter(!deleted)`, 나머지 빈 배열. `serverRev = 0`, 특별 플래그 가능.
3. `serverId` 변경 감지 → `serverWasWiped = true`.
4. 각 `serverManifest.notes`에 대해:
   - `rev > localKnownRev` 이면
     - 로컬에 `deleted` → **무시**(업로드에서 `toDeleteRemote` 처리).
     - 로컬 없음 → `toDownload{reason: 'new'}`.
     - 로컬 있고 `localDirty` → `conflicts` 추가(`suggested`는 changeDate 비교).
     - 로컬 있고 깨끗 → `toDownload{reason: 'updated'}`.
5. 로컬 manifest에 있으나 `serverNoteMap`에 없는 guid → `toDeleteLocal`.
6. 로컬에서 `localDirty=true && !deleted && !conflicts` → `toUpload{reason: 'updated' | 'new'}`.
7. 로컬 `deleted=true && serverHas` → `toDeleteRemote`.

### `applyPlan` (9a에서는 selection 없는 경로만 테스트 보장)

기존 로직을 이 플랜을 참조하도록 소폭 변경:

- `conflicts`에 대해 `suggested`대로 진행(기존 동작과 동일).
- `toDownload`/`toUpload`/`toDeleteRemote`/`toDeleteLocal` 항목만 처리.

`selection`이 주어지면 각 배열을 `filter((x) => selection.<kind>.has(x.guid))` 로 걸러 처리. 9b에서 본격 사용.

### UI — `SyncPlanView.svelte`

```svelte
<script lang="ts">
  import type { SyncPlan } from '$lib/sync/syncManager.js';
  interface Props { plan: SyncPlan }
  let { plan }: Props = $props();
</script>

<section>
  <h3>⬇ 다운로드 ({plan.toDownload.length})</h3>
  <ul>{#each plan.toDownload as i (i.guid)}<li>{i.title ?? i.guid} <span class="reason">{i.reason}</span></li>{/each}</ul>

  <h3>⬆ 업로드 ({plan.toUpload.length})</h3>
  <ul>{#each plan.toUpload as i (i.guid)}<li>{i.title ?? i.guid} <span class="reason">{i.reason}</span></li>{/each}</ul>

  <h3>🗑 서버에서 삭제 ({plan.toDeleteRemote.length})</h3>
  <ul>{#each plan.toDeleteRemote as i (i.guid)}<li>{i.title ?? i.guid}</li>{/each}</ul>

  <h3>🗑 로컬에서 삭제 ({plan.toDeleteLocal.length})</h3>
  <ul>{#each plan.toDeleteLocal as i (i.guid)}<li>{i.title ?? i.guid}</li>{/each}</ul>

  <h3>⚠️ 충돌 ({plan.conflicts.length})</h3>
  <ul>{#each plan.conflicts as c (c.guid)}<li>{c.title} — 제안: {c.suggested}</li>{/each}</ul>

  {#if plan.serverWasWiped}
    <p class="warn">서버가 재설정되었습니다. 동기화 시 로컬 매니페스트가 재생성됩니다.</p>
  {/if}
</section>
```

`settings/+page.svelte` 진입점:

```ts
let plan = $state<SyncPlan | null>(null);
async function preview() { plan = await computePlan(); }
async function apply() { if (plan) await applyPlan(plan); plan = null; }
```

## Refactor / 엣지케이스

- **업로드 제목 보여주기**: `toUpload` 항목의 `title`은 로컬 노트에서 채움. 다운로드 항목은 서버 manifest에 제목이 없을 수 있으니 `title?`.
- **diff 보여주기(업로드 내용 확인)** — 유저 피드백 중요 포인트. 1차는 제목만. 후속에서 `<pre>` 로 서버 last-rev 내용과 로컬 내용 비교 표시 가능 (다운로드 1건 추가 비용).
- **오프라인/미인증**: `computePlan`도 실패. 설정 화면에서 에러 배너.
- **대규모 plan**: 수천 개 항목 스크롤. 1차는 단순 `<ul>`, 페이징은 후속.
- **권장 병합 기준**: `conflicts.suggested`는 현재 구현 규칙(`changeDate`) 그대로 — 동작 변화 없음.

## 수동 확인

- [ ] [미리보기] → 올바른 카운트(업로드/다운로드/삭제/충돌).
- [ ] 미리보기 후 [지금 동기화] → 결과가 Plan과 일치.
- [ ] 서버 wipe 시나리오(Dropbox에서 Tomboy 폴더 삭제 후 테스트 계정에서 재시도) → `serverWasWiped` 배너.
- [ ] 기존 동기화 시나리오(새 노트/수정/삭제) 회귀 없음.
