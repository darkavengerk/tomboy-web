# 음악 크로스-디바이스 v2 개선 설계

> 5개 개선: 단일 재생(기기간) · 모바일 홈 FAB · 연속성 picker · 노트 기록 축소 · 위치 별도 경량 채널

**작성일:** 2026-06-23
**브랜치:** shifu
**선행:** `2026-06-22-music-control-note.md` (음악제어:: 노트 + global-latest 핸드오프 최초 구현). 이 설계는 그 위에서 데이터 모델을 슬림화하고 위치를 별도 채널로 분리한다.

---

## Goal

한 번에 한 곳에서만 음악이 흐르고, 기기를 바꿔도 듣던 위치에서 자연스럽게 이어지며, 그 동기화 비용(Firestore 쓰기 크기/빈도)이 작은 음악 시스템.

## 핵심 결정 요약

| # | 결정 |
|---|---|
| 1 | 단일 재생: 다른 기기에서 재생 시작하면 현재 재생 기기는 자동 일시정지 |
| 2 | 모바일 떠다니는 알약(GlobalMiniPlayer) 제거 → 홈노트 FAB 스택에 재생/정지 둥근 버튼 추가 |
| 3 | 재생 누를 때 로컬·원격 기록이 서로 다른 곡이면 picker(모바일 팝업/데스크탑 확장메뉴), 아니면 바로 재생 |
| 4 | 음악제어:: 노트 record에서 `queue`/`index`/`playlistLabel`/`position` 제거 → 받는 기기가 noteGuid 재파싱으로 큐 복원 |
| 5 | 재생 위치(10초 주기)는 노트가 아니라 **신규 경량 Firestore 컬렉션**(`users/{uid}/deviceState/{deviceId}`)에 저장 |

---

## Architecture — 두 개의 크로스-디바이스 채널

크로스-디바이스 음악 상태를 **내구성(durable)** 과 **휘발성(ephemeral)** 두 채널로 분리한다.

### 채널 A — 내구성 "지금 뭐 재생 중" → 음악제어:: 노트

- **저장소:** 기존 `음악제어::` 싱글톤 노트 (`MUSIC_CONTROL_GUID`) 본문의 숨겨진 JSON 마커.
- **쓰기 시점:** 명시적 transport 이벤트 — `play` / `pause` / `stop` / **`track-change`(신규)**. 주기적 쓰기 없음.
- **동기화:** 기존 노트-싱크 채널(Firestore 실시간 + Dropbox). 변경 없음.
- **레코드 스키마(슬림):**

```ts
interface MusicControlRecord {
  deviceId: string;     // 이 기기 설치 식별자
  deviceName: string;   // 표시용 (picker "아이폰" 등)
  noteGuid: string;     // 재생 출처 음악 노트 guid (큐 재구성 키)
  trackUrl: string;     // 현재 트랙 url (큐 내 위치 찾기 + 위치-검증 키)
  trackTitle: string;   // 표시용 (picker / 미디어세션)
  noteTitle: string;    // 표시용 (picker "음악::로제")
  state: 'playing' | 'paused' | 'stopped';
  updatedAt: string;    // ISO-8601, 충돌/신선도 판정 키
}
```

제거되는 필드(이전 v1 대비): `queue`, `index`, `playlistLabel`, `position`.
- `queue`/`index`/`playlistLabel` → 받는 기기가 `noteGuid` 노트를 `parseMusicNote`로 재파싱해 복원(아래 4번).
- `position` → 채널 B로 이동(아래 5번).

레코드 크기: ~850B → ~250B. 5-기기 배열: ~4.2KB → ~1.25KB.

### 채널 B — 휘발성 "재생 위치" → 신규 Firestore 컬렉션

- **저장소:** 신규 `users/{uid}/deviceState/{deviceId}` (기기당 문서 1개). 범용 휘발성 런타임 정보 bag — 앞으로 다른 류(예: 볼륨, 마지막 활동 등) 추가 가능하게 설계.
- **문서 스키마:**

```ts
interface DeviceStateDoc {
  position: number;     // 재생 위치(초)
  trackUrl: string;     // 이 위치가 속한 트랙 (불일치 시 위치 무시)
  updatedAt: Timestamp; // Firestore serverTimestamp()
}
```

- **쓰기 시점:** 재생 중 **10초마다** + `pause`/`stop`/`seek` 직후 즉시. 위치만 바뀌는 throttle 갱신은 채널 A를 절대 건드리지 않는다.
- **동기화:** 노트-싱크/Dropbox와 **완전 별개**. 전용 Firestore 클라이언트(`deviceStateSync`)가 직접 `setDoc`/`getDoc`. XML/노트 본문에 들어가지 않는다.
- **읽기:** 받는 기기가 이어듣기를 시작하는 순간 **1회 `getDoc`** (지속 리스너 불필요 — 단일 재생이라 활성 기기는 하나, 위치는 재생 시작 순간에만 필요). 채널 A(노트)에서 active `deviceId` + `trackUrl`을 얻어 `deviceState/{deviceId}` 1회 조회.
- **보안 룰:** 기존 `users/{uid}/**` 규칙(`firestore.rules`)이 새 하위경로를 이미 커버한다고 가정. 구현 1단계에서 `firestore.rules` 확인 — 만약 경로별 명시 규칙이라 커버 안 되면 `match /deviceState/{deviceId}` 규칙을 추가한다.

### 채널 정합 — track-change 노트 쓰기 추가 (load-bearing)

현재 자동 넘김(`onEnded → next`)은 노트에 기록하지 않는다. 그러면 노트의 `trackUrl`(예: 1번곡)과 채널 B의 위치(2번곡으로 진행)가 어긋난다. 따라서 **track-change에도 채널 A 노트 record를 1회 write**(곡당 ~1회, 미미). 이로써:

- 노트 `trackUrl` = 항상 현재 트랙.
- 채널 B `trackUrl` = 같은 순간 같은 트랙.
- 받는 기기: 노트(현재 트랙+noteGuid) → 큐 재구성 → 채널 B 위치(trackUrl 일치 시) seek. 정합.

### Join 다이어그램

```
기기 A (재생 중)                          기기 B (이어받기)
─────────────                          ─────────────
[채널 A] 노트 record write               note-sync 실시간 →  noteGuid·trackUrl·state·deviceId 수신
  (play/pause/stop/track-change)                            │
[채널 B] deviceState/{A} write                              ├─ #1: state==='playing' & 더 새 record & 다른 기기
  (10s + pause/stop/seek)                                   │      → (B가 재생 중이면 B 자동 일시정지)
                                                            └─ 이어듣기 결정 시:
                                                                 noteGuid 재파싱 → 큐+인덱스 복원
                                                                 getDoc deviceState/{A} → 위치(trackUrl 일치) → seek
```

---

## 기능별 동작

### 1. 단일 재생 (기기간)

- **기기 내부:** 이미 단일(전역 오디오 엔진 1개). 변경 없음.
- **기기간:** `refreshFromNote`가 채널 A에서 **다른 기기**의 record가 (a) `state==='playing'` 이고 (b) `updatedAt`이 내 마지막 재생 액션보다 더 새것이면 → 이 기기가 재생 중일 경우 **자동 일시정지**(`musicPlayer.pause()` — 큐/인덱스/위치 유지, 오디오만 정지). 큐를 비우지 않는다.
- 현재 `refreshFromNote`의 "재생 중이면 yank 안 함" 가드를 **분기**한다: 다른 기기의 새 playing record면 pause(정지), 그 외(paused/stopped, 또는 더 오래된 것)는 무시.
- **레이스:** A·B가 거의 동시에 재생 → 각자 playing record write. `updatedAt`(ms 정밀)으로 후발자가 "최신". 후발자는 선발자(더 오래됨)를 보고도 정지하지 않음; 선발자는 후발자(더 새것)를 보고 정지. 스래시 없음. 동률(거의 불가)이면 deviceId 사전순 tie-break.

### 2. 모바일 홈 FAB + 떠다니는 알약 제거

- **제거:** `GlobalMiniPlayer.svelte`(드래그 알약) + `+layout.svelte`의 마운트. 부속 `miniPlayerVisibility.ts`, `miniPlayerDrag.ts` 삭제(다른 곳에서 안 쓰임 — 구현 시 grep 확인).
- **추가:** 홈노트 FAB 스택(`routes/note/[id]/+page.svelte`, `?from=home`)에 3번째 둥근 버튼.
  - 위치: `position:absolute; bottom: calc(88px + 56px*2) = 200px; right:20px; z-index:10` (📅 144px, 🎲 88px 위).
  - 크기/모양: 48×48 원형, 기존 FAB와 동일 클래스 패턴(`box-shadow`, `background:var(--color-bg)`, press 시 `scale(0.93)`).
  - 편집 포커스 시 페이드(기존 `.fab-*` 셀렉터에 합류).
  - 아이콘: 재생 중 ⏸ / 아니면 ▶ (이모지 또는 인라인 SVG — 기존 이모지 관행 따름).
  - 표시 조건: `isFromHome && (활성 세션 있음 || 원격 record 있음)`. 둘 다 없으면 숨김.
  - 탭: 전역 재생/정지 토글. 단, picker 조건(아래 3번) 충족 시 picker 먼저. 전역 싱글톤을 제어하므로 어느 노트를 보든 동작.
  - 제스처 규칙: 재생 시작은 반드시 onclick 동기 구간에서 `resumePlaybackFromGesture()` 호출(iOS 자동재생). 새 버튼이라 빠지기 쉬움 — 필수.
- 더 세밀한 조작(스킵/곡 선택)은 음악 노트를 직접 연다. 모바일 잠금화면 미디어 컨트롤은 그대로 유지(별도 조작 수단).

### 3. 연속성 picker (로컬 vs 원격)

- **로컬 기록:** 이 기기의 `musicSession`(마지막 로컬 세션) / 현재 `musicPlayer` 큐.
- **원격 기록:** 채널 A의 다른 기기 최신 record(`globalLatest`) + 채널 B 위치.
- **트리거:** 재생 버튼(홈 FAB[모바일] / 레일 ▶[데스크탑])을 누를 때 — 로컬·원격이 **둘 다 존재**하고 **다른 곡**(`trackUrl` 다름)이면 picker. 하나뿐이거나 같은 곡이면 바로 재생, picker 없음.
- **UI:** 모바일 = 바텀시트 팝업(2 항목: "이 기기: {track}" / "{deviceName}: {track}"). 데스크탑 = 좌패널(레일)에서 확장 메뉴.
- **선택 결과:**
  - 로컬 → 기존 세션 resume(`resumeOrRestart`).
  - 원격 → noteGuid 재파싱으로 큐 복원 + active index 설정 + 채널 B 위치 seek + 재생. (= 기존 `refreshFromNote` 복원 경로를 명시적으로 트리거.)
- `--z-sheet`/`--z-menu` 토큰 규약 준수(모바일 시트=`--z-sheet`, 데스크탑 확장메뉴=`--z-menu` 또는 인-패널 로컬 컨텍스트).

### 4. 노트 record 축소 + 큐 재파싱

- 채널 A 스키마에서 `queue`/`index`/`playlistLabel`/`position` 제거(위 Architecture A).
- **큐 복원:** 받는 기기가 `noteGuid`로 노트 로드 → `parseMusicNote` → `flatQueue`에서 `trackUrl` 위치 = index → 큐+index 복원.
- **폴백:** noteGuid 노트가 이 기기에 아직 동기화 안 됨/없음 → v1처럼 단일 합성 트랙(`{url:trackUrl, title:trackTitle, ...}`) 큐로 폴백(⏭은 못 하지만 재생은 됨).
- `tracksFromRecord`(현재 `r.queue` 우선)를 **노트 재파싱 우선 → 합성 폴백**으로 교체.

### 5. 위치 10초 기록 → 채널 B

- `musicAudio`/`musicPlayer`에 위치 ticker: 재생 중 10초마다 `deviceStateSync.writePosition(position, trackUrl)`. `pause`/`stop`/`seek` 직후에도 즉시 1회.
- 받는 기기 이어듣기: 채널 B `getDoc` → `position`. 없음/`trackUrl` 불일치 → 0:00부터.
- **로컬 같은-기기 이어듣기는 기존 `musicProgress`(localStorage) 유지** — 채널 B는 순수 크로스-디바이스용. 두 저장소 스코프 분리(로컬=musicProgress, 기기간=deviceState). 섞지 않는다.

---

## 신규 모듈: `lib/music/deviceStateSync.ts`

기존 `lib/sync/firebase/` DI 패턴을 따른다(순수 코어 + 주입형 Firestore 프리미티브 + firestore 어댑터).

```ts
// 순수 인터페이스
interface DeviceStateClient {
  writePosition(deviceId: string, position: number, trackUrl: string): Promise<void>;
  readDeviceState(deviceId: string): Promise<DeviceStateDoc | null>;
}
```

- 게이트: `firebaseNotesEnabled` 설정 OFF거나 `getCurrentNoteSyncUid()` null이면 write/read는 no-op(노트 싱크와 동일 게이트).
- write throttle: 모듈이 10초 최소 간격 보장(연속 timeupdate가 매번 쓰지 않게). pause/stop/seek는 throttle 우회 즉시 flush.
- 실 어댑터: `users/{uid}/deviceState/{deviceId}` 문서에 `setDoc({position, trackUrl, updatedAt: serverTimestamp()}, {merge:true})`.
- 설치: `+layout.svelte`에서 1회(`installDeviceStateSync()` 또는 기존 음악 설치 경로에 합류). uninstall 짝.
- 테스트: 순수 throttle/게이트 로직은 주입형 fake로 단위 테스트.

---

## 엣지 케이스 & 하위호환

- **구 v1 record(큐 포함)** 가 노트에 남아있을 수 있음 → 슬림 리더는 `queue`/`index`/`position` 필드를 **무시**(있어도 안 읽음). 깨지지 않음.
- **구 기기가 큐 포함 record를 write** → 신 기기는 무시하고 noteGuid 재파싱. 정상.
- **신 기기가 슬림 record write** → 구 기기는 `queue` 없으니 기존 합성-폴백 경로로 단일곡 재생(이미 v1에 존재). 정상.
- **채널 B 없음/오프라인** → 0:00부터(데이터 손실 아님, 그냥 처음부터).
- **noteGuid 미동기화** → 단일곡 폴백.
- **2기기 동시 재생** → updatedAt 후발자 승(위 1번 레이스).
- **stopped record** → 채널 A에서 스테이징 안 함(기존 동작 유지), 단 global-latest 포인터는 갱신.

## 보안

- 채널 B는 사용자 자신의 `users/{uid}/...` 네임스페이스. 기존 룰 커버 가정 + 1단계 확인. 타 사용자 접근 불가(uid = dbx-{account_id}).
- 비밀/토큰 없음. 위치(초)는 민감정보 아님.

## 테스트

- `app/tests/unit/music/`:
  - 슬림 record 직렬화/파싱(구 필드 무시) 라운드트립.
  - `tracksFromRecord` 노트-재파싱 우선 + 단일곡 폴백.
  - `refreshFromNote` #1 분기: 다른 기기 playing 더 새것 → pause; 더 오래됨/paused → 무시.
  - 레이스 tie-break.
  - `deviceStateSync` throttle(10초 최소) + 게이트(OFF시 no-op) + pause/seek 즉시 flush.
  - picker 술어: local≠remote일 때만 표시(순수 함수).
  - FAB 가시성 술어.
- `__reset*` 싱글톤 격리 `beforeEach` 필수.
- 회귀 잠금: 기존 음악-컨트롤 테스트가 슬림 스키마로 깨지지 않게 갱신(없어진 queue 단언 제거/이전).

## 설정 → 가이드 갱신

`settings/+page.svelte` 가이드 카드 갱신(`guideSubTab: notes`의 음악제어 카드):
- "한 곳에서만 재생, 다른 기기서 재생 누르면 현재 기기 정지."
- "홈 화면 재생 버튼으로 어디서든 재생/정지."
- "재생 누를 때 이 기기/다른 기기 중 선택(다를 때)."
- 떠다니던 알약 사라짐 언급.

## 파일 맵

**생성**
- `app/src/lib/music/deviceStateSync.ts` — 채널 B 클라이언트(순수 + 어댑터) + 설치자.
- `app/src/lib/music/deviceStateSync.firestore.ts` (또는 어댑터 동거) — 실 Firestore 와이어링.
- `app/src/lib/editor/musicNote/MusicContinuityPicker.svelte` — 로컬/원격 선택 UI(모바일 시트 + 데스크탑 메뉴, 또는 얇은 두 래퍼).
- 단위 테스트들(`app/tests/unit/music/`).

**수정**
- `app/src/lib/music/musicControlNote.ts` — 슬림 record 타입 + 직렬화/파싱(구 필드 무시).
- `app/src/lib/music/musicControl.svelte.ts` — 슬림 write, track-change write, `tracksFromRecord` 재파싱, `refreshFromNote` #1 분기, 원격-resume 진입점(picker용).
- `app/src/lib/music/musicPlayer.svelte.ts` — 10초 위치 ticker 훅, track-change transport emit, 원격-resume 메서드.
- `app/src/lib/music/musicAudio.svelte.ts` — position ticker 연결(timeupdate→throttled write), seek/pause 즉시 flush.
- `app/src/routes/+layout.svelte` — GlobalMiniPlayer 마운트 제거, deviceStateSync 설치.
- `app/src/routes/note/[id]/+page.svelte` — 홈 음악 FAB 추가(+가시성+picker 연결).
- `app/src/lib/editor/musicNote/RailMusicControls.svelte` — 데스크탑 picker(확장메뉴) 연결.
- `app/src/routes/settings/+page.svelte` — 가이드 카드 갱신.
- `firestore.rules` — 필요 시 deviceState 경로 규칙(1단계 확인 후).

**삭제**
- `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte`
- `app/src/lib/editor/musicNote/miniPlayerVisibility.ts`
- `app/src/lib/editor/musicNote/miniPlayerDrag.ts`
- (관련 테스트 정리)

## 비목표 (YAGNI)

- 채널 B의 지속 리스너(라이브 위치 추종) — 불필요. 재생 시작 순간 1회 read로 충분.
- 핸드셰이크 프로토콜 — 채널 B의 ≤10s 신선도 + #1로 자연 핸드오프, 불필요.
- 위치 외 휘발성 필드(볼륨 등) — 스키마는 확장 가능하게 두되 지금 구현 안 함.
- 기존 Dropbox/note XML 라운드트립 변경 — 없음.
