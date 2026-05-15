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
