# Hue 존(zone) 노트 재도입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `조명::` 존(zone) 노트를 방(room) 노트와 동일 패턴으로 재도입한다 — 본문 `zone:<uuid>`, 위젯=체크박스 조명+라디오 씬, 마스터 가져오기에 존 노트+존 묶음.

**Architecture:** room 인프라를 일반화한다. `RoomControl.svelte` → `GroupControl.svelte`(groupKind prop), 멤버십만 분기(room=device-hop, zone=`children` light refs 직접). `roomDoc`/`groupedLightIdOf`/`buildSceneActions`/`isSceneActive` 는 그룹 무관이라 무변경 재사용. 씬은 그룹 스코프 진짜 Hue 씬(`scene.group.rid===groupId`, 저장 시 `rtype:groupKind`).

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, vitest, CLIP v2 릴레이(브릿지 무변경).

**Spec:** `docs/superpowers/specs/2026-06-20-hue-zone-note-readd-design.md`

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `app/src/lib/hue/hueTypes.ts` | `HueZone` 재추가 | 1 |
| `app/src/lib/hue/roomOps.ts` | `lightsInZone` | 1 |
| `app/src/lib/hue/hueNoteParse.ts` | `'zone'` kind + `ZONE_RE` | 1 |
| `app/src/lib/hue/hueImport.ts` | `planZoneImports` | 1 |
| `app/tests/unit/hue/{roomOps,hueNoteParse,hueImport}.test.ts` | 순수 zone 테스트 | 1 |
| `app/src/lib/editor/hueNote/RoomControl.svelte` → `GroupControl.svelte` | groupKind 일반화 | 2 |
| `app/src/lib/editor/hueNote/hueNotePlugin.ts` | zone 분기, GroupControl 렌더 | 2 |
| `app/tests/unit/hue/hueNotePlugin.test.ts` | zone 위젯 테스트 | 2 |
| `app/src/lib/editor/hueNote/MasterDashboard.svelte` | zone 가져오기 + 존 묶음 | 3 |
| `app/tests/unit/hue/masterBundle.test.ts` | 존 묶음 3블록 테스트 | 3 |
| `.claude/skills/tomboy-hue/SKILL.md`, `CLAUDE.md`, `settings/+page.svelte`(가이드 카드) | 문서 | 4 |

브릿지: 변경 없음(`/hue/clip` ALLOWED_RESOURCES 이미 `zone` 포함).

---

### Task 1: 순수 zone 데이터 레이어 (타입 + 멤버십 + 파싱 + 가져오기)

**Goal:** zone 의 순수 로직(HueZone 타입, lightsInZone, zone 노트 판별, planZoneImports)을 TDD 로 추가한다. 전부 additive — 기존 함수 무변경.

**Files:**
- Modify: `app/src/lib/hue/hueTypes.ts`
- Modify: `app/src/lib/hue/roomOps.ts`
- Modify: `app/src/lib/hue/hueNoteParse.ts`
- Modify: `app/src/lib/hue/hueImport.ts`
- Test: `app/tests/unit/hue/roomOps.test.ts`, `hueNoteParse.test.ts`, `hueImport.test.ts`

**Acceptance Criteria:**
- [ ] `HueZone { id, type:'zone', metadata?, children: HueResourceRef[], services: HueResourceRef[] }`
- [ ] `lightsInZone(zone, allLights)` — `children` 중 rtype `light` rid 로 필터; 순서 보존; 비멤버 제외; device-hop 안 함
- [ ] `parseHueNote` 가 `zone:<uuid>` → `{kind:'zone', zoneId}`; `HueNoteKind` 에 `'zone'`, `HueNoteInfo` 에 `zoneId?`
- [ ] `planZoneImports(zones, existingZoneIds)` — 기존 skip, title `조명::<존명>`+`zone:<id>`, 폴백 `존 <id>`
- [ ] 전체 hue 유닛 그린; `npm run check` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/roomOps.test.ts tests/unit/hue/hueNoteParse.test.ts tests/unit/hue/hueImport.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: 실패 테스트 추가**

`app/tests/unit/hue/roomOps.test.ts` — 기존 파일 끝에 추가(기존 테스트 유지):
```ts
import { lightsInZone } from '$lib/hue/roomOps.js';
import type { HueZone } from '$lib/hue/hueTypes.js';

describe('lightsInZone', () => {
  const lights = [
    { id: 'L1', type: 'light', on: { on: true } },
    { id: 'L2', type: 'light', on: { on: false } },
    { id: 'L3', type: 'light', on: { on: true } }
  ] as any[];
  it('children 의 light rid 만, 순서 보존, device-hop 없음', () => {
    const zone = { id: 'Z', type: 'zone', children: [
      { rid: 'L3', rtype: 'light' }, { rid: 'L1', rtype: 'light' }
    ], services: [] } as HueZone;
    // 입력 light 순서(L1,L2,L3) 기준 필터 — allLights 순서 보존
    expect(lightsInZone(zone, lights).map((l) => l.id)).toEqual(['L1', 'L3']);
  });
  it('rtype 가 light 아닌 children 무시', () => {
    const zone = { id: 'Z', type: 'zone', children: [
      { rid: 'L1', rtype: 'light' }, { rid: 'DEV', rtype: 'device' }
    ], services: [] } as HueZone;
    expect(lightsInZone(zone, lights).map((l) => l.id)).toEqual(['L1']);
  });
  it('멤버 없으면 빈 배열', () => {
    const zone = { id: 'Z', type: 'zone', children: [], services: [] } as HueZone;
    expect(lightsInZone(zone, lights)).toEqual([]);
  });
});
```

`app/tests/unit/hue/hueNoteParse.test.ts` — 추가:
```ts
  it('zone:<uuid> → kind zone', () => {
    expect(parseHueNote('조명::거실존', 'zone:11111111-2222-3333-4444-555555555555'))
      .toEqual({ kind: 'zone', zoneId: '11111111-2222-3333-4444-555555555555' });
  });
  it('잘못된 zone sig → null', () => {
    expect(parseHueNote('조명::x', 'zone:not-a-uuid')).toBeNull();
  });
```
(상단에 `parseHueNote` 가 이미 import 되어 있음 — 확인만.)

`app/tests/unit/hue/hueImport.test.ts` — 추가:
```ts
import { planZoneImports } from '$lib/hue/hueImport.js';
import type { HueZone } from '$lib/hue/hueTypes.js';

describe('planZoneImports', () => {
  const zones = [
    { id: 'Z1', type: 'zone', metadata: { name: '거실존' }, children: [], services: [] },
    { id: 'Z2', type: 'zone', metadata: {}, children: [], services: [] }
  ] as HueZone[];
  it('기존 zone skip, title+zone:<id>, 이름 폴백', () => {
    const out = planZoneImports(zones, new Set(['Z1']));
    expect(out).toEqual([{ title: '조명::존 Z2', bodyFirstLine: 'zone:Z2' }]);
  });
  it('이름 있으면 사용', () => {
    expect(planZoneImports([zones[0]], new Set())).toEqual([
      { title: '조명::거실존', bodyFirstLine: 'zone:Z1' }
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/roomOps.test.ts tests/unit/hue/hueNoteParse.test.ts tests/unit/hue/hueImport.test.ts`
Expected: FAIL — `lightsInZone`/`planZoneImports`/`HueZone` export 없음, zone parse 미지원

- [ ] **Step 3: `hueTypes.ts` — HueZone 추가** (HueRoom 정의 바로 아래)

```ts
export interface HueZone {
  id: string;
  type: 'zone';
  metadata?: { name?: string };
  children: HueResourceRef[]; // light refs (rtype 'light') — room 과 달리 device-hop 없음
  services: HueResourceRef[]; // grouped_light 등
}
```

- [ ] **Step 4: `roomOps.ts` — lightsInZone 추가**

import 줄에 `HueZone` 추가:
```ts
import type { HueRoom, HueZone, HueResourceRef, HueLight, HueScene } from './hueTypes.js';
```
`lightsInRoom` 바로 아래에:
```ts
/** zone children 의 light 만(직접 참조, device-hop 없음; 순서 보존). */
export function lightsInZone(zone: HueZone, allLights: HueLight[]): HueLight[] {
  const lightRids = new Set(zone.children.filter((c) => c.rtype === 'light').map((c) => c.rid));
  return allLights.filter((l) => lightRids.has(l.id));
}
```

- [ ] **Step 5: `hueNoteParse.ts` — zone 분기**

전체 교체:
```ts
export type HueNoteKind = 'bulb' | 'room' | 'zone' | 'master';
export interface HueNoteInfo { kind: HueNoteKind; lightId?: string; roomId?: string; zoneId?: string; }

export const HUE_PREFIX = '조명::';
export const HUE_MASTER_NAME = '전체';
const LIGHT_RE = /^light:([0-9a-fA-F-]{36})$/;
const ROOM_RE = /^room:([0-9a-fA-F-]{36})$/;
const ZONE_RE = /^zone:([0-9a-fA-F-]{36})$/;

/** 타이틀+본문 첫 줄로 조명 노트 종류 판별. 조명 노트가 아니면 null. */
export function parseHueNote(title: string, bodyFirstLine: string): HueNoteInfo | null {
  if (!title.startsWith(HUE_PREFIX)) return null;
  const name = title.slice(HUE_PREFIX.length).trim();
  if (name === HUE_MASTER_NAME) return { kind: 'master' };
  const sig = bodyFirstLine.trim();
  const lm = LIGHT_RE.exec(sig);
  if (lm) return { kind: 'bulb', lightId: lm[1] };
  const rm = ROOM_RE.exec(sig);
  if (rm) return { kind: 'room', roomId: rm[1] };
  const zm = ZONE_RE.exec(sig);
  if (zm) return { kind: 'zone', zoneId: zm[1] };
  return null;
}
```

- [ ] **Step 6: `hueImport.ts` — planZoneImports 추가**

import 줄에 `HueZone` 추가:
```ts
import type { HueLight, HueRoom, HueZone } from './hueTypes.js';
```
`planRoomImports` 바로 아래에:
```ts
/** 새로 노트를 만들어야 할 zone 만. existingZoneIds 의 id 는 skip. */
export function planZoneImports(zones: HueZone[], existingZoneIds: Set<string>): ImportPlanItem[] {
  const out: ImportPlanItem[] = [];
  for (const z of zones) {
    if (existingZoneIds.has(z.id)) continue;
    const name = z.metadata?.name?.trim() || `존 ${z.id}`;
    out.push({ title: `${HUE_PREFIX}${name}`, bodyFirstLine: `zone:${z.id}` });
  }
  return out;
}
```

- [ ] **Step 7: 통과 + 체크**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/roomOps.test.ts tests/unit/hue/hueNoteParse.test.ts tests/unit/hue/hueImport.test.ts && npm run check`
Expected: PASS + 0 errors

- [ ] **Step 8: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add app/src/lib/hue/hueTypes.ts app/src/lib/hue/roomOps.ts app/src/lib/hue/hueNoteParse.ts app/src/lib/hue/hueImport.ts app/tests/unit/hue/roomOps.test.ts app/tests/unit/hue/hueNoteParse.test.ts app/tests/unit/hue/hueImport.test.ts && git commit -m "feat(hue): 존 순수 레이어 — HueZone + lightsInZone + zone 파싱 + planZoneImports"
```

---

### Task 2: RoomControl → GroupControl 일반화 + 플러그인 zone 배선

**Goal:** `RoomControl.svelte` 를 `GroupControl.svelte` 로 일반화(groupKind prop, 멤버십 분기)하고, 플러그인이 room·zone 둘 다 GroupControl 로 렌더하게 한다.

**Files:**
- Rename+Modify: `app/src/lib/editor/hueNote/RoomControl.svelte` → `app/src/lib/editor/hueNote/GroupControl.svelte`
- Modify: `app/src/lib/editor/hueNote/hueNotePlugin.ts`
- Modify: `app/src/lib/hue/roomDoc.ts` (주석의 RoomControl 언급만 GroupControl 로 — cosmetic)
- Test: `app/tests/unit/hue/hueNotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `GroupControl.svelte` props `{ groupKind: 'room'|'zone', groupId, view }`
- [ ] load(): GET `${groupKind}/${groupId}`; 멤버십 room→lightsInRoom, zone→lightsInZone; scene 필터 `s.group?.rid === groupId`
- [ ] saveScene(): group `{ rid: groupId, rtype: groupKind }`
- [ ] 플러그인: kind room|zone → GroupControl(props groupKind+groupId); key `hue:${kind}:${id}`(zoneId 포함)
- [ ] hueNotePlugin.test: zone 노트 → 위젯 1개 key `hue:zone:<uuid>`; room 노트도 `hue:room:<uuid>` 유지
- [ ] `npm run check` 0 errors; 전체 hue 유닛 그린

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: 플러그인 테스트 추가(실패 먼저)** — `app/tests/unit/hue/hueNotePlugin.test.ts` `describe` 안에 추가:
```ts
  it('one widget for a zone note with key hue:zone:<uuid>', () => {
    const set = buildHueDecorations(docOf(['조명::거실존', `zone:${UUID}`]));
    expect(set.find().length).toBe(1);
    expect(set.find()[0].spec.key).toBe(`hue:zone:${UUID}`);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts`
Expected: FAIL — zone 노트가 위젯 0개(파싱은 Task1 에서 됐지만 플러그인 key 가 `hue:zone:undefined` 또는 위젯 미생성)

- [ ] **Step 3: `git mv` 로 rename**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git mv app/src/lib/editor/hueNote/RoomControl.svelte app/src/lib/editor/hueNote/GroupControl.svelte
```

- [ ] **Step 4: `GroupControl.svelte` 일반화** — 다음 4곳만 변경, 나머지(onMousedown/onCheckbox/onRadio/setGroupOn/setGroupBrightness/uuidToTitleMap/replaceList/errMsg/markup/style)는 그대로.

(a) import 줄 — `lightsInZone` + `HueZone` 추가:
```ts
  import type { HueLight, HueRoom, HueZone, HueScene } from '$lib/hue/hueTypes.js';
  import { lightsInRoom, lightsInZone, groupedLightIdOf, buildSceneActions, isSceneActive } from '$lib/hue/roomOps.js';
```

(b) props:
```ts
  let { groupKind, groupId, view }: { groupKind: 'room' | 'zone'; groupId: string; view: EditorView } = $props();
```

(c) `load()` 교체:
```ts
  async function load() {
    status = '불러오는 중…';
    try {
      const rd = (await hueCall('GET', `${groupKind}/${groupId}`)) as { data?: Array<HueRoom | HueZone> };
      const group = rd.data?.[0]; if (!group) { status = groupKind === 'room' ? '룸을 찾을 수 없음' : '존을 찾을 수 없음'; return; }
      glId = groupedLightIdOf(group);
      if (glId) {
        const g = ((await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> }).data?.[0];
        groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
      }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const groupLights = groupKind === 'room'
        ? lightsInRoom(group as HueRoom, allLights)
        : lightsInZone(group as HueZone, allLights);
      const u2t = await uuidToTitleMap();
      titleToId = new Map();
      const lightItems: LightItem[] = []; let missing = 0;
      for (const l of groupLights) {
        const title = u2t.get(l.id);
        if (!title) { missing++; continue; }
        titleToId.set(title, l.id);
        lightItems.push({ title, checked: l.on.on });
      }
      if (missing) pushToast(`노트 없는 전구 ${missing}개 — 마스터에서 가져오기`);

      const scenes = (((await hueCall('GET', 'scene')) as { data?: HueScene[] }).data ?? []).filter((s) => s.group?.rid === groupId);
      sceneNameToId = new Map(scenes.map((s) => [s.metadata.name.trim(), s.id]));
      const sceneItems: SceneItem[] = scenes.map((s) => ({ name: s.metadata.name.trim(), active: isSceneActive(s) }));

      replaceList('inlineCheckbox', buildLightList(view.state.schema, lightItems));
      replaceList('inlineRadio', buildSceneList(view.state.schema, sceneItems));
      status = '';
    } catch (e) { status = errMsg(e, '불러오기 실패'); }
  }
```

(d) `saveScene()` 교체:
```ts
  async function saveScene() {
    const name = newSceneName.trim(); if (!name) { pushToast('씬 이름을 입력하세요'); return; }
    try {
      const rd = (await hueCall('GET', `${groupKind}/${groupId}`)) as { data?: Array<HueRoom | HueZone> };
      const group = rd.data?.[0]; if (!group) { pushToast('그룹 없음'); return; }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const members = groupKind === 'room' ? lightsInRoom(group as HueRoom, allLights) : lightsInZone(group as HueZone, allLights);
      const acts = buildSceneActions(members);
      await hueCall('POST', 'scene', { type: 'scene', metadata: { name }, group: { rid: groupId, rtype: groupKind }, actions: acts });
      newSceneName = ''; pushToast('씬 저장됨'); await load();
    } catch (e) { pushToast(errMsg(e, '씬 저장 실패')); }
  }
```
(markup 의 `class="room-control"` 등 CSS 클래스명은 그대로 둔다 — 내부용, 재스타일 불필요.)

- [ ] **Step 5: `hueNotePlugin.ts` — zone 배선**

import 교체:
```ts
import GroupControl from './GroupControl.svelte';
```
(`import RoomControl from './RoomControl.svelte';` 줄 제거.)

key 줄 교체(zoneId 포함):
```ts
  const key = `hue:${info.kind}:${info.lightId ?? info.roomId ?? info.zoneId ?? 'master'}`;
```

`renderWidget` 의 Comp/props 교체:
```ts
  const Comp = info.kind === 'bulb' ? BulbControl
    : info.kind === 'room' || info.kind === 'zone' ? GroupControl
    : MasterDashboard;
  const props: Record<string, unknown> =
    info.kind === 'bulb' ? { lightId: info.lightId }
    : info.kind === 'room' || info.kind === 'zone' ? { groupKind: info.kind, groupId: info.roomId ?? info.zoneId, view }
    : { view, oninternallink: opts?.oninternallink };
```

- [ ] **Step 6: `roomDoc.ts` 주석 정정(cosmetic)** — 파일 내 "RoomControl" 언급을 "GroupControl" 로(주석만, 코드 무변경). 없으면 skip.

- [ ] **Step 7: 통과 + 체크**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check`
Expected: PASS(zone+room 위젯) + 0 errors. (참고: GroupControl 마운트 동작은 유닛 미커버 — 순수 로직은 roomOps/roomDoc/parse 가 커버. 수동: `npm run dev` 로 존 노트 위젯 확인.)

- [ ] **Step 8: 전체 hue 유닛 회귀**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/`
Expected: 전부 그린

- [ ] **Step 9: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add -A app/src/lib/editor/hueNote/ app/src/lib/hue/roomDoc.ts app/tests/unit/hue/hueNotePlugin.test.ts && git commit -m "feat(hue): RoomControl→GroupControl 일반화 + zone 노트 위젯 배선"
```

---

### Task 3: MasterDashboard — 존 가져오기 + 존 묶음 블록

**Goal:** 마스터 가져오기가 존 노트도 멱등 생성하고, 본문에 존 묶음 블록을 추가해 전구/방/존 3블록을 쓴다.

**Files:**
- Modify: `app/src/lib/editor/hueNote/MasterDashboard.svelte`
- Test: `app/tests/unit/hue/masterBundle.test.ts`

**Acceptance Criteria:**
- [ ] `importAll`: `zone` GET + `planZoneImports(zones, existingZoneIds)` 결과도 생성; toast 에 존 개수 포함
- [ ] `writeBundles`: 전구/방/존 3블록(`bundleBlock(schema, '존: ', zoneTitles)`); 멱등(`Fragment.eq`) 유지
- [ ] masterBundle.test: 전구/방/존 3블록 연속 삽입 → parseNoteBundles 3 번들 인식
- [ ] `npm run check` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/masterBundle.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: masterBundle.test 에 3블록 테스트 추가(실패 먼저)** — `describe('bundleBlock — parseNoteBundles 통합 인식'` 안에 추가:
```ts
  it('전구+방+존 3블록 연속 삽입 시 세 번들 모두 인식됨', () => {
    const ed = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '조명::전체' }] }]
    });
    const schema = ed.schema;
    const allBlocks = [
      ...bundleBlock(schema, '전구: ', ['조명::거실등']),
      ...bundleBlock(schema, '방: ', ['조명::거실']),
      ...bundleBlock(schema, '존: ', ['조명::거실존'])
    ];
    const { tr } = ed.state;
    const from = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(tr.replaceWith(from, ed.state.doc.content.size, allBlocks));

    const bundles = parseNoteBundles(ed.state.doc);
    expect(bundles).toHaveLength(3);
    expect(bundles[2].entries.map((e) => e.title)).toEqual(['조명::거실존']);
  });
```
또한 prefix 검증 블록에 한 줄:
```ts
  it('"존: " prefix 도 ":" 로 끝남', () => {
    expect('존: '.trim().endsWith(':')).toBe(true);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/masterBundle.test.ts`
Expected: 새 3블록 테스트는 통과할 수도(빌더는 일반적) — 핵심은 다음 단계 MasterDashboard 변경. 테스트가 이미 PASS 면 그대로 두고 Step 3 진행(테스트는 빌더 일반성 + parser 인식 회귀 가드).

- [ ] **Step 3: `MasterDashboard.svelte` — zone 가져오기**

import 에 `planZoneImports` + `HueZone` 추가:
```ts
  import type { HueLight, HueRoom, HueZone } from '$lib/hue/hueTypes.js';
  import { planLightImports, planRoomImports, planZoneImports } from '$lib/hue/hueImport.js';
```

`importAll` 교체:
```ts
  async function importAll() {
    busy = true;
    try {
      const lights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const rooms = ((await hueCall('GET', 'room')) as { data?: HueRoom[] }).data ?? [];
      const zones = ((await hueCall('GET', 'zone')) as { data?: HueZone[] }).data ?? [];
      const lightPlan = planLightImports(lights, await existingIds(/^light:([0-9a-fA-F-]{36})$/));
      const roomPlan = planRoomImports(rooms, await existingIds(/^room:([0-9a-fA-F-]{36})$/));
      const zonePlan = planZoneImports(zones, await existingIds(/^zone:([0-9a-fA-F-]{36})$/));
      for (const it of [...lightPlan, ...roomPlan, ...zonePlan]) {
        const title = await ensureUniqueTitle(it.title);
        await createNote({ title, bodyFirstLine: it.bodyFirstLine });
      }
      if (view) await writeBundles();
      const created = lightPlan.length + roomPlan.length + zonePlan.length;
      pushToast(created ? `전구 ${lightPlan.length} · 방 ${roomPlan.length} · 존 ${zonePlan.length}개 생성` : '새 항목 없음 — 목록 갱신');
    } catch (e) {
      pushToast(e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨');
    } finally { busy = false; }
  }
```

`writeBundles` 교체(존 블록 추가):
```ts
  async function writeBundles() {
    const notes = await listNotesShared();
    const lightTitles = notes.filter((n) => /^light:/.test(firstBodyLineOf(n.xmlContent).trim())).map((n) => n.title);
    const roomTitles = notes.filter((n) => /^room:/.test(firstBodyLineOf(n.xmlContent).trim())).map((n) => n.title);
    const zoneTitles = notes.filter((n) => /^zone:/.test(firstBodyLineOf(n.xmlContent).trim())).map((n) => n.title);

    const schema = view!.state.schema;
    const blocks = [
      ...bundleBlock(schema, '전구: ', lightTitles),
      ...bundleBlock(schema, '방: ', roomTitles),
      ...bundleBlock(schema, '존: ', zoneTitles)
    ];

    const doc = view!.state.doc;
    const from = doc.firstChild ? doc.firstChild.nodeSize : 0;
    if (Fragment.from(blocks).eq(doc.slice(from, doc.content.size).content)) return;
    view!.dispatch(view!.state.tr.replaceWith(from, doc.content.size, blocks).setMeta('addToHistory', false));
  }
```

- [ ] **Step 4: 통과 + 체크**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/masterBundle.test.ts && npm run check`
Expected: PASS + 0 errors. 수동: `npm run dev` → 마스터 노트 가져오기 → 전구/방/존 3 묶음 윈도우 확인.

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add app/src/lib/editor/hueNote/MasterDashboard.svelte app/tests/unit/hue/masterBundle.test.ts && git commit -m "feat(hue): 마스터 — 존 가져오기 + 존 묶음 블록(전구/방/존 3블록)"
```

---

### Task 4: 문서 — SKILL.md, CLAUDE.md, 가이드 카드

**Goal:** 존 노트 재도입 + GroupControl 일반화를 스킬/CLAUDE/사용자 가이드에 반영.

**Files:**
- Modify: `.claude/skills/tomboy-hue/SKILL.md`
- Modify: `CLAUDE.md` (tomboy-hue 행)
- Modify: `app/src/routes/settings/+page.svelte` (가이드 조명 카드)

**Acceptance Criteria:**
- [ ] SKILL.md: 노트 종류 표에 존 행 추가; GroupControl(room+zone 공유) + lightsInZone 불변식; "존 제거됨" 서술을 "존 재도입" 으로 보정; 파일 목록 GroupControl/RoomControl 갱신
- [ ] CLAUDE.md tomboy-hue 행: 존 포함 + RoomControl→GroupControl 경로 갱신
- [ ] 가이드 조명 카드: 존 노트 사용법 한 줄(방과 동일 + 한 조명이 여러 존 가능)
- [ ] `npm run check` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check` (+ 가이드 카드 수동 확인)

**Steps:**

- [ ] **Step 1: SKILL.md** — 노트 종류 표(3가지 → 4가지)에 존 행 추가:
```markdown
| 존 노트 | `조명::<이름>` | `zone:<uuid>` | GroupControl (체크박스+라디오) |
```
방 노트 행의 위젯도 `GroupControl` 로 갱신. "존(zone) 포맷은 제거됨" 류 서술이 있으면 제거하고 다음 불변식 추가:
```markdown
- **방·존은 GroupControl 공유.** `groupKind: 'room'|'zone'` prop 으로 분기 — 멤버십만 다름(room=device children→`light.owner` 역추적 `lightsInRoom`; zone=`children` light refs 직접 `lightsInZone`). 씬 저장 group rtype = groupKind. roomDoc 빌더/컨텍스트는 그룹 무관 재사용.
```
파일 목록: `RoomControl` → `GroupControl`.

- [ ] **Step 2: CLAUDE.md** — tomboy-hue 행 설명에 "방(room)/존(zone)/전구/씬" 반영, 경로 `RoomControl.svelte` → `GroupControl.svelte`. (창의 기존 "방(room)/전구/씬" 을 "방/존/전구/씬" 으로.)

- [ ] **Step 3: 가이드 카드** — `settings/+page.svelte` 의 조명 관련 가이드 카드(notes 또는 editor 서브탭)에 존 한 줄 추가(기존 카드 패턴 유지):
```svelte
						<li>존(zone) 노트(<code>zone:&lt;uuid&gt;</code>)도 방과 동일하게 동작합니다. 한 조명이 여러 존에 속할 수 있어 각 존 노트 목록에 나타납니다.</li>
```

- [ ] **Step 4: 체크 + 커밋**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check`
Expected: 0 errors
```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add .claude/skills/tomboy-hue/SKILL.md CLAUDE.md app/src/routes/settings/+page.svelte && git commit -m "docs(hue): 존 노트 재도입 — SKILL/CLAUDE/가이드"
```

---

## Self-Review

**Spec coverage:**
- HueZone 타입 → T1 ✅
- lightsInZone(children light 직접) → T1 ✅
- zone kind 파싱 → T1 ✅
- planZoneImports → T1 ✅
- GroupControl 일반화(멤버십 분기, 씬 rtype) → T2 ✅
- 플러그인 zone 배선(room+zone GroupControl) → T2 ✅
- 마스터 zone 가져오기 + 존 묶음 3블록 → T3 ✅
- 옛 zone 노트 자동 부활(파싱 복원의 부수효과) → T1+T2(자동) ✅
- 브릿지 무변경 → 전 태스크 ✅
- 문서 → T4 ✅

**Placeholder scan:** 없음 — 변경 코드 전부 완전.

**Type consistency:** `HueZone`(T1) ↔ lightsInZone/planZoneImports/GroupControl/MasterDashboard 일치. `HueNoteInfo.zoneId`(T1) ↔ plugin `info.roomId ?? info.zoneId`(T2) 일치. `groupKind:'room'|'zone'`/`groupId`(T2 props) ↔ plugin props 일치. `bundleBlock` 시그(기존) ↔ writeBundles '존: ' 호출(T3) 일치. `existingIds(regex)` 헬퍼(기존) ↔ zone 정규식(T3) 일치.

**룸 회귀:** GroupControl(groupKind='room') = 기존 RoomControl 동작(GET room/, lightsInRoom, rtype 'room'). 플러그인 room key `hue:room:<id>` 유지(테스트 가드).
