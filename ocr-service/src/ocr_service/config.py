"""Process-wide configuration sourced from environment variables.

Keep this trivial: the service is a single process and the values are
read once at startup. Tests override by monkeypatching `settings`."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    shared_token: str
    model_id: str
    idle_unload_s: int
    device: str

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.environ.get("BRIDGE_SHARED_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "BRIDGE_SHARED_TOKEN env var is required — refusing to start "
                "an unauthenticated OCR service."
            )
        return cls(
            shared_token=token,
            model_id=os.environ.get("OCR_MODEL_ID", "stepfun-ai/GOT-OCR2_0"),
            idle_unload_s=int(os.environ.get("OCR_IDLE_UNLOAD_S", "300")),
            device=os.environ.get("OCR_DEVICE", "cuda:0"),
        )


settings: Settings | None = None


def get_settings() -> Settings:
    """Lazy accessor. Initialized on first call (or in tests by patching)."""
    global settings
    if settings is None:
        settings = Settings.from_env()
    return settings
