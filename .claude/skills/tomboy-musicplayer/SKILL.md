---
name: tomboy-musicplayer
description: 음악:: 노트 재생 — 전역 단일 오디오 엔진 + 싱글톤 큐, 노트별 이어듣기, 세션 복원, 모바일 알약/데스크탑 레일, 잠금화면, iOS 자동재생 함정
---

# tomboy-musicplayer

`음악::` 노트 **재생** 서브시스템. 추출(`음악추출::`)은 별개 — [[tomboy-musicextract]] 참고.
브릿지/Vercel 함수 없음, 100% 클라이언트. 오디오는 앱 전체에서 **단 하나** 흐른다.

## 핵심 모델 (외워라)

- **`musicPlayer` = 싱글톤 룬 스토어** (`lib/music/musicPlayer.svelte.ts`). 큐·인덱스·재생상태·
  활성노트·반복·셔플·seek 토큰. 앱 전체에 한 인스턴스. 모든 UI 가 이걸 읽고 조작.
- **`musicAudio` = 단일 오디오 엔진** (`lib/music/musicAudio.svelte.ts`). `new Audio()` 1개
  (+프리로드 1개). `+layout` 에서 `installMusicAudio()` 1회 설치. `$effect.root` 로 `musicPlayer`
  를 구독해 src/play/pause/seek/preload/미디어세션 동기. **모든 컴포넌트는 순수 뷰** — 직접
  `<audio>` 안 만든다.
- **`musicProgress` = 노트별 이어듣기** (`lib/music/musicProgress.ts`). guid→{trackUrl,초}.
  인메모리 맵이 진실, localStorage 는 throttle(5초)+숨김/정지 시 flush 캐시. 노트 데이터 아님.
- **`musicSession` = 세션 복원** (`lib/music/musicSession.svelte.ts`). 활성노트+큐+인덱스를
  localStorage 에. `installMusicSession()` 부팅 시 복원(자동재생 X) + 400ms 디바운스 persist.
- **`mediaSession`** (`lib/music/mediaSession.ts`) — 잠금화면 컨트롤/메타. 순수 매핑 + 얇은 설치자.

```
설치 (routes/+layout.svelte):  installMusicAudio() + installMusicSession()  (uninstall 도 짝)
구동:  UI onclick → musicPlayer.<mutate>  →  musicAudio $effect 가 <audio> 반영
```

## 노트 포맷 + 파싱

`lib/music/parseMusicNote.ts`. 제목 `음악::<이름>`. 본문 = `플레이리스트:<label>` 헤더 문단 +
바로 뒤 리스트. 헤더 앞 `inlineCheckbox` atom 의 checked 가 **플레이리스트 on/off** (없으면
레거시=항상 on, 미체크=텍스트 모드라 큐/데코 제외 — [[project_inlinecheckbox_atom_gotcha]]).

트랙 추출 4패턴: bare URL 줄 / 제목+중첩리스트 URL / head 마크링크(text=제목) / head 끼인 URL.
URL 은 `tomboyUrlLink`(또는 테스트의 `link`) 마크 href 우선, 없으면 본문 정규식.
`flatQueue` = 전 플레이리스트 트랙 평탄화 = 큐. `MusicTrack = {url,title,display,liPos,playlistLabel?}`.

⚠️ `URL_RE` 는 `'`(작은따옴표)를 **제외하지 않는다** — 브릿지 `/files` 파일명에 raw `'` 가 박혀
있어 제외하면 URL 이 중간에서 잘린다. (꼬리 구두점은 `trimTrailingPunct` 가 별도로 제거.)

## 재생 진입점 (불변식: 제스처 동기 play)

| 진입점 | 위치 | 동작 |
|---|---|---|
| 트랙 행 탭 | `musicNotePlugin` 데코 위젯 | 현재곡=토글, 아니면 `setQueue`+`play(idx)` |
| 헤더 ▶ | 데코 위젯 | 그 플레이리스트 첫 곡부터 |
| 노트 바 ▶ | `MusicPlayerBar.svelte` | 활성=toggle, 비활성=`playNote` |
| 모바일 알약 | `GlobalMiniPlayer.svelte` | 활성노트 안 보일 때만 표시 |
| 데스크탑 레일 ▶⏮⏭ | `RailMusicControls.svelte` | 항상 표시, `resumeOrRestart` |

**모든 진입점 규칙 (절대):** 스토어 갱신 직후 **같은 onclick 안에서 동기로
`resumePlaybackFromGesture()`** 호출. iOS Safari 는 `play()` 를 사용자 제스처 동기 구간에서만
허용 — `$effect` 로 미룬 play() 는 차단돼 "재생 중인데 0:00 멈춤". 새 버튼 추가 시 이거 빼먹으면
데스크탑은 되고 폰만 죽는다(재현 안 됨). 자세히 → [[project_mobile_autoplay_gesture]].

## 큐 동기 규칙 (노트 열기 ≠ 큐 교체)

- **노트를 *여는* 것만으로 큐 안 바뀐다** — 글로벌 now-playing 보존. 명시적 ▶/탭만 `setQueue`.
- **활성 노트를 편집하면** `MusicPlayerBar` 가 `untrack` 안에서 `setQueue` 재동기(인덱스 url 로
  보존). `untrack` 없으면 player 자기-구독 effect 루프 → [[feedback_svelte_effect_store_mutator_loop]].
- **`setQueue` 노트 전환 시 이어듣기**: 나가는 노트 위치 저장 + 들어오는 노트 저장 위치 복원
  (`pendingRestore`→`resume()`이 `resumeAt`으로 승격→엔진이 src 로드 후 1회 seek).
- 비활성 노트 바/알약은 그 노트의 **기억된 위치**(loadProgress)를 보여줌 — 노트마다 자기 상태.

## 데스크탑 레일 (작업표시줄 분할)

`SidePanel.svelte` 에 2분할:
- **`RailMusicControls`** (workspace-switcher↔rail-chips 사이) — ⏮▶⏭만, **항상 표시**, 세션
  없으면 disabled. ▶=`resumeOrRestart`(재생중→pause / 중간→resume / 소진→처음부터).
- **`RailNowPlaying`** (header↔list 사이, `.main` 펼침 영역) — 곡 제목+노트명+탐색바. 곡 로드 시
  표시, **일시정지 10분 후 자동 접힘**(`IDLE_TIMEOUT_MS`), 상호작용 시 리셋.
- 옛 떠다니는 `DesktopMiniPlayer` 는 삭제됨. 모바일 알약(`GlobalMiniPlayer`)은 유지.

## 불변식

- **오디오 1개.** 패널/창 여러 개여도 소리 하나. 컴포넌트가 `<audio>` 만들지 마라 — `musicPlayer`
  조작만. `installMusicAudio` 는 멱등(중복 호출 시 기존 teardown 반환, 이중오디오 방지).
- **세션 복원은 전역** → 새로고침 후 모바일 `GlobalMiniPlayer` 도 마지막 세션 복원됨(의도된 부수효과).
- **세션 persist effect 는 currentTime 비추적** — guid/name/queue/index 만(저churn). 이어듣기
  초는 `musicProgress` 담당. 둘 섞지 마라.
- **onError 연쇄-스킵 차단**: 엔진이 `'playing'` 이벤트로 잠금해제 추적. 잠금 전 에러=`pause()`
  (스킵 금지), 후 에러만 `next()`(죽은 링크 스킵). 안 그러면 첫 곡 실패→큐 전체 붕괴(iOS).
- **위젯 버튼은 pointerdown+mousedown+click 모두 삼킴**(`swallowGesture`). mousedown 만으론
  모바일 탭이 contenteditable 로 새 캐럿/키보드 뜸. 재생 버튼=`swallowGesture`(resume 호출 O),
  편집도구(▲▼⧉🗑)=`swallowAction`(resume 호출 X — 도구가 재생 시작하면 안 됨).
- **데코는 라이브 doc 재계산**: 편집도구 클릭 시 `view.state.doc` 에서 범위 다시 계산(빌드 이후
  doc 변해도 안전). `canMove` 경계는 빌드 시 계산해 위젯 key 에 넣어 DOM 재사용 방지.
- **미디어세션 metadata 는 키 diff 로만 재생성** — 매 timeupdate 깜빡임 방지. 모든 호출 지원가드
  +try/catch(부분구현 브라우저에서도 일반 재생 불변).
- **localStorage 가드** = `safeStorage()` try/catch + JSON 파싱 폴백. 쿼터 초과 시 인메모리만 유지.

## 폰 재생 디버그 (확정 원인 박제)

"브릿지 곡이 폰(Safari/iOS)만 `MEDIA_ERR_SRC_NOT_SUPPORTED`, FF/Chrome 은 됨" → **URL/헤더 쫓지
말고 파일 의심.** 진짜 원인은 yt-dlp `--embed-thumbnail` 이 박은 PNG 커버가 ID3 앞부분에 끼어
WebKit 오디오 스니퍼를 막음. `ffprobe` 로 스트림 확인(mp3+png=커버). music-service
`--embed-thumbnail` 제거 + 기존 파일 무손실 커버-스트립으로 해결 완료(2026-06-07). 전체 진단/헛다리
목록 → [[project_mobile_autoplay_gesture]].

## 테스트

`app/tests/unit/music/`. 싱글톤이라 격리 필수 — `__resetMusicPlayer`/`__resetMusicProgress`/
`__clearMusicSessionStorage`/`__resetMediaSession` 를 `beforeEach` 에. 엔진은
`__musicAudioForTest()`. 순수 술어(`miniPlayerVisible`, `handleTrackButtonClick`, `buildMetadataInit`)
는 DOM 없이 단위 테스트.

## 경로

- `lib/music/`: `musicPlayer.svelte.ts` `musicAudio.svelte.ts` `musicProgress.ts`
  `musicSession.svelte.ts` `mediaSession.ts` `parseMusicNote.ts` (+ SUNO: `parseSunoLine.ts`
  `sunoClient.ts` `writeSunoPlaylistBlock.ts`)
- `lib/editor/musicNote/`: `MusicPlayerBar.svelte`(노트 바) `GlobalMiniPlayer.svelte`(모바일 알약)
  `RailMusicControls.svelte`+`RailNowPlaying.svelte`(데스크탑 레일) `musicNotePlugin.ts`(데코/탭)
  `miniPlayerVisibility.ts` `miniPlayerDrag.ts` `trackTools.ts` `index.ts`
- 마운트: `routes/+layout.svelte`(설치+알약), `routes/note/[id]/+page.svelte`+`desktop/NoteWindow.svelte`(바),
  `desktop/SidePanel.svelte`(레일)
- 스펙/플랜: `docs/superpowers/specs|plans/2026-06-16-desktop-rail-music-player*`
