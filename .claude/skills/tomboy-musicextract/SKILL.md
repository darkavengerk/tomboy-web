---
name: tomboy-musicextract
description: 음악추출:: 노트 — YouTube 영상을 데스크탑 yt-dlp로 mp3 추출, 브릿지 /files 저장, 멱등 채움
---

# tomboy-musicextract

`음악추출::` 작업대 노트. 영상 URL/검색어 리스트 → ⟳ → 데스크탑 yt-dlp → mp3 → 브릿지 `/files` →
결과 URL을 항목 자식에 기록. 재생은 `음악::` 노트로 수동 구성.

## 경로
- 앱: `app/src/lib/musicExtract/{parseExtractNote,extractClient,writeExtractResult}.ts`,
  `app/src/lib/editor/musicExtractNote/{musicExtractNotePlugin,runExtractButtonClick,index}.ts`
- 브릿지: `bridge/src/music.ts` (`/music/extract` relay)
- 데스크탑: `music-service/` (yt-dlp + Fastify `/extract`)

## 불변식
- **멱등 판정 = `/files/<uuid>/` URL 결과 자식의 유무.** 있으면 done(skip), 없으면(신규/실패)
  ⟳ 때 재시도. 실패는 `❌ …` 텍스트 자식이라 URL이 없어 자동 재시도된다.
- **저장·서빙은 기존 브릿지 `/files` 재사용** — Range·`audio/mpeg` MIME·무토큰(추측 불가 UUID)
  다운로드가 이미 있어 `<audio src>`로 직접 재생. 새 저장 코드 없음.
- **보안 경계는 automation보다 약하다** — 소스 문자열을 노트가 직접 보냄. `music-service`가
  shell 미경유 spawn + `resolveSource` allowlist(선두 `-`/비-http 스킴 거부, 검색어 `ytsearch1:`
  강제) + `--no-playlist`/`--no-exec`/`--max-filesize`/`--socket-timeout`/타임아웃으로 완화.
- **시스템 오류 시 중단** — not_configured/unauthorized/service_unavailable/network 는 한 항목에서
  나면 토스트만 띄우고 루프 중단(노트에 같은 에러 도배 방지). 항목별 오류(bad_request/upstream_error)만
  그 항목에 `❌` 기록하고 계속.
- **데스크탑 전용·개인용.** Vercel 함수 금지. 권리 보유 콘텐츠 전제.
- **항목별 동기**: 앱이 대기 항목을 하나씩 `extractOne` → `writeExtractResult`. 다운로드가 길어
  배치 대신 순차(진행 가시성 + 부분 실패 격리).

## 배포 함정
- `/home`→`/var/home` 심볼릭링크가 `import.meta.url` entry 가드를 깨뜨림 → `.service`의 node·dist
  경로는 canonical `/var/home/...`. fnm default alias node 절대경로. `loginctl enable-linger` 필수.
  (automation-service 동일.)
- 브릿지 `MUSIC_SERVICE_URL`, 서비스 `BRIDGE_FILES_URL`/`BRIDGE_SHARED_TOKEN` 정렬 필수.

스펙: `docs/superpowers/specs/2026-06-05-music-extract-design.md`
플랜: `docs/superpowers/plans/2026-06-05-music-extract.md`
