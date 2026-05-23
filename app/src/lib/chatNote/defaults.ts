/**
 * Matches any chat note signature line:
 *   llm://qwen2.5-coder:3b   (ollama)
 *   claude://                 (claude, model optional)
 *   claude://opus             (claude, short alias)
 *   claude://claude-opus-4-7  (claude, full id)
 *
 * Capture 1 = backend ('llm' or 'claude')
 * Capture 2 = model string (may be undefined for claude://)
 */
export const CHAT_SIGNATURE_RE =
	/^(llm|claude):\/\/([A-Za-z0-9._:/-]+)?\s*$/;

// ─── Ollama headers ────────────────────────────────────────────────────────

/**
 * Matches a recognized Ollama header key at the start of a line.
 * Capture 1 = key name, capture 2 = value (may be empty).
 */
export const OLLAMA_HEADER_KEY_RE =
	/^(system|temperature|num_ctx|top_p|seed|num_predict|rag):\s*(.*)$/;

export const OLLAMA_RECOGNIZED_HEADER_KEYS = [
	'system',
	'temperature',
	'num_ctx',
	'top_p',
	'seed',
	'num_predict',
	'rag'
] as const;

export type OllamaHeaderKey = (typeof OLLAMA_RECOGNIZED_HEADER_KEYS)[number];

// ─── Claude headers ────────────────────────────────────────────────────────

/**
 * Matches a recognized Claude header key at the start of a line.
 * Capture 1 = key name, capture 2 = value (may be empty).
 */
export const CLAUDE_HEADER_KEY_RE =
	/^(system|model|cwd|allowedTools):\s*(.*)$/;

export const CLAUDE_RECOGNIZED_HEADER_KEYS = [
	'system',
	'model',
	'cwd',
	'allowedTools'
] as const;

export type ClaudeHeaderKey = (typeof CLAUDE_RECOGNIZED_HEADER_KEYS)[number];

// ─── Backwards-compat aliases (keep existing imports working) ──────────────

/** @deprecated Use CHAT_SIGNATURE_RE */
export const LLM_SIGNATURE_RE = /^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/** @deprecated Use OLLAMA_HEADER_KEY_RE */
export const LLM_HEADER_KEY_RE = OLLAMA_HEADER_KEY_RE;

/** @deprecated Use OLLAMA_RECOGNIZED_HEADER_KEYS */
export const LLM_RECOGNIZED_HEADER_KEYS = OLLAMA_RECOGNIZED_HEADER_KEYS;

/** @deprecated Use OllamaHeaderKey */
export type LlmHeaderKey = OllamaHeaderKey;

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
