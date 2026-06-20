---
name: tomboy-hue
description: Use when working on the 조명:: Hue light-control note family — per-bulb / room / master notes that drive a Philips Hue hub via the Pi bridge's /hue/{discover,pair,clip} CLIP v2 relay. Covers color.ts (RGB↔xy + gamut), hueNoteParse (kind/uuid 시그 판별), hueClient (bridge calls + context), hueImport (idempotent note creation), roomDoc (room body PM builder/walker + 체크박스/라디오 PMNode 컨텍스트), the editor plugin + BulbControl/GroupControl/MasterDashboard widgets, settings pairing, and the UUID-binding / open-time auto-refresh / real-scene invariants.
---

# tomboy-hue

`조명::` 노트로 Philips Hue 허브 제어. 설계: `docs/superpowers/specs/2026-06-19-hue-control-note-design.md`. 계획: `docs/superpowers/plans/2026-06-19-hue-control-note.md`.

## 노트 종류 (4가지)

| 종류 | 타이틀 | 본문 첫 줄 | 위젯 |
|---|---|---|---|
| 전구 노트 | `조명::<이름>` | `light:<uuid>` | BulbControl (색/밝기/on-off) |
| 방 노트 | `조명::<이름>` | `room:<uuid>` | GroupControl (체크박스+라디오) |
| 존 노트 | `조명::<이름>` | `zone:<uuid>` | GroupControl (체크박스+라디오) |
| 마스터 | `조명::전체` | (고정) | MasterDashboard (가져오기+전체 on/off) |

## 핵심 불변식

- 바인딩은 항상 light/room/zone **UUID**(이름/타이틀 아님). 본문 첫 줄 시그니처: `light:<uuid>` / `room:<uuid>` / `zone:<uuid>`. 마스터 = `조명::전체`.
- **방 노트 ⟳ / 노트 열기**: 허브에서 그 방의 전구 목록·씬 목록을 읽어 본문을 재빌드. 전구 = 체크박스 리스트(체크=on), 씬 = 라디오 리스트(선택=recall). 본문 교체는 `roomDoc.buildRoomDoc` → `roomDoc.applyRoomDoc` (PM 직접 교체, 멱등).
- **씬은 룸 스코프 진짜 Hue 씬.** Hue 앱에서 만든 씬도 라디오 목록에 나타남. "현재 상태 저장"은 그 방의 새 Hue 씬을 생성(CLIP v2 `POST /clip/v2/resource/scene`).
- **체크박스/라디오는 실제 PM 인라인 원자.** GroupControl 위젯의 `view.dom` `mousedown` 핸들러가 타입별 상호 배타(라디오는 같은 `listItem` 묶음 내 단 하나)를 강제하고 즉시 PUT/recall 전송.
- **room→device→light 역방향 조회.** 허브의 `grouped_light` → `room` → 멤버 `device` → 멤버 `light` 체인으로 실제 전구 uuid를 얻음. `roomOps.fetchRoomLights` 참조.
- 상태 읽기 = 노트 마운트 1회 자동 새로고침 + ⟳ 수동. 주기 폴링·SSE 없음. 쓰기 = 즉시 PUT + 옵티미스틱/롤백.
- 브릿지가 같은 LAN Hue 를 자체서명(`rejectUnauthorized:false`)으로 직접 호출. `/hue/clip` 은 resource-path 화이트리스트(`room/zone/scene/grouped_light/light/device`) + `..` 거부.
- 앱은 전역 터미널-브릿지 URL+토큰 재사용(별도 브릿지 설정 없음). Hue 크레덴셜(ip/appkey/clientkey)은 로컬 appSettings 에 저장하지만 **브릿지 파일이 단일 소스**(로컬은 브릿지 저장 실패 시 폴백).
- **브릿지가 creds 를 보관한다(단일 소스).** `bridge/src/hueCreds.ts` 가 `BRIDGE_HUE_FILE` JSON(`{ip,appkey,clientkey}`, 0600)을 read/write/clear. `/hue/pair` 성공 시 파일에 persist(`persisted` 플래그 반환), `/hue/clip` 은 `파일 ?? 클라` 순서로 creds 해석(**파일 우선**). 기기당 Hue 설정 0 — 한 기기에서 1회 페어링하면 같은 브릿지 토큰을 쓰는 모든 기기가 자동 동작.
- **`GET /hue/health`** `{configured, ip?}` (미구성이면 ip 없음; appkey/clientkey 미반환) — 앱 `hueClient.hueHealth`(15초 TTL 캐시, 실패는 캐시 안 함)가 호출해 로컬 creds 없는 기기의 구성 여부 판단. **`DELETE /hue/creds`** 로 브릿지 보관 creds 해제. 둘 다 `verifyToken` 게이트.
- 앱 `getHueContext`: 로컬 creds 있으면 동봉, 없으면 health 로 브릿지 구성 확인 후 creds 생략 호출. 사용 불가면 null. 설정에서 페어링 성공 시 로컬 creds 를 지워 `source:'bridge'` 로 인식(브릿지에서 해제 가능); 브릿지 저장 실패 시에만 로컬 폴백 보관.
- **마스터 가져오기** = `hueImport.planLightImports` (전구) + `planRoomImports` (방) + `planZoneImports` (존) → 멱등 노트 생성 → 본문에 묶음 세 개(전구/방/존 노트 목록 묶음) 작성.
- **방·존은 GroupControl 공유.** `groupKind: 'room'|'zone'` prop 으로 분기 — 멤버십만 다름(room=device children→`light.owner` 역추적 `lightsInRoom`; zone=`children` 의 light refs 직접 `lightsInZone`). 씬은 그룹 스코프(`scene.group.rid===groupId`), 저장 시 group rtype=groupKind. `roomDoc` 빌더/컨텍스트는 그룹 무관 재사용.

## 파일

- `app/src/lib/hue/` — color, hueTypes, hueNoteParse, hueClient, hueImport, roomOps, roomDoc, noteBody
- `app/src/lib/editor/hueNote/` — hueNotePlugin + BulbControl/GroupControl/MasterDashboard
- `bridge/src/hue.ts` + `hueCreds.ts` — discover/pair/clip/health/creds (CLIP v2 릴레이 + 파일 보관)
- 설정/페어링: `lib/storage/hueSettings.ts`, 설정 터미널 탭의 'Hue 조명' 섹션
- 등재: `lib/noteTypes/registry.ts` (`조명::`), TomboyEditor `tomboyHueNote` extension

## v1 제외(YAGNI)

scene action 줄단위 편집 · room 편집(읽기만) · eventstream 실시간 · clientkey/DTLS 엔터테인먼트 · mDNS 발견(클라우드+수동 IP만).
