# RAG 인프라 — 노트 임베딩 + LLM 노트 컨텍스트 부착

**날짜:** 2026-05-13
**상태:** 디자인 검토 대기
**스코프:** `llm://` 시그니처 LLM 노트의 헤더에 `rag: <K>` 키가 있을 때, 사용자의 마지막 Q 텍스트를 query 로 bge-m3 임베딩 → 데스크탑 sqlite-vec 인덱스에서 top-K 노트를 가져와 → system prompt 앞에 본문을 prepend → 기존 `/llm/chat` 흐름으로 응답 → 응답 본문 뒤에 `참고: [[제목1]] [[제목2]] …` 을 internal-link 마크로 자동 부착. 인덱서는 데스크탑에서 long-running systemd service 로 돌며, **bootstrap** 은 `/admin/tools` 의 기존 zip 백업을 데스크탑 watched 경로에 1회 복사하여, **steady state** 는 Firestore `users/{uid}/notes` 의 `serverUpdatedAt > watermark` polling 으로 점진 갱신. bridge 는 `/rag/search` 엔드포인트 1개를 추가해 데스크탑 FastAPI `/search` 로 proxy.

## 요약

LLM 노트가 사용자의 노트 전체를 "기억" 처럼 활용하게 하는 첫 RAG 구현. 빠른 터미널 도우미 spec (`2026-05-12-llm-note-quick-helper-design.md`) 이 잠근 6 분해 (런타임, 노트-모델 통합, **RAG 인프라**, 빠른 도우미, 페르소나 아바타, OCR 재검수 — 의존성 1 → (2,3) → (4,5,6)) 중 **#3 RAG 인프라** 를 단독 vertical slice 로 다룬다. 페르소나 fine-tune, OCR 재검수, reranker, hybrid search (BM25), 단락-단위 chunking, 노트북 필터, 검색 결과 사용자 편집 UI 는 의도적 비-목표.

핵심 결정 잠금:

| | |
|---|---|
| 인덱스 위치 | **Desktop only** (vector DB + 임베딩 모델 + 검색 서버 모두 데스크탑) |
| 인덱싱 단위 | **노트 1개 = 1 chunk** (제목 + 전체 본문). 노트 잘림 발생해도 v1 감수 |
| 임베딩 모델 | **bge-m3** via Ollama (568M, 다국어/한국어 강함, 8K context, 1024-dim) |
| Vector DB | **sqlite-vec** 단일 파일 (`~/.local/share/tomboy-rag/index.db`) |
| 검색 서버 | **Desktop FastAPI** on `0.0.0.0:8743` — Pi (bridge) IP 만 firewall allowlist |
| Bridge 노출 | `/rag/search` (Bearer auth → desktop proxy). `/llm/chat` 옆에 sibling |
| 활성화 | **노트별 opt-in via `rag` 헤더 키** — 기본 OFF |
| 검색 단위 | 마지막 Q: 텍스트가 query, 응답된 본문은 system prompt 에 invisible prepend |
| 사용자에게 표시 | A: 응답 뒤에 `참고: [[제목]] [[제목]] …` 자동 부착 (autoLink 가 internal-link 마크 부여) |
| Bootstrap 채널 | `/admin/tools` 의 기존 zip 백업 → desktop watched 경로 (`~/.local/share/tomboy-rag/inbox/`) 에 사용자가 1회 수동 복사 |
| Steady-state 채널 | Firestore polling 30 초마다, `serverUpdatedAt > watermark` |
| 인덱싱 대상 제외 | LLM 노트 (`llm://`), 터미널 노트 (`ssh://`). 그 외 (일정/슬립박스 포함) 모두 인덱싱 |
| 검색 실패 시 | RAG 없이 정상 응답 진행 + toast 안내. 사용자가 답 못 받는 상황 안 만듦 |

---

## 섹션 1 — 노트 grammar 확장

빠른 도우미 spec 의 LLM 노트 grammar 에 `rag` 헤더 키 1 개와 응답 본문 부착물 1 종을 추가한다. 시그니처 / 제목 단락 / Q:A: turn 영역 / 빈 단락 경계 규칙은 모두 그대로.

### 추가되는 헤더 키: `rag`

```
지난 한 달 정리                       ← 단락 1 (제목)
llm://qwen2.5:7b                       ← 단락 2 (시그니처)
system: 너는 내 노트의 어시스턴트.
temperature: 0.3
num_ctx: 8192
rag: 5                                 ← 신규
                                       ← 빈 단락
Q: 차 점검 어떻게 했는지 알려줘.
A: 4월 12일에 엔진오일 교체하고, …
참고: [[차 정비 메모]] [[2026-04-12 점검]]   ← 신규 (응답 뒤 자동 부착)

Q: ▌
```

`rag` 키 값 명세:

| 값 | 의미 |
|----|------|
| (키 자체 없음) | RAG OFF (기본) |
| `rag: off` | RAG OFF (명시) |
| `rag: on` | RAG ON, top-K = 5 |
| `rag: <정수>` (1-20) | RAG ON, top-K = 그 정수 |
| `rag: <범위 밖 정수>` | 1-20 범위로 silent clamp |
| `rag: <기타>` | 기존 헤더 grammar 의 silent drop 규칙 적용 (전체 RAG OFF) |

### `참고:` 줄 명세

- A: 응답 스트리밍이 끝난 직후, `LlmSendBar` 가 새 단락으로 `참고: [[제목1]] [[제목2]] …` 을 삽입한다 (제목 사이 공백 1 칸).
- 각 `[[제목]]` 은 기존 `autoLinkPlugin` 이 internal-link 마크를 자동 부여 → 클릭하면 해당 노트가 열린다 (Tomboy 내부링크 표준 동작).
- 검색 결과 0개 → `참고:` 줄 자체를 부착하지 않는다.
- `참고:` 줄은 **A: 응답의 일부로 노트 본문에 영구 저장**된다. 다음 turn 의 LLM message 로도 그대로 포함되어 흘러간다 — 파서가 따로 발라내지 않는다 (대화 맥락에 도움). 이 invariant 는 §6 #3 참조.

### 자동 헤더 보완 (`llmNotePlugin`) 영향

빠른 도우미 spec 의 자동 보완 규칙 (시그니처 완성 시, mount 시 헤더 0개일 때) 에 `rag` 키는 **포함하지 않는다**. 기본 OFF 유지가 우선 — 사용자가 의식적으로 한 줄 추가해야 ON. plugin 의 헤더 detection 정규식 (`LLM_HEADER_KEY_RE`) 에 `rag` 추가만 하면 사용자가 직접 입력한 `rag: ...` 은 헤더로 인식된다.

### parseLlmNote 영향

- `LLM_RECOGNIZED_HEADER_KEYS` 에 `'rag'` 추가
- `LlmHeaderKey` type union 에 `'rag'` 추가
- `LlmNoteSpec.options` 에 `rag?: number` 필드 추가 (`undefined` = OFF, 정수 = top-K)
- 파싱 로직: 값이 `off` → `undefined`, `on` → `5`, 정수 → `clamp(1, 20, value)`, 그 외 → `undefined` (silent drop)

---

## 섹션 2 — 아키텍처 & 구성요소

```
┌──────────────────────┐                ┌─────────────────────────────┐
│  Browser (PWA)       │                │  Desktop (RTX 3080)         │
│                      │                │                             │
│  /admin/tools        │                │  ┌───────────────────────┐  │
│  └ "zip 백업"────────┼─수동 복사──┐   │  │  rag-indexer.service  │  │
│                      │            └──▶│  │  (long-running)       │  │
│  note/[id]           │                │  │                       │  │
│  └ LlmSendBar        │                │  │  ┌─[A] zip bootstrap─┐│  │
│    (rag 헤더 분기)   │   /rag/search  │  │  │  startup 1회만    ││  │
│                      │─────HTTP──┐    │  │  │  (count == 0 일 때)││  │
│  (Firebase sync ON)  │            │   │  │  └─────────────────────┘│  │
│  └ Firestore 푸시────┼─────►Firestore │  │  ┌─[B] firestore     ││  │
│                      │           │   │  │  │  poller 30s        ││  │
└──────────────────────┘           ▼   │  │  └─────────────────────┘│  │
                          ┌──────────┐ │  │           ▼              │  │
                          │ bridge   │ │  │  ┌─────────────────┐    │  │
                          │  (Pi)    │ │  │  │ Ollama bge-m3   │    │  │
                          │          │ │  │  │ 임베딩 호출      │    │  │
                          │/rag/search│─┼─▶│           ▼              │  │
                          │ → proxy   │ │  │  ┌─────────────────┐    │  │
                          │/llm/chat  │ │  │  │ sqlite-vec      │    │  │
                          │           │ │  │  │ index.db        │    │  │
                          └──────────┘ │  │  └─────────────────┘    │  │
                                       │  │                          │  │
                                       │  │  rag-search.service      │  │
                                       │  │  └ FastAPI /search       │  │
                                       │  │    (0.0.0.0:8743)        │  │
                                       │  └────────────────────────────┘  │
                                       └─────────────────────────────┘
```

### 구성요소

| # | 이름 | 위치 | 책임 |
|---|------|------|------|
| 1 | `rag-indexer.service` | Desktop, Python | 두 채널 ([A] zip startup-only, [B] Firestore polling 30 s) 으로 노트 수신 → bge-m3 임베딩 → sqlite-vec upsert |
| 2 | `rag-search.service` | Desktop, Python (FastAPI) | `localhost:0.0.0.0:8743/search` — query 임베딩 → sqlite-vec top-K → JSON 반환 |
| 3 | `bridge /rag/search` | Pi, Node | Bearer auth → desktop `:8743/search` 로 proxy (env `RAG_SEARCH_URL`) |
| 4 | `LlmSendBar` rag 분기 | Browser, Svelte | `spec.options.rag` 진리값 → bridge `/rag/search` 호출 → system 에 prepend → `/llm/chat` → 응답 뒤 `[[title]]` 부착 |
| 5 | `searchRag.ts` 신규 모듈 | Browser, TS | `/rag/search` 호출 + `RagSearchError` 분류 (인증/네트워크/upstream) |
| 6 | `parseLlmNote.ts` 확장 | Browser, TS | `rag` 헤더 키 인식 |
| 7 | `/admin/tools` 의 기존 zip | Browser, Svelte | (변경 없음) Bootstrap 채널 [A] 입력 |

Pi 에는 RAG 인덱스/모델이 **없다** — bridge 는 proxy 만. 모든 인덱싱·검색 로직은 desktop 에 집중 (§6 #11).

---

## 섹션 3 — 인덱싱 흐름

### [A] Zip bootstrap — startup 시 1 회만

```
watched 경로:  ~/.local/share/tomboy-rag/inbox/
sqlite 위치:   ~/.local/share/tomboy-rag/index.db
```

인덱서 시작 시 흐름:

```python
def main():
    db = open_or_create_index_db()
    if db.count_notes() == 0:
        bootstrap_from_zip_if_present()
    start_firestore_polling_loop()
```

1. sqlite `notes` 테이블 행 수 조회.
2. `count == 0` (인덱스 비어 있음) → `inbox/` 디렉토리에서 `*.zip` 검색.
   - 가장 최근 mtime zip 하나 선택 (여러 개면).
   - zip 풀어서 메모리에 `{guid}.note` 들 로드.
   - 각 `.note` 파싱: `(guid, title, body_text, content_hash)` 추출.
     - `body_text` = `<note-content>` 안의 XML 을 plain text 로 변환 (모든 마크 무시, 텍스트만 추출, 줄바꿈 보존).
     - `content_hash` = `sha256(title + "\n" + body_text)`.
   - **제외 필터**: 본문 처음 2 단락 안에 `llm://` 또는 `ssh://` 패턴 → skip.
   - 각 노트에 대해 bge-m3 임베딩 호출 → sqlite-vec upsert + `notes` 행 insert.
   - bootstrap 후 zip 은 `inbox/` 에 그대로 둠 (다음 startup 시 count > 0 라서 무시됨).
3. `count > 0` → zip 무시, 즉시 [B] 로 진행.

**재bootstrap 방법**: 사용자가 `~/.local/share/tomboy-rag/index.db` 삭제 + 새 zip 을 `inbox/` 에 넣고 `systemctl --user restart rag-indexer rag-search`.

### [B] Firestore polling — steady state, 30 초마다

```
watermark 위치: ~/.local/share/tomboy-rag/firestore_watermark.iso
```

```python
async def poll_loop():
    while True:
        await asyncio.sleep(30)
        watermark = load_watermark()  # ISO timestamp, init = epoch
        docs = await firestore_query(
            collection=f"users/{uid}/notes",
            where="serverUpdatedAt", op=">", value=watermark,
            order_by="serverUpdatedAt",
            limit=100
        )
        for doc in docs:
            process_doc(doc)
        if docs:
            save_watermark(docs[-1].serverUpdatedAt)
```

1. 30 초마다 watermark 기반 쿼리.
2. `LIMIT 100` 으로 burst 대응 (한 번 polling 에 너무 많이 처리 안 함; 다음 tick 에 이어서).
3. 각 doc:
   - `deleted: true` → sqlite 에서 guid 삭제 (notes + note_embeddings).
   - `xmlContent` 파싱 → `(title, body_text, content_hash)` 추출.
   - 제외 필터 (LLM/터미널 시그니처) → skip.
   - 기존 인덱스 행 조회: `content_hash` 일치 → skip (임베딩 비용 절약).
   - 다르면 bge-m3 임베딩 → upsert.
4. 처리된 doc 의 가장 큰 `serverUpdatedAt` 으로 watermark 업데이트 (fsync).

**uid 산출**: `pipeline/desktop/bootstrap.py` 의 기존 `sanitize_account_id` 재사용 — `dbx-{sanitized account_id}`. diary / app / RAG 가 같은 uid 공유 (§6 #9).

### sqlite 스키마

```sql
CREATE TABLE IF NOT EXISTS notes (
  guid           TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  indexed_at     TEXT NOT NULL    -- ISO timestamp
);

CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
  guid       TEXT PRIMARY KEY,
  embedding  FLOAT[1024]
);
```

### 실패 처리

| 실패 | 동작 |
|------|------|
| bge-m3 호출 실패 (Ollama 다운/모델 미설치) | 해당 노트 skip + ERROR 로그. content_hash 가 그대로니 다음 tick 에 자동 재시도. |
| Firestore 인증 실패 (custom token 만료 등) | log + 30 초 sleep + 재시도. 5 회 연속 실패 시 service 죽음 (systemd `Restart=on-failure` 가 재시작). |
| Zip 파일 손상 (CRC 오류 등) | ERROR 로그 + zip 을 `inbox/broken-{epoch}.zip` 로 rename → 사용자가 발견. count == 0 그대로 → 사용자가 새 zip 넣을 때까지 [A] 시도 안 됨. |
| 노트 XML 파싱 실패 | 해당 노트 skip + WARN 로그. 다른 노트 인덱싱 계속. |
| sqlite-vec disk full | service crash → systemd 재시작. 운영자가 발견해야 함 (별도 모니터링 없음). |

---

## 섹션 4 — 검색 흐름

### Browser 측 (`LlmSendBar` rag 분기)

```ts
async function send() {
  // 기존: spec 파싱, abortController, editor.setEditable(false), appendParagraph('A: ')
  // ...

  let retrievedNotes: RagHit[] = [];
  if (spec.options.rag && spec.options.rag > 0) {
    try {
      retrievedNotes = await searchRag({
        url: `${httpBase}/rag/search`,
        token: bridgeToken,
        query: lastUserContent,
        k: spec.options.rag,
        signal: ctrl.signal
      });
    } catch (err) {
      // 검색 실패 = RAG 없이 진행
      pushToast(`RAG 검색 실패 — 참고 노트 없이 응답`);
    }
  }

  // system prompt 에 invisible prepend
  if (retrievedNotes.length > 0) {
    const ragPrefix = '참고 노트:\n' + retrievedNotes
      .map(n => `## ${n.title}\n${n.body}`)
      .join('\n\n---\n\n') + '\n\n---\n\n';
    if (body.messages[0]?.role === 'system') {
      body.messages[0].content = ragPrefix + body.messages[0].content;
    } else {
      body.messages.unshift({ role: 'system', content: ragPrefix });
    }
  }

  // 기존 /llm/chat 호출 (변경 없음)
  const result = await sendChat({ ... });

  // 응답 끝나면 참고: 줄 부착
  if (retrievedNotes.length > 0 && result.reason === 'done') {
    const titles = retrievedNotes.map(n => `[[${n.title}]]`).join(' ');
    appendParagraph(`참고: ${titles}`);
  }
  appendParagraph('');
  appendParagraph('Q: ');
  // 커서 이동, abort 처리, finally 블록은 기존 그대로
}
```

`searchRag` 의 시그너처:

```ts
export interface RagHit {
  guid: string;
  title: string;
  body: string;
  score: number;  // 0.0 ~ 1.0 (cosine similarity)
}

export interface SearchRagOptions {
  url: string;
  token: string;
  query: string;
  k: number;
  signal?: AbortSignal;
}

export class RagSearchError extends Error {
  kind: 'unauthorized' | 'rag_unavailable' | 'network' | 'bad_request' | 'upstream_error';
  // ...
}

export async function searchRag(opts: SearchRagOptions): Promise<RagHit[]>;
```

오류는 `LlmChatError` 와 비슷한 discriminator 패턴. UI 는 `[오류: 연결 실패]` 같은 텍스트를 본문에 부착하지 않는다 — toast 만. RAG 실패는 chat 자체를 막지 않음.

### Bridge 측 (`/rag/search` proxy)

```ts
// bridge/src/rag.ts
export async function handleRagSearch(req, res, secret) {
  if (!verifyBearer(req, secret)) return reply401();

  const body = await readJsonBody(req);
  if (!body.query || typeof body.query !== 'string') return reply400('bad query');
  const k = Math.min(Math.max(parseInt(body.k) ?? 5, 1), 20);

  const upstream = process.env.RAG_SEARCH_URL ?? 'http://localhost:8743/search';
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: body.query, k }),
      signal: ctrl.signal
    });
    if (!r.ok) return reply502('rag service error');
    const data = await r.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
    log(`[term-bridge rag] query.len=${body.query.length} k=${k} hits=${data.length}`);
  } catch (err) {
    if (ctrl.signal.aborted) return; // client 가 끊음
    log(`[term-bridge rag] upstream error: ${err.message}`);
    return reply503({ error: 'rag_unavailable' });
  }
}
```

`/llm/chat` 의 admin endpoint 차단 패턴은 `/rag/*` 에도 같이 적용 (이미 server.ts 에 들어가 있음).

### Desktop 측 (FastAPI `/search`)

```python
# pipeline/desktop/rag/search_server.py
from fastapi import FastAPI
from pydantic import BaseModel
import httpx
import sqlite_vec

app = FastAPI()
db = open_index_db()  # 인덱서가 쓰는 같은 파일 read-only 열기

class SearchReq(BaseModel):
    query: str
    k: int = 5

@app.post("/search")
async def search(req: SearchReq):
    embedding = await ollama_embed(req.query)  # 1024-dim List[float]
    rows = db.execute("""
        SELECT n.guid, n.title, n.body_text, v.distance
        FROM note_embeddings v
        JOIN notes n USING (guid)
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
    """, (sqlite_vec.serialize_float32(embedding), req.k)).fetchall()
    return [
        {"guid": r[0], "title": r[1], "body": r[2],
         "score": 1.0 - min(r[3], 1.0)}
        for r in rows
    ]
```

- 인증 없음 — `0.0.0.0:8743` 으로 바인드하되 host firewall 이 Pi IP 만 allow.
- sqlite 는 인덱서와 search server 가 동시에 연다 (인덱서는 write, search 는 read-only). SQLite WAL 모드 + `PRAGMA journal_mode=WAL` 로 동시성 OK.

---

## 섹션 5 — 운영 / 배포

### 파일 구조

```
pipeline/desktop/
├── rag/
│   ├── __init__.py
│   ├── indexer.py            # main loop: bootstrap + Firestore poller
│   ├── note_parser.py        # .note XML → (title, body_text, content_hash)
│   ├── embeddings.py         # Ollama bge-m3 client (httpx)
│   ├── vector_store.py       # sqlite-vec 래퍼 (open/upsert/delete/search)
│   ├── firestore_source.py   # Firestore polling + watermark
│   ├── zip_bootstrap.py      # one-shot zip extract + bulk index
│   └── search_server.py      # FastAPI /search
├── deploy/
│   ├── rag-indexer.service     # long-running 인덱서
│   └── rag-search.service      # FastAPI /search server

bridge/
├── src/
│   ├── rag.ts                  # handleRagSearch (Bearer + proxy)
│   └── server.ts               # /rag/search 라우팅 추가
└── deploy/
    └── term-bridge.container   # 신규 env: RAG_SEARCH_URL (multi-host 일 때)

app/src/
├── lib/llmNote/
│   ├── defaults.ts             # LLM_RECOGNIZED_HEADER_KEYS 에 'rag' 추가
│   ├── parseLlmNote.ts         # rag 키 파싱
│   └── searchRag.ts            # 신규 — /rag/search 클라이언트
├── lib/editor/llmNote/
│   ├── llmNotePlugin.ts        # LLM_HEADER_KEY_RE 정규식에 rag 추가
│   └── LlmSendBar.svelte       # rag 분기 추가
└── tests/unit/
    ├── llmNote/parseLlmNote.test.ts  # rag 키 케이스 추가
    └── llmNote/searchRag.test.ts     # 신규
```

### Systemd unit (desktop, rootless user)

`rag-indexer.service`:

```ini
[Unit]
Description=Tomboy RAG indexer (zip bootstrap + Firestore poller)
After=ollama.service
Wants=ollama.service

[Service]
Type=simple
WorkingDirectory=%h/workspace/tomboy-web/pipeline
ExecStart=%h/workspace/tomboy-web/pipeline/.venv/bin/python -m desktop.rag.indexer
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

`rag-search.service`:

```ini
[Unit]
Description=Tomboy RAG search server (FastAPI)
After=ollama.service
Wants=ollama.service

[Service]
Type=simple
WorkingDirectory=%h/workspace/tomboy-web/pipeline
ExecStart=%h/workspace/tomboy-web/pipeline/.venv/bin/uvicorn desktop.rag.search_server:app --host 0.0.0.0 --port 8743
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

설치:
```bash
mkdir -p ~/.config/systemd/user
cp pipeline/desktop/deploy/rag-*.service ~/.config/systemd/user/
mkdir -p ~/.local/share/tomboy-rag/inbox
systemctl --user daemon-reload
systemctl --user enable --now rag-indexer.service rag-search.service
```

### Ollama 모델 추가

```bash
ollama pull bge-m3   # 568M, ~600 MB VRAM, 1024-dim
```

bge-m3 는 chat 모델 (qwen2.5:7b, qwen2.5-coder:3b) 과 **동시 로드 가능** — 작은 모델이라 VRAM 부담 무시 가능.

### Diary 파이프라인 동거

기존 `desktop-pipeline.service` 의 `ExecStartPre` 모델 evict 목록에 `bge-m3` 추가:

```ini
ExecStartPre=/bin/bash -c 'for m in qwen2.5-coder:3b qwen2.5:7b bge-m3; do curl -sf -X POST http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null || true; done'
```

diary 의 transformers VLM 로딩 직전 모든 Ollama 모델을 evict 시켜 OOM 방지.

### Firewall (multi-host: bridge=Pi, indexer=Desktop)

Desktop 의 `8743/tcp` 를 Pi IP 만 허용:

```bash
# firewalld 예시
sudo firewall-cmd --permanent --zone=internal --add-rich-rule=\
  'rule family="ipv4" source address="<Pi-IP>" port port="8743" protocol="tcp" accept'
sudo firewall-cmd --reload
```

Ollama 11434 와 같은 패턴 (기존 LLM 노트 spec 의 운영 결정 재사용).

### Python 의존성

`pipeline/requirements.txt` 에 추가:

```
sqlite-vec>=0.1
fastapi>=0.110
uvicorn>=0.27
httpx>=0.27
google-cloud-firestore>=2.16   # diary 가 이미 쓰면 재사용
```

### Bridge env 변수

`~/.config/term-bridge.env`:

```
# 기존
BRIDGE_PASSWORD=...
BRIDGE_SECRET=...
BRIDGE_ALLOWED_ORIGIN=https://...
OLLAMA_BASE_URL=http://<desktop-ip>:11434
# 신규 — bridge 가 Pi 면 desktop 의 검색 서버 주소
RAG_SEARCH_URL=http://<desktop-ip>:8743/search
```

같은 호스트 (Pi 에 Ollama 도 있는 가상의 setup) 면 둘 다 생략 → 코드 default 가 localhost.

### 13-step PWA smoke (검수)

운영 배포 후 수동 검증:

1. `/admin/tools` 에서 zip 백업 다운로드.
2. zip 을 desktop `~/.local/share/tomboy-rag/inbox/` 로 복사.
3. `systemctl --user status rag-indexer` — bootstrap 로그 (`indexed N notes`) 확인.
4. `systemctl --user status rag-search` — running.
5. Pi 에서 `curl http://<desktop-ip>:8743/search -d '{"query":"테스트","k":3}' -H 'content-type:application/json'` — JSON 결과.
6. 모바일 PWA 에서 `rag: on` 헤더 있는 LLM 노트 작성.
7. Q 입력 + 보내기 → 응답 도중 system 에 참고 본문 들어갔는지 확인 (직접 보이진 않지만 응답 품질로 추정).
8. 응답 끝난 뒤 `참고: [[제목]] …` 부착 확인.
9. `[[제목]]` 클릭 → 해당 노트 열림 (autoLink 검증).
10. 새 노트 작성 + 즉시 `지금 동기화` (Dropbox) — 30 초 후 검색에 반영되는지 (Firestore 동기화 켜져 있어야 함).
11. 노트 삭제 → 30 초 후 검색 결과에서 빠지는지.
12. `rag: off` 노트는 RAG 동작 안 함 검증.
13. desktop `rag-search` 중지 후 LLM 노트 Q 보내기 → toast "RAG 검색 실패" + 응답은 정상.

---

## 섹션 6 — invariant

향후 확장 시 깨면 안 되는 것들:

1. **노트별 opt-in, default OFF** — `rag` 헤더 없으면 RAG 동작 안 함. 사용자가 의식적으로 켬.
2. **검색 실패 = RAG 없이 진행** — 사용자가 답을 못 받는 상황을 절대 만들지 않는다. toast 로만 알림.
3. **`참고:` 줄은 본문의 일부** — 다음 turn 의 LLM message 에 그대로 흘러간다. 파서가 발라내지 않음.
4. **LLM 노트 / 터미널 노트 인덱싱 제외** — 시그니처 (`llm://`, `ssh://`) 기반 필터. 순환 참조 방지.
5. **임베딩 모델 = Ollama bge-m3 단일** — chat 모델과 같은 Ollama 인스턴스. 별도 임베딩 서비스 안 띄움.
6. **인덱스 = sqlite-vec 단일 파일** — `~/.local/share/tomboy-rag/index.db`. 백업/이동/디버그 단순.
7. **`/search` 는 read-only** — 인덱서가 유일한 writer. 검색 경로는 부수효과 없음.
8. **Bootstrap zip 은 startup 시 1회만** — `count == 0` 이 entry 조건. 재bootstrap 은 sqlite 삭제 + restart 로만.
9. **uid = `dbx-{sanitized account_id}`** — diary / app / RAG 모두 같은 uid 공유. `sanitize_account_id` 함수 분기 금지 — 변경 시 세 곳 동시 수정.
10. **Firestore steady-state 는 `serverUpdatedAt` watermark** — `changeDate` 안 씀 (wall-clock 안전성 이유; app/tomboy-notesync 와 동일 규칙).
11. **Pi (bridge) 에는 RAG 데이터/모델 없음** — proxy 만. 모든 인덱싱·검색 로직은 desktop.
12. **Search server 인증 없음, firewall 로만 보호** — 0.0.0.0:8743 으로 바인드하되 외부 노출 금지. Pi IP allowlist 가 사실상의 인증.
13. **노트 1개 = 1 chunk** — 향후 단락 chunking 도입 시 invariant 변경 필요 (검색 결과 단위가 노트 != 청크가 됨).

---

## 섹션 7 — 비-목표 (v1 에서 안 함)

향후 별도 spec 으로 분리:

1. **Reranker** — bge-reranker-v2-m3 같은 2-stage retrieval.
2. **Hybrid search** — BM25 + dense 결합.
3. **단락 단위 chunking** — 노트 1개 = 1 chunk 고정.
4. **검색 결과 사용자 편집 UI** — "이 노트는 참고하지 마" 인터랙션.
5. **수동 노트 핀** — "이 노트들은 항상 컨텍스트에 포함".
6. **재인덱싱 트리거 UI** — `/admin` 에서 "전체 재인덱싱" 버튼.
7. **인덱스 상태 대시보드** — UI 로 노출. journalctl 로만 확인.
8. **노트북 필터** — "특정 notebook 만 RAG 대상" 헤더 키.
9. **검색 결과 캐싱** — 같은 query 의 임베딩/결과 캐시.
10. **Streaming retrieval** — 검색 중 UI 피드백.
11. **다른 임베딩 모델 옵션** — 노트별 임베딩 모델 선택. bge-m3 hardcode.
12. **권한 / 멀티유저** — Firestore uid 가 곧 namespace, 단일 사용자.
13. **암호화** — 노트 본문이 sqlite + Firestore 평문 (기존 규칙 그대로).
14. **Mobile-only 모드** — 인덱서 없이 모바일 단독 동작.
15. **WOL 통합** — 데스크탑 자동 깨움.
16. **검색 query 자동 가공** — Q 텍스트 그대로 query. paraphrase / multi-query / HyDE 없음.

---

## 참조 spec

- `2026-05-12-llm-note-quick-helper-design.md` — LLM 노트 grammar, `/llm/chat` bridge endpoint, `LlmSendBar` 의 기반 (본 spec 이 확장).
- `2026-05-10-remarkable-diary-pipeline-design.md` — desktop systemd timer 패턴, Firestore client (`pipeline/desktop/lib/firestore_client.py`), `sanitize_account_id` 정의.
- `tomboy-notesync` skill — Firestore 노트 동기화 채널 (`serverUpdatedAt` watermark 패턴 출처).
