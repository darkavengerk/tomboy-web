# OCR + 번역 모델 분리 설계

작성일: 2026-05-15
워크트리/브랜치: `tigress`

## 1. 배경과 동기

현재 노트 앱에는 `ocr://<model>` 시그니처 노트가 있어 이미지를 붙여 넣으면
Qwen2.5-VL-7B 한 모델이 **OCR + 번역**을 한 호출에 처리한다
(`app/src/lib/ocrNote/`). 시스템 프롬프트가 `[원문]/[번역]` 형식을 강제하는
구조다.

이 단일 모델 접근의 한계:

- VRAM이 7B 비전 모델 한 개에 묶여 있어 더 가볍거나 더 좋은 모델로 자유롭게
  바꾸기 어렵다.
- OCR 정확도와 번역 품질의 사용처가 사실상 다르다. 사용자의 일반적인 사용
  맥락은 **영문 인쇄체 → 한국어** 번역이다. 손글씨가 아니라서 OCR 난이도가
  낮고, 번역 품질은 한국어 출력에 특화된 모델이 더 잘한다.

목표는 두 단계를 분리해 각각에 최적화된 모델을 두는 것이다:

- **OCR**: `stepfun-ai/GOT-OCR2_0` (`GOT-OCR2`, ~580M, FP16 ~1.2GB) — 영문
  인쇄체 정확도가 일반 VLM 대비 매우 우수하고 가볍다.
- **번역**: `exaone3.5:2.4b` (LG AI, Q4_K_M ~1.7GB) — 영→한 번역 품질이
  Ollama 호환 모델 중 가장 안정적이다.

## 2. 운영 환경 — **이 문서의 가장 중요한 전제**

지난 작업에서 머신 분리를 가정 못 해 잘못된 설계를 한 적이 있어 명시한다.

```
┌──────────────┐  HTTPS+Bearer   ┌─────────────────────┐  HTTP (LAN)   ┌─────────────────────────┐
│ Web app      │ ───────────────►│ Raspberry Pi        │ ─────────────►│ Desktop (RTX 3080 10GB) │
│ (TipTap +    │                 │ - term-bridge       │               │ - Ollama                │
│  ocrNote)    │                 │ - Caddy reverse     │               │   (EXAONE 외)           │
│              │                 │   proxy             │               │ - ocr-service           │
│              │                 │ - rootless Podman   │               │   (GOT-OCR2, FastAPI)   │
└──────────────┘                 │ + Quadlet           │               └─────────────────────────┘
                                 │                     │
                                 │ NO GPU.             │
                                 │ NO model hosting.   │
                                 └─────────────────────┘
```

핵심 invariant:

- **브릿지(Pi)는 GPU가 없다.** Pi에 모델을 호스팅하지 않는다. Pi의 역할은
  HTTPS 종단, Bearer 인증, SSH 터미널, 그리고 데스크탑 서비스로의 라우팅
  뿐이다.
- **모델은 데스크탑에만 있다.** Ollama, `ocr-service` 둘 다 동일 데스크탑의
  같은 RTX 3080 VRAM 풀(10GB)을 공유한다.
- 브릿지 → 데스크탑은 **LAN HTTP**(외부 노출 없음). 데스크탑 IP/포트는 브릿지
  환경변수 `OLLAMA_URL`, `OCR_SERVICE_URL` 로 주입한다.
- 데스크탑이 꺼져 있을 수 있으므로 브릿지는 모든 데스크탑 호출에 짧은 타임아웃
  + 명확한 에러(`ocr_service_unavailable`, `ollama_unavailable`)를 반환한다.

이 invariant는 `.claude/skills/tomboy-terminal/SKILL.md` 에도 동일하게
박는다 (현재 "rootless Podman + Quadlet" 라고만 적혀 있어 같은 머신 가정이
재발하기 쉽다).

## 3. 호출 흐름

```
[ocrNote 노트의 이미지 붙여넣기]
    │
    ▼
runOcrInEditor (web)
    │
    │ ① POST {bridge}/ocr  (image base64)
    ▼
bridge /ocr (Pi)  ──forward──►  ocr-service /ocr (desktop)
                                     │
                                     ▼
                                GOT-OCR2 추론 (~1초)
                                     │
                                     ▼
                                 응답: {"text": "..."}
    │
    │  에디터에 [원문] 블록 즉시 표시 + 스트리밍 표시
    │
    │ ② POST {bridge}/llm/chat  (원문 텍스트 + 번역 system prompt)
    ▼
bridge /llm/chat (Pi)  ──forward──►  Ollama /api/chat (desktop, EXAONE)
                                          │
                                          ▼
                                     스트리밍 응답: 번역 텍스트
    │
    │  에디터에 [번역] 블록 스트리밍 추가
    ▼
완료
```

OCR이 끝나야 번역이 시작되는 직렬 호출이다. 한 호출에 합치는 것은 불가능한데,
GOT-OCR2는 번역 능력이 없고 EXAONE은 vision 입력을 받지 못하기 때문이다.
UX 부수효과: 사용자는 **원문이 먼저 화면에 나타난 뒤 번역이 뒤이어 스트리밍**
되는 흐름을 보게 되며, 원문 정확도를 즉시 검증할 수 있어 오히려 개선이다.

**언어 분기 없음.** 사용자 사용 맥락이 항상 영→한이므로 OCR 결과가 한국어인지
검사하지 않는다. `target_lang` 헤더, 한국어 분기 프롬프트 모두 제거한다.

## 4. 컴포넌트 설계

### 4.1 `ocr-service` 컨테이너 (신규, 데스크탑)

Python FastAPI 단일 프로세스. GOT-OCR2 모델을 transformers로 로드.

엔드포인트:

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `POST /ocr` | multipart/form-data 또는 JSON(`{image_b64}`) | OCR 실행. 응답 `{"text": "..."}` 또는 SSE 스트림. |
| `GET /status` | — | `{loaded: bool, last_called_at: iso, vram_mb: number?}` |
| `POST /unload` | — | `model.cpu()` + `torch.cuda.empty_cache()`. in-flight 요청 있으면 423. |
| `GET /gpu/raw` | — | `nvidia-smi --query-gpu=...` 파싱 결과 JSON. 데스크탑에서 nvidia-smi 가용한 유일한 서비스라 여기서 노출. |
| `GET /healthz` | — | liveness. |

모델 로딩:

```python
AutoModel.from_pretrained(
    "stepfun-ai/GOT-OCR2_0",
    trust_remote_code=True,
    torch_dtype=torch.float16,
    device_map="cuda:0",
)
```

OCR 호출 모드는 `ocr_type='format'` — 마크다운 비슷한 구조 출력으로
일반 인쇄체에 최적.

**Idle auto-unload**: 환경변수 `OCR_IDLE_UNLOAD_S` (기본 300). 마지막
`/ocr` 호출 시각으로부터 그 시간 초과 시 `model.cpu()` + `empty_cache()`.
다음 호출 시 자동 재로드 (cold 호출은 ~3~5초 추가 지연, 사용자에 토스트로
"OCR 모델 로딩 중…" 안내).

인증: bridge와 같은 Bearer 토큰을 환경변수 `BRIDGE_SHARED_TOKEN` 으로
주입. 외부에 직접 노출 안 함 (방화벽으로 LAN에만 listen).

배포: Quadlet `.container` 파일을 `bridge/deploy/` 에 추가하지 않고
**데스크탑 측 별도 `ocr-service/deploy/`** 디렉토리에 둔다. 데스크탑은
Bazzite + rpm-ostree + Podman 이라 동일한 Quadlet 방식 사용 가능.

### 4.2 `bridge` 변경 (Pi)

신규 라우팅 (`bridge/src/server.ts` 등):

| 엔드포인트 | 동작 |
|---|---|
| `POST /ocr` | 요청 Bearer 검증 → `${OCR_SERVICE_URL}/ocr` 으로 프록시 (스트리밍이면 파이프). |
| `GET /gpu/status` | `${OCR_SERVICE_URL}/gpu/raw` + `${OCR_SERVICE_URL}/status` + `${OLLAMA_URL}/api/ps` 셋을 fan-out 호출 → 하나의 JSON으로 합쳐 반환. 응답 형식은 §4.4 참고. |
| `POST /gpu/unload` | body `{backend: "ollama"\|"ocr", name?: string}`. <br>· `ollama` → `POST {OLLAMA_URL}/api/generate` with `{model: name, prompt: "", keep_alive: 0}` (공식 unload 방법). <br>· `ocr` → `POST {OCR_SERVICE_URL}/unload`. |

신규 환경변수: `OLLAMA_URL`, `OCR_SERVICE_URL`. Quadlet 유닛 `Environment=` 에 추가.
기본값 두지 않음(누락 시 부팅 거부) — 같은 머신 가정 재발 방지.

### 4.3 웹 앱 변경

#### 4.3.1 `runOcrInEditor` 두 단계 분리

`app/src/lib/ocrNote/runOcrInEditor.ts` 의 현재 단일 `sendChat` 호출을 두
호출의 직렬 합성으로 바꾼다:

1. 새 헬퍼 `sendOcr({ url: "${httpBase}/ocr", token, imageB64 })` →
   `{ text, reason }`. 스트리밍이면 토큰을 [원문] 블록에 누적.
2. 1번 결과 텍스트로 기존 `sendChat` 호출. system prompt는 새
   `buildTranslatePrompt()` (영→한 단일 시스템 프롬프트). 스트리밍을
   [번역] 블록에 누적.

`defaults.ts`:

- `OCR_DEFAULT_TARGET_LANG`, `buildOcrSystemPrompt`, `OCR_USER_PROMPT`,
  `target_lang` 헤더 키 모두 제거.
- 신규: `buildTranslatePrompt()` — `"다음 영문을 자연스러운 한국어로 번역해.
  부연 설명 없이 번역 결과만 출력해."` 한 줄짜리.
- `OCR_RECOGNIZED_HEADER_KEYS` 에서 `target_lang` 제거, `translate` 추가
  (번역 모델 지정용; 다음 절 참고).

#### 4.3.2 노트 시그니처 확장

기존:
```
ocr://qwen2.5vl:7b
```

신규:
```
ocr://got-ocr2
translate: exaone3.5:2.4b
```

- `ocr://<name>` — OCR 백엔드 모델 이름. ocr-service에 현재는 GOT-OCR2 하나만
  로드되지만 향후 확장 가능. 임시로 알 수 없는 이름이면 ocr-service가
  400 응답 + UI에 토스트.
- `translate: <ollama-model>` — Ollama에 있는 번역 모델. 누락 시 기본값
  `exaone3.5:2.4b`.
- 하위호환: 단일 시그니처 `ocr://qwen2.5vl:7b` 같은 형태도 계속 수용
  (기존 노트 유지). 이 경우 `translate:` 가 비어있으면 옛 단일 모델 흐름
  (`sendChat` 한 번)으로 폴백한다. 새 노트는 위 두 줄 형식 권장.
- `parseOcrNote.ts` 의 `OcrNoteSpec` 에 `translateModel: string` 필드 추가.

`system:` 헤더는 유지하되 의미가 바뀐다 — 이제 번역 단계의 system prompt를
덮어쓴다.

#### 4.3.3 신규 페이지 `/admin/gpu`

위치 결정 근거: admin 영역은 desktop-only 운영자 UI이며 모바일-퍼스트
invariant 적용 안 됨. GPU 모니터는 데스크탑에서만 의미 있어 적합.
`/admin/+layout.svelte` 의 서브탭에 "GPU" 추가.

폴링: `GET /gpu/status` 를 5초 간격, 페이지가 `document.visibilityState ===
"visible"` 동안만. hidden 되면 중단.

UI 요소:

- 상단: 총 VRAM 바 (used/total MB + %).
- 모델 목록: 백엔드(ollama/ocr), 이름, 크기, idle 시간, [언로드] 버튼.
- 하단: nvidia-smi 프로세스 목록 (PID, 프로세스명, VRAM MB) — 디버깅용.
- 빈 상태 / 데스크탑 다운 상태 명시 (`/gpu/status` 가 502/타임아웃이면
  "데스크탑에 연결할 수 없음").

언로드 동작:

- 클릭 → `POST /gpu/unload {backend, name}` → 토스트(`"EXAONE 언로드됨"`) →
  즉시 한 번 재폴링.
- 423 응답 (in-flight) 시 토스트 `"사용 중 — 잠시 후 다시 시도"`.

자동 언로드 타이머 값 변경 UI는 이번 범위에서 제외 (환경변수로만 관리).

### 4.4 `/gpu/status` 응답 형식

```json
{
  "vram": {
    "total_mb": 10240,
    "used_mb": 4280,
    "free_mb": 5960
  },
  "models": [
    {
      "backend": "ollama",
      "name": "exaone3.5:2.4b",
      "size_mb": 1700,
      "idle_for_s": 12,
      "unloadable": true
    },
    {
      "backend": "ocr",
      "name": "got-ocr2",
      "size_mb": 1200,
      "idle_for_s": 200,
      "unloadable": true
    }
  ],
  "processes": [
    { "pid": 1234, "name": "ollama", "vram_mb": 6200 }
  ],
  "fetched_at": "2026-05-15T15:43:50+09:00"
}
```

`size_mb` 는 모델 자체 가중치 크기 추정치 (Ollama `/api/ps` 의 `size_vram`
또는 ocr-service 자체 계산). `idle_for_s` 는 마지막 추론 호출 후 경과 초.
브릿지가 데스크탑 응답을 받지 못하면 해당 섹션을 빼고 `unavailable` 플래그를
추가한다.

## 5. VRAM 충돌 모델 (중요)

같은 GPU를 PyTorch CUDA allocator (ocr-service) 와 llama.cpp CUDA
allocator (Ollama) 가 공유한다. 두 프로세스는 서로의 점유를 모른다.

| 시나리오 | 동작 |
|---|---|
| Ollama 내부 모델 교체 (LRU) | `OLLAMA_MAX_LOADED_MODELS` / `OLLAMA_KEEP_ALIVE` 정책으로 Ollama가 자동 unload 후 새 모델 로드. 정상. |
| ocr-service idle 만료 | 자동 unload (`OCR_IDLE_UNLOAD_S`). 다음 호출 cold 비용 ~3~5초. |
| ocr-service 활성 중 Ollama가 큰 모델 요청 | Ollama 입장에선 ocr-service가 점유한 VRAM이 안 보임. 가용분 안에 못 들어가면 `CUDA out of memory` 또는 부분 CPU 오프로드(매우 느림). |
| 사용자가 `/admin/gpu` 에서 수동 언로드 | 즉시 회수. 다음 호출 시 cold 재로드. |

권장 운영 패턴:

- ocr-service idle auto-unload 활성 (`OCR_IDLE_UNLOAD_S=300`).
- EXAONE은 작아서(1.7GB) Ollama `keep_alive=-1` 로 상주해도 OK.
- 큰 모델(9B+)을 Ollama에서 자주 쓸 거면 `OCR_IDLE_UNLOAD_S` 짧게.
- `/admin/gpu` 페이지에서 충돌 발생 시 즉시 진단 + 수동 회수.

## 6. 작업 단위 (Implementation Plan 분해 후보)

1. **데스크탑 측 `ocr-service` 컨테이너**
   - FastAPI 서버 + GOT-OCR2 로드 + idle unload 로직
   - `Containerfile`, Quadlet `.container`
   - `tests/` 로컬 스모크 테스트
2. **bridge 측 라우팅**
   - `/ocr` 프록시
   - `/gpu/status` 합본 (3-way fan-out)
   - `/gpu/unload` 백엔드 분기
   - 환경변수 검증 (누락 시 부팅 거부)
3. **`runOcrInEditor` 두 단계 분리**
   - `sendOcr` 헬퍼 (스트리밍 처리 포함)
   - 순차 호출 + 두 블록 ([원문]/[번역]) 스트리밍
   - 옛 단일 시그니처 폴백 경로
4. **노트 시그니처 확장**
   - `parseOcrNote.ts` 에 `translate:` 헤더 + `translateModel` 필드
   - `defaults.ts` 단순화 (`buildTranslatePrompt`)
   - 단위 테스트 (`app/tests/unit/ocrNote/parseOcrNote.test.ts` 업데이트)
5. **`/admin/gpu` 페이지**
   - 서브탭 추가 (`/admin/+layout.svelte`)
   - 라우트 + 폴링 + UI
   - 토스트 + 빈 상태
6. **invariant 문서화**
   - `.claude/skills/tomboy-terminal/SKILL.md` 에 "Pi는 GPU 없음, 모델은
     데스크탑" invariant 단락 추가
   - 본 spec 의 §2 architecture 다이어그램 + 그 invariant 명시

## 7. 비범위 (Out of scope)

- **이미지 편집/생성** — 사용자가 이번 범위에서 보류. 후속 spec에서 다룸.
- **여러 OCR/번역 모델 동시 라우팅** — 현재는 OCR=GOT-OCR2 하나, 번역=Ollama
  모델 임의 선택 구조. 일반화는 후속.
- **자동 언로드 타이머 사용자 설정 UI** — 환경변수로만 관리.
- **`/admin/gpu` 에서 모델 pull / pre-warm 트리거** — 후속.
- **iOS PWA에서 `/admin/gpu`** — admin은 데스크탑-only 영역으로 모바일 UX
  최적화 안 함.

## 8. 검증 계획

- ocr-service: `pytest tests/` 로 OCR 결과 비공백 / `/unload` 후 VRAM 감소 /
  idle timer fake-clock 테스트.
- bridge: 단위 테스트로 `/gpu/status` 합본 로직 (데스크탑 응답 부분 누락 시
  graceful 처리), `/gpu/unload` 백엔드 분기.
- 웹 앱: `parseOcrNote.test.ts` 업데이트 — 새 형식 + 옛 형식 폴백 양쪽 커버.
  `runOcrInEditor` 는 기존처럼 mock sendChat + 신규 mock sendOcr 로 두 단계
  순서 검증.
- 통합 (수동): 실제 데스크탑에서 영문 PDF 페이지 캡처 → OCR 노트에 붙여넣기
  → [원문]/[번역] 두 블록이 순차 스트리밍되는지 확인. `/admin/gpu` 에서
  두 모델 모두 표시되는지 + 언로드 동작 확인.

## 9. 마이그레이션

기존 OCR 노트는 단일 시그니처(`ocr://qwen2.5vl:7b`) 폴백 경로로 그대로
동작한다. 사용자가 새 흐름을 쓰려면 시그니처를 두 줄 형식으로 수정.

Ollama 측에서 `ollama pull exaone3.5:2.4b` 한 번 필요. ocr-service 첫 부팅 시
GOT-OCR2 가중치를 HuggingFace에서 자동 다운로드 (~1.2GB).
