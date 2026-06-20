# Hue 룸 기반 노트-네이티브 제어 — 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 존(zone) 기반 Hue 노트 제어를 제거하고, 룸(room) 노트(체크박스=조명 on/off + 라디오=씬 택1) + 마스터 가져오기(조명·룸 노트 생성 + 묶음 기록)로 재설계. 씬은 룸 스코프의 진짜 Hue 씬.

**Architecture:** 순수 로직(타입/파싱/임포트/문서빌더)을 먼저 TDD로 굳히고, 그 위에 Svelte 위젯(`RoomControl`)을 얹는다. 룸 노트의 조명 목록은 Hue 룸 멤버십(물리·device 기반)에서 **읽기 전용**으로 재생성하고, 체크박스는 on/off만 제어한다. 씬 목록은 `GET scene`(룸 스코프) 결과로 재생성하고, 라디오 택1·recall은 위젯이 `view.dom` mousedown 핸들러로 처리(인라인 라디오의 per-parent 배타성 한계를 우회). 새로고침은 멱등(변동 없으면 트랜잭션 미발행).

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror (Decoration widget + inlineCheckbox/inlineRadio atom + tomboyInternalLink mark), vitest + @testing-library/svelte, 기존 Pi 브릿지 `/hue/clip` 릴레이(변경 없음).

---

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `app/src/lib/hue/hueTypes.ts` | Hue CLIP v2 타입 | 수정: `HueRoom`/`light.owner`/`HueScene.status` 추가, `HueZone` 제거 |
| `app/src/lib/hue/roomOps.ts` | 룸 순수 로직(조명 필터, gl id, 씬 액션, active 판정) | 신규 |
| `app/src/lib/hue/zoneOps.ts` | (존 로직) | **삭제(Task 5)** — ZoneControl 의존이 살아있는 동안 유지 |
| `app/src/lib/hue/hueNoteParse.ts` | 조명 노트 종류 판별 | Task2(additive): room 추가 / Task5: zone·zoneId·ZONE_RE·extractMembershipTitles 제거 |
| `app/src/lib/hue/hueImport.ts` | 가져오기 플래너 | 수정: `planRoomImports` 추가 |
| `app/src/lib/hue/roomDoc.ts` | 룸 노트 본문 PM 빌더/탐색기(순수) | 신규 |
| `app/src/lib/editor/hueNote/RoomControl.svelte` | 룸 위젯(로드/⟳/그룹제어/씬저장 + atom 상호작용) | 신규 |
| `app/src/lib/editor/hueNote/ZoneControl.svelte` | (존 위젯) | **삭제** |
| `app/src/lib/editor/hueNote/hueNotePlugin.ts` | 종류별 위젯 데코 | 수정: zone→room 분기 |
| `app/src/lib/editor/hueNote/MasterDashboard.svelte` | 마스터 위젯 | 수정: 룸 가져오기 + 묶음 본문 기록 |
| `app/src/lib/noteTypes/registry.ts` | 노트종류 카탈로그 | 수정: help 문자열 존→룸(line 92) |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 | 수정: 조명 카드 존→룸 |
| `CLAUDE.md` / `.claude/skills/tomboy-hue/SKILL.md` | 스킬 인덱스/본문 | 수정 |

테스트: `app/tests/unit/hue/{roomOps,hueNoteParse,hueImport,roomDoc}.test.ts`. 삭제: `app/tests/unit/hue/zoneOps.test.ts`.

브릿지(`bridge/src/hue.ts`)는 화이트리스트에 `room/scene/grouped_light/light/device`가 이미 있어 **변경 없음**.

---

### Task 1: hueTypes + roomOps (순수 로직)

**Goal:** (additive) Hue 타입에 룸/owner/씬-status를 더하고, 룸 순수 로직(조명 필터·gl id·씬 액션·active 판정)을 TDD로 만든다. **존 제거(HueZone/zoneOps/ZoneControl)는 Task 5로 이관** — 중간 커밋에서 ZoneControl이 여전히 의존하므로 트리를 깨지 않게 유지.

**Files:**
- Modify: `app/src/lib/hue/hueTypes.ts` (HueRoom·owner·scene.status 추가; **HueZone는 유지**)
- Create: `app/src/lib/hue/roomOps.ts`
- Create test: `app/tests/unit/hue/roomOps.test.ts`

**Acceptance Criteria:**
- [ ] `HueRoom`(children/services: `HueResourceRef[]`), `HueLight.owner?: HueResourceRef`, `HueScene.status?: { active: ... }` 존재. (HueZone은 Task 5까지 공존)
- [ ] `lightsInRoom(room, allLights)` = owner.rid가 룸 device children에 든 light만, 순서 보존.
- [ ] `groupedLightIdOf(group)` = services의 grouped_light rid 또는 null.
- [ ] `buildSceneActions(lights)` = mirek 있으면 color_temperature, 아니면 color; off도 그대로 캡처.
- [ ] `isSceneActive(scene)` = status.active가 `'inactive'`가 아니면 true.
- [ ] 전체 `tests/unit/hue/` + `npm run check` 그린 유지(zoneOps/HueZone 보존).

**Verify:** `cd app && npx vitest run tests/unit/hue/roomOps.test.ts` → 전부 pass

**Steps:**

- [ ] **Step 1: hueTypes 수정**

`app/src/lib/hue/hueTypes.ts`에서 `HueLight`에 `owner` 추가, `HueScene`에 `status` 추가, `HueZone` 블록 삭제, `HueRoom` 추가:

```typescript
export interface HueLight {
  id: string;
  type: 'light';
  metadata?: { name?: string };
  owner?: HueResourceRef;            // ← 추가: 보통 { rid: <deviceId>, rtype: 'device' }
  on: HueOn;
  dimming?: HueDimming;
  color?: HueColor;
  color_temperature?: HueColorTemp;
}
export interface HueResourceRef { rid: string; rtype: string; }
export interface HueRoom {           // ← HueZone 자리에 추가
  id: string;
  type: 'room';
  metadata?: { name?: string };
  children: HueResourceRef[];        // device refs
  services: HueResourceRef[];        // grouped_light 등
}
export interface HueScene {
  id: string;
  type: 'scene';
  metadata: { name: string };
  group: HueResourceRef;
  actions: Array<{ target: HueResourceRef; action: Record<string, unknown> }>;
  status?: { active: 'inactive' | 'static' | 'dynamic_palette' };  // ← 추가
}
```

**`HueZone` 인터페이스는 유지**(zoneOps.ts/ZoneControl.svelte가 아직 의존 — Task 5에서 함께 제거). `supportsColor`/`lightGamut` 등 헬퍼도 그대로 둔다.

- [ ] **Step 2: 실패 테스트 작성** — `app/tests/unit/hue/roomOps.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { lightsInRoom, groupedLightIdOf, buildSceneActions, isSceneActive } from '$lib/hue/roomOps.js';
import type { HueLight, HueRoom, HueScene } from '$lib/hue/hueTypes.js';

const room: HueRoom = {
  id: 'r1', type: 'room', metadata: { name: '거실' },
  children: [{ rid: 'devA', rtype: 'device' }, { rid: 'devB', rtype: 'device' }],
  services: [{ rid: 'gl1', rtype: 'grouped_light' }, { rid: 'mot', rtype: 'motion' }]
};
const mk = (id: string, dev: string, extra: Partial<HueLight> = {}): HueLight =>
  ({ id, type: 'light', owner: { rid: dev, rtype: 'device' }, on: { on: false }, ...extra });

describe('lightsInRoom', () => {
  it('owner가 룸 device에 든 light만, 순서 보존', () => {
    const all = [mk('lA', 'devA'), mk('lX', 'devZ'), mk('lB', 'devB')];
    expect(lightsInRoom(room, all).map((l) => l.id)).toEqual(['lA', 'lB']);
  });
  it('owner 없는 light는 제외', () => {
    const all = [{ id: 'lN', type: 'light', on: { on: true } } as HueLight];
    expect(lightsInRoom(room, all)).toEqual([]);
  });
});

describe('groupedLightIdOf', () => {
  it('grouped_light rid 반환', () => expect(groupedLightIdOf(room)).toBe('gl1'));
  it('없으면 null', () => expect(groupedLightIdOf({ ...room, services: [] })).toBeNull());
});

describe('buildSceneActions', () => {
  it('mirek 있으면 color_temperature, 아니면 color', () => {
    const lights: HueLight[] = [
      mk('l1', 'devA', { on: { on: true }, dimming: { brightness: 80 }, color_temperature: { mirek: 300 }, color: { xy: { x: 0.4, y: 0.4 } } }),
      mk('l2', 'devB', { on: { on: true }, color: { xy: { x: 0.5, y: 0.3 } } })
    ];
    const acts = buildSceneActions(lights);
    expect(acts[0].action).toMatchObject({ on: { on: true }, dimming: { brightness: 80 }, color_temperature: { mirek: 300 } });
    expect(acts[0].action.color).toBeUndefined();
    expect(acts[1].action).toMatchObject({ color: { xy: { x: 0.5, y: 0.3 } } });
  });
  it('off 상태도 캡처', () => {
    expect(buildSceneActions([mk('l3', 'devA')])[0].action).toMatchObject({ on: { on: false } });
  });
});

describe('isSceneActive', () => {
  const base: HueScene = { id: 's', type: 'scene', metadata: { name: 'n' }, group: { rid: 'r1', rtype: 'room' }, actions: [] };
  it('active != inactive → true', () => expect(isSceneActive({ ...base, status: { active: 'static' } })).toBe(true));
  it('inactive → false', () => expect(isSceneActive({ ...base, status: { active: 'inactive' } })).toBe(false));
  it('status 없으면 false', () => expect(isSceneActive(base)).toBe(false));
});
```

- [ ] **Step 3: 실패 확인** — `cd app && npx vitest run tests/unit/hue/roomOps.test.ts` → FAIL(모듈 없음)

- [ ] **Step 4: roomOps.ts 구현**

```typescript
import type { HueRoom, HueResourceRef, HueLight, HueScene } from './hueTypes.js';

/** 룸 device children 에 owner 가 든 light 만(순서 보존). */
export function lightsInRoom(room: HueRoom, allLights: HueLight[]): HueLight[] {
  const devRids = new Set(room.children.filter((c) => c.rtype === 'device').map((c) => c.rid));
  return allLights.filter((l) => l.owner && devRids.has(l.owner.rid));
}

/** services 에서 grouped_light rid. */
export function groupedLightIdOf(group: { services: HueResourceRef[] }): string | null {
  return group.services.find((s) => s.rtype === 'grouped_light')?.rid ?? null;
}

export interface SceneAction { target: { rid: string; rtype: 'light' }; action: Record<string, unknown>; }
/** 멤버 light 현재 상태 → scene actions[]. color 와 color_temperature 는 상호배타 — mirek 있으면 CT. */
export function buildSceneActions(lights: HueLight[]): SceneAction[] {
  return lights.map((l) => {
    const action: Record<string, unknown> = { on: { on: l.on.on } };
    if (l.dimming) action.dimming = { brightness: l.dimming.brightness };
    if (l.color_temperature && l.color_temperature.mirek != null) action.color_temperature = { mirek: l.color_temperature.mirek };
    else if (l.color) action.color = { xy: l.color.xy };
    return { target: { rid: l.id, rtype: 'light' }, action };
  });
}

/** scene.status.active 가 inactive 가 아니면 활성. */
export function isSceneActive(scene: HueScene): boolean {
  return !!scene.status && scene.status.active !== 'inactive';
}
```

- [ ] **Step 5: 통과 확인(전체 hue 그린) + 커밋** — zoneOps/HueZone은 삭제하지 않는다(Task 5 담당). 전체 `tests/unit/hue/`가 그린이어야 함(ZoneControl import 안 깨짐).

```bash
cd app && npx vitest run tests/unit/hue/   # 전체 hue 그린
cd .. && git add -A && git commit -m "feat(hue): roomOps + 룸/owner/씬-status 타입 (additive)"
```

---

### Task 2: hueNoteParse — bulb|room|master

**Goal:** (additive) `room:<uuid>` 시그를 인식해 `{kind:'room', roomId}`를 반환하도록 추가. **zone 분기·zoneId·extractMembershipTitles는 유지**(ZoneControl/hueNotePlugin이 아직 의존 — Task 5에서 제거).

**Files:**
- Modify: `app/src/lib/hue/hueNoteParse.ts` (room 추가, zone 유지)
- Modify test: `app/tests/unit/hue/hueNoteParse.test.ts` (room 케이스 추가, 기존 유지)

**Acceptance Criteria:**
- [ ] `parseHueNote('조명::전체', '')` → `{kind:'master'}`.
- [ ] `parseHueNote('조명::거실', 'room:<uuid>')` → `{kind:'room', roomId:'<uuid>'}`.
- [ ] `parseHueNote('조명::메인등', 'light:<uuid>')` → `{kind:'bulb', lightId:'<uuid>'}`.
- [ ] 기존 zone 시그/zoneId/`extractMembershipTitles` 동작 유지.
- [ ] 비-조명 타이틀 → null. `조명::` + 알 수 없는 시그 → null.
- [ ] 전체 `tests/unit/hue/` + `npm run check` 그린(ZoneControl import 안 깨짐).

**Verify:** `cd app && npx vitest run tests/unit/hue/hueNoteParse.test.ts` → pass

**Steps:**

- [ ] **Step 1: 테스트 추가(additive)** — `app/tests/unit/hue/hueNoteParse.test.ts`의 **기존 케이스는 그대로 두고** room 케이스를 추가. (zone/extractMembership 테스트가 있으면 유지.)

```typescript
// 기존 describe에 추가하거나 새 it 추가:
const ROOM_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
it('룸', () => expect(parseHueNote('조명::거실', `room:${ROOM_UUID}`)).toEqual({ kind: 'room', roomId: ROOM_UUID }));
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/hue/hueNoteParse.test.ts` → 새 room 테스트 FAIL

- [ ] **Step 3: hueNoteParse.ts 구현(additive)** — `HueNoteKind` 유니온에 `'room'` 추가, `HueNoteInfo`에 `roomId?` 추가, `ROOM_RE` 추가, parseHueNote에 room 분기 추가. **`zone` 종류·`zoneId`·`ZONE_RE`·`extractMembershipTitles`는 그대로 둔다**(Task 5 제거). 예:

```typescript
export type HueNoteKind = 'bulb' | 'zone' | 'room' | 'master';   // zone 유지
export interface HueNoteInfo { kind: HueNoteKind; lightId?: string; zoneId?: string | null; roomId?: string; }
// ... 기존 LIGHT_RE/ZONE_RE 유지 + 추가:
const ROOM_RE = /^room:([0-9a-fA-F-]{36})$/;
// parseHueNote 내부: light → zone(기존) → room 순으로 검사하되, room 분기 추가:
//   const rm = ROOM_RE.exec(sig); if (rm) return { kind: 'room', roomId: rm[1] };
// extractMembershipTitles 함수는 그대로 export 유지.
```

- [ ] **Step 4: 통과(전체 hue 그린) + 커밋**

```bash
cd app && npx vitest run tests/unit/hue/    # 전체 그린(zone/membership 유지)
cd .. && git add -A && git commit -m "feat(hue): parseHueNote room 종류 + room:<uuid> 시그 (additive, zone 유지)"
```

---

### Task 3: hueImport — planRoomImports

**Goal:** 마스터 가져오기가 룸 노트도 멱등 생성하도록 `planRoomImports`를 추가.

**Files:**
- Modify: `app/src/lib/hue/hueImport.ts`
- Modify test: `app/tests/unit/hue/hueImport.test.ts`

**Acceptance Criteria:**
- [ ] `planRoomImports(rooms, existingRoomIds)` = existing에 없는 룸만, `{title:'조명::<룸명>', bodyFirstLine:'room:<id>'}`.
- [ ] 이름 없으면 `방 <id>` 폴백.
- [ ] 기존 룸 id는 skip(멱등).

**Verify:** `cd app && npx vitest run tests/unit/hue/hueImport.test.ts` → pass

**Steps:**

- [ ] **Step 1: 테스트 추가** — `app/tests/unit/hue/hueImport.test.ts`에 아래 describe 추가(기존 planLightImports 테스트는 유지):

```typescript
import { planRoomImports } from '$lib/hue/hueImport.js';
import type { HueRoom } from '$lib/hue/hueTypes.js';

const room = (id: string, name?: string): HueRoom =>
  ({ id, type: 'room', metadata: name ? { name } : undefined, children: [], services: [] });

describe('planRoomImports', () => {
  it('기존 룸 skip, 새 룸만', () => {
    const plan = planRoomImports([room('r1', '거실'), room('r2', '침실')], new Set(['r1']));
    expect(plan).toEqual([{ title: '조명::침실', bodyFirstLine: 'room:r2' }]);
  });
  it('이름 폴백', () => {
    expect(planRoomImports([room('r9')], new Set())[0].title).toBe('조명::방 r9');
  });
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/hue/hueImport.test.ts` → FAIL

- [ ] **Step 3: hueImport.ts 구현** — 기존 파일에 추가:

```typescript
import type { HueLight, HueRoom } from './hueTypes.js';   // ← HueRoom 추가
// ... (기존 planLightImports 유지)

/** 새로 노트를 만들어야 할 room 만. existingRoomIds 의 id 는 skip. */
export function planRoomImports(rooms: HueRoom[], existingRoomIds: Set<string>): ImportPlanItem[] {
  const out: ImportPlanItem[] = [];
  for (const r of rooms) {
    if (existingRoomIds.has(r.id)) continue;
    const name = r.metadata?.name?.trim() || `방 ${r.id}`;
    out.push({ title: `${HUE_PREFIX}${name}`, bodyFirstLine: `room:${r.id}` });
  }
  return out;
}
```

- [ ] **Step 4: 통과 + 커밋**

```bash
cd app && npx vitest run tests/unit/hue/hueImport.test.ts
cd .. && git add -A && git commit -m "feat(hue): planRoomImports — 룸 노트 멱등 가져오기"
```

---

### Task 4: roomDoc — 룸 본문 PM 빌더/탐색기(순수)

**Goal:** 룸 노트 본문의 조명·씬 리스트를 찾고(탐색) 다시 그리고(빌드) 클릭 위치에서 컨텍스트(링크 타이틀 / 씬 이름 / 형제 라디오 위치)를 해석하는 순수 함수를 TDD로 만든다. Svelte·네트워크 없이 ProseMirror Editor만으로 검증.

**Files:**
- Create: `app/src/lib/hue/roomDoc.ts`
- Create test: `app/tests/unit/hue/roomDoc.test.ts`

**배경(스키마 사실):** `inlineCheckbox`(inline atom, attr `checked:boolean`), `inlineRadio`(inline atom, attr `selected:boolean`, 배타성은 **같은 부모 노드 내부만** NodeView가 처리), `tomboyInternalLink`(mark, attr `target:string`=노트 타이틀; 링크 텍스트는 타이틀과 같게 둔다 — Tomboy .note 라운드트립/이름변경 캐스케이드가 텍스트로 타이틀을 매칭). 룸 노트는 본문에서 체크박스=조명, 라디오=씬으로만 쓴다.

**Acceptance Criteria:**
- [ ] `findListByAtom(doc, 'inlineCheckbox')` / `findListByAtom(doc, 'inlineRadio')` = 그 atom을 가진 첫 bulletList의 `{from,to}` 또는 null.
- [ ] `buildLightList(schema, items)` = 각 `{title}` → listItem(paragraph(checkbox{checked}, link(text=title,target=title))) 의 bulletList 노드.
- [ ] `buildSceneList(schema, items)` = 각 `{name,active}` → listItem(paragraph(radio{selected:active}, text(name))) 의 bulletList 노드.
- [ ] `lightContextAt(doc, pos)` = 그 위치 체크박스가 속한 listItem의 첫 internalLink target + 새 checked. 없으면 null.
- [ ] `sceneContextAt(doc, pos)` = 그 위치 라디오의 새 selected + 같은 씬 리스트의 다른 라디오 위치들 + 같은 listItem 텍스트(씬 이름).

**Verify:** `cd app && npx vitest run tests/unit/hue/roomDoc.test.ts` → pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/hue/roomDoc.test.ts`. 실제 앱 확장을 쓰는 최소 Editor를 만들어 검증. **teardown 규칙: 매 테스트 editor.destroy()** (afterEach).

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineCheckbox } from '$lib/editor/inlineCheckbox/node.js';
import { InlineRadio } from '$lib/editor/inlineRadio/node.js';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { findListByAtom, buildLightList, buildSceneList, lightContextAt, sceneContextAt } from '$lib/hue/roomDoc.js';

let editor: Editor | null = null;
function make(): Editor {
  editor = new Editor({ extensions: [StarterKit, InlineCheckbox, InlineRadio, TomboyInternalLink], content: '<p>조명::거실</p><p>room:x</p>' });
  return editor;
}
afterEach(() => { editor?.destroy(); editor = null; });

describe('buildLightList / findListByAtom', () => {
  it('체크박스 리스트를 만들고 다시 찾는다', () => {
    const e = make();
    const list = buildLightList(e.schema, [{ title: '조명::메인등', checked: true }, { title: '조명::스탠드', checked: false }]);
    // 본문 끝에 삽입
    e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));
    const found = findListByAtom(e.state.doc, 'inlineCheckbox');
    expect(found).not.toBeNull();
    // 첫 체크박스 위치에서 컨텍스트 해석
    let cbPos = -1;
    e.state.doc.descendants((n, p) => { if (cbPos < 0 && n.type.name === 'inlineCheckbox') cbPos = p; });
    expect(lightContextAt(e.state.doc, cbPos)).toEqual({ title: '조명::메인등', checked: true });
  });
});

describe('buildSceneList / sceneContextAt', () => {
  it('라디오 리스트 + 컨텍스트(이름 + 형제 위치)', () => {
    const e = make();
    const list = buildSceneList(e.schema, [{ name: '영화', active: false }, { name: '독서', active: true }]);
    e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, list));
    const radios: number[] = [];
    e.state.doc.descendants((n, p) => { if (n.type.name === 'inlineRadio') radios.push(p); });
    expect(radios.length).toBe(2);
    const ctx = sceneContextAt(e.state.doc, radios[1]);
    expect(ctx?.name).toBe('독서');
    expect(ctx?.selected).toBe(true);
    expect(ctx?.siblings).toContain(radios[0]);
    expect(ctx?.siblings).not.toContain(radios[1]);
  });
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/hue/roomDoc.test.ts` → FAIL(모듈 없음). (만약 InlineCheckbox/InlineRadio/TomboyInternalLink의 named export 이름이 다르면 해당 파일의 실제 export에 맞춰 import 라인만 정정한다.)

- [ ] **Step 3: roomDoc.ts 구현**

```typescript
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

export interface LightItem { title: string; checked: boolean; }
export interface SceneItem { name: string; active: boolean; }

/** atomName(inlineCheckbox|inlineRadio) 을 포함한 첫 bulletList 의 {from,to}. */
export function findListByAtom(doc: PMNode, atomName: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (result || node.type.name !== 'bulletList') return;
    let has = false;
    node.descendants((d) => { if (d.type.name === atomName) has = true; });
    if (has) result = { from: pos, to: pos + node.nodeSize };
    return false; // 중첩 리스트는 안 들어감
  });
  return result;
}

export function buildLightList(schema: Schema, items: LightItem[]): PMNode {
  const cb = schema.nodes.inlineCheckbox, li = schema.nodes.listItem, bl = schema.nodes.bulletList, p = schema.nodes.paragraph;
  const link = schema.marks.tomboyInternalLink;
  const lis = items.map((it) =>
    li.create(null, p.create(null, [cb.create({ checked: it.checked }), schema.text(it.title, [link.create({ target: it.title })])]))
  );
  return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

export function buildSceneList(schema: Schema, items: SceneItem[]): PMNode {
  const radio = schema.nodes.inlineRadio, li = schema.nodes.listItem, bl = schema.nodes.bulletList, p = schema.nodes.paragraph;
  const lis = items.map((it) =>
    li.create(null, p.create(null, [radio.create({ selected: it.active }), schema.text(' ' + it.name)]))
  );
  return bl.create(null, lis.length ? lis : [li.create(null, p.create())]);
}

/** 체크박스 위치 → 그 listItem의 첫 internalLink target + 체크박스 새 checked. */
export function lightContextAt(doc: PMNode, pos: number): { title: string; checked: boolean } | null {
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== 'inlineCheckbox') return null;
  const $pos = doc.resolve(pos);
  // listItem 깊이 찾기
  let liNode: PMNode | null = null;
  for (let d = $pos.depth; d > 0; d--) { if ($pos.node(d).type.name === 'listItem') { liNode = $pos.node(d); break; } }
  if (!liNode) return null;
  let title = '';
  liNode.descendants((n) => {
    if (title || !n.isText) return;
    const m = n.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
    if (m) title = String(m.attrs.target ?? '');
  });
  return title ? { title, checked: !!node.attrs.checked } : null;
}

/** 라디오 위치 → 새 selected + 같은 씬 리스트의 다른 라디오 위치들 + 같은 listItem 텍스트(이름). */
export function sceneContextAt(doc: PMNode, pos: number): { name: string; selected: boolean; siblings: number[] } | null {
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== 'inlineRadio') return null;
  const list = findListByAtom(doc, 'inlineRadio');
  if (!list) return null;
  const siblings: number[] = [];
  doc.nodesBetween(list.from, list.to, (n, p) => { if (n.type.name === 'inlineRadio' && p !== pos) siblings.push(p); });
  const $pos = doc.resolve(pos);
  let liNode: PMNode | null = null;
  for (let d = $pos.depth; d > 0; d--) { if ($pos.node(d).type.name === 'listItem') { liNode = $pos.node(d); break; } }
  const name = (liNode?.textContent ?? '').trim();
  return { name, selected: !!node.attrs.selected, siblings };
}
```

- [ ] **Step 4: 통과 + 커밋**

```bash
cd app && npx vitest run tests/unit/hue/roomDoc.test.ts
cd .. && git add -A && git commit -m "feat(hue): roomDoc — 룸 본문 조명/씬 리스트 빌더·탐색기(순수, PM)"
```

---

### Task 5: RoomControl 위젯 + 플러그인 배선

**Goal:** 룸 노트 위젯을 만든다 — 열 때/⟳ 시 Hue에서 조명·씬을 읽어 본문 두 리스트를 멱등 재생성, 그룹 on/off·밝기·"현재 상태 저장" 버튼, 그리고 `view.dom` mousedown 핸들러로 체크박스→`PUT light`, 라디오→배타 처리+`recall`. hueNotePlugin을 room 분기로 바꾸고 ZoneControl을 삭제.

**Files:**
- Create: `app/src/lib/editor/hueNote/RoomControl.svelte`
- Modify: `app/src/lib/editor/hueNote/hueNotePlugin.ts`
- Delete: `app/src/lib/editor/hueNote/ZoneControl.svelte`, `app/src/lib/hue/zoneOps.ts`, `app/tests/unit/hue/zoneOps.test.ts`
- Modify: `app/src/lib/hue/hueTypes.ts` (Task 1에서 미룬 `HueZone` 인터페이스 제거)
- Modify: `app/src/lib/hue/hueNoteParse.ts` (Task 2에서 미룬 `zone` 종류·`zoneId`·`ZONE_RE`·`extractMembershipTitles` 제거)
- Modify test: `app/tests/unit/hue/hueNotePlugin.test.ts` (zone→room 기대값), `app/tests/unit/hue/hueNoteParse.test.ts` (zone 케이스 제거)

**Acceptance Criteria:**
- [ ] `buildHueDecorations`가 room 노트(`room:<uuid>`)에 위젯 1개, key `hue:room:<uuid>`. 비-조명 노트엔 0개.
- [ ] 위젯 mount 시 `GET room/{id}` + `GET light` + `GET scene` + 노트 스캔으로 조명/씬 리스트를 본문에 재생성(멱등 — 동일하면 트랜잭션 미발행).
- [ ] 체크박스 클릭 → `PUT light/{id} {on:{on:checked}}`; 실패 시 status 포함 toast.
- [ ] 라디오 클릭(선택) → 같은 씬 리스트의 다른 라디오 해제 + `PUT scene/{id} {recall:active}`.
- [ ] 그룹 on/off·밝기 → `grouped_light` PUT; "현재 상태 저장"(이름칸) → `POST scene{group:room}` → ⟳.
- [ ] 모든 실패 toast에 HTTP status 동봉(`HueError.status`). `no_bridge`/`unreachable` 분기 메시지.
- [ ] **zone 잔재 전부 제거**: `ZoneControl.svelte`, `zoneOps.ts`(+test), `HueZone` 인터페이스 삭제 — 어디서도 import 안 함.
- [ ] `npm run check` 0 errors. ZoneControl import 잔재 없음.

**Verify:** `cd app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: hueClient에 status 노출 확인** — `HueError`는 이미 `status`를 가짐(`hueClient.ts:8`). toast에서 `e instanceof HueError ? e.status : 0` 사용.

- [ ] **Step 2: RoomControl.svelte 작성**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight, HueRoom, HueScene } from '$lib/hue/hueTypes.js';
  import { lightsInRoom, groupedLightIdOf, buildSceneActions, isSceneActive } from '$lib/hue/roomOps.js';
  import { buildLightList, buildSceneList, findListByAtom, lightContextAt, sceneContextAt, type LightItem, type SceneItem } from '$lib/hue/roomDoc.js';
  import { listNotesShared } from '$lib/core/noteManager.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { roomId, view }: { roomId: string; view: EditorView } = $props();

  let status = $state('');
  let glId = $state<string | null>(null);
  let groupedOn = $state(false);
  let brightness = $state(100);
  let newSceneName = $state('');

  // 클릭 핸들러용 맵(refresh 가 채움)
  let titleToId = new Map<string, string>();   // 노트 타이틀 → light uuid
  let sceneNameToId = new Map<string, string>();

  const REFRESH_META = 'hueRefresh';
  const errMsg = (e: unknown, base: string) =>
    e instanceof HueError ? (e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : e.kind === 'unreachable' ? '조명 브릿지에 연결 안 됨' : `${base} (HTTP ${e.status})`) : base;

  async function uuidToTitleMap(): Promise<Map<string, string>> {
    const notes = await listNotesShared();
    const m = new Map<string, string>();
    for (const n of notes) { const mt = /^light:([0-9a-fA-F-]{36})$/.exec(firstBodyLineOf(n.xmlContent).trim()); if (mt) m.set(mt[1], n.title); }
    return m;
  }

  /** 본문 리스트를 desired 노드로 멱등 교체(같으면 미발행). */
  function replaceList(atomName: 'inlineCheckbox' | 'inlineRadio', node: import('@tiptap/pm/model').Node) {
    const cur = findListByAtom(view.state.doc, atomName);
    if (cur) {
      const existing = view.state.doc.slice(cur.from, cur.to).content.firstChild;
      if (existing && existing.eq(node)) return; // 동일 → skip
      view.dispatch(view.state.tr.replaceWith(cur.from, cur.to, node).setMeta(REFRESH_META, true));
    } else {
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.insert(end, node).setMeta(REFRESH_META, true));
    }
  }

  async function load() {
    status = '불러오는 중…';
    try {
      const rd = (await hueCall('GET', `room/${roomId}`)) as { data?: HueRoom[] };
      const room = rd.data?.[0]; if (!room) { status = '룸을 찾을 수 없음'; return; }
      glId = groupedLightIdOf(room);
      if (glId) {
        const g = ((await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> }).data?.[0];
        groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
      }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const roomLights = lightsInRoom(room, allLights);
      const u2t = await uuidToTitleMap();
      titleToId = new Map();
      const lightItems: LightItem[] = []; let missing = 0;
      for (const l of roomLights) {
        const title = u2t.get(l.id);
        if (!title) { missing++; continue; }
        titleToId.set(title, l.id);
        lightItems.push({ title, checked: l.on.on });
      }
      if (missing) pushToast(`노트 없는 전구 ${missing}개 — 마스터에서 가져오기`);

      const scenes = (((await hueCall('GET', 'scene')) as { data?: HueScene[] }).data ?? []).filter((s) => s.group?.rid === roomId);
      sceneNameToId = new Map(scenes.map((s) => [s.metadata.name, s.id]));
      const sceneItems: SceneItem[] = scenes.map((s) => ({ name: s.metadata.name, active: isSceneActive(s) }));

      replaceList('inlineCheckbox', buildLightList(view.state.schema, lightItems));
      replaceList('inlineRadio', buildSceneList(view.state.schema, sceneItems));
      status = '';
    } catch (e) { status = errMsg(e, '불러오기 실패'); }
  }

  function onMousedown(ev: MouseEvent) {
    const el = (ev.target as HTMLElement)?.closest?.('.tomboy-inline-checkbox, .tomboy-inline-radio') as HTMLElement | null;
    if (!el) return;
    const isRadio = el.classList.contains('tomboy-inline-radio');
    queueMicrotask(() => { // atom NodeView 가 먼저 dispatch 하도록
      try { const pos = view.posAtDOM(el, 0); isRadio ? onRadio(pos) : onCheckbox(pos); } catch { /* noop */ }
    });
  }

  async function onCheckbox(pos: number) {
    const ctx = lightContextAt(view.state.doc, pos); if (!ctx) return;
    const id = titleToId.get(ctx.title); if (!id) { pushToast('전구 노트 매핑 없음 — ⟳'); return; }
    try { await hueCall('PUT', `light/${id}`, { on: { on: ctx.checked } }); }
    catch (e) { pushToast(errMsg(e, '조명 토글 실패')); }
  }

  async function onRadio(pos: number) {
    const ctx = sceneContextAt(view.state.doc, pos); if (!ctx || !ctx.selected) return;
    // 배타: 다른 라디오 해제
    if (ctx.siblings.length) {
      let tr = view.state.tr;
      for (const sp of ctx.siblings) tr = tr.setNodeAttribute(sp, 'selected', false);
      view.dispatch(tr.setMeta(REFRESH_META, true));
    }
    const id = sceneNameToId.get(ctx.name); if (!id) { pushToast('씬 매핑 없음 — ⟳'); return; }
    try { await hueCall('PUT', `scene/${id}`, { recall: { action: 'active' } }); }
    catch (e) { pushToast(errMsg(e, '씬 적용 실패')); }
  }

  async function setGroupOn(on: boolean) {
    if (!glId) return; const prev = groupedOn; groupedOn = on;
    try { await hueCall('PUT', `grouped_light/${glId}`, { on: { on } }); } catch (e) { groupedOn = prev; pushToast(errMsg(e, '그룹 제어 실패')); }
  }
  async function setGroupBrightness(v: number) {
    if (!glId) return; const prev = brightness; brightness = v;
    try { await hueCall('PUT', `grouped_light/${glId}`, { dimming: { brightness: v } }); } catch (e) { brightness = prev; pushToast(errMsg(e, '그룹 밝기 실패')); }
  }

  async function saveScene() {
    const name = newSceneName.trim(); if (!name) { pushToast('씬 이름을 입력하세요'); return; }
    try {
      const rd = (await hueCall('GET', `room/${roomId}`)) as { data?: HueRoom[] };
      const room = rd.data?.[0]; if (!room) { pushToast('룸 없음'); return; }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const acts = buildSceneActions(lightsInRoom(room, allLights));
      await hueCall('POST', 'scene', { type: 'scene', metadata: { name }, group: { rid: roomId, rtype: 'room' }, actions: acts });
      newSceneName = ''; pushToast('씬 저장됨'); await load();
    } catch (e) { pushToast(errMsg(e, '씬 저장 실패')); }
  }

  onMount(() => { view.dom.addEventListener('mousedown', onMousedown, true); load(); });
  onDestroy(() => view.dom.removeEventListener('mousedown', onMousedown, true));
</script>

<div class="room-control">
  <div class="room-row">
    <button type="button" class="bulb-toggle" class:on={groupedOn} onclick={() => setGroupOn(!groupedOn)}>{groupedOn ? '전체 켜짐' : '전체 꺼짐'}</button>
    <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
  </div>
  {#if glId}
    <label class="bulb-slider">전체 밝기
      <input type="range" min="1" max="100" value={brightness} oninput={(e) => setGroupBrightness(Number((e.target as HTMLInputElement).value))} />
    </label>
  {/if}
  <div class="room-scene-save">
    <input type="text" placeholder="새 씬 이름" bind:value={newSceneName} />
    <button type="button" onclick={saveScene}>현재 상태 저장</button>
  </div>
  {#if status}<span class="hue-status">{status}</span>{/if}
</div>

<style>
  .room-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .room-row { display: flex; align-items: center; gap: 0.5rem; }
  .room-scene-save { display: flex; gap: 0.3rem; }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
```

> 주의: `.tomboy-inline-checkbox`/`.tomboy-inline-radio` 클래스명은 inlineCheckbox/inlineRadio NodeView가 실제로 다는 클래스다(Task의 schema 사실 참조). `posAtDOM(el,0)`이 atom 바로 안/앞 위치를 주면 `nodeAt`이 atom을 못 집을 수 있으니, `lightContextAt`/`sceneContextAt`는 `nodeAt(pos)`가 atom이 아닐 때 `pos`·`pos-1`도 시도하도록 구현 중 보강(아래 Step 3에서 확인).

- [ ] **Step 3: (완료됨) posAtDOM 보정** — `atomAt`(±1) 보정은 **Task 4의 roomDoc.ts에 이미 포함**되어 `lightContextAt`/`sceneContextAt`가 `posAtDOM` 오차를 흡수한다. 여기선 그 함수를 import해 쓰기만 한다(roomDoc 수정 불필요).

- [ ] **Step 4: hueNotePlugin.ts 수정** — zone→room:

```typescript
import RoomControl from './RoomControl.svelte';   // ZoneControl import 삭제
// ...
const key = `hue:${info.kind}:${info.lightId ?? info.roomId ?? 'master'}`;
// renderWidget 내부:
const Comp = info.kind === 'bulb' ? BulbControl : info.kind === 'room' ? RoomControl : MasterDashboard;
const props: Record<string, unknown> =
  info.kind === 'bulb' ? { lightId: info.lightId }
  : info.kind === 'room' ? { roomId: info.roomId, view }
  : { oninternallink: opts?.oninternallink };
```

- [ ] **Step 5: zone 잔재 일괄 삭제** — `git rm app/src/lib/editor/hueNote/ZoneControl.svelte app/src/lib/hue/zoneOps.ts app/tests/unit/hue/zoneOps.test.ts` + `hueTypes.ts`의 `HueZone` 제거 + `hueNoteParse.ts`의 `zone` 종류·`zoneId`·`ZONE_RE`·`extractMembershipTitles` 제거 + `hueNoteParse.test.ts`의 zone 케이스 제거. 이후 grep으로 `HueZone`/`zoneOps`/`extractMembershipTitles`/`'zone'` import·참조 잔재 0 확인.

- [ ] **Step 6: hueNotePlugin 테스트 갱신** — `app/tests/unit/hue/hueNotePlugin.test.ts`의 zone 케이스를 room으로 교체(타이틀 `조명::거실`, 본문 `room:<uuid>`, 기대 key `hue:room:<uuid>`, 위젯 1개). 비-조명 노트 0개 케이스 유지.

- [ ] **Step 7: 통과 + 커밋**

```bash
cd app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check
cd .. && git add -A && git commit -m "feat(hue): RoomControl 위젯 — 체크박스=조명 on/off, 라디오=씬 recall, 멱등 ⟳/onMount, ZoneControl 제거"
```

---

### Task 6: MasterDashboard — 룸 가져오기 + 묶음 본문 기록

**Goal:** 마스터 "가져오기"가 조명 노트 + 룸 노트를 멱등 생성하고, 마스터 본문에 조명·룸 노트 링크를 묶음 형식으로 기록하도록 확장.

**Files:**
- Modify: `app/src/lib/editor/hueNote/MasterDashboard.svelte`
- Modify: `app/src/lib/editor/hueNote/hueNotePlugin.ts` (master에 `view` prop 전달)

**Acceptance Criteria:**
- [ ] 가져오기 = `GET light`(조명 노트 멱등 생성) + `GET room`(룸 노트 멱등 생성, `planRoomImports`).
- [ ] 마스터 본문에 전구 묶음 + 방 묶음 2블록을 기록(재실행 시 중복 없이 갱신 — 멱등). 각 블록은 `noteBundle/parser.ts`가 윈도우로 인식하는 형식(접두 라벨 + `inlineCheckbox` + `묶음:N` 텍스트 + 내부링크 bulletList)이어야 함.
- [ ] 전체 켜기/끄기 버튼 유지.
- [ ] `npm run check` 0 errors.

**Verify:** `cd app && npm run check` + 수동: 마스터 노트에서 가져오기 → 룸 노트 생성 + 본문에 묶음 윈도우 2개.

**Steps:**

- [ ] **Step 1: master에 view 전달** — `hueNotePlugin.ts` renderWidget의 master props를 `{ view, oninternallink: opts?.oninternallink }`로.

- [ ] **Step 2: MasterDashboard.svelte 확장** — 기존 `importLights`를 `importAll`로 확장:

```typescript
import { planLightImports, planRoomImports } from '$lib/hue/hueImport.js';
import type { HueLight, HueRoom } from '$lib/hue/hueTypes.js';
import { buildLightList } from '$lib/hue/roomDoc.js';   // 링크 빌더 재사용은 묶음과 형식이 달라 별도(아래)
import type { EditorView } from '@tiptap/pm/view';

let { view, oninternallink }: { view?: EditorView; oninternallink?: (t: string) => void } = $props();

async function existingIds(sig: RegExp): Promise<Set<string>> {
  const notes = await listNotesShared(); const ids = new Set<string>();
  for (const n of notes) { const m = sig.exec(firstBodyLineOf(n.xmlContent).trim()); if (m) ids.add(m[1]); }
  return ids;
}

async function importAll() {
  busy = true;
  try {
    const lights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
    const rooms = ((await hueCall('GET', 'room')) as { data?: HueRoom[] }).data ?? [];
    const lightPlan = planLightImports(lights, await existingIds(/^light:([0-9a-fA-F-]{36})$/));
    const roomPlan = planRoomImports(rooms, await existingIds(/^room:([0-9a-fA-F-]{36})$/));
    for (const it of [...lightPlan, ...roomPlan]) { const title = await ensureUniqueTitle(it.title); await createNote({ title, bodyFirstLine: it.bodyFirstLine }); }
    if (view) writeBundles(lights, rooms);
    pushToast(`전구 ${lightPlan.length} · 방 ${roomPlan.length}개 생성`);
  } catch (e) { pushToast(e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨'); }
  finally { busy = false; }
}
```

- [ ] **Step 3: 묶음 본문 기록** — `writeBundles`. **먼저 `noteBundle/parser.ts`의 BUNDLE_RE(`/^\s*(?:노트\s*)?묶음:(\d+)?(?::(\d+))?\s*$/`)와 트리거 구조(접두 텍스트 + inlineCheckbox + 키워드 텍스트 + 직후 bulletList)를 확인**하고 그에 맞춰 노드를 만든다. 본문(타이틀 다음 child(1)~끝)을 두 블록으로 멱등 교체:

```typescript
import { listNotesShared } from '$lib/core/noteManager.js';
function bundleBlock(schema, label: string, titles: string[]) {
  const cb = schema.nodes.inlineCheckbox, li = schema.nodes.listItem, bl = schema.nodes.bulletList, p = schema.nodes.paragraph;
  const link = schema.marks.tomboyInternalLink;
  const head = p.create(null, [schema.text(label), cb.create({ checked: false }), schema.text('묶음:50')]);
  const items = titles.map((t) => li.create(null, p.create(null, schema.text(t, [link.create({ target: t })]))));
  const list = bl.create(null, items.length ? items : [li.create(null, p.create())]);
  return [head, list];
}
async function writeBundles(lights: HueLight[], rooms: HueRoom[]) {
  const notes = await listNotesShared();
  const lightTitles = notes.filter((n) => /^light:/.test(firstBodyLineOf(n.xmlContent).trim())).map((n) => n.title);
  const roomTitles = notes.filter((n) => /^room:/.test(firstBodyLineOf(n.xmlContent).trim())).map((n) => n.title);
  const schema = view!.state.schema;
  const blocks = [...bundleBlock(schema, '전구: ', lightTitles), ...bundleBlock(schema, '방: ', roomTitles)];
  const doc = view!.state.doc; const from = doc.firstChild ? doc.firstChild.nodeSize : 0;
  // 멱등: 동일 직렬화면 skip
  const tr = view!.state.tr.replaceWith(from, doc.content.size, blocks);
  view!.dispatch(tr.setMeta('hueRefresh', true));
}
```

> 라벨 접두 `'전구: '`/`'방: '`는 BUNDLE_RE가 **키워드 텍스트(체크박스 다음 노드)**만 검사하므로 통과한다(접두는 별도 텍스트 노드). Task 실행 시 parser.ts로 실제 통과를 확인하고, 안 되면 접두를 제거하거나 parser가 받는 형식으로 정정한다(불확실한 형식은 parser.ts가 단일 출처).

- [ ] **Step 4: 템플릿 버튼** — `onclick={importAll}` 로 교체, 라벨 "가져오기".

- [ ] **Step 5: 확인 + 커밋**

```bash
cd app && npm run check
cd .. && git add -A && git commit -m "feat(hue): 마스터 가져오기 — 룸 노트 생성 + 본문 묶음(전구/방) 기록"
```

---

### Task 7: 가이드 + registry help + 스킬 문서

**Goal:** 사용자 발견 표면(가이드 카드)·노트종류 help·스킬 문서를 룸 기반으로 갱신.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (가이드 → 노트 서브탭 조명 카드)
- Modify: `app/src/lib/noteTypes/registry.ts` (line 92 help 문자열)
- Modify: `CLAUDE.md` (tomboy-hue 행 설명)
- Modify: `.claude/skills/tomboy-hue/SKILL.md`

**Acceptance Criteria:**
- [ ] registry `hue-master` help: "전구/존 노트" → "전구/룸 노트", 룸 사용법 한 줄 반영.
- [ ] 가이드 조명 카드: 존→룸 전환, 룸 노트(체크박스=켬/끔, 라디오=씬 택1), 마스터 가져오기, 열 때 자동 새로고침 + 수동 ⟳ 설명.
- [ ] CLAUDE.md tomboy-hue 행 + SKILL.md가 룸/씬(진짜 Hue 씬, 룸 스코프) 구조를 기술.
- [ ] `npm run check` 0 errors.

**Verify:** `cd app && npm run check` + 수동: 설정 → 가이드 → 노트 탭에 갱신된 조명 카드.

**Steps:**

- [ ] **Step 1: registry.ts line 92** — help를:
```
'타이틀 조명::전체 = 마스터(전구/룸 가져오기). 조명::<이름> = 전구 노트(light:) 또는 룸 노트(room:). 룸 노트는 체크박스로 조명 on/off, 라디오로 씬을 고릅니다. 설정 → Hue 에서 허브 먼저 연결.'
```

- [ ] **Step 2: 가이드 카드** — `settings/+page.svelte`의 기존 조명 `<details class="guide-card">`(notes 서브탭)를 룸 기준으로 갱신: `<summary>` 조명(Hue), `<p class="info-text">` 룸 노트 소개, `<ul class="guide-list">`에 ▸체크박스=켬/끔 ▸라디오=씬 택1(룸 스코프 진짜 Hue 씬) ▸마스터 "가져오기"→전구·방 노트 + 묶음 ▸열 때 자동 ⟳ 1회, 그 외 수동 ⟳ ▸설정 Hue 탭 링크. 기존 카드 패턴(짧은 summary/info-text/guide-list) 모방.

- [ ] **Step 3: CLAUDE.md** — tomboy-hue 행 설명을 "`조명::` 노트 — Hue 허브 룸/전구/씬 제어(룸 노트=체크박스 조명+라디오 씬, 진짜 Hue 씬 룸 스코프; 브릿지 직통 CLIP v2)"로, primary paths에 `lib/hue/roomOps.ts`·`roomDoc.ts`·`editor/hueNote/RoomControl.svelte` 반영(zoneOps/ZoneControl 제거).

- [ ] **Step 4: SKILL.md** — 존→룸 구조로 갱신: 노트 3종, room→device→light 역참조, 씬=룸 스코프 진짜 Hue 씬, 체크박스/라디오 atom + view.dom mousedown 상호작용, 멱등 ⟳, 묶음 마스터, G1/G2가 룸으로 해소된 경위.

- [ ] **Step 5: 확인 + 커밋**

```bash
cd app && npm run check
cd .. && git add -A && git commit -m "docs(hue): 가이드/registry/CLAUDE/SKILL — 룸 기반 재설계 반영"
```

---

## Self-Review

**Spec coverage:** 노트 3종(Task 2,5) ✓ · 룸 조명=체크박스/씬=라디오(Task 5) ✓ · 진짜 Hue 씬 룸 스코프 recall/save(Task 5) ✓ · 마스터 가져오기 조명+룸+묶음(Task 6) ✓ · 열 때 자동 ⟳ + 수동 ⟳(Task 5 onMount/⟳) ✓ · 멱등(Task 5 replaceList, Task 6 멱등) ✓ · status 포함 toast(Task 5 errMsg) ✓ · 존 제거(Task 1,2,5) ✓ · room→light owner 역참조(Task 1) ✓ · 타입/parse/registry(Task 1,2,7) ✓ · 엣지(노트 없는 전구/도달불가/충돌)(Task 5,6) ✓ · 가이드(Task 7) ✓.

**Type consistency:** `HueNoteInfo.roomId`(Task 2) ↔ hueNotePlugin/RoomControl `roomId` prop(Task 5) 일치. `lightsInRoom/groupedLightIdOf/buildSceneActions/isSceneActive`(Task 1) ↔ RoomControl/Master 사용(Task 5,6) 일치. `buildLightList/buildSceneList/findListByAtom/lightContextAt/sceneContextAt`(Task 4) ↔ RoomControl(Task 5) 일치. `planRoomImports`(Task 3) ↔ Master(Task 6) 일치.

**미해결(실행 중 확인):** (a) inlineCheckbox/inlineRadio/TomboyInternalLink의 named export 이름·NodeView 클래스명 — Task 4 Step 2 / Task 5 Step 2에서 실제 파일로 확인 후 import·셀렉터 정정. (b) noteBundle BUNDLE_RE 정확 형식 — Task 6 Step 3에서 parser.ts 단일 출처로 확인. (c) `posAtDOM` 위치 오차 — Task 5 Step 3 `atomAt` 보정으로 흡수.

**User-gate:** 사용자 브리프에 ordering/proof/gate 명사 신호 없음(루틴 redesign). user-gate 태깅 없음.
