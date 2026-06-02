import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
  getDefaultTerminalBridge: vi.fn(),
  getTerminalBridgeToken: vi.fn(),
  bridgeToHttpBase: (b: string) => `https://${b.replace(/^wss?:\/\//, '')}`
}));

import { runAutomation, AutomationError } from '$lib/automation/runAutomation.js';
import { getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  (getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://host/ws');
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});
afterEach(() => { globalThis.fetch = realFetch; vi.clearAllMocks(); });

it('throws not_configured when bridge or token missing', async () => {
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
});

it('returns results+errors on 200', async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ results: { tomboy: 'a\n1\n' }, errors: { robotC: '타임아웃' } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )) as typeof fetch;
  const out = await runAutomation({ command: 'loc-history' });
  expect(out).toEqual({ results: { tomboy: 'a\n1\n' }, errors: { robotC: '타임아웃' } });
});

it('maps 401 to unauthorized', async () => {
  globalThis.fetch = (async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'unauthorized' });
});

it('maps 400 unknown_command', async () => {
  globalThis.fetch = (async () => new Response('{"error":"unknown_command"}', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'unknown_command' });
});

it('maps 503 to service_unavailable', async () => {
  globalThis.fetch = (async () => new Response('{"error":"automation_service_unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await expect(runAutomation({ command: 'x' })).rejects.toMatchObject({ kind: 'service_unavailable' });
});
