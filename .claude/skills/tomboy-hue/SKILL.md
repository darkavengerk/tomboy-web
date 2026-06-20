---
name: tomboy-hue
description: Use when working on the 조명:: Hue light-control note family — per-bulb / room / master notes that drive a Philips Hue hub via the Pi bridge's /hue/{discover,pair,clip} CLIP v2 relay. Covers color.ts (RGB↔xy + gamut), hueNoteParse (kind/uuid 시그 판별), hueClient (bridge calls + context), hueImport (idempotent note creation), roomDoc (room body PM builder/walker + 체크박스/라디오 PMNode 컨텍스트), the editor plugin + BulbControl/RoomControl/MasterDashboard widgets, settings pairing, and the UUID-binding / open-time auto-refresh / real-scene invariants.
---

# tomboy-hue

`조명::` 노트로 Philips Hue 허브 제어. 설계: `docs/superpowers/specs/2026-06-19-hue-control-note-design.md`. 계획: `docs/superpowers/plans/2026-06-19-hue-control-note.md`.

## 노트 종류 (3가지)

| 종류 | 타이틀 | 본문 첫 줄 | 위젯 |
|---|---|---|---|
| 전구 노트 | `조명::<이름>` | `light:<uuid>` | BulbControl (색/밝기/on-off) |
| 방 노트 | `조명::<이름>` | `room:<uuid>` | RoomControl (체크박스+라디오) |
| 마스터 | `조명::전체` | (고정) | MasterDashboard (가져오기+전체 on/off) |

## 핵심 불변식

- 바인딩은 항상 light/room **UUID**(이름/타이틀 아님). 본문 첫 줄 시그니처: `light:<uuid>` / `room:<uuid>`. 마스터 = `조명::전체`.
- **방 노트 ⟳ / 노트 열기**: 허브에서 그 방의 전구 목록·씬 목록을 읽어 본문을 재빌드. 전구 = 체크박스 리스트(체크=on), 씬 = 라디오 리스트(선택=recall). 본문 교체는 `roomDoc.buildRoomDoc` → `roomDoc.applyRoomDoc` (PM 직접 교체, 멱등).
- **씬은 룸 스코프 진짜 Hue 씬.** Hue 앱에서 만든 씬도 라디오 목록에 나타남. "현재 상태 저장"은 그 방의 새 Hue 씬을 생성(CLIP v2 `POST /clip/v2/resource/scene`).
- **체크박스/라디오는 실제 PM 인라인 원자.** RoomControl 위젯의 `view.dom` `mousedown` 핸들러가 타입별 상호 배타(라디오는 같은 `listItem` 묶음 내 단 하나)를 강제하고 즉시 PUT/recall 전송.
- **room→device→light 역방향 조회.** 허브의 `grouped_light` → `room` → 멤버 `device` → 멤버 `light` 체인으로 실제 전구 uuid를 얻음. `roomOps.fetchRoomLights` 참조.
- 상태 읽기 = 노트 마운트 1회 자동 새로고침 + ⟳ 수동. 주기 폴링·SSE 없음. 쓰기 = 즉시 PUT + 옵티미스틱/롤백.
- 브릿지가 같은 LAN Hue 를 자체서명(`rejectUnauthorized:false`)으로 직접 호출. `/hue/clip` 은 resource-path 화이트리스트(`room/scene/grouped_light/light/device`) + `..` 거부.
- 앱은 전역 터미널-브릿지 URL+토큰 재사용(별도 브릿지 설정 없음). Hue 크레덴셜(ip/appkey/clientkey)은 appSettings.
- **마스터 가져오기** = `hueImport.planLightImports` (전구) + `hueImport.planRoomImports` (방) → 멱등 노트 생성 → 본문에 묶음 두 개(전구 노트 목록 묶음 + 방 노트 목록 묶음) 작성.
- **존(zone) 포맷은 제거됨.** 기존 `zone:<uuid>` 시그니처, `zoneOps.ts`, `ZoneControl.svelte`는 Tasks 1-6에서 삭제됨.

## 파일

- `app/src/lib/hue/` — color, hueTypes, hueNoteParse, hueClient, hueImport, roomOps, roomDoc, noteBody
- `app/src/lib/editor/hueNote/` — hueNotePlugin + BulbControl/RoomControl/MasterDashboard
- `bridge/src/hue.ts` — discover/pair/clip (CLIP v2 릴레이)
- 설정/페어링: `lib/storage/hueSettings.ts`, 설정 터미널 탭의 'Hue 조명' 섹션
- 등재: `lib/noteTypes/registry.ts` (`조명::`), TomboyEditor `tomboyHueNote` extension

## v1 제외(YAGNI)

scene action 줄단위 편집 · room 편집(읽기만) · eventstream 실시간 · clientkey/DTLS 엔터테인먼트 · mDNS 발견(클라우드+수동 IP만).
