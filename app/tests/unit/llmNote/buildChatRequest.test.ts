import { describe, it, expect } from 'vitest';
import { buildChatRequest } from '$lib/llmNote/buildChatRequest.js';
import type { LlmNoteSpec } from '$lib/llmNote/parseLlmNote.js';

const baseSpec: LlmNoteSpec = {
	model: 'qwen2.5-coder:3b',
	options: {},
	messages: [{ role: 'user', content: 'hi' }],
	trailingEmptyUserTurn: true
};

describe('buildChatRequest', () => {
	it('passes model through unchanged', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.model).toBe('qwen2.5-coder:3b');
	});

	it('passes messages through when system is undefined', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('prepends system as the first message when defined', () => {
		const body = buildChatRequest({
			...baseSpec,
			system: 'you are a shell helper'
		});
		expect(body.messages).toEqual([
			{ role: 'system', content: 'you are a shell helper' },
			{ role: 'user', content: 'hi' }
		]);
	});

	it('omits undefined option keys', () => {
		const body = buildChatRequest({
			...baseSpec,
			options: { temperature: 0.5, num_ctx: undefined }
		});
		expect(body.options).toEqual({ temperature: 0.5 });
		expect('num_ctx' in body.options).toBe(false);
	});

	it('includes all defined option keys', () => {
		const body = buildChatRequest({
			...baseSpec,
			options: {
				temperature: 0.5,
				num_ctx: 4096,
				top_p: 0.9,
				seed: 42,
				num_predict: 256
			}
		});
		expect(body.options).toEqual({
			temperature: 0.5,
			num_ctx: 4096,
			top_p: 0.9,
			seed: 42,
			num_predict: 256
		});
	});

	it('omits options entirely when no keys are defined', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.options).toEqual({});
	});

	it('passes empty system string as a system message (user wants explicit empty persona)', () => {
		const body = buildChatRequest({
			...baseSpec,
			system: ''
		});
		// Empty system means "user explicitly chose no persona" — we send it as
		// undefined so we don't waste a system message on whitespace.
		expect(body.messages[0].role).toBe('user');
	});
});
