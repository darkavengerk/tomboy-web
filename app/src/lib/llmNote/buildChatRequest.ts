import type { LlmNoteSpec } from './parseLlmNote.js';

/**
 * One message in a chat request. `images` is optional — Ollama's /api/chat
 * accepts a `images: string[]` field on user messages for vision models
 * (qwen2.5-vl, llava, gemma3, ...). Each entry is a base64-encoded image
 * (no `data:` prefix). The field is ignored by text-only models, so it's
 * safe to include conditionally.
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	images?: string[];
}

export interface ChatRequestBody {
	model: string;
	options: Record<string, number>;
	messages: ChatMessage[];
}

/**
 * Convert a parsed LLM note spec into the JSON body POSTed to /llm/chat.
 *
 * - If `system` is a non-empty string, prepend it as a system message.
 *   Empty string means "user deliberately left the persona blank" — we
 *   omit the system message entirely rather than wasting a slot.
 * - `options` only contains keys whose value is not undefined.
 * - `model` is passed through unchanged.
 */
export function buildChatRequest(spec: LlmNoteSpec): ChatRequestBody {
	const options: Record<string, number> = {};
	for (const [k, v] of Object.entries(spec.options)) {
		if (typeof v === 'number') options[k] = v;
	}

	const messages = spec.system && spec.system.length > 0
		? [{ role: 'system' as const, content: spec.system }, ...spec.messages]
		: [...spec.messages];

	return { model: spec.model, options, messages };
}
