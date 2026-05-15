/**
 * Matches the OCR note signature line:
 *   ocr://got-ocr2
 *   ocr://qwen2.5vl:7b        (legacy single-model)
 *
 * The signature carries the OCR model name. The translation model lives
 * in a separate `translate:` header (post-split spec). When the header
 * is absent we treat the note as legacy and use the same model for both
 * extraction and translation in a single call.
 */
export const OCR_SIGNATURE_RE = /^ocr:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/**
 * Recognized header keys:
 *   - translate:   Ollama model id for the translation step. Default
 *                  is `exaone3.5:2.4b`. Absent → legacy single-call.
 *   - system:      override the translation step's system prompt.
 *   - temperature: model sampling temperature for the translation step.
 *   - num_ctx:     context size for the translation step.
 */
export const OCR_HEADER_KEY_RE =
	/^(translate|system|temperature|num_ctx):\s*(.*)$/;

export const OCR_RECOGNIZED_HEADER_KEYS = [
	'translate',
	'system',
	'temperature',
	'num_ctx'
] as const;

export type OcrHeaderKey = (typeof OCR_RECOGNIZED_HEADER_KEYS)[number];

export const OCR_DEFAULT_TRANSLATE_MODEL = 'exaone3.5:2.4b';
export const OCR_DEFAULT_TEMPERATURE = 0.2;
export const OCR_DEFAULT_NUM_CTX = 4096;

/**
 * Translation step system prompt. The use case is English print →
 * Korean, period. We don't detect language and we don't ask the model
 * to skip translation — that's UX-level logic above this call.
 */
export function buildTranslatePrompt(): string {
	return [
		'다음 영문을 자연스러운 한국어로 번역해.',
		'부연 설명, 머리말, 마무리 문구 없이 번역 결과만 출력해.',
		'줄바꿈과 단락 구분을 가능한 한 보존해.'
	].join('\n');
}
