"""Background idle watcher.

Polls the engine's `last_called_at` every N seconds; if the model has
been idle longer than `idle_unload_s`, calls `engine.unload()`. Uses a
clock callable (default `time.time`) so tests can substitute a fake."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from .model import OcrEngine

log = logging.getLogger(__name__)


async def idle_watcher(
    engine: OcrEngine,
    idle_unload_s: int,
    poll_interval_s: float = 5.0,
    clock: Callable[[], float] | None = None,
) -> None:
    """Run forever (cancelled on app shutdown). Unloads the model on idle.

    Caller does `asyncio.create_task(idle_watcher(...))` on startup.
    The `clock` parameter is for tests; production uses `time.time`."""
    tick = clock or time.time
    while True:
        await asyncio.sleep(poll_interval_s)
        try:
            if not engine.runner.is_loaded():
                continue
            idle_for = tick() - engine.last_called_at
            if idle_for >= idle_unload_s and engine.unload():
                log.info("idle unload after %.0fs", idle_for)
        except Exception:
            # Don't let one failed poll kill the watcher — log and keep
            # going. A torch hiccup during empty_cache() shouldn't disable
            # idle unload for the rest of the process's lifetime.
            log.exception("idle_watcher iteration failed")
