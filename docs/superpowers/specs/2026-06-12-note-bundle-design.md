# 노트 묶음 (Note Bundle) 설계

날짜: 2026-06-12
상태: 승인됨

## 목적

연관된 노트 여러 개를 호스트 노트 한 곳에서 서류함(파일철)처럼 훑어보고, 그중 하나를 펼쳐 실제 편집/재생까지 할 수 있게 한다. 계기: 음악 노트들을 일일이 찾아 열지 않고 묶음 하나에서 훑으며 그때그때 재생하고 싶음.

대상 화면: 데스크톱 NoteWindow + 모바일 `/note/[id]` 둘 다.

## 인식 문법

```
[ ]노트 묶음:50        ← inlineCheckbox atom + 키워드 텍스트. :N 생략 시 50
• ( )시계탑 구현 할 거   ← listItem: inlineRadio atom + tomboyInternalLink 마크 텍스트
• ( )시계탑 버그 리스트
• (o)시계탑 캐릭터 구현 확인
```

- 키워드 라인: paragraph 안에 `inlineCheckbox` atom → 직후 텍스트가 `^\s*노트\s*묶음:(\d+)?\s*$` 매치 (`노트묶음`/`노트 묶음` 모두 허용). **라이브 PMNode 워크로 파싱** — 체크박스/라디오는 atom 노드라 plain-JSON 텍스트 스캔으로는 보이지 않는다 (기존 inlineCheckbox gotcha).
- 키워드 paragraph의 바로 다음 형제 = bulletList. 각 listItem에서 `tomboyInternalLink` 마크가 붙은 텍스트를 추출해 `titleProvider.lookupGuidByTitle`(exact-case trimmed)로 guid 해석. 링크 마크 없는 항목은 무시.
- 체크박스 의미: **체크 = 스택만 표시(리스트 숨김), 해제 = 리스트만 표시(스택 없음).**
- `:N` = 스택 높이, 호스트 노트 편집 영역 높이의 N% (기본 50, 클램프 20–90).
- **라디오는 의무.** 라디오 없는 링크 항목이 있는 상태에서 체크박스가 체크되는 시점에 플러그인이 각 항목 맨 앞에 `( )` atom을 tr로 자동 삽입하고, 펼침 노트(기본 첫 항목)에 `(o)`를 설정한다. 이후 라디오 = 펼친 노트, 양방향 영구 동기화.
- 노트당 번들 여러 개 허용 — 파서가 배열 반환, 각 번들 독립 스택.

## 데이터 모델

```ts
interface BundleSpec {
  keywordFrom: number;      // 키워드 paragraph 위치
  checkboxPos: number;      // 체크 상태 읽기/토글용
  checked: boolean;         // true=스택, false=리스트
  heightPct: number;        // :N (기본 50, 클램프 20–90)
  listFrom: number;
  listTo: number;           // 체크 시 숨길 범위
  entries: BundleEntry[];
}
interface BundleEntry {
  title: string;
  guid: string | null;      // null = 깨진 링크(회색 바, 펼침 스킵)
  radioPos: number | null;
  selected: boolean;
}
```

플러그인 state가 docChanged마다 재파싱(다른 에디터 플러그인과 동일 패턴). 위치는 tr 매핑 대신 재파싱으로 단순화.

## 아키텍처: 위젯 데코레이션 + 임베디드 TomboyEditor

검토한 대안:

- **A. 위젯 데코레이션 + 임베디드 TomboyEditor (채택)** — 순수 뷰 레이어, XML 무변경.
- B. 커스텀 블록 NodeView — 탈락. `.note` XML verbatim 불변식 위반, Tomboy 데스크탑 라운드트립 깨짐.
- C. 에디터 밖 컴포넌트(ChatSendBar 패턴, 노트 하단 고정) — 탈락. 인라인 배치(키워드 자리) 요구와 불일치.

### 렌더링

- 체크 시: 리스트 블록 범위에 `display:none` 노드 데코레이션 + 리스트 끝 위치(리스트 없으면 키워드 라인 끝)에 block widget decoration → 위젯 DOM에 Svelte `mount()`로 `NoteBundleStack.svelte` 마운트.
- 해제 시: 데코레이션 전부 제거, 리스트 그대로. 스택 언마운트 시 임베디드 에디터 pending save flush 후 destroy.
- 위젯 wrapper `contenteditable=false` + keydown/paste/copy/pointerdown `stopPropagation` 격벽 — 외부 PM 이벤트 위임이 내부 에디터 이벤트를 보지 못하게 한다 (editor-in-editor 격리의 핵심).
- XML 무변경: `[x]`/`(o)`/`<link:internal>` 전부 기존 직렬화 그대로 라운드트립. 데코레이션은 geoMap과 같은 순수 뷰 레이어.

### 스택 레이아웃

- 높이 = 호스트 편집 영역 높이 × N% (ResizeObserver로 추적, 창 리사이즈 시 비례 추종).
- 하단 드래그 핸들로 리사이즈 → 드래그 끝에 새 N%를 본문 `노트 묶음:N` 텍스트에 tr로 써넣어 영구화(기기 간 동기화됨).
- 접힌 바: 펼침 인덱스 k 위로 최대 4개(`max(0, k-4)..k-1`), 총 타이틀 5개 한계. NoteWindow 타이틀 바 CSS 재활용. 깨진 링크 = 회색 바 + 클릭 무시.
- 펼친 노트: 항상 스택 맨 아래, 남은 높이 전부. 내부 `overflow-y:auto` + `overscroll-behavior:contain`.
- 스크롤 전환: 접힌 바 영역에서 휠 1노치 / 터치 스와이프(임계값) = k±1. 펼친 노트 본문 스크롤은 내부에서만 소비.

### 임베디드 에디터 수명주기

- `TomboyEditor` 인스턴스는 번들당 1개만(펼친 노트용). k 전환 시: pending save flush → `getNote(guid)` 로드 → 같은 인스턴스에 setContent (NoteWindow의 인스턴스 재사용 패턴).
- 저장: 자체 1500ms 디바운스 → `updateNoteFromEditor(guid, doc)`. 호스트와 guid가 다르므로 동시 저장 충돌 없음.
- `noteReloadBus` 구독(렌임 스윕 대응) + Firestore `attachOpenNote`/`detachOpenNote` 리프카운트 — 일반 열람과 동일 취급.
- 음악 노트를 펼치면 musicNotePlugin 인라인 ▶ 버튼이 그대로 동작 — 클릭 제스처 안에서 재생되므로 모바일 autoplay 제약 충족.
- 중첩 가드: `TomboyEditor`에 `enableNoteBundle` prop(기본 true, 임베디드 인스턴스엔 false) — 번들 안 번들은 리스트로만 보임 (depth 1).

### 상태 동기화

- 스크롤로 k 변경 → 호스트 doc에 라디오 tr(k 항목 `(o)`, 나머지 `( )`) → 호스트 저장 파이프라인이 영구화 → 재접속 시 그 자리부터 복원.
- 호스트 doc 변경(동기화 수신/직접 편집)으로 라디오가 바뀌면 → 플러그인 재파싱 → k 갱신 → 임베디드 에디터 노트 교체.

## 엣지 케이스

| 케이스 | 처리 |
|---|---|
| 링크 0개 (리스트 없거나 전부 비링크) | 체크해도 스택 대신 "묶을 노트 없음" 플레이스홀더, 리스트 숨기지 않음 |
| 전 항목 깨진 링크 | 회색 바만, 펼침 없음 |
| 펼친 노트가 외부에서 삭제됨 | reload 시 깨진 링크 전환, k는 다음 유효 항목으로 |
| 같은 노트 두 곳에서 열림 (창 + 번들) | 기존과 동일 last-write-wins. noteReloadBus가 상호 갱신. 설계상 허용 |
| 호스트 자신을 리스트에 넣음 | 엔트리 무시 (자기참조 가드) |
| 체크 상태로 Tomboy 데스크탑에서 열람 | `[x]노트 묶음:50` + 리스트 평문으로 보임, 라운드트립 무손상 |
| 모바일 키보드 | 임베디드 에디터 포커스 시 기존 keepCursorVisible 경로 그대로 (편집 기반 트리거만, vv 리스너 추가 금지) |

## 파일 구조

```
app/src/lib/editor/noteBundle/
├── parser.ts              # parseNoteBundles(doc) → BundleSpec[] (라이브 PMNode 워크)
├── noteBundlePlugin.ts    # 데코레이션 + 라디오 자동삽입/동기화 tr + 높이 써넣기
├── NoteBundleStack.svelte # 스택 UI + 임베디드 TomboyEditor + 스크롤/드래그
└── index.ts
```

- `TomboyEditor.svelte`: `enableNoteBundle` prop 추가, 플러그인 설치 분기.
- 설정 → 가이드 → 에디터 탭에 guide-card 추가 (사용자 발견 표면 — 필수).

## 테스트

vitest (`app/tests/unit/editor/noteBundle/`):

- `parser.test.ts`: 키워드 변형(`노트묶음`/`노트 묶음`/`:N` 유무), 체크박스/라디오 atom 워크, 링크 추출, 다중 번들, 자기참조 제외.
- `noteBundlePlugin.test.ts`: 체크 전환 시 라디오 자동삽입 tr, k 변경 라디오 동기화 tr, 높이 써넣기 tr, XML 라운드트립 무변경(아카이버 통과).
- 에디터 생성 테스트는 afterEach destroy 필수 (teardown flake 재발 방지).
- 스크롤/드래그/임베디드 저장 = 수동 검증 (`npm run dev`, e2e 없음).
