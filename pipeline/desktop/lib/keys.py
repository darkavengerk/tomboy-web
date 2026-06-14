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
