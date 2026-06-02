import { describe, it, expect } from 'vitest';
import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';

function para(text: string) {
	return {
		type: 'paragraph',
		content: text.length === 0 ? [] : [{ type: 'text', text }]
	};
}

describe('parseOcrNote', () => {
	it('returns null for empty doc', () => {
		expect(parseOcrNote(null)).toBeNull();
		expect(parseOcrNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('parses bare signature as legacy', () => {
		const doc = {
			type: 'doc',
			content: [para('ocr://qwen2.5vl:7b')]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.model).toBe('qwen2.5vl:7b');
		expect(spec!.legacy).toBe(true);
		expect(spec!.translateModel).toBeUndefined();
	});

	it('parses translate header as non-legacy', () => {
		const doc = {
			type: 'doc',
			content: [para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b')]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.model).toBe('got-ocr2');
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
		expect(spec!.legacy).toBe(false);
	});

	it('allows title line above signature', () => {
		const doc = {
			type: 'doc',
			content: [
				para('My OCR note'),
				para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b')
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.model).toBe('got-ocr2');
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
	});

	it('reads system, temperature, num_ctx', () => {
		const doc = {
			type: 'doc',
			content: [
				para(
					'ocr://got-ocr2\ntranslate: exaone3.5:2.4b\nsystem: custom prompt\ntemperature: 0.5\nnum_ctx: 8192'
				)
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.system).toBe('custom prompt');
		expect(spec!.options.temperature).toBe(0.5);
		expect(spec!.options.num_ctx).toBe(8192);
	});

	it('ignores legacy target_lang header (graceful)', () => {
		const doc = {
			type: 'doc',
			content: [para('ocr://qwen2.5vl:7b\ntarget_lang: 한국어')]
		};
		const spec = parseOcrNote(doc);
		expect(spec).not.toBeNull();
		expect(spec!.legacy).toBe(true);
	});

	it('stops header parse at blank paragraph (so OCR results below are ignored)', () => {
		const doc = {
			type: 'doc',
			content: [
				para('ocr://got-ocr2\ntranslate: exaone3.5:2.4b'),
				para(''),
				para('[원문] previous run text...'),
				para('translate: should-not-be-read')
			]
		};
		const spec = parseOcrNote(doc);
		expect(spec!.translateModel).toBe('exaone3.5:2.4b');
	});
});

describe('parseOcrNote — Claude backend', () => {
	it('ocr://claude → backend=claude, model=claude', () => {
		const doc = { type: 'doc', content: [para('ocr://claude')] };
		const spec = parseOcrNote(doc);
		expect(spec?.backend).toBe('claude');
		expect(spec?.model).toBe('claude');
	});

	it('ocr://claude-opus-4-7 → backend=claude, model=claude-opus-4-7', () => {
		const doc = { type: 'doc', content: [para('ocr://claude-opus-4-7')] };
		const spec = parseOcrNote(doc);
		expect(spec?.backend).toBe('claude');
		expect(spec?.model).toBe('claude-opus-4-7');
	});

	it('ocr://got-ocr2 → backend=ollama (회귀)', () => {
		const doc = { type: 'doc', content: [para('ocr://got-ocr2')] };
		const spec = parseOcrNote(doc);
		expect(spec?.backend).toBe('ollama');
	});

	it('ocr://qwen2.5vl:7b → backend=ollama (회귀)', () => {
		const doc = { type: 'doc', content: [para('ocr://qwen2.5vl:7b')] };
		const spec = parseOcrNote(doc);
		expect(spec?.backend).toBe('ollama');
	});

	it('effort: high → options.effort = "high"', () => {
		const doc = { type: 'doc', content: [para('ocr://claude\neffort: high')] };
		const spec = parseOcrNote(doc);
		expect(spec?.options.effort).toBe('high');
	});

	it('effort: HIGH → options.effort = "high" (소문자 정규화)', () => {
		const doc = { type: 'doc', content: [para('ocr://claude\neffort: HIGH')] };
		const spec = parseOcrNote(doc);
		expect(spec?.options.effort).toBe('high');
	});

	it('effort: bogus → options.effort undefined', () => {
		const doc = { type: 'doc', content: [para('ocr://claude\neffort: bogus')] };
		const spec = parseOcrNote(doc);
		expect(spec?.options.effort).toBeUndefined();
	});

	it('Claude 노트의 translate: 헤더는 파싱되지만 소비자가 무시 가능', () => {
		const doc = { type: 'doc', content: [para('ocr://claude\ntranslate: anything')] };
		const spec = parseOcrNote(doc);
		expect(spec?.translateModel).toBe('anything');
	});
});
