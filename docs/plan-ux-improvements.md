# UX 보완 구현 계획

여러 보완사항에 대한 구현 계획. 코드 작성 전 설계 검토 목적.

---

## 1. 뒤로가기 시 스크롤 복원 문제

### 현재 동작

- 노트 목록(`/`) → 노트 상세(`/note/[id]`) 이동 후 뒤로가기 하면,
  `+page.svelte`의 `onMount`에서 `listNotes()`를 새로 불러오며 스크롤 위치가 최상단으로 리셋됨.
- 내부 링크(`oninternallink`)로 노트 간 이동할 때도 매번 라우팅이 발생.

### 원인

- SvelteKit은 기본적으로 navigation 시 브라우저 스크롤 위치를 복원하지만,
  목록 페이지 컴포넌트가 **매번 unmount → mount** 되면서 데이터를 다시 로드하고,
  스크롤 복원 타이밍이 데이터 렌더링보다 앞서기 때문에 "위로 점프" 현상이 발생.
- 추가로 `onMount` 기반 비동기 로드는 "빈 목록 → 내용 채움" 순으로 DOM 높이가 변해서
  브라우저의 스크롤 복원이 무효화됨.

### 해결 방안 후보

#### A안. 스크롤 위치 직접 복원 (가장 실용적, 권장)

현재 아키텍처 유지하면서 보완:

1. **목록 데이터를 모듈 레벨 캐시**에 보관 (예: `$lib/stores/noteListCache.ts`에
   `let cached: NoteData[] | null`).
   - `+page.svelte` mount 시 캐시가 있으면 동기적으로 초기 렌더, 백그라운드에서 refresh.
   - 첫 렌더에 DOM 높이가 즉시 완성되므로 브라우저 스크롤 복원이 정상 동작.
2. **스크롤 위치 저장**: `.note-list` 스크롤 컨테이너의 `scrollTop`을
   `sessionStorage` 또는 모듈 변수에 navigation 직전에 저장 → mount 시 복원.
3. SvelteKit의 `afterNavigate`/`beforeNavigate` 훅 활용.

**장점**: 변경 범위 작음, 기존 라우팅/URL 구조 유지, 공유/새로고침 URL 동작 그대로.
**단점**: 캐시 무효화 규칙(저장/동기화/삭제 시) 관리 필요.

#### B안. Modal/Overlay 방식 (질문에서 제안한 "컨텐츠 위에 새로 올리기")

노트 상세를 라우트가 아닌 **오버레이 컴포넌트**로 목록 위에 띄움.

- 목록 페이지가 unmount 되지 않으므로 스크롤 자연히 유지.
- URL은 여전히 `/note/[id]`로 바뀌게 하려면 `pushState`로 history만 조작.

**장점**: 스크롤 문제 근본 해결, 전환 애니메이션 연출 쉬움.
**단점**:

- 현재 `routes/note/[id]/+page.svelte` 구조를 크게 바꿔야 함.
- 공유 링크로 직접 `/note/xxx` 진입 시 뒤에 깔릴 목록이 없음 → 별도 처리 필요.
- 모바일에서 스와이프로 뒤로가기 등 OS 제스처와 충돌 가능.
- SvelteKit의 중첩 라우팅이나 `$app/navigation` 흐름과 어긋나서 구현 복잡도↑.

#### C안. 일반적인 업계 관행

- **iOS/Android 네이티브**: 이전 화면이 메모리에 유지 → 스크롤 자동 복원. (=B안에 가까움)
- **Next.js / SvelteKit SPA**: 데이터 캐싱(SWR/TanStack Query 등) + 브라우저 scrollRestoration.
  즉 "데이터 즉시 채움 + 스크롤 복원"이 표준 패턴. (=A안)
- **Gmail / Twitter 웹**: URL은 바뀌지만 실제 DOM은 keep-alive 느낌으로 유지 (하이브리드).

### 권장

**A안(캐시 + 스크롤 저장)으로 진행**. 나중에 전환 애니메이션이 필요해지면 그때 B안을 검토.

### 구현 세부

- 새 파일: `app/src/lib/stores/noteListCache.ts`
  - `export let cachedNotes: NoteData[] | null = null;`
  - `export let cachedScrollTop = 0;`
  - `invalidate()`: 노트 생성/삭제/저장/동기화 훅에서 호출.
- `+page.svelte` 수정:
  - 초기값으로 `cachedNotes ?? []` 사용, `loading`은 캐시가 있으면 false.
  - mount 시 `.note-list` 요소에 `scrollTop = cachedScrollTop` 즉시 적용.
  - scroll 이벤트를 debounce하여 `cachedScrollTop`에 기록.
- 캐시 무효화 포인트:
  - `createNote`, `deleteNoteById`, `updateNoteFromEditor`, `sync()` 완료 후.
  - 또는 IDB write 시점에 단일 지점에서 invalidate 이벤트 발행.

---

## 2. 노트별 설정(옵션 메뉴)

### 요구사항

- 노트 편집 페이지 우측 상단 아이콘 → 탭 시 노트별 액션 메뉴.
- 초기 액션 항목:
  - 삭제
  - 즐겨찾기 토글 (데이터 모델만 준비, UI는 표시만)
  - 홈으로 지정 (데이터 모델만 준비)
- 후속 확장을 고려해 "액션 목록"을 쉽게 늘릴 수 있는 구조로.

### UI 설계

- `routes/note/[id]/+page.svelte`의 `.editor-header`에
  기존 뒤로가기 버튼 반대편(우측)에 "⋮" (kebab) 또는 "⚙" 아이콘 추가.
- 클릭 시 **바텀 시트** 또는 드롭다운 메뉴 표시.
  - 모바일 퍼스트 원칙에 따라 **바텀 시트** 권장(손가락 닿는 위치, 큰 탭 타깃).
- 새 컴포넌트: `app/src/lib/editor/NoteActionSheet.svelte`
  - `interface Props { note: NoteData; onaction: (kind: ActionKind) => void; onclose: () => void }`
  - `ActionKind = 'delete' | 'toggleFavorite' | 'setHome'`
- 삭제는 confirm 다이얼로그 대신 "실행 취소" 토스트 패턴이 모바일에서 더 자연스러우나,
  1차 구현은 단순한 `confirm()` 대체용 인라인 확인 UI로 둠 (한국어 "삭제하시겠습니까?").
  - 단, 브라우저 모달 대화상자는 PWA 환경에서 포커스 문제가 있으므로 커스텀 구현.

### 데이터 모델 변경

#### 즐겨찾기

- Tomboy 원본은 `system:pinned` 태그를 사용. 이 태그 규칙을 그대로 따름.
- `NoteData.tags`에 `system:pinned` 추가/제거로 관리.
- `.note` XML 왕복 호환성 유지됨.

#### 홈 지정

- Tomboy에는 "시작 시 열기"(`openOnStartup` 필드)가 이미 존재. 이것과 구분되는 "홈"을 새로 만들지,
  아니면 `openOnStartup`을 홈으로 재해석할지 결정 필요.
- **제안**: 별개 개념으로 두되, 전역에 **단 하나의 "홈 노트"**만 존재.
  - 저장소: `localStorage` 또는 `syncManifest` 확장이 아닌 별도 IDB `appSettings` 스토어에
    `{ id: 'homeNoteGuid', value: guid }` 형태로 저장.
  - 홈 노트 지정 시 기존 홈 지정 해제.
  - 이후 `/` 진입 시 홈 노트로 자동 리다이렉트 옵션(기본 off)은 별도 설정으로.
- **.note XML에 저장하지 않음**: 클라이언트 로컬 설정으로 간주. (동기화되지 않음.)
  - 만약 동기화 필요하면 태그 `system:home`으로 승격 가능 (후속 과제).

### 액션 구현 요약

| 액션     | 위치                                      | 주요 변경                         |
| -------- | ----------------------------------------- | --------------------------------- |
| 삭제     | `noteManager.deleteNoteById` 기존 활용  | 확인 UI만 추가                    |
| 즐겨찾기 | `noteManager.toggleFavorite(guid)` 신규 | tags에서 `system:pinned` toggle |
| 홈 지정  | `appSettings.setHomeNote(guid)` 신규    | 새 IDB 스토어 필요                |

### 새 파일 / 수정 대상

- 신규: `app/src/lib/editor/NoteActionSheet.svelte`
- 신규: `app/src/lib/storage/appSettings.ts` (+ `db.ts`에 `appSettings` 스토어 추가, DB_VERSION 3으로 bump)
- 수정: `app/src/routes/note/[id]/+page.svelte` (헤더 아이콘, 액션 핸들러)
- 수정: `app/src/lib/core/noteManager.ts` (`toggleFavorite`)

---

## 3. 카테고리(노트북) 기능

### Tomboy의 기존 개념

- 원본 Tomboy에는 **Notebook**이라는 개념이 이미 있음.
- 태그 기반: `system:notebook:<이름>` 태그가 붙은 노트가 해당 노트북 소속.
- 노트북 자체를 표현하는 "Template Note"가 존재(`system:template` + `system:notebook:<이름>`).
- 현재 홈 화면(`+page.svelte` line 62)에 `getNotebook()`이 이미 구현되어 있어 **표시만** 되고 있음.
  생성/편집 UI는 없음.

### 기능 범위 (1차)

1. 노트북 **목록**: 모든 노트에서 `system:notebook:*` 태그를 스캔해 고유한 노트북 이름 수집.
2. 노트북 **생성**: 이름만 입력 → 내부적으로 Template Note를 만들거나 단순 "이름 레지스트리"에 추가.
3. 노트북 **지정/해제**: 노트 액션 시트(기능 #2)에 "노트북 이동" 항목 추가.
   - 하나의 노트는 **단 하나의 노트북**에만 속함(Tomboy 관례).
4. 홈 화면 **필터링**: 노트북별로 목록 필터. 사이드 드로어 또는 상단 탭.
5. 노트북별 **색상/아이콘**: 1차에서는 제외, 이름만.

### 데이터 모델 결정

**권장: Tomboy 원본과 동일하게 태그 기반.**

- `NoteData.tags`에 `system:notebook:<이름>` 추가. 하나만 유지(중복 제거 필요).
- 노트북 **생성 동작**의 정의:
  - (옵션 A) 템플릿 노트를 만든다(`system:template` + `system:notebook:<이름>`)
    → Tomboy desktop과 완전 호환. 노트북이 "존재"한다는 서버 측 근거가 생김.
  - (옵션 B) 태그가 붙은 노트가 하나도 없어도 "빈 노트북"을 허용 → `localStorage` 또는
    `appSettings`에 이름 목록 저장.
- **제안**: A안을 채택하되, 템플릿 노트는 목록에서 감춤(`getAllNotes`에서 `system:template` 필터).
  - 호환성 + 동기화 자연 유지.

### UI 설계

- **홈 화면**:
  - 상단에 노트북 필터 칩(chip) 행 또는 햄버거 드로어.
  - "📓 전체" / "📓 Work" / "📓 Personal" / "➕ 새 노트북".
  - 모바일 우선이라 **상단 가로 스크롤 칩** 추천.
- **노트별 노트북 변경**:
  - 액션 시트 > "노트북 이동" > 노트북 선택 모달(현재 목록 + 새로 만들기).
- **노트북 관리 페이지** (후속):
  - `/settings` 또는 `/notebooks`에서 이름 변경/삭제.

### 구현 세부

#### 새 모듈: `app/src/lib/core/notebooks.ts`

```
listNotebooks(): Promise<string[]>              // 중복 없이 정렬
createNotebook(name: string): Promise<void>     // 템플릿 노트 생성 (옵션 A)
deleteNotebook(name: string): Promise<void>     // 템플릿 삭제 + 해당 태그 가진 노트들 태그 제거(또는 유지?)
assignNotebook(guid: string, name: string | null): Promise<void>  // null이면 해제
```

#### `noteStore.ts` 변경

- `getAllNotes()`가 `system:template` 태그를 제외하도록 필터 추가.
- 성능이 문제되면 `by-notebook` IDB 인덱스 추가 가능(1차에서는 제외, 메모리 필터로 충분).

#### `+page.svelte` 변경

- 상단 노트북 칩 렌더.
- 선택된 노트북에 따라 `notes` 필터링(`$derived`).
- 선택 상태는 `sessionStorage` 또는 URL 쿼리스트링 `?nb=Work`로 보존(뒤로가기 호환).

#### 충돌/엣지 케이스

- 동일 노트에 `system:notebook:*`이 2개 이상 달린 레거시 데이터 → 첫 번째만 사용, 나머지 제거하는
  1회성 마이그레이션.
- 노트북 이름 XML escape (콜론 금지, 슬래시는 Tomboy 관례상 하위 노트북인지 확인 필요).
- 삭제 시 포함된 노트 처리:
  - "노트북만 삭제, 노트는 남김"(태그 제거) 또는 "노트 통째로 삭제" 중 선택.
  - 1차는 **태그만 제거** (데이터 보존 우선).

### 새 파일 / 수정 대상

- 신규: `app/src/lib/core/notebooks.ts`
- 신규: `app/src/lib/components/NotebookChips.svelte` (홈 화면 상단)
- 신규: `app/src/lib/components/NotebookPicker.svelte` (노트별 선택 모달)
- 수정: `app/src/routes/+page.svelte` (필터 UI + 로직)
- 수정: `app/src/lib/storage/noteStore.ts` (템플릿 노트 제외 필터)
- 수정: `app/src/lib/editor/NoteActionSheet.svelte` (#2에서 생성된 시트에 항목 추가)

---

---

## 4. 내부 링크로 인한 "빈 노트" 스텁 문제 (긴급도: 높음)

### 증상

동기화가 불완전한 상태에서 노트의 내부 링크(`[[제목]]`)를 누르면 해당 제목의 스텁
(빈 노트)이 로컬에 생성되고, 목록에 끼어 들어 혼란을 줌.

### 원인

`app/src/lib/core/noteManager.ts`의 `resolveOrCreateNoteByTitle`:

```
const existing = await noteStore.findNoteByTitle(title);
if (existing) return existing;
return createNote(title);
```

로컬 IDB에서만 제목을 찾음. 서버엔 원본이 있으나 아직 다운로드 안 된 상태에선 undefined → 새 GUID로 빈 노트 생성. `createNote`는 `putNote`로 저장하므로 `localDirty=true` → 다음 동기화에서 중복 제목의 빈 파일이 업로드됨.

### 데이터 안전성 (원본 덮어쓰기 여부)

- **덮어쓰지 않음**. 서버 파일 경로는 GUID 기반이라 다른 GUID로는 원본 파일을 덮을 수 없음.
- 업로드되더라도 "제목 같은 노트 2개"가 Dropbox에 공존할 뿐.
- 원본은 다음 동기화에서 로컬로 정상 다운로드됨 (다른 GUID로).

### 복구 방법 (사용자 가이드)

1. Dropbox의 `{rev/100}/{rev}/*.note` 폴더는 건드리지 않음 — 원본은 그대로.
2. 로컬의 빈 스텁 노트를 식별해 삭제:
   - 목록에서 육안으로 빈 것 삭제.
   - 이미 동기화된 경우 삭제 후 재동기화하면 서버에서도 tombstone 처리됨.
3. 최악의 경우 DevTools → Application → IndexedDB → `tomboy-web` 삭제 후
   전체 재동기화하면 서버 원본으로 완전 복구.

### 수정 방침

**내부 링크 클릭은 "탐색"이지 "생성"이 아니다.** 노트 생성은 명시적 경로(목록 FAB,
Extract-note)로만 수행. 링크가 가리키는 노트가 없으면 "없음"을 알려주고 멈춤.

1. **`resolveOrCreateNoteByTitle` 제거 / 이름 변경** → `findNoteByTitle`만 사용.
   - `+page.svelte`의 `handleInternalLink`에서:
     - 찾으면 → `goto`.
     - 없으면 → **토스트**로 "'{title}' 노트를 찾을 수 없습니다." 안내. 이동 없음.
   - `noteManager.resolveOrCreateNoteByTitle`는 호출부 없어지면 삭제.
2. **기존 스텁 정리**: 이미 만들어진 스텁들을 정리할 수단 제공.
   - 목록에서 수동 삭제가 1차 수단. 배지로 식별 쉽게.
   - (선택) 설정 화면에 "빈 노트 일괄 정리" 버튼 — 제목 외 내용 없고 `changeDate === createDate`인 노트만 대상.
     - 유저 의견: 바로 삭제하지 않고 검토할 수 있게 필터링 기능의 일부로 만들어줘.
3. **동기화 시 동명 병합은 보류**:
   - 더 이상 스텁이 새로 생기지 않으므로 자동 병합 로직 없이도 문제 축소.
   - 다만 이미 서버에 업로드되어 버린 스텁이 있을 수 있어 수동 삭제가 가장 확실.
4. **토스트 UI**: 현재 프로젝트에 공용 토스트 컴포넌트 없음. 간단한 `Toast.svelte`와
   store(`$lib/stores/toast.ts`)를 신규 추가. 짧은 텍스트, 자동 닫힘, 상단/하단 고정.

### 새 파일 / 수정 대상

- 수정: `app/src/lib/core/noteManager.ts` (`resolveOrCreateNoteByTitle` 삭제)
- 수정: `app/src/routes/note/[id]/+page.svelte` (`handleInternalLink`가 없음 처리)
- 신규: `app/src/lib/components/Toast.svelte`, `app/src/lib/stores/toast.ts`
- (선택) `app/src/routes/settings/+page.svelte` (빈 노트 일괄 정리)

### 구현 우선순위

이 문제는 **데이터 혼란**을 일으키므로 #2 액션 시트보다 먼저, 또는 적어도 동시에 처리 권장.

---

## 5. 상단 네비게이션 바 (4개 뷰)

### 개념

앱 전반의 진입점을 **4개 탭**으로 재편:

| 탭            | 종류     | 설명                                                       |
| ------------- | -------- | ---------------------------------------------------------- |
| 🏠 홈         | 노트형   | 홈으로 지정된 노트 1개 표시. 미지정 시 최근 수정 노트.     |
| 📄 전체 목록  | 리스트형 | 모든 노트(삭제 제외, 템플릿 제외). 현재 `/`의 확장판.    |
| 🗂 카테고리별 | 리스트형 | 노트북 선택 후 해당 노트북 노트 표시.                      |
| 🎲 랜덤 노트  | 노트형   | 매번 다른 노트를 무작위로 1개 표시. 새로고침 시 다시 뽑기. |

### UI 배치

- **상단 vs 하단**: 모바일 퍼스트라면 **하단 탭 바**가 자연스럽지만, 개별 노트 편집 화면에서 툴바가 이미 하단에 있음. 충돌 방지를 위해 **상단 탭 바**(목록 계열 화면 전용) 또는 **하단 탭 바이되 노트 편집 시 숨김** 중 선택.
  - 제안: **하단 탭 바**. 편집 화면에선 툴바가 탭 바를 대체(탭 바 숨김, 뒤로가기로 탭 바 복귀).
- 탭 아이콘 + 라벨. 활성 탭 강조.
- 라우트 구조:
  - `/` → 홈 탭 (홈 노트로 직접 렌더, 리다이렉트가 아닌 내부 컴포넌트 전환).
  - `/notes` → 전체 목록.
  - `/notebooks` → 카테고리 선택 → `/notebooks/[name]`.
  - `/random` → 랜덤 노트.
  - `/note/[id]` → 기존 편집 화면(탭 바 숨김).

### 노트형 뷰 (홈 / 랜덤)

- 편집 화면과 동일한 컴포넌트 재사용. 단, URL이 `/note/[id]`가 아니므로:
  - 홈: `/`에서 홈 노트 guid를 resolve 후 `TomboyEditor` 재사용.
  - 랜덤: 진입 시 `getAllNotes()`에서 무작위 선택 → `TomboyEditor`에 주입.
- 랜덤 노트 화면에는 "🎲 다시 뽑기" 버튼. 노트가 0개면 안내 문구.
- 홈 노트가 삭제되었거나 미지정일 때 fallback: **가장 최근 `changeDate`** 노트.

### 리스트형 뷰 (전체 / 카테고리별)

- 공통 리스트 컴포넌트로 통합: `NoteList.svelte`.
  - `Props: { notes: NoteData[]; sortBy: SortKey }`
  - `SortKey = 'changeDate' | 'createDate'`
- **정렬 드롭다운** 리스트 상단 우측:
  - "최근 수정순" (`changeDate` 내림차순, 현재 기본)
  - "생성순" (`createDate` 내림차순)
  - (후속) "제목 오름차순"
- 정렬 선택은 각 뷰별로 `sessionStorage` 또는 URL 쿼리 `?sort=created` 에 저장.

### 카테고리별 뷰

- 진입 화면은 **카테고리 목록**: 노트북 이름 + 해당 노트 개수.
- 특정 노트북 클릭 → `/notebooks/[name]` → 필터된 리스트.
- "노트북 없음(미지정)" 항목도 가상 카테고리로 노출.

### 새 파일 / 수정 대상

- 신규: `app/src/lib/components/TabBar.svelte`
- 신규: `app/src/lib/components/NoteList.svelte` (전체/카테고리 공용)
- 신규: `app/src/routes/notes/+page.svelte` (전체 목록)
- 신규: `app/src/routes/notebooks/+page.svelte`, `/notebooks/[name]/+page.svelte`
- 신규: `app/src/routes/random/+page.svelte`
- 수정: `app/src/routes/+page.svelte` (홈 노트 렌더로 전환)
- 수정: `app/src/routes/+layout.svelte` (탭 바 조건부 렌더)

### 상호 의존

- 카테고리별 뷰는 **#3 노트북 기능**이 선행돼야 함.
- 홈 탭은 **#2 홈 지정**이 선행돼야 함 (미지정 fallback만 쓴다면 독립 가능).

---

## 6. 개별 노트의 카테고리 표시 / 변경

**#2 노트 액션 시트 및 #3 노트북 기능과 합류**. 여기서는 요구사항만 명시:

- 편집 화면 헤더에 노트북 이름 칩(있을 때만). 탭 시 변경 모달(#3의 `NotebookPicker`).
- 액션 시트 메뉴에도 "노트북 이동" 항목.
- 변경 시 `system:notebook:<이름>` 태그 치환. 기존 `system:notebook:*` 태그는 모두 제거 후 추가 1개(또는 해제).
- 해제 옵션 "없음" 제공.

특별히 #2·#3 계획에 이미 포함된 내용이라 신규 파일 없음.

---

## 7. 세밀한 동기화 컨트롤 (git push/pull 스타일)

### 동기 vs 비동기 동작 비교

현재 "지금 동기화" 버튼은 **fetch + diff + push + commit**을 한 번에 수행. 사용자 검토 지점이 없음.

### 목표

- 동기화 전에 **무엇이 올라가고 무엇이 내려오는지** 미리 보기.
- 필요 시 **부분 선택**(특정 노트만 업로드/다운로드) — 이건 Tomboy 프로토콜상 일부 제약 있음(아래).
  - 유저 의견: 중요한 건 업로드. 다운로드는 이미 올라간 것이기 때문에 충돌만 없으면 모두 다운해도 됨. 문제는 잘못 된 파일이 업로드 되는 것이라서 업로드 하게 되는 파일들을 목록을 보고 어떤 내용이 올라가는지 확인할 수 있으면 좋겠음(diff 같은 기능)

### Tomboy 프로토콜의 제약

- 서버는 `(revision, serverId)`와 `(guid, rev)` 목록만 갖고 있음.
- 업로드는 **새 revision**을 만들고 그 revision 안에 포함된 노트들 + 삭제된 GUID를 한꺼번에 반영. 즉 **커밋 단위**.
- 따라서 "일부 노트만 업로드"는 가능하지만 "나머지 업로드는 보류한 채 한 번에 커밋"하는 개념. 여러 번 나눠 커밋하면 revision이 쪼개지기만 할 뿐 기능상 가능.
- "일부 노트만 다운로드"도 가능. 다만 `localManifest.noteRevisions`에는 내려받은 것만 기록해, 다운받지 않은 노트는 다음 번에 계속 "다운로드 대상"으로 남음.

### 단계 분리

동기화를 **3단계 상태기계**로 재구성:

1. **Plan** (계산): 서버 manifest 다운로드 후 변화 계산만. 실제 I/O 없음.
   - 출력: `SyncPlan` 객체 `{ toDownload, toUpload, toDeleteRemote, toDeleteLocal, conflicts }`
2. **Review** (사용자 확인): Plan을 UI에 표시. 각 항목 체크박스로 포함/제외.
3. **Apply** (실행): 선택된 항목만 다운로드 + 업로드 커밋.

### `SyncPlan` 데이터 구조

```
interface SyncPlan {
    serverRev: number;
    serverId: string;
    toDownload: Array<{ guid: string; title?: string; rev: number; reason: 'new' | 'updated' | 'conflict-remote-wins' }>;
    toUpload:   Array<{ guid: string; title: string; reason: 'new' | 'updated' }>;
    toDeleteRemote: Array<{ guid: string; title?: string }>;   // 로컬에서 삭제됨 → 서버에서 제거
    toDeleteLocal:  Array<{ guid: string; title: string }>;    // 서버에서 사라짐 → 로컬에서 제거
    conflicts: Array<{ guid: string; title: string; localDate: string; remoteDate: string; suggested: 'local' | 'remote' }>;
}
```

### UI 설계

- 설정 화면(또는 전용 `/sync` 화면)에서:
  - **[미리보기]** 버튼 → Plan 조회 → 화면에 목록.
  - 각 섹션: ⬇ 다운로드 / ⬆ 업로드 / 🗑 삭제(원격) / 🗑 삭제(로컬) / ⚠️ 충돌.
  - 각 항목 체크박스(기본 전부 체크).
  - 충돌 항목은 local/remote 선택 라디오 버튼.
- **[동기화 실행]** 버튼 → 선택된 항목만 Apply.
- 기존 "지금 동기화" 버튼은 유지(빠른 전체 동기화, "전부 선택 후 실행"과 동등).

### `syncManager` 리팩터링

- 현재 `sync()` 한 함수에 모든 로직 → 분리:
  - `computePlan(): Promise<SyncPlan>`
  - `applyPlan(plan: SyncPlan, selection: PlanSelection): Promise<SyncResult>`
  - `sync()` = `applyPlan(await computePlan(), ALL)` 유지(역호환).
- `computePlan`은 순수 조회성. 실패해도 사이드이펙트 없음.
- `applyPlan`은 내부적으로 기존 step 2~5를 수행하되 selection에 따라 필터.

### 충돌 처리 UX

- 현재는 last-write-wins(changeDate 비교). Plan 단계에서 drop-down으로 사용자가 명시적으로 선택 가능하게. 기본값은 기존 규칙과 동일하게 제안.

### 엣지 케이스

- **부분 업로드 후 일부 남김**: 새 revision에 선택된 노트만 들어가고, 업로드 안 한 노트는 로컬에서 여전히 `localDirty=true`. 다음 Plan에서 다시 "업로드 대상"으로 나타남. 문제없음.
- **부분 다운로드 후 일부 남김**: 해당 guid는 `localManifest.noteRevisions`에 기록 안 됨 → 다음 Plan에서 다시 "다운로드 대상"으로 나타남.
- **서버 reset (serverId 변경)**: Plan 단계에서 감지되면 경고 배너. 사용자가 인지 후 진행해야 현재처럼 manifest 재생성.
- **오프라인/인증 실패**: Plan 단계에서 즉시 감지·알림. Apply 이전에 걸러짐.

### 새 파일 / 수정 대상

- 수정(주요): `app/src/lib/sync/syncManager.ts` (`computePlan`, `applyPlan` 분리)
- 수정: `app/src/routes/settings/+page.svelte` (미리보기 진입점)
- 신규(선택): `app/src/routes/sync/+page.svelte` (전용 화면) 또는 `SyncPlanView.svelte` 컴포넌트
- 신규: `app/src/lib/components/SyncPlanView.svelte`

### 구현 우선순위

독립성이 높아 #1~#4와 병행 가능. 그러나 규모가 커서 **2단계**로 쪼개는 편이 실용적:

- 7-a: `computePlan` + 읽기 전용 미리보기 UI (체크박스 없음, 전부 진행).
- 7-b: 체크박스 선택 + 충돌 해결 UI 추가.

---

## 전체 구현 순서 제안

1. **#4 빈 스텁 문제 — 긴급**. 데이터 안전성 이슈는 아니지만 사용자 혼란이 큼.
2. **기반 작업** — `appSettings` IDB 스토어 추가, DB_VERSION 3 마이그레이션.
3. **#2 노트 액션 시트** 뼈대 구현 (삭제/다시 다운받기만 먼저).
4. **#1 스크롤 복원** — 독립적이라 언제 해도 무방. #2와 병행 가능.
5. **#3 노트북 기능** — #2 액션 시트에 항목으로 얹히는 구조라서 #2 이후.
6. **#6 개별 노트 카테고리 표시/변경** — #2·#3 합류.
7. **#2 확장** — 즐겨찾기 / 홈 지정 추가. 홈 지정은 #5 홈 탭 전제.
8. **#5 상단 네비게이션** — #3, 홈 지정 완료 후. 규모 크므로 리스트형 뷰부터.
9. **#7 세밀한 동기화(7-a)** — 미리보기만 먼저. 체크박스 선택(7-b)은 별도 단계.

## 공통 고려사항

- **동기화 영향**:
  - 태그 변경(#2 즐겨찾기, #3 노트북)은 `.note` XML에 반영되므로 `localDirty=true`가 찍혀
    다음 동기화 시 자연스럽게 업로드됨. 별도 처리 불필요.
  - 홈 지정은 로컬 전용.
  - 템플릿 노트 생성(#3)은 일반 노트 생성과 동일 경로로 처리되므로 기존 업로드 흐름 그대로.
- **UI 일관성**: 바텀 시트, 칩, 모달 모두 기존 컬러 토큰(`--color-*`) 사용.
- **Svelte 5 runes** 규칙 준수(`$state`, `$derived`, `$props`, `$effect`).
- **테스트 불가능 영역**: 동기화 상호작용은 수동 테스트 (`settings > 지금 동기화`).
