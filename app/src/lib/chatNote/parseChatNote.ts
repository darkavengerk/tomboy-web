import type { JSONContent } from '@tiptap/core';
import {
	CHAT_SIGNATURE_RE,
	OLLAMA_HEADER_KEY_RE,
	CLAUDE_HEADER_KEY_RE,
	CLAUDE_VALID_EFFORTS,
	type OllamaHeaderKey,
	type ClaudeHeaderKey
} from './defaults.js';

export type ChatBackend = 'ollama' | 'claude';

export interface ChatNoteSpec {
	backend: ChatBackend;
	model: string;
	system?: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	/**
	 * True when the last message is a user turn awaiting a response (whether
	 * its content is empty or has text). The send-time check separately
	 * verifies the content is non-empty.
	 */
	trailingEmptyUserTurn: boolean;
	options: {
		// ollama-specific
		temperature?: number;
		num_ctx?: number;
		top_p?: number;
		seed?: number;
		num_predict?: number;
		rag?: number;
		// claude-specific
		effort?: string;
	};
}

/** Backward-compat alias — keeps backends/ollama.ts working unchanged. */
export type LlmNoteSpec = ChatNoteSpec;

/** Plain text of a paragraph block, joining only text-typed inline children. */
function paragraphText(block: JSONContent | undefined): string {
	if (!block || !Array.isArray(block.content)) return '';
	return block.content
		.map((node) => (node.type === 'text' ? (node.text ?? '') : ''))
		.join('');
}

/**
 * In tomboy-web a "paragraph" is usually a single visual line, but a paragraph
 * node can hold '\n' characters. Defensively split.
 */
function paragraphLines(block: JSONContent | undefined): string[] {
	return paragraphText(block).split('\n');
}

const OLLAMA_INT_KEYS = new Set<OllamaHeaderKey>(['num_ctx', 'seed', 'num_predict']);

export function parseChatNote(doc: JSONContent | null | undefined): ChatNoteSpec | null {
	if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return null;

	// Find signature: doc.content[1] preferred, doc.content[0] tolerated.
	let sigIndex: number;
	let backend: ChatBackend;
	let model: string;

	const c1FirstLine = doc.content.length > 1 ? paragraphLines(doc.content[1])[0] ?? '' : '';
	const m1 = CHAT_SIGNATURE_RE.exec(c1FirstLine);
	if (m1) {
		sigIndex = 1;
		backend = m1[1] === 'claude' ? 'claude' : 'ollama';
		model = m1[2] ?? '';
	} else {
		const c0FirstLine = paragraphLines(doc.content[0])[0] ?? '';
		const m0 = CHAT_SIGNATURE_RE.exec(c0FirstLine);
		if (!m0) return null;
		sigIndex = 0;
		backend = m0[1] === 'claude' ? 'claude' : 'ollama';
		model = m0[2] ?? '';
	}

	// For ollama (llm://) model is required.
	if (backend === 'ollama' && model === '') return null;

	// Header lines: collect every line after the signature line until the
	// first BLANK paragraph (which is the header/turn boundary).
	const headerLines: string[] = [];
	let blankSeen = false;
	let turnStartIndex = sigIndex + 1;

	// First, the rest of the signature paragraph itself (if signature was
	// followed by more lines within the same paragraph).
	const sigParaLines = paragraphLines(doc.content[sigIndex]);
	for (let i = 1; i < sigParaLines.length; i++) {
		headerLines.push(sigParaLines[i]);
	}

	for (let i = sigIndex + 1; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text === '') {
			blankSeen = true;
			turnStartIndex = i + 1;
			break;
		}
		for (const line of paragraphLines(doc.content[i])) {
			headerLines.push(line);
		}
	}
	if (!blankSeen) turnStartIndex = doc.content.length;

	const result: ChatNoteSpec = {
		backend,
		model,
		options: {},
		messages: [],
		trailingEmptyUserTurn: false
	};

	// Pick header regex by backend.
	const headerKeyRe = backend === 'ollama' ? OLLAMA_HEADER_KEY_RE : CLAUDE_HEADER_KEY_RE;

	let currentKey: OllamaHeaderKey | ClaudeHeaderKey | null = null;
	let currentValueLines: string[] = [];

	const flushKey = (): void => {
		if (currentKey === null) return;
		const value = currentValueLines.join('\n');

		if (backend === 'ollama') {
			const key = currentKey as OllamaHeaderKey;
			if (key === 'system') {
				result.system = value;
			} else if (key === 'rag') {
				const trimmed = value.trim().toLowerCase();
				if (trimmed === 'on') {
					result.options.rag = 5;
				} else if (trimmed === 'off' || trimmed === '') {
					// undefined — leave unset
				} else {
					const n = parseInt(trimmed, 10);
					if (Number.isFinite(n)) {
						result.options.rag = Math.min(Math.max(n, 1), 20);
					}
				}
			} else {
				const trimmed = value.trim();
				const n = OLLAMA_INT_KEYS.has(key)
					? parseInt(trimmed, 10)
					: parseFloat(trimmed);
				if (Number.isFinite(n)) {
					(result.options as Record<string, number>)[key] = n;
				}
			}
		} else {
			// claude backend
			const key = currentKey as ClaudeHeaderKey;
			if (key === 'system') {
				result.system = value;
			} else if (key === 'model') {
				const trimmed = value.trim();
				if (trimmed !== '') result.model = trimmed;
			} else if (key === 'effort') {
				const trimmed = value.trim().toLowerCase();
				if ((CLAUDE_VALID_EFFORTS as readonly string[]).includes(trimmed)) {
					result.options.effort = trimmed;
				}
			}
		}

		currentKey = null;
		currentValueLines = [];
	};

	for (const line of headerLines) {
		const keyMatch = headerKeyRe.exec(line);
		if (keyMatch) {
			flushKey();
			currentKey = keyMatch[1] as OllamaHeaderKey | ClaudeHeaderKey;
			currentValueLines = [keyMatch[2]];
		} else if (currentKey !== null) {
			const stripped = line.replace(/^\s+/, '');
			currentValueLines.push(stripped);
		}
	}
	flushKey();

	let lastRole: 'user' | 'assistant' | null = null;
	let lastContent: string[] = [];

	const flushTurn = (): void => {
		if (lastRole === null) return;
		result.messages.push({ role: lastRole, content: lastContent.join('\n') });
		lastRole = null;
		lastContent = [];
	};

	for (let i = turnStartIndex; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text.startsWith('Q: ') || text === 'Q:') {
			flushTurn();
			lastRole = 'user';
			lastContent = [text === 'Q:' ? '' : text.slice(3)];
		} else if (text.startsWith('A: ') || text === 'A:') {
			flushTurn();
			lastRole = 'assistant';
			lastContent = [text === 'A:' ? '' : text.slice(3)];
		} else if (lastRole !== null) {
			lastContent.push(text);
		}
	}

	if (lastRole === 'user') {
		result.trailingEmptyUserTurn = true;
	}
	flushTurn();

	return result;
}
