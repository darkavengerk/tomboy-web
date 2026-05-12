import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendChat, LlmChatError } from '$lib/llmNote/sendChat.js';

function ndjsonStreamResponse(frames: object[], status = 200): Response {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			// Split into per-frame chunks to test buffering
			for (const f of frames) {
				controller.enqueue(encoder.encode(JSON.stringify(f) + '\n'));
			}
			controller.close();
		}
	});
	return new Response(stream, {
		status,
		headers: { 'Content-Type': 'application/x-ndjson' }
	});
}

describe('sendChat', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('streams tokens via onToken and resolves with full content', async () => {
		const frames = [
			{ message: { role: 'assistant', content: 'Hello' }, done: false },
			{ message: { role: 'assistant', content: ', ' }, done: false },
			{ message: { role: 'assistant', content: 'world' }, done: false },
			{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }
		];
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ndjsonStreamResponse(frames));

		const tokens: string[] = [];
		const result = await sendChat({
			url: 'https://bridge.example/llm/chat',
			token: 't',
			body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
			onToken: (t) => tokens.push(t)
		});

		expect(tokens).toEqual(['Hello', ', ', 'world']);
		expect(result.content).toBe('Hello, world');
		expect(result.reason).toBe('done');
	});

	it('throws unauthorized on 401', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('throws model_not_found with model name on 404', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: 'model_not_found', model: 'foo:bar' }),
				{ status: 404 }
			)
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'foo:bar', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'model_not_found', model: 'foo:bar' });
	});

	it('throws ollama_unavailable on 503', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'ollama_unavailable' }), { status: 503 })
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'ollama_unavailable' });
	});

	it('resolves with reason=abort when signal aborts mid-stream', async () => {
		// Stream that emits one chunk then waits
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(
					encoder.encode(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n')
				);
				// Never close — wait for abort
			}
		});
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
		);

		const ctrl = new AbortController();
		const tokens: string[] = [];
		const p = sendChat({
			url: 'x',
			token: 't',
			body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
			onToken: (t) => {
				tokens.push(t);
				if (tokens.length === 1) ctrl.abort();
			},
			signal: ctrl.signal
		});
		const result = await p;
		expect(result.content).toBe('partial');
		expect(result.reason).toBe('abort');
	});
});
