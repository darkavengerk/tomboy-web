import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

/**
 * GPU status + unload fan-out across the desktop's ocr-service and Ollama.
 *
 * The bridge sits on the Pi and is the only network surface the app talks
 * to; the desktop services live on a private LAN. So both /gpu/status and
 * (Task 6's) /gpu/unload are bridge endpoints that fan out to:
 *
 *   - ocr-service /gpu/raw      → physical VRAM totals + per-PID usage
 *   - ocr-service /status       → got-ocr2 loaded/in_flight/last_called_at
 *   - Ollama /api/ps            → currently-loaded LLM models
 *
 * Auth: client presents a Bearer minted by /login. The bridge re-Bearers
 * its own `BRIDGE_SECRET` to the ocr-service (Ollama runs unauthenticated
 * on a local socket).
 *
 * Partial-failure policy: each upstream is wrapped in `fetchJson`, which
 * swallows network errors and non-2xx responses and returns `null`. The
 * response always 200s and exposes `*_available` booleans so the UI can
 * hide sections it can't trust.
 */

interface OllamaPsModel {
	name: string;
	size_vram?: number;
	expires_at?: string;
}

interface OcrStatus {
	loaded: boolean;
	last_called_at: number;
	in_flight: number;
}

interface OcrGpuRaw {
	available: boolean;
	total_mb?: number;
	used_mb?: number;
	free_mb?: number;
	processes?: Array<{ pid: number; name: string; vram_mb: number }>;
	reason?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
	try {
		const r = await fetch(url, init);
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch {
		return null;
	}
}

export async function handleGpuStatus(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string,
	ollamaUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	const auth = `Bearer ${secret}`;
	const [ocrRaw, ocrStatus, ollamaPs] = await Promise.all([
		fetchJson<OcrGpuRaw>(`${ocrServiceUrl}/gpu/raw`, {
			headers: { Authorization: auth }
		}),
		fetchJson<OcrStatus>(`${ocrServiceUrl}/status`, {
			headers: { Authorization: auth }
		}),
		fetchJson<{ models: OllamaPsModel[] }>(`${ollamaUrl}/api/ps`)
	]);

	const now = Date.now() / 1000;
	const models: Array<Record<string, unknown>> = [];

	if (ollamaPs && Array.isArray(ollamaPs.models)) {
		for (const m of ollamaPs.models) {
			const sizeMb = typeof m.size_vram === 'number'
				? Math.round(m.size_vram / (1024 * 1024))
				: 0;
			// Ollama's default keep_alive is 5 min (300s). `expires_at` is the
			// scheduled eviction time, so last-used ≈ expires_at - 300, and
			// idle ≈ now - (expires_at - 300). Clamped to ≥ 0 so a
			// just-finished generation doesn't report negative idle.
			const expiresAt = m.expires_at ? new Date(m.expires_at).getTime() / 1000 : null;
			const idle = expiresAt !== null && Number.isFinite(expiresAt)
				? Math.max(0, now - (expiresAt - 300))
				: null;
			models.push({
				backend: 'ollama',
				name: m.name,
				size_mb: sizeMb,
				idle_for_s: idle,
				unloadable: true
			});
		}
	}

	if (ocrStatus && ocrStatus.loaded) {
		models.push({
			backend: 'ocr',
			name: 'got-ocr2',
			size_mb: 1200,
			idle_for_s: Math.max(0, now - ocrStatus.last_called_at),
			unloadable: ocrStatus.in_flight === 0
		});
	}

	const vram =
		ocrRaw && ocrRaw.available
			? {
					total_mb: ocrRaw.total_mb,
					used_mb: ocrRaw.used_mb,
					free_mb: ocrRaw.free_mb
				}
			: null;

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			vram,
			models,
			processes: ocrRaw?.processes ?? [],
			ollama_available: ollamaPs !== null,
			ocr_available: ocrStatus !== null,
			gpu_available: ocrRaw?.available ?? false,
			fetched_at: new Date().toISOString()
		})
	);
}

interface UnloadBody {
	backend?: unknown;
	name?: unknown;
}

/**
 * POST /gpu/unload {backend, name?} — route a model unload to the right
 * backend.
 *
 * - `backend: "ollama"` + `name` → POST `${OLLAMA_URL}/api/generate` with
 *   `{model, prompt: "", keep_alive: 0}`. This is Ollama's official
 *   trick to evict a loaded model: load with zero keep_alive forces
 *   immediate eviction.
 * - `backend: "ocr"` → POST `${OCR_SERVICE_URL}/unload` with the
 *   re-Bearered bridge secret. The ocr-service returns 423 with a JSON
 *   body when generation is in-flight; we pass that through verbatim so
 *   the UI can display the localized "busy, try again" message.
 * - Anything else → 400 unknown_backend.
 */
export async function handleGpuUnload(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string,
	ollamaUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: UnloadBody;
	try {
		body = (await readJson(req)) as UnloadBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const backend = typeof body.backend === 'string' ? body.backend : '';
	if (backend === 'ollama') {
		const name = typeof body.name === 'string' ? body.name : '';
		if (!name) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'missing_name' }));
			return;
		}
		await proxy(
			res,
			`${ollamaUrl}/api/generate`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			},
			JSON.stringify({ model: name, prompt: '', keep_alive: 0 })
		);
		return;
	}

	if (backend === 'ocr') {
		await proxy(
			res,
			`${ocrServiceUrl}/unload`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${secret}` }
			},
			null
		);
		return;
	}

	res.writeHead(400, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'unknown_backend' }));
}

async function proxy(
	res: ServerResponse,
	url: string,
	init: RequestInit,
	body: string | null
): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(url, body !== null ? { ...init, body } : init);
	} catch {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_unavailable' }));
		return;
	}
	const text = await resp.text();
	res.writeHead(resp.status, { 'Content-Type': 'application/json' });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}
