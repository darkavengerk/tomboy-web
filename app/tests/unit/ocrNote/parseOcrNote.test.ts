import { describe, it, expect } from 'vitest';
import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';
import { OCR_DEFAULT_TARGET_LANG } from '$lib/ocrNote/defaults.js';
import type { JSONContent } from '@tiptap/core';

function doc(...paras: string[]): JSONContent {
	return {
		type: 'doc',
		content: paras.map((text) => ({
			type: 'paragraph',
			content: text === '' ? undefined : [{ type: 'text', text }]
		}))
	};
}

describe('parseOcrNote', () => {
	it('returns null for empty/null/undefined doc', () => {
		expect(parseOcrNote(undefined)).toBeNull();
		expect(parseOcrNote(null)).toBeNull();
		expect(parseOcrNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature is present', () => {
		expect(parseOcrNote(doc('hello', 'world'))).toBeNull();
	});

	it('returns null when signature is malformed', () => {
		expect(parseOcrNote(doc('title', 'ocr://invalid format!'))).toBeNull();
	});

	it('recognizes signature at content[1] (canonical title-then-sig)', () => {
		const result = parseOcrNote(doc('OCR 노트', 'ocr://qwen2.5vl:7b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5vl:7b');
		// Default target lang when not specified
		expect(result!.targetLang).toBe(OCR_DEFAULT_TARGET_LANG);
		expect(result!.system).toBeUndefined();
	});

	it('recognizes signature at content[0] (no title yet)', () => {
		const result = parseOcrNote(doc('ocr://llava:7b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('llava:7b');
	});

	it('parses target_lang header', () => {
		const result = parseOcrNote(
			doc('OCR 노트', 'ocr://qwen2.5vl:7b', 'target_lang: English')
		);
		expect(result!.targetLang).toBe('English');
	});

	it('parses temperature and num_ctx', () => {
		const result = parseOcrNote(
			doc('OCR 노트', 'ocr://qwen2.5vl:7b', 'temperature: 0.4', 'num_ctx: 8192')
		);
		expect(result!.options.temperature).toBe(0.4);
		expect(result!.options.num_ctx).toBe(8192);
	});

	it('silently drops headers whose values fail to parse as numbers', () => {
		const result = parseOcrNote(
			doc('title', 'ocr://qwen2.5vl:7b', 'temperature: not-a-number')
		);
		expect(result!.options.temperature).toBeUndefined();
	});

	it('parses multi-line system override (continuation indented or unindented)', () => {
		const result = parseOcrNote(
			doc(
				'title',
				'ocr://qwen2.5vl:7b',
				'system: 추출만 하고',
				'  번역은 절대 하지 마.'
			)
		);
		expect(result!.system).toBe('추출만 하고\n번역은 절대 하지 마.');
	});

	it('stops header parsing at the first blank paragraph', () => {
		const result = parseOcrNote(
			doc(
				'title',
				'ocr://qwen2.5vl:7b',
				'target_lang: English',
				'',
				// These lines are past the header boundary — they're either old OCR
				// results or pasted images. They MUST NOT be parsed as headers.
				'temperature: 0.99',
				'num_ctx: 1'
			)
		);
		expect(result!.targetLang).toBe('English');
		expect(result!.options.temperature).toBeUndefined();
		expect(result!.options.num_ctx).toBeUndefined();
	});

	it('keeps target_lang default when value is empty', () => {
		const result = parseOcrNote(
			doc('title', 'ocr://qwen2.5vl:7b', 'target_lang: ')
		);
		expect(result!.targetLang).toBe(OCR_DEFAULT_TARGET_LANG);
	});

	it('accepts namespaced model refs', () => {
		const result = parseOcrNote(doc('library/llava:13b-v1.6', 'ocr://library/llava:13b-v1.6'));
		expect(result!.model).toBe('library/llava:13b-v1.6');
	});
});
