import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchBridgeStatus, BridgeStatusError } from '$lib/bridgeStatus/statusClient.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'https://bridge.example'),
	getTerminalBridgeToken: vi.fn(async () => 'tok'),
	bridgeToHttpBase: (b: string) => b.replace(/\/$/, '')
}));
import * as bs from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});
beforeEach(() => {
	(bs.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('https://bridge.example');
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});

const OK = {
	fetched_at: '2026-06-19T01:48:00.000Z',
	system: { uptime_s: 1, load: [0], cpu_count: 1, cpu_temp_c: null, mem_total_bytes: 1, mem_used_bytes: 0 },
	disks: [],
	services: [{ name: 'ocr', status: 'up', latency_ms: 1 }],
	files: { count: 0, total_bytes: 0, latest_mtime: null },
	connections: { spectator_sessions: 0, folder_cache: 0, hosts_ssh: 0, hosts_remarkable: 0, hosts_wol: 0 },
	bridge: { port: 3000, uptime_s: 1, node: 'v22', public_host: 'b.ex' }
};

it('미설정이면 not_configured + fetch 미호출', async () => {
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	const spy = vi.fn();
	globalThis.fetch = spy as unknown as typeof fetch;
	await expect(fetchBridgeStatus()).rejects.toMatchObject({ kind: 'not_configured' });
	expect(spy).not.toHaveBeenCalled();
});

it('성공 응답 파싱 + GET /status + Bearer', async () => {
	let url = '';
	let auth = '';
	let method = '';
	globalThis.fetch = (async (u: string, init: RequestInit) => {
		url = String(u);
		auth = (init.headers as Record<string, string>).Authorization;
		method = init.method ?? 'GET';
		return new Response(JSON.stringify(OK), { status: 200 });
	}) as unknown as typeof fetch;
	const out = await fetchBridgeStatus();
	expect(out.services[0].name).toBe('ocr');
	expect(out.bridge.port).toBe(3000);
	expect(url).toBe('https://bridge.example/status');
	expect(auth).toBe('Bearer tok');
	expect(method).toBe('GET');
});

it.each([
	[401, 'unauthorized'],
	[503, 'service_unavailable'],
	[500, 'upstream_error'],
	[404, 'bad_request']
])('상태 %i → %s', async (status, kind) => {
	globalThis.fetch = (async () => new Response('{}', { status })) as unknown as typeof fetch;
	await expect(fetchBridgeStatus()).rejects.toMatchObject({ kind });
});

it('네트워크 오류 → network', async () => {
	globalThis.fetch = (async () => {
		throw new Error('boom');
	}) as unknown as typeof fetch;
	await expect(fetchBridgeStatus()).rejects.toMatchObject({ kind: 'network' });
});

it('잘못된 JSON 본문 → upstream_error', async () => {
	globalThis.fetch = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
	await expect(fetchBridgeStatus()).rejects.toBeInstanceOf(BridgeStatusError);
});

it('signal 전달', async () => {
	let sig: AbortSignal | undefined;
	globalThis.fetch = (async (_u: string, init: RequestInit) => {
		sig = init.signal as AbortSignal | undefined;
		return new Response(JSON.stringify(OK), { status: 200 });
	}) as unknown as typeof fetch;
	const ctrl = new AbortController();
	await fetchBridgeStatus({ signal: ctrl.signal });
	expect(sig).toBe(ctrl.signal);
});
