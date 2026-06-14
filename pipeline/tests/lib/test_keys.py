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
