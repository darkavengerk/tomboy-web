# 음악제어:: 노트 — 기기간 재생 상태 공유 (v1)

작성일: 2026-06-22
상태: 설계 승인 대기 → 구현 플랜

## 목표

`음악제어::` 제목을 가진 **단 하나의** 전용 노트를 도입한다. v1 의 기능은
**기기간 재생 상태 공유**: 한 기기에서 음악을 재생/일시정지/정지하면 그 기록이
이 노트에 남고, 다른 기기에서 멈춘 상태로 ▶ 를 누르면 **전역에서 가장 최근에
재생된 곡을 그 위치에서 이어 재생**한다.

이 노트는 앞으로 음악 관련 여러 정보를 담는 허브로 확장될 예정이므로, 사용자가
자유롭게 본문을 편집할 수 있어야 한다. 기계가 관리하는 재생 상태 데이터는 본문에
**숨겨진 JSON 블록** 하나로만 존재하며, 에디터에서는 보이지 않아 실수로 편집되지
않는다. 원본 데이터는 메뉴 "원본 보기"(NoteXmlViewer)로만 확인한다.

## 사용자가 확정한 결정

1. **이어재생 기준 = 전역 최신 우선.** 멈춘 상태에서 ▶ → 제어 노트의 모든 기기
   기록 중 `updatedAt` 이 가장 최근인 것을 이어 재생(다른 기기 것이라도). 이 기기의
   동작도 노트에 기록되므로 보통 "최신 = 내 마지막 동작" 으로 자연스럽게 수렴.
2. **기록 시점 = 재생 + 일시정지 + 정지(명시적 조작만).** 틱마다 기록 X,
   자동 다음곡/곡 종료(`reportEnded`/`next`) 기록 X → 파이어베이스 쓰기 비용 최소.
3. **동기화 의존 = 기존 "파이어베이스 실시간 동기화" 토글 필요.** 토글이 꺼져
   있으면 기기간 공유는 동작하지 않으며, 이 사실을 가이드에 명시한다.
4. **JSON 블록은 에디터에서 완전히 숨김.** 편집 불가. 원본은 "원본 보기"로만.
5. **요약/위젯 없음(v1).** 사람용 렌더링 없이 숨겨진 JSON 만.

## 비목표 (v1 범위 밖)

- 커스텀 에디터 위젯 / 기기별 상태 대시보드 렌더링.
- 틱 단위 위치 기록(재생 중 라이브 위치 공유) — 두 기기가 동시에 재생 중일 때
  위치는 "마지막 명시적 조작 시점" 까지만 정확. 정확한 이어듣기는 상대 기기가
  일시정지/정지한 뒤에 보장된다.
- Dropbox 채널을 통한 공유(파이어베이스 토글 off 시 동작 안 함 — 의도된 제약).

## 아키텍처

### 채널 선택 (승인된 접근: Note-as-truth)

제어 노트는 **고정된 단일 GUID 를 가진 일반 노트**다. 본문에 기계가 소유하는
JSON 블록 하나를 두고, 나머지 본문은 사용자 자유 영역이다. 노트 전체가 기존
파이어베이스 실시간 노트 동기화(`tomboy-notesync`)를 그대로 타고 기기간 전파된다.

대안(기각):
- **기기별 전용 Firestore 경로**(`users/{uid}/musicControl/{deviceId}`): 충돌 없음.
  하지만 새 경로 + 보안 규칙 + 상시 리스너 비용 + "노트에 기록" 요건 위반.
- **기기별 별도 노트**(`음악제어::노트북` 등): 충돌 없음. 하지만 "하나의 노트만
  존재" 위반 + 노트 목록 오염.

**알려진 한계(Note-as-truth):** 제어 노트는 단일 Firestore 문서이고 충돌 해소는
문서 전체 last-write-wins 다. 두 기기가 ~1초 안에 각자 기록을 쓰면 한쪽 섹션이
덮어써질 수 있다. 단일 사용자가 손으로 누르는 재생/정지 이벤트는 거의 동시 발생하지
않고, 쓰기 직전 IDB 최신본을 읽어 splice 하므로 실질 위험은 무시 가능. 문서화한다.

### 노트 식별 & 싱글톤

- `MUSIC_CONTROL_GUID` — 새 고정 상수(슬립노트의 `1c97d161-…` 처럼 새 uuid 1개를
  민팅해 박는다). **모든 기기가 같은 guid 를 써야** 같은 Firestore 문서로 수렴한다.
  기기마다 새로 만들면 문서가 갈라져 공유가 깨지므로 이게 핵심 불변식.
- 제목: `음악제어::공유` (접두어 `음악제어::` 로 인식). guid 로 단일성 보장.
- **get-or-create**: 첫 기록 시점에 `MUSIC_CONTROL_GUID` 로 노트가 없으면 생성.
  사용자가 미리 만들 필요 없음.

### 기기 정체성 & 명칭

- **기기 ID**: 기존 `getOrCreateInstallId()`(`lib/schedule/installId.ts`) 재사용 —
  브라우저별 안정 ID, 이미 일정 알림에서 사용 중. 새로 민팅하지 않는다.
- **기기 명칭**: 새 `appSettings` 키 `deviceName`(범용 명명, 향후 재사용 대비).
  기본값 빈 문자열 → 표시/기록 시 폴백 `기기-<installId 앞 4자>`.
  설정 → 동기화 설정 탭의 파이어베이스 토글 옆에 입력 필드.

### 노트 본문 데이터 모델

본문 = [사용자 자유 콘텐츠] + [기계 소유 JSON 블록 1개]. 블록은 **노트 끝**에 둔다
(캐럿 처리 단순화). 블록 위치 식별을 위해 센티넬 헤딩 한 줄 + 펜스드 코드블록:

```
재생 상태 (자동 갱신 — 편집 금지)
```​json
[ {레코드}, {레코드}, … ]
```​
```

(위 ​ 는 문서용 이스케이프; 실제로는 일반 ```json 펜스드 코드블록.)

CSV 가 아니라 **JSON** 인 이유: 트랙 URL 에 쉼표·작은따옴표가 들어간다(브릿지
`/files` 파일명 — `tomboy-musicplayer` 의 `URL_RE` 주석 참고). CSV 는 깨진다.

레코드 스키마(기기당 1개, `deviceId` 로 upsert):

```ts
interface MusicControlRecord {
  deviceId: string;       // getOrCreateInstallId()
  deviceName: string;     // 설정값 또는 폴백
  trackUrl: string;       // currentTrack.url
  trackTitle: string;     // currentTrack.display
  noteGuid: string;       // musicPlayer.activeNoteGuid — 트랙 파싱 대상(음악 노트)
  noteTitle: string;      // musicPlayer.activeNoteName
  position: number;       // currentTime (초)
  state: 'playing' | 'paused' | 'stopped';
  updatedAt: string;      // ISO (Date.now 기반)
}
```

`noteGuid` 는 **트랙을 가진 음악 노트**(`activeNoteGuid`)다. 묶음 호스트
(`originNoteGuid`)가 아니라 재생 트랙을 다시 파싱할 수 있는 노트를 저장해야
이어재생 시 큐를 복원할 수 있다.

### 모듈: `lib/music/musicControl.svelte.ts`

신규 모듈. 두 가지 책임:

**(A) 쓰기 — 기록**
- `recordPlay()` / `recordPause()` / `recordStop()`:
  - 파이어베이스 토글 off 면 즉시 no-op.
  - `musicPlayer` 현재 상태 + `deviceId`/`deviceName` 로 이 기기 레코드 생성
    (`state` 는 각각 playing/paused/stopped, `position`=currentTime, `updatedAt`=now).
  - 제어 노트 get-or-create → `emitNoteFlush(guid)`(열린 에디터의 펜딩 저장 배수)
    → IDB 최신본 재독 → JSON 블록 파싱 → 이 deviceId 레코드 upsert → 블록 re-serialize
    → `putNote` + `notifyNoteSaved` + `noteMutated` + `emitNoteReload([guid])`.
  - 쓰기 코얼레싱: 연속 호출은 짧게 디바운스(예: 300ms)로 묶어 putNote 폭주 방지
    (Firestore push 는 어차피 500ms 디바운스).

**(B) 읽기 — 전역 포인터(인메모리 reactive)**
- 제어 노트의 JSON 블록을 파싱해 **전역 최신 레코드**(max `updatedAt`)를 인메모리
  `$state` 로 유지.
- 갱신 트리거: 앱 부팅 시 1회 + 제어 노트 변경 시(noteReloadBus 의 해당 guid 구독,
  incremental sync 가 IDB 를 갱신하면 reload 가 발생). 
- **이어재생 준비(핵심 재사용):** 이 기기가 **재생 중이 아닐 때**, 전역 최신
  레코드를 플레이어의 *준비된(일시정지) 큐* 로 복원한다 — `musicSession` 의
  "준비만 하고 자동재생 안 함" 패턴과 동일:
  - `noteGuid` 가 IDB 에 있으면 `parseMusicNote` 로 트랙 파싱 →
    `musicPlayer.setQueue(noteGuid, tracks, noteTitle)` → `trackUrl` 로 인덱스 →
    `pendingRestore = position`(이어듣기 위치). 없으면 단일 합성 트랙
    `{url: trackUrl, title: trackTitle}` 폴백.
  - 재생 중이면 큐를 빼앗지 않는다(사용자 재생 보호).
- 결과: 멈춘 상태에서 기존 ▶ 진입점(`resumeOrRestart` 등)을 누르면 **이미 준비된
  전역 최신 큐**를 **제스처 동기**로 이어 재생 → iOS 자동재생 함정 회피(탭 안에서
  async IDB 읽기 없음). [[project_mobile_autoplay_gesture]] 불변식 준수.

### 기록 훅 위치

- **recordPlay**: 모든 명시적 재생 진입점(트랙 행 탭, 헤더 ▶, 노트 바 ▶, 모바일
  알약, 데스크탑 레일 ▶)에서 `resumePlaybackFromGesture()` 호출 직후 호출.
- **recordPause / recordStop**: `musicPlayer.pause()` / `musicPlayer.stop()` 내부
  (항상 명시적). `reportEnded`/`next`(자동 진행)에서는 호출하지 않는다.
- 주의: `pause()` 는 onError(잠금 전) 에서도 호출될 수 있으나 드묾 — 허용.

### 에디터: JSON 블록 숨김 플러그인

`lib/editor/musicControlNote/` (신규). ProseMirror 플러그인:
- 제어 노트(또는 `음악제어::` 노트)에서만 활성. 본문을 스캔해 센티넬 헤딩 + 그 뒤
  ```json 코드블록 범위를 찾아 **숨김 데코레이션**(display:none, contenteditable
  off)을 적용. noteBundle 의 hide-list 데코레이션 / hrSplit 패턴 선례 참고.
- 블록을 노트 끝에 두므로 캐럿이 들어가기 어렵지만, 화살표/Ctrl+End 로 진입하지
  않도록 캐럿 가드(necessary 시) — 상세는 플랜에서.
- **숨김은 렌더링만 바꾼다. 노트 doc 에는 블록이 그대로 남는다** → 사용자가 보이는
  본문을 편집해 저장(`updateNoteFromEditor`)해도 직렬화된 doc 에 블록이 보존된다.
  코드의 기록 splice 와 사용자 편집이 공존.

### 충돌/레이스 처리

- 기록 splice 전 `emitNoteFlush(guid)` 로 열린 에디터 펜딩 저장을 먼저 배수 → 사용자
  편집 보존. splice 후 `emitNoteReload([guid])` 로 에디터가 최신 doc 로 교체.
- 데스크탑 다중 창은 `noteReloadBus` 가 커버(이 노트가 묶음/체인 op 대상은 아니므로
  `desktopSession.reloadWindows` 까지는 불필요).
- 알려진 한계: 사용자가 제어 노트를 **편집 중(디바운스 펜딩)** 인 바로 그 순간 다른
  기기 기록이 도착해 reload 되면, flush 타이밍에 따라 마지막 펜딩 편집이 유실될 수
  있음(드묾). 문서화.

## 설정 UI

- 설정 → 동기화 설정 탭, 파이어베이스 토글 **옆/아래**에 "기기 이름" 입력 필드
  (`deviceName`). 빈 값이면 폴백 라벨 안내.

## 가이드 (설정 → 가이드 → 노트 서브탭)

`<details class="guide-card">` 추가:
- summary: "음악제어:: 노트 — 기기간 재생 이어듣기"
- 본문: 하나만 존재, 멈춘 상태에서 ▶ 누르면 전역 최신 곡 이어재생, 재생/일시정지/
  정지 시에만 기록(비용 절약), **실시간 동기화 ON 필요**, 기기 이름은 동기화 설정
  탭에서 지정, 재생 상태 JSON 은 숨김 — 원본 보기로 확인.

## 테스트 (vitest, `app/tests/unit/music/`)

- `musicControl` 순수 로직: 레코드 upsert(by deviceId), 전역 최신 선택(max updatedAt),
  JSON 블록 parse/serialize 라운드트립, 블록 splice(사용자 콘텐츠 보존).
- 폴백: noteGuid 미존재 → 합성 단일 트랙. trackUrl 인덱스 매칭.
- 토글 off → recordX no-op.
- 싱글톤 격리: `__resetMusicControl` 류 헬퍼 + `__resetMusicPlayer` 병행.
- 숨김 플러그인 데코레이션은 에디터 마운트 테스트(makeEditor + afterEach destroy —
  [[project_flaky_ocr_test_teardown]] 누수 방지).

## 파일 영향 요약

신규:
- `lib/music/musicControl.svelte.ts` (쓰기/읽기/전역 포인터)
- `lib/music/musicControlNote.ts` (파서: JSON 블록 추출/주입, 레코드 타입)
- `lib/editor/musicControlNote/` (숨김 플러그인)
- `lib/music/constants.ts` 또는 기존 상수 파일에 `MUSIC_CONTROL_GUID`

수정:
- `lib/music/musicPlayer.svelte.ts` — `pause()`/`stop()` 에 record 훅
- 재생 진입점들(`musicNotePlugin`, `MusicPlayerBar`, `GlobalMiniPlayer`,
  `RailMusicControls`) — recordPlay 호출
- `routes/+layout.svelte` — musicControl 설치(부팅 읽기 + 구독)
- `lib/storage/appSettings.ts` — `deviceName` get/set
- `routes/settings/+page.svelte` — 기기 이름 필드 + 가이드 카드
- 에디터 마운트 지점 — 제어 노트일 때 숨김 플러그인 주입
```
