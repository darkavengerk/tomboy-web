import { describe, it, expect } from 'vitest';
import { parseChatNote } from '$lib/chatNote/parseChatNote.js';
import { normalizeEffort, CLAUDE_HEADER_DEFAULTS } from '$lib/chatNote/defaults.js';
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

describe('parseChatNote', () => {
	it('returns null when doc is empty or undefined', () => {
		expect(parseChatNote(undefined)).toBeNull();
		expect(parseChatNote(null)).toBeNull();
		expect(parseChatNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature line is present', () => {
		expect(parseChatNote(doc('hello', 'world'))).toBeNull();
	});

	it('returns null when signature format is broken', () => {
		expect(parseChatNote(doc('title', 'llm://invalid format!'))).toBeNull();
	});

	it('recognizes signature at doc.content[1] (canonical placement)', () => {
		const result = parseChatNote(doc('셸 도우미', 'llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('recognizes signature at doc.content[0] (transient pre-auto-complete state)', () => {
		const result = parseChatNote(doc('llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('prefers doc.content[1] when both positions match (abnormal case)', () => {
		const result = parseChatNote(
			doc('llm://qwen2.5-coder:3b', 'llm://qwen2.5:7b')
		);
		expect(result!.model).toBe('qwen2.5:7b');
	});

	it('parses single-line header values', () => {
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
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
		const result = parseChatNote(
			doc('title', 'llm://qwen2.5-coder:3b', 'Q: hello', 'A: world')
		);
		expect(result).not.toBeNull();
		expect(result!.messages).toHaveLength(0);
	});

	it('handles arbitrary whitespace after the colon (system: value vs system:  value)', () => {
		const r1 = parseChatNote(
			doc('title', 'llm://m', 'system: one space')
		);
		const r2 = parseChatNote(
			doc('title', 'llm://m', 'system:  two spaces')
		);
		const r3 = parseChatNote(
			doc('title', 'llm://m', 'system:no space')
		);
		expect(r1!.system).toBe('one space');
		expect(r2!.system).toBe('two spaces');
		expect(r3!.system).toBe('no space');
	});

	it('parses headers and turns when signature is at doc.content[0] (transient state)', () => {
		const result = parseChatNote(
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

	describe('rag header key', () => {
		it('rag: on → 5', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: on', '', 'Q: hi'));
			expect(result?.options.rag).toBe(5);
		});
		it('rag: 7 → 7', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: 7', '', 'Q: hi'));
			expect(result?.options.rag).toBe(7);
		});
		it('rag: 30 → clamps to 20', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: 30', '', 'Q: hi'));
			expect(result?.options.rag).toBe(20);
		});
		it('rag: 0 → clamps to 1', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: 0', '', 'Q: hi'));
			expect(result?.options.rag).toBe(1);
		});
		it('rag: off → undefined', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: off', '', 'Q: hi'));
			expect(result?.options.rag).toBeUndefined();
		});
		it('rag: foo → undefined', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'rag: foo', '', 'Q: hi'));
			expect(result?.options.rag).toBeUndefined();
		});
		it('rag absent → undefined', () => {
			const result = parseChatNote(doc('t', 'llm://m', 'system: x', '', 'Q: hi'));
			expect(result?.options.rag).toBeUndefined();
		});
	});
});

describe('parseChatNote — claude:// backend', () => {
	it('recognizes claude:// with no model', () => {
		const r = parseChatNote(doc('타이틀', 'claude://'));
		expect(r).not.toBeNull();
		expect(r!.backend).toBe('claude');
		expect(r!.model).toBe('');
	});

	it('recognizes claude://opus shortname', () => {
		const r = parseChatNote(doc('타이틀', 'claude://opus'));
		expect(r!.backend).toBe('claude');
		expect(r!.model).toBe('opus');
	});

	it('recognizes claude://claude-opus-4-7 full id', () => {
		const r = parseChatNote(doc('타이틀', 'claude://claude-opus-4-7'));
		expect(r!.model).toBe('claude-opus-4-7');
	});

	it('ignores legacy cwd: header (clean mode)', () => {
		const r = parseChatNote(
			doc('t', 'claude://', 'cwd: /home/jh/workspace/foo')
		);
		expect(r).not.toBeNull();
		expect('cwd' in (r!.options as object)).toBe(false);
	});

	it('ignores legacy allowedTools: header (clean mode)', () => {
		const r = parseChatNote(
			doc('t', 'claude://', 'cwd: /tmp', 'allowedTools: Read, Bash, Edit')
		);
		expect(r).not.toBeNull();
		expect('allowedTools' in (r!.options as object)).toBe(false);
	});

	it('ignores rag: header on claude:// note', () => {
		const r = parseChatNote(doc('t', 'claude://', 'rag: on'));
		expect(r!.options.rag).toBeUndefined();
	});

	it('ignores cwd: header on llm:// note', () => {
		const r = parseChatNote(doc('t', 'llm://qwen2.5', 'cwd: /tmp'));
		expect((r!.options as { cwd?: string }).cwd).toBeUndefined();
	});

	it('header model: overrides signature model on claude', () => {
		const r = parseChatNote(
			doc('t', 'claude://opus', 'model: claude-opus-4-7')
		);
		expect(r!.model).toBe('claude-opus-4-7');
	});

	it('claude:// preserves Q:/A: turn parsing', () => {
		const r = parseChatNote(
			doc('t', 'claude://', '', 'Q: hello', 'A: hi', 'Q: what', 'Q:')
		);
		expect(r!.messages).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' },
			{ role: 'user', content: 'what' },
			{ role: 'user', content: '' },
		]);
		expect(r!.trailingEmptyUserTurn).toBe(true);
	});

	it('llm:// returns backend: "ollama"', () => {
		const r = parseChatNote(doc('t', 'llm://qwen2.5'));
		expect(r!.backend).toBe('ollama');
	});

	it('llm:// still requires model (returns null without)', () => {
		expect(parseChatNote(doc('t', 'llm://'))).toBeNull();
	});
});

describe('parseChatNote — claude effort/clean headers', () => {
	function claudeDoc(headerLines: string[]) {
		return {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'claude://' }] },
				...headerLines.map((l) => ({
					type: 'paragraph',
					content: [{ type: 'text', text: l }]
				})),
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: 안녕' }] }
			]
		};
	}

	it('parses a valid effort header', () => {
		const spec = parseChatNote(claudeDoc(['effort: xhigh']));
		expect(spec?.options.effort).toBe('xhigh');
	});

	it('ignores an invalid effort header', () => {
		const spec = parseChatNote(claudeDoc(['effort: bogus']));
		expect(spec?.options.effort).toBeUndefined();
	});

	it('ignores legacy cwd / allowedTools headers (clean mode)', () => {
		const spec = parseChatNote(claudeDoc(['cwd: /tmp', 'allowedTools: Read,Bash']));
		expect(spec).not.toBeNull();
		expect('cwd' in (spec!.options as object)).toBe(false);
		expect('allowedTools' in (spec!.options as object)).toBe(false);
	});

	it('parses system + model + effort together', () => {
		const spec = parseChatNote(
			claudeDoc(['system: 번역기', 'model: opus', 'effort: high'])
		);
		expect(spec?.system).toBe('번역기');
		expect(spec?.model).toBe('opus');
		expect(spec?.options.effort).toBe('high');
	});

	it('normalizeEffort falls back to high', () => {
		expect(normalizeEffort('max')).toBe('max');
		expect(normalizeEffort('nonsense')).toBe('high');
		expect(normalizeEffort(undefined)).toBe('high');
		expect(CLAUDE_HEADER_DEFAULTS.effort).toBe('high');
	});
});
