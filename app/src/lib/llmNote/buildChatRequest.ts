import type { LlmNoteSpec } from './parseLlmNote.js';

export interface ChatRequestBody {
	model: string;
	options: Record<string, number>;
	messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
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
