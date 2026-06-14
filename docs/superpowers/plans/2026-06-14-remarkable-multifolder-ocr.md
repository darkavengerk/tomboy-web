# reMarkable 다중 폴더 OCR + 슬립노트 분할 + 이미지 폐지 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** reMarkable 일기 파이프라인을 Diary/Notes/Slip-Notes 3폴더 수집으로 확장하고, Slip-Notes 페이지를 위/아래 2노트로 분할하며, 모든 폴더에서 이미지 저장(Dropbox + `<link:url>`)을 폐지한다.

**Architecture:** page-uuid 단일 키(I1)를 *작업단위 키*(`<uuid>` | `<uuid>#0/#1`)로 일반화한다. s2가 렌더된 PNG를 화면 중앙(`PAGE_HEIGHT//2`) 근처 빈 가로 띠에서 잘라 분할 폴더 페이지를 두 단위로 emit하고, s3/s4는 기존 dict-키 순회로 자연스럽게 흐른다. 폴더→{노트북, 제목포맷, 분할여부}는 코드 기본값 + config 오버라이드.

**Tech Stack:** Python 3.11+, Pillow(렌더/크롭), rmscene, pytest. 작업 디렉터리는 `pipeline/`. 테스트 실행은 venv: `pipeline/.venv/bin/python -m pytest`.

설계 문서: `docs/superpowers/specs/2026-06-14-remarkable-multifolder-ocr-design.md`.

---

## 파일 구조

| 파일 | 책임 | 변경 |
|---|---|---|
| `pipeline/desktop/lib/keys.py` | 작업단위 키 헬퍼 | 신규 |
| `pipeline/desktop/lib/state.py` | `StateFile.remove_page` | 수정 |
| `pipeline/desktop/lib/raster.py` | 순수 Pillow 빈-띠 탐색 | 신규(local_vlm에서 추출) |
| `pipeline/desktop/ocr_backends/local_vlm.py` | 타일러가 raster 공유 | 수정 |
| `pipeline/desktop/lib/config.py` | `FolderRoute`/`folders`/`route_for`, dropbox 선택값 | 수정 |
| `pipeline/desktop/bootstrap.py` | 생성 config에 folders | 수정(소) |
| `pipeline/desktop/lib/tomboy_payload.py` | 이미지 제거·슬립 스켈레톤·제목 플레이스홀더 | 수정 |
| `pipeline/desktop/stages/s2_prepare.py` | sourceFolder 라우팅·슬립 분할 | 수정 |
| `pipeline/desktop/stages/s4_write.py` | dropbox 제거·route 기반·빈 건너뛰기 | 수정 |
| `pipeline/desktop/stages/s1_fetch.py` | 복합키 캐스케이드 | 수정 |
| `pipeline/pi/README.md` | 다중 폴더 푸시 스크립트 | 수정(문서) |
| `.claude/skills/tomboy-diary/SKILL.md` | 다중 폴더/분할/이미지 폐지 반영 | 수정(문서) |

각 단계(s1~s4) 코드는 이미 `prepared.json` 등의 dict 키를 그대로 순회하므로, 키만 복합화하면 s3는 코드 변경 없이 통과한다.

---

### Task 1: 작업단위 키 플러밍 (keys.py + StateFile.remove_page)

**Goal:** 복합 키(`<uuid>#half`)를 만들고/분해하는 순수 함수와, 페이지 단위로 하위 상태를 비우는 `StateFile.remove_page`를 추가한다.

**Files:**
- Create: `pipeline/desktop/lib/keys.py`
- Modify: `pipeline/desktop/lib/state.py:58-62` (`remove` 아래에 `remove_page` 추가)
- Test: `pipeline/tests/lib/test_keys.py` (신규), `pipeline/tests/lib/test_state.py` (추가)

**Acceptance Criteria:**
- [ ] `unit_keys_for_page("u", False) == ["u"]`, `unit_keys_for_page("u", True) == ["u#0", "u#1"]`
- [ ] `page_uuid_of("u#1") == "u"`, `page_uuid_of("u") == "u"`
- [ ] `half_index_of("u#0") == 0`, `half_index_of("u#1") == 1`, `half_index_of("u") is None`
- [ ] `remove_page("u")` 가 키 `"u"`, `"u#0"`, `"u#1"` 를 모두 삭제하고 무관한 `"v"`는 남긴다

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/lib/test_keys.py tests/lib/test_state.py -q` → all pass

**Steps:**

- [ ] **Step 1: `test_keys.py` 작성 (실패 확인용)**

```python
from __future__ import annotations

from desktop.lib.keys import half_index_of, page_uuid_of, unit_keys_for_page


def test_unit_keys_whole_page():
    assert unit_keys_for_page("abc", False) == ["abc"]


def test_unit_keys_split_page():
    assert unit_keys_for_page("abc", True) == ["abc#0", "abc#1"]


def test_page_uuid_of():
    assert page_uuid_of("abc") == "abc"
    assert page_uuid_of("abc#0") == "abc"
    assert page_uuid_of("abc#1") == "abc"


def test_half_index_of():
    assert half_index_of("abc") is None
    assert half_index_of("abc#0") == 0
    assert half_index_of("abc#1") == 1
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_keys.py -q` → FAIL (`No module named 'desktop.lib.keys'`)

- [ ] **Step 3: `keys.py` 구현**

```python
"""작업단위(unit) 키 헬퍼.

page-uuid 단일 키(I1)를 일반화한다. 일반 페이지는 page-uuid 그대로,
슬립 등 분할 페이지는 ``<page-uuid>#<half>`` 형태의 복합 키를 쓴다.
이 키가 prepared/ocr-done/written/mappings 상태와 제목 마커 ``[unit_key]``
의 단위가 된다. Firestore 문서 ID는 별도 uuid4라 ``#``가 들어가지 않는다.
"""
from __future__ import annotations

SEP = "#"


def unit_keys_for_page(page_uuid: str, split: bool) -> list[str]:
    if split:
        return [f"{page_uuid}{SEP}0", f"{page_uuid}{SEP}1"]
    return [page_uuid]


def page_uuid_of(unit_key: str) -> str:
    return unit_key.split(SEP, 1)[0]


def half_index_of(unit_key: str) -> int | None:
    parts = unit_key.split(SEP, 1)
    if len(parts) != 2:
        return None
    try:
        return int(parts[1])
    except ValueError:
        return None
```

- [ ] **Step 4: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_keys.py -q` → PASS

- [ ] **Step 5: `test_state.py`에 remove_page 테스트 추가**

```python
def test_remove_page_drops_uuid_and_all_halves(tmp_path):
    from desktop.lib.state import StateFile

    s = StateFile(tmp_path / "prepared.json")
    s.write({"u": {"a": 1}, "u#0": {"b": 2}, "u#1": {"c": 3}, "v": {"d": 4}})
    s.remove_page("u")
    remaining = s.read()
    assert set(remaining.keys()) == {"v"}


def test_remove_page_noop_when_absent(tmp_path):
    from desktop.lib.state import StateFile

    s = StateFile(tmp_path / "prepared.json")
    s.write({"v": {"d": 4}})
    s.remove_page("u")  # no error, no change
    assert set(s.read().keys()) == {"v"}
```

- [ ] **Step 6: `StateFile.remove_page` 구현** — `state.py`의 `remove` 메서드 바로 아래에 추가

```python
    def remove_page(self, page_uuid: str) -> None:
        """Drop the page's own key and every ``<page_uuid>#<half>`` derived
        unit key. Used by the s1 re-fetch cascade and s2 force handling so a
        re-edited split page is fully re-processed (the bare ``remove`` only
        matched the whole-page key)."""
        current = self.read()
        prefix = page_uuid + "#"
        keys = [k for k in current if k == page_uuid or k.startswith(prefix)]
        if not keys:
            return
        for k in keys:
            del current[k]
        self.write(current)
```

- [ ] **Step 7: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_keys.py tests/lib/test_state.py -q` → PASS

- [ ] **Step 8: 커밋**

```bash
git add pipeline/desktop/lib/keys.py pipeline/desktop/lib/state.py pipeline/tests/lib/test_keys.py pipeline/tests/lib/test_state.py
git commit -m "feat(pipeline): 작업단위 키 헬퍼 + StateFile.remove_page (복합키 캐스케이드)"
```

---

### Task 2: 빈-띠 탐색 raster 헬퍼 (raster.py + local_vlm 공유)

**Goal:** `local_vlm`의 순수 Pillow `_ink_row_mask`/`_find_gap_near`를 `lib/raster.py`로 추출해 s2 분할과 타일러가 공유하게 한다. torch를 끌어오지 않는다.

**Files:**
- Create: `pipeline/desktop/lib/raster.py`
- Modify: `pipeline/desktop/ocr_backends/local_vlm.py:128-210` (`_split_to_tiles`가 raster 함수 사용; 정적 메서드는 얇은 위임으로 유지)
- Test: `pipeline/tests/lib/test_raster.py` (신규)

**Acceptance Criteria:**
- [ ] `find_blank_row_near`가 중앙 빈 띠가 있을 때 그 행에 스냅한다
- [ ] 검색창에 빈 행이 없으면 `target`을 반환한다
- [ ] `raster.py` import가 torch/transformers를 끌어오지 않는다 (PIL 객체를 인자로만 받음)
- [ ] 기존 `local_vlm` 타일 테스트가 계속 통과한다

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/lib/test_raster.py tests/ocr_backends/test_local_vlm.py -q` → all pass

**Steps:**

- [ ] **Step 1: `test_raster.py` 작성**

```python
from __future__ import annotations

import pytest


def test_find_blank_row_snaps_to_central_gap():
    PIL = pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    from desktop.lib.raster import find_blank_row_near

    # 400px tall, ink only at y=50 and y=350 → window around 200 is blank.
    img = Image.new("RGB", (60, 400), "white")
    d = ImageDraw.Draw(img)
    d.line([(5, 50), (55, 50)], fill="black", width=3)
    d.line([(5, 350), (55, 350)], fill="black", width=3)

    cut = find_blank_row_near(img, target=200, search=120)
    # The whole [80, 320] window is blank → midpoint 200.
    assert 180 <= cut <= 220


def test_find_blank_row_falls_back_to_target_when_all_ink():
    PIL = pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    from desktop.lib.raster import find_blank_row_near

    img = Image.new("RGB", (60, 400), "white")
    d = ImageDraw.Draw(img)
    # Fill every row in the search window with ink.
    for y in range(80, 321):
        d.line([(0, y), (59, y)], fill="black", width=1)

    cut = find_blank_row_near(img, target=200, search=120)
    assert cut == 200
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_raster.py -q` → FAIL (`No module named 'desktop.lib.raster'`)

- [ ] **Step 3: `raster.py` 구현** (local_vlm의 두 정적 메서드 본문을 그대로 모듈 함수로 이동)

```python
"""Pure-Pillow raster helpers for finding ink-free horizontal bands.

Used by both the slip-note split (``s2_prepare``) and the tall-page tile
slicer (``ocr_backends.local_vlm``). Operates on already-open PIL Image
objects, so importing this module pulls in **no** torch/transformers —
keeping s2 light. No numpy dep either.
"""
from __future__ import annotations

from typing import Any

INK_THRESHOLD = 250  # any pixel darker than near-white counts as ink


def ink_row_mask(image: Any) -> list[bool]:
    """For each row, True iff any pixel is darker than near-white."""
    gray = image.convert("L")
    w, h = gray.size
    data = gray.tobytes()
    assert len(data) == w * h, "unexpected PIL row stride"
    rows: list[bool] = [False] * h
    for y in range(h):
        base = y * w
        if min(data[base : base + w]) < INK_THRESHOLD:
            rows[y] = True
    return rows


def find_gap_near(ink_rows: list[bool], target: int, search: int) -> int:
    """Return the midpoint of the longest blank run within
    [target-search, target+search]. Falls back to ``target`` when the
    window has no blank row."""
    n = len(ink_rows)
    lo = max(0, target - search)
    hi = min(n, target + search)
    best_mid = target
    best_len = 0
    run_start: int | None = None
    for i in range(lo, hi):
        if not ink_rows[i]:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                run_len = i - run_start
                if run_len > best_len:
                    best_len = run_len
                    best_mid = (run_start + i) // 2
                run_start = None
    if run_start is not None:
        run_len = hi - run_start
        if run_len > best_len:
            best_len = run_len
            best_mid = (run_start + hi) // 2
    return best_mid


def find_blank_row_near(image: Any, target: int, search: int) -> int:
    """Convenience: scan ``image`` for the blank band nearest ``target``."""
    return find_gap_near(ink_row_mask(image), target, search)
```

- [ ] **Step 4: `local_vlm.py`가 raster를 쓰도록 수정** — 파일 상단 import 추가, 정적 메서드를 위임으로 교체

`local_vlm.py:21` 부근 import 블록에 추가:

```python
from desktop.lib.raster import find_gap_near, ink_row_mask
```

`_split_to_tiles` 본문의 `self._ink_row_mask(image)` → `ink_row_mask(image)`, `self._find_gap_near(...)` → `find_gap_near(...)`로 교체. 그리고 두 정적 메서드를 얇은 위임으로 남긴다(외부 참조/호환):

```python
    @staticmethod
    def _ink_row_mask(image: Any) -> list[bool]:
        return ink_row_mask(image)

    @staticmethod
    def _find_gap_near(ink_rows: list[bool], target: int, search: int) -> int:
        return find_gap_near(ink_rows, target, search)
```

- [ ] **Step 5: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_raster.py tests/ocr_backends/test_local_vlm.py -q` → PASS

- [ ] **Step 6: 커밋**

```bash
git add pipeline/desktop/lib/raster.py pipeline/desktop/ocr_backends/local_vlm.py pipeline/tests/lib/test_raster.py
git commit -m "refactor(pipeline): 빈-띠 탐색을 lib/raster.py로 추출 (s2 분할·타일러 공유)"
```

---

### Task 3: Config 폴더 라우팅 (FolderRoute + folders + route_for, dropbox 선택값)

**Goal:** rM 폴더명 → {노트북, 제목포맷, 분할여부, 라벨} 라우팅을 config에 도입(코드 기본값 + 오버라이드 + 레거시 폴백)하고, Dropbox 키를 선택값으로 강등한다.

**Files:**
- Modify: `pipeline/desktop/lib/config.py:59-69` (`TomboyConfig`), `:160-163` (dropbox `_require`→`get`)
- Modify: `pipeline/desktop/bootstrap.py:114-117` (생성 config tomboy 블록)
- Test: `pipeline/tests/lib/test_config.py` (추가)

**Acceptance Criteria:**
- [ ] `cfg.tomboy.route_for("Slip-Notes")` → `notebook="[0] Slip-Box"`, `split=True`, `labels=("上","下")`
- [ ] `cfg.tomboy.route_for("Notes")` → `notebook="기록"`, `split=False`
- [ ] 미지 폴더 `route_for("Whatever")` → 폴백(=Notes류, split False)
- [ ] `tomboy.folders` 오버라이드가 코드 기본값을 덮는다
- [ ] dropbox 키 없는 config가 `ConfigError` 없이 로드된다
- [ ] 기존 config 테스트 전부 통과(레거시 `diary_notebook_name`/`title_format` 호환)

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/lib/test_config.py -q` → all pass

**Steps:**

- [ ] **Step 1: 테스트 추가** (`test_config.py` 하단에)

```python
def test_route_for_default_folders():
    cfg = load_config_from_string(VALID_YAML)
    slip = cfg.tomboy.route_for("Slip-Notes")
    assert slip.notebook == "[0] Slip-Box"
    assert slip.split is True
    assert slip.labels == ("上", "下")

    notes = cfg.tomboy.route_for("Notes")
    assert notes.notebook == "기록"
    assert notes.split is False

    diary = cfg.tomboy.route_for("Diary")
    assert diary.split is False


def test_route_for_unknown_folder_falls_back_to_notes():
    cfg = load_config_from_string(VALID_YAML)
    r = cfg.tomboy.route_for("SomethingElse")
    assert r.split is False
    assert r.notebook == "기록"


def test_folders_override_in_config():
    yaml_text = VALID_YAML.replace(
        '''tomboy:
  diary_notebook_name: "일기"
  title_format: "{date} 리마커블([{page_uuid}])"
''',
        '''tomboy:
  folders:
    Slip-Notes:
      notebook: "내슬립박스"
      title_format: "{datetime} S {label}([{unit_key}])"
      split: true
      labels: ["A", "B"]
''',
    )
    cfg = load_config_from_string(yaml_text)
    slip = cfg.tomboy.route_for("Slip-Notes")
    assert slip.notebook == "내슬립박스"
    assert slip.labels == ("A", "B")
    # Folders not overridden still come from code defaults.
    assert cfg.tomboy.route_for("Notes").notebook == "기록"


def test_dropbox_keys_optional():
    yaml_text = VALID_YAML.replace('dropbox_refresh_token: "dummy-token"\n', "")
    yaml_text = yaml_text.replace('dropbox_app_key: "dummy-key"\n', "")
    cfg = load_config_from_string(yaml_text)  # must not raise
    assert cfg.dropbox_refresh_token == ""
    assert cfg.dropbox_app_key == ""
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_config.py -q` → FAIL (`AttributeError: route_for` 등)

- [ ] **Step 3: `config.py`에 `FolderRoute` + 기본 라우팅 추가** (`TomboyConfig` 정의 위)

```python
@dataclass(frozen=True)
class FolderRoute:
    notebook: str
    title_format: str
    split: bool = False
    labels: tuple[str, ...] = ()


# rM 폴더명 → 라우팅. config의 tomboy.folders가 이를 덮어쓴다.
DEFAULT_FOLDER_ROUTES: dict[str, FolderRoute] = {
    "Diary": FolderRoute("일기", "{date} 리마커블([{unit_key}])"),
    "Notes": FolderRoute("기록", "{date} 리마커블([{unit_key}])"),
    "Slip-Notes": FolderRoute(
        "[0] Slip-Box",
        "{datetime} 리마커블 {label}([{unit_key}])",
        split=True,
        labels=("上", "下"),
    ),
}
# 알 수 없는 rM 폴더는 Notes처럼 처리(전체 페이지, 분할 없음).
_FALLBACK_FOLDER = "Notes"
```

- [ ] **Step 4: `TomboyConfig` 교체** (`config.py:59-69`)

```python
@dataclass(frozen=True)
class TomboyConfig:
    folders: dict[str, FolderRoute]
    diary_notebook_name: str = "일기"
    title_format: str = "{date} 리마커블([{page_uuid}])"

    def route_for(self, source_folder: str | None) -> FolderRoute:
        if source_folder and source_folder in self.folders:
            return self.folders[source_folder]
        return self.folders.get(
            _FALLBACK_FOLDER, FolderRoute("기록", "{date} 리마커블([{unit_key}])")
        )

    @classmethod
    def from_dict(cls, d: dict) -> TomboyConfig:
        folders: dict[str, FolderRoute] = dict(DEFAULT_FOLDER_ROUTES)
        legacy_nb = d.get("diary_notebook_name")
        legacy_tf = d.get("title_format")
        # 레거시 단일 폴더 키 → Diary 엔트리 오버라이드(하위호환).
        if legacy_nb or legacy_tf:
            base = folders["Diary"]
            folders["Diary"] = FolderRoute(
                notebook=legacy_nb or base.notebook,
                title_format=legacy_tf or base.title_format,
            )
        # 명시적 folders 맵이 최종 오버라이드.
        for name, fd in (d.get("folders") or {}).items():
            folders[name] = FolderRoute(
                notebook=_require(fd, "notebook", f"tomboy.folders.{name}.notebook"),
                title_format=_require(
                    fd, "title_format", f"tomboy.folders.{name}.title_format"
                ),
                split=bool(fd.get("split", False)),
                labels=tuple(fd.get("labels", ()) or ()),
            )
        return cls(
            folders=folders,
            diary_notebook_name=legacy_nb or "일기",
            title_format=legacy_tf or "{date} 리마커블([{page_uuid}])",
        )
```

- [ ] **Step 5: dropbox 키 선택값화** (`config.py` `Config.from_dict` 내 두 줄)

`dropbox_refresh_token=_require(d, "dropbox_refresh_token", "dropbox_refresh_token"),` → `dropbox_refresh_token=d.get("dropbox_refresh_token", ""),`
`dropbox_app_key=_require(d, "dropbox_app_key", "dropbox_app_key"),` → `dropbox_app_key=d.get("dropbox_app_key", ""),`

- [ ] **Step 6: bootstrap 생성 config에 folders 추가** (`bootstrap.py:114-117`의 `"tomboy": {...}` 블록 교체)

```python
        "tomboy": {
            "folders": {
                "Diary": {"notebook": "일기", "title_format": "{date} 리마커블([{unit_key}])", "split": False},
                "Notes": {"notebook": "기록", "title_format": "{date} 리마커블([{unit_key}])", "split": False},
                "Slip-Notes": {
                    "notebook": "[0] Slip-Box",
                    "title_format": "{datetime} 리마커블 {label}([{unit_key}])",
                    "split": True,
                    "labels": ["上", "下"],
                },
            },
        },
```

- [ ] **Step 7: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_config.py -q` → PASS (신규 + 기존 전부)

- [ ] **Step 8: 커밋**

```bash
git add pipeline/desktop/lib/config.py pipeline/desktop/bootstrap.py pipeline/tests/lib/test_config.py
git commit -m "feat(pipeline): 폴더 라우팅(FolderRoute/folders/route_for) + dropbox 키 선택값화"
```

---

### Task 4: Payload — 이미지 제거 + 슬립 스켈레톤 + 제목 플레이스홀더

**Goal:** `build_note_content_xml`/`build_payload`에서 이미지(`---`+`<link:url>`)를 제거하고, 슬립 스켈레톤 본문과 `{datetime}`/`{unit_key}`/`{label}` 제목 플레이스홀더를 지원한다.

**Files:**
- Modify: `pipeline/desktop/lib/tomboy_payload.py:53-109`
- Test: `pipeline/tests/lib/test_tomboy_payload.py` (재작성)

**Acceptance Criteria:**
- [ ] `build_note_content_xml("T","a\nb")` → `<note-content version="0.1">T\n\na\nb</note-content>` (이미지/`---` 없음)
- [ ] `slip=True` 본문 = `제목\n\n이전: 없음\n다음: 없음\n\n{ocr}`
- [ ] 슬립 제목 `2026-06-14 09:30 리마커블 上([abc#0])` 이 앱 `isSlipNoteTitle` 정규식 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b` 에 매칭
- [ ] `build_payload`에 `image_url` 인자 없음; `unit_key`/`label`/`slip` 인자 지원; 마커는 `[unit_key]`
- [ ] payload에 image 관련 필드/링크 없음, 첫 줄 == 제목

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/lib/test_tomboy_payload.py -q` → all pass

**Steps:**

- [ ] **Step 1: 테스트 재작성** (`test_tomboy_payload.py` 전체 교체)

```python
from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest

from desktop.lib.tomboy_payload import (
    NotePayloadTooLargeError,
    build_note_content_xml,
    build_payload,
    format_tomboy_date,
)


def test_format_tomboy_date_utc():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    s = format_tomboy_date(dt)
    assert s.startswith("2024-05-10T12:00:00.")
    frac = s.split(".")[1].split("+")[0].split("-")[0]
    assert len(frac) == 7
    assert s.endswith("+00:00")


def test_whole_body_has_no_image_or_hr():
    xml = build_note_content_xml("T", "a\nb")
    assert xml == '<note-content version="0.1">T\n\na\nb</note-content>'
    assert "<link:url>" not in xml
    assert "---" not in xml


def test_whole_body_escapes_special_chars():
    xml = build_note_content_xml("t", 'a < b & c > d "e"')
    assert "&lt;" in xml and "&gt;" in xml and "&amp;" in xml and "&quot;" in xml


def test_slip_skeleton_body_layout():
    title = "2026-06-14 09:30 리마커블 上([abc#0])"
    xml = build_note_content_xml(title, "본문1\n본문2", slip=True)
    inner = xml.replace('<note-content version="0.1">', "").replace("</note-content>", "")
    lines = inner.split("\n")
    assert lines[0] == title
    assert lines[1] == ""
    assert lines[2] == "이전: 없음"
    assert lines[3] == "다음: 없음"
    assert lines[4] == ""
    assert lines[5] == "본문1"
    assert "<link:url>" not in xml


def test_build_payload_whole_page():
    dt = datetime(2024, 5, 10, 12, 0, 0, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc-123", ocr_text="hello",
        notebook_name="일기", title_format="{date} 리마커블([{unit_key}])",
        create_date=dt, change_date=dt,
    )
    assert p["title"] == "2024-05-10 리마커블([abc-123])"
    assert p["tags"] == ["system:notebook:일기"]
    assert p["deleted"] is False
    assert "<link:url>" not in p["xmlContent"]
    # first line == title
    inner = p["xmlContent"].replace('<note-content version="0.1">', "").replace("</note-content>", "")
    assert inner.lstrip().splitlines()[0] == p["title"]


def test_build_payload_slip_title_matches_app_regex():
    DATE_TIME_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b")
    dt = datetime(2026, 6, 14, 9, 30, 0, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc", unit_key="abc#0", ocr_text="x",
        notebook_name="[0] Slip-Box",
        title_format="{datetime} 리마커블 {label}([{unit_key}])",
        create_date=dt, change_date=dt, label="上", slip=True,
    )
    assert p["title"] == "2026-06-14 09:30 리마커블 上([abc#0])"
    assert DATE_TIME_PREFIX.match(p["title"])
    assert p["tags"] == ["system:notebook:[0] Slip-Box"]
    assert "이전: 없음" in p["xmlContent"]
    assert "다음: 없음" in p["xmlContent"]


def test_build_payload_marker_uses_unit_key():
    dt = datetime(2026, 6, 14, 9, 30, tzinfo=timezone.utc)
    p = build_payload(
        guid="g", page_uuid="abc", unit_key="abc#1", ocr_text="x",
        notebook_name="N", title_format="{datetime} 리마커블 {label}([{unit_key}])",
        create_date=dt, change_date=dt, label="下", slip=True,
    )
    assert "[abc#1]" in p["title"]


def test_build_payload_too_large_raises():
    dt = datetime(2024, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(NotePayloadTooLargeError):
        build_payload(
            guid="g", page_uuid="p", ocr_text="x" * 1_000_000,
            notebook_name="일기", title_format="{date}",
            create_date=dt, change_date=dt,
        )
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_tomboy_payload.py -q` → FAIL (`image_url` 관련 / slip kwarg 미지원)

- [ ] **Step 3: `build_note_content_xml` 교체** (`tomboy_payload.py:53-71`)

```python
def build_note_content_xml(title: str, ocr_text: str, *, slip: bool = False) -> str:
    """Produce the ``<note-content>`` block.

    이미지 폐지: 본문에 더 이상 ``<link:url>`` 이미지 링크나 ``---`` 구분선이
    없다. 일반 노트는 ``제목 + OCR``, 슬립 노트는 앱 ``validateSlipNoteFormat``
    레이아웃([0]제목 [1]공백 [2]이전 [3]다음 [4]공백 [5+]본문)에 맞춘 스켈레톤을
    쓴다. ``이전``/``다음``은 '없음'으로 두고 사용자가 수동 연결한다.
    """
    if slip:
        body = (
            f"{_xml_escape(title)}\n\n"
            f"이전: 없음\n"
            f"다음: 없음\n\n"
            f"{_xml_escape(ocr_text)}"
        )
    else:
        body = f"{_xml_escape(title)}\n\n{_xml_escape(ocr_text)}"
    return f'<note-content version="{NOTE_CONTENT_VERSION}">{body}</note-content>'
```

- [ ] **Step 4: `build_payload` 교체** (`tomboy_payload.py:74-109`)

```python
def build_payload(
    *,
    guid: str,
    page_uuid: str,
    ocr_text: str,
    notebook_name: str,
    title_format: str,
    create_date: datetime,
    change_date: datetime,
    metadata_change_date: datetime | None = None,
    unit_key: str | None = None,
    label: str = "",
    slip: bool = False,
) -> dict[str, Any]:
    """Build the FirestoreNotePayload dict (sans ``serverUpdatedAt``).

    ``unit_key`` is the title marker + state key unit (``page_uuid`` for whole
    pages, ``<uuid>#<half>`` for slip halves). Title format placeholders:
    ``{date}`` (yyyy-mm-dd), ``{datetime}`` (yyyy-mm-dd HH:mm), ``{page_uuid}``,
    ``{unit_key}``, ``{label}``. Unused placeholders are ignored by ``str.format``.
    """
    unit_key = unit_key if unit_key is not None else page_uuid
    metadata_change_date = metadata_change_date or change_date
    date_str = change_date.strftime("%Y-%m-%d")
    datetime_str = change_date.strftime("%Y-%m-%d %H:%M")
    title = title_format.format(
        date=date_str,
        datetime=datetime_str,
        page_uuid=page_uuid,
        unit_key=unit_key,
        label=label,
    )
    xml_content = build_note_content_xml(title, ocr_text, slip=slip)
    payload: dict[str, Any] = {
        "guid": guid,
        "uri": f"note://tomboy/{guid}",
        "title": title,
        "xmlContent": xml_content,
        "createDate": format_tomboy_date(create_date),
        "changeDate": format_tomboy_date(change_date),
        "metadataChangeDate": format_tomboy_date(metadata_change_date),
        "tags": [f"system:notebook:{notebook_name}"],
        "deleted": False,
    }
    size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    if size > MAX_FIRESTORE_NOTE_BYTES:
        raise NotePayloadTooLargeError(size)
    return payload
```

- [ ] **Step 5: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/lib/test_tomboy_payload.py -q` → PASS

- [ ] **Step 6: 커밋**

```bash
git add pipeline/desktop/lib/tomboy_payload.py pipeline/tests/lib/test_tomboy_payload.py
git commit -m "feat(pipeline): payload 이미지 제거 + 슬립 스켈레톤 + 제목 플레이스홀더(datetime/unit_key/label)"
```

---

### Task 5: s2_prepare — sourceFolder 라우팅 + 슬립 분할

**Goal:** s2가 metadata의 `sourceFolder`로 분할 여부를 판단하고, 분할 폴더 페이지는 `PAGE_HEIGHT//2` 근처 빈 띠에서 위/아래로 잘라 복합 키 2개를 emit한다. skip/force는 페이지 단위.

**Files:**
- Modify: `pipeline/desktop/stages/s2_prepare.py` (`prepare` 시그니처/본문, `main`)
- Test: `pipeline/tests/stages/test_s2_prepare.py` (추가)

**Acceptance Criteria:**
- [ ] 비분할 폴더 → 키 `<uuid>` 1개 + `page.png` (기존 동작 유지)
- [ ] 분할 폴더 → 키 `<uuid>#0`/`<uuid>#1` + `page.0.png`/`page.1.png`
- [ ] 1872 높이 이미지: 컷 ≈ 936 (위 절반 높이 936)
- [ ] 2400 높이(스크롤) 이미지: 컷 == 936 (canvas//2=1200이 아니라 고정 화면 중앙)
- [ ] 한 페이지의 두 복합 키가 모두 prepared면 skip; `force`에 페이지/복합 키가 오면 페이지 전체 재렌더

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s2_prepare.py -q` → all pass

**Steps:**

- [ ] **Step 1: 분할 테스트 추가** (`test_s2_prepare.py` 하단)

```python
def _route_for_factory(split_folders):
    from desktop.lib.config import FolderRoute

    def route_for(source_folder):
        if source_folder in split_folders:
            return FolderRoute("[0] Slip-Box", "{datetime} 리마커블 {label}([{unit_key}])",
                               split=True, labels=("上", "下"))
        return FolderRoute("기록", "{date} 리마커블([{unit_key}])", split=False)

    return route_for


def _seed_raw_with_folder(raw_root, uuid, source_folder):
    import json as _json
    d = raw_root / uuid
    d.mkdir(parents=True)
    (d / f"{uuid}.rm").write_bytes(b"\x00" * 32)
    (d / f"{uuid}.metadata").write_text(
        _json.dumps({"lastModified": "1715337600000", "sourceFolder": source_folder,
                     "visibleName": source_folder, "type": "PageType"})
    )


def _tall_png_bytes(h):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (80, h), "white")
    d = ImageDraw.Draw(img)
    d.line([(5, 20), (75, 20)], fill="black", width=4)          # ink near top
    d.line([(5, h - 20), (75, h - 20)], fill="black", width=4)  # ink near bottom
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_split_folder_emits_two_halves(tmp_path, stub_log):
    pytest.importorskip("PIL")
    from PIL import Image
    from desktop.stages.s2_prepare import RmsceneRenderer, prepare

    raw_root = tmp_path / "raw"; png_root = tmp_path / "png"
    raw_root.mkdir(); png_root.mkdir()
    _seed_raw_with_folder(raw_root, "slip-1", "Slip-Notes")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_tall_png_bytes(RmsceneRenderer.PAGE_HEIGHT))  # 1872

    prepared = prepare(raw_root=raw_root, png_root=png_root, state=state,
                       log=stub_log, renderer=renderer,
                       route_for=_route_for_factory({"Slip-Notes"}))

    assert sorted(prepared) == ["slip-1#0", "slip-1#1"]
    p0 = png_root / "slip-1" / "page.0.png"
    p1 = png_root / "slip-1" / "page.1.png"
    assert p0.exists() and p1.exists()
    # Cut at physical screen center → top half is 936 tall.
    assert Image.open(p0).size[1] == RmsceneRenderer.PAGE_HEIGHT // 2
    rec0 = state.get("slip-1#0")
    assert rec0["source_folder"] == "Slip-Notes"
    assert rec0["half_index"] == 0
    assert rec0["png_path"].endswith("page.0.png")


def test_split_uses_fixed_center_even_when_scrolled(tmp_path, stub_log):
    pytest.importorskip("PIL")
    from PIL import Image
    from desktop.stages.s2_prepare import RmsceneRenderer, prepare

    raw_root = tmp_path / "raw"; png_root = tmp_path / "png"
    raw_root.mkdir(); png_root.mkdir()
    _seed_raw_with_folder(raw_root, "slip-2", "Slip-Notes")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_tall_png_bytes(2400))  # scrolled / extended

    prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log,
            renderer=renderer, route_for=_route_for_factory({"Slip-Notes"}))

    # Fixed physical-center split: top half == PAGE_HEIGHT//2 (936), NOT 2400//2.
    assert Image.open(png_root / "slip-2" / "page.0.png").size[1] == RmsceneRenderer.PAGE_HEIGHT // 2


def test_split_skip_and_force_are_page_scoped(tmp_path, stub_log):
    pytest.importorskip("PIL")
    from desktop.stages.s2_prepare import RmsceneRenderer, prepare

    raw_root = tmp_path / "raw"; png_root = tmp_path / "png"
    raw_root.mkdir(); png_root.mkdir()
    _seed_raw_with_folder(raw_root, "slip-3", "Slip-Notes")
    state = StateFile(tmp_path / "state" / "prepared.json")
    renderer = FakeRenderer(_tall_png_bytes(RmsceneRenderer.PAGE_HEIGHT))
    rf = _route_for_factory({"Slip-Notes"})

    first = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log,
                    renderer=renderer, route_for=rf)
    assert sorted(first) == ["slip-3#0", "slip-3#1"]
    # Both halves present → skip on re-run.
    again = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log,
                    renderer=renderer, route_for=rf)
    assert again == []
    # Force by page uuid → re-render both halves.
    forced = prepare(raw_root=raw_root, png_root=png_root, state=state, log=stub_log,
                     renderer=renderer, route_for=rf, force={"slip-3"})
    assert sorted(forced) == ["slip-3#0", "slip-3#1"]
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s2_prepare.py -q` → FAIL (`prepare() got unexpected keyword argument 'route_for'`)

- [ ] **Step 3: `s2_prepare.py` import + 상수 추가** (파일 상단 import 영역)

```python
from desktop.lib.keys import page_uuid_of, unit_keys_for_page
from desktop.lib.raster import find_blank_row_near
```

`RmsceneRenderer` 클래스 정의 아래(모듈 레벨)에 상수 + 분할 헬퍼 추가:

```python
SPLIT_GAP_SEARCH = 240  # half-window (px) to snap the split to a blank band


def _split_full_png(full_png: Path, out_dir: Path, log: StageLogger, uuid: str) -> list[tuple[int, Path]]:
    """Crop a rendered page into top/bottom halves at the physical screen
    center (PAGE_HEIGHT//2), snapping to the nearest blank row band. Returns
    [(half_index, png_path), ...]. Requires Pillow."""
    from PIL import Image

    img = Image.open(full_png).convert("RGB")
    w, h = img.size
    if h > RmsceneRenderer.PAGE_HEIGHT:
        # Unintended scroll — the physical-center split may be off; flag it.
        log.info("split_scroll_warning", uuid=uuid, height=h)
    target = RmsceneRenderer.PAGE_HEIGHT // 2
    cut = find_blank_row_near(img, target, SPLIT_GAP_SEARCH)
    cut = max(1, min(h - 1, cut))
    out_dir.mkdir(parents=True, exist_ok=True)
    p0 = out_dir / "page.0.png"
    p1 = out_dir / "page.1.png"
    img.crop((0, 0, w, cut)).save(p0, "PNG")
    img.crop((0, cut, w, h)).save(p1, "PNG")
    return [(0, p0), (1, p1)]
```

- [ ] **Step 4: `prepare` 함수 교체** (`s2_prepare.py:155-197`)

```python
def prepare(
    *,
    raw_root: Path,
    png_root: Path,
    state: StateFile,
    log: StageLogger,
    renderer: Renderer,
    route_for: "Callable[[str | None], Any] | None" = None,
    force: Iterable[str] | None = None,
) -> list[str]:
    # 분할 여부는 route_for(source_folder).split 으로 판단. 미지정 시 전부 비분할.
    if route_for is None:
        from desktop.lib.config import FolderRoute

        _default = FolderRoute("기록", "{date} 리마커블([{unit_key}])", split=False)
        route_for = lambda _sf: _default  # noqa: E731

    # force/rerun/--uuid 로 들어온 키는 page-uuid로 환원해 페이지 전체를 비운다.
    for page in {page_uuid_of(k) for k in (force or [])}:
        state.remove_page(page)

    prepared: list[str] = []
    for uuid_dir in sorted(p for p in raw_root.iterdir() if p.is_dir()):
        uuid = uuid_dir.name
        meta_path = uuid_dir / f"{uuid}.metadata"
        if not meta_path.exists():
            log.error("missing_metadata", uuid=uuid)
            continue
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            source_folder = metadata.get("sourceFolder")
            route = route_for(source_folder)
            keys = unit_keys_for_page(uuid, route.split)
            if all(state.contains(k) for k in keys):
                continue
            # 부분 상태 정리 후 재렌더(멱등).
            for k in keys:
                state.remove(k)

            def _record(png_path: Path, meta: dict) -> dict[str, object]:
                rec: dict[str, object] = {
                    "prepared_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "png_path": str(png_path.resolve()),
                    "metadata": meta,
                    "source_folder": source_folder,
                }
                size = _read_png_size(png_path)
                if size is not None:
                    rec["png_width"], rec["png_height"] = size
                return rec

            if route.split:
                full = png_root / uuid / "page.full.png"
                renderer.render(uuid_dir, full)
                halves = _split_full_png(full, png_root / uuid, log, uuid)
                full.unlink(missing_ok=True)
                for half_idx, png_path in halves:
                    key = f"{uuid}#{half_idx}"
                    rec = _record(png_path, metadata)
                    rec["half_index"] = half_idx
                    state.update({key: rec})
                    log.info("prepared", uuid=key)
                    prepared.append(key)
            else:
                target = png_root / uuid / "page.png"
                renderer.render(uuid_dir, target)
                state.update({uuid: _record(target, metadata)})
                log.info("prepared", uuid=uuid)
                prepared.append(uuid)
        except Exception as e:
            log.error("prepare_failed", uuid=uuid, reason=str(e))
    return prepared
```

`Callable`/`Any` 사용을 위해 상단 `from typing import ...`에 `Callable, Any`가 포함됐는지 확인(없으면 추가).

- [ ] **Step 5: `main()` 갱신** (`s2_prepare.py:200-234`) — 죽은 `if args.uuid: pass` 블록 제거, `route_for` 주입, `--uuid`를 force에 추가

```python
    cfg = load_config(args.config)
    raw_root = cfg.data_dir / "raw"
    png_root = cfg.data_dir / "png"
    png_root.mkdir(parents=True, exist_ok=True)
    state = StateFile(cfg.data_dir / "state" / "prepared.json")
    log = StageLogger("s2_prepare", cfg.data_dir)
    renderer = RmsceneRenderer()

    rerun_uuids = fetch_pending_reruns(cfg, log)
    force = set(args.force) | set(rerun_uuids)
    if args.uuid:
        force.add(args.uuid)
    prepared = prepare(
        raw_root=raw_root,
        png_root=png_root,
        state=state,
        log=log,
        renderer=renderer,
        route_for=cfg.tomboy.route_for,
        force=force,
    )
    print(f"s2_prepare: {len(prepared)} units prepared")
    return 0
```

- [ ] **Step 6: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s2_prepare.py -q` → PASS (신규 분할 + 기존 비분할 전부)

- [ ] **Step 7: 커밋**

```bash
git add pipeline/desktop/stages/s2_prepare.py pipeline/tests/stages/test_s2_prepare.py
git commit -m "feat(pipeline): s2 sourceFolder 라우팅 + 슬립 위/아래 분할(고정 화면중앙 빈띠 스냅)"
```

---

### Task 6: s4_write — Dropbox 제거 + route 기반 노트북/제목 + 슬립 + 빈 건너뛰기

**Goal:** s4가 Dropbox를 쓰지 않고, 복합 키별로 `route_for(source_folder)`로 노트북·제목·슬립 스켈레톤을 적용하며, 빈 OCR 단위는 건너뛴다.

**Files:**
- Modify: `pipeline/desktop/stages/s4_write.py` (`write_pending` 시그니처/본문, `main`)
- Test: `pipeline/tests/stages/test_s4_write.py` (재작성)

**Acceptance Criteria:**
- [ ] `write_pending`에 `dropbox`/`notebook_name`/`title_format` 인자 없음; `route_for` 인자 있음
- [ ] Diary 단위 → 노트북 `일기`, 제목 `{date} 리마커블([uuid])`, 본문에 `<link:url>` 없음
- [ ] 슬립 복합 키 `p#0`/`p#1` → 노트북 `[0] Slip-Box`, 제목 `... 上/下([p#0|#1])`, 슬립 스켈레톤
- [ ] 빈/공백 OCR 단위 → Firestore 미기록, written 미등록 (skip 로그)
- [ ] I1 보호(new/overwrite/marker-removed/deleted) 유지, 마커는 복합 키
- [ ] Dropbox 미사용(import/호출 없음)

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s4_write.py -q` → all pass

**Steps:**

- [ ] **Step 1: 테스트 재작성** (`test_s4_write.py` 전체 교체 — 핵심 부분; 기존 status/backfill 테스트는 dropbox 제거 형태로 유지)

```python
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.config import FolderRoute
from desktop.lib.log import StageLogger
from desktop.lib.state import StateFile
from desktop.stages.s4_write import backfill_status, write_pending


@pytest.fixture
def stub_log(tmp_path: Path):
    return StageLogger("s4_write", tmp_path)


def _route_for(source_folder):
    if source_folder == "Slip-Notes":
        return FolderRoute("[0] Slip-Box", "{datetime} 리마커블 {label}([{unit_key}])",
                           split=True, labels=("上", "下"))
    if source_folder == "Notes":
        return FolderRoute("기록", "{date} 리마커블([{unit_key}])")
    return FolderRoute("일기", "{date} 리마커블([{unit_key}])")  # Diary / None default


def _seed_unit(*, tmp_path, prepared, ocr_state, ocr_root, key, source_folder=None,
               text="ocr text", last_modified_ms="1715337600000"):
    png = tmp_path / "png" / key.replace("#", "_") / "page.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    png.write_bytes(b"\x89PNG fake")
    rec = {"prepared_at": "x", "png_path": str(png),
           "metadata": {"lastModified": last_modified_ms}, "source_folder": source_folder}
    prepared.update({key: rec})
    ocr_root.mkdir(parents=True, exist_ok=True)
    (ocr_root / f"{key}.json").write_text(
        json.dumps({"text": text, "model": "m", "prompt_hash": "h", "ts": "t", "uuid": key})
    )
    ocr_state.update({key: {"ocr_at": "now", "model": "m"}})


def _states(tmp_path):
    return (
        StateFile(tmp_path / "state" / "prepared.json"),
        StateFile(tmp_path / "state" / "ocr-done.json"),
        StateFile(tmp_path / "state" / "written.json"),
        StateFile(tmp_path / "state" / "mappings.json"),
        tmp_path / "ocr",
    )


def test_whole_page_diary_note(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Diary")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert out == ["rm-1"]
    payload = fs.set_note.call_args.args[1]
    assert payload["tags"] == ["system:notebook:일기"]
    assert "[rm-1]" in payload["title"]
    assert "<link:url>" not in payload["xmlContent"]
    assert written.contains("rm-1")


def test_slip_halves_two_notes(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    for key in ("p#0", "p#1"):
        _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
                   ocr_root=ocr_root, key=key, source_folder="Slip-Notes")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert sorted(out) == ["p#0", "p#1"]
    titles = [c.args[1]["title"] for c in fs.set_note.call_args_list]
    assert any("上([p#0])" in t for t in titles)
    assert any("下([p#1])" in t for t in titles)
    for c in fs.set_note.call_args_list:
        p = c.args[1]
        assert p["tags"] == ["system:notebook:[0] Slip-Box"]
        assert "이전: 없음" in p["xmlContent"]


def test_empty_ocr_unit_skipped(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#0", source_folder="Slip-Notes", text="실제 글자")
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#1", source_folder="Slip-Notes", text="   \n  ")
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)

    assert out == ["p#0"]
    assert not written.contains("p#1")
    assert fs.set_note.call_count == 1


def test_marker_uses_unit_key_for_overwrite(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="p#0", source_folder="Slip-Notes")
    mappings.write({"p#0": {"tomboy_guid": "existing", "first_seen": "2024-05-10T12:00:00+00:00"}})
    fs = MagicMock()
    fs.get_note.return_value = {"guid": "existing",
                                "title": "2024-05-10 12:00 리마커블 上([p#0])", "deleted": False}

    write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                  written_state=written, mappings=mappings, firestore=fs,
                  log=stub_log, route_for=_route_for)

    assert fs.set_note.call_args.args[0] == "existing"  # overwrote same guid


def test_new_unit_mints_guid(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Notes")
    fs = MagicMock(); fs.get_note.return_value = None

    write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                  written_state=written, mappings=mappings, firestore=fs,
                  log=stub_log, route_for=_route_for)
    new_guid = fs.set_note.call_args.args[0]
    assert mappings.get("rm-1")["tomboy_guid"] == new_guid
    assert fs.set_note.call_args.args[1]["tags"] == ["system:notebook:기록"]


def test_skips_already_written(tmp_path, stub_log):
    prepared, ocr_state, written, mappings, ocr_root = _states(tmp_path)
    _seed_unit(tmp_path=tmp_path, prepared=prepared, ocr_state=ocr_state,
               ocr_root=ocr_root, key="rm-1", source_folder="Notes")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": ""}})
    fs = MagicMock(); fs.get_note.return_value = None

    out = write_pending(ocr_root=ocr_root, prepared_state=prepared, ocr_state=ocr_state,
                        written_state=written, mappings=mappings, firestore=fs,
                        log=stub_log, route_for=_route_for)
    assert out == []
    fs.set_note.assert_not_called()


def test_backfill_skips_when_status_unavailable(tmp_path, stub_log):
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    written = StateFile(tmp_path / "state" / "written.json")
    written.write({"rm-1": {"written_at": "x", "tomboy_guid": "g", "image_url": ""}})
    n = backfill_status(written_state=written, prepared_state=prepared,
                        ocr_root=tmp_path / "ocr", status=None, log=stub_log)
    assert n == 0
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s4_write.py -q` → FAIL (`write_pending() got unexpected keyword argument 'route_for'`)

- [ ] **Step 3: `s4_write.py` import 교체** — Dropbox import 제거, keys import 추가

`from desktop.lib.dropbox_uploader import DropboxUploader` 줄 삭제. 상단에 추가:

```python
from desktop.lib.config import FolderRoute
from desktop.lib.keys import half_index_of, page_uuid_of
```

`_Dropbox` Protocol(라인 37-39) 삭제.

- [ ] **Step 4: `write_pending` 교체** (`s4_write.py:175-304`)

```python
def write_pending(
    *,
    ocr_root: Path,
    prepared_state: StateFile,
    ocr_state: StateFile,
    written_state: StateFile,
    mappings: StateFile,
    firestore: _Firestore,
    log: StageLogger,
    route_for: "Callable[[str | None], FolderRoute]",
    force: Iterable[str] | None = None,
    status: _PipelineStatus | None = None,
) -> list[str]:
    force = set(force or [])
    for u in force:
        written_state.remove(u)

    processed: list[str] = []
    prepared_index = prepared_state.read()

    for unit_key, _ in ocr_state.read().items():
        if written_state.contains(unit_key):
            continue
        ocr_path = ocr_root / f"{unit_key}.json"
        prep = prepared_index.get(unit_key)
        if not ocr_path.exists() or prep is None:
            log.error("inputs_missing", uuid=unit_key)
            continue
        try:
            ocr_data = json.loads(ocr_path.read_text(encoding="utf-8"))
            ocr_text = ocr_data["text"]
            if not ocr_text.strip():
                # 빈/공백 OCR(예: 카드 한쪽만 작성) → 노트 생성 건너뜀. 다음
                # 실행에서 cheap-skip; 카드를 채우고 재OCR하면 mtime-bump
                # 캐스케이드로 다시 처리된다.
                log.info("skipped_empty", uuid=unit_key)
                continue

            metadata = prep["metadata"]
            source_folder = prep.get("source_folder")
            route = route_for(source_folder)
            change_dt = _ms_to_dt(metadata["lastModified"])
            page_uuid = page_uuid_of(unit_key)
            half = half_index_of(unit_key)
            label = (
                route.labels[half]
                if route.split and half is not None and half < len(route.labels)
                else ""
            )
            existing_mapping = mappings.get(unit_key)
            create_dt = (
                datetime.fromisoformat(existing_mapping["first_seen"])
                if existing_mapping and "first_seen" in existing_mapping
                else change_dt
            )

            # I1 알고리즘 — 마커는 복합 키(unit_key).
            target_guid, is_new = _resolve_target_guid(
                rm_uuid=unit_key, mappings=mappings, firestore=firestore
            )

            # metadata_change_date=now (I13): 재OCR 시 app conflictResolver가
            # remote를 당기도록. changeDate는 rM mtime 유지(제목 날짜·정렬).
            payload = build_payload(
                guid=target_guid,
                page_uuid=page_uuid,
                unit_key=unit_key,
                ocr_text=ocr_text,
                notebook_name=route.notebook,
                title_format=route.title_format,
                create_date=create_dt,
                change_date=change_dt,
                metadata_change_date=datetime.now(timezone.utc),
                label=label,
                slip=route.split,
            )

            firestore.set_note(target_guid, payload)

            mappings.update(
                {unit_key: {"tomboy_guid": target_guid, "first_seen": create_dt.isoformat()}}
            )
            written_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            written_state.update(
                {unit_key: {"written_at": written_at, "tomboy_guid": target_guid, "image_url": ""}}
            )
            if status is not None:
                try:
                    fields = _status_for_uuid(
                        rm_uuid=unit_key,
                        written_entry={
                            "written_at": written_at,
                            "tomboy_guid": target_guid,
                            "image_url": "",
                        },
                        prep_entry=prep,
                        ocr_root=ocr_root,
                    )
                    status.set(unit_key, fields)
                    status.clear_rerun(unit_key)
                except Exception as e:
                    log.error("status_write_failed", uuid=unit_key, reason=str(e))
            log.info("wrote_note", uuid=unit_key, guid=target_guid, is_new=is_new)
            processed.append(unit_key)
        except Exception as e:
            log.error("write_failed", uuid=unit_key, reason=str(e))
    return processed
```

`Callable` import가 상단 `from typing import ...`에 있는지 확인(없으면 추가).

- [ ] **Step 5: `main()` 갱신** (`s4_write.py:307-361`) — Dropbox 생성 제거, `route_for` 주입

`dbx = DropboxUploader(...)` 줄 삭제. `write_pending(...)` 호출에서 `firestore=fs, dropbox=dbx, ... notebook_name=..., title_format=...` 를 다음으로 교체:

```python
    processed = write_pending(
        ocr_root=ocr_root,
        prepared_state=prepared,
        ocr_state=ocr_state,
        written_state=written,
        mappings=mappings,
        firestore=fs,
        log=log,
        route_for=cfg.tomboy.route_for,
        force=set(args.force) | set(rerun_uuids),
        status=status,
    )
```

- [ ] **Step 6: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s4_write.py -q` → PASS

- [ ] **Step 7: 커밋**

```bash
git add pipeline/desktop/stages/s4_write.py pipeline/tests/stages/test_s4_write.py
git commit -m "feat(pipeline): s4 Dropbox 제거 + route 기반 노트북/제목 + 슬립 스켈레톤 + 빈 OCR 건너뛰기"
```

---

### Task 7: s1_fetch — 복합 키 캐스케이드

**Goal:** 재페치/force 시 하위 상태(prepared/ocr-done/written)에서 page-uuid와 그 복합 키(`uuid#*`)를 함께 비워 가필한 슬립 페이지가 끝까지 재처리되게 한다.

**Files:**
- Modify: `pipeline/desktop/stages/s1_fetch.py:103-130` (`fetch`의 force/재페치 캐스케이드)
- Test: `pipeline/tests/stages/test_s1_fetch.py` (추가)

**Acceptance Criteria:**
- [ ] mtime bump 재페치 시 하위 상태에서 `uuid`와 `uuid#0`/`uuid#1`가 모두 제거된다
- [ ] `--force uuid` 시도 동일하게 하위 복합 키까지 제거
- [ ] 기존 s1 테스트 전부 통과

**Verify:** `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s1_fetch.py -q` → all pass

**Steps:**

- [ ] **Step 1: 테스트 추가** (`test_s1_fetch.py` 하단)

```python
def test_refetch_cascade_clears_composite_keys(tmp_path):
    from desktop.lib.log import StageLogger
    from desktop.lib.state import StateFile
    from desktop.stages.s1_fetch import FakeTransport, fetch

    raw_root = tmp_path / "raw"
    state = StateFile(tmp_path / "state" / "fetched.json")
    # Already fetched at mtime 100.
    state.write({"slip": {"fetched_at": "x", "source_mtime": 100}})
    prepared = StateFile(tmp_path / "state" / "prepared.json")
    prepared.write({"slip#0": {"a": 1}, "slip#1": {"b": 2}})
    ocr = StateFile(tmp_path / "state" / "ocr-done.json")
    ocr.write({"slip#0": {"c": 3}, "slip#1": {"d": 4}})
    log = StageLogger("s1_fetch", tmp_path)

    # Pi index reports a NEWER mtime → re-fetch.
    transport = FakeTransport(
        index={"slip": {"present": True, "mtime": 200}},
        files={"slip": {"slip.rm": b"\x00", "slip.metadata": b"{}"}},
    )

    fetch(raw_root=raw_root, state=state, log=log, transport=transport,
          downstream_states=[prepared, ocr])

    # Both composite keys cleared from downstream so s2/s3 reprocess.
    assert prepared.read() == {}
    assert ocr.read() == {}
```

- [ ] **Step 2: 실패 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s1_fetch.py::test_refetch_cascade_clears_composite_keys -q` → FAIL (하위에 `slip#0`/`slip#1` 잔존)

- [ ] **Step 3: `fetch`의 캐스케이드를 `remove_page`로 교체** (`s1_fetch.py`)

force 루프(라인 105-108):

```python
    for u in force:
        state.remove(u)
        for s in downstream:
            s.remove_page(u)
```

mtime-bump 재페치 블록(라인 128-130):

```python
            state.remove(uuid)
            for s in downstream:
                s.remove_page(uuid)
```

- [ ] **Step 4: 통과 확인** — `cd pipeline && .venv/bin/python -m pytest tests/stages/test_s1_fetch.py -q` → PASS (신규 + 기존)

- [ ] **Step 5: 커밋**

```bash
git add pipeline/desktop/stages/s1_fetch.py pipeline/tests/stages/test_s1_fetch.py
git commit -m "fix(pipeline): s1 재페치 캐스케이드가 복합 키(uuid#*)까지 비우도록"
```

---

### Task 8: rM 푸시 스크립트 — 다중 폴더 + sourceFolder (README)

**Goal:** `pipeline/pi/README.md`의 정본 푸시 스크립트를 Diary/Notes/Slip-Notes 3폴더 루프로 교체하고 metadata에 `sourceFolder`를 넣는다.

**Files:**
- Modify: `pipeline/pi/README.md:223-329` ("### 2. Push script" 블록 + 본문 설명)

**Acceptance Criteria:**
- [ ] 스크립트가 `Diary Notes Slip-Notes` 각각을 CollectionType+visibleName으로 찾는다
- [ ] 각 폴더의 DocumentType 자식(PDF 제외) 페이지를 스테이징
- [ ] 합성 metadata에 `"sourceFolder": "<folder>"` 포함
- [ ] page-uuid 전역 유일 가정/평탄 inbox 설명 유지

**Verify:** 셸 스크립트는 자동 테스트 없음. `bash -n` 으로 문법만 확인 → `bash -n <(편집한 스크립트 블록을 추출)`; 그리고 사람 리뷰.

**Steps:**

- [ ] **Step 1: "### 2. Push script" 의 데이터 모델 설명 갱신** — "A folder visibly named **\"Diary\"** ..." 단락을 "Three folders — **Diary**, **Notes**, **Slip-Notes** — (each `CollectionType`) ... 각 페이지 metadata에 `sourceFolder`를 실어 데스크탑이 폴더별 라우팅(노트북/제목/슬립 분할)을 한다." 로 교체.

- [ ] **Step 2: 스크립트 본문 교체** (` ```bash ... ``` ` 블록 전체)

```sh
#!/bin/sh
# Push pages from each target reMarkable folder to the Pi inbox as flat
# <page-uuid>.{rm,metadata} pairs. Each .metadata stub carries `sourceFolder`
# so the desktop pipeline routes per folder (notebook, title, slip-split).
#
# rM userland is busybox + dropbear:
#   - `head -n 1` (busybox rejects `-1`)
#   - `-y` for accept-new-hostkey (dropbear has no `-o StrictHostKeyChecking`)

SRC=/home/root/.local/share/remarkable/xochitl/
DEST=diary-sync@<PI-HOST>:diary/inbox/
SSH_E="ssh -p 2222 -i /home/root/.ssh/id_diary -y"
STAGING=/tmp/diary-push-staging
TARGET_FOLDERS="Diary Notes Slip-Notes"

rm -rf "$STAGING"
mkdir -p "$STAGING"
count=0

for folder in $TARGET_FOLDERS; do
    # 1. Find the folder (CollectionType, visibleName == "$folder").
    folder_uuid=""
    for meta in "$SRC"*.metadata; do
        if grep -q "\"visibleName\": \"$folder\"" "$meta" \
           && grep -q '"type": "CollectionType"' "$meta"; then
            folder_uuid="$(basename "$meta" .metadata)"
            break
        fi
    done
    if [ -z "$folder_uuid" ]; then
        echo "No '$folder' folder (CollectionType) found"
        continue
    fi

    # 2. Stage pages of every native DocumentType notebook inside it. Skip PDFs.
    for meta in "$SRC"*.metadata; do
        grep -q '"type": "DocumentType"' "$meta" || continue
        grep -q "\"parent\": \"$folder_uuid\"" "$meta" || continue

        nb_uuid="$(basename "$meta" .metadata)"
        nb_dir="$SRC$nb_uuid"
        [ -d "$nb_dir" ] || continue

        content="$SRC$nb_uuid.content"
        if [ -f "$content" ] && grep -q '"fileType":[[:space:]]*"pdf"' "$content"; then
            continue
        fi

        for rm_file in "$nb_dir"/*.rm; do
            [ -f "$rm_file" ] || continue
            page_uuid="$(basename "$rm_file" .rm)"
            cp -p "$rm_file" "$STAGING/$page_uuid.rm"
            mtime_secs="$(stat -c %Y "$rm_file")"
            mtime_ms="$((mtime_secs * 1000))"
            cat > "$STAGING/$page_uuid.metadata" <<EOF
{
    "lastModified": "$mtime_ms",
    "notebookUuid": "$nb_uuid",
    "visibleName": "$folder",
    "sourceFolder": "$folder",
    "type": "PageType"
}
EOF
            touch -r "$rm_file" "$STAGING/$page_uuid.metadata"
            count=$((count + 1))
        done
    done
done

echo "Staged $count page(s) under $STAGING"
[ "$count" -eq 0 ] && exit 0

rsync -avz -e "$SSH_E" "$STAGING"/ "$DEST"
echo "Push complete: $count page(s) sent"
```

- [ ] **Step 3: "Verify" 섹션(README 하단) 갱신** — "Draw a new page ... in the Diary notebook" → "in any of the Diary / Notes / Slip-Notes folders". Slip-Notes는 한 화면에 위/아래 2장 작성 시 노트 2개가 생긴다는 한 줄 추가.

- [ ] **Step 4: 문법 확인** — 스크립트 블록을 임시 파일로 저장 후 `bash -n /tmp/diary-push.sh` → 출력 없음(통과). (busybox sh 대상이지만 bash -n로 기본 문법 확인.)

- [ ] **Step 5: 커밋**

```bash
git add pipeline/pi/README.md
git commit -m "docs(pipeline): rM 푸시 스크립트 다중 폴더(Diary/Notes/Slip-Notes) + sourceFolder"
```

---

### Task 9: tomboy-diary 스킬 문서 갱신

**Goal:** 스킬 본문에 다중 폴더 수집, 슬립 분할(작업단위 키), 이미지 폐지를 반영해 다음 세션이 새 불변식을 알게 한다.

**Files:**
- Modify: `.claude/skills/tomboy-diary/SKILL.md`

**Acceptance Criteria:**
- [ ] I1 항목에 "작업단위 키(uuid | uuid#half)" 일반화 반영
- [ ] I3(폴더) 항목이 3폴더 + sourceFolder 반영
- [ ] 이미지 폐지(`<link:url>`/Dropbox 제거) 반영, I5/I13/§ 관련 문구 갱신
- [ ] 슬립 분할(s2, PAGE_HEIGHT//2 + 빈띠 스냅, lib/raster) + 빈 건너뛰기 + 슬립 스켈레톤 추가
- [ ] config 폴더 라우팅(route_for) 언급, 파일 맵에 keys.py/raster.py 추가

**Verify:** 사람 리뷰(스킬 본문이 실제 코드와 모순 없는지). 자동 테스트 없음.

**Steps:**

- [ ] **Step 1: I1 갱신** — "Page UUID is the universal key" → 일반화. 다음 문장 추가: "분할 폴더(Slip-Notes)는 페이지당 2 작업단위 `<uuid>#0`/`<uuid>#1`. 이 단위 키가 상태/마커/매핑 단위. 비분할은 page-uuid와 동일(기존 매핑 호환)." `page_uuid_of`/`unit_keys_for_page`(`lib/keys.py`) 언급.

- [ ] **Step 2: I3 갱신** — "rM \"Diary\" is a FOLDER" → "Diary/Notes/Slip-Notes 세 FOLDER. 푸시 스크립트가 `TARGET_FOLDERS` 루프로 각각 찾고 metadata에 `sourceFolder` 스탬프. 데스크탑은 `cfg.tomboy.route_for(sourceFolder)`로 노트북/제목/분할 결정."

- [ ] **Step 3: 이미지 폐지 반영** — I5("image URL must be wrapped in `<link:url>`")를 "이미지 폐지됨 — 본문은 OCR 텍스트만. Dropbox 업로드/`<link:url>` 제거(2026-06-14)."로 교체. I13은 유지(metadataChangeDate=now 여전히 필요)하되 "image" 언급 정리. §9 deferred의 image 관련 항목 갱신.

- [ ] **Step 4: 새 항목 추가** — "I17. 슬립 분할" : s2가 `PAGE_HEIGHT//2`(936) 타깃 + `lib/raster.find_blank_row_near` 스냅으로 위/아래 크롭, `canvas_h>PAGE_HEIGHT`면 `split_scroll_warning` 로그, 빈 OCR 단위는 s4가 `skipped_empty`로 건너뜀, 슬립 본문은 `validateSlipNoteFormat` 스켈레톤(제목/공백/이전:없음/다음:없음/공백/OCR), 제목 `yyyy-mm-dd HH:mm …`라 `isSlipNoteTitle` 인식.

- [ ] **Step 5: 파일 맵 갱신** — `lib/keys.py`, `lib/raster.py` 추가; `tomboy_payload.py`/`s2_prepare.py`/`s4_write.py` 설명 갱신(이미지 제거·분할·route). config에 `FolderRoute`/`folders`/`route_for` 추가.

- [ ] **Step 6: 설계/계획 문서 링크 추가** — 상단 설계 doc 목록에 `2026-06-14-remarkable-multifolder-ocr-design.md` 추가.

- [ ] **Step 7: 커밋**

```bash
git add .claude/skills/tomboy-diary/SKILL.md
git commit -m "docs(tomboy-diary): 다중 폴더 + 슬립 분할(작업단위 키) + 이미지 폐지 반영"
```

---

## 전체 검증

모든 태스크 후:

```bash
cd pipeline && .venv/bin/python -m pytest tests/ -q
```

기대: 전부 통과(기존 + 신규). PIL/rmscene 미설치 환경에서는 해당 테스트가 `importorskip`으로 skip되며 나머지는 통과.

## 자가 검토 메모 (작성자)

- **스펙 커버리지**: 3폴더 수집(T3,T8) · 슬립 분할(T5) · 이미지 폐지(T4,T6) · 작업단위 키(T1) · 빈 건너뛰기(T6) · s1 캐스케이드(T7) · 슬립 스켈레톤/제목(T4) · raster 공유(T2) · 문서(T8,T9). 설계 §4.8 어드민 경량 변경은 이미지가 빈 값이면 자동 처리(별도 코드 변경 불요 — image_url=""이 흐름) → 앱 어드민 썸네일 숨김은 앱이 빈 URL을 안전 렌더하면 됨; 현재 동작 깨지지 않으므로 본 계획 범위에서 제외(필요 시 후속).
- **타입 일관성**: `route_for(source_folder) -> FolderRoute` 시그니처가 T3/T5/T6 일치. `unit_key`/`page_uuid`/`label`/`slip` 인자명 T4/T6 일치. `remove_page` T1 정의 → T5/T7 사용.
- **마이그레이션**: 기존 Diary 매핑은 비분할이라 키 그대로 호환. 기존 노트의 이미지 링크 제거는 선택(설계 §9): `rm state/written.json && s4_write` 재실행.
