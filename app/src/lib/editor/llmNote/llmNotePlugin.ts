import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
	LLM_SIGNATURE_RE,
	LLM_HEADER_DEFAULTS,
	LLM_RECOGNIZED_HEADER_KEYS,
	type LlmHeaderKey
} from '$lib/llmNote/defaults.js';

export const llmNotePluginKey = new PluginKey<undefined>('llmNote');

interface SignatureLocation {
	paragraphIndex: number;
	model: string;
}

/** Find the signature line position in the doc. Returns null if absent. */
function findSignature(doc: PMNode): SignatureLocation | null {
	if (doc.childCount === 0) return null;

	if (doc.childCount > 1) {
		const c1FirstLine = doc.child(1).textContent.split('\n')[0] ?? '';
		const m1 = LLM_SIGNATURE_RE.exec(c1FirstLine);
		if (m1) return { paragraphIndex: 1, model: m1[1] };
	}
	const c0FirstLine = doc.child(0).textContent.split('\n')[0] ?? '';
	const m0 = LLM_SIGNATURE_RE.exec(c0FirstLine);
	if (m0) return { paragraphIndex: 0, model: m0[1] };

	return null;
}

const HEADER_KEY_LINE_RE = new RegExp(
	`^(${LLM_RECOGNIZED_HEADER_KEYS.join('|')}):`
);

function countRecognizedHeaderKeys(doc: PMNode, sigIndex: number): number {
	let count = 0;
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			if (HEADER_KEY_LINE_RE.test(line)) count++;
		}
	}
	return count;
}

function existingHeaderKeysInDoc(
	doc: PMNode,
	sigIndex: number
): Set<LlmHeaderKey> {
	const out = new Set<LlmHeaderKey>();
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = doc.child(i).textContent;
		if (text === '') break;
		for (const line of text.split('\n')) {
			const m = HEADER_KEY_LINE_RE.exec(line);
			if (m) out.add(m[1] as LlmHeaderKey);
		}
	}
	return out;
}

function buildAutoCompleteParagraphs(
	schema: Schema,
	existingHeaderKeys: Set<LlmHeaderKey>
): PMNode[] {
	const paras: PMNode[] = [];
	if (!existingHeaderKeys.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text('system: ')));
	}
	if (!existingHeaderKeys.has('temperature')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`temperature: ${LLM_HEADER_DEFAULTS.temperature}`)
			)
		);
	}
	if (!existingHeaderKeys.has('num_ctx')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`num_ctx: ${LLM_HEADER_DEFAULTS.num_ctx}`)
			)
		);
	}
	paras.push(schema.nodes.paragraph.create()); // blank boundary
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

export function createLlmNotePlugin(): Plugin {
	return new Plugin({
		key: llmNotePluginKey,
		appendTransaction(trs, oldState, newState) {
			const rescan = trs.some(
				(tr) => tr.getMeta(llmNotePluginKey)?.rescan === true
			);
			const docChanged = trs.some((tr) => tr.docChanged);

			if (!rescan && !docChanged) return null;

			const { doc, schema } = newState;
			const sig = findSignature(doc);
			if (!sig) return null;

			let shouldComplete = false;

			if (rescan) {
				if (countRecognizedHeaderKeys(doc, sig.paragraphIndex) === 0) {
					shouldComplete = true;
				}
			} else if (docChanged) {
				const oldSig = findSignature(oldState.doc);
				if (!oldSig) {
					shouldComplete = true;
				}
			}

			if (!shouldComplete) return null;

			const tr = newState.tr;
			let titleInserted = false;

			if (sig.paragraphIndex === 0) {
				const emptyPara = schema.nodes.paragraph.create();
				tr.insert(0, emptyPara);
				titleInserted = true;
			}

			const effSigIndex = titleInserted
				? sig.paragraphIndex + 1
				: sig.paragraphIndex;

			const currentDoc = tr.doc;
			let endOfHeaderIndex = effSigIndex + 1;
			while (endOfHeaderIndex < currentDoc.childCount) {
				const text = currentDoc.child(endOfHeaderIndex).textContent;
				if (text === '') break;
				endOfHeaderIndex++;
			}

			let insertPos = 0;
			for (let i = 0; i < endOfHeaderIndex; i++) {
				insertPos += currentDoc.child(i).nodeSize;
			}

			const existing = existingHeaderKeysInDoc(currentDoc, effSigIndex);
			const hasTrailingBlankAndQ = endOfHeaderIndex < currentDoc.childCount;

			const allParas = buildAutoCompleteParagraphs(schema, existing);
			const parasToInsert = hasTrailingBlankAndQ
				? allParas.slice(0, allParas.length - 2) // drop blank + Q: when one already exists
				: allParas;

			if (parasToInsert.length > 0) {
				tr.insert(insertPos, parasToInsert);
			}

			return tr;
		}
	});
}
