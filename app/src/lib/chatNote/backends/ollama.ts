/**
 * Ollama backend bundle for chatNote.
 *
 * Combines three former sibling modules into one backend-scoped file:
 *   - LlmChatError + sendChat  (POST /llm/chat streaming NDJSON)
 *   - ChatRequestBody + buildChatRequest  (spec → request body)
 *   - RagHit + RagSearchError + searchRag  (POST /rag/search)
 *
 * A future backends/claude.ts will sit alongside this file for the
 * Anthropic Claude path (Task 4).
 */

import type { LlmNoteSpec } from '../parseChatNote.js';

// ─── sendChat ──────────────────────────────────────────────────────────────

export type LlmChatErrorKind =
	| 'unauthorized'
	| 'model_not_found'
	| 'ollama_unavailable'
	| 'upstream_error'
	| 'network'
	| 'bad_request';

export class LlmChatError extends Error {
	kind: LlmChatErrorKind;
	model?: string;
	status?: number;

	constructor(
		kind: LlmChatErrorKind,
		opts: { model?: string; status?: number; message?: string } = {}
	) {
		super(opts.message ?? kind);
		this.name = 'LlmChatError';
		this.kind = kind;
		this.model = opts.model;
		this.status = opts.status;
	}
}

export interface SendChatOptions {
	url: string;
	token: string;
	body: ChatRequestBody;
	onToken: (delta: string) => void;
	signal?: AbortSignal;
}

export interface SendChatResult {
	content: string;
	reason: 'done' | 'abort' | 'stream_error';
}

interface NdjsonFrame {
	message?: { role?: string; content?: string };
	done?: boolean;
	done_reason?: string;
}

export async function sendChat(opts: SendChatOptions): Promise<SendChatResult> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify(opts.body),
			signal: opts.signal
		});
	} catch (err) {
		const e = err as { name?: string };
		if (e.name === 'AbortError') {
			return { content: '', reason: 'abort' };
		}
		throw new LlmChatError('network', { message: (err as Error).message });
	}

	if (resp.status === 401) {
		throw new LlmChatError('unauthorized', { status: 401 });
	}
	if (resp.status === 404) {
		const errBody = await resp.json().catch(() => ({}));
		throw new LlmChatError('model_not_found', {
			status: 404,
			model: (errBody as { model?: string }).model
		});
	}
	if (resp.status === 503) {
		throw new LlmChatError('ollama_unavailable', { status: 503 });
	}
	if (resp.status === 400) {
		const errBody = await resp.json().catch(() => ({}));
		throw new LlmChatError('bad_request', {
			status: 400,
			message: (errBody as { error?: string }).error
		});
	}
	if (resp.status >= 500 || !resp.ok) {
		throw new LlmChatError('upstream_error', { status: resp.status });
	}

	const reader = resp.body?.getReader();
	if (!reader) {
		return { content: '', reason: 'done' };
	}

	const decoder = new TextDecoder();
	let buffer = '';
	let accumulated = '';

	// Wrap reader.read() so an AbortSignal can interrupt it mid-stream.
	const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
		const sig = opts.signal;
		if (!sig) return reader.read();
		if (sig.aborted) return Promise.resolve({ value: undefined, done: true } as ReadableStreamReadResult<Uint8Array>);
		return new Promise((resolve, reject) => {
			const abort = () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
			sig.addEventListener('abort', abort, { once: true });
			reader.read().then(
				(r) => { sig.removeEventListener('abort', abort); resolve(r); },
				(e) => { sig.removeEventListener('abort', abort); reject(e); }
			);
		});
	};

	try {
		while (true) {
			const { value, done } = await readChunk();
			if (done) break;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			// Process complete NDJSON frames in buffer
			let nlIdx: number;
			while ((nlIdx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nlIdx).trim();
				buffer = buffer.slice(nlIdx + 1);
				if (line === '') continue;
				let frame: NdjsonFrame;
				try {
					frame = JSON.parse(line) as NdjsonFrame;
				} catch {
					continue; // skip malformed frame
				}
				const delta = frame.message?.content ?? '';
				if (delta) {
					accumulated += delta;
					opts.onToken(delta);
				}
				if (frame.done) {
					return { content: accumulated, reason: 'done' };
				}
			}
		}
	} catch (err) {
		const e = err as { name?: string };
		if (e.name === 'AbortError' || opts.signal?.aborted) {
			return { content: accumulated, reason: 'abort' };
		}
		return { content: accumulated, reason: 'stream_error' };
	}

	// If we exited due to abort, report that.
	if (opts.signal?.aborted) {
		return { content: accumulated, reason: 'abort' };
	}
	// Stream ended without a `done: true` frame — treat as done with what we have.
	return { content: accumulated, reason: 'done' };
}

// ─── buildChatRequest ──────────────────────────────────────────────────────

/**
 * One message in a chat request. `images` is optional — Ollama's /api/chat
 * accepts a `images: string[]` field on user messages for vision models
 * (qwen2.5-vl, llava, gemma3, ...). Each entry is a base64-encoded image
 * (no `data:` prefix). The field is ignored by text-only models, so it's
 * safe to include conditionally.
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	images?: string[];
}

export interface ChatRequestBody {
	model: string;
	options: Record<string, number>;
	messages: ChatMessage[];
}

/**
 * Convert a parsed LLM note spec into the JSON body POSTed to /llm/chat.
 *
 * - If `system` is a non-empty string, prepend it as a system message.
 *   Empty string means "user deliberately left the persona blank" — we
 *   omit the system message entirely rather than wasting a slot.
 * - `options` only contains keys whose value is not undefined.
 * - `model` is passed through unchanged.
 */
export function buildChatRequest(spec: LlmNoteSpec): ChatRequestBody {
	const options: Record<string, number> = {};
	for (const [k, v] of Object.entries(spec.options)) {
		if (typeof v === 'number') options[k] = v;
	}

	const messages = spec.system && spec.system.length > 0
		? [{ role: 'system' as const, content: spec.system }, ...spec.messages]
		: [...spec.messages];

	return { model: spec.model, options, messages };
}

// ─── searchRag ─────────────────────────────────────────────────────────────

export interface RagHit {
	guid: string;
	title: string;
	body: string;
	score: number;
}

export type RagSearchErrorKind =
	| 'unauthorized'
	| 'rag_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network';

export class RagSearchError extends Error {
	kind: RagSearchErrorKind;
	status?: number;

	constructor(kind: RagSearchErrorKind, opts: { status?: number; message?: string } = {}) {
		super(opts.message ?? kind);
		this.name = 'RagSearchError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface SearchRagOptions {
	url: string;
	token: string;
	query: string;
	k: number;
	signal?: AbortSignal;
}

export async function searchRag(opts: SearchRagOptions): Promise<RagHit[]> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ query: opts.query, k: opts.k }),
			signal: opts.signal
		});
	} catch (err) {
		const e = err as { name?: string; message?: string };
		throw new RagSearchError('network', { message: e.message ?? 'fetch failed' });
	}

	if (resp.status === 401) throw new RagSearchError('unauthorized', { status: 401 });
	if (resp.status === 400) throw new RagSearchError('bad_request', { status: 400 });
	if (resp.status === 503) throw new RagSearchError('rag_unavailable', { status: 503 });
	if (resp.status >= 500 || !resp.ok)
		throw new RagSearchError('upstream_error', { status: resp.status });

	try {
		const data = (await resp.json()) as RagHit[];
		return Array.isArray(data) ? data : [];
	} catch (err) {
		throw new RagSearchError('upstream_error', {
			status: resp.status,
			message: 'bad json'
		});
	}
}
