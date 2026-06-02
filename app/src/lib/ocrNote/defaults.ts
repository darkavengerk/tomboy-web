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
 *   - effort:      Claude 백엔드 reasoning effort. low|medium|high|xhigh|max.
 */
export const OCR_HEADER_KEY_RE =
	/^(translate|system|temperature|num_ctx|effort):\s*(.*)$/;

export const OCR_RECOGNIZED_HEADER_KEYS = [
	'translate',
	'system',
	'temperature',
	'num_ctx',
	'effort'
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

/**
 * `ocr://` 시그니처에서 추출한 model 토큰이 Claude 백엔드를 가리키는지 판정.
 *
 *   ocr://claude            → true (정확 매치)
 *   ocr://claude-opus-4-7   → true (claude-* prefix)
 *   ocr://got-ocr2          → false
 *   ocr://qwen2.5vl:7b      → false
 */
export function isClaudeBackend(model: string): boolean {
	return model === 'claude' || model.startsWith('claude-');
}

export const OCR_CLAUDE_VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const OCR_CLAUDE_DEFAULT_EFFORT = 'high';

/**
 * OCR + 번역을 한 번에 처리하는 시스템 프롬프트. 출력 형식
 * `[원문]\n…\n\n[번역]\n…`을 강제하므로 호출 측은 별도 후처리 없이
 * 결과 텍스트를 노트에 그대로 삽입한다.
 */
export const OCR_CLAUDE_SYSTEM_PROMPT = [
	'당신은 이미지에서 텍스트를 정확히 추출하고 한국어로 번역하는 어시스턴트입니다.',
	'',
	'규칙:',
	'1. 이미지의 모든 텍스트를 원본 그대로 추출합니다. 줄바꿈/들여쓰기/기호를 최대한 보존합니다.',
	'2. 추출 텍스트가 한국어가 아니면 한국어 번역도 함께 제공합니다.',
	'3. 추출 텍스트가 이미 한국어면 [번역] 섹션은 생략합니다.',
	'4. 출력 외의 설명/주석을 덧붙이지 않습니다.',
	'',
	'출력 형식:',
	'[원문]',
	'<추출한 텍스트 그대로>',
	'',
	'[번역] (한국어가 아닐 때만)',
	'<한국어 번역>'
].join('\n');
