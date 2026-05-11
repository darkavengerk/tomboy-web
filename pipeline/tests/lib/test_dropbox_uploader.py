from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.lib.dropbox_uploader import DropboxUploader, _to_inline_url


@pytest.fixture
def mock_dbx(mocker):
    dbx_module = mocker.patch("desktop.lib.dropbox_uploader.dropbox")
    client = MagicMock()
    dbx_module.Dropbox.return_value = client
    return dbx_module, client


def test_construct_passes_refresh_token(mock_dbx):
    dbx_module, _ = mock_dbx
    DropboxUploader("refresh-tok", "app-key")
    dbx_module.Dropbox.assert_called_once()
    kwargs = dbx_module.Dropbox.call_args.kwargs
    assert kwargs["oauth2_refresh_token"] == "refresh-tok"
    assert kwargs["app_key"] == "app-key"


def test_upload_writes_bytes(mock_dbx, tmp_path: Path):
    _, client = mock_dbx
    f = tmp_path / "p.png"
    f.write_bytes(b"PNGDATA")
    u = DropboxUploader("t", "k")
    u.upload(f, "/Apps/Tomboy/diary-images/2024/05/10/abc/page.png")
    args = client.files_upload.call_args
    assert args.args[0] == b"PNGDATA"
    assert args.args[1] == "/Apps/Tomboy/diary-images/2024/05/10/abc/page.png"


def test_share_link_returns_url_for_new_link(mock_dbx):
    _, client = mock_dbx
    client.sharing_create_shared_link_with_settings.return_value = MagicMock(
        url="https://www.dropbox.com/scl/fi/abc/page.png?rlkey=xyz&dl=0"
    )
    u = DropboxUploader("t", "k")
    url = u.share_link("/Apps/Tomboy/diary-images/2024/05/10/abc/page.png")
    # `?dl=0` returns Dropbox's HTML preview page — useless as an inline
    # image source. We rewrite to `?raw=1` so the URL serves raw bytes.
    assert "raw=1" in url
    assert "dl=0" not in url
    assert "rlkey=xyz" in url  # other params preserved


def test_share_link_falls_back_to_existing_when_already_shared(mock_dbx, mocker):
    dbx_module, client = mock_dbx

    # Simulate Dropbox SDK raising shared_link_already_exists
    class ApiError(Exception):
        pass

    dbx_module.exceptions.ApiError = ApiError

    err_inst = ApiError()
    err_inst.error = MagicMock()
    err_inst.error.is_shared_link_already_exists = MagicMock(return_value=True)
    client.sharing_create_shared_link_with_settings.side_effect = err_inst

    existing = MagicMock()
    existing.links = [MagicMock(url="https://www.dropbox.com/existing/page.png?dl=0")]
    client.sharing_list_shared_links.return_value = existing

    u = DropboxUploader("t", "k")
    url = u.share_link("/path.png")
    assert "existing" in url
    # The fallback (existing-link) path must also normalize to raw=1.
    assert "raw=1" in url
    assert "dl=0" not in url


def test_to_inline_url_strips_dl_and_appends_raw():
    assert (
        _to_inline_url("https://www.dropbox.com/scl/fi/abc/page.png?rlkey=k&dl=0")
        == "https://www.dropbox.com/scl/fi/abc/page.png?rlkey=k&raw=1"
    )


def test_to_inline_url_collapses_existing_raw_and_dl_params():
    # Defensive: if a URL already has raw=N or both raw and dl, output is
    # exactly one raw=1 with no dl.
    out = _to_inline_url("https://www.dropbox.com/x.png?rlkey=k&raw=0&dl=1")
    parsed = dict(part.split("=", 1) for part in out.split("?", 1)[1].split("&"))
    assert parsed == {"rlkey": "k", "raw": "1"}


def test_to_inline_url_preserves_other_query_params():
    out = _to_inline_url(
        "https://www.dropbox.com/scl/fi/abc/page.png?rlkey=ogy7gao0&token=xyz&dl=0"
    )
    assert "rlkey=ogy7gao0" in out
    assert "token=xyz" in out
    assert "raw=1" in out
