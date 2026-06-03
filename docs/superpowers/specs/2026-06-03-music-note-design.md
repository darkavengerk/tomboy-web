# 음악 노트 (`음악::`) — Design Spec

## Goal

노트 제목이 `음악::{이름}` 으로 시작하면 **음악 노트**가 된다. 본문에는
아무 텍스트나 올 수 있고, `플레이리스트:{설명}` 문단 바로 다음에 오는
리스트(ul/ol)의 아이템들이 **재생 트랙**이 된다. 제목 아래에 sticky 컨트롤
패널(재생/정지·이전/다음·진행바)이 생기고, 한 노트의 모든 플레이리스트
트랙은 문서 순서대로 **하나의 연속 큐**로 이어 재생된다.

재생 중인 곡은 리스트 마커 대신 재생 아이콘으로 표시되고, `modKeys.ctrl`
이 active 일 때(데스크탑 = Ctrl+호버, 모바일 = 가상 Ctrl 버튼 ON 후 탭)
각 트랙에 인라인 재생 버튼이 노출된다.

v1 은 **직접 오디오 파일 URL**(`.mp3` 등 HTML5 `<audio>` 재생 가능 링크)
을 대상으로 한다.

## Why

`자동화::` / `DATA::` 노트의 **제목 prefix 감지**, `automationNotePlugin`
의 **헤더 위젯 데코레이션**, `sendListItem` 의 **`modKeys.ctrl` 게이트로
리스트 아이템에 버튼 노출**, `ChatSendBar` 의 **에디터 밖 컴포넌트 +
parse 함수 기반 조건부 마운트** — 네 가지 기존 패턴을 그대로 조합한다.

재생 상태(큐·현재곡·진행)는 **노트에 기록하지 않는다**. 데코레이션과 외부
컴포넌트는 doc 을 변형하지 않으므로 `.note` XML 이 그대로 라운드트립되어
Tomboy desktop 호환과 Dropbox 동기화에 영향이 없다.

## 노트 포맷 & 감지

### 노트 판별

```
음악::주말 플레이리스트          ← 노트 제목 (note-content 첫 줄)

주말에 듣는 노래 모음.            ← 본문 아무 텍스트

플레이리스트: 아침               ← 헤더 문단
- Song A                         ← 패턴 A: 깊이1 = 제목
  - https://ex.com/a.mp3         ←          깊이2 = URL
- https://ex.com/b.mp3           ← 패턴 B: 깊이1 = URL (제목 모름)

플레이리스트: 저녁               ← 두 번째 플레이리스트
- Song C
  - https://ex.com/c.mp3
```

- **음악 노트 판별**: `doc.firstChild?.textContent.trim().startsWith('음악::')`
  (`parseAutomationTitle` 미러링, prefix = `음악::`).
- **이름 추출**: prefix 뒤 trim. 비어도 음악 노트로 인정(이름 없는 패널).

### 플레이리스트 헤더 & 트랙 리스트

- **플레이리스트 헤더** = 텍스트가 `플레이리스트:` 로 시작하는 paragraph.
  prefix 뒤 trim = 플레이리스트 라벨(설명, 비어도 됨).
- **트랙 리스트** = 헤더 문단의 **바로 다음 형제 블록**이 `bulletList`
  또는 `orderedList` 인 경우 그 리스트. 그 외 위치의 리스트는 무시 →
  일반 본문 리스트와 충돌하지 않는다.
- 한 노트에 헤더 여러 개 → 각 헤더의 트랙 리스트를 문서 순서대로 이어
  하나의 `flatQueue` 로 만든다.

## 트랙 추출 (`parseMusicNote.ts`)

순수 함수. 입력 = editor JSON(`PMNode` 형태) 또는 doc, 출력:

```ts
interface MusicTrack {
  url: string;          // 재생 URL
  title: string | null; // 패턴 A 면 제목, 패턴 B 면 null
  display: string;      // 패널/리스트 표시명 (title ?? deriveName(url))
  liPos: number;        // 깊이1 <li> 의 doc pos (데코레이션 키/매칭용)
}
interface MusicPlaylist { label: string; tracks: MusicTrack[]; }
interface MusicNote {
  isMusic: boolean;
  name: string;                  // 음악:: 뒤 이름
  playlists: MusicPlaylist[];
  flatQueue: MusicTrack[];       // 모든 playlist.tracks 를 순서대로 평탄화
}
export function parseMusicNote(docOrJson): MusicNote;
```

각 트랙 리스트의 깊이-1 `<li>` 마다:

1. `<li>` 의 본체 paragraph 텍스트 = `head`, 본체에서 첫 http(s) URL 탐색
   (평문 정규식 + `tomboyUrlLink` 마크 href 둘 다 인식).
2. **`head` 자체가 URL** → **패턴 B**: `{ url: head, title: null }`.
3. 아니고 `<li>` 안에 **중첩 리스트**가 있으면 그 첫 중첩 `<li>` 에서 첫
   URL 추출 → **패턴 A**: `{ url, title: head }`.
4. URL 을 못 찾으면 **비-트랙**으로 스킵(큐에 안 들어감).

- `deriveName(url)`: 마지막 경로 세그먼트 디코드 + 확장자 제거. 실패 시
  URL 원문.
- **확장자 검사 없음** — 트랙의 출처는 리스트 구조다. 재생 가능 여부는
  `<audio>` 가 판정하고, 못 읽으면 그 트랙 에러 → 다음 곡으로 진행.

## 플레이어 런타임

### `lib/music/musicPlayer.svelte.ts` (전역 rune 스토어)

한 번에 한 곡(단일 오디오). 모듈 `$state`:

```ts
let queue = $state<MusicTrack[]>([]);
let currentIndex = $state(-1);     // -1 = 선택 없음
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let activeNoteGuid = $state<string | null>(null);

export const musicPlayer = {
  get queue() {...}, get currentIndex() {...}, get isPlaying() {...},
  get currentTime() {...}, get duration() {...},
  get currentTrack() { return queue[currentIndex] ?? null; },

  // MusicPlayerBar 가 doc 재파싱 결과를 밀어넣음.
  // currentTrack.url 로 매칭해 currentIndex 보존(트랙 추가/삭제 견딤).
  setQueue(noteGuid: string, tracks: MusicTrack[]): void,

  play(index: number): void,   // index 곡으로 점프 + 재생
  toggle(): void,              // 현재 곡 재생/일시정지
  next(): void, prev(): void,  // flatQueue 경계 넘나듦(플레이리스트 가로지름)
  seek(t: number): void,
  // onended → next(); 큐 끝이면 isPlaying=false (정지, 반복 없음)
};
```

- **연속 큐**: `next`/`prev` 는 `queue`(=flatQueue) 인덱스를 ±1 → 플레이
  리스트 경계를 자연히 넘는다.
- 다른 음악 노트를 열면 `setQueue` 의 `noteGuid` 가 바뀌며 큐 교체 +
  currentIndex 리셋.

### `MusicPlayerBar.svelte` (제목 아래 sticky 컨트롤 패널)

- 숨은 `<audio>` 1개를 소유. `play()` 시 `audio.src = currentTrack.url`,
  `timeupdate`/`loadedmetadata`/`ended`/`error` → 스토어 갱신.
- UI: 재생 중인 라벨(`플레이리스트` 칩 + 곡명) + ⏮ ⏯ ⏭ + 진행바(seek) +
  시간. `clamp()` 반응형(바 사이즈 규칙 준수).
- **마운트 조건**: `/note/[id]/+page.svelte` 와 데스크탑 `NoteWindow.svelte`
  에서 `parseMusicNote(content).isMusic` 일 때만 렌더 (ChatSendBar 패턴).
- doc 변경 시 재파싱 → `musicPlayer.setQueue(guid, flatQueue)`.
- 곡 에러(`audio.onerror`) → 해당 트랙 에러 표시(스토어 플래그) 후 `next()`.

## 에디터 안 렌더링 (`musicNotePlugin.ts`)

`automationNotePlugin` + `geoMapPlugin` 패턴의 ProseMirror `Plugin`.

- plugin state: doc 에서 `parseMusicNote` 로 트랙 `liPos` 목록 산출 →
  `DecorationSet`. `apply` 에서 `tr.docChanged` 면 재빌드.
- **재생 중인 곡 마커**: `musicPlayer.currentTrack` 의 `liPos` 에 해당하는
  `<li>` 에 node decoration 클래스(`music-track--playing`) 부여 → CSS 로
  네이티브 마커 숨김 + 위젯 데코로 이퀄라이저/▶ 아이콘 삽입(content 시작
  side:-1). 정지 시 마커 복귀.
- **트랙별 컨트롤 (Ctrl-게이트)**: `modKeys.ctrl` 이 active 일 때만 각 트랙
  `<li>` 에 인라인 버튼 위젯(`side:1`) 노출. 버튼 = ▶(여기서부터 재생) →
  그 곡이 현재 재생 중이면 ⏸. 클릭 → `musicPlayer.play(queueIndex)`.
  - `modKeys.ctrl` 은 reactive 이므로 plugin 은 이 값 변화에 데코를 갱신
    해야 한다. `sendListItem` 처럼 외부 reactive 값을 plugin 에 전달하는
    방식(메타 디스패치 또는 effect → `view.dispatch` 빈 tr)으로 재빌드를
    트리거한다. 구현 시 `sendActiveGate`/`+page.svelte` 의 `$derived` +
    plugin 통지 방식을 그대로 미러링.
- **등록**: `TomboyEditor.svelte` 의 extensions 에
  `Extension.create({ name: 'tomboyMusicNote', addProseMirrorPlugins: () => [createMusicNotePlugin(...)] })`.

### 마커 ↔ doc 안전성

데코레이션은 doc 을 변형하지 않는다. 재생 상태는 스토어(휘발)에만 있다.
`.note` XML, 제목 유일성, 백링크 인덱스 등 기존 불변식에 영향 없음.

## 파일 구조

```
app/src/lib/music/
├── parseMusicNote.ts          # 순수 파서 (doc → MusicNote)
├── musicPlayer.svelte.ts      # 전역 rune 스토어 + 액션
└── deriveName.ts              # URL → 표시명 (또는 parseMusicNote 내부)

app/src/lib/editor/musicNote/
├── index.ts                   # export TomboyMusicNote extension
├── musicNotePlugin.ts         # 데코레이션(재생중 마커 + Ctrl-게이트 버튼)
└── MusicPlayerBar.svelte      # 상단 컨트롤 패널 + <audio> 소유
```

(파서를 `lib/music/` 에 두는 이유: `MusicPlayerBar`(컴포넌트)와
`musicNotePlugin`(에디터) 양쪽에서 쓰고, 노트 판별을 `/note/[id]` 라우트
에서도 호출하므로 에디터 비의존 위치가 적절.)

### 마운트 지점

- `app/src/routes/note/[id]/+page.svelte` — `parseMusicNote(content).isMusic`
  이면 `<MusicPlayerBar editor={...} guid={noteId} />` 렌더.
- `app/src/lib/desktop/NoteWindow.svelte` — 동일 조건부 렌더(데스크탑).
- `app/src/lib/editor/TomboyEditor.svelte` — `tomboyMusicNote` extension 등록.

## CSS

`TomboyEditor.svelte` 에 트랙/마커 스타일 추가:

- `li.music-track--playing` → `list-style: none` (네이티브 마커 숨김),
  배경 하이라이트.
- 이퀄라이저 아이콘(위젯) 애니메이션 + ▶/⏸ 폴백.
- Ctrl-게이트 인라인 버튼: 작은 원형/사각 버튼, `contentEditable=false`.
- 패널 바: sticky, `clamp()` 반응형 gap/padding/font.

## Dropbox 직링크 (고려)

직접 오디오 URL 중 `www.dropbox.com` 링크는 `<audio src>` 재생 시
`?dl=1`/`raw=1` 변환이 필요할 수 있다. `toDirectImageUrl` 류의
`toDirectMediaUrl` 를 둘 수 있으나, **v1 최소 구현은 URL 패스스루**로 하고
필요 시 후속 확장한다(이미지 캐시처럼 호스트 분기).

## 테스트 (`app/tests/unit/music/`)

`parseMusicNote` 중심 단위 테스트(파서가 핵심 로직):

1. **노트 판별** — 제목 `음악::X` → `isMusic=true`, name=`X`. `음악::` 만
   → isMusic=true, name=`''`. 비음악 제목 → `isMusic=false`.
2. **헤더+리스트 감지** — `플레이리스트: 아침` 다음 bulletList → 트랙 추출.
   헤더 없는 본문 리스트 → 무시. orderedList 도 인정.
3. **패턴 A** — 깊이1 텍스트=제목, 깊이2 첫 URL → `{title, url}`.
4. **패턴 B** — 깊이1 텍스트=URL → `{title:null, url}`, `display`=파일명.
5. **URL 마크** — `tomboyUrlLink` href 로만 된 아이템도 URL 인식.
6. **비-트랙 스킵** — URL 없는 아이템은 큐에서 제외.
7. **다중 플레이리스트 평탄화** — 헤더 2개 → `flatQueue` 가 문서 순서대로
   이어짐(가로지르는 next/prev 순서 확인).
8. **deriveName** — `https://h/path/My%20Song.mp3` → `My Song`.

`musicPlayer.svelte.ts` 액션 테스트:

9. **setQueue 보존** — currentTrack.url 동일하면 트랙 추가/삭제 후에도
   currentIndex 가 같은 곡을 가리킴.
10. **next/prev 경계** — 큐 끝에서 next → 정지(isPlaying=false), 시작에서
    prev → 클램프.

(브라우저 `<audio>` 재생 자체는 자동 테스트 비대상 — `npm run dev` 수동
확인.)

## 가이드 카드 (필수)

`app/src/routes/settings/+page.svelte` `guideSubTab='notes'` 에
`<details class="guide-card">` 추가:

- summary: "음악 노트 (`음악::`)"
- 본문: 포맷 설명(`플레이리스트:` 헤더 + 리스트, 패턴 A/B), 컨트롤 패널,
  Ctrl-게이트(모바일 가상 Ctrl 버튼), 연속재생.
- `<pre class="snippet">` 에 위 포맷 예시.
- `<ul class="guide-list">` 에 제약(직접 오디오 URL 한정, SUNO 후속 등).

## 비-목표 (Non-goals)

- **SUNO:: 노트** — `SUNO::{이름}` + 2번째 줄 플레이리스트 링크 → 본문
  자동 채움. **별도 후속 스펙**. 본 스펙은 직접 오디오 URL 만.
- **유튜브/스트리밍 임베드** — iframe 통일 컨트롤 어려움. v1 제외.
- **셔플 / 반복 / 볼륨 / 플레이리스트별 분리재생** — YAGNI. 연속 큐 + 기본
  재생 컨트롤만.
- **재생 위치 영속화** — 노트 닫으면 휘발. 노트에 상태 안 씀.
- **여러 노트 동시 재생** — 전역 단일 오디오. 다른 음악 노트 열면 큐 교체.
- **플레이리스트 자동 메타데이터/길이 표시** — `<audio>` duration 외 별도
  메타 fetch 안 함.
```
