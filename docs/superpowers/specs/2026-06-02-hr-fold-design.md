# HR Fold (수평선 섹션 접기) — Design

**Date:** 2026-06-02
**Status:** Approved

## Summary

수평선(`---` 마커) 아래의 콘텐트 섹션을 접거나 펼칠 수 있는 기능. 각 수평선의
우측 끝에 작은 `+` / `−` 버튼이 표시되고, 접으면 해당 섹션의 첫 블록만 한 줄로
클램프되어 보이고 나머지 블록은 숨겨진다. 접기 상태는 기기별 localStorage에
저장되며 노트 XML에는 기록되지 않는다.

```
펼침:                          접힘:
─────────────────────── [−]   ─────────────────────── [+]
프로젝트 회의 메모             프로젝트 회의 메모 - 오늘 …
오늘 논의한 내용을 정리합니다.  ─────────────────────── [−]
참석자는 다음과 같습니다.       다음 섹션 내용
─────────────────────── [−]
다음 섹션 내용
```

## Background

기존 hrSplit 기능: `---` 단락(= 가상 HR 마커)을 Ctrl/Cmd+클릭하면 가로 구분선이
세로 칼럼 분할(나란히 보기)로 토글된다 (Firefox masonry 전용, 데스크탑 전용).
접기 기능은 같은 HR 마커를 섹션 경계로 재사용하되, 분할과는 상호 배타적으로
동작한다.

## Decisions (사용자 확정)

- **접힌 표시**: 섹션의 첫 블록을 CSS line-clamp로 **한 줄**만 표시(말줄임표),
  나머지 블록은 `display: none`.
- **상호 배타**: 나란히 보기(칼럼 분할)가 활성인 동안 접기 버튼은 숨김.
  접힌 섹션이 있는 동안 Ctrl+클릭 분할 토글은 무시됨.
- **모바일 포함**: 접기는 모바일/데스크탑 모두 동작 (분할은 데스크탑 전용 유지).
- **저장**: 기기별 localStorage (`tomboy.hrFold.<guid>`), 동기화 안 함.

## Section model

각 HR 마커가 자기 **아래** 콘텐트를 소유한다: 섹션 *k* = HR *k* 바로 다음
블록부터 다음 HR(또는 노트 끝) 직전 블록까지. 헤더(제목 + 날짜)와 첫 HR 위의
영역은 접기 대상이 아니다. 접기 상태는 HR ordinal(분할과 동일한 번호 체계)로
키잉된다. 빈 섹션(HR 바로 뒤가 또 HR이거나 노트 끝)에는 버튼을 표시하지 않는다.

## Architecture

Approach: 기존 hrSplitPlugin과 **별도의** hrFoldPlugin (같은 디렉토리). 상호
배타는 플러그인 키를 통한 상대 상태 읽기로 구현. 순환 import를 피하기 위해
플러그인 키를 공유 모듈로 분리.

### Files

| File | Role |
|---|---|
| `app/src/lib/editor/hrSplit/pluginKeys.ts` | `hrSplitPluginKey` + `hrFoldPluginKey` 공유 모듈 (신규) |
| `app/src/lib/editor/hrSplit/assignSections.ts` | 순수 섹션 할당 로직 (신규) |
| `app/src/lib/editor/hrSplit/hrFoldPlugin.ts` | PM 플러그인: 상태, 데코레이션, 버튼 위젯 (신규) |
| `app/src/lib/editor/hrSplit/hrFoldStore.ts` | guid별 localStorage 저장 (신규) |
| `app/src/lib/editor/hrSplit/hrSplitPlugin.ts` | handleClick에 접기 게이트 추가 (수정) |
| `app/src/lib/editor/TomboyEditor.svelte` | 확장 등록, 노트 로드 시 시드, CSS (수정) |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 (편집기 탭) (수정) |
| `app/tests/unit/editor/hrFoldSections.test.ts` | 섹션 로직 테스트 (신규) |
| `app/tests/unit/editor/hrFoldStore.test.ts` | 저장 테스트 (신규) |
| `.claude/skills/tomboy-hrsplit/SKILL.md` | 스킬 문서 갱신 (수정) |

### `assignSections.ts` — pure logic

```ts
type SectionRole =
  | { role: 'outside' }                  // 헤더 또는 첫 HR 위 영역
  | { role: 'hr'; ord: number; sectionEmpty: boolean }
  | { role: 'first'; section: number }   // 섹션의 첫 블록
  | { role: 'rest'; section: number };   // 섹션의 나머지 블록

assignSections({ kinds, headerCount }) → { roles: SectionRole[]; hrCount: number }
```

`kinds`는 hrSplit의 `describeTopLevel`과 동일한 `BlockKind[]` 입력을 재사용.

### `hrFoldPlugin.ts`

- **State**: `{ folded: Set<number> }` (HR ordinal 기준).
- **Meta**: `{ toggle: number }` | `{ replace: number[] }` (노트 로드 시드용).
- **apply()**: toggle/replace 처리. `tr.docChanged` 시 HR 개수 밖의 ordinal
  prune (hrSplit의 reconcile과 동일). 변경 시 `onChange` 콜백을 microtask로
  호출 (replace 제외) → TomboyEditor가 localStorage에 저장.
- **decorations()**:
  - hrSplit 상태를 읽어 `activeOrdinals.size > 0`이면 **아무 데코레이션도
    내지 않음** (분할 우선).
  - 비어 있지 않은 섹션의 HR 마커마다 위젯 버튼 (`+` 접힘 / `−` 펼침). HR
    마커 단락 안에 widget decoration으로 부착, CSS로 우측 끝 절대 배치.
    HR 마커는 절대 숨겨지지 않으므로 클램프/clip 문제 없음.
  - 접힌 섹션: 첫 블록에 `tomboy-hr-fold-clamped` (line-clamp:1), 나머지
    블록에 `tomboy-hr-fold-hidden` (display:none) node decoration.
- **버튼 동작**: mousedown preventDefault(캐럿 이동 방지) + click에서
  toggle meta dispatch. `contenteditable=false`, `ignoreSelection: true`.

### `hrSplitPlugin.ts` 수정

`handleClick`: `hrFoldPluginKey.getState(view.state)`의 `folded.size > 0`이면
`false` 반환 (Ctrl+클릭 분할 토글 무시).

### `TomboyEditor.svelte` 수정

- `tomboyHrFold` Extension 등록 (`onChange` → `saveFoldedOrdinals(lastAppliedGuid, …)`).
- 노트 로드 시드 2곳 (초기 시드 + 노트 전환)에서 fold replace meta도 함께 dispatch.
- CSS: `.tomboy-hr-fold-btn`, `.tomboy-hr-fold-clamped`, `.tomboy-hr-fold-hidden`.
  버튼은 HR 마커 우측에 작은 원형, 평소 저채도/hover 시 진하게, 터치 친화
  크기. HR 마커의 `color: transparent` 상속을 끊기 위해 버튼에 색 명시.

### `hrFoldStore.ts`

`hrSplitStore.ts`와 동일 패턴: `tomboy.hrFold.<guid>` 키에 접힌 ordinal 배열
JSON. 빈 set이면 키 삭제. guid null / storage 불가 시 no-op.

## Mutual exclusion semantics

| 상태 | 동작 |
|---|---|
| 분할 활성 (`activeOrdinals.size > 0`) | 접기 버튼/데코레이션 전부 비표시. 접기 상태는 보존되지만 비활성 (inert). |
| 접힌 섹션 존재 (`folded.size > 0`) | Ctrl+클릭 분할 토글 무시. |
| 둘 다 존재 (비정상: localStorage 교차 시드) | 분할 우선. 분할 해제 시 접기 데코레이션 복귀. |

## Error handling

- 문서 편집으로 HR 개수가 줄면 범위 밖 fold ordinal 자동 prune + 저장.
- localStorage 불가(쿼터/프라이빗 모드) 시 silent no-op — 접기는 세션 내에서만 유지.
- 숨겨진 블록은 select-all/copy/find에 여전히 포함 (의도된 동작 — 내용은
  존재하고 보기만 접힘).

## Known limitations

- 접힌(숨겨진) 영역으로의 캐럿 이동은 브라우저가 `display:none`을 건너뛰므로
  사실상 불가 — 편집하려면 펼쳐야 한다.
- HR ordinal 키잉이므로 HR을 삽입/삭제하면 접기 상태가 이웃 섹션으로 밀릴 수
  있다 (hrSplit과 동일한 트레이드오프, ephemeral view state로 허용).
- 노트 내 찾기(Ctrl+F)가 숨겨진 블록 매치로 스크롤해도 보이지 않는다.

## Testing

- `hrFoldSections.test.ts`: 섹션 할당 (HR 없음 / 빈 섹션 / 연속 HR / 헤더 경계 /
  마지막 섹션) — vitest.
- `hrFoldStore.test.ts`: 라운드트립, guid 스코프, 빈 set 삭제, null guid — vitest.
- 플러그인 데코레이션: TipTap Editor 인스턴스 기반 테스트 (geoMapPlugin.test.ts
  패턴) — 분할 활성 시 버튼 미표시, 접기 시 클래스 부여 검증.
- 수동 검증: `npm run dev` — 모바일 뷰포트 + 데스크탑, 분할과의 상호 배타.
