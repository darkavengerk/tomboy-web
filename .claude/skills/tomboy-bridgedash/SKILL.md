---
name: tomboy-bridgedash
description: 브릿지:: 노트 — ⟳ 갱신 시 브릿지(Pi) GET /status 집계를 받아 시스템/서비스/파일/연결 대시보드를 본문에 스냅샷 렌더
---

# tomboy-bridgedash

`브릿지::` 대시보드 노트. ⟳ → 브릿지 `GET /status` 집계 → 제목 아래 본문을 통째로
다시 그린다(스냅샷 교체). 디스크/메모리/CPU 온도 + 다운스트림 서비스 도달성 + 파일
저장소 + 활성 연결을 `---` 구분 섹션 + ```csv 표로 표시.

## 경로
- 앱: `app/src/lib/bridgeStatus/{parseBridgeNote,statusClient,buildBridgeDashboard,writeBridgeDashboard}.ts`,
  `app/src/lib/editor/bridgeNote/{bridgeNotePlugin,runBridgeButtonClick,index}.ts`
- 브릿지: `bridge/src/status.ts` (`GET /status` 집계), `server.ts` 라우트 등록
  + 카운트 게터: `hosts.ts:wolHostCount`, `sshHosts.ts:sshHostCount`,
  `remarkableHosts.ts:remarkableHostCount`, `remarkableFolders.ts:remarkableFoldersCacheSize`

## 흐름
```
runBridgeButtonClick(view)
 └─ fetchBridgeStatus()                    (app statusClient.ts) → GET /status (Bearer)
     └─ bridge handleStatus → buildStatus  (status.ts)
         ├─ system: os.uptime/loadavg/mem + /sys/class/thermal (CPU 온도)
         ├─ disks:  statfsSync(BRIDGE_FILES_DIR) + statfsSync('/')
         ├─ services: 각 다운스트림 GET 프로브(응답=up / throw=down / 빈 URL=unconfigured)
         ├─ files:  BRIDGE_FILES_DIR 의 UUID 디렉터리 개수·총용량·최근 mtime
         └─ connections: SpectatorHubRegistry.size() + 호스트/캐시 카운트
 └─ writeBridgeDashboard(view, status)     → 제목 뒤 ~ 문서끝 replaceWith(대시보드 노드)
```

## 표시 형식 (buildBridgeDashboard.ts)
- **섹션 구분 = `---` 한 줄.** 단락 텍스트 `---` 는 전 브라우저에서 가로 구분선으로
  렌더(hrSplit 데코, Firefox masonry 만 인터랙티브 — 그래도 안전한 폴백).
- **표 = ```csv 펜스 블록.** `tableBlock` 플러그인이 표로 렌더. 값에 쉼표 금지(포맷터가
  쉼표 없는 사이즈/지연 문자열만 생성).
- **섹션 헤더 = 굵은 단락(bold 마크).** heading 노드는 `.note` 라운드트립에서 단락으로
  납작해짐(아카이버가 heading 태그 미emit) → bold 마크라야 동기화 후에도 모양 유지.
- 5섹션: 🖥 시스템 / 🔌 서비스 / 🗂 파일 저장소 / 🛰 연결·구성 / ⚙ 브릿지.

## 불변식
- **스냅샷 교체.** 매 ⟳ 가 `replaceWith(first.nodeSize, doc.content.size, nodes)` 로 제목 아래
  본문 전체를 갈아끼움. 멱등 — 두 번 눌러도 한 벌. 제목은 절대 안 건드림.
- **프로브는 best-effort, 전체는 항상 200.** 서비스 하나 죽어도 `down` 으로 표시하고 계속.
  HTTP 응답이 오면(404 포함) `up`(도달 가능), throw/타임아웃이면 `down`, env URL 비면
  `unconfigured`. ocr 만 `auth:true`(브릿지 시크릿 재Bearer), 나머지는 무인증 베이스 프로브.
- **status.ts 는 싱글톤을 직접 import.** `SpectatorHubRegistry` + 호스트 카운트 게터를
  모듈에서 바로 읽으므로 server.ts 는 라우트 등록 + config(시크릿/디렉터리/포트/서비스목록)만
  넘김. 인메모리 상태를 server.ts 가 따로 스레딩하지 않는다.
- **디스크는 컨테이너 뷰.** `statfsSync` 가 podman 컨테이너 파일시스템 기준. `/files` =
  업로드 볼륨(누적분, 중요), `/(루트)` = 컨테이너 fs. 호스트 전체 디스크는 안 보임.
- **방어적 빌더.** `buildBridgeDashboardNodes` 는 필드 누락/형식 오류에 throw 안 함(폴백 값).
- **시스템 오류 토스트만.** not_configured/unauthorized/service_unavailable/network 는 토스트 띄우고
  본문 미변경(기존 대시보드 유지).

## 배포 함정
- **신규 라우트 = 브릿지 재배포 필요** — `GET /status` 는 `bridge/` 빌드+Pi 재배포 후 활성.
  music-service 같은 데스크탑 서비스 변경은 없음(status.ts 는 그 서비스들을 프로브만 함).
- `AbortSignal.timeout` / `statfsSync` 는 Node 18.15+/17.3+ 필요 — 브릿지는 node:22 컨테이너라 OK.
- 프로브 대상 URL 은 server.ts 의 기존 env 상수 재사용. `RAG_SEARCH_URL` 만 status 용으로
  server.ts 에 추가(rag.ts 기본값과 동일하게 정렬).
