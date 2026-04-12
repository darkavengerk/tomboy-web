# 10. 글로벌 상단 네비게이션 통합

## 목표

페이지마다 제각각이던 상단 바와 하단 탭바를 제거하고, `+layout.svelte`에서 단일 `TopNav` 컴포넌트를 렌더해 전 화면에서 동일한 네비게이션을 제공한다.

## 배경 / 의사결정

- **현재 문제**
  - 페이지마다 다른 `<header>` 구현(`+page.svelte`, `/notes`, `/notebooks`, `/notebooks/[name]`, `/settings`, `/note/[id]`) — 색/높이/버튼 배치가 제각각.
  - 하단 `TabBar`는 일부 경로(`/note/*`, `/search`, `/settings`)에서 숨겨져 있어 일관성이 떨어짐.
  - 세부 페이지의 "뒤로가기" 버튼이 실제로는 고정된 경로(`/`, `/notebooks`)로 이동 — 브라우저 히스토리와 불일치, 사용자 멘탈 모델과 어긋남.
- **결정**
  1. 모든 페이지 상단에 전역 `TopNav` 1개. 기본 디자인은 **현재 홈(`/`) 상단 바**(높이/프라이머리 배경/흰 글자/우측 아이콘 버튼)를 기준.
  2. 주요 섹션 메뉴는 **홈 / 전체** 두 개로 축소.
     - 노트북(카테고리) 별 보기는 `/notes` 안으로 통합(필터 UI). 별도 라우트 제거.
     - 랜덤 보기는 홈 화면의 플로팅 버튼으로 이동(우측 상단).
  3. 개별 노트(`/note/[id]`)에서도 동일한 `TopNav` 유지. 기존의 "노트 제목을 상단에 그대로 표시"는 제거(제목은 편집기 첫 줄이 이미 그 역할).
  4. 상단 좌측에 **실제** 뒤로/앞으로 버튼(브라우저 히스토리 기반). 홈/전체는 상단 메뉴에서 직접 이동 가능하므로 홈 아이콘은 없음.

## 완료 조건 (Acceptance)

- [ ] `TopNav.svelte`가 `+layout.svelte`에서 단 한 번 렌더되고, 모든 라우트에서 동일한 바가 보인다.
- [ ] 페이지별 `<header>`가 `/`, `/notes`, `/notebooks/[name]`, `/settings`, `/note/[id]`에서 제거됨.
- [ ] `TabBar.svelte`와 관련 렌더/조건부 분기 삭제.
- [ ] 상단 메뉴 링크는 `홈(/)`, `전체(/notes)` 2개. active 하이라이트는 `page.url.pathname`으로 결정.
- [ ] `/notes`에서 노트북별 필터(드롭다운 또는 칩)가 작동하고, 기존 `/notebooks`, `/notebooks/[name]` 라우트는 `/notes?notebook=xxx`로 리다이렉트 혹은 제거.
- [ ] 홈(`/`) 우측 상단에 🎲 랜덤 플로팅 버튼. 클릭 시 기존 `/random` 로직(랜덤 노트로 이동)을 수행.
- [ ] `TopNav` 좌측의 뒤로가기는 `history.back()`, 앞으로가기는 `history.forward()`를 호출. 진입 후 첫 화면(히스토리 깊이 0~1)에선 뒤로가기 비활성(disabled).
- [ ] 노트 상세(`/note/[id]`) 화면에 별도의 노트 제목 헤더 없음 — 편집기만 바로 렌더.
- [ ] 모든 UI 문자열 한국어 유지.

## 선행 / 영향 범위

- 선행: 없음(문서 08의 하단 탭 구현을 대체).
- 수정: `app/src/routes/+layout.svelte`, `/+page.svelte`, `/notes/+page.svelte`, `/note/[id]/+page.svelte`, `/settings/+page.svelte`.
- 삭제 또는 축소: `app/src/lib/components/TabBar.svelte`, `app/src/routes/notebooks/**`, `app/src/routes/random/**`.
- 신규: `app/src/lib/components/TopNav.svelte`, `app/src/lib/nav/history.ts`(히스토리 깊이 추적 헬퍼).

## TDD 원칙 (반드시 이 순서로)

> **모든 단계에서 "테스트 먼저 작성 → 실패 확인(RED) → 구현으로 통과(GREEN) → 리팩터"** 흐름을 지킨다.
> 테스트 커밋과 구현 커밋을 섞지 않는다.

테스트가 아직 없으면, 실패 출력(예: `cannot find module`, `expected ... to be ...`)을 커밋 메시지 혹은 PR 본문에 붙여 RED를 명시적으로 남긴다.

## Red: 먼저 작성할 테스트

### 1) `tests/unit/nav/history.test.ts` — 히스토리 깊이 트래커

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createHistoryTracker } from '$lib/nav/history';

describe('history tracker', () => {
  beforeEach(() => {
    // reset module state if needed
  });

  it('starts with canGoBack=false on first navigation', () => {
    const h = createHistoryTracker();
    h.onNavigate('/');
    expect(h.canGoBack()).toBe(false);
    expect(h.canGoForward()).toBe(false);
  });

  it('enables back after a forward navigation', () => {
    const h = createHistoryTracker();
    h.onNavigate('/');
    h.onNavigate('/notes');
    expect(h.canGoBack()).toBe(true);
  });

  it('enables forward after going back', () => {
    const h = createHistoryTracker();
    h.onNavigate('/');
    h.onNavigate('/notes');
    h.goBack();
    expect(h.canGoForward()).toBe(true);
  });
});
```

### 2) `tests/unit/components/TopNav.test.ts` — 컴포넌트 렌더/상호작용

`@testing-library/svelte`는 이미 3단계에서 도입됨.

- `it('renders 홈 / 전체 links and marks active by pathname', ...)`
- `it('disables back button when canGoBack is false', ...)`
- `it('calls history.back on back-button click', ...)`
- `it('does not render a page-specific title header inside note route', ...)` (루트별 렌더는 레이아웃 수준이므로, 이 테스트는 `TopNav`의 props로 전달되는 title이 없음을 보장)

샘플:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import TopNav from '$lib/components/TopNav.svelte';

it('뒤로가기 버튼은 canGoBack=false일 때 비활성화', () => {
  render(TopNav, { canGoBack: false, canGoForward: false, pathname: '/' });
  expect(screen.getByLabelText('뒤로가기')).toBeDisabled();
});

it('뒤로가기 클릭 시 onback 콜백 호출', async () => {
  const onback = vi.fn();
  render(TopNav, { canGoBack: true, canGoForward: false, pathname: '/notes', onback });
  await userEvent.click(screen.getByLabelText('뒤로가기'));
  expect(onback).toHaveBeenCalledOnce();
});

it('홈/전체 링크만 렌더되고 랜덤/노트북 링크는 없다', () => {
  render(TopNav, { canGoBack: false, canGoForward: false, pathname: '/' });
  expect(screen.getByRole('link', { name: '홈' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '전체' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '노트북' })).toBeNull();
  expect(screen.queryByRole('link', { name: '랜덤' })).toBeNull();
});
```

### 3) `tests/unit/routes/notes-filter.test.ts` — `/notes`의 노트북 필터

- `it('filters notes by selected notebook', ...)` — 노트북 필터 순수 함수를 추출해 테스트.
  예: `filterByNotebook(notes, null)` → 전체, `filterByNotebook(notes, '업무')` → 업무 노트만.

### 4) 수동 테스트(문서화)

다음은 단위 테스트로 검증하기 어려우므로 체크리스트로 대체:

- [ ] 홈 → 전체 → 개별 노트 → 뒤로 → 뒤로 순서로 이동 시 브라우저 주소와 화면 일치.
- [ ] PWA 설치 상태에서도 세이프 에어리어가 `TopNav` 상단에 반영됨.
- [ ] 오프라인 배너가 `TopNav` 위에 덮이지 않음(z-index).

## Green: 구현 포인트

### 네비게이션 히스토리 헬퍼

`app/src/lib/nav/history.ts`

```ts
import { writable, type Readable } from 'svelte/store';

export interface NavState {
  canGoBack: boolean;
  canGoForward: boolean;
}

// SvelteKit의 afterNavigate에서 호출할 수 있는 얇은 래퍼.
// 내부 스택은 pushState/popState를 직접 관찰하지 않고, 상대 깊이만 추적한다.
export function createNavStore(): {
  state: Readable<NavState>;
  onNavigate: (type: 'enter' | 'popstate') => void;
  goBack: () => void;
  goForward: () => void;
} {
  // … 아래 구조는 테스트가 요구하는 API에 맞춰 작성
}
```

포인트:
- `history.length`는 동일 origin 다른 탭 방문 내역까지 포함하므로 신뢰 금지. 대신 **앱이 시작된 시점의 depth=0**을 기준으로 상대 변화만 추적.
- `afterNavigate({ type })`의 `type === 'enter'`(초기 진입) vs `'link' | 'goto' | 'popstate' | 'form'` 구분하여 depth 증감.

### `TopNav.svelte` 시그니처

```svelte
<script lang="ts">
  interface Props {
    pathname: string;
    canGoBack: boolean;
    canGoForward: boolean;
    onback?: () => void;
    onforward?: () => void;
  }
  let { pathname, canGoBack, canGoForward, onback, onforward }: Props = $props();
  const items = [
    { href: '/', label: '홈' },
    { href: '/notes', label: '전체' }
  ];
  function isActive(href: string) {
    return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
  }
</script>

<header class="topnav">
  <div class="nav-left">
    <button aria-label="뒤로가기" disabled={!canGoBack} onclick={onback}>‹</button>
    <button aria-label="앞으로가기" disabled={!canGoForward} onclick={onforward}>›</button>
  </div>
  <nav class="nav-center">
    {#each items as it (it.href)}
      <a href={it.href} class:active={isActive(it.href)} aria-current={isActive(it.href) ? 'page' : undefined}>{it.label}</a>
    {/each}
  </nav>
  <div class="nav-right">
    <a href="/search" aria-label="검색">🔍</a>
    <a href="/settings" aria-label="설정">⚙</a>
  </div>
</header>
```

스타일은 현재 `/+page.svelte`의 `.header`(프라이머리 배경, 흰 글자, safe-area top) 규칙을 가져온다.

### `+layout.svelte` 변경

```svelte
<script lang="ts">
  import TopNav from '$lib/components/TopNav.svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';

  let canGoBack = $state(false);
  let canGoForward = $state(false);

  afterNavigate(({ type }) => {
    // depth 추적 로직 — nav/history.ts에 위임
  });

  function back() { history.back(); }
  function forward() { history.forward(); }
</script>

<TopNav pathname={page.url.pathname} {canGoBack} {canGoForward} onback={back} onforward={forward} />
<!-- TabBar 제거 -->
```

### 홈 FAB(랜덤)

`/+page.svelte`의 기존 `.fab`(새 노트)과 충돌하지 않도록, 새 노트는 좌하단 또는 동일 위치 유지하되 **상단 우측**에 🎲 랜덤 FAB을 추가.

```svelte
<button class="fab-random" onclick={gotoRandom} aria-label="랜덤 노트">🎲</button>
```

`gotoRandom`은 기존 `/random` 라우트의 로직(`listNotes` → 랜덤 하나 선택 → `goto(/note/<guid>)`)을 인라인화하거나 `$lib/core/random.ts`로 추출.

### `/notes`의 노트북 필터

- 순수 함수 `filterByNotebook(notes, name | null)`를 `$lib/core/notebooks.ts`에 추가.
- URL 쿼리 `?notebook=xxx`와 동기화(`page.url.searchParams`).
- 노트북 목록은 기존 `listNotebooks()` 재사용. 상단에 칩/드롭다운 렌더.

### 라우트 정리

- `/notebooks`, `/notebooks/[name]`, `/random` 디렉토리 삭제.
- 기존 내부 링크에서 이 경로를 참조하는 코드 grep 후 `/notes?notebook=...` 혹은 홈 FAB로 교체.

## Refactor / 엣지 케이스

- **직접 URL 진입**(`/note/abc`를 새 탭에서 열기)에서 뒤로가기는 비활성화되어야 한다. `afterNavigate`의 첫 `type === 'enter'`를 depth 0으로 처리.
- **note 편집 중 이탈**: 기존 `beforeNavigate` 저장 로직은 그대로 두되, `TopNav`의 뒤로가기도 내부적으로 `goto(history.back())`이 아니라 `history.back()`을 직접 호출해 같은 저장 훅을 타도록.
- **오프라인/설치 배너**와 `TopNav`의 z-index/위치 충돌 확인. 배너는 `TopNav` 아래(혹은 위 고정)로 일관되게.
- **키보드 포커스**: 좌측 뒤로/앞으로 버튼은 disabled 시 탭 스킵.
- **노트 상세에서 제목 제거** 시, 편집기 내부의 첫 줄 제목 렌더가 이미 충분한지 확인(현재 `TomboyEditor`가 첫 줄을 h1 스타일로 렌더하는지). 그렇지 않다면 별도 이슈로 분리.

## 수동 확인 체크리스트

- [ ] 홈 `/`에서 상단 바 = 메뉴(홈/전체) + 검색/설정 + 좌측 뒤로(비활성).
- [ ] 홈 우측 상단에 🎲 랜덤 FAB — 클릭 시 임의 노트로 이동.
- [ ] `/notes`에서 노트북 필터 칩/드롭다운 동작.
- [ ] 노트 상세에서 편집기 바로 위에 `TopNav`만 있고 별도 제목 바 없음.
- [ ] 설정 → 홈 → 전체 → 노트 → 뒤로 x3 경로 테스트.
- [ ] 모바일(iOS Safari 기준) safe-area-top이 상단 바 높이에 반영.
