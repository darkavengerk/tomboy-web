# Hue 존(zone) 노트 재도입 설계

> 2026-06-20. `조명::` Hue 제어에 존(zone) 노트를 다시 추가한다. 방(room) 노트와 동일한 패턴이되, 멤버십 해석만 다르다. room 재설계 때 제거됐던 `zone:` 시그니처/위젯을 복원하고, 방·존이 위젯을 공유하도록 `RoomControl` 을 `GroupControl` 로 일반화한다.

## 목표

- `조명::` 존 노트: 본문 첫 줄 `zone:<uuid>`, 위젯 = 체크박스 조명(존 멤버 on/off) + 라디오 씬(존 스코프, 택1 recall).
- 씬은 존 스코프 **진짜 Hue 씬**. "현재 상태 저장" 은 존 스코프 새 씬 생성.
- 마스터 "가져오기" 가 존 노트도 멱등 생성 + 본문 **존 묶음 블록** 추가(전구/방/존 3블록).
- 방·존 위젯 공유(단일 `GroupControl`, 멤버십만 분기).
- 존 하나당 노트 하나. 여러 존 = 각각 노트.

## 비목표 (YAGNI)

- 존 편집(읽기 전용, room 과 동일). 존 생성/멤버 변경은 Hue 앱에서.
- 한 조명이 여러 존에 속할 때 특수 UI(각 존 노트 목록에 그대로 나타남).
- 실하드웨어 `zone.children` 모양 검증(CLIP v2 모델 가정 — 아래 "가정" 참조).

## zone ↔ room 차이 (설계 근거)

| | room | zone |
|---|---|---|
| 멤버십 | `room.children` = device refs → `light.owner.rid` 역추적 | `zone.children` = **light refs 직접**(rtype `light`), device-hop 없음 |
| 씬 | `scene.group.rid === roomId` | `scene.group.rid === zoneId` |
| 씬 저장 group | `{ rid, rtype: 'room' }` | `{ rid, rtype: 'zone' }` |
| grouped_light | `services` 에 존재 | `services` 에 존재(동일) |
| 한 조명 소속 | 정확히 한 room | 여러 zone 가능 |

`groupedLightIdOf`, `buildSceneActions`, `isSceneActive`, `roomDoc` 의 PM 빌더/컨텍스트(체크박스·라디오 리스트)는 그룹 종류와 무관 — **무변경 재사용**.

### 가정 (실하드웨어 검증 대상)

CLIP v2 `zone` 리소스의 `children` 는 light 참조 배열(`rtype: 'light'`)이고 `services` 에 grouped_light 가 있다. `lightsInZone` 은 이를 전제로 한다. 실제 허브에서 다르면(예: children 이 비고 다른 필드 사용) `lightsInZone` 만 조정한다. 방어적으로 `children` 중 `rtype === 'light'` 만 필터한다.

## 아키텍처

### 타입 — `hueTypes.ts`
`HueZone` 재추가:
```ts
export interface HueZone {
  id: string;
  type: 'zone';
  metadata?: { name?: string };
  children: HueResourceRef[]; // light refs (rtype 'light')
  services: HueResourceRef[]; // grouped_light 등
}
```

### 순수 로직 — `roomOps.ts`
`lightsInZone` 추가(기존 함수 무변경):
```ts
/** zone children 의 light 만(순서 보존, device-hop 없음). */
export function lightsInZone(zone: HueZone, allLights: HueLight[]): HueLight[] {
  const lightRids = new Set(zone.children.filter((c) => c.rtype === 'light').map((c) => c.rid));
  return allLights.filter((l) => lightRids.has(l.id));
}
```

### 노트 판별 — `hueNoteParse.ts`
`HueNoteKind` 에 `'zone'` 추가, `HueNoteInfo` 에 `zoneId?`. `ZONE_RE = /^zone:([0-9a-fA-F-]{36})$/`. parse 에 zone 분기(light → room → zone 순서, 상호배타라 순서 무관).

### 가져오기 — `hueImport.ts`
`planZoneImports(zones, existingZoneIds)` — `planRoomImports` 와 동형:
```ts
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

### 위젯 — `RoomControl.svelte` → `GroupControl.svelte` (일반화, 파일 이름 변경)
props: `{ groupKind: 'room' | 'zone'; groupId: string; view: EditorView }`.
- `load()`: GET `${groupKind}/${groupId}` → grouped_light(services) + light(전체) + scene(`group.rid === groupId`).
  - 멤버십: `groupKind === 'room' ? lightsInRoom(group, allLights) : lightsInZone(group, allLights)`.
- `saveScene()`: `group: { rid: groupId, rtype: groupKind }`.
- 나머지(체크박스→PUT light, 라디오→배타+recall, 그룹 on/off+밝기, view.dom mousedown 핸들러, errMsg HTTP status, replaceList 멱등, roomDoc 빌더/컨텍스트)는 그대로.
- `roomDoc.ts` 무변경 재사용.

### 플러그인 — `hueNotePlugin.ts`
`renderWidget`: `kind === 'bulb' → BulbControl`; `kind === 'room' || kind === 'zone' → GroupControl` with `{ groupKind: kind, groupId: info.roomId ?? info.zoneId, view }`; `master → MasterDashboard`. key `hue:${kind}:${id}`.

### 마스터 — `MasterDashboard.svelte`
- `importAll`: 기존 light+room GET 에 더해 `zone` GET; `planZoneImports(zones, existingZoneIds)` 결과도 생성 루프에.
- `existingIds` 시그 정규식에 `zone:` 추가(또는 호출부 분리).
- `writeBundles`: 전구/방 묶음에 **존 묶음 블록** 추가 → `[전구][방][존]` 3블록. `bundleBlock(schema, '존: ', zoneTitles)` 재사용. 멱등(`Fragment.eq`) 유지.

## 부수 효과

room 재설계 때 `zone:` 파싱을 제거해 옛 존 노트는 현재 위젯이 없다. zone 파싱 복원으로 본문 `zone:<uuid>` 가 남은 옛 노트가 **자동으로 GroupControl 위젯을 다시 얻는다**(마이그레이션 불필요).

## 보안 / 브릿지

`/hue/clip` ALLOWED_RESOURCES 가 이미 `zone` 을 포함(레거시 허용). **브릿지 변경 없음** — 전부 앱 측. creds 해석/health 등 직전 작업과 무관(존은 clip 호출 리소스만 추가).

## 오류 처리

- 멤버 조명에 대응하는 `조명::` 노트가 없으면 기존 패턴대로 "노트 없는 전구 N개 — 마스터에서 가져오기" toast.
- 제어 실패 → errMsg(HTTP status 포함) toast(기존 GroupControl 동작).
- `zone/<id>` 404(존 삭제됨) → "존을 찾을 수 없음" status(room 의 룸-없음과 동일 분기).

## 테스트

### 순수 (vitest)
- `roomOps.lightsInZone`: children 의 light rid 로 필터; device-hop 안 함; 순서 보존; 비멤버 제외; rtype 비-light children 무시.
- `hueNoteParse`: `zone:<uuid>` → `{kind:'zone', zoneId}`; 잘못된 sig → null; light/room/zone 상호배타.
- `hueImport.planZoneImports`: 기존 zone skip; title+`zone:<id>`; 이름 폴백 `존 <id>`.
- `hueNotePlugin`: zone 노트 → GroupControl 위젯 1개 key `hue:zone:<id>`; room 노트도 여전히 GroupControl(`hue:room:<id>`).
- `masterBundle`: `writeBundles` 전구/방/존 3블록 생성 + 멱등(반복 시 dispatch 없음).

### 회귀
- 기존 room 경로: GroupControl(groupKind='room') 이 RoomControl 과 동일 동작. 기존 hue 테스트 그린 유지.
- `npm run check` 0 errors; bridge 무변경(테스트 영향 없음).

## 영향 받는 파일

**앱**
- `app/src/lib/hue/hueTypes.ts` (HueZone 재추가)
- `app/src/lib/hue/roomOps.ts` (lightsInZone)
- `app/src/lib/hue/hueNoteParse.ts` (zone kind + ZONE_RE)
- `app/src/lib/hue/hueImport.ts` (planZoneImports)
- `app/src/lib/editor/hueNote/RoomControl.svelte` → `GroupControl.svelte` (일반화, rename)
- `app/src/lib/editor/hueNote/hueNotePlugin.ts` (zone 분기, GroupControl)
- `app/src/lib/editor/hueNote/MasterDashboard.svelte` (zone 가져오기 + 존 묶음)
- `app/tests/unit/hue/{roomOps,hueNoteParse,hueImport,hueNotePlugin,masterBundle}.test.ts` (zone 케이스 추가/신규)

**문서**
- `.claude/skills/tomboy-hue/SKILL.md` (존 노트 + GroupControl + lightsInZone)
- `CLAUDE.md` (tomboy-hue 행: 존 복원 반영)
- 설정 → 가이드 조명 카드(존 노트 사용법)

**브릿지**: 변경 없음.
