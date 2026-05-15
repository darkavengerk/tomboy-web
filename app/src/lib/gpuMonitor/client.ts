import type { GpuStatusResponse, UnloadRequest } from './types.js';

export class GpuMonitorError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
		this.name = 'GpuMonitorError';
	}
}

/**
 * Normalise the user-stored bridge URL into an HTTP(S) base usable for
 * the bridge's REST endpoints.
 *
 * Accepts ws://, wss://, http://, https:// (with or without trailing
 * known paths). Strips trailing /ws, /llm/chat, /ocr, and /gpu/<anything>
 * so the caller can append /gpu/status or /gpu/unload cleanly.
 */
function httpBase(bridgeUrl: string): string {
	return bridgeUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/(ws|llm\/chat|ocr|gpu\/[a-z]+)\/?$/, '')
		.replace(/\/$/, '');
}

export async function fetchGpuStatus(
	bridgeUrl: string,
	token: string
): Promise<GpuStatusResponse> {
	const resp = await fetch(`${httpBase(bridgeUrl)}/gpu/status`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!resp.ok) {
		throw new GpuMonitorError(`status ${resp.status}`, resp.status);
	}
	return (await resp.json()) as GpuStatusResponse;
}

export async function unloadModel(
	bridgeUrl: string,
	token: string,
	req: UnloadRequest
): Promise<{ ok: boolean; status: number; message?: string }> {
	const resp = await fetch(`${httpBase(bridgeUrl)}/gpu/unload`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify(req)
	});
	if (resp.ok) return { ok: true, status: resp.status };
	const body = await resp.json().catch(() => ({}));
	return {
		ok: false,
		status: resp.status,
		message: (body as { error?: string }).error
	};
}
