/**
 * Matches the OCR note signature line:
 *   ocr://qwen2.5vl:7b
 *   ocr://library/llava:7b
 *
 * Captures the model ref. Same character class as `llm://` so any vision-capable
 * Ollama model id is acceptable. The bridge proxies to Ollama's /api/chat
 * unchanged, so vision support is a property of the chosen model, not the bridge.
 */
export const OCR_SIGNATURE_RE = /^ocr:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/**
 * Matches a recognized OCR header key at the start of a line.
 * Capture 1 = key name, capture 2 = value (may be empty).
 *
 * Recognized keys:
 *   - target_lang: language to translate non-target text into (default 한국어)
 *   - system:      override the default OCR prompt entirely
 *   - temperature: model sampling temperature (default 0.1 — OCR is deterministic)
 *   - num_ctx:     context size, mostly relevant when many images accumulate
 */
export const OCR_HEADER_KEY_RE =
	/^(target_lang|system|temperature|num_ctx):\s*(.*)$/;

export const OCR_RECOGNIZED_HEADER_KEYS = [
	'target_lang',
	'system',
	'temperature',
	'num_ctx'
] as const;

export type OcrHeaderKey = (typeof OCR_RECOGNIZED_HEADER_KEYS)[number];

export const OCR_DEFAULT_TARGET_LANG = '한국어';
export const OCR_DEFAULT_TEMPERATURE = 0.1;
export const OCR_DEFAULT_NUM_CTX = 4096;

/**
 * Build the system prompt that drives the extraction + translation.
 *
 * The structured output format ([원문]/[번역]) is deliberate — it makes the
 * result skim-readable even when the source text is long, and lets the user
 * tell at a glance whether translation was needed.
 */
export function buildOcrSystemPrompt(targetLang: string): string {
	return [
		'당신은 이미지에서 텍스트를 정확히 추출하는 OCR 어시스턴트입니다.',
		'',
		'규칙:',
		`1. 이미지의 모든 텍스트를 원본 그대로 추출합니다. 줄바꿈, 들여쓰기, 기호를 최대한 보존합니다.`,
		`2. 추출한 텍스트가 ${targetLang}가 아니면, ${targetLang} 번역도 함께 제공합니다.`,
		`3. 추출한 텍스트가 이미 ${targetLang}이면 [번역] 섹션은 생략합니다.`,
		'4. 출력 외의 설명/주석을 덧붙이지 않습니다.',
		'',
		'출력 형식:',
		'[원문]',
		'<추출한 텍스트 그대로>',
		'',
		`[번역] (${targetLang}가 아닐 때만)`,
		`<${targetLang} 번역>`
	].join('\n');
}

/**
 * The single user-side message accompanying the image. The actual extraction
 * instructions live in the system prompt; this is just a nudge to start.
 */
export const OCR_USER_PROMPT = '이 이미지의 텍스트를 추출해줘.';
