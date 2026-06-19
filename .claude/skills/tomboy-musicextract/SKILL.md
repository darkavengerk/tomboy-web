---
name: tomboy-musicextract
description: 음악추출:: 노트 — YouTube 영상/재생목록/챕터를 데스크탑 yt-dlp로 mp3 추출, 브릿지 /files 저장, 멱등 채움
---

# tomboy-musicextract

`음악추출::` 작업대 노트. 영상 URL/검색어 리스트 → ⟳ → 데스크탑 yt-dlp → mp3 → 브릿지 `/files` →
결과 URL을 항목 자식에 기록. 재생목록 URL은 일반 텍스트 줄로 쓰면 플레이리스트 블록으로 펼쳐진다.
재생은 `음악::` 노트로 수동 구성.

## 경로
- 앱: `app/src/lib/musicExtract/{parseExtractNote,extractClient,writeExtractResult,writePlaylistBlock}.ts`,
  `app/src/lib/editor/musicExtractNote/{musicExtractNotePlugin,runExtractButtonClick,index}.ts`
  (`playlistSourceOf` 헬퍼는 `parseExtractNote.ts` 내부)
- 브릿지: `bridge/src/music.ts` (`/music/extract` relay, `/music/enumerate` 재생목록 열거, `/music/chapters` 챕터 분할)
- 데스크탑: `music-service/` (yt-dlp + Fastify `/extract`, `/enumerate`, `/chapters`)

## 단일 곡 vs 재생목록 vs 챕터 구분

| 노트 내 표현 | 감지 방법 | 처리 경로 |
|---|---|---|
| 불릿 항목 (`- URL`) | 기존 bullet 파싱 | `extractOne` → `/music/extract` → `runner.extract` |
| 일반 텍스트 줄 (`URL`) | `playlistSourceOf` — `list=` 또는 `/playlist?` 포함 | `enumeratePlaylist` → `/music/enumerate` → 곡별 `extractOne` |
| `챕터:<URL>` 텍스트 줄 | `chapterSourceOf` — 텍스트가 `챕터:`로 시작 + http URL | `extractChapters` → `/music/chapters` → `runner.extractChapters`(한 번에 다운+분할+업로드) |

**재생목록 = 일반 텍스트 줄, 단일 곡 = 불릿, 챕터 = `챕터:` 텍스트 줄.** `runExtractButtonClick`이 각
소스를 분기한다. 파서는 `챕터:`를 재생목록보다 **먼저** 검사 — `list=`가 있어도 `챕터:` 줄이면 챕터.

## 챕터 분할 흐름

긴 영상(단일 120MB 상한 초과)을 챕터별 별도 곡으로. yt-dlp `--split-chapters` 네이티브.

```
runExtractButtonClick → processChapters
 └─ extractChapters({source})                 (app extractClient.ts)
     └─ POST /music/chapters                   (bridge handleMusicChapters, 600s 백스톱)
         └─ POST /chapters                      (music-service)
             └─ runner.extractChapters
                 └─ yt-dlp -x mp3 --split-chapters
                     --max-filesize <maxChapterDownload: 기본 1G>   (풀 다운로드, 넉넉히)
                     -P <dir> -P chapter:<chapDir>
                     -o '%(title)s.%(ext)s'
                     -o 'chapter:%(section_number)03d %(section_title)s.%(ext)s'
                 → chapDir 의 챕터 mp3 들을 각각 브릿지 업로드
                 → { label, tracks:[{url,title}], total, truncated }
```

- **풀 다운로드 상한은 단일(120M)보다 크다(`MUSIC_MAX_CHAPTER_DOWNLOAD`, 기본 1G).** 챕터 분할은
  postprocessor라 풀 오디오를 통째로 받은 뒤 잘라야 함 — 단일 120M을 그대로 쓰면 긴 영상이
  분할 전에 abort되어 기능 무의미. 잘린 챕터들은 자연히 작아 출력 사이즈 별도 체크 불필요.
- **챕터/풀 파일 분리**: `-P chapter:<chapDir>`로 챕터 mp3는 `dir/chapters/`에, 풀 mp3는 `dir/`에.
  `chapDir` 비었으면(=챕터 없는 영상) 풀 곡 한 개로 폴백. `label` = 풀 파일 제목.
- **상한 `maxChapters`**(= `MUSIC_MAX_PLAYLIST`, 기본 50) 초과 시 앞 50챕터만 + `truncated`.
- 성공 트랙들은 `writePlaylistBlock`이 **재생목록과 동일한** `[ ]플레이리스트: <label>` 블록으로
  소스 줄 아래 기록(음악:: 재생 호환). `findInsertPos`의 `sourceLineMatches`가 재생목록·챕터 소스를
  같이 매칭한다.

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
- **챕터 지원도 신규 라우트 필요** — 브릿지(`/music/chapters`)·music-service(`/chapters`) 양쪽 재배포.
  단일 상한 기본값이 `40M`→`120M`으로 올랐고, 챕터 풀 다운로드 상한은 새 env `MUSIC_MAX_CHAPTER_DOWNLOAD`
  (기본 1G). `MUSIC_MAX_FILESIZE`(단일)와 별개. 챕터 타임아웃 `MUSIC_CHAPTERS_TIMEOUT_MS`(기본 300s).

스펙: `docs/superpowers/specs/2026-06-05-music-extract-design.md`
플랜: `docs/superpowers/plans/2026-06-05-music-extract.md`
