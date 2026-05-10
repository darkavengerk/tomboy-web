"""Shared pytest fixtures for the pipeline test suite."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A temporary data root mimicking the runtime layout."""
    for sub in ("raw", "png", "ocr", "state", "logs", "corrections"):
        (tmp_path / sub).mkdir()
    return tmp_path


@pytest.fixture
def sample_metadata() -> dict:
    """A minimal rM .metadata JSON shape used across tests."""
    return {
        "deleted": False,
        "lastModified": "1715337600000",  # 2024-05-10T12:00:00Z in ms epoch
        "metadatamodified": False,
        "modified": False,
        "parent": "diary-folder-uuid",
        "pinned": False,
        "synced": True,
        "type": "DocumentType",
        "version": 1,
        "visibleName": "Diary Page 2024-05-10",
    }


@pytest.fixture
def sample_page_uuid() -> str:
    return "abc-123-def-456"
