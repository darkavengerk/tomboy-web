import { describe, it, expect } from 'vitest';
import { parseLlmNote } from '$lib/llmNote/parseLlmNote.js';
import type { JSONContent } from '@tiptap/core';

// Helper: build a doc from an array of paragraph strings
function doc(...paras: string[]): JSONContent {
	return {
		type: 'doc',
		content: paras.map((text) => ({
			type: 'paragraph',
			content: text === '' ? undefined : [{ type: 'text', text }]
		}))
	};
}

describe('parseLlmNote', () => {
	it('returns null when doc is empty or undefined', () => {
		expect(parseLlmNote(undefined)).toBeNull();
		expect(parseLlmNote(null)).toBeNull();
		expect(parseLlmNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature line is present', () => {
		expect(parseLlmNote(doc('hello', 'world'))).toBeNull();
	});

	it('returns null when signature format is broken', () => {
		expect(parseLlmNote(doc('title', 'llm://invalid format!'))).toBeNull();
	});

	it('recognizes signature at doc.content[1] (canonical placement)', () => {
		const result = parseLlmNote(doc('셸 도우미', 'llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('recognizes signature at doc.content[0] (transient pre-auto-complete state)', () => {
		const result = parseLlmNote(doc('llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('prefers doc.content[1] when both positions match (abnormal case)', () => {
		const result = parseLlmNote(
			doc('llm://qwen2.5-coder:3b', 'llm://qwen2.5:7b')
		);
		expect(result!.model).toBe('qwen2.5:7b');
	});

	it('parses single-line header values', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'system: you are a helpful assistant',
				'temperature: 0.5',
				'num_ctx: 2048'
			)
		);
		expect(result!.system).toBe('you are a helpful assistant');
		expect(result!.options.temperature).toBe(0.5);
		expect(result!.options.num_ctx).toBe(2048);
	});

	it('silently drops a header key whose value fails to parse as number', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'temperature: not-a-number',
				'num_ctx: 4096'
			)
		);
		expect(result!.options.temperature).toBeUndefined();
		expect(result!.options.num_ctx).toBe(4096);
	});

	it('extracts Q/A turns from the turn region (after blank paragraph)', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'system: shell helper',
				'',
				'Q: tar.zst 풀기?',
				'A: tar -I zstd -xf file.tar.zst',
				'Q: zstd 없으면?',
				'A: dnf install zstd'
			)
		);
		expect(result!.messages).toEqual([
			{ role: 'user', content: 'tar.zst 풀기?' },
			{ role: 'assistant', content: 'tar -I zstd -xf file.tar.zst' },
			{ role: 'user', content: 'zstd 없으면?' },
			{ role: 'assistant', content: 'dnf install zstd' }
		]);
	});

	it('sets trailingEmptyUserTurn true when ending with empty Q:', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: first question',
				'A: first answer',
				'Q:'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(true);
		expect(result!.messages[result!.messages.length - 1]).toEqual({
			role: 'user',
			content: ''
		});
	});

	it('sets trailingEmptyUserTurn true when ending with Q: containing text', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: first',
				'A: answered',
				'Q: second pending'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(true);
		expect(result!.messages[result!.messages.length - 1]).toEqual({
			role: 'user',
			content: 'second pending'
		});
	});

	it('sets trailingEmptyUserTurn false when ending with A:', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: question',
				'A: answer'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(false);
	});

	it('treats unrecognized header keys as silent ignore', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'temperature: 0.3',
				'unknown_key: value',
				'num_ctx: 4096'
			)
		);
		expect(result!.options.temperature).toBe(0.3);
		expect(result!.options.num_ctx).toBe(4096);
		expect((result!.options as Record<string, unknown>).unknown_key).toBeUndefined();
	});

	it('assembles a multi-line system value from indented continuation lines', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'system: 너는 Linux 셸 전문가다.',
				'        한국어로 짧게.',
				'temperature: 0.3'
			)
		);
		expect(result!.system).toBe('너는 Linux 셸 전문가다.\n한국어로 짧게.');
		expect(result!.options.temperature).toBe(0.3);
	});

	it('returns empty messages when there is no blank separator paragraph', () => {
		const result = parseLlmNote(
			doc('title', 'llm://qwen2.5-coder:3b', 'Q: hello', 'A: world')
		);
		expect(result).not.toBeNull();
		expect(result!.messages).toHaveLength(0);
	});

	it('handles arbitrary whitespace after the colon (system: value vs system:  value)', () => {
		const r1 = parseLlmNote(
			doc('title', 'llm://m', 'system: one space')
		);
		const r2 = parseLlmNote(
			doc('title', 'llm://m', 'system:  two spaces')
		);
		const r3 = parseLlmNote(
			doc('title', 'llm://m', 'system:no space')
		);
		expect(r1!.system).toBe('one space');
		expect(r2!.system).toBe('two spaces');
		expect(r3!.system).toBe('no space');
	});

	it('parses headers and turns when signature is at doc.content[0] (transient state)', () => {
		const result = parseLlmNote(
			doc(
				'llm://qwen2.5-coder:3b',
				'system: helper',
				'',
				'Q: ping',
				'A: pong'
			)
		);
		expect(result!.model).toBe('qwen2.5-coder:3b');
		expect(result!.system).toBe('helper');
		expect(result!.messages).toEqual([
			{ role: 'user', content: 'ping' },
			{ role: 'assistant', content: 'pong' }
		]);
	});
});
