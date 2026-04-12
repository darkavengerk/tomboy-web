# 2단계 — `appSettings` IDB 스토어 (DB_VERSION 3)

## 목표

앱 전역의 작은 키-값 설정(홈 노트 guid, 리스트 정렬 선택 등)을 보관할 전용 IDB 스토어 추가. 후속 단계(3·7·8)에서 공통으로 사용.

## 완료 조건

- [ ] `db.ts`의 `DB_VERSION`을 3으로 올리고 `appSettings` 오브젝트 스토어를 `{ keyPath: 'id' }`로 생성.
- [ ] `lib/storage/appSettings.ts` 모듈 제공. 시그니처:
  - `getSetting<T>(id: string): Promise<T | undefined>`
  - `setSetting<T>(id: string, value: T): Promise<void>`
  - `deleteSetting(id: string): Promise<void>`
- [ ] 기존 DB(v2) 사용자 세션에서 v3 업그레이드가 **기존 노트/매니페스트를 지우지 않음**.
- [ ] 단위 테스트 그린. `svelte-check` 에러 0.

## 선행 / 영향 범위

- 선행: 없음.
- 수정: `app/src/lib/storage/db.ts`.
- 신규: `app/src/lib/storage/appSettings.ts`, `app/tests/unit/appSettings.test.ts`.
- 테스트 의존 신설: `fake-indexeddb` 추가 → `package.json` devDeps.

## Red: 작성할 테스트

`tests/unit/appSettings.test.ts`:

- `it('returns undefined for unknown key')`
- `it('roundtrips string value')`
- `it('overwrites previous value at same key')`
- `it('deleteSetting removes the row')`
- `it('stores structured value (object) intact')`
- `it('upgrading from v2 preserves existing notes store')`
  - v2 스키마로 선 연결 → 노트 1개 put → 연결 종료 → v3 재오픈 → 노트 여전히 존재 검증.

### 셋업 (vitest)

```ts
// tests/unit/appSettings.test.ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect } from 'vitest';
```

`beforeEach`에서 `indexedDB.deleteDatabase('tomboy-web')` 호출해 격리.

## Green: 구현 포인트

### `db.ts` 변경 개요

```ts
export const DB_VERSION = 3;

// openDB(..., { upgrade(db, oldVersion) { ... } })
upgrade(db, oldVersion) {
  if (oldVersion < 1) { /* notes 스토어 ... 기존 코드 */ }
  if (oldVersion < 2) { /* syncManifest 스토어 ... 기존 코드 */ }
  if (oldVersion < 3) {
    db.createObjectStore('appSettings', { keyPath: 'id' });
  }
}
```

**주의**: 기존 `if (oldVersion < 1/2)` 블록의 내용은 손대지 말 것. v2 사용자가 v3로 올라와도 기존 데이터가 유지되어야 한다 (acceptance).

스키마 타입(`DBSchema`)에 `appSettings: { key: string; value: { id: string; value: unknown } }` 추가.

### `appSettings.ts`

```ts
import { getDB } from './db.js';

interface Row<T> { id: string; value: T; }

export async function getSetting<T>(id: string): Promise<T | undefined> {
  const db = await getDB();
  const row = (await db.get('appSettings', id)) as Row<T> | undefined;
  return row?.value;
}

export async function setSetting<T>(id: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('appSettings', { id, value });
}

export async function deleteSetting(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('appSettings', id);
}
```

### 키 네이밍 컨벤션 (후속 단계가 사용할 키)

- `'homeNoteGuid'` — 7단계.
- `'listSort:all'`, `'listSort:notebook:<name>'` — 8단계.
- `'noteListScroll'` — 4단계 (대안: `sessionStorage`).

문서 내에서 일관성 유지. 각 단계에서 이 문서를 참조하도록 링크한다.

## Refactor / 엣지케이스

- **마이그레이션 순차성**: `oldVersion < N` 분기 누적으로 모든 이전 버전에서 올라올 수 있게 유지.
- **타입 안전성**: 호출부는 제네릭으로 `getSetting<string>('homeNoteGuid')` 식으로 기대 타입을 명시. 잘못 저장된 값은 `undefined`로 다루지 않으므로, 호출부에서 런타임 유효성 검사가 필요한 경우 각 도메인 모듈이 책임.
- **SSR 가드 불필요**: 이 앱은 `adapter-static` SPA지만, prerender 단계에서 `getDB()`가 호출되지 않도록 호출부 레벨에서 `$effect`/`onMount` 안에서만 사용.

## 수동 확인

- [ ] DevTools → Application → IndexedDB → `tomboy-web` v3, `appSettings` 스토어 생성됨.
- [ ] 기존 v2 사용자 업그레이드 시 기존 `notes`/`syncManifest` 데이터 유지.
- [ ] `setSetting('homeNoteGuid', 'abc')` → 새로고침 → 여전히 조회됨.
