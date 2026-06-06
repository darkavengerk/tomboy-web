# 음악추출 노트 (`음악추출::`) — 설계

작성일: 2026-06-05
상태: 디자인 확정, 구현 대기
범위: v1. YouTube 영상 → mp3 추출, `음악추출::` 작업대 노트. Spotify·플레이리스트 자동확장·자동 재생노트 생성은 명시적 후속.

## 배경

음악 노트(`음악::`)의 백그라운드 재생 엔진은 단일 `new Audio()`로 **직접 미디어 URL만**
재생한다(mp3/m4a, Dropbox/Vercel blob). YouTube 같은 스트리밍 소스는 직접 재생 URL이 없고,
임베드 iframe은 **휴대폰 잠금/백그라운드에서 멈춘다**(사용자가 가장 꺼린 제약).

해결책: 스트리밍 소스를 **미리 mp3로 추출**해 두면 기존 엔진이 그대로 풀버전·백그라운드·
잠금화면 재생을 한다. 추출은 `yt-dlp + ffmpeg`로 데스크탑에서 하고, mp3는 브릿지(Pi)에
저장·서빙한다.

작업 모델: **`음악추출::` 노트 하나가 작업대**다. 소스를 리스트로 적고 ⟳ 버튼을 누르면
**결과(브릿지 URL)가 아직 없는 항목만** 추출해 결과를 그 항목 밑에 채운다. 소스를 더 추가하고
다시 누르면 신규/실패 항목만 처리한다(멱등). 추출된 곡을 재생용 `음악::` 노트로 옮겨 구성하는
것은 **사용자 수동**이다. 자동 재생노트 생성은 하지 않는다.

## 기존 자산 (그대로 미러링)

이 설계는 새 패턴을 거의 만들지 않는다. 두 완성 기능을 합쳐 따른다.

- **데이터 노트 자동화** — 노트 ⟳ → 브릿지 relay → 데스크탑 서비스 → 결과 → 노트에 write-back.
  - 브릿지 relay(비스트리밍 프록시): `bridge/src/automation.ts` (`handleAutomationRun`)
  - 데스크탑 서비스: `automation-service/src/{server,runner,auth,registry}.ts` (systemd --user)
  - 앱 클라이언트: `app/src/lib/automation/runAutomation.ts` (Bearer + 에러 매핑)
  - 노트 감지/파싱: `app/src/lib/automation/parseAutomationNote.ts`
  - 에디터 트리거 버튼 위젯: `app/src/lib/editor/automationNote/automationNotePlugin.ts`
  - 라이브 노트 write-back(파괴된 view 가드): `app/src/lib/automation/appendRunHistory.ts`,
    `app/src/lib/editor/footnote/claudeFill.ts`
- **브릿지 파일 업로드/서빙** — mp3 저장·서빙 인프라가 **이미 존재**(`bridge/src/files.ts`).
  - `POST /files` (Bearer) → `{ uuid, filename, size, url }`, 영속 Volume.
  - `GET /files/<uuid>/<name>` — **인증 없음(추측 불가 UUID)** + **Range 206** + `mp3: audio/mpeg`
    MIME 이미 등록. `<audio src>`가 헤더 없이 직접 재생·탐색 가능.
  - 클라 SDK 패턴: `app/src/lib/sync/bridgeFileUpload.ts`
- **음악 재생 엔진/파서** — 추출 결과 소비처(변경 없음).
  - `app/src/lib/music/{musicAudio.svelte.ts, musicPlayer.svelte.ts, parseMusicNote.ts}`
  - 브릿지 `/files/...mp3` URL은 기존 `<audio>` 엔진의 Bucket-1 직접 미디어 URL일 뿐 — 재생
    코드 0줄 변경.
- **노트 영속화 / 브릿지 설정**:
  - `app/src/lib/core/noteManager.ts`, `app/src/lib/editor/terminal/bridgeSettings.ts`
    (`getDefaultTerminalBridge`/`getTerminalBridgeToken`/`bridgeToHttpBase`)

## 결정 사항 (브레인스토밍 확정)

1. **`음악추출::<이름>` 노트** — `DATA::`/`자동화::`/`음악::` 와 같은 `::` 계열 제목 접두사로
   식별. 본문은 소스 리스트.
2. **한 줄 = 한 소스** — 각 top-level 리스트 항목의 head 텍스트가 소스(YouTube 영상 URL 또는
   검색어). v1은 플레이리스트 한 줄 → N개 확장 **안 함**.
3. **결과 = 자식 리스트 항목의 브릿지 URL 링크** — 성공하면 소스 항목 밑 중첩 리스트에
   `tomboyUrlLink` 마크로 감싼 브릿지 `/files/...mp3` URL(링크 텍스트 = 추출된 제목)을 적는다.
   새 mark/node 정의 없음, `.note` XML round-trip 무손상, `inlineCheckbox` atom 함정 회피.
4. **멱등 = "URL 결과 없음"이 작업 대상** — 항목이 `/files/...` URL 자식을 가지면 **완료(skip)**,
   없으면(=신규 또는 실패) **작업**. ⟳ 재실행이 신규·실패 항목만 처리한다.
5. **항목별 동기 추출(배치 아님)** — ⟳ 핸들러가 대기 항목을 **하나씩 순차** 처리하며 끝나는 즉시
   결과를 write-back. 요청 1건 = 다운로드 1건(시간 bounded), 진행이 항목 단위로 보이고, 한
   항목 실패가 나머지를 막지 않는다. (automation의 일괄 응답과 다른 점 — 다운로드는 길 수 있음.)
6. **저장·서빙은 기존 `/files` 재사용** — 새 브릿지 저장 코드 없음. 데스크탑 러너가 mp3를
   `POST {bridge}/files`로 올리고 받은 URL을 반환. mp3 다운로드 URL은 토큰 불필요(추측 불가 UUID)
   → `<audio src>` 직접 재생.
7. **새 브릿지 relay `/music/extract`** — `automation.ts`를 복제한 비스트리밍 프록시. 본문
   `{ source }` 한 건 → 데스크탑 `music-service`로 Bearer 재프록시 → `{ url, title } | { error }`.
8. **새 데스크탑 `music-service/`** — automation-service 미러(systemd --user). `yt-dlp -x
   --audio-format mp3`로 추출 → 브릿지 `/files` 업로드 → URL 반환. yt-dlp/ffmpeg가 무겁고 음악
   전용이라 automation-service와 분리.
9. **자동 재생노트 생성 없음** — `음악추출::`은 작업대일 뿐. `음악::` 구성은 수동.
10. **운영/법적 제약** — 데스크탑 전용·개인용·자기 호스팅. `yt-dlp`/`ffmpeg`는 합법 도구지만
    저작권 콘텐츠를 ToS 위반으로 받지 않도록, 권리 보유 콘텐츠(내 업로드·CC·퍼블릭도메인) 사용을
    전제로 설계한다. Vercel 함수로 두지 않는다(claude-service가 데스크탑 전용인 것과 동형 + 법적).

## 전체 흐름

```
[음악추출::내 라이브러리 노트의 ⟳ 진행 버튼]
   │ click → pendingItems(doc) 산출 (URL 결과 없는 top-level 항목)
   │ 각 항목을 순차로:
   ▼
앱   POST {httpBase}/music/extract   { source: "<url|검색어>" }   + Bearer(terminalBridgeToken)
   ▼
브릿지(Pi)  bridge/src/music.ts  → verifyToken 후 프록시(Bearer=BRIDGE_SECRET)
   ▼
데스크탑  music-service  POST /extract { source }
   │   scheme allowlist 검증 → spawn(yt-dlp, [...args, source], {cwd:HOME, shell 미경유})
   │   yt-dlp -x --audio-format mp3 --embed-metadata --embed-thumbnail → <tmp>/<title>.mp3
   │   제목 추출(--print) → POST {BRIDGE_FILES_URL}/files (Bearer, X-Filename=<title>.mp3)
   ▼
응답   { url: "https://<bridge>/files/<uuid>/<title>.mp3", title: "<title>" }   또는  { error }
   ▼
앱   해당 소스 항목 밑에 자식 항목 write-back:
       성공 → "[<title>](<url>)" (tomboyUrlLink, 라이브 view.dispatch, 파괴 가드)
       실패 → "❌ 실패: <reason>" (URL 없음 → 다음 ⟳ 때 재시도 대상)
   → 다음 대기 항목으로. 전부 끝나면 한국어 토스트 요약 + 버튼 복귀.
```

## 보안 / 신뢰 경계

automation과 **다른 트렁스트 포스처**임을 명시한다. automation은 노트가 command-id만 보내고
exec는 데스크탑 registry에만 둬서 노트가 임의 실행을 못 한다. 음악추출은 **소스 문자열(URL/검색어)을
노트가 직접 보내** yt-dlp에 넘기므로 경계가 본질적으로 약하다(기능상 불가피 — 사용자가 임의
YouTube URL을 붙여넣는 게 목적). 완화:

- **셸 미경유** — `spawn('yt-dlp', [...flags, source], { shell:false })`. 셸 인젝션 불가.
- **scheme allowlist** — source는 `http(s)://…` 또는 검색어(영숫자/공백 위주)만 허용. `file:`,
  `-` 시작(yt-dlp 옵션 주입), 파이프/리다이렉트 문자 거부. 검색어는 `ytsearch1:` 접두로 강제.
- **yt-dlp 안전 플래그** — `--no-exec`(post-exec 비활성), `--no-playlist`(단일 영상 강제),
  오디오 후처리만, `--max-filesize`/`--socket-timeout` 등 자원 상한, 출력은 `--paths` 임시
  디렉토리에 국한.
- **개인 위협 모델** — 자기 노트·자기 호스팅. 동기화된 오염 노트가 할 수 있는 최대치는 "내
  데스크탑에서 yt-dlp가 어떤 URL을 받아옴". scheme allowlist + 단일영상 + 자원상한으로 영향 제한.
- **전 구간 기존 Bearer 게이트** — `terminalBridgeToken`(앱) → `verifyToken(BRIDGE_SECRET)`(브릿지)
  → 업스트림 `Bearer BRIDGE_SECRET` → `verifyToken(BRIDGE_SHARED_TOKEN)`(서비스). `/files` 업로드도
  동일 Bearer. 다운로드만 추측 불가 UUID(파일 업로드 설계와 동일 모델).

## 컴포넌트

### (A) 데스크탑: `music-service/` (신규)

automation-service를 미러링한 소형 서비스(Fastify 또는 동일 스택 Node HTTP).

- **엔드포인트**: `POST /extract` · 본문 `{ source: string }` · `Authorization: Bearer
  <BRIDGE_SHARED_TOKEN>`. 인증은 `automation-service/src/auth.ts`의 `extractBearer` + 상수시간
  비교 재사용.
- **추출**: source 검증(scheme allowlist) → 임시 디렉토리(`mkdtemp`)에
  `spawn('yt-dlp', ['-x','--audio-format','mp3','--embed-metadata','--embed-thumbnail',
  '--no-playlist','--no-exec','--socket-timeout','30', '--max-filesize','<cap>',
  '-o','%(title)s.%(ext)s', '--paths', tmpDir, source], { cwd: HOME, shell:false })`.
  종료 후 tmp의 `.mp3` 1개 + 제목(`--print '%(title)s'` 또는 info-json) 수집.
- **업로드**: `POST {BRIDGE_FILES_URL}/files` — `Authorization: Bearer <BRIDGE_SHARED_TOKEN>`,
  `Content-Type: audio/mpeg`, `X-Filename: <title>.mp3`, body=mp3 bytes. 응답 `{ url }` 반환.
  업로드 후 tmp 정리.
- **응답**: 성공 `{ url, title }`. 실패(추출 불가/타임아웃/상한 초과/업로드 실패) → 비-200 +
  `{ error: <kind>, detail }`. 한 요청 = 한 소스(앱이 루프).
- **배포**: **systemd --user 서비스**(automation-service와 동형). 호스트의 `yt-dlp`/`ffmpeg`를
  직접 실행. `music-service/deploy/music-service.service` + `deploy/README.md`. 포트는
  7842/7843/8080과 비충돌(예: **7844**). LAN 한정. env `~/.config/music-service.env`:
  - `BRIDGE_SHARED_TOKEN` (= `BRIDGE_SECRET`)
  - `MUSIC_SERVICE_PORT` (기본 7844)
  - `BRIDGE_FILES_URL` (mp3 업로드 대상 브릿지 베이스, 예 `https://<bridge-host>`)
  - `YTDLP_PATH` / `FFMPEG_PATH` (기본 PATH 탐색)
  - `MUSIC_MAX_FILESIZE` (기본 예: `40M`), `MUSIC_TIMEOUT_MS`
  - **배포 함정(메모리)**: fnm node 경로 + `/home`→`/var/home` 심볼릭링크가 엔트리 가드를
    깨뜨림 → canonical 경로 필수(automation-service 배포 노트와 동일).

### (B) 브릿지: `bridge/src/music.ts` (신규)

`bridge/src/automation.ts`를 복제(비스트리밍 프록시, per-item).

- `handleMusicExtract(req, res, secret, musicServiceUrl)`:
  - `verifyToken(secret, extractBearer(req))` 실패 → 401.
  - `musicServiceUrl` 비어있으면 503 `{error:'music_service_not_configured'}`.
  - `readJson`(크기 상한) → `{ source }` 문자열 검증, 없으면 400.
  - `fetch(\`${musicServiceUrl}/extract\`, { POST, Authorization: Bearer secret, body:{source} })`
    → 네트워크 오류 503 `{error:'music_service_unavailable'}`. 다운로드가 길 수 있으므로
    upstream fetch 타임아웃을 자동화보다 넉넉히(서비스 측 상한과 정렬).
  - 업스트림 status/text 그대로 패스스루.
- `bridge/src/server.ts`: 라우트 `POST /music/extract` 등록 +
  `const MUSIC_SERVICE_URL = process.env.MUSIC_SERVICE_URL ?? '';`(선택 env, `~/.config/term-bridge.env`에
  `MUSIC_SERVICE_URL=http://<desktop-LAN-IP>:7844`). **`/files` 라우트·저장은 변경 없음**(재사용).
- 테스트 `bridge/src/music.test.ts` (`node --test`, `mintToken(SECRET)`): 인증·프록시·503(미설정/불통)·
  400(빈 source).

### (C) 앱: `lib/musicExtract/`

- **`parseExtractNote.ts`** — `parseExtractNote(doc): ExtractNote | null`.
  - 제목이 `음악추출::`로 시작하지 않으면 null.
  - top-level 리스트 각 항목 → `{ source: string, result: ExtractResult, liPos: number }`.
    - `source` = 항목 head 단락 텍스트(URL이면 `tomboyUrlLink` href 우선, 없으면 텍스트).
    - `result` = 항목의 중첩 리스트에서 `/files/<uuid>/...` 형태 URL 링크 자식 탐색 →
      있으면 `{ kind:'done', url, title }`, `❌`로 시작하는 자식만 있으면 `{ kind:'error', message }`,
      아무 자식 없으면 `{ kind:'pending' }`.
  - `pendingItems(note)` = `result.kind !== 'done'` 항목들(신규+실패 모두 재시도).
  - 브릿지 호스트 매칭은 런타임 resolve(`bridgeToHttpBase`)와 `/files/<uuid>/` 경로 패턴으로만
    "결과 URL"로 인정(다른 URL은 소스로 오인하지 않음).
- **`extractClient.ts`** — `extractOne({ source, signal }): Promise<{ url, title } | { error }>`.
  `bridgeSettings`에서 bridge/token 획득 → `bridgeToHttpBase` 정규화 → `POST {httpBase}/music/extract`
  Bearer. 에러 매핑은 `runAutomation`의 `STATUS_TO_KIND` 재사용(401/503/≥500/그 외). abort는 조용히 종료.
- **`writeExtractResult.ts`** — `writeExtractResult(view, liPos, payload)`. 라이브 `view.dispatch`로
  해당 소스 항목 밑 중첩 리스트에 결과 자식을 prepend/교체(`claudeFill`/`appendRunHistory` 패턴 +
  파괴된 view 가드).
  - 성공 → 자식 단락에 `tomboyUrlLink` 마크 URL(텍스트=title). 기존 error 자식 있으면 제거.
  - 실패 → `❌ 실패: <reason>` 텍스트 자식(URL 없음 → 재시도 가능 유지).

### (D) 앱 에디터 플러그인: `lib/editor/musicExtractNote/`

- **`musicExtractNotePlugin.ts`** — `parseExtractNote(doc)`로 감지 → 제목 단락 뒤
  `Decoration.widget`로 `contentEditable=false` **`⟳ 진행` 버튼** 마운트(automation 패턴).
  - 항목별 상태 데코(선택): 대기/진행중(스피너)/완료(✅)/실패(❌) 글리프 또는 클래스.
- **`runExtractButtonClick.ts`** — onclick 핸들러:
  1. 버튼 비활성 + 스피너, `pendingItems(doc)` 산출(클릭 시점 스냅샷; liPos는 write 직전 재해석).
  2. 각 대기 항목 **순차**: 상태 진행중 → `extractOne({source})` → `writeExtractResult(view, …)`.
     항목 간 doc 변동으로 liPos가 흔들리므로, 각 항목은 **소스 텍스트로 재조회**해 위치 확정.
  3. 전부 끝나면 성공/부분실패 한국어 토스트(예: "3곡 추출, 1곡 실패") → 버튼 복귀.
  4. 쓰기 직전 view 파괴(노트 닫힘) → 가드 후 남은 항목 중단.

### (E) 문서: 설정 → 가이드

`app/src/routes/settings/+page.svelte`의 **`notes` 서브탭**에 `<details class="guide-card">` 추가.
기존 카드 패턴(짧은 `<summary>`, `<p class="info-text">` 인트로, `<pre class="snippet">` 예시,
`<ul class="guide-list">` 제약/주의). `음악::` 카드와 인접 배치. 명시할 것:
- 데스크탑 `music-service` + `MUSIC_SERVICE_URL` 브릿지 env 선행조건.
- 권리 보유 콘텐츠 전제(개인·자기 호스팅).
- 결과 mp3를 재생하려면 `음악::` 노트로 수동 구성.

### (F) 스킬: `tomboy-musicextract` (신규)

`.claude/skills/` 에 스킬 추가 + 루트 `CLAUDE.md` 스킬 색인 표에 한 줄 등록(`tomboy-dataautomation`
인접). 본문에 불변식(멱등 규칙, 결과 URL = `/files` 패턴, 보안 경계, 배포 함정) 수록.

## 노트 표기

```
음악추출::내 라이브러리

[⟳ 진행]   ← 위젯 버튼 (제목 아래 렌더)

- https://www.youtube.com/watch?v=abcd1234        ← 소스 (권리 보유분만)
    - [Some Song Title](https://<bridge>/files/<uuid>/Some%20Song%20Title.mp3)   ✅ 완료
- Artist Name - Track Title                        ← 검색어 소스(ytsearch1)
    - ❌ 실패: 추출 불가
- https://www.youtube.com/watch?v=efgh5678         ← 신규 (자식 없음 = 대기)
```

⟳ 를 누르면 **자식 URL이 없는 1·2·3번**(2번은 실패 자식뿐이라 재시도 대상)만 순차 추출되고,
각 결과가 해당 항목 밑에 채워진다. 완료(URL 있는 항목)는 건드리지 않는다. 1번 결과를 재생하려면
`[Some Song Title](…mp3)` 줄을 복사해 `음악::` 노트에 붙여 구성한다(수동).

## 에러 처리 (전부 한국어 토스트 + 항목 자식 기록)

| 케이스 | 응답 | UI / 노트 |
|---|---|---|
| 브릿지/서비스 불통·미설정 | 503 | 토스트 "음악 추출 서비스에 연결할 수 없습니다" + 해당 항목 `❌ 실패: 연결 불가` |
| 토큰 만료/누락 | 401 | 토스트 "브릿지 토큰을 확인하세요" + 항목 `❌ 실패: 인증` |
| 빈/잘못된 source | 400 | 항목 `❌ 실패: 잘못된 소스` |
| yt-dlp 추출 불가(영상 없음/지역제한) | 비-200 | 항목 `❌ 실패: 추출 불가` |
| 타임아웃 / 파일크기 상한 초과 | 비-200 | 항목 `❌ 실패: 시간 초과` / `❌ 실패: 용량 초과` |
| 업로드 실패(브릿지 디스크 풀 등) | 비-200 | 항목 `❌ 실패: 저장 실패` |
| 노트 닫힘(view 파괴) | — | 남은 항목 중단, 이미 쓴 결과는 보존 |

- 실패 항목은 URL이 없으므로 **다음 ⟳ 때 자동 재시도**된다("결과 없음 = 작업 대상").
- 한 항목 실패가 배치를 죽이지 않는다(다음 항목 계속).

## 테스트

- **브릿지** `bridge/src/music.test.ts` (`node --test`, `mintToken(SECRET)`): 인증 통과/실패,
  프록시 정상, 503(미설정/불통), 400(빈 source). 업스트림 목. **`/files` 테스트는 기존 그대로**(변경 없음).
- **music-service**: source scheme allowlist(거부 케이스: `file:`, `-`-시작, 파이프 문자), yt-dlp
  `spawn` 목으로 성공/실패/타임아웃, 업로드 호출 인자(Bearer/X-Filename), 검색어 → `ytsearch1:` 변환.
- **앱** (vitest + @testing-library/svelte):
  - `parseExtractNote` — `음악추출::` 감지, 소스/결과 분류(done/error/pending), `pendingItems`가
    신규+실패만 고르는지, `/files` URL만 결과로 인정(다른 URL은 소스 취급).
  - `extractClient` — fetch 목 응답 파싱 + 에러 매핑(401/503/5xx), abort.
  - `writeExtractResult` — fake doc에 (a) 대기 항목에 성공 자식 추가, (b) 실패 자식 추가,
    (c) 기존 실패 자식 → 성공으로 교체, (d) liPos 소스-텍스트 재조회.
  - `musicExtractNotePlugin` — 버튼 위젯 마운트, 항목 상태 글리프 데코.
  - `runExtractButtonClick` — 순차 루프(목 extractOne), 부분 실패 토스트, view 파괴 가드.
- **Tomboy XML 라운드트립** — 결과 URL 자식 insert → `archiveNoteContent`→`unarchiveNoteContent`
  → URL byte-identical(기존 image/file URL 테스트와 동형 한 줄).
- **수동 검증**(No e2e): `music-service` 기동 + `MUSIC_SERVICE_URL` 설정 → `npm run dev` →
  `음악추출::` 노트에 YouTube URL → ⟳ → 항목 밑 URL 채워짐 → 그 URL을 `음악::` 노트에 넣어
  백그라운드/잠금화면 재생 확인. 토큰 깸 → 401, 서비스 끔 → 503.

## 비목표 / 추후

- **Spotify** — 메타데이터(ISRC)로 다른 소스 매칭 다운로드(spotdl 방식). v1 제외.
- **플레이리스트 자동확장** — 한 줄(플레이리스트 URL) → N개 자식 항목. v1 제외.
- **자동 재생노트 생성** — 추출 완료분으로 `음악::` 노트 자동 구성. 수동 유지.
- **진행률 바 / SSE 스트리밍** — 항목 단위 동기 처리로 충분. 필요 시 `claude.ts` SSE 전환.
- **mp3 보관/정리 정책** — Pi 디스크 유한. v1은 `/admin/files`에서 수동 삭제(기존 UI 재사용).
- **dedupe** — 같은 영상 두 번 추출 = mp3 두 개(`/files`는 dedupe 없음).
- **검색 결과 다건 선택** — `ytsearch1`로 1건 자동 선택. 후보 선택 UI 없음.

## 검토했으나 뺀 대안

- **임베드 iframe(YouTube/Spotify/SoundCloud 직접 재생)** — 휴대폰 잠금/백그라운드에서 멈춤.
  사용자 핵심 요구(백그라운드 재생) 위반 → 기각. 추출-후-mp3가 이 제약을 근본 해소.
- **30초 미리듣기(iTunes/Deezer)·다른 소스 매칭 재생** — 풀버전 불가 / 미리듣기 한계. 사용자가
  "로컬 mp3 라이브러리 구축"으로 방향 전환 → 본 설계.
- **새 브릿지 `/music/*` 저장·서빙 엔드포인트** — `/files`가 Range·MIME·무토큰 다운로드를 이미
  제공 → 중복. 재사용.
- **Dropbox 저장** — 사용자가 브릿지 저장을 명시 선택(쿼터 회피, 자기 인프라). 단, 백업·크로스
  디바이스는 Dropbox만 못함(알려진 트레이드오프).
- **automation-service 재사용** — 성격(데이터 자동화)과 다르고 yt-dlp/ffmpeg가 무거움 → 별도 서비스.
- **배치 일괄 추출(automation식 단일 응답)** — 다운로드가 길어 연결 장기 점유·타임아웃 위험 →
  항목별 동기로 변경(진행 가시성 + 부분 실패 격리).
- **자동 재생노트 생성** — 사용자가 수동 구성 선호(작업대/재생 분리) → 미생성.
```
