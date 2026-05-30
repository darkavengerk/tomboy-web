import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
	CHAT_SIGNATURE_RE,
	LLM_HEADER_DEFAULTS,
	OLLAMA_RECOGNIZED_HEADER_KEYS,
	CLAUDE_RECOGNIZED_HEADER_KEYS,
	CLAUDE_HEADER_DEFAULTS
} from '$lib/chatNote/defaults.js';
import type { ChatBackend } from '$lib/chatNote/parseChatNote.js';

export const chatNotePluginKey = new PluginKey<undefined>('llmNote');

export interface ClaudeAutoDefaults {
	system: string;
	model: string;
	effort: string;
}

export interface ChatNotePluginOptions {
	/** Read at scaffold time so 설정 changes apply without re-creating the plugin. */
	claudeDefaults?: () => ClaudeAutoDefaults;
}

interface SignatureLocation {
	paragraphIndex: number;
	backend: ChatBackend;
}

function backendOf(capture: string): ChatBackend {
	return capture === 'claude' ? 'claude' : 'ollama';
}

/** Find the signature line position + backend in the doc. Null if absent. */
function findSignature(doc: PMNode): SignatureLocation | null {
	if (doc.childCount === 0) return null;

	if (doc.childCount > 1) {
		const c1FirstLine = doc.child(1).textContent.split('\n')[0] ?? '';
		const m1 = CHAT_SIGNATURE_RE.exec(c1FirstLine);
		if (m1) return { paragraphIndex: 1, backend: backendOf(m1[1]) };
	}
	const c0FirstLine = doc.child(0).textContent.split('\n')[0] ?? '';
	const m0 = CHAT_SIGNATURE_RE.exec(c0FirstLine);
	if (m0) return { paragraphIndex: 0, backend: backendOf(m0[1]) };

	return null;
}

function headerKeyLineRe(backend: ChatBackend): RegExp {
	const keys =
		backend === 'claude' ? CLAUDE_RECOGNIZED_HEADER_KEYS : OLLAMA_RECOGNIZED_HEADER_KEYS;
	return new RegExp(`^(${keys.join('|')}):`);
}

function countRecognizedHeaderKeys(doc: PMNode, sigIndex: number, re: RegExp): number {
	let count = 0;
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			if (re.test(line)) count++;
		}
	}
	return count;
}

function existingHeaderKeysInDoc(doc: PMNode, sigIndex: number, re: RegExp): Set<string> {
	const out = new Set<string>();
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			const m = re.exec(line);
			if (m) out.add(m[1]);
		}
	}
	return out;
}

function buildOllamaParagraphs(schema: Schema, existing: Set<string>): PMNode[] {
	const paras: PMNode[] = [];
	if (!existing.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text('system: ')));
	}
	if (!existing.has('temperature')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`temperature: ${LLM_HEADER_DEFAULTS.temperature}`)
			)
		);
	}
	if (!existing.has('num_ctx')) {
		paras.push(
			schema.nodes.paragraph.create(null, schema.text(`num_ctx: ${LLM_HEADER_DEFAULTS.num_ctx}`))
		);
	}
	paras.push(schema.nodes.paragraph.create()); // blank boundary
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

function buildClaudeParagraphs(
	schema: Schema,
	existing: Set<string>,
	defaults: ClaudeAutoDefaults
): PMNode[] {
	const paras: PMNode[] = [];
	if (!existing.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`system: ${defaults.system}`)));
	}
	if (!existing.has('model')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`model: ${defaults.model}`)));
	}
	if (!existing.has('effort')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text(`effort: ${defaults.effort}`)));
	}
	paras.push(schema.nodes.paragraph.create()); // blank boundary
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

export function createChatNotePlugin(options: ChatNotePluginOptions = {}): Plugin {
	const getClaudeDefaults = options.claudeDefaults ?? (() => ({ ...CLAUDE_HEADER_DEFAULTS }));

	return new Plugin({
		key: chatNotePluginKey,
		appendTransaction(trs, oldState, newState) {
			const rescan = trs.some((tr) => tr.getMeta(chatNotePluginKey)?.rescan === true);
			const docChanged = trs.some((tr) => tr.docChanged);
			if (!rescan && !docChanged) return null;

			const { doc, schema } = newState;
			const sig = findSignature(doc);
			if (!sig) return null;

			const keyRe = headerKeyLineRe(sig.backend);

			let shouldComplete = false;
			if (rescan) {
				if (countRecognizedHeaderKeys(doc, sig.paragraphIndex, keyRe) === 0) shouldComplete = true;
			} else if (docChanged) {
				const oldSig = findSignature(oldState.doc);
				if (!oldSig) shouldComplete = true;
			}
			if (!shouldComplete) return null;

			const tr = newState.tr;
			let titleInserted = false;
			if (sig.paragraphIndex === 0) {
				tr.insert(0, schema.nodes.paragraph.create());
				titleInserted = true;
			}
			const effSigIndex = titleInserted ? sig.paragraphIndex + 1 : sig.paragraphIndex;

			const currentDoc = tr.doc;
			let endOfHeaderIndex = effSigIndex + 1;
			while (endOfHeaderIndex < currentDoc.childCount) {
				if (currentDoc.child(endOfHeaderIndex).textContent === '') break;
				endOfHeaderIndex++;
			}

			let insertPos = 0;
			for (let i = 0; i < endOfHeaderIndex; i++) insertPos += currentDoc.child(i).nodeSize;

			const existing = existingHeaderKeysInDoc(currentDoc, effSigIndex, keyRe);
			const hasTrailingBlankAndQ = endOfHeaderIndex < currentDoc.childCount;

			const allParas =
				sig.backend === 'claude'
					? buildClaudeParagraphs(schema, existing, getClaudeDefaults())
					: buildOllamaParagraphs(schema, existing);
			const parasToInsert = hasTrailingBlankAndQ
				? allParas.slice(0, allParas.length - 2) // drop blank + Q: when present
				: allParas;

			if (parasToInsert.length > 0) tr.insert(insertPos, parasToInsert);

			return tr;
		}
	});
}
