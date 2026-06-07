# 데스크탑 펼쳐보기 (Spread View) 설계

- **날짜**: 2026-06-07
- **상태**: 설계 승인 대기 → 구현 예정
- **범위**: `/desktop` 멀티윈도우 모드 전용 (모바일 무관)

## 1. 문제 / 동기

`/desktop` 워크스페이스에서 노트 창을 여러 개 열면 서로 겹쳐 내용이 가린다. 특정 노트를
찾으려면 하나씩 들춰봐야 하고, 전체를 죽 훑어보려면 창을 일일이 다시 열어야 한다.

**펼쳐보기**: 한 번의 동작으로 현재 워크스페이스에 열린 노트 창들을 **겹치지 않게 정렬해
한눈에 훑어보고**, 원하는 노트를 클릭해 곧장 그 창으로 이동한다. macOS의 Exposé /
Mission Control과 비슷하되, 한 화면에 맞게 *축소*하지 않고 **각 노트를 실제 크기 그대로**
두어, 넘치면 **세로 스크롤**로 내려가며 본다.

## 2. 목표 / 비목표

### 목표
- 현재 워크스페이스의 열린 **노트 창**(`kind === 'note'`)을 실제 크기 그대로 펼쳐 정렬.
- 화면을 넘기면 세로 스크롤로 전부 훑어보기.
- 카드 클릭 → 펼쳐보기 닫고 해당 창으로 포커스/이동(크기가 같아 전환이 자연스러움).
- **2채널 스크롤**: 오른쪽 큰 스크롤바 = 갤러리 전체 스크롤, 마우스 휠 = 커서 밑 개별 노트
  내용 스크롤.
- 기존 캔버스 / 창 / 영속성(`session.svelte.ts`)에 **무손상**. 펼쳐보기는 순수 일시적
  읽기전용 레이어.

### 비목표 (YAGNI)
- 펼쳐보기 안에서의 직접 편집(읽기전용 + 클릭 이동만).
- 다른 워크스페이스나 닫힌 노트까지 펼치기(현재 워크스페이스의 열린 노트만).
- 한 화면 맞춤 축소(Mission Control 정석) — 사용자가 "스크롤 원함"으로 명시적 배제.
- 패킹 좌표의 영속화(펼쳐보기는 휘발 상태).
- 카드 → 창으로의 FLIP 모핑 애니메이션(후속 폴리시 후보).

## 3. 확정된 설계 결정

| 항목 | 결정 |
|---|---|
| 아키텍처 | **A. 전체화면 오버레이 + 실제크기 읽기전용 스냅샷** |
| 대상 범위 | 현재 워크스페이스의 열린 노트 창만 (settings/admin 제외) |
| 인터랙션 | 읽기전용 훑어보기 + 클릭 시 그 창으로 이동 |
| 갤러리 스크롤 | 오른쪽 **커스텀 큰 스크롤바**(Firefox에서 폭 키우기 위해 네이티브 대신 위젯) |
| 개별 노트 스크롤 | 마우스 휠 + 카드 `overscroll-behavior: contain` (페이지로 안 샘) |
| 패킹 | 직접 구현한 **First-Fit 선반(shelf) 패킹**, 실제 크기 유지 |
| 정렬 순서 | 원래 창 위치 기준 **row-major (y → x)** 보존 |
| 정렬 방식 | **좌측 정렬** (실제 크기 유지 대가로 우측 끝 들쭉날쭉 수용) |
| 스냅샷 | 살아있는 창 콘텐츠 DOM `cloneNode(true)` 정적 복제 |
| 트리거 | **F4** 토글 + SidePanel 레일 버튼 |
| 종료 | Esc(capture) / 닫기 버튼 / 카드 클릭 |

## 4. 아키텍처

전체화면 오버레이가 캔버스 위를 덮는다. 오버레이는 현재 워크스페이스의 노트 창 목록을 읽어
각 창을 **실제 w/h 크기의 카드**로 만들고, 카드 내용은 그 창의 살아있는 콘텐츠 DOM을 복제한
정적 스냅샷이다. 카드들을 선반 패킹으로 좌측 정렬 배치하고, 콘텐츠 총높이가 뷰포트를 넘으면
세로 스크롤된다.

기존 데스크탑 구조(절대좌표 창, 드래그/리사이즈, 디바운스 영속성)는 전혀 건드리지 않는다.
펼쳐보기는 그 위에 얹히는 별도 레이어이며, 닫으면 흔적 없이 사라진다.

### 4.1 2채널 스크롤 (핵심)

- **오른쪽 큰 스크롤바 = 갤러리(페이지) 스크롤.** Firefox는 `::-webkit-scrollbar`로 폭을
  키울 수 없으므로 커스텀 위젯으로 구현: 트랙 + 두꺼운 드래그 thumb. thumb 높이 =
  `clientHeight / scrollHeight` 비율, 위치 = `scrollTop / (scrollHeight - clientHeight)`.
  thumb 드래그 → 스크롤 컨테이너 `scrollTop` 설정. 트랙 클릭 → 페이지 단위 이동.
- **마우스 휠 = 커서 밑 카드 내용 스크롤.** 각 카드는 내부 `overflow-y: auto` +
  `overscroll-behavior: contain`. 휠이 카드 경계에 닿아도 갤러리로 전파되지 않는다(휠은
  "노트 안 읽기" 전용). 카드 콘텐츠가 카드보다 짧아 스크롤 불가일 때도 페이지는 움직이지
  않는다 — 페이지 이동은 오른쪽 스크롤바가 전담.
- 스크롤 컨테이너는 `overflow-y: auto`이되 네이티브 스크롤바를 숨겨(`scrollbar-width: none`
  / `::-webkit-scrollbar { display:none }`) 커스텀 스크롤바만 노출. 여백(카드 밖) 위에서의
  휠은 갤러리 스크롤로 폴백.

### 4.2 패킹 알고리즘 — `packShelves.ts` (순수 함수)

```ts
interface Box   { guid: string; w: number; h: number; }
interface Placed extends Box { x: number; y: number; }
interface PackResult { placed: Placed[]; totalHeight: number; }

function packShelves(boxes: Box[], containerWidth: number, gap: number): PackResult {
  const placed: Placed[] = [];
  let shelfX = 0, shelfY = 0, shelfH = 0;
  for (const box of boxes) {
    const w = Math.min(box.w, containerWidth);   // 뷰포트보다 넓은 노트는 클램프
    const h = box.h;
    if (shelfX > 0 && shelfX + w > containerWidth) {  // 현재 선반에 못 들어가면 줄바꿈
      shelfY += shelfH + gap;
      shelfX = 0;
      shelfH = 0;
    }
    placed.push({ guid: box.guid, x: shelfX, y: shelfY, w, h });
    shelfX += w + gap;
    shelfH = Math.max(shelfH, h);
  }
  return { placed, totalHeight: boxes.length ? shelfY + shelfH : 0 };
}
```

`gap` 기본값은 16px 정도(구현 시 상수). `containerWidth`는 §6 참조.

- **순서 보존**: 높이 정렬을 하지 않으므로 입력 순서(=원래 위치 row-major)가 그대로 시각
  순서가 된다. 예측 가능성 ↔ 약간의 우측 빈틈을 맞바꾼 의도된 선택.
- **좌측 정렬**: 각 선반은 `x = 0`부터 `gap` 간격으로 채운다.
- **클램프**: 한 노트의 폭이 컨테이너보다 넓으면 컨테이너 폭으로 줄여 단독 전체폭 행이 된다.
- **빈 입력**: `totalHeight = 0`.

### 4.3 스냅샷 렌더링

카드 내용 = **살아있는 창 콘텐츠 DOM의 `cloneNode(true)` 정적 복제본**. 이미지·표 등 현재
렌더 상태 그대로 박제되며, 카드가 스크롤 뷰포트를 제공하므로 휠로 전체 내용을 읽을 수 있다.

- 복제본은 비활성화: `pointer-events: none`(클릭이 카드로 전달되어 "점프") +
  `contenteditable=false` + `user-select: none`.
- **스냅샷 소스 등록부**를 `session.svelte.ts`에 추가:
  `registerSnapshotSource(guid, () => HTMLElement | null)`. `NoteWindow`가 자기 콘텐츠
  스크롤 루트를 등록 → TomboyEditor 노트든 터미널 노트든 동일하게 복제. 등록 소스가 없으면
  제목 + 텍스트 미리보기(노트 XML에서 추출) 폴백.
- 각 카드 상단에 얇은 비스크롤 **제목 바**(노트 제목) — 스크롤 중에도 식별 가능.
- **한계**: Leaflet 지도 등 `<canvas>` 픽셀은 `cloneNode`로 복제되지 않아 빈칸으로 보일 수
  있음. 썸네일 용도라 수용. 지연 로드 이미지는 펼치는 시점에 로드된 만큼만 박제됨(열려 있던
  창이라 대개 이미 로드됨).

## 5. 구성 파일

```
app/src/lib/desktop/spreadView/
├── packShelves.ts          # 순수 패킹 함수 + 타입
├── spreadView.svelte.ts    # 룬 상태 모듈: isOpen, open(), close(), toggle()
├── SpreadOverlay.svelte    # 오버레이: 창 수집 → 복제 → 패킹 → 카드 렌더, 휠 라우팅,
│                           #          클릭 점프, Esc(capture), 커스텀 스크롤바 호스팅
└── SpreadScrollbar.svelte  # 오른쪽 커스텀 큰 스크롤바 (드래그 thumb + 트랙 클릭)
```

기존 파일 변경:
- `session.svelte.ts` — 스냅샷 소스 등록부(`registerSnapshotSource` / `getSnapshotSource`).
- `NoteWindow.svelte` — `onMount`에서 콘텐츠 루트를 `registerSnapshotSource`로 등록.
- `DesktopWorkspace.svelte` — `{#if spreadView.isOpen}<SpreadOverlay/>{/if}` 마운트,
  `onKey`에 F4 토글, SidePanel `onspread` 핸들러 연결.
- `SidePanel.svelte` — 레일에 "펼쳐보기" 버튼(열린 노트 0개면 비활성), `onspread` prop.
- `settings/+page.svelte` — 가이드 카드 추가(데스크탑 전용 → `env` 서브탭 후보; 구현 시 기존
  데스크탑 가이드 카드 위치 확인 후 맞춤).

신규 테스트:
- `app/tests/unit/desktop/packShelves.test.ts`
- `app/tests/unit/desktop/SpreadOverlay.test.ts`(스모크)

## 6. 데이터 흐름

```
F4 / 레일 버튼
  └─> spreadView.open()                         # isOpen = true
        └─> SpreadOverlay 마운트
              1. wins = desktopSession.windows.filter(kind==='note')
              2. ordered = [...wins].sort((a,b)=> a.y-b.y || a.x-b.x)   # row-major
              3. boxes = ordered.map(w => ({guid, w: w.width, h: w.height}))
              4. { placed, totalHeight } = packShelves(boxes, containerWidth, GAP)
              5. 스크롤 콘텐츠(height=totalHeight)에 카드를 position:absolute 로 배치
                 각 카드: 제목 바 + 스크롤 뷰포트(복제 스냅샷)
              6. SpreadScrollbar 가 컨테이너 scrollTop/scrollHeight 반영

카드 클릭 ─> spreadView.close() + desktopSession.focusWindow(guid)
Esc / 닫기 ─> spreadView.close()                # 창 상태 무변경
```

`containerWidth` = 오버레이 내부 폭 − 커스텀 스크롤바 폭 − 좌우 패딩. 리사이즈 시 재패킹.

## 7. 트리거 / 종료

- **트리거**: `F4`(수정자 없이) 토글 — `DesktopWorkspace.onKey`에서 `preventDefault` 후
  `spreadView.toggle()`. 추가로 SidePanel 레일 버튼. 열린 노트가 0개면 버튼 비활성(F4는
  토스트 또는 무동작).
- **종료**: `SpreadOverlay`가 `window`에 `keydown` capture 리스너를 달아 `Escape`를 먼저
  가로채고(`stopImmediatePropagation`) `close()` — NoteWindow의 Esc 닫기와 충돌 방지.
  우상단 닫기 버튼, 카드 클릭(점프)도 종료 경로.

## 8. 엣지 케이스

- 열린 노트 0개 → 버튼 비활성 / F4 무동작(또는 토스트).
- 1개 → 카드 1장(정상).
- 노트 폭 > 뷰포트 → 폭 클램프(전체폭 행).
- 매우 긴 노트 → 카드 = 실제 창 높이, 내부 휠 스크롤로 전체 열람.
- 새로고침 중 펼쳐보기 → 휘발 상태(비영속)라 그냥 닫힌 채 로드.
- settings/admin 창 → 펼치기 대상에서 제외.
- 펼쳐보기 동안 하부 캔버스 상호작용은 오버레이가 가로막음(모달).

## 9. 테스트

- `packShelves` 순수 단위 테스트: 한 행 채움 / 줄바꿈 / 초과폭 클램프 / `totalHeight` /
  순서 보존 / `gap` 간격 / 빈 입력.
- `SpreadOverlay` 스모크: 가짜 `desktopSession`(노트 N개 + 더미 스냅샷 소스) → 카드 N개
  렌더 + 패킹 좌표 확인, 카드 클릭 → `focusWindow` 호출 + `close`, Esc → `close`.
- 저장소 관례: vitest + @testing-library/svelte. IDB 비의존(필요 없음).

## 10. 문서화 (CLAUDE.md 불변식)

설정 → 가이드에 `<details class="guide-card">` 추가(데스크탑 전용 기능). 짧은 `<summary>`
("펼쳐보기 — 열린 노트 한눈에"), `<p class="info-text">` 소개, `<ul class="guide-list">`에
F4 트리거 / 2채널 스크롤 / 현재 워크스페이스·노트만 / 읽기전용+클릭 이동 등 제약을 기재.
서브탭은 구현 시 기존 데스크탑 가이드 카드 배치를 확인해 맞춘다.

## 11. 후속(선택) 아이디어 — 본 구현 범위 밖

- 카드 → 창 FLIP 모핑 애니메이션.
- 카드 수가 매우 많을 때 화면 밖 카드의 스냅샷 지연 복제(성능).
- 패킹 모드 토글(높이정렬 최밀 / 선반 정렬)·정렬순서 토글(최근 포커스순).
- "화면 맞춤 축소" 보조 토글.
