# 앱에서 리마커블 OCR 프롬프트·폴더 편집

**Date:** 2026-06-20
**Status:** Approved (design)
**Area:** reMarkable diary OCR pipeline (`pipeline/`) + 앱 설정 (`app/src/routes/settings/`) + 데스크탑 트리거 서버

## 문제

클로드(claude-service) 경유로 리마커블 문서를 OCR할 때, OCR 프롬프트와
폴더 라우팅 설정이 데스크탑 파일에만 존재해 앱에서 확인·편집할 수 없다.
사용자는:

1. 앱(설정 → 리마커블 탭)에서 **OCR 프롬프트를 확인·편집**하고 싶다.
2. 현재 읽어오는 **3개 폴더(Diary/Notes/Slip-Notes)를 확인·편집**하고
   추가할 수 있길 원한다.
3. 저장하면 **데스크탑에 자동 반영**되길 원한다.
4. 프롬프트는 **폴더별로 각각 지정** (폴더마다 쓰임이 다름).

## 저장 위치 판단 — 브릿지가 아니라 데스크탑

사용자가 "브릿지에 저장하는 게 맞나?"라고 물음. 답: **아니다.**

- **Pi 브릿지는 무상태 릴레이**다. inbox 파일을 데스크탑으로 넘기고
  WS/SSH를 프록시할 뿐, OCR을 실행하지 않으며 프롬프트/라우팅 설정을
  보관하지 않는다. (브릿지의 `remarkableFolders.ts`는 노트→리마커블 PDF
  송출용 폴더 조회로 **다른 기능**이다.)
- **OCR은 데스크탑에서 실행**된다. Claude 백엔드
  (`pipeline/desktop/ocr_backends/claude.py`)는 시스템 프롬프트를
  데스크탑 로컬 파일(`config/prompts/diary-ko.txt`)에서 읽고, 폴더
  라우팅은 데스크탑 `pipeline.yaml`의 `tomboy.folders`에 있다.
- **데스크탑에는 이미 앱과 연결된 엔드포인트가 있다**: diary-trigger
  서버(`trigger_server.py`, 포트 8765). Bearer 인증 + CORS 완비, 파이프라인
  루트를 cwd로 실행(→ `config/` 읽기/쓰기 가능), 앱이 이미 URL+토큰을
  저장(`diaryTriggerUrl`/`diaryTriggerToken`, `/admin/remarkable`에서 사용).

→ **데스크탑 trigger 서버에 config 읽기/쓰기 엔드포인트를 추가**해
OCR이 실제로 소비하는 위치에서 설정을 직접 관리한다.

## 폴더 편집 범위 — 데스크탑 라우팅만

"어떤 폴더를 OCR하느냐"는 사실 **두 곳**에 산다:

1. **데스크탑 라우팅** (`tomboy.folders`): 폴더 → 노트북/제목형식/분할/라벨.
   → 앱에서 완전히 편집 가능.
2. **태블릿 푸시 목록** (`diary-push.sh`의 `TARGET_FOLDERS`): rM 태블릿이
   실제로 Pi에 **푸시**하는 폴더. **태블릿에 있고** 데스크탑은 태블릿을
   건드리지 않는다(rM→Pi→데스크탑 단방향).

**결정: 앱은 데스크탑 라우팅만 편집한다.** 완전히 새 폴더를 추가하면
태블릿 `diary-push.sh`의 `TARGET_FOLDERS`도 수동으로 고쳐야 페이지가
들어온다 — 앱이 이 사실을 고정 안내문으로 표시한다.

## 프롬프트 모델 — 폴더당 프롬프트 1개 + 공용 기본값

- 폴더마다 프롬프트 텍스트 1개(= 시스템 프롬프트).
- 커스터마이즈하지 않은 폴더는 공용 **기본 프롬프트**로 폴백.
- 이미지별 지시줄(`_USER_PROMPT`, `claude.py` 하드코딩)은 **고정 유지**.
- 프롬프트는 백엔드 무관(claude/local_vlm 둘 다 동일하게 적용).

## 설계

### 1. 앱 관리 오버레이 파일 — `pipeline/config/folders.yaml`

신규 파일(gitignored, 데스크탑), 앱이 전적으로 소유:

```yaml
default_prompt: "<기본 OCR 프롬프트>"
folders:
  Diary:
    notebook: "일기"
    title_format: "{date} 리마커블([{unit_key}])"
    split: false
    prompt: ""
  Notes:
    notebook: "기록"
    title_format: "{date} 리마커블([{unit_key}])"
    split: false
    prompt: "<노트용 프롬프트>"
  Slip-Notes:
    notebook: "[0] Slip-Box"
    title_format: "{datetime} 리마커블 {label}([{unit_key}])"
    split: true
    labels: ["上", "下"]
    prompt: "<슬립용 프롬프트>"
```

별도 파일을 쓰는 이유 (pipeline.yaml 직접 수정 안 함):

- **시크릿 덮어쓰기 위험 제거** — `pipeline.yaml`은 `firebase_uid`,
  service-account 경로, 토큰을 보유. 앱은 절대 건드리지 않는다.
- **주석 손실 없음** — `yaml.safe_dump`은 bootstrap이 생성한 설명 주석을
  날린다. 앱 파일에는 보존할 주석이 없다.
- `config.py`는 `pipeline.yaml`을 기존대로 로드한 뒤 `folders.yaml`이
  있으면 **오버레이**한다. 파일 부재 = 현재 동작 그대로.

**오버레이 우선순위** (높은 쪽 우선):
`folders.yaml` > `pipeline.yaml`의 `tomboy.folders`(레거시) > `DEFAULT_FOLDER_ROUTES`.
즉 `folders.yaml`은 폴더별로 부분 오버라이드하며, 명시 안 한 폴더는 하위
계층의 값을 유지한다. `default_prompt`도 같은 식 — `folders.yaml`에 있으면
우선, 없으면 §2의 파일 폴백.

### 2. 프롬프트 해석 (페이지별, s3에서)

`s3_ocr.run_ocr`는 이미 `prepared.json`을 순회하며, 각 레코드는
`source_folder`를 보유(s2가 기록, 확인됨). 페이지마다 다음 순서로 해석:

1. `folders.<name>.prompt` (인라인, 비어있지 않으면)
2. `default_prompt` (folders.yaml)
3. 기존 `system_prompt_path` 파일 내용 (최종 폴백 — 현재 동작)

해석된 프롬프트를 백엔드로 전달: `OCRBackend.ocr(image_path,
system_prompt=resolved)`.

- `OCRBackend` ABC의 `ocr()`에 선택 인자 `system_prompt: str | None = None`
  추가.
- `claude.py`: 주어지면 `self._system` 대신 사용. `prompt_hash`는 실제
  사용 프롬프트로 계산.
- `local_vlm.py`: 주어지면 `_run_inference(image_path, system_prompt)`로
  전달.
- `None`이면 생성자 기본값 사용 → **완전 하위호환**.

이미지별 지시줄(`_USER_PROMPT`)은 변경 없음.

### 3. 트리거 서버 — 신규 엔드포인트 2개 (`trigger_server.py`)

기존 Bearer 인증 + CORS(앱과 이미 연결됨) 재사용:

- **`GET /config`** (Bearer) → `{ defaultPrompt, folders: [{name, notebook,
  titleFormat, split, labels, prompt}] }`. **효과 값(effective)**을 반환한다 —
  `config.py`가 해석한 최종 `TomboyConfig`(= §1 오버레이 우선순위 적용
  결과)를 그대로 직렬화하므로, `folders.yaml`이 없어도 `pipeline.yaml`
  레거시 + `DEFAULT_FOLDER_ROUTES` + 기본 프롬프트 파일 값을 보여준다.
- **`PUT /config`** (Bearer) → 검증 후 `folders.yaml`을 **원자적으로**
  기록(temp 파일 + `os.replace`). `pipeline.yaml`은 절대 건드리지 않는다.

검증:

- 타입 검사(notebook/prompt/title_format은 str, split은 bool, labels는
  str 배열).
- `title_format`은 알려진 플레이스홀더만 허용: `{date}`, `{datetime}`,
  `{unit_key}`, `{page_uuid}`, `{label}`. 그 외 `{...}`는 거부(잘못된
  포맷 → s4 크래시 방지).
- prompt 텍스트는 불활성 데이터(LLM 입력) — 실행되지 않음.

### 4. 앱 UI — 설정 → 리마커블 탭

`RemarkableSendSettings` 아래 신규 섹션 "**일기 OCR 파이프라인 설정**":

- 기존 `diaryTriggerUrl` / `diaryTriggerToken` 재사용(신규 시크릿 없음).
  미설정/연결 불가 시 `/admin/remarkable`과 동일한 안내 패턴.
- 열 때: `GET /config` → **기본 프롬프트** textarea + 폴더당 카드 렌더
  (notebook, title format, split 토글, labels, **prompt** textarea).
- **폴더 추가** 버튼 → 새 폴더 카드. 고정 안내문 표시: *"새 폴더는 태블릿
  `diary-push.sh`의 `TARGET_FOLDERS`에도 추가해야 페이지가 들어옵니다"*.
- **저장** → `PUT /config` → 성공/실패 토스트.
- 반응형 바 규약은 이 섹션엔 비적용(설정 본문 카드, TopNav/필터바 아님).

### 5. 가이드 카드

저장소 불변식(사용자 기능 → 설정 → 가이드)에 따라, 프롬프트/폴더 편집을
설명하는 `<details class="guide-card">`를 `env`(또는 `notes`) 서브탭에
추가.

### 6. 테스트

파이프라인:

- `config.py`: `folders.yaml` 오버레이 + `prompt`/`default_prompt` 파싱;
  파일 부재 시 현재 동작.
- `s3_ocr`: 폴더별 프롬프트 해석(인라인 > default > 파일) + `ocr(system_prompt=)`
  오버라이드 전달.
- `claude.py` / `local_vlm.py`: `system_prompt` 인자 존중, 미지정 시 기본값.
- 트리거 `GET/PUT /config`: 검증, 원자적 쓰기, `pipeline.yaml` 불변,
  플레이스홀더 거부.

앱:

- 설정 섹션 로드/저장 (fetch 목).

### 7. 범위 밖 (YAGNI)

- 태블릿 푸시 목록(`TARGET_FOLDERS`) 편집.
- 백엔드/모델/effort 전환.
- 이미지별 지시줄(`_USER_PROMPT`) 편집.

## 영향 받는 파일

신규:

- `pipeline/config/folders.yaml` (gitignored, 런타임 생성)
- 앱 설정 섹션 컴포넌트 (예: `app/src/lib/remarkable/DiaryOcrSettings.svelte`)
- `app/src/lib/storage/appSettings.ts`의 trigger config getter 재사용
  (또는 신규 client 래퍼)

수정:

- `pipeline/desktop/lib/config.py` — `FolderRoute.prompt`, `TomboyConfig.default_prompt`,
  `folders.yaml` 오버레이 로더.
- `pipeline/desktop/stages/s3_ocr.py` — 폴더별 프롬프트 해석 + 전달.
- `pipeline/desktop/ocr_backends/base.py` — `ocr(system_prompt=None)`.
- `pipeline/desktop/ocr_backends/claude.py` — 인자 존중.
- `pipeline/desktop/ocr_backends/local_vlm.py` — 인자 존중.
- `pipeline/desktop/trigger_server.py` — `GET/PUT /config`.
- `app/src/routes/settings/+page.svelte` — 리마커블 탭에 섹션 + 가이드 카드.
- `.gitignore` — `pipeline/config/folders.yaml`.
- 관련 테스트 파일들.
