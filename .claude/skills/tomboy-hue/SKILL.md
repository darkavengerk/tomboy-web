---
name: tomboy-hue
description: Use when working on the 조명:: Hue light-control note family — per-bulb / zone / master notes that drive a Philips Hue hub via the Pi bridge's /hue/{discover,pair,clip} CLIP v2 relay. Covers color.ts (RGB↔xy + gamut), hueNoteParse (kind/uuid + PMNode membership), hueClient (bridge calls + context), hueImport (idempotent note creation), the editor plugin + BulbControl/ZoneControl/MasterDashboard widgets, settings pairing, and the UUID-binding / manual-refresh / two-way-membership invariants.
---

# tomboy-hue

조명:: 노트로 Philips Hue 허브 제어. 설계: `docs/superpowers/specs/2026-06-19-hue-control-note-design.md`. 계획: `docs/superpowers/plans/2026-06-19-hue-control-note.md`.

## 핵심 불변식
- 바인딩은 항상 light/zone **UUID**(이름/타이틀 아님). 본문 첫 줄 시그니처: `light:<uuid>` / `zone:<uuid>`(미생성이면 `zone`). 마스터 = `조명::전체`.
- 상태 읽기 = 마운트 1회 + ⟳ 수동. 주기 폴링·SSE 없음. 쓰기 = 즉시 PUT + 옵티미스틱/롤백.
- 브릿지가 같은 LAN Hue 를 자체서명(`rejectUnauthorized:false`)으로 직접 호출. `/hue/clip` 은 resource-path 화이트리스트 + `..` 거부.
- 존 멤버십 양방향: 노트 내부링크 리스트 ⇄ zone.children. 충돌 시 "마지막 버튼 승".
- capability 판별 = light 리소스의 `color`/`color_temperature`/`dimming` 키 존재.
- 앱은 전역 터미널-브릿지 URL+토큰 재사용(별도 브릿지 설정 없음). Hue 크레덴셜(ip/appkey/clientkey)은 appSettings.

## 파일
- `app/src/lib/hue/` — color, hueTypes, hueNoteParse, hueClient, hueImport, zoneOps, noteBody
- `app/src/lib/editor/hueNote/` — hueNotePlugin + BulbControl/ZoneControl/MasterDashboard
- `bridge/src/hue.ts` — discover/pair/clip
- 설정/페어링: `lib/storage/hueSettings.ts`, 설정 터미널 탭의 'Hue 조명' 섹션
- 등재: `lib/noteTypes/registry.ts` (`조명::`), TomboyEditor `tomboyHueNote` extension

## v1 제외(YAGNI)
scene action 줄단위 편집 · room 편집(읽기만) · eventstream 실시간 · clientkey/DTLS 엔터테인먼트 · mDNS 발견(클라우드+수동 IP만).
