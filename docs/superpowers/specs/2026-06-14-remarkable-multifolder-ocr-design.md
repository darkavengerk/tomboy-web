# reMarkable 다중 폴더 OCR + 슬립노트 분할 + 이미지 폐지 설계

날짜: 2026-06-14
대상: `pipeline/` (reMarkable 일기 OCR 파이프라인) + 일부 앱 어드민

## 1. 배경

현재 파이프라인은 reMarkable의 **"Diary" 폴더 한 곳**만 수집한다. rM 푸시 스크립트(`diary-push.sh`, 기기 상주·`pipeline/pi/README.md`가 정본)가 `CollectionType` + `visibleName == "Diary"` 폴더를 찾아 그 자식 `DocumentType` 노트북의 페이지 `.rm`을 평탄하게 Pi inbox로 푸시한다. 데스크탑은 s1(fetch)→s2(render PNG)→s3(OCR)→s4(Firestore 쓰기)로 흐르며 **page-uuid를 단일 키(I1)** 로 쓴다. s4는 PNG를 Dropbox에 올리고 본문에 `<link:url>` 이미지 링크를 넣는다.

기존 스펙: `docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`. 운영 불변식은 `tomboy-diary` 스킬에 정리돼 있다.

## 2. 목표 / 비목표

**목표**
1. 수집 대상을 **Diary + Notes + Slip-Notes** 세 폴더로 확장.
2. **Slip-Notes는 페이지당 카드 2장** — 렌더된 PNG를 위/아래로 나눠 각 절반을 별도 OCR → 별도 노트로 저장.
3. **이미지 저장 폐지** — Dropbox 업로드와 본문 `<link:url>`을 모든 폴더에서 제거. 본문은 OCR 텍스트만. (검수는 사용자가 rM 원본을 직접 보며 함)

**비목표**
- 슬립노트 인덱스 체인 자동 연결(이전:/다음: 링크 자동 배선)은 하지 않는다 — 스켈레톤만 생성하고 사용자가 수동 연결.
- 인라인 이미지 렌더(앱 본문에 그림 표시)는 여전히 비목표.
- 콘텐츠 인식 기반의 카드 자동 식별(개수 가변)은 하지 않는다 — 슬립은 항상 위/아래 2장 가정.

## 3. 확정 결정 요약

| rM 폴더 | 분할 | Tomboy 노트북 | 제목 형식 | 본문 형식 |
|---|---|---|---|---|
| Diary | 아니오 | `일기` | `{date} 리마커블([{unit_key}])` | `{title}\n\n{ocr}` |
| Notes | 아니오 | `기록` | `{date} 리마커블([{unit_key}])` | `{title}\n\n{ocr}` |
| Slip-Notes | 위/아래 절반 | `[0] Slip-Box` | `{datetime} 리마커블 {label}([{unit_key}])` | 슬립 스켈레톤(아래) |

- `{date}` = `yyyy-mm-dd`, `{datetime}` = `yyyy-mm-dd HH:mm`(rM `lastModified` 기준), `{label}` = `上`/`下`.
- 슬립 본문 스켈레톤:
  ```
  {title}

  이전: 없음
  다음: 없음

  {ocr}
  ```
  역직렬화 시 블록 `[0]제목 [1]공백 [2]"이전: 없음" [3]"다음: 없음" [4]공백 [5+]본문` → 앱 `validateSlipNoteFormat` 레이아웃과 정확히 일치. 제목이 `yyyy-mm-dd HH:mm …` 형태라 `isSlipNoteTitle`이 슬립노트로 인식.
- 이미지 없음(모든 폴더). 본문에 `---`/`<link:url>` 없음.
- **텍스트 미검출(공백) 반쪽/페이지는 노트 생성을 건너뛴다**(로그 남김).

## 4. 아키텍처 변경

### 4.1 작업단위 키(unit key) 모델 — I1 일반화

page-uuid 단일 키를 **작업단위 키**로 일반화한다.

- 비분할 페이지: `<page-uuid>` (기존과 동일 — Diary/Notes의 기존 매핑·키 그대로 호환).
- 분할(슬립) 페이지: `<page-uuid>#0`(위) / `<page-uuid>#1`(아래).

이 키가 `prepared.json`·`ocr-done.json`·`written.json`·`mappings.json` 상태와 **제목 마커 `[unit_key]`** 의 단위가 된다.

신규 `pipeline/desktop/lib/keys.py`:
- `unit_keys_for_page(page_uuid: str, split: bool) -> list[str]` → `[uuid]` 또는 `[uuid#0, uuid#1]`
- `page_uuid_of(unit_key: str) -> str` → `#` 앞부분
- `half_index_of(unit_key: str) -> int | None` → `0`/`1`/`None`

Firestore 문서 ID는 여전히 새 `uuid4`(`_resolve_target_guid`)라 `#`가 들어가지 않는다. `#`는 로컬 상태 키·로컬 파일명·제목 마커에만 등장하며 Linux 파일명에서 무해.

### 4.2 rM 푸시 스크립트 (`pipeline/pi/README.md` 정본 갱신)

단일 Diary 스캔을 폴더 루프로 교체.

- `TARGET_FOLDERS="Diary Notes Slip-Notes"` 각각에 대해: `CollectionType` + `visibleName == <folder>` UUID를 찾고, 그 자식 `DocumentType` 노트북(`.content`의 `fileType:"pdf"` 제외) 페이지를 스테이징.
- 합성 metadata 스텁에 **`"sourceFolder": "<folder>"`** 추가. `visibleName`도 해당 폴더명으로 채움(기존 호환).
- page-uuid는 전역 유일 → 폴더가 늘어도 평탄 inbox에서 충돌 없음. Pi watcher/inbox 레이아웃 무변경.

### 4.3 Config 폴더 라우팅 (`config.py` + example yaml + `bootstrap.py`)

`TomboyConfig`에 폴더 라우팅 맵 도입.

```yaml
tomboy:
  folders:
    Diary:       { notebook: "일기",        title_format: "{date} 리마커블([{unit_key}])",            split: false }
    Notes:       { notebook: "기록",        title_format: "{date} 리마커블([{unit_key}])",            split: false }
    Slip-Notes:  { notebook: "[0] Slip-Box", title_format: "{datetime} 리마커블 {label}([{unit_key}])", split: true, labels: ["上", "下"] }
```

- 코드에 **기본 라우팅(DEFAULT_FOLDER_ROUTING)** 내장 → 위 3폴더는 config 없이도 명세대로 동작. config는 오버라이드용.
- 미지의 `sourceFolder`는 기본 라우트(Notes류: 분할 없음, 노트북 `기록`)로 폴백.
- **하위호환**: `tomboy.folders`가 없고 레거시 `tomboy.diary_notebook_name`/`title_format`만 있으면 → Diary 엔트리를 거기서 합성하고 Notes/Slip-Notes는 코드 기본값 사용.
- `folder_route(source_folder) -> FolderRoute` 접근자 제공.
- `dropbox_refresh_token`/`dropbox_app_key`를 **선택값으로 강등**(이미지 폐지로 더 이상 필수 아님). bootstrap의 Dropbox PKCE 단계는 건너뛸 수 있게.

`{page_uuid}` 플레이스홀더는 별칭으로 계속 지원(비분할에서 `unit_key == page_uuid`).

### 4.4 s2_prepare — 렌더 + 분할

- 각 `raw/<uuid>/`의 metadata에서 `sourceFolder` → `route.split` 결정.
- **skip 가드**: 그 페이지의 `unit_keys_for_page`가 prepared에 **모두** 있으면 skip.
- **force/rerun/--uuid**: 들어온 키를 `page_uuid_of`로 환원해 그 페이지의 모든 단위 키를 prepared에서 제거 후 재렌더.
- 전체 PNG 1회 렌더(기존 `RmsceneRenderer`). 분할이면:
  - **컷 타깃 = 물리 화면 중앙 행 `PAGE_HEIGHT // 2`(=936).** `canvas_h`는 `max(PAGE_HEIGHT, …)` 바닥 덕분에 비스크롤 페이지는 항상 1872 → 컷이 정확히 화면 중앙. 아래/위 공백은 캔버스 크기에 영향 없음(원점이 화면 상단).
  - 타깃 ±검색창(`SPLIT_GAP_SEARCH`, 기본 240px) 내에서 **가장 긴 빈 가로 띠**의 행을 찾아 거기서 컷(두 카드 사이 틈/구분선에 스냅, 글자 줄 가르기 방지). 빈 띠 없으면 타깃 행 폴백.
  - 위 절반 → `png/<uuid>/page.0.png`(`#0`), 아래 절반 → `page.1.png`(`#1`). 각 prepared 엔트리에 `png_path`, `half_index`, `source_folder`, `metadata` 기록.
  - **스크롤 가드**: `canvas_h > PAGE_HEIGHT`(의도치 않은 스크롤)면 경고 로그 — 그 페이지 분할은 수동 확인 필요 신호.
- 비분할이면 기존대로 `png/<uuid>/page.png`(`<uuid>`) 1개 + `source_folder` 기록.
- **빈 가로 띠 탐색은 순수 Pillow 헬퍼 `pipeline/desktop/lib/raster.py`로 추출**(`find_blank_row_near(image, target, search) -> int`). `local_vlm._ink_row_mask`/타일 컷 로직도 이 헬퍼를 공유하도록 리팩터(중복 제거, s2가 torch를 끌어오지 않게 — 헬퍼는 Pillow만 의존).

### 4.5 s3_ocr — 로직 무변경

- `prepared.json`을 키 단위로 순회(이미 dict 키 기반) → 자동으로 복합 키 처리.
- OCR 결과 파일명 `ocr/<unit_key>.json` (`#` 포함, 무해).
- 슬립 반쪽이 비정상적으로 길면 기존 local_vlm 타일링이 그대로 처리.

### 4.6 s4_write + tomboy_payload — 이미지 제거 + 라우팅 + 슬립 스켈레톤 + 빈 건너뛰기

- **Dropbox 완전 제거**: `DropboxUploader` import/사용, `upload`/`share_link`, `image_url` 인자 모두 제거. `build_note_content_xml`에서 `---`+`<link:url>` 제거.
  - 일반 본문: `{title}\n\n{ocr}`
  - 슬립 본문: §3 스켈레톤.
- 각 단위 키별: `page_uuid_of` 환원 → prepared의 `source_folder` → `folder_route` 조회 → `route.notebook` 태그·`route.title_format`로 payload.
  - 제목 포맷 인자: `date`, `datetime`, `page_uuid`, `unit_key`, `label`(슬립은 `half_index`→labels[idx], 비분할은 빈 문자열).
- `mappings.json`·`written.json`·마커 모두 단위 키. `_resolve_target_guid`의 마커 체크는 `f"[{unit_key}]"`.
- **빈 텍스트 건너뛰기**: `ocr_data["text"].strip() == ""`이면 Firestore 쓰기·mappings/written 갱신 없이 `log.info("skipped_empty", key=...)` 후 continue. (다음 실행에서 cheap-skip; 사용자가 카드를 채우고 재OCR하면 mtime-bump 캐스케이드로 다시 처리됨.)
- `metadata_change_date=datetime.now()` 유지(I13 — 재OCR 시 app conflictResolver가 remote를 당기도록).
- 상태 미러(`pipeline_status`): `image_url`/`image_width`/`image_height`는 빈 값/생략, `page_uuid` 필드는 단위 키. 나머지(글자수·모델·재처리 플래그) 유지.

### 4.7 s1_fetch — 하위 캐스케이드

- 재페치(mtime bump)/`--force` 시 하위 상태(prepared/ocr-done/written) 제거 대상이 page-uuid와 `uuid#*` **둘 다**여야 함. `StateFile`에 `remove_page(page_uuid)`(키가 `uuid`이거나 `uuid#`로 시작하면 삭제) 추가하고 s1 캐스케이드·s2 force 환원에서 사용.

### 4.8 상태 미러 / `/admin/remarkable` (앱) — 경량 변경

- 썸네일은 사라짐(이미지 폐지) → 어드민이 빈 `imageUrl`을 안전 처리(이미지 칸 숨김/플레이스홀더). 사용자는 rM 원본으로 검수하므로 수용.
- 단위 키에 `#`가 포함될 수 있으니 표시만 허용. 재처리 요청 시 키를 page-uuid로 환원해 s2가 페이지 단위로 재렌더.
- 그 외 페이지 동작 무변경(글자수/모델/매핑/재처리).

## 5. 데이터 흐름 예시 (슬립 페이지)

```
rM "Slip-Notes" 폴더의 노트북 / 페이지 abcd.rm  (lastModified=2026-06-14 09:30)
  └ push: inbox/abcd.rm + abcd.metadata {sourceFolder:"Slip-Notes", lastModified:...}
s1: raw/abcd/ 로 pull (키=abcd)
s2: route.split=true → 전체 렌더(1404×1872) → 936 근처 빈 띠에서 컷
      png/abcd/page.0.png  → prepared["abcd#0"]
      png/abcd/page.1.png  → prepared["abcd#1"]
s3: ocr/abcd#0.json, ocr/abcd#1.json
s4: abcd#0 → guid g0, 노트북 "[0] Slip-Box",
       제목 "2026-06-14 09:30 리마커블 上([abcd#0])", 본문 슬립 스켈레톤
    abcd#1 → guid g1, "... 下([abcd#1])"
    (반쪽 OCR이 공백이면 그 반쪽은 건너뜀)
```

## 6. 불변식 (신규/변경)

- **I1′**: 작업단위 키(`uuid` | `uuid#half`)가 OCR/노트의 단위·상태 키·제목 마커. 비분할은 기존 page-uuid와 동일하므로 Diary/Notes 기존 매핑 호환.
- **분할은 물리 화면 중앙(`PAGE_HEIGHT//2`) 기준**, 빈 띠 스냅 + 폴백. `canvas_h > PAGE_HEIGHT`면 경고(스크롤). 캔버스 바닥(floor=1872)이 비스크롤 페이지의 중앙을 936으로 고정 → 공백이 중앙을 밀지 않음.
- **이미지 산출물 없음**(모든 폴더). 본문은 OCR 텍스트(+슬립 스켈레톤)만.
- **슬립 제목은 `yyyy-mm-dd HH:mm …`** 형태 — 앱 `isSlipNoteTitle` 인식 필수.
- **빈 OCR 단위는 노트 미생성**.
- I13(metadataChangeDate=now)·I4(uid sanitize)·mappings.json sacred 등 기존 불변식 유지.

## 7. 엣지 케이스

- page-uuid 전역 유일 → 폴더 간 키 충돌 없음.
- 두 슬립 반쪽: 같은 `lastModified`라 datetime 동일하지만 `label`(上/下)+마커로 제목 유일.
- 가필(기존 슬립 페이지 재작성): s1 mtime-bump → `remove_page`로 `uuid#0`/`uuid#1` 모두 클리어 → 재렌더·재OCR·재쓰기.
- 한쪽 카드만 작성: 빈 반쪽 OCR 공백 → 건너뜀. 나중에 채우면 mtime-bump로 재처리.
- 빈 띠가 검색창에 없음(중앙까지 글자 빽빽): 타깃 행(936)으로 폴백, 최악의 경우 한 줄이 양쪽에 분리될 수 있음(타일링과 동일한 트레이드오프).

## 8. 테스트

- `lib/keys`: `unit_keys_for_page`(split T/F), `page_uuid_of`, `half_index_of`.
- `lib/raster`: `find_blank_row_near` — 중앙 빈 띠에 스냅; 빈 띠 없으면 타깃 폴백.
- s2: 분할 폴더 → 복합 키 2개 + 두 PNG; 비분할 → 1개; **바닥 공백 큰 페이지도 canvas 1872 유지 → 컷 ~936**; `canvas_h>1872` 경고; force/skip이 page 단위로 동작.
- s1: `remove_page`가 `uuid#*`까지 캐스케이드.
- tomboy_payload: 본문에 `<link:url>`/`---` 없음; 일반 본문/슬립 스켈레톤; **슬립 제목이 앱 `isSlipNoteTitle` 정규식(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b`) 매칭**; 마커 `[unit_key]`.
- config: `folders` 맵 파싱 + 레거시 폴백 + 미지 폴더 기본 라우트; dropbox 키 선택값.
- s4: 폴더별 노트북 태그; 빈 OCR 건너뛰기; Dropbox 미사용; 슬립 create/change date.

기존 테스트 갱신: `test_tomboy_payload.py`(`<link:url>` 기대 제거), `test_s4_write.py`(dropbox fake 제거/라우팅), `test_s2_prepare.py`(분할), `test_config.py`(folders).

## 9. 마이그레이션 / 롤아웃

1. **config**: 기존 `pipeline.yaml`은 코드 기본 라우팅 덕분에 그대로도 3폴더 동작. 노트북명 커스터마이즈하려면 `tomboy.folders` 추가. (bootstrap은 새 스키마로 생성.)
2. **rM 스크립트 재배포**: README 정본의 새 다중 폴더 스크립트로 `/home/root/diary-push.sh` 교체(폴더 3개 생성/이름 확인). 기존 Diary 페이지는 page-uuid 동일 → 재푸시해도 노op 또는 재처리.
3. **기존 Diary 노트의 이미지 링크 제거(선택)**: 원하면 I13 복구 절차(`rm state/written.json` → s4 재실행)로 마커 보유 Diary 노트를 이미지 없는 본문으로 재발행(OCR 텍스트는 기존 것 재사용). 마커를 지운(=교정 완료) 노트는 보호되어 유지. 새/재OCR 페이지는 자동으로 이미지 없는 형식.
4. `dropbox_uploader.py`는 s4에서 미사용 → 데드코드. 즉시 삭제 또는 후속 정리(테스트 영향 최소화 위해 본 작업에선 s4 경로에서만 제거).

## 10. 보류 / 범위 외

- 슬립 인덱스 체인 자동 배선(이전:/다음:) — 수동.
- 가변 카드 수(2장 외) — 미지원.
- 콘텐츠 인식 카드 경계(상단 카드가 936 넘게 길 때 등) — 빈 띠 스냅으로 완화하되 근본 해결은 범위 외.
- 앱 어드민 썸네일 복원 — 이미지 폐지로 제거.
