---
name: tomboy-remarkable-send
description: 노트 → PDF 번들(BFS depth + forward/backward 트리 + 이미지/차트) → 브릿지 → SSH → reMarkable xochitl. 데스크탑 우클릭 "리마커블로 보내기".
---

# tomboy-remarkable-send

데스크탑 노트 윈도우 우클릭 → "리마커블로 보내기" 메뉴 → 모달에서 깊이 / 트리 / 제외 셋 확정 →
`pdfBundle` 이 forward+backward BFS 로 노트 그래프를 한 PDF 로 묶음 → 브릿지가 SSH 로 reMarkable
의 `xochitl` 디렉터리에 `.pdf` + `.metadata` + `.content` 떨궈 `systemctl restart xochitl`.

## 경로

| 레이어 | 파일 |
|---|---|
| 앱 모달 / 진입점 | `app/src/lib/remarkable/SendToRemarkableModal.svelte`, `app/src/lib/desktop/NoteWindow.svelte` (`<SendToRemarkableModal>` 마운트), `app/src/lib/editor/EditorContextMenu.svelte` ("리마커블로 보내기") |
| 송출 클라이언트 | `app/src/lib/remarkable/sendNoteToRemarkable.ts` (PDF blob → multipart/JSON → SSE 소비) |
| 번들 빌더 | `app/src/lib/remarkable/pdf/pdfBundle.ts` (BFS · 트리 · 본문 직조) |
| 보조 | `extractImageUrls.ts`, `fetchImagesForBundle.ts`, `findJsonChartRegions.ts`, `renderChartsToImages.ts`, `tiptapToPdfmake.ts`, `koreanFont.ts` |
| 설정 / 별칭 | `app/src/lib/remarkable/RemarkableSendSettings.svelte`, `appSettings.ts: getAllRemarkableSendDefaults` |
| 브릿지 | `bridge/src/remarkableSendPdf.ts` (`POST /remarkable/send-pdf` → SSE), `remarkableHosts.ts`, `remarkableFolders.ts` |

## 모달 트리 — forward + backward 양방향

- **두 트리 좌우 배치(데스크탑 전용, 모달 너비 880px)** — 왼쪽 "앞으로"(이 노트가 링크하는 노트들),
  오른쪽 "뒤로"(이 노트를 링크하는 노트 = 백링크). 같은 root 에서 시작해 BFS 방향만 반대.
- **백링크 트리의 존재 이유**: "2026년" 같은 키워드 노트는 본문에 다른 노트로의 링크가 없어도
  다른 노트들이 그 키워드를 참조함. forward 트리만으로는 그 그룹을 못 모은다. 백링크가
  그 그래프를 끌어옴.
- **단일 `excludedGuids` Set 이 양쪽을 통제** — 한쪽 트리에서 체크 해제하면 양쪽에서 사라지고
  PDF 본문 안 그 노트로의 링크는 plain text 로 떨어진다. "복원" 버튼으로 되돌림.
- **루트는 제외 불가** (`if (guid === rootGuid) return` in `toggleGuid`).
- **트리 노드 `positionKey` 에 방향 prefix** (`forward:` / `backward:`) — 같은 guid 가 두 트리에
  떠도 Svelte `{#each}` 키 충돌 없음.

## BFS / 인접 / 본문 출력

`pdfBundle.ts::traverseBundle`:

1. **인접 행렬은 XML regex 로 한 번에 빌드** — `extractLinkTargets`(backlinkIndex 와 같은 regex)
   로 `forwardAdj`(guid → [target guids]) 와 `backwardAdj`(guid → [source guids]) 를 동시에 채운다.
   JSON 디시리얼라이즈 비용 안 듦.
2. **양방향 BFS 따로**, 각자 `forwardVisited` / `backwardVisited` 채움. depth 0..5, 사이클은
   `enqueued` Set, 제외 노트는 큐 진입 자체에서 빠짐.
3. **PDF 본문 출력 순서 = forward ordered ∪ backward ordered 신규분** (`visited` Set 으로 dedup).
   루트는 forward[0] 으로 한 번만.
4. **내부 링크 해상**: `resolver.resolveInternalTarget` 는 `visited`(union) 으로 판정 — 백링크
   경로로 들어온 노트로의 forward 링크도 PDF 안 점프 링크로 살아남는다.

## 본문 직조 (`tiptapToPdfmake`)

- **`stripLeadingTitleParagraph(doc, title)`** — Tomboy 컨벤션상 `<note-content>` 첫 줄 = 제목.
  PDF 헤더가 별도로 들어가므로 본문에서는 그 paragraph 만 제거(plain text 비교, mark 영향 없음).
- **차트 치환**: `chartReplaceMaps(body, chartImages)` 가 `body`(strip 후) 에서 다시 `findJsonChartRegions`
  실행해 i 번째 checked region 을 i 번째 rendered ChartImage 와 짝지음. 인덱스 시프트 안전성은
  "잘리는 첫 paragraph 는 Chart 헤더가 될 수 없다" 로 보장.
- **이미지**: paragraph 안 이미지 URL(`https?://…\.(png|jpg|jpeg|gif|webp)`) 을 텍스트에서 잘라
  별도 `{image, width, margin}` 블록 emit. `imageMap.get(originalUrl)` 키는 사용자가 본문에
  적은 형태 그대로(`toDirectImageUrl` 정규화 전). list-item paragraph 는 이미지 split 안 함
  (구조 호환성).

## 이미지 / 차트 비동기 수집

- **이미지** (`collectImageMap`): 본문에서 URL 모음 → `fetchImagesForBundle` 가 `imageCache.lookupOrFetch(toDirectImageUrl(url))` → `getBlob` → `blobToDataUri`. 실패는 조용히 드롭(키 없으면 URL 텍스트로 폴백).
- **차트** (`collectChartImages`): checked Chart 블록만 → `renderChartsToImages` 가 hidden div(`position:fixed; left:-99999px`) 에 `mountChart` → 1 RAF → `canvas.toDataURL('image/png')`. 출력은 `Map<guid, Array<ChartImage | null>>` (checked region 순서).
- **차트 애니메이션은 PDF 캡처 시점에만 꺼야 한다** — `buildChartConfig` 는 라이브 편집기용이라
  애니메이션 유지. `renderChartsToImages.renderOne` 에서 `{...config, options:{...,animation:false,
  animations:{colors:false,x:false,y:false}, transitions:{active:{animation:{duration:0}}}}}` 로 오버라이드.
  안 끄면 라인 차트가 baseline(y=0) 에 깔린 1프레임이 박힘.

## 한글 폰트

- `koreanFont.ts::loadKoreanFonts` — NanumGothic (OFL). `static/fonts/` 에서 fetch → IDB 캐시 후
  pdfmake `vfs` 에 등록. `registerKoreanFontFamily` 가 `defaultStyle.font='Korean'` 매칭.
- `npm run prefetch:fonts` 가 빌드 시 폰트 받음. 클라이언트는 첫 송출 때 한 번만 네트워크.

## 클라이언트 → 브릿지 프로토콜

`POST /remarkable/send-pdf` (Bearer + JSON):

```json
{ "alias": "myrm", "folderName": "Inbox", "folderUuid": "...", "visibleName": "노트 제목", "pdfBase64": "..." }
```

응답: SSE — `event: status` (`{step:'folder_lookup'|'ssh_write'|'xochitl_reload', message?}`) → `event: done` 또는 `event: error` (`{kind:SendRemarkableErrorKind, message}`).

오류 분류 (`SendRemarkableErrorKind`): `not_configured / unauthorized / unknown_alias / unknown_folder / remote_failure / network / internal`. 사용자 표시는 `SendToRemarkableModal.describeError`.

`visibleName` 결정 순서 (`sendNoteToRemarkable`): `opts.visibleName?.trim()` 이 비어 있지 않으면 그 값, 아니면 루트 노트 `title.trim()`, 그것도 비면 `"제목 없음"`. 모달은 prefill 시 루트 제목으로 채우되 입력 가능 — 리마커블에서 한글이 깨질 때 사용자가 ASCII 로 바꿔서 보내는 경로. 본문은 손대지 않고 `.metadata` 의 `visibleName` 만 교체된다.

## 브릿지 동작 (`bridge/src/remarkableSendPdf.ts`)

1. `remarkableHostsConfigured()` 검증 → SSH host 해석 (`remarkableHosts.ts`).
2. UUID 생성(`docUuid`) → `{uuid}.pdf` + `{uuid}.metadata` + `{uuid}.content` JSON 페이로드 준비.
3. **한 SSH 세션** 으로 `/home/root/.local/share/remarkable/xochitl/` 에 셋 다 떨굼 (`runSshWithStdin` 으로 stdin → `cat > file` 셋).
4. `systemctl restart xochitl` — 실패해도 PDF 는 이미 들어갔으므로 `done` 처리하고 stderr 경고만 (다음 reboot 에 자동 표시).

## 불변식

- **모달 backdrop / dialog 둘 다 `use:portal` 로 `<body>` 마운트** — NoteWindow(`.note-window`)
  의 stacking context 를 벗어나야 `--z-modal` 토큰이 문서 루트에서 평가된다. 그래야 backdrop
  이 화면 전체를 가리고(블러 포함) 다른 창들 위로 띄워진다. CLAUDE.md "z-index 레이어 규약"
  의 "portaled/`appendChild`'d to `<body>`" 조건을 만족시키는 형태. 포털 빼면 모달이 자기 창
  안에만 갇혀 노트 뒤에 깔린 것처럼 보임.
- **`includedGuids` = forward ∪ backward, dedup, forward 우선 순서.** 결과 PDF 안 노트 순서와
  `sendNoteToRemarkable` 가 반환하는 결과의 순서가 같음. 토스트 카운트도 이 값.
- **`titleToGuid` 충돌 해결은 `changeDate` 최신 우선** — 제목 중복은 앱 전체에서 막혀 있어야
  하지만 직접 IDB 편집/오래된 동기화 잔재 등 비상시를 위해 latest-wins.
- **broken 마크도 백링크에 합산** — `<link:broken>X</link:broken>` 가 있는 노트는 X 가 존재하면
  X 의 백링크로 보임. backlinkIndex 와 동일한 의미(stale broken 마크가 떠 있는 것은 의도된
  reference 로 해석).
- **이미지 캐시 키는 `toDirectImageUrl(url)` 정확값** — 쿼리 reorder 등 정규화 금지 (editor 와
  byte-identical 해야 캐시 hit). `tomboy-imagecache` 참고.
- **Vercel Blob 이미지도 같은 imageCache 경로** 로 picks up — `lookupOrFetch` 의 plain fetch
  폴백이 CORS-open Vercel 호스트 처리. Dropbox 는 `dropboxFetcher` 가 SDK 우회 (CORS 차단 회피).
- **차트 DATA 노트가 같은 IDB 안에 있어야** 차트 렌더 가능 — 없는 노트의 차트는 null 반환, 본문은
  원본 paragraph + config list 가 그대로 남음 (fail-open).
- **모달은 단일 entry — `previewPdfBundle`** (동기, 부수효과 0) 이 depth/excludedGuids 바뀔
  때마다 재계산. **`buildPdfBundle` 은 async** (이미지/차트 fetch 동반). `sendNoteToRemarkable`
  만 후자를 호출.

## 데스크탑 vs 모바일

- 컨텍스트 메뉴 항목은 `EditorContextMenu` 의 `enableContextMenu` prop — `NoteWindow` 에서만 켜져
  있고 `/note/[id]` 모바일 라우트는 꺼져 있음. 송출 기능 진입점 자체가 데스크탑 전용.
- 모달 너비 880px 도 데스크탑 가정. 모바일에서 띄울 일이 있으면 좌우 트리 stack 필요.

## 테스트

- `app/tests/unit/remarkable/pdf/pdfBundle.test.ts` — BFS / 트리 / forwardTree / backwardTree /
  excludedGuids / 본문 직조 / 차트 인덱스 정합성.
- `app/tests/unit/remarkable/pdf/{extractImageUrls,tiptapToPdfmakeImages,…}.test.ts`.
- `bridge/src/remarkableSendPdf.test.ts` — SSE 프레이밍 / SSH 세션 직조.
- 한글 폰트 / 실제 PDF 바이트 검증은 없음 — 폰트 vfs 등록 자체가 동적이고 pdfmake 출력은 결정적이지만 binary diff 어렵다. dev 에서 수동 확인.

## 관련 skills

- `tomboy-imagecache` — 본문 이미지 → PNG/JPEG data URI 변환 경로
- `tomboy-backlinkindex` — `extractLinkTargets` 의 src, 인덱스 무효화 모델
- `tomboy-graph` — `extractInternalLinkTargets` (JSON 기반 forward 링크 추출, pdfBundle 은 더
  이상 직접 사용 안 함 — XML regex 로 통합)
- `tomboy-diary` — reMarkable OCR 파이프라인 (완전 별개; 송출이 아니라 수입)
