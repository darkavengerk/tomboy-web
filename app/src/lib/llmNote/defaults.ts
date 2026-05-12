/**
 * Matches the LLM note signature line:
 *   llm://qwen2.5-coder:3b
 *   llm://library/qwen2.5:7b
 *
 * Captures the model ref. Ollama tags use [a-z0-9._:-] plus optional / for
 * registry namespacing; we allow uppercase too for robustness.
 */
export const LLM_SIGNATURE_RE = /^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/**
 * Matches a recognized header key at the start of a line.
 * Capture 1 = key name, capture 2 = value (may be empty).
 */
export const LLM_HEADER_KEY_RE =
	/^(system|temperature|num_ctx|top_p|seed|num_predict):\s*(.*)$/;

export const LLM_RECOGNIZED_HEADER_KEYS = [
	'system',
	'temperature',
	'num_ctx',
	'top_p',
	'seed',
	'num_predict'
] as const;

export type LlmHeaderKey = (typeof LLM_RECOGNIZED_HEADER_KEYS)[number];

/**
 * Defaults inserted by auto-complete when keys are missing.
 *   system: empty value — user is nudged to define their persona explicitly
 *   temperature: 0.3 — conservative for Korean + technical answers
 *   num_ctx: 4096 — safe coexistence with 7B-Q4 on RTX 3080 10GB
 */
export const LLM_HEADER_DEFAULTS = {
	system: '',
	temperature: 0.3,
	num_ctx: 4096
} as const;
