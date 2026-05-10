"""Dropbox file upload + share-link wrapper using a refresh token."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import dropbox


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
            return res.url
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
            return existing.links[0].url
