import type { ChatRequestBody } from './buildChatRequest.js';

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
