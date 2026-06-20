# Hue 브릿지-보관 크레덴셜 설계

> 2026-06-20. `조명::` Hue 제어에서 기기당 Hue 페어링 설정을 없앤다. 브릿지가 Hue 크레덴셜(ip/appkey/clientkey)을 단일 소스로 보관하고, 모든 기기는 이미 가진 브릿지 URL+토큰만으로 조명을 제어한다.

## 목표

- **기기당 Hue 설정 = 0.** 터미널용으로 이미 설정한 브릿지 URL+토큰만 있으면 모든 기기에서 조명 동작.
- 브릿지가 `{ip, appkey, clientkey}` 단일 소스로 보관(쓰기 가능 JSON 파일).
- 페어링은 한 번(아무 기기에서) → 브릿지에 저장 → 이후 모든 기기 자동.
- 기존 동작(로컬 크레덴셜 보유 기기) 깨지지 않음.

## 비목표 (YAGNI)

- 다중 허브. 파일은 단일 `{ip, appkey, clientkey}`. 재페어링이 덮어씀.
- 존(zone) 재도입. 별도 spec 으로 이 작업 뒤에 진행.
- 크레덴셜 암호화. 평문 `0600`(기존 Pi 평문-비밀 자세 유지).
- 기존 기기 로컬 크레덴셜 자동 마이그레이션/삭제(브릿지 우선이므로 무시되어 무해).

## 권위 규칙

**브릿지 파일이 존재하면 항상 그것이 이긴다.** 클라이언트가 보낸 ip/appkey 는 파일이 없을 때만 폴백으로 사용된다. 효과: 브릿지에 한 번 구성하면, 스테일한 로컬 크레덴셜을 가진 기기도 자동으로 정상 동작한다. 단일 소스 오브 트루스.

## 아키텍처

### 브릿지 (`bridge/src/`)

```
hueCreds.ts (신규)         ← 파일 read/write/clear, 인메모리 캐시
hue.ts (수정)              ← pair persist, clip 폴백, health, creds DELETE
server.ts (수정)           ← 신규 라우트 배선 + BRIDGE_HUE_FILE 환경변수
```

#### `bridge/src/hueCreds.ts` (신규)

`hosts.ts`/`sshHosts.ts` 의 파일-기반 설정 패턴을 따른다.

```ts
export interface HueCreds { ip: string; appkey: string; clientkey: string; }

// 환경변수 BRIDGE_HUE_FILE 경로. 미설정이면 모든 함수 no-op/null.
export function readHueCreds(): HueCreds | null;   // 파일 없음/env 미설정/파싱 실패 → null
export function writeHueCreds(c: HueCreds): void;   // 원자적: temp→rename, perms 0600. env 미설정/쓰기 실패 시 throw.
export function clearHueCreds(): void;              // 파일 삭제(없으면 no-op). env 미설정 시 no-op.
```

- 경로는 `process.env.BRIDGE_HUE_FILE`. 미설정이면 읽기=null, **쓰기=throw**(호출부 pair 가 catch 해 `persisted:false`/`persistError` 로 표면화), 삭제=no-op.
- 인메모리 캐시: 첫 read 시 로드, write/clear 시 갱신. 디스크 stat 반복 회피.
- 원자적 쓰기: 같은 디렉터리에 `*.tmp` 작성 후 `renameSync`. perms `0600`(`writeFileSync(..., { mode: 0o600 })` + 기존 파일도 `chmodSync` 보정).

#### `bridge/src/hue.ts` 수정

- **`handleHuePair`**: 페어링 성공(`first.success.username` 획득) 후 `writeHueCreds({ip, appkey, clientkey})` 호출. 성공 응답에 `persisted: boolean` 필드 추가.
  - 쓰기 성공 → `{ appkey, clientkey, persisted: true }`.
  - 쓰기 실패(예: BRIDGE_HUE_FILE 미설정, 디스크 오류) → `{ appkey, clientkey, persisted: false, persistError: <reason> }`. 페어링 자체는 성공이므로 200 유지; 그 기기는 반환된 appkey 로 로컬 동작 가능.
- **`handleHueClip`**: 크레덴셜 해석 변경.
  ```
  const file = readHueCreds();
  const ip = file?.ip ?? <body.ip>;
  const appkey = file?.appkey ?? <body.appkey>;
  ```
  - `ip`/`appkey` 요청 바디에서 **선택**으로(현재는 둘 다 필수 → 400). 파일이 있으면 바디 ip/appkey 없어도 통과.
  - 해석 후에도 ip 또는 appkey 가 비면 기존처럼 400 `bad_request`.
  - 나머지(method/path 화이트리스트, `..` 거부) 변경 없음.

#### 신규 라우트 (`server.ts` 배선, `hue.ts` 핸들러)

- **`GET /hue/health`** → `handleHueHealth`. `verifyToken` 게이트. 응답 `{ configured: boolean, ip?: string }`.
  - `configured = readHueCreds() !== null`.
  - `ip` 는 구성됐을 때만 포함(LAN 주소, 비밀 아님 — 설정 화면 표시용).
  - **appkey/clientkey 는 절대 반환하지 않는다.**
- **`DELETE /hue/creds`** → `handleHueCredsDelete`. `verifyToken` 게이트. `clearHueCreds()` 후 `{ cleared: true }`.

### 앱 (`app/src/lib/`)

#### `hue/hueClient.ts` 수정

```ts
// 신규: 브릿지 health 조회
export async function hueHealth(): Promise<{ configured: boolean; ip?: string } | null>;
// 브릿지/토큰 없으면 null, 불통이면 null(폴백 트리거).

// 신규: 구성 상태 + 소스 판별 (UI 게이트용)
export type HueSource = 'bridge' | 'local' | 'none';
export async function hueConfigured(): Promise<{ ok: boolean; source: HueSource; ip?: string }>;
// 1) health.configured → { ok:true, source:'bridge', ip }
// 2) 로컬 ip+appkey 존재 → { ok:true, source:'local' }
// 3) 그 외 → { ok:false, source:'none' }
```

- **`getHueContext` 재작성**: 브릿지 URL+토큰이 있으면 항상 컨텍스트 반환(ip/appkey 는 옵셔널 필드로). `hueConfigured().source` 가 `bridge` 면 ip/appkey 생략, `local` 이면 로컬값 채움. 브릿지/토큰 자체가 없으면 `null`.
- **`hueClip` 요청 바디**: ip/appkey 가 빈 문자열/undefined 면 필드 생략(브릿지 파일이 채움). `ClipReq` 의 ip/appkey 를 옵셔널로.
- `hueCall` 시그니처/에러 동작(`HueError` kind/status) 불변 — 호출부(RoomControl/MasterDashboard/BulbControl) 수정 불필요.

#### 설정 Hue 탭 (`settings/+page.svelte` 의 Hue 섹션)

- 페어링 버튼: 기존 `huePair` 흐름 유지하되, 성공 시 응답 `persisted` 로 분기 — `persisted:true` → "브릿지에 저장됨", `false` → "이 기기에만 저장됨(브릿지 저장 실패: <reason>)".
- 상태줄: `hueHealth()` 결과로 "브릿지에 구성됨 (`<ip>`)" / "미구성". 로컬 폴백 크레덴셜이 있으면 보조 표기.
- "해제" 버튼: `DELETE /hue/creds` 호출(`hueClient` 에 `hueClearBridgeCreds()` 추가). 확인 후 실행.

## 데이터 흐름

```
[새 기기, 로컬 크레덴셜 없음]
  앱 마운트 → hueConfigured() → GET /hue/health (Bearer 브릿지토큰)
    → { configured:true, ip } → source:'bridge'
  조명 호출 → hueCall('GET','room') → POST /hue/clip { method, path }  (ip/appkey 없음)
    → 브릿지: readHueCreds() 로 ip/appkey 채워 Hue 허브 호출 → 응답 릴레이

[페어링, 아무 기기]
  설정 Hue → 허브 IP(발견 or 수동) → POST /hue/pair { ip }
    → 링크버튼 누름 → 브릿지: appkey 획득 → writeHueCreds() → { appkey, persisted:true }
  이후 모든 기기: 위 [새 기기] 흐름으로 자동 동작

[기존 기기, 로컬 크레덴셜 보유]
  POST /hue/clip { ip, appkey, method, path }
    → 브릿지: 파일 있으면 파일 우선(로컬 무시), 없으면 로컬 사용
```

## 오류 처리

| 상황 | 동작 |
|---|---|
| `/hue/health` 불통(브릿지 다운) | `hueHealth()` → null → 로컬 폴백 시도. 실제 호출은 기존 `HueError('unreachable')` toast. |
| creds 어디에도 없음 | clip 400 `bad_request` → `HueError('http',400)` → 기존 HTTP status toast. |
| 페어링 시 파일 쓰기 실패 | 200 유지 + `persisted:false`+`persistError`. 클라 toast "이 기기에만 저장됨(<reason>)". 그 기기는 로컬 appkey 로 동작. |
| `BRIDGE_HUE_FILE` 미설정 | health `configured:false`; pair `persisted:false` reason='unconfigured'; clip 은 클라 크레덴셜만으로 동작(기존과 동일). |
| 파일 손상/JSON 파싱 실패 | `readHueCreds()` → null(미구성 취급). 재페어로 복구. |

## 보안

- 파일은 appkey+clientkey **평문**, Pi 에 `0600`/브릿지 유저 소유. 기존 평문 비밀(duckdns 토큰)과 동일 자세 — 2026-06-15 브릿지 보안감사 백로그에 이미 기록됨. 추가 노출 아님.
- 신규 엔드포인트(`/hue/health`, `DELETE /hue/creds`)와 pair persist 전부 기존 `verifyToken(SECRET)` 게이트. **무인증 표면 추가 0.**
- `/hue/health` 는 appkey/clientkey 미반환(boolean + LAN ip 만).
- 재페어링은 **물리 링크버튼** 필요 → 원격 무단 덮어쓰기 자체-게이트.
- `DELETE /hue/creds` 는 토큰 게이트 + 복구 가능(재페어).
- 신뢰 경계 변화: 브릿지 토큰 단독으로 Hue 제어 가능해짐(appkey 불필요). 그 토큰은 이미 SSH 터미널 릴레이(풀 셸)를 열고 인터넷 노출(Caddy/duckdns)되므로 Hue 는 그보다 약함 — 의미 있는 신규 노출 아님.

## 테스트

### 브릿지 (`node --test`, NOT vitest)
- `hueCreds`: env 미설정 → read null/write·clear no-op; 설정 시 write→read 라운드트립; 원자적 쓰기(temp→rename); perms 0600; 손상 파일 → null.
- `handleHuePair`: 주입 `hueRequest` + temp `BRIDGE_HUE_FILE` → 성공 시 파일 기록 + `persisted:true`; 링크버튼(409) 시 미기록; 쓰기 실패 → `persisted:false`.
- `handleHueClip`: 파일 존재 시 파일 ip/appkey 우선(클라값 무시); 파일 없고 클라값 있으면 클라 사용; 둘 다 없으면 400; ip/appkey 생략 요청이 파일 있을 때 통과.
- `handleHueHealth`: 구성됨 → `{configured:true, ip}` (appkey/clientkey 부재 단언); 미구성 → `{configured:false}`.
- `handleHueCredsDelete`: 파일 삭제 후 health=false.
- 각 라우트 `mintToken(SECRET)` 인증 + 미인증 401.

### 앱 (vitest)
- `hueHealth`: fetch mock — 200 configured / 미구성 / 네트워크 오류→null / 브릿지 미설정→null.
- `hueConfigured`: bridge / local / none 세 분기.
- `getHueContext`: bridge 소스 → ip/appkey 생략; local 소스 → 값 채움; 브릿지 없음 → null.
- `hueClip`: ip/appkey 빈값일 때 바디에서 생략 단언.

## 영향 받는 파일

**브릿지**
- `bridge/src/hueCreds.ts` (신규)
- `bridge/src/hue.ts` (수정: pair persist, clip 폴백, health, creds delete)
- `bridge/src/server.ts` (수정: 라우트 배선 + BRIDGE_HUE_FILE)
- `bridge/test/hue.test.*` (수정/신규)
- 배포: Quadlet 유닛에 `BRIDGE_HUE_FILE` env + 볼륨/경로(README 갱신)

**앱**
- `app/src/lib/hue/hueClient.ts` (수정: hueHealth, hueConfigured, getHueContext, hueClip 옵셔널)
- `app/src/routes/settings/+page.svelte` (Hue 섹션: persisted 분기, health 상태줄, 해제 버튼)
- `app/tests/unit/hue/hueClient.test.ts` (신규/수정)

**문서**
- `.claude/skills/tomboy-hue/SKILL.md` (브릿지-보관 크레덴셜 불변식)
- `CLAUDE.md` (tomboy-hue 행 + 크로스커팅 토큰 ≡ 패턴에 BRIDGE_HUE_FILE 추가 여부)
- 설정 → 가이드 조명 카드(브릿지 1회 페어링 = 모든 기기 흐름)
- `bridge/deploy` README (BRIDGE_HUE_FILE)
