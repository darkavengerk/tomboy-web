# 음악추출 재생목록 지원 설계 (Playlist extract)

**작성일:** 2026-06-06
**선행:** [2026-06-05-music-extract-design.md](./2026-06-05-music-extract-design.md) — 단일 곡 `음악추출::` 노트 (배포 완료)

## 목표

`음악추출::` 노트에서 **유튜브 재생목록/믹스 URL 한 줄**을 주면 ⟳ 한 번으로 전체 곡을 mp3 추출하고, 그 결과를 **`음악::` 노트에 그대로 복사·붙여넣을 수 있는 플레이리스트 블록**으로 노트에 기록한다.

## 배경 / 현재 한계

- `music-service/src/runner.ts`의 `runYtdlp`는 `--no-playlist` 고정 → 재생목록 URL을 줘도 영상 1개만 받음.
- `parseExtractNote.ts`는 **불릿 리스트 항목만** 소스로 인식. 일반 텍스트 줄(문단)은 무시.
- 결과는 항목 밑 중첩 리스트의 단일 `/files/<uuid>/` 링크.

## 사용자 포맷 (확정)

`음악추출::` 노트는 두 종류의 소스를 섞어 담을 수 있다:

- **단일 곡** → 지금처럼 **불릿 항목** (변경 없음).
- **재생목록/믹스** → **일반 텍스트 줄(문단)**에 URL.

⟳ 실행 시, 재생목록 텍스트 줄을 열거 → 각 곡 mp3 추출 → **소스 줄 바로 아래에 `음악::` 노트용 플레이리스트 블록**을 생성:

```
음악추출::가수A
https://www.youtube.com/watch?v=…&list=RD…      ← 재생목록 소스 (텍스트 줄)
[ ]플레이리스트: 가수A 믹스                        ← 생성된 결과 헤더 (미체크 inlineCheckbox)
• https://umayloveme.duckdns.org/files/<uuid>/곡1.mp3
• https://umayloveme.duckdns.org/files/<uuid>/곡2.mp3
• https://umayloveme.duckdns.org/files/<uuid>/곡3.mp3
```

`[ ]플레이리스트:`부터 불릿까지 통째로 복사 → `음악::` 노트에 붙임 → 체크박스를 켜면 재생. (`음악::` 노트 파서 `parseMusicNote.ts` 규약과 byte-호환: `플레이리스트:` 접두 문단 + 다음 불릿 리스트, 앞 `inlineCheckbox.checked`가 켜짐/꺼짐.)

## 결정 (확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 플레이리스트 헤더 체크박스 | **`[ ]` 미체크** (`inlineCheckbox{checked:false}`) | 붙여넣은 뒤 사용자가 명시적으로 켜서 재생 |
| 곡 수 상한 | **50곡** (env `MUSIC_MAX_PLAYLIST`, 기본 50) | RD 믹스·대형 재생목록 폭주 방지. 초과분은 자르고 토스트 경고 |
| 재실행 (이미 블록 있음) | **건너뜀** (스냅샷 1회) | 새로 받으려면 블록 지우고 다시 ⟳ |
| 트랙 줄 형식 | **맨 mp3 URL (text===href)** | `.note` 라운드트립에서 href 보존(`tomboyUrlLink` 텍스트만 보존되는 함정 회피). 음악 노트가 파일명에서 곡 제목 유도 |

## 데이터 흐름

```
⟳ → runExtractButtonClick
  ├─ 단일 곡 항목: extractOne(source) → writeExtractResult            (기존)
  └─ 재생목록 소스: enumeratePlaylist(source)                          (신규)
        → POST {bridge}/music/enumerate {source}
            → music-service POST /enumerate
                → yt-dlp -J --flat-playlist --yes-playlist <url>
                → { label, entries:[{url,title}], total, truncated }   (상한 50 적용)
        → entries 각각 extractOne(entry.url)  (순차, 기존 단일 추출 재사용)
        → 성공 URL 모아 writePlaylistBlock(view, source, label, urls)  (신규)
```

핵심: **열거만 신규**, 곡별 다운로드/업로드/토큰 경로는 기존 단일 추출(`extractOne` → `/music/extract` → `runner.extract`)을 **그대로 재사용**. 곡 단위 멱등·타임아웃·에러 처리도 그대로 얻는다.

## 컴포넌트 변경

### 1. music-service — 열거 엔드포인트

**`src/validate.ts`** — 변경 없음 (열거는 URL을 그대로 yt-dlp에 전달).

**`src/runner.ts`** — `enumerate(source, deps)` 추가 (기존 `extract`는 불변):
- `yt-dlp -J --flat-playlist --yes-playlist --socket-timeout 30 [--ffmpeg-location] <url>` 실행, stdout 캡처 (`stdio:['ignore','pipe','pipe']` — JSON 받아야 하므로 stdout pipe; **읽기를 반드시 소비**해 데드락 방지).
- stdout JSON 파싱: `.title`(없으면 `'재생목록'`), `.entries[]`에서 `id`+`title` 추출 → `url = https://www.youtube.com/watch?v=<id>`.
- 상한 `maxPlaylist`(기본 50) 적용: `entries.slice(0, max)`, `truncated = total > max`.
- 반환 `{ label, entries:[{url,title}], total, truncated }`. 0개면 `bad_source:empty_playlist` throw.
- 타임아웃 기본 60s (열거는 다운로드 없음; `MUSIC_ENUMERATE_TIMEOUT_MS`).

**`src/server.ts`** — `POST /enumerate` 추가:
- 인증·바디 검증 `/extract`와 동일 (Bearer 평문 토큰, `source` 필수).
- `enumerate(source, {ytdlpPath, ffmpegPath, maxPlaylist, timeoutMs})` 호출.
- 에러→코드: `bad_source*`→400 / `타임아웃`→504 / else→502 (기존과 동일 규약).
- `maxPlaylist = Number(process.env.MUSIC_MAX_PLAYLIST ?? 50)` 부트 와이어링.
- `extractFn`처럼 테스트 주입용 `enumerateFn?` 추가.

### 2. bridge — 열거 릴레이

**`src/music.ts`** — `handleMusicEnumerate(req, res, secret, musicServiceUrl)` 추가 (`handleMusicExtract` 클론, 경로만 `/enumerate`). 401/400/503-not-configured/passthrough/503-unavailable + `signal: AbortSignal.timeout(120_000)`(열거는 짧음).

**`src/server.ts`** — 라우트 `POST /music/enumerate` → `handleMusicEnumerate(...)`. `MUSIC_SERVICE_URL` 재사용 (이미 와이어됨).

> ⚠️ **재배포 필요**: 브릿지에 새 라우트 추가 → `ssh -p 2222 192.168.219.110` → `git pull` → `podman build` → restart. music-service도 `/enumerate` 추가 → 재빌드+재기동. (배포 절차는 [[reference_desktop_bridge_network]] 메모리.)

### 3. app — extractClient

**`src/lib/musicExtract/extractClient.ts`** — `enumeratePlaylist({source, signal})` 추가:
- `POST {bridgeToHttpBase}/music/enumerate {source}`, Bearer.
- 반환 `{ label:string, entries:{url,title}[], total:number, truncated:boolean }`.
- 에러는 기존 `ExtractError`/`ExtractErrorKind`/`STATUS_TO_KIND` 재사용.

### 4. app — parseExtractNote (블록 순회 리팩터)

`doc`를 **블록 순서대로** 순회하며 직전 블록 컨텍스트 추적:

- **제목 문단**(idx 0): 스킵.
- **`플레이리스트:` 접두 문단**: "결과 헤더"로 표시 → 이 문단과 **바로 다음 리스트 블록**은 소스가 아님 (스킵). 직전에 본 재생목록 소스를 `done`으로 표시.
- **그 외 문단 + URL(`[?&]list=` 또는 `/playlist?`) 포함**: **재생목록 소스**. `done` = 다음 블록이 `플레이리스트:` 헤더인지로 결정. `paraPos`(문단 시작) 보관.
- **불릿/번호 리스트** (직전이 `플레이리스트:` 헤더가 **아닐** 때): 각 listItem = **단일 곡 소스** (기존 로직 그대로).

모델:
```ts
type ExtractItem =
  | { kind: 'single';   source: string; result: ExtractResult; liPos: number }
  | { kind: 'playlist'; source: string; done: boolean; paraPos: number };
```
`pendingItems` = single(result≠done) + playlist(done=false). 기존 `isExtractTitle`/`isExtractNoteDoc`/`itemSource`/`resultOf` 유지. `RESULT_URL_RE`로 트랙 줄(mp3 URL)이 단일-소스로 오인되지 않게 — 단일-소스 판정에서 `/files/<uuid>/` URL 항목 제외.

판정 규칙은 가이드에 명시: **재생목록 = 일반 줄, 단일 곡 = 불릿**. (불릿에 list= URL을 넣어도 단일 영상으로 처리 — 기존 동작.)

### 5. app — writePlaylistBlock (신규, writeExtractResult 옆)

`findPlaylistTarget(doc, source)` — source URL을 가진 미완료(다음 블록이 `플레이리스트:` 아님) 문단을 **라이브 재탐색**, 삽입 위치(문단 끝) 반환.

블록 구성 후 `tr.insert`:
- 헤더: `paragraph(null, [ inlineCheckbox.create({checked:false}), schema.text('플레이리스트: ' + label) ])`
  - `inlineCheckbox` 노드 없으면(스키마 미등록 테스트 환경) 텍스트 `'[ ]플레이리스트: '+label`로 폴백.
- 리스트: `bulletList(null, urls.map(u => listItem(null, paragraph(null, urlChild(schema,u)))))` — `urlChild`는 기존 헬퍼 재사용(text===href).

### 6. app — runExtractButtonClick

`pendingItems` 순회 시 `kind` 분기:
- `single` → 기존 흐름.
- `playlist` →
  1. `enumeratePlaylist(source)`; 실패가 SYSTEMIC이면 토스트+중단(기존 규칙).
  2. `entries` 순차 `extractOne(entry.url)`; 곡별 실패는 카운트만(❌ 노트 기록 X — 재생목록 블록은 성공 곡만), SYSTEMIC이면 중단.
  3. 성공 URL ≥1 → `writePlaylistBlock(view, source, label, urls)`. 0이면 블록 미작성(소스는 pending 유지 → 재시도 가능).
- 요약 토스트에 곡 수·재생목록 수·잘림 경고 반영 (예: `"재생목록 1개(50곡 중 50곡, 12곡 추출), 단일 3곡 추출"`).

### 7. 설정 가이드 (`routes/settings/+page.svelte`, `notes` 서브탭)

기존 `음악추출::` 카드에 재생목록 사용법 추가: 재생목록은 일반 줄/단일은 불릿, 결과 `플레이리스트:` 블록을 `음악::` 노트로 복사, 상한 50, RD 믹스는 동적(매번 다름·개수 제한)이라 정규 `list=PL…`/`OLAK5uy…`가 안정적.

### 8. 스킬 (`tomboy-musicextract/SKILL.md`)

재생목록 열거 흐름·`/music/enumerate` 릴레이·블록 출력 포맷·상한·멱등 규칙 추가.

## 불변식

- **열거만 신규** — 곡별 추출/업로드/토큰(HMAC)·곡별 멱등·타임아웃은 기존 단일 경로 재사용.
- **트랙 줄은 맨 URL(text===href)** — `.note` 라운드트립 href 보존. [[project_tomboyurllink_roundtrip_href]].
- **자동 음악 노트 생성 없음** — `음악추출::` 노트에 복사 가능한 블록만 만든다. `음악::` 노트 구성은 사용자 수동(기존 합의).
- **`BRIDGE_SHARED_TOKEN === 브릿지 BRIDGE_SECRET`** 유지 — 열거 릴레이도 동일 토큰.
- **상한 명시** — 잘림 시 토스트로 알림(조용한 절단 금지).
- **권리 보유 콘텐츠 전제** — 데스크탑 전용 개인 사용 (기존 제약 유지).

## 엣지 케이스

- **RD 믹스 동적성**: 매 열거마다 곡 구성이 다를 수 있고 개수 제한적. 가이드에 명시. 건너뜀 정책이라 한 번 받으면 고정 스냅샷.
- **`watch?v=X&list=Y`**: list= 있으면 재생목록으로 열거(영상 X 포함). 단일 영상만 원하면 `&list=` 제거.
- **부분 실패**: 일부 곡 실패 → 성공분만 블록에 포함, 토스트에 실패 수.
- **전체 실패 / 0곡**: 블록 미작성, 소스 pending 유지, 토스트 알림.
- **상한 초과**: 첫 50곡만, `truncated` 토스트.

## 테스트

- **music-service** (`vitest`): `enumerate` — 정상 JSON 파싱(label+entries), 상한 슬라이스+truncated, 0엔트리→bad_source, 타임아웃, ffmpeg/ytdlp 경로. `server` `/enumerate` — 401/400/200/504/502, enumerateFn 주입.
- **bridge** (`node --test`): `/music/enumerate` 릴레이 401/400/503/passthrough, mintToken.
- **app** (`vitest`):
  - `parseExtractNote`: 단일+재생목록 혼합, 재생목록 done 판정(플레이리스트 블록 유무), 트랙 URL이 단일소스로 오인 안 됨, 제목/일반 문단 무시.
  - `writePlaylistBlock`: 헤더(`inlineCheckbox{checked:false}`+`플레이리스트:`)+불릿(맨 URL) 구조, 삽입 위치, 폴백.
  - **라운드트립 테스트**: 생성 블록 `serializeContent→deserializeContent` 후 `플레이리스트:` 헤더·체크박스·각 mp3 href 보존 — `parseMusicNote`가 그대로 트랙 인식하는지까지 검증.
- 실제 다운로드 검증은 사용자 수동(권리 보유 콘텐츠).

## 배포 (구현 후)

1. **music-service 재빌드+재기동** (`/enumerate` 추가): canonical 경로에서 `npm run build` → `systemctl --user restart music-service`.
2. **브릿지 재배포** (`/music/enumerate` 라우트): main push → `ssh` → `git pull` → `podman build` → restart.
3. app은 클라이언트 — dev/배포가 자동 반영.

## 범위 밖 (YAGNI)

- 곡별 진행 표시(현재 순차 + 최종 토스트). 대형 재생목록은 시간 걸림 — v1 수용.
- 자동 새로고침(커가는 재생목록) — 건너뜀 정책. 필요 시 후속.
- Spotify/SoundCloud 재생목록 — 기존대로 범위 밖.
- 곡 중복 제거(여러 재생목록 간) — v1 미포함.
