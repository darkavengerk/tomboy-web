# 제목 변경 시 전체 문서 링크 스윕 — 설계

> 작성일: 2026-06-15 · 브랜치: `shifu`
> 선행 작업: 2026-06-14 새 노트 결과 패널 + 전체 문서 링크 스윕
> (`docs/superpowers/specs/2026-06-14-new-note-result-panel-design.md`)

## 배경 / 문제

새 노트 생성 흐름에는 결과 패널(`phase='result'`, 자동으로 닫히지 않음)과 **전체 문서 링크 스윕**("전체 문서에 이 제목 반영")이 이미 구현돼 있다. 스윕은 새 제목이 다른 노트 본문에 **평문으로** 등장하는 곳을 찾아 `tomboyInternalLink` 마크를 **추가**한다(`linkSweep.ts` + `addInternalLinksForTitle`).

생성과 제목 **수정**은 본질적으로 같다 — 둘 다 끝나면 "코퍼스에 어떤 제목이 존재하고, 다른 노트의 평문이 그 제목을 링크하고 싶어할 수 있는" 상태가 된다. 그런데 현재 제목 수정에는 결과 패널도 스윕도 없다.

다만 제목 수정에는 이미 절반이 자동화돼 있다:

- **백링크 rename 캐스케이드(`rewriteBacklinksForRename`)** 가 `updateNoteFromEditor`(인라인 첫 줄 편집)와 `renameNote`(제목 변경 다이얼로그) 양쪽에서 **자동 실행**된다. 기존 `<link:internal|broken>OLD</link>` → `<link:…>NEW</link>` 를 인-메모리 백링크 인덱스로 찾아 전부 다시 쓴다.
- **빠진 조각**은 (1) 새 제목의 평문을 찾아 **새 링크를 추가**하는 가산(additive) 스윕, (2) 백링크 갱신 결과까지 포함해 **패널로 보여주는** 가시성이다.

## 목표

1. **제목 변경 다이얼로그**(`renameNote`)로 리네임하면 결과 패널이 **자동으로** 뜬다(생성과 대칭). 패널은 이미 자동 실행된 백링크 갱신 결과를 **완료된 단계로 표시**하고, 그 아래에서 새 제목에 대한 가산 스윕을 제안한다.
2. **수동 액션** "전체 문서에 이 제목 반영"을 노트 액션 메뉴(모바일 `NoteActionSheet`, 데스크탑 `NoteContextMenu`)에 추가 — 생성/리네임과 무관하게 **어느 노트에서든 아무 때나** 현재 제목으로 스윕을 띄운다. 인라인 첫 줄 편집으로 리네임한 경우와 재-스윕을 커버한다.

## 비목표 (YAGNI)

- **인라인 첫 줄 블러 자동 패널 없음.** 사용자가 "다이얼로그 자동 + 수동 액션"을 선택. 편집 중 매번 블러마다 모달이 뜨면 방해됨 → 인라인 케이스는 수동 액션으로 커버.
- **옛 제목의 고아 링크 제거 스윕 없음.** 캐스케이드가 이미 OLD→NEW 링크 텍스트를 다시 쓰고, 옛 제목은 더 이상 제목이 아니므로 자동 링크 대상이 아니다.
- **링크 해소(broken→internal) 재계산 없음.** 스윕은 평문 → 링크 마크 가산만 한다(생성 스윕과 동일 범위).

## 접근 (Approach 1: 기존 패널/스윕 일반화)

스윕 상태기계(`startSweepCount`/`applySweep`/`cancelSweep`)는 이미 제네릭한 `(title, guid)` 위에서 동작하고, 그동안의 미묘한 버그 수정(중단 복구, 쓰기 전 `flushAll`, 적용 중 취소)을 품고 있다. 이 오케스트레이션을 복제하지 않고 **생성·다이얼로그 리네임·수동 액션 세 진입점이 같은 패널 + 같은 스윕**을 공유한다. 추가 비용은 시드 메서드 하나 + 동적 헤딩 필드뿐.

대안: (2) 별도 `titleSweepFlow` 스토어 — count→confirm→apply 오케스트레이션을 복제, 그 버그들을 독립적으로 재도입할 위험 → 기각. (3) 공용 `sweepController` 추출 — 호출자가 하나 더 느는 것 치고 추상 레이어 과함 → 기각.

## 컴포넌트별 설계

### A. 플로우 스토어 — `app/src/lib/stores/newNoteFlow.svelte.ts`

- 내부 식별자 `createdTitle`/`createdGuid` → `targetTitle`/`targetGuid` 로 이름 변경(제너럴 의미 반영).
- `heading: string` 필드 추가 — 패널 제목. `get heading()` 노출.
- **`openResult({ heading, title, guid, stages })`** 추가 — 생성 경로 없이 곧장 `phase='result'` 로 시드한다. `stages` 는 호출자가 만든 **이미 완료된** 단계 배열(빈 배열 허용), 스윕은 `emptySweep()` 으로 초기화, `targetTitle=title`/`targetGuid=guid`/`heading=heading` 설정.
- 기존 **`submit()`**(생성)은 마지막 성공 분기에서 `openResult({ heading: '새 노트 생성 완료', title: finalTitle, guid: noteGuid, stages })` 를 호출하도록 리팩터 — 생성 동작은 그대로(헤딩 문구 동일, 단계 그대로).
- 스윕 메서드(`startSweepCount`/`applySweep`/`cancelSweep`)는 변경 없음 — 이미 `target*` 를 읽음. `reset()`/`dismiss()`/`cancel()` 도 `heading` 초기화만 추가.

### B. 패널 컴포넌트 — `app/src/lib/components/NewNoteResultPanel.svelte`

- 하드코딩 `새 노트 생성 완료` → `{newNoteFlow.heading}` 으로 교체.
- 동작/상태(idle 버튼 → counting → confirm → applying → done, Esc/백드롭/닫기 게이팅)는 그대로.
- 마운트 지점은 `+layout.svelte` 한 곳(375–393), `isChromeless` 가드 **밖**이라 `/desktop` 에서도 이미 렌더됨 — 추가 마운트 불필요. portal + `--z-modal` 로 데스크탑 캔버스 위에 뜬다.
- (선택) 파일명을 `TitleSweepResultPanel.svelte` 로 변경해 의미를 정직화 — import는 `+layout.svelte` 한 곳. 구현 계획에서 채택 여부 결정(저우선 폴리시).

### C. 다이얼로그 리네임 경로 (자동 패널)

- **`renameNote` 반환형 변경**: `Promise<boolean>` → `Promise<{ ok: boolean; backlinksUpdated: number }>`.
  - `backlinksUpdated` = `rewriteBacklinksForRename(...)` 가 반환한 `affected.length`.
  - 충돌/빈 제목 등 실패 시 `{ ok: false, backlinksUpdated: 0 }`.
- **두 호출 사이트 갱신** (`src/routes/note/[id]/+page.svelte` `handleTitleSave`, `src/lib/desktop/NoteWindow.svelte` `openTitleDialog`):
  - `const t0 = performance.now(); const { ok, backlinksUpdated } = await renameNote(...);`
  - 실패면 기존 토스트.
  - 성공이면 노트북 변경/리로드 등 기존 후처리 후:
    ```ts
    const ms = Math.round(performance.now() - t0);
    newNoteFlow.openResult({
      heading: '제목 변경 완료',
      title: r.title,
      guid: note.guid,
      stages: [{ name: `제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status: 'done' }]
    });
    ```
  - 자동 실행된 백링크 갱신이 **완료된 단계로 가시화**되고, 그 아래에서 새 제목 가산 스윕을 제안.

### D. 수동 액션 (어느 노트든 아무 때나)

- **새 액션 종류 `'reflectTitle'`** 추가 — 두 메뉴는 **각자의 `ActionKind` 유니온**을 export하므로 **둘 다** 갱신:
  - `app/src/lib/editor/NoteActionSheet.svelte`(모바일) `ActionKind` 에 `'reflectTitle'` 추가 + `editTitle` 옆에 버튼 "전체 문서에 이 제목 반영".
  - `app/src/lib/editor/NoteContextMenu.svelte`(데스크탑, `NoteWindow` 가 import) `ActionKind` 에 `'reflectTitle'` 추가 + 동일 항목.
- **두 호출 사이트의 `handleAction`** 에 분기:
  ```ts
  if (kind === 'reflectTitle') {
    newNoteFlow.openResult({
      heading: '전체 문서에 제목 반영',
      title: note.title,
      guid: note.guid,
      stages: []
    });
    void newNoteFlow.startSweepCount(); // 메뉴 선택 자체가 의도 → 집계 자동 시작
    return;
  }
  ```
- 빈 제목 노트면 액션을 숨기거나(권장: `note.title.trim()` 없으면 미표시) no-op.

### E. 정확성 / 합성

- **리네임 순서**: 캐스케이드(OLD→NEW 링크 *텍스트*)는 `renameNote` 안에서 패널 표시 **이전에** 영속화된다. 가산 스윕(평문 "NEW" → 새 링크)은 사용자가 확인을 누른 **이후** `countLinkSweep`/`applyLinkSweep` 가 IDB에서 캐스케이드 반영된 최신 본문을 다시 읽어 동작. `addInternalLinksForTitle` 는 이미 링크된 스팬을 건너뛰므로 중복 링크 없음(멱등).
- **자기 제외 / 삭제 제외**: `candidates()` 가 이미 `targetGuid` 와 `deleted` 를 거른다.
- **크로스-윈도우**: `applySweep` 가 쓰기 전 `desktopSession.flushAll()`, 후 `emitNoteReload`/`reloadWindows` 를 이미 수행(생성 경로와 동일).
- **`&<>` 포함 제목**: `linkSweep` 의 escaped probe(`xmlEscapeTitle`)가 이미 처리.
- **수동 액션 = 리네임 아님**: 제목이 그대로이므로 캐스케이드를 다시 돌리지 않는다 — 가산 스윕만.

### F. 가이드 + 테스트

- **가이드**: `app/src/routes/settings/+page.svelte` 의 기존 결과-패널 가이드 카드(`guideSubTab==='notes'`)에 (1) 제목 변경 다이얼로그 자동 패널, (2) 액션 메뉴 "전체 문서에 이 제목 반영" 수동 항목을 추가.
- **테스트**:
  - `openResult` 시드 → `phase='result'`, `heading`/`target*`/`stages` 반영, 스윕 idle.
  - `submit()` 가 `openResult` 경유로도 기존 동작 유지(헤딩 '새 노트 생성 완료', 생성 단계 보존).
  - `renameNote` 새 반환형 `{ ok, backlinksUpdated }` — 성공/충돌/빈 제목/백링크 0개·N개 케이스.
  - 두 호출 사이트가 새 반환형을 구조분해(타입 통과, `npm run check`).
  - 수동 액션 분기: `reflectTitle` → `openResult` + `startSweepCount` 호출(목 검증).
  - **합성/멱등**: 한 노트에 캐스케이드(OLD→NEW)를 적용한 뒤 같은 노트에 스윕을 돌려도 NEW 마크가 중복되지 않음.

## 영향 받는 파일 요약

| 파일 | 변경 |
|---|---|
| `lib/stores/newNoteFlow.svelte.ts` | `target*` 개명 + `heading` + `openResult`; `submit` 리팩터 |
| `lib/components/NewNoteResultPanel.svelte` | 동적 헤딩 (선택: 파일명 변경) |
| `lib/core/noteManager.ts` | `renameNote` 반환형 `{ ok, backlinksUpdated }` |
| `routes/note/[id]/+page.svelte` | `handleTitleSave` 구조분해 + `openResult`; `handleAction` 에 `reflectTitle` |
| `lib/desktop/NoteWindow.svelte` | `openTitleDialog` 구조분해 + `openResult`; `handleAction` 에 `reflectTitle` |
| `lib/editor/NoteActionSheet.svelte` | `ActionKind` + `reflectTitle` 버튼 (모바일 메뉴) |
| `lib/editor/NoteContextMenu.svelte` | `ActionKind` + `reflectTitle` 항목 (데스크탑 메뉴) |
| `routes/settings/+page.svelte` | 가이드 카드 갱신 |
| `tests/unit/...` | 위 테스트 |

## 성공 기준

- 제목 변경 다이얼로그로 리네임하면 결과 패널이 자동으로 뜨고, "제목 변경 · 백링크 N개 갱신" 단계가 보이며, 새 제목 가산 스윕을 확인→적용할 수 있다.
- 어느 노트의 액션 메뉴에서든 "전체 문서에 이 제목 반영"으로 현재 제목 스윕을 띄울 수 있다(집계 자동 시작).
- 캐스케이드 후 스윕을 돌려도 링크 중복이 없다(멱등).
- `npm run check` 통과, 신규/기존 단위 테스트 통과.
