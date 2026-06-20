# Hue 룸 기반 노트-네이티브 제어 — 재설계 Spec

> 2026-06-20. 기존 `2026-06-19-hue-control-note-design.md`(존 기반)을 대체하는 재설계.
> 개별 조명 노트 위젯은 유지. 존(zone) 개념·코드는 제거하고 **룸(room)** 기반으로 전환.

## 1. 동기 / 문제

현재 존 기반 UI(`ZoneControl.svelte`)는 노트 기능과 동떨어진 버튼 대시보드이고, 씬이 기대대로 동작하지 않으며 **어디서 깨지는지 보이지 않는다.** 근본 원인 2가지:

- **G1 — Hue 씬은 반드시 그룹(룸 or 존)에 묶인다.** 현재 `saveScene`은 `group:{rid:zoneId,rtype:'zone'}`를 강제(`ZoneControl.svelte:141`). 존을 Hue에 먼저 만들지 않으면 씬 저장 불가 → "수동 생성해도 안 됨"의 한 원인.
- **G2 — 씬 목록 필터가 존 스코프 전용.** `scenes.filter(s => s.group?.rid === zoneId)`(`ZoneControl.svelte:36`)는 존 스코프 씬만 표시. 그러나 **Hue 앱에서 만든 씬은 대개 룸 스코프** → 사용자의 기존 씬이 노트에 절대 표시되지 않음. 실패도 toast 한 줄뿐이라 진단 단서 없음.

룸을 1급 개념으로 도입하면 두 문제가 자연히 해소된다: 씬이 룸에 묶이고, 룸 노트가 그 룸 스코프 씬을 그대로 보여준다(Hue 앱과 동일 스코프).

## 2. 목표 / 비목표

**목표**
- 룸을 노트 1급 종류로 추가. 마스터 "가져오기"가 조명 노트 + **룸 노트**를 생성하고 마스터 본문에 목록을 묶음 형식으로 기록.
- 룸 노트는 노트 기본기능으로 구성: 조명 = 체크박스 리스트(켬/끔), 씬 = 라디오 리스트(택1 recall).
- 씬 = **진짜 Hue 씬**(룸 스코프). 기존 씬 표시 + recall + "현재 상태 저장"으로 신규 씬 생성.
- 실패 시 status를 포함한 구체적 toast로 가시성 확보.
- 노트 열 때 관련 조명을 **1회 자동 새로고침**. 그 외에는 수동 ⟳만(폴링 없음).

**비목표 (YAGNI / 이번 범위 밖)**
- 존(zone) 지원 — 제거. (Hue API상 가능하지만 사용자 셋업이 룸 중심.)
- 동적 씬 팔레트 편집, 씬 이름변경/삭제 UI(생성 + recall만).
- 자동 폴링 / SSE / 실시간 상태 스트림.
- 씬 인라인 값 텍스트(밝기/색을 링크 뒤에 기록) — **드롭**(D2). 값은 Hue 씬이 보유.
- 색/밝기의 룸-레벨 세밀 제어 UI(개별 조명 노트에서). 룸은 전체 on/off + 그룹 밝기까지만.

## 3. 노트 종류 (3)

| 종류 | 타이틀 | 시그니처(본문 1번째 줄) | UI |
|---|---|---|---|
| 개별 조명 | `조명::<전구명>` | `light:<uuid>` | 기존 `BulbControl` 위젯 — **변경 없음** |
| **룸** (신규) | `조명::<룸명>` | `room:<uuid>` | 본문-네이티브 (§5) |
| 마스터 | `조명::전체` | (없음, 타이틀명=`전체`) | 가져오기 + 전체 on/off 버튼 (§6) |

`parseHueNote`는 `bulb | room | master` 3종을 반환. `room:<uuid>` 정규식 추가, 기존 `zone` 분기 삭제.

## 4. Hue API 매핑

| 노트 동작 | Hue CLIP v2 호출 |
|---|---|
| 룸의 조명 목록 | `GET room` → 각 room.children = **device** rid들. `GET light` 전체 → `light.owner.rid ∈ 룸 device들`로 필터 (device 추가 GET 불필요) |
| 조명 체크박스 토글 | `PUT light/{id} {on:{on}}` |
| 룸 전체 토글 | `PUT grouped_light/{room의 grouped_light rid}` |
| 룸 그룹 밝기 | `PUT grouped_light/{glid} {dimming:{brightness}}` |
| 씬 라디오 목록 | `GET scene` → `group.rid === roomId` 필터 |
| 현재 active 씬 | `scene.status.active`(`'inactive' | 'static' | 'dynamic_palette'`) — `inactive`가 아니면 선택 |
| 씬 택1 recall | `PUT scene/{id} {recall:{action:'active'}}` |
| 현재 상태 저장 | 룸 조명 각각 `GET light/{id}` → `buildSceneActions` → `POST scene {type:'scene', metadata:{name}, group:{rid:roomId,rtype:'room'}, actions}` |
| 마스터 가져오기 | `GET light` + `GET room` |

브릿지(`bridge/src/hue.ts`)의 `ALLOWED_RESOURCES`는 이미 `light/room/grouped_light/scene/device` 포함 → **브릿지 변경 불필요.** (`zone`은 화이트리스트에 남아도 무해, 정리는 선택.)

## 5. 룸 노트 본문 구조 + 동작

```
조명::거실              ← 타이틀
room:a1b2c3…           ← 시그니처(본문 1번째 줄)

조명                    ← 섹션 라벨(가독용 paragraph)
- [x] [[조명::거실 메인등]]    ← 체크박스 atom + 내부링크 · 체크=켜짐
- [ ] [[조명::거실 스탠드]]

씬                      ← 섹션 라벨
( ) [[영화모드]]              ← 라디오 atom + 내부링크 · 택1=recall
(•) [[독서모드]]              ← scene.status.active 인 씬
```

**위젯**(`RoomControl.svelte`, 제목 아래 데코 위젯): ⟳ 버튼, 전체 on/off + 그룹 밝기, "현재 상태 저장"(이름칸 + 버튼), status 라인.

**리스트는 진짜 노트 atom**(D1): 체크박스 atom(기존 inline checkbox) + 라디오 atom(기존 inline radio) + `tomboyInternalLink` 마크. 위젯이 본문을 직접 조립.

**섹션 식별:** 새로고침 시 리스트를 다시 그릴 때, **조명 리스트 = 체크박스 atom을 포함한 list, 씬 리스트 = 라디오 atom을 포함한 list**로 atom 종류 기준 식별(순서 의존 아님). 둘 다 없으면(빈 본문) 라벨 paragraph + 두 리스트를 새로 생성.

**동작:**
- **열 때(onMount) + ⟳**: `GET light`(룸 소속) → 체크박스 checked 동기화, `GET scene`(룸 스코프) → 라디오 항목/active 동기화. **멱등 적용** — 계산된 새 상태가 현재 doc과 같으면 트랜잭션을 디스패치하지 않음(불필요한 churn 방지).
- **체크박스 클릭** → `PUT light/{id} {on:{on}}`(옵티미스틱; 실패 시 되돌림 + toast).
- **라디오 선택** → `PUT scene/{id} {recall:active}`(옵티미스틱).
- **전체 on/off** → grouped_light PUT.
- **현재 상태 저장** → §4 POST scene → 성공 후 ⟳로 라디오 목록 갱신.

조명↔노트 매핑은 기존 방식 재사용: 전체 노트 스캔 → `firstBodyLineOf`에서 `light:<uuid>` 추출 → 타이틀↔uuid 맵.

## 6. 마스터 노트 가져오기

현재는 조명 노트만 자동 생성. 변경:

1. `GET light` → 조명 노트 멱등 생성(기존 `planLightImports` 유지).
2. `GET room` → **룸 노트 멱등 생성**(신규 `planRoomImports`): 타이틀 `조명::<룸명>`, 본문 시그 `room:<uuid>`, 섹션은 비워 둠(룸 노트를 열면 채워짐). 이름 충돌은 `ensureUniqueTitle`.
3. 마스터 본문에 **묶음(`묶음:`) 형식**으로 (a) 조명 노트들, (b) 룸 노트들 링크를 기록 → 마스터에서 브라우징 가능. 재실행 시 중복 없이 갱신(멱등, 사용자 편집 최대 보존).

전체 on/off 버튼은 유지(`GET light` → 각 PUT).

## 7. 신규/변경/삭제 코드

**신규**
- `app/src/lib/hue/roomOps.ts` — 룸→조명 필터(`lightsInRoom(room, allLights)`), `groupedLightIdOf(room)`, `buildSceneActions`(zoneOps에서 이동), 씬 active 판정. + 단위 테스트.
- `app/src/lib/editor/hueNote/RoomControl.svelte` — 룸 위젯(섹션 조립 + ⟳ + onMount + 저장).
- `planRoomImports`(`hueImport.ts`에 추가) + 테스트.

**변경**
- `hueTypes.ts` — `HueRoom`(children=device ref, services), `HueScene.group`/`.status` 보강, `light.owner` 필드. `HueZone` 제거.
- `hueNoteParse.ts` — `HueNoteKind`를 `bulb|room|master`로, `ROOM_RE`(`room(?::<uuid>)?`) 추가, `zone` 제거. `extractMembershipTitles`는 재사용.
- `registry.ts` — `hue-master` 엔트리는 `조명::` 프리픽스 하나로 bulb/room/master를 모두 덮으므로 **신규 엔트리·카운트 변동 없음**. help 문자열만 "전구/존 노트" → "전구/룸 노트"로 갱신(line 92).
- `MasterDashboard.svelte` — 룸 가져오기 + 묶음 기록 추가.
- `hueNotePlugin.ts` — zone 위젯 → room 위젯 분기.
- `noteBody.ts`(`firstBodyLineOf`) — 재사용, 변경 없음.

**삭제**
- `app/src/lib/editor/hueNote/ZoneControl.svelte`
- `app/src/lib/hue/zoneOps.ts` + `app/tests/unit/hue/zoneOps.test.ts`(roomOps 테스트로 대체)
- parse/types의 zone 잔재.

## 8. 에러 가시성 (핵심 불만 해결)

- 모든 Hue 호출 실패 toast에 **HTTP status 포함**(예: `씬 적용 실패 (HTTP 207)`, `조명 토글 실패 (HTTP 503)`).
- `HueError.kind === 'no_bridge'` → `설정에서 Hue를 먼저 연결`. `'unreachable'` → `조명 브릿지에 연결 안 됨`. `'http'` → status 동봉.
- recall/저장 후 ⟳ 자동 호출로 실제 반영을 즉시 확인.
- 룸 스코프라 Hue 앱 씬이 그대로 보임 → "씬이 안 보임"(G2) 제거.

## 9. 엣지 케이스

- **조명 꺼짐/도달불가 상태로 씬 저장**: `buildSceneActions`는 현재값 그대로 캡처(off면 `on:false`). 도달불가 light는 `GET light` 실패 → 건너뜀 + 누락 수 toast.
- **노트 없는 조명**(룸엔 있지만 조명 노트 미생성): 룸 리스트에서 uuid→타이틀 역참조 실패분은 `먼저 마스터에서 가져오기` 안내 + 건너뜀.
- **타이틀 충돌**: 조명/룸 노트 생성은 `ensureUniqueTitle` 경유(앱 전역 규칙 준수).
- **빈 본문 룸 노트 열기**: onMount가 섹션+리스트 생성.
- **churn 최소화**: 새로고침은 멱등 — 변동 없으면 트랜잭션 없음. Dropbox는 명시 동기화만이므로 자동 push 없음(localDirty만). 컨트롤 노트라 허용.
- **플러그인 공존**(G10): 한 노트에 inline checkbox + inline radio + `tomboyInternalLink` 동시. `묶음:`은 룸 노트엔 안 씀(마스터에만). 데코/플러그인 순서는 plan에서 검증.
- **라디오 미선택**: active 씬 없으면 어느 라디오도 선택 안 됨.

## 10. 테스트

- `roomOps.test.ts`: `lightsInRoom`(owner 필터, 빈 룸, 누락), `groupedLightIdOf`(rid/null), `buildSceneActions`(CT vs color, off 캡처).
- `hueNoteParse.test.ts`: `room`/`room:<uuid>`/`bulb`/`master`/`none` 판별, zone 제거 확인.
- `hueImport.test.ts`: `planRoomImports` 멱등(기존 룸 스킵), 이름 폴백.
- `noteTypes` 카운트는 **불변**(room이 새 타입을 추가하지 않음) — 카운트 테스트 수정 불필요.
- `npm run check` 0 errors. `bridge` 변경 없음(테스트 영향 없음).
- 실하드웨어 검증은 수동(`npm run dev` + 실제 Hue 허브) — 자동 불가.

## 11. 가이드 문서

`설정 → 가이드 → 노트` 탭의 조명 카드를 갱신: 존→룸 전환, 룸 노트 사용법(체크박스=켬/끔, 라디오=씬), 마스터 가져오기 동작, 열 때 자동 새로고침, ⟳ 수동. (앱 전역 규칙: 사용자 기능은 가이드에 문서화.)
