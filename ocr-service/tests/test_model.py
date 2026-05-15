"""Engine + idle-watcher unit tests.

The real GOT-OCR2 model is never touched — uses FakeRunner from
tests/_fakes.py."""
from __future__ import annotations

import asyncio

import pytest

from ocr_service.idle import idle_watcher
from ocr_service.model import OcrEngine

from ._fakes import FakeRunner


def test_engine_load_on_first_run() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    assert not runner.is_loaded()
    engine.run("xx")
    assert runner.is_loaded()
    assert engine.last_called_at > 0


def test_engine_unload_when_idle() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")
    assert engine.unload() is True
    assert not runner.is_loaded()


def test_engine_unload_refuses_in_flight() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    runner._loaded = True  # simulate currently-loaded model
    engine._in_flight = 1
    assert engine.unload() is False
    assert runner.is_loaded() is True


async def test_idle_watcher_unloads_after_threshold() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")  # loads runner; sets last_called_at

    fake_now = engine.last_called_at + 999.0
    clock = lambda: fake_now

    task = asyncio.create_task(
        idle_watcher(engine, idle_unload_s=60, poll_interval_s=0.01, clock=clock)
    )
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert not runner.is_loaded()


async def test_idle_watcher_does_not_unload_fresh_call() -> None:
    runner = FakeRunner()
    engine = OcrEngine(runner=runner)
    engine.run("xx")

    fake_now = engine.last_called_at + 1.0
    clock = lambda: fake_now

    task = asyncio.create_task(
        idle_watcher(engine, idle_unload_s=60, poll_interval_s=0.01, clock=clock)
    )
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert runner.is_loaded()
