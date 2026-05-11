"""Dropbox file upload + share-link wrapper using a refresh token."""
from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

import dropbox


def _to_inline_url(url: str) -> str:
    """Rewrite a Dropbox share URL to return raw bytes instead of the preview page.

    Dropbox's SDK returns share links with ``?dl=0`` by default, which
    resolves to the Dropbox preview HTML — fine for click-through but
    useless inside an ``<img src>`` or anywhere expecting raw image
    bytes. ``?raw=1`` returns the file content directly, which is what
    the Tomboy note body needs so the image actually loads.

    ``?dl=0`` → ``?raw=1`` , preserving every other query param. Any
    pre-existing ``raw`` or ``dl`` is normalized to a single ``raw=1``.
    """
    parts = urllib.parse.urlsplit(url)
    qs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    qs = [(k, v) for k, v in qs if k not in ("dl", "raw")]
    qs.append(("raw", "1"))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(qs), parts.fragment)
    )


class DropboxUploader:
    def __init__(self, refresh_token: str, app_key: str) -> None:
        self._client = dropbox.Dropbox(
            oauth2_refresh_token=refresh_token, app_key=app_key
        )

    def upload(self, local_path: Path | str, target_path: str) -> Any:
        data = Path(local_path).read_bytes()
        return self._client.files_upload(
            data,
            target_path,
            mode=dropbox.files.WriteMode.overwrite,
            mute=True,
        )

    def share_link(self, target_path: str) -> str:
        try:
            res = self._client.sharing_create_shared_link_with_settings(target_path)
            return _to_inline_url(res.url)
        except dropbox.exceptions.ApiError as e:
            # Already shared — fetch the existing link
            err = getattr(e, "error", None)
            already = (
                err is not None
                and hasattr(err, "is_shared_link_already_exists")
                and err.is_shared_link_already_exists()
            )
            if not already:
                raise
            existing = self._client.sharing_list_shared_links(path=target_path)
            if not existing.links:
                raise
            return _to_inline_url(existing.links[0].url)
