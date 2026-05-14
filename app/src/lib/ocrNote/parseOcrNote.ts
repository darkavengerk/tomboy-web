import type { JSONContent } from '@tiptap/core';
import {
	OCR_SIGNATURE_RE,
	OCR_HEADER_KEY_RE,
	OCR_DEFAULT_TARGET_LANG,
	type OcrHeaderKey
} from './defaults.js';

export interface OcrNoteSpec {
	model: string;
	targetLang: string;
	system?: string;
	options: {
		temperature?: number;
		num_ctx?: number;
	};
}

function paragraphText(block: JSONContent | undefined): string {
	if (!block || !Array.isArray(block.content)) return '';
	return block.content
		.map((node) => (node.type === 'text' ? (node.text ?? '') : ''))
		.join('');
}

function paragraphLines(block: JSONContent | undefined): string[] {
	return paragraphText(block).split('\n');
}

const INT_KEYS = new Set<OcrHeaderKey>(['num_ctx']);

/**
 * Parse a note's TipTap JSON into an OCR spec.
 *
 * Mirrors the parseLlmNote shape — signature line at content[0] OR content[1]
 * (so a title line above is allowed), header block until the first blank
 * paragraph. Anything after the blank paragraph is the OCR result history and
 * is NOT parsed (the runner appends new results below the trigger image, but
 * existing results don't influence subsequent runs).
 */
export function parseOcrNote(doc: JSONContent | null | undefined): OcrNoteSpec | null {
	if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return null;

	let sigIndex: number;
	let model: string;

	const c1FirstLine = doc.content.length > 1 ? paragraphLines(doc.content[1])[0] ?? '' : '';
	const m1 = OCR_SIGNATURE_RE.exec(c1FirstLine);
	if (m1) {
		sigIndex = 1;
		model = m1[1];
	} else {
		const c0FirstLine = paragraphLines(doc.content[0])[0] ?? '';
		const m0 = OCR_SIGNATURE_RE.exec(c0FirstLine);
		if (!m0) return null;
		sigIndex = 0;
		model = m0[1];
	}

	const headerLines: string[] = [];
	const sigParaLines = paragraphLines(doc.content[sigIndex]);
	for (let i = 1; i < sigParaLines.length; i++) {
		headerLines.push(sigParaLines[i]);
	}

	for (let i = sigIndex + 1; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text === '') break;
		for (const line of paragraphLines(doc.content[i])) {
			headerLines.push(line);
		}
	}

	const result: OcrNoteSpec = {
		model,
		targetLang: OCR_DEFAULT_TARGET_LANG,
		options: {}
	};

	let currentKey: OcrHeaderKey | null = null;
	let currentValueLines: string[] = [];

	const flushKey = (): void => {
		if (currentKey === null) return;
		const value = currentValueLines.join('\n');
		if (currentKey === 'system') {
			result.system = value;
		} else if (currentKey === 'target_lang') {
			const trimmed = value.trim();
			if (trimmed !== '') result.targetLang = trimmed;
		} else {
			const trimmed = value.trim();
			const n = INT_KEYS.has(currentKey) ? parseInt(trimmed, 10) : parseFloat(trimmed);
			if (Number.isFinite(n)) {
				(result.options as Record<string, number>)[currentKey] = n;
			}
		}
		currentKey = null;
		currentValueLines = [];
	};

	for (const line of headerLines) {
		const keyMatch = OCR_HEADER_KEY_RE.exec(line);
		if (keyMatch) {
			flushKey();
			currentKey = keyMatch[1] as OcrHeaderKey;
			currentValueLines = [keyMatch[2]];
		} else if (currentKey !== null) {
			const stripped = line.replace(/^\s+/, '');
			currentValueLines.push(stripped);
		}
	}
	flushKey();

	return result;
}
