# SUNO 재생목록 가져오기 (음악 노트)

**날짜:** 2026-06-09
**상태:** 설계 승인됨 (구현 대기)
**관련:** `tomboy-musicextract` 스킬, `docs/superpowers/specs/2026-06-05-music-extract-design.md`

## 한 줄 요약

`음악::` 재생 노트에서 `SUNO:<url>` 줄을 쓰면 우측에 **가져오기** 버튼이 생기고,
클릭하면 브릿지가 Suno 공개 재생목록을 서버 사이드로 읽어 각 곡의 직접 재생 가능한
`audio_url(.mp3)`을 `플레이리스트:` 블록으로 그 자리에 펼쳐 넣는다. 재생은 기존
음악 노트 재생과 동일.

## 배경 / 동기

기존 음악 기능은 두 노트로 나뉜다.

- **`음악추출::` 워크벤치** — 영상/검색어/재생목록 URL → 단일 `⟳ 진행` 헤더 버튼 →
  데스크탑 `music-service`(yt-dlp)가 mp3 다운로드 → 브릿지 `/files` 업로드 →
  `플레이리스트:` 블록 작성. (스킬: `tomboy-musicextract`)
- **`음악::` 재생 노트** — `플레이리스트:` 블록(앞에 `inlineCheckbox` 토글)을 파싱해
  `MusicPlayerBar`로 재생. 트랙 URL은 `<audio src>`로 직접 재생.

Suno 곡은 이미 재생 가능한 `.mp3` CDN URL(`https://cdn1.suno.ai/<id>.mp3`)을 갖는다.
따라서 다운로드/재호스팅이 불필요하다 — 재생목록의 곡 목록과 audio_url만 읽어
`플레이리스트:` 블록으로 만들면 곧바로 재생된다.

## 핵심 결정

1. **저장 방식 = Suno CDN 직접 링크.** 다운로드 없음. 데스크탑 `music-service`/yt-dlp
   **불필요**. 단점: Suno가 곡을 내리면 재생 불가(영구 보존 아님) — 사용자 수용.
2. **위치 = `음악::` 재생 노트.** `음악추출::` 워크벤치가 아니다. `SUNO:<url>`은 기존
   `플레이리스트:` 형식과 나란히 `음악::` 노트에서 인식되는 새 줄 형식이다.
3. **UI = 줄별 `가져오기` 위젯 버튼.** 워크벤치의 단일 헤더 `⟳ 진행`과 다르다. SUNO:
   줄 우측 끝에 버튼이 뜬다.
4. **백엔드 = 브릿지 단독(Approach A).** 항상 켜진 Pi 브릿지가 새 `POST /music/suno`
   라우트에서 공개 재생목록을 서버 사이드로 fetch(CORS 우회)하고 `{ label, tracks }`를
   반환. 데스크탑 서비스 의존 없음. (대안 B: music-service 경유 — 데스크탑 의존 재도입이라
   기각. 대안 C: Vercel 함수 — CLAUDE.md가 음악에 Vercel 함수 금지라 기각.)
5. **블록 형식 = 패턴 A(제목 + 중첩 URL).** Suno는 곡 제목을 주므로, 바 URL 항목(워크벤치
   방식)이 아니라 "제목 줄 + 중첩 URL 서브아이템"으로 작성한다 — 제목이 표시명이 되고,
   중첩 URL 항목은 `text===href`라 `.note` Dropbox 라운드트립에서 href가 보존된다.
6. **체크박스 기본 체크됨.** 워크벤치 출력은 미체크(붙여넣기 대상)지만, 여기선 재생 노트에
   바로 펼치므로 즉시 재생 가능하도록 체크 상태로 삽입.

## 아키텍처 / 데이터 흐름

```
[음악:: 노트 본문 한 줄]   SUNO:https://suno.com/playlist/<id>
        │  (줄 우측에 '가져오기' 위젯 버튼)
        ▼ click
runSunoImportClick(view, line)              app/src/lib/editor/sunoNote/
        │
        ▼
fetchSunoPlaylist({ url })                  app/src/lib/music/sunoClient.ts
        │  POST {bridge}/music/suno  (Bearer = 터미널 브릿지 토큰)
        ▼
handleSunoPlaylist(req,res)                 bridge/src/music.ts
        │  Bearer 검증 후 위임
        ▼
fetchSunoPlaylist(url, {fetch})             bridge/src/suno.ts
        │  1차: studio-api JSON,  2차 폴백: 공개 HTML 임베드 JSON
        ▼
   { label, tracks:[{ url:audio_url, title }], total, truncated }
        │
        ▼  (앱으로 응답)
writeSunoPlaylistBlock(view, line, result)  app/src/lib/music/writeSunoPlaylistBlock.ts
        │  SUNO: 줄 바로 아래에 [x] 플레이리스트: 블록 삽입(패턴 A)
        ▼
parseMusicNote → buildMusicDecorations      (기존) → 재생
```

### 삽입되는 블록(패턴 A)

```
[x] 플레이리스트: <재생목록 이름>          ← inlineCheckbox(checked) + 헤더 단락
  • Song Title 1
      • https://cdn1.suno.ai/<id1>.mp3       ← urlChild(text===href)
  • Song Title 2
      • https://cdn1.suno.ai/<id2>.mp3
```

- 헤더: `inlineCheckbox`(checked) atom + `플레이리스트: <label>` 텍스트. `parseMusicNote`가
  checked=true → 재생 활성으로 인식.
- 각 곡: `listItem( paragraph(제목) , bulletList( listItem( paragraph(urlChild(audio_url)) ) ) )`.
  `parseMusicNote` 패턴 A가 head=제목, 중첩 첫 항목 URL을 읽어 `display=제목`.
- **라운드트립 불변식:** 제목 단락은 평문(마크 없음)이라 무손실. URL 서브아이템은 `urlChild`
  (`text===href`인 `tomboyUrlLink`)라 `.note` 역직렬화 시 href가 textContent에서 재구성됨.
  (참고: 메모리 `tomboyUrlLink round-trip href loss` — text≠href이면 href가 죽는다.)

## Suno 추출 메커니즘 (브릿지 `bridge/src/suno.ts`)

**보장:** 공개 Suno 재생목록은 로그아웃 방문자에게도 오디오가 재생된다 → audio_url이
익명 응답에 **반드시** 존재한다. 따라서 서버 사이드 익명 fetch로 항상 곡 목록을 얻을 수 있다.

추출 체인(브라우저 유사 User-Agent로 요청):

1. **1차 — 내부 JSON API.** `GET https://studio-api.prod.suno.com/api/playlist/<id>/?page=<n>`.
   응답에 `playlist_clips: [{ clip: { id, title, audio_url, image_url, ... } }]`,
   `num_total_results`(또는 유사 총계). 페이지를 상한까지 순회.
   - 호스트/필드는 `gcui-art/suno-api` 참조로 확인: 호스트 `studio-api.prod.suno.com`,
     클립 필드 `id/title/audio_url/image_url/video_url`.
2. **2차 폴백 — 공개 HTML 임베드 JSON.** 1차가 401/빈 응답이면
   `GET https://suno.com/playlist/<id>` HTML을 받아 임베드된 클립 JSON(Next.js
   `__NEXT_DATA__` 또는 RSC `self.__next_f` payload)에서 `audio_url`/`title` 추출.

각 클립 → `{ url: clip.audio_url, title: clip.title }`. `audio_url`이 없거나 http가 아닌
클립은 건너뜀. id 추출은 입력 URL에서 `/playlist/<id>` 세그먼트 파싱
(`suno.com`, `app.suno.ai` 호스트 허용).

**상한:** `SUNO_MAX_PLAYLIST`(브릿지 env, 기본 100). 초과 시 첫 100곡 + `truncated:true`.

## 컴포넌트 / 파일

### 신규

| 파일 | 책임 |
|---|---|
| `app/src/lib/music/parseSunoLine.ts` | doc에서 `SUNO:<url>` 줄 탐지. 각 줄에 대해 `{ url, paraPos, alreadyImported }`. `alreadyImported` = 바로 다음 블록이 `플레이리스트:` 헤더면 true(멱등). `음악::` 제목 게이트. |
| `app/src/lib/music/sunoClient.ts` | `fetchSunoPlaylist({url, signal})` → 브릿지 `POST /music/suno`. `extractClient.ts`의 에러 종류(`SunoError`/kinds) 미러. 반환 `{ label, tracks:[{url,title}], total, truncated }`. |
| `app/src/lib/music/writeSunoPlaylistBlock.ts` | SUNO: 줄 위치를 라이브 재탐색 → 바로 아래에 패턴 A `플레이리스트:` 블록 삽입(체크됨). 이미 결과 블록 있으면 false. |
| `app/src/lib/editor/sunoNote/sunoImportPlugin.ts` | `음악::` 노트의 각 SUNO: 줄(미가져옴)에 `가져오기` 위젯 데코(side:1). 클릭 → `runSunoImportClick`. |
| `app/src/lib/editor/sunoNote/runSunoImportClick.ts` | 한 SUNO: 줄 처리: `fetchSunoPlaylist` → `writeSunoPlaylistBlock`. 토스트(성공/에러/상한). |
| `app/src/lib/editor/sunoNote/index.ts` | `TomboySunoImport` 확장(extension) export. |
| `bridge/src/suno.ts` | `fetchSunoPlaylist(url, deps)` — JSON API 1차 + HTML 폴백. 주입형 `fetch`로 `node --test` 가능. |

### 수정

| 파일 | 변경 |
|---|---|
| `bridge/src/music.ts` | `handleSunoPlaylist(req,res,secret)` 추가 — Bearer 검증 후 `bridge/src/suno.ts` 호출, `{label,tracks,total,truncated}` JSON 응답. |
| 브릿지 서버 라우트 등록 | `POST /music/suno` → `handleSunoPlaylist` 배선. |
| 에디터 확장 목록 | `TomboySunoImport`를 `TomboyMusicNote` 옆에 등록. |
| `app/src/routes/settings/+page.svelte` | 가이드 카드(guideSubTab `notes`) 추가. |

### 클라이언트 인터페이스(초안)

```ts
// app/src/lib/music/sunoClient.ts
export type SunoErrorKind =
  | 'not_configured' | 'unauthorized' | 'network'
  | 'bad_request' | 'upstream_error' | 'empty';
export interface SunoTrack { url: string; title: string; }
export interface SunoPlaylist {
  label: string;
  tracks: SunoTrack[];
  total: number;
  truncated: boolean;
}
export function fetchSunoPlaylist(opts: { url: string; signal?: AbortSignal }): Promise<SunoPlaylist>;
```

```ts
// bridge/src/suno.ts
export interface SunoDeps { fetch?: typeof fetch; maxPlaylist?: number; userAgent?: string; }
export interface SunoResult {
  label: string;
  tracks: { url: string; title: string }[];
  total: number;
  truncated: boolean;
}
export function fetchSunoPlaylist(playlistUrl: string, deps?: SunoDeps): Promise<SunoResult>;
```

## 에러 처리 / 멱등 / 상한

- **에러 → 한국어 토스트.** `extractClient` 패턴 재사용. `not_configured`(브릿지 설정 필요),
  `unauthorized`(브릿지 인증), `network`/`service_unavailable`(연결 불가),
  `bad_request`(잘못된 URL), `upstream_error`(Suno 읽기 실패), `empty`(재생목록을 읽을 수 없음).
- **멱등.** SUNO: 줄 바로 아래에 `플레이리스트:` 헤더가 이미 있으면 `가져오기` 버튼이
  안 뜬다(`alreadyImported`). 재가져오기는 블록 삭제 후.
- **상한.** 곡 수 상한(기본 100), 초과 시 첫 100곡 + `상한 초과 …` 토스트.
- **부분 성공.** audio_url 없는 개별 클립은 건너뜀(나머지 곡으로 블록 생성). 0곡이면 블록
  미작성 + `재생목록을 읽을 수 없습니다`.
- **줄 보존.** SUNO: 줄은 삭제하지 않고 그 아래에 블록을 삽입(멱등 판정과 재가져오기 위해).

## 재생 호환성 메모

- `cdn1.suno.ai/<id>.mp3`는 정상 호스트 + `.mp3` 확장자라 `<audio src>` 직접 재생.
  Safari/iOS도 OK — 브릿지 전용 `toPlayableSrc` 재작성은 브릿지 `/files` URL만 건드리므로
  Suno URL에 간섭하지 않음(메모리 `Mobile music playback gotchas` 참고).
- 일부 클립은 `audio_url`이 `https://audiopipe.suno.ai/?item_id=<id>` 스트리밍 형태일 수
  있음 — 그대로 통과(재생 가능하면 사용). `.mp3` 직링크를 우선.

## 테스트

- **`parseSunoLine`** (vitest) — SUNO: 줄 탐지, `alreadyImported` 판정, 비-음악 노트 무시.
- **`writeSunoPlaylistBlock`** (vitest + `.note` 아카이버 라운드트립) — 패턴 A 블록 생성 +
  href 보존 단언(인메모리 파싱은 통과해도 라운드트립이 깨지는 케이스 방지 —
  메모리 `tomboyUrlLink round-trip href loss` 교훈).
- **`bridge/src/suno.ts`** (`node --test`, NOT vitest) — 캡처한 JSON 픽스처 1개 + 캡처한
  HTML 픽스처 1개로 파싱·매핑 검증. 주입형 fetch.
- **`sunoImportPlugin`** — 가져오기 버튼 데코가 미가져옴 SUNO: 줄에만 뜨는지 마운트 테스트.

## 가이드 (설정 → 가이드 → 노트)

새 `<details class="guide-card">`:
- `<summary>` SUNO 재생목록 가져오기
- intro: `음악::` 노트에서 `SUNO:<재생목록 URL>` 줄을 쓰고 우측 `가져오기` 클릭.
- `<pre class="snippet">` 예시 한 줄.
- `<ul class="guide-list">`: 직접 링크라 다운로드 없음 / Suno가 곡을 내리면 재생 불가 /
  브릿지 설정 필요(터미널 탭 링크) / 이미 가져온 줄은 블록 삭제 후 재가져오기.

## 배포

- **브릿지 재배포 필요** — 새 `/music/suno` 라우트 + `bridge/src/suno.ts`. 데스크탑
  music-service는 **무관**(이 기능에 미사용).
- 앱은 Vercel 정적 배포(새 서버 함수 없음).
- 브릿지 env: `SUNO_MAX_PLAYLIST`(선택, 기본 100).

## 위험 / 미해결

- **Suno 내부 JSON API 변동성.** 비공식 API라 경로/필드가 바뀔 수 있음. HTML 임베드 JSON
  폴백이 안전망(공개 페이지가 익명 재생되는 한 audio_url은 존재). 구현 시 실제 공개
  재생목록 1개로 두 경로를 검증하고 픽스처 캡처.
- **audio_url 만료/서명.** 일부 audio_url이 서명·만료될 수 있음. 직접 링크 모델의 수용된
  한계(곡 내려가면 재생 불가)와 동일선상 — 영구 보존이 필요하면 추후 "다운로드 승격"을
  별도 기능으로(현 범위 밖, YAGNI).
```

