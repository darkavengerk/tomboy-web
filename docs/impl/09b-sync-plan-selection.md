# 9단계-b — 체크박스 선택 + 충돌 해결 UI

## 목표

9a의 읽기 전용 미리보기에 **부분 선택**을 추가. 사용자 피드백 핵심은 **업로드 검토** — 어떤 파일이 올라가는지 확인하고 잘못된 것은 제외할 수 있어야 함.

## 완료 조건

- [ ] `SyncPlanView.svelte`의 각 항목에 체크박스. 기본 전부 체크.
- [ ] 충돌 항목에 로컬 / 리모트 라디오 버튼. 기본값은 `suggested`.
- [ ] [선택 항목 적용] 버튼 → `applyPlan(plan, selection)`.
- [ ] 업로드 항목을 펼치면 **내용 미리보기**(로컬 `xmlContent`를 plain text로 간이 표시). — 유저 피드백 반영.
- [ ] 미선택 항목은 로컬 상태에 영향 없음(업로드 제외된 노트는 다음 Plan에서 여전히 `toUpload`).
- [ ] 테스트 그린.

## 선행 / 영향 범위

- 선행: 9단계-a.
- 수정: `app/src/lib/sync/syncManager.ts` (`applyPlan`이 `selection`을 실제 적용), `SyncPlanView.svelte`.

## Red: 작성할 테스트

`tests/unit/syncManager.applyPlan.selection.test.ts`:

- `it('applyPlan with empty upload selection does not call commitRevision')` — 단, 다운로드가 있으면 download 단계는 진행.
- `it('applyPlan skips downloads not selected, leaving noteRevisions untouched for those guids')`
- `it('applyPlan honors conflictChoice "local" — remote version is NOT written to local, upload is scheduled instead')`
- `it('applyPlan honors conflictChoice "remote" — local dirty note is overwritten by remote, not uploaded')`
- `it('after partial upload, the not-selected dirty guids remain localDirty=true')`
- `it('after partial download, the not-selected guids are not in localManifest.noteRevisions afterwards')`

## Green: 구현 포인트

### `applyPlan` 로직 보강

```ts
export async function applyPlan(plan: SyncPlan, selection?: PlanSelection): Promise<SyncResult> {
  const sel = selection ?? selectAll(plan);
  // 1. 다운로드: sel.download에 포함된 것만 downloadNoteAtRevision
  // 2. 충돌: conflictChoice 맵의 'remote'는 다운로드 경로, 'local'은 업로드 예약으로 분기
  //    conflictChoice가 누락된 guid는 suggested를 사용.
  // 3. 업로드: sel.upload + conflictChoice === 'local' 항목 병합
  // 4. 서버 삭제: sel.deleteRemote만 commitRevision의 deletions에 포함
  // 5. 로컬 삭제: sel.deleteLocal만 purgeNote
  // 6. noteRevisions 업데이트는 "실제로 처리한 guid"에 한정
}

function selectAll(p: SyncPlan): PlanSelection {
  return {
    download: new Set(p.toDownload.map((x) => x.guid)),
    upload: new Set(p.toUpload.map((x) => x.guid)),
    deleteRemote: new Set(p.toDeleteRemote.map((x) => x.guid)),
    deleteLocal: new Set(p.toDeleteLocal.map((x) => x.guid)),
    conflictChoice: new Map(p.conflicts.map((c) => [c.guid, c.suggested]))
  };
}
```

### 커밋 단위 주의

- Tomboy 서버 프로토콜상 업로드는 하나의 revision에 묶여 커밋된다.
- 선택한 업로드가 **0개**이면 `commitRevision` 호출을 생략(다운로드만 수행).
- 선택한 업로드가 **있으면** 해당 것들만 모아 1개의 revision으로 커밋. 나머지 업로드 후보는 다음 Plan에 다시 등장.

### UI 확장

```svelte
<label>
  <input type="checkbox" bind:checked={sel.upload[i.guid]} />
  {i.title}
  <button onclick={() => togglePreview(i.guid)}>미리보기</button>
</label>
{#if openPreview === i.guid}
  <pre>{previewText(i.guid)}</pre>
{/if}
```

`previewText`는 로컬 `xmlContent`의 `<note-content>` 안을 plain text로 변환 (`noteContentArchiver`에 헬퍼 추가 or 임시로 `.replace(/<[^>]+>/g, '')`).

충돌 라디오:

```svelte
{#each plan.conflicts as c (c.guid)}
  <fieldset>
    <legend>{c.title}</legend>
    <label><input type="radio" bind:group={sel.conflictChoice[c.guid]} value="local" /> 로컬 ({c.localDate})</label>
    <label><input type="radio" bind:group={sel.conflictChoice[c.guid]} value="remote" /> 리모트 ({c.remoteDate})</label>
  </fieldset>
{/each}
```

## Refactor / 엣지케이스

- **부분 선택 재진입**: 업로드를 일부 제외하고 적용 → 다음 Plan에서 미선택분이 여전히 나옴. 정상 동작. 단 사용자에게 "N개가 업로드되지 않았습니다" 토스트로 끝나야 혼동 없음.
- **충돌 선택을 로컬로**: 리모트가 진보했으므로 다음 Plan에서 여전히 충돌로 남음 → 업로드가 성공하면 서버 rev가 올라가 자연 해소. 테스트로 고정.
- **전역 전체 선택/해제** 토글: 섹션별 "모두/해제" 버튼 제공.
- **diff 표시**: 서버 last-rev 대비 실제 diff는 노트 1건당 네트워크 호출 추가 → 비싸다. 1차는 로컬 내용만.
- **선택 상태 유지**: Plan 재계산 시 선택을 승계할지 초기화할지 결정 — 1차는 초기화(안전).

## 수동 확인

- [ ] 업로드 4개 중 1개 체크 해제 → [적용] → 3개만 올라감. 해제했던 1개는 여전히 로컬 dirty.
- [ ] 충돌 "로컬 선택" → 서버 버전 내려오지 않음, 로컬 기준으로 업로드 commit.
- [ ] 충돌 "리모트 선택" → 로컬이 서버 버전으로 덮어쓰이고 업로드 목록에서 제외.
- [ ] 업로드 미리보기에 실제 본문 일부 노출.
- [ ] 업로드 0개 + 다운로드만 선택한 경우 `commitRevision` 호출 없음(네트워크 로그로 확인).
