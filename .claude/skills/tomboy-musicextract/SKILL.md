---
name: tomboy-musicextract
description: 음악추출:: 노트 — YouTube 영상/재생목록을 데스크탑 yt-dlp로 mp3 추출, 브릿지 /files 저장, 멱등 채움
---

# tomboy-musicextract

`음악추출::` 작업대 노트. 영상 URL/검색어 리스트 → ⟳ → 데스크탑 yt-dlp → mp3 → 브릿지 `/files` →
결과 URL을 항목 자식에 기록. 재생목록 URL은 일반 텍스트 줄로 쓰면 플레이리스트 블록으로 펼쳐진다.
재생은 `음악::` 노트로 수동 구성(또는 완료 재생목록의 **🎵 노트 만들기** 버튼으로 자동 생성).

## 경로
- 앱: `app/src/lib/musicExtract/{parseExtractNote,extractClient,writeExtractResult,writePlaylistBlock,buildMusicNote}.ts`,
  `app/src/lib/editor/musicExtractNote/{musicExtractNotePlugin,runExtractButtonClick,createMusicNoteFromPlaylist,index}.ts`
  (`playlistSourceOf` 헬퍼는 `parseExtractNote.ts` 내부)
- 브릿지: `bridge/src/music.ts` (`/music/extract` relay, `/music/enumerate` 재생목록 열거)
- 데스크탑: `music-service/` (yt-dlp + Fastify `/extract`, `/enumerate`)

## 단일 곡 vs 재생목록 구분

| 노트 내 표현 | 감지 방법 | 처리 경로 |
|---|---|---|
| 불릿 항목 (`- URL`) | 기존 bullet 파싱 | `extractOne` → `/music/extract` → `runner.extract` |
| 일반 텍스트 줄 (`URL`) | `playlistSourceOf` — `list=` 또는 `/playlist?` 포함 | `enumeratePlaylist` → `/music/enumerate` → 곡별 `extractOne` |

**재생목록 = 일반 텍스트 줄, 단일 곡 = 불릿.** `runExtractButtonClick`이 각 소스를 분기한다.

## 재생목록 열거 흐름

```
runExtractButtonClick
 └─ playlistSourceOf(line) → true
     └─ enumeratePlaylist({source})          (app extractClient.ts)
         └─ POST /music/enumerate            (bridge, Bearer relay)
             └─ handleMusicEnumerate         (bridge/src/music.ts)
                 └─ POST /enumerate          (music-service)
                     └─ yt-dlp -J --flat-playlist --yes-playlist
                         → { label, entries:[{url,title}], total, truncated }
```

열거 결과의 `entry.url`마다 기존 단일 곡 경로(`extractOne` → `/music/extract` → `runner.extract`)를
순차 실행 — 다운로드·업로드·HMAC 토큰·멱등·타임아웃 모두 재사용, 재구현 없음.

성공한 트랙 URL은 `writePlaylistBlock`이 소스 줄 바로 아래에 기록:

```
[ ] 플레이리스트: <label>
  • https://bridge/.../track1.mp3
  • https://bridge/.../track2.mp3
```

- 첫 줄: 미체크 `inlineCheckbox` + `플레이리스트: <label>` 헤더 단락
- 트랙 목록: 불릿 리스트, 각 항목은 **text === href** (`urlChild`)로 생성 →
  `.note` 아카이버 라운드트립 시 `<link:url>` href가 textContent에서 재구성됨
  (`tomboyUrlLink href-from-textContent` 고차 참고). 사용자가 블록 전체를
  `음악::` 노트에 붙여넣고 체크박스를 토글하면 재생.

## 🎵 노트 만들기 (완료 재생목록 → 음악:: 노트 자동 생성)

복사·붙여넣기 없이 재생용 `음악::` 노트를 한 번에 얻는 지름길. **완료 재생목록**(소스 줄 바로
다음이 `플레이리스트:` 결과 헤더)에만 헤더 끝에 위젯 버튼이 뜬다.

```
donePlaylistAnchors(doc)                       (buildMusicNote.ts) → source별 헤더끝 pos
 └─ 플러그인 widget(side:1, key=makenote:<source>)  '🎵 노트 만들기'
     └─ click → createMusicNoteFromPlaylist(view, source, oninternallink)
         ├─ readPlaylistResult(doc, source) → {label, urls}   (미완료/0곡 → 토스트, no-op)
         ├─ findNoteByTitle('음악::'+label) 있으면 → 그 노트로 이동(중복 생성 X)
         └─ createNote + updateNoteFromEditor(buildMusicNoteDoc) → oninternallink(title)
```

- **buildMusicNoteDoc** = 제목 문단 + **체크된**(`checked:true`) `inlineCheckbox` 헤더 + mp3 불릿
  (`tomboyUrlLink` text===href). `writePlaylistBlock` 과 동일 구조지만 **체크 상태**라 열자마자 큐 활성.
  `serializeContent`→`deserializeContent`→`parseMusicNote` 라운드트립이 트랙 복원을 보장(테스트로 박제).
- **find-or-create**(applyChartNote 패턴): 같은 제목 있으면 새로 안 만들고 연다 — 제목 전역 유일 불변식
  + 사용자 편집 보존. createNote 명시 제목은 `ensureUniqueTitle` 우회하므로 `findNoteByTitle` 선검사 필수.
- **oninternallink 스레딩**: `index.ts` `addOptions` → `TomboyEditor.configure({oninternallink})`
  (noteBundle 패턴). 호스트(`note/[id]`/`NoteWindow`)가 title→guid 해석해 이동 — 모바일 goto / 데스크탑 창.
- **위젯 key 에 source** 포함 → 재생목록별 고정·재사용. `mousedown` preventDefault 로 contenteditable
  캐럿/키보드 차단.

## 불변식
- **멱등 판정 = `/files/<uuid>/` URL 결과 자식의 유무.** 있으면 done(skip), 없으면(신규/실패)
  ⟳ 때 재시도. 실패는 `❌ …` 텍스트 자식이라 URL이 없어 자동 재시도된다.
- **재생목록 멱등**: 소스 줄 바로 아래에 `플레이리스트:` 헤더가 이미 있으면 해당 소스 전체를
  건너뜀. 재추출하려면 블록을 삭제하고 ⟳.
- **상한 `MUSIC_MAX_PLAYLIST`** (music-service env, 기본 50). 열거 결과가 초과 시
  첫 50개만 처리하고 `truncated: true` → 앱 토스트 경고("상한 초과 …").
- **부분 성공**: 트랙별 실패는 건너뜀, 성공 트랙만 블록에 기록. 0개 성공 시 블록 미생성,
  소스 줄은 대기 상태 유지(다음 ⟳에 재시도).
- **저장·서빙은 기존 브릿지 `/files` 재사용** — Range·`audio/mpeg` MIME·무토큰(추측 불가 UUID)
  다운로드가 이미 있어 `<audio src>`로 직접 재생. 새 저장 코드 없음.
- **보안 경계는 automation보다 약하다** — 소스 문자열을 노트가 직접 보냄. `music-service`가
  shell 미경유 spawn + `resolveSource` allowlist(선두 `-`/비-http 스킴 거부, 검색어 `ytsearch1:`
  강제) + `--no-exec`/`--max-filesize`/`--socket-timeout`/타임아웃으로 완화.
  (단일 곡은 `--no-playlist`; 재생목록 경로는 `--flat-playlist --yes-playlist`로 대체.)
- **시스템 오류 시 중단** — not_configured/unauthorized/service_unavailable/network 는 한 항목에서
  나면 토스트만 띄우고 루프 중단(노트에 같은 에러 도배 방지). 항목별 오류(bad_request/upstream_error)만
  그 항목에 `❌` 기록하고 계속.
- **데스크탑 전용·개인용.** Vercel 함수 금지. 권리 보유 콘텐츠 전제.
- **항목별 동기**: 앱이 대기 항목을 하나씩 `extractOne` → `writeExtractResult`. 다운로드가 길어
  배치 대신 순차(진행 가시성 + 부분 실패 격리). 재생목록도 동일 — 트랙마다 순차 다운로드.

## 배포 함정
- `/home`→`/var/home` 심볼릭링크가 `import.meta.url` entry 가드를 깨뜨림 → `.service`의 node·dist
  경로는 canonical `/var/home/...`. fnm default alias node 절대경로. `loginctl enable-linger` 필수.
  (automation-service 동일.)
- 브릿지 `MUSIC_SERVICE_URL`, 서비스 `BRIDGE_FILES_URL`/`BRIDGE_SHARED_TOKEN` 정렬 필수.
- **재생목록 지원은 신규 라우트 필요** — 브릿지(`/music/enumerate`)·music-service(`/enumerate`)
  양쪽 재배포 후 활성화됨. 기존 단일 곡 경로는 재배포 없이 동작.

스펙: `docs/superpowers/specs/2026-06-05-music-extract-design.md`
플랜: `docs/superpowers/plans/2026-06-05-music-extract.md`
