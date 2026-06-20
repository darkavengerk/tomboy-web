# Hue 조명 제어 노트 설계

- **날짜**: 2026-06-19
- **상태**: 설계 승인됨 (구현 대기)
- **워크트리/브랜치**: po
- **관련 스킬**: 신규 `tomboy-hue` (구현 후 작성), 기반 인프라 `tomboy-terminal`(브릿지), `tomboy-notebundle`(내부링크 리스트 패턴)

## 1. 목표

브릿지와 같은 LAN에 있는 **Philips Hue 스마트전구 허브**를 Tomboy 노트로 제어한다.

- 개별 전구 상태(전원/밝기/색)를 보고 설정한다.
- 전구 1개 = 노트 1개.
- 전구들을 묶어서 일괄 관리하는 **존(zone) 노트**가 있고, 노트의 링크 리스트가 곧 그룹 멤버십이다.
- 씬(scene) 적용/저장을 존 노트 안에서 한다.

## 2. 확정된 결정

| 축 | 결정 | 근거 |
|---|---|---|
| 노트 구조 | 전구 1개=노트 1개 + 존 노트 N개(각자 Hue zone에 1:1) + 마스터 대시보드 노트 | 사용자 직관(개별+묶음) |
| 노트 생성 | 마스터 노트 "가져오기" 버튼이 발견→노트 멱등 자동생성 | 전구 수십 개 수동 생성 비현실적 |
| 바인딩 키 | 항상 **light/zone UUID**(이름·타이틀 아님) | Hue v2 rid는 이름 바뀌어도 고정; 타이틀 중복 (2) 접미사에도 안전 |
| 상태 읽기 | 마운트 시 1회 fetch + ⟳ 수동 새로고침. **주기 폴링·SSE 없음** | 배터리·복잡도 최소 |
| 상태 쓰기 | 토글/슬라이드 시 즉시 PUT + 옵티미스틱 UI | 제어 패널 UX 기본 |
| 페어링 | 설정 새 'Hue/조명' 하위탭. appkey/clientkey/ip → appSettings | 기존 토큰 설정 패턴(`imageStorageToken` 등)과 동일 |
| 브릿지↔Hue | Pi 브릿지가 직접 CLIP v2 호출(`wol`/`suno` 패턴). 데스크탑 서비스 불필요 | Hue가 Pi와 같은 LAN, 무거운 작업 없음 |
| 존 멤버십 | **양방향** — 노트 링크 리스트 ⇄ `zone.children`, 둘 다 명시적 버튼 | "노트가 존을 정의" |
| 노트 식별 | 단일 `조명::` 타이틀 접두어 + 본문 첫 줄 시그니처로 분기 | `음악::`/`자동화::` 관리노트 패턴 |
| 풀-노트 takeover | 없음. 에디터 플러그인이 위젯 주입, 본문 편집 유지 | `automationNote` 패턴 — 모바일+데스크탑 자동 커버, 존 멤버십 링크가 편집 가능해야 함 |

## 3. Hue CLIP v2 사실 (검증됨)

브릿지가 호출하는 로컬 API. 자체서명 인증서 → `https.Agent({rejectUnauthorized:false})`.

- **헤더**: `hue-application-key: <appkey>` (v2의 모든 `/clip/v2/*` 호출).
- **페어링** (v1 엔드포인트로 키 발급): `POST https://<ip>/api` body `{"devicetype":"tomboy-web#<instance>","generateclientkey":true}`.
  - 링크 버튼 미押 → `[{"error":{"type":101,"description":"link button not pressed"}}]`.
  - 성공 → `[{"success":{"username":"<appkey>","clientkey":"<psk>"}}]`. `username`이 v2의 application key. clientkey는 재발급 불가(엔터테인먼트용, 저장만).
- **발견**: mDNS `_hue._tcp` 또는 클라우드 폴백 `https://discovery.meethue.com` (`[{"internalipaddress":"..."}]`).
- **light** `GET/PUT /clip/v2/resource/light/<id>`:
  - `on:{on:bool}` · `dimming:{brightness:0..100}` · `color:{xy:{x,y}, gamut, gamut_type}` · `color_temperature:{mirek:153..500}`.
  - **capability 판별**: `color`/`color_temperature`/`dimming` 키가 **없으면 미지원**(화이트 전용 전구 등). 있는 컨트롤만 위젯에 노출.
- **zone** `GET/POST/PUT /clip/v2/resource/zone`:
  - `{type:"zone", metadata:{name, archetype}, children:[{rid:"<light-uuid>", rtype:"light"}], services:[{rid, rtype:"grouped_light"}]}`.
  - 멤버십 = `children`(rtype `"light"`). 일괄 제어 서비스 = `services` 중 rtype `"grouped_light"`.
  - **room vs zone**: room은 디바이스 기반·배타적(전구 1개=방 1개). zone은 light 기반·겹침 허용. 노트의 "임의 전구 모음"은 **zone**에 매핑(room 아님). room은 v1 범위에서 읽기 전용.
- **grouped_light** `PUT /clip/v2/resource/grouped_light/<id>`: `{on, dimming, color}` (light과 동일 셰이프, 그룹 전체 적용).
- **scene** `GET/POST/PUT /clip/v2/resource/scene`:
  - `{type:"scene", metadata:{name}, group:{rid:"<zone>", rtype:"zone"}, actions:[{target:{rid:"<light>", rtype:"light"}, action:{on, dimming, color, color_temperature}}]}`.
  - 적용(recall): `PUT /clip/v2/resource/scene/<id>` body `{recall:{action:"active"}}`.

## 4. 컴포넌트 / 파일 배치

```
bridge/src/
  hue.ts            # /hue/discover, /hue/pair, /hue/clip 핸들러 (+ hue.test.ts, node --test)
  server.ts         # 라우트 3개 등록

app/src/lib/hue/
  hueClient.ts      # 앱→브릿지 호출 래퍼(discover/pair/clip), Bearer
  hueTypes.ts       # light/zone/room/grouped_light/scene v2 타입
  color.ts          # RGB↔xy(감마 + gamut 클램프), mirek↔kelvin
  hueNoteParse.ts   # 조명:: 노트 파싱: kind(bulb|zone|master) + uuid + 멤버십 링크
  hueImport.ts      # 발견→노트 멱등 생성(기존 uuid 스캔 후 skip)
app/src/lib/editor/hueNote/
  hueNotePlugin.ts  # automationNote 패턴 — 조명:: 타이틀 게이트, 위젯 데코레이션
  BulbControl.svelte
  ZoneControl.svelte   # grouped_light 바 + 멤버십 버튼 + 씬 섹션
  MasterDashboard.svelte
app/src/lib/storage/appSettings.ts  # hueBridgeIp / hueAppKey / hueClientKey
app/src/lib/noteTypes/registry.ts   # '조명::' 1개 추가
app/src/routes/settings/+page.svelte # Hue 페어링 하위탭 + 가이드 카드
```

**풀-노트 takeover 아님.** `automationNote`처럼 에디터 플러그인이 위젯을 본문 위에 데코레이션으로 주입하고 본문은 일반 편집 유지(전구 메모, 존 멤버십 링크 리스트가 살아있어야 함). 모바일 `/note/[id]` + 데스크탑 `NoteWindow` 둘 다 같은 플러그인이라 자동 커버.

## 5. 데이터 모델 — 노트 3종

바인딩은 **항상 UUID**. 디바이스 상태(on/bri/color)는 **노트에 저장하지 않음**(Hue가 소스). `.note` XML 본문에는 시그니처 + (존) 멤버십 링크 리스트 + 자유 메모만 남는다.

### 5.1 전구 노트
- 타이틀: `조명::<전구이름>`
- 본문 첫 줄: `light:<uuid>`
- 위젯(`BulbControl`): on/off 토글 · 밝기 슬라이더 · (CT 지원 시) 색온도 · (color 지원 시) 색 피커. capability는 light 리소스의 키 존재로 판별.
- 위젯 아래: 자유 메모 영역(일반 편집).

### 5.2 존 노트
- 타이틀: `조명::<존이름>`
- 본문 첫 줄: `zone:<uuid>` (아직 Hue에 미생성이면 `zone`)
- 위젯 상단(`ZoneControl`): grouped_light 일괄 바(전체 on/off·밝기·색) + 멤버십 동기 버튼 + 씬 섹션.
- 본문: 전구 노트로의 **내부링크 불릿 리스트 = 멤버십**.
  - PMNode **라이브 워크**로 internal-link 마크 추출(plain JSON text 스캔 금지 — inlineCheckbox atom 교훈). 항목당 링크 여러 개 허용(notebundle 규칙 재사용 검토).
  - 각 링크 → 전구 노트 → `light:<uuid>` 해석 → 멤버십 uuid 집합.
- `[Hue에 반영]`: 링크리스트 uuid → `PUT zone.children`. zone 미생성(`zone`)이면 `POST zone` 후 새 uuid를 본문 시그니처에 write-back.
- `[Hue에서 가져오기]`: `zone.children` → 각 light uuid에 해당하는 전구 노트 찾아 링크리스트 재작성.

### 5.3 마스터 노트
- 타이틀: `조명::전체` (Hue zone 아님 — 대시보드)
- `MasterDashboard`: `[전구 가져오기]`/`[존 가져오기]` 버튼(발견→멱등 생성) + 전 전구·전 존 링크 개요 + 전역 all on/off(알려진 light id 순회).
- 미페어링 시 "설정에서 Hue 연결" 안내.

## 6. 브릿지 API (`/hue/*`, 모두 Bearer `verifyToken`)

브릿지는 Hue 크레덴셜 **무상태** — ip/appkey는 매 호출 body로 전달(music `source` 패턴).

| 라우트 | body | 동작 |
|---|---|---|
| `GET /hue/discover` | — | mDNS `_hue._tcp` + `discovery.meethue.com` 폴백 → `{bridges:[{ip,id}]}` |
| `POST /hue/pair` | `{ip}` | `POST https://ip/api {devicetype, generateclientkey:true}` → error 101이면 `{error:"link_button"}`(409) / 성공이면 `{appkey, clientkey}` |
| `POST /hue/clip` | `{ip, appkey, method, path, body}` | `fetch(https://ip/clip/v2/resource/<path>, {method, headers:{'hue-application-key':appkey}, agent:insecure, body})` → 응답 status+본문 파이프 |

- `/hue/clip`의 `path`는 첫 세그먼트를 화이트리스트(`light`/`zone`/`room`/`grouped_light`/`scene`/`device`)로 검증 → 임의 LAN SSRF 축소.
- 자체서명 인증서 → 모듈 상수 `https.Agent({rejectUnauthorized:false})` 1개 재사용.

## 7. 데이터 흐름

- **읽기**: 위젯 마운트 → `hueClient.clip('GET', 'light/<uuid>')` 1회 → 상태 표시. ⟳ = 재fetch. 주기 폴링 없음.
- **쓰기(즉시)**: 토글/슬라이드 → 옵티미스틱 UI 갱신 + `clip('PUT','light/<uuid>', body)`. 실패 → 이전 상태 롤백 + 한국어 토스트.
- **존 일괄**: grouped_light 바 → `clip('PUT','grouped_light/<id>', body)`.
- **멤버십**: 6절 두 버튼(양방향, 명시적).
- **색**: `color.ts`가 RGB→xy(Philips 변환 + 해당 light `color.gamut` 삼각형 클램프), CT는 mirek 직통. ⚠️ light별 gamut이 달라 가장 까다로운 부분 — 구현 위험.

## 8. 페어링 / 설정 (설정 → 새 'Hue/조명' 하위탭)

1. `[브릿지 찾기]` → `/hue/discover` → 후보 IP 목록.
2. IP 선택 → "허브의 링크 버튼을 누르세요" 안내.
3. `[연결]` → `/hue/pair {ip}` → 성공 시 `hueBridgeIp`/`hueAppKey`/`hueClientKey` appSettings 저장. 101 → "브릿지 링크 버튼 누르고 다시".
4. 연결됨 표시 + `[연결 해제]`(설정 초기화).

## 9. 씬 (존 노트 안)

- recall 버튼들: `clip('GET','scene')` → `group.rid == 존uuid` 필터 → 이름 버튼 나열. 클릭 = `clip('PUT','scene/<id>', {recall:{action:"active"}})`.
- `[현재 상태를 씬으로 저장]`: 존 멤버 각 light 현재 상태 fetch → `clip('POST','scene', {metadata, group, actions})`.
- 개별 action 줄단위 편집은 **v1 제외(YAGNI)**.

## 10. 에러 처리 (전부 한국어 토스트)

| 상황 | 처리 |
|---|---|
| 브릿지 연결 안 됨 | 503 → "조명 브릿지에 연결 안 됨" |
| 미페어링(appkey 없음) | "설정에서 Hue를 먼저 연결" |
| 링크버튼 미押 | "브릿지 링크 버튼 누르고 다시" |
| light 사라짐(4xx/404) | 위젯 "오프라인/제거됨" 표시 |
| 타이틀 중복(자동생성) | titleRewrite `(2)` 접미사 — uuid 바인딩이라 링크 안전 |
| 멤버십 링크가 전구 노트 아님/uuid 없음 | 해당 항목 skip + 경고 토스트 |

## 11. 테스트

- `hueNoteParse` 유닛: bulb/zone/master 분기, uuid 추출, **PMNode 멤버십 링크 추출**(atom 안전).
- `color.ts` 유닛: RGB↔xy 라운드트립 + gamut 클램프 경계 + mirek↔kelvin.
- `hueClient` 유닛: 브릿지 fetch mock, 요청 셰이핑, 에러 매핑.
- `hueImport` 유닛(fake-indexeddb): 멱등 — 기존 uuid 재실행 시 중복 노트 생성 안 함.
- `bridge/src/hue.test.ts`(node --test, `mintToken`): discover/pair/clip 릴레이, 101 매핑, path 화이트리스트 거부.
- 실 Hue 없음 — `npm run dev` + 브라우저 수동 검증.

## 12. 보안

- appkey 매 호출 app→브릿지(Bearer 보호). 브릿지→Hue 자체서명 `rejectUnauthorized:false` — LAN-only, MITM 위험 가정 낮음. 브릿지 보안감사 백로그에 "LAN https 신뢰" 항목 추가.
- `/hue/clip` path 화이트리스트로 SSRF 표면 축소.
- clientkey는 엔터테인먼트 DTLS용 — v1에선 저장만, 미사용.

## 13. 가이드 (CLAUDE.md 강제)

`설정 → 가이드 → notes` 탭에 `<details class="guide-card">` 추가: `조명::` 노트 3종, 페어링 흐름, ⟳ 의미, 존 양방향 멤버십, 씬. summary + info-text intro + snippet(`조명::거실` 예시) + guide-list(제약/주의 + 설정탭 링크 버튼).

## 14. CLAUDE.md 인덱스

스킬 테이블에 `tomboy-hue` 행 추가(구현 후 SKILL.md 작성). 두-채널/접두어 노트 패밀리에 `조명::` 등재.

## 15. YAGNI (v1 제외)

scene action 줄단위 편집 · room 노트 편집(읽기만) · eventstream 실시간 · smart_scene · 전역 all-zone 자동생성 · clientkey/DTLS 엔터테인먼트.

## 16. 구현 위험 / 검증 필요

- **색 gamut 변환**(7절·11절): light 모델별 gamut A/B/C. 잘못하면 색이 어긋남. 가장 먼저 TDD로 고정.
- **grouped_light id 획득**: zone/room 리소스의 `services[]`에서 rtype `grouped_light` 추출 — 구현 시 실 응답으로 확인.
- **양방향 멤버십 충돌**: 노트와 Hue 둘 다 바뀐 경우 — v1은 "마지막 누른 버튼 승"(자동 머지 없음). 사용자에게 방향 명시.
