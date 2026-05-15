import type { Editor } from '@tiptap/core';
import { sendChat, LlmChatError } from '../llmNote/sendChat.js';
import type { ChatRequestBody } from '../llmNote/buildChatRequest.js';
import { imageBlobToBase64 } from './imageToBase64.js';
import { downloadImageFromDropboxUrl } from '../sync/imageUpload.js';
import {
	OCR_DEFAULT_NUM_CTX,
	OCR_DEFAULT_TEMPERATURE,
	OCR_USER_PROMPT,
	buildOcrSystemPrompt
} from './defaults.js';
import type { OcrNoteSpec } from './parseOcrNote.js';

export interface RunOcrOptions {
	editor: Editor;
	spec: OcrNoteSpec;
	/** URL of the uploaded image (for logging/UI only — NOT fetched if `imageBlob` is also supplied). */
	imageUrl: string;
	/**
	 * In-memory bytes of the image. When present, this is used directly for
	 * base64 encoding — no network fetch. The paste/drop flow always has
	 * this. URL-only callers (e.g. cross-device retry on a note that
	 * already has the image URL but not the original File) fall through to
	 * `downloadImageFromDropboxUrl(imageUrl)`, which routes via the
	 * Dropbox SDK to side-step the www.dropbox.com CORS limitation.
	 */
	imageBlob?: Blob;
	bridgeUrl: string;
	bridgeToken: string;
	onStatus?: (msg: string) => void;
}

export interface RunOcrResult {
	reason: 'done' | 'abort' | 'stream_error' | 'error';
	text: string;
}

/**
 * Run OCR for one image URL and stream the result into the editor as new
 * paragraphs immediately following the paragraph that contains the URL.
 *
 * Contract:
 *   - Editor is set non-editable for the duration of the call. Any pending
 *     user typing is on hold; this matches LlmSendBar's behavior for the
 *     same reason — we'd otherwise have to track positions through user
 *     edits, which gets ugly fast.
 *   - The first appended paragraph is a "[OCR 진행 중…]" placeholder so
 *     the user sees something immediately even before the model produces
 *     its first token. The first arriving token replaces the placeholder.
 *   - On error / cancel / non-2xx, an "[OCR 오류: …]" line is appended in
 *     place of the placeholder. The image URL above stays untouched.
 *   - The result block is NOT wrapped in any special mark, so the next
 *     parseOcrNote call won't see it as a header. The OCR note's parser
 *     only looks at the header region (above the first blank paragraph),
 *     and we always emit a blank paragraph before our placeholder.
 */
export async function runOcrInEditor(opts: RunOcrOptions): Promise<RunOcrResult> {
	const { editor, spec, imageUrl, bridgeUrl, bridgeToken } = opts;

	const httpBase = bridgeUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/(ws|llm\/chat)\/?$/, '')
		.replace(/\/$/, '');

	editor.setEditable(false);
	let placeholderPos: number | null = null;
	let firstTokenSeen = false;
	const accumulatedRef = { value: '' };

	try {
		opts.onStatus?.('이미지 처리 중…');
		// Insert placeholder block at end of doc BEFORE we start the slow base64
		// encode, so the user gets immediate feedback. Position is tracked by
		// (placeholderPos, accumulated.length) — the placeholder paragraph holds
		// the streaming text.
		placeholderPos = appendOcrBlock(editor, '[OCR 진행 중…]');

		let imageB64: string;
		try {
			const blob = opts.imageBlob ?? (await downloadImageFromDropboxUrl(imageUrl));
			imageB64 = await imageBlobToBase64(blob);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			replaceOcrBlock(editor, placeholderPos, `[OCR 오류: ${msg}]`);
			return { reason: 'error', text: '' };
		}

		opts.onStatus?.('OCR 분석 중…');
		const body: ChatRequestBody = {
			model: spec.model,
			options: {
				temperature: spec.options.temperature ?? OCR_DEFAULT_TEMPERATURE,
				num_ctx: spec.options.num_ctx ?? OCR_DEFAULT_NUM_CTX
			},
			messages: [
				{
					role: 'system',
					content: spec.system && spec.system.length > 0
						? spec.system
						: buildOcrSystemPrompt(spec.targetLang)
				},
				{
					role: 'user',
					content: OCR_USER_PROMPT,
					images: [imageB64]
				}
			]
		};

		const result = await sendChat({
			url: `${httpBase}/llm/chat`,
			token: bridgeToken,
			body,
			onToken: (delta) => {
				if (placeholderPos === null) return;
				if (!firstTokenSeen) {
					replaceOcrBlock(editor, placeholderPos, delta);
					accumulatedRef.value = delta;
					firstTokenSeen = true;
				} else {
					accumulatedRef.value += delta;
					appendToOcrBlock(editor, placeholderPos, accumulatedRef.value.length, delta);
				}
			}
		});

		if (!firstTokenSeen) {
			// Stream completed with zero tokens — replace placeholder with a
			// minimal "no result" line so the user isn't left staring at the
			// "in progress" text forever.
			replaceOcrBlock(editor, placeholderPos, '[OCR 결과 없음]');
		}

		return { reason: result.reason, text: result.content };
	} catch (err) {
		if (placeholderPos !== null) {
			const msg = err instanceof LlmChatError ? formatLlmError(err) : (err as Error).message;
			if (firstTokenSeen) {
				appendOcrBlock(editor, `[OCR 오류: ${msg}]`);
			} else {
				replaceOcrBlock(editor, placeholderPos, `[OCR 오류: ${msg}]`);
			}
		}
		return { reason: 'error', text: '' };
	} finally {
		editor.setEditable(true);
	}
}

function formatLlmError(err: LlmChatError): string {
	switch (err.kind) {
		case 'unauthorized':
			return '인증 실패 — 설정에서 브릿지 재로그인';
		case 'model_not_found':
			return `모델 '${err.model ?? '?'}' 없음. ollama pull 필요`;
		case 'ollama_unavailable':
			return 'Ollama 서비스 응답 없음';
		case 'bad_request':
			return `요청 오류 ${err.message ?? ''}`;
		case 'upstream_error':
			return '브릿지 응답 오류';
		case 'network':
		default:
			return '연결 실패';
	}
}

/**
 * Append a single paragraph to the end of the doc with the given text and
 * return the position of the paragraph node (NOT its inner text content).
 *
 * The returned position is the offset of the paragraph node itself; the inner
 * text starts at `pos + 1`. We pre-pend an empty paragraph as a separator so
 * the OCR result is visually offset from the image URL above.
 */
function appendOcrBlock(editor: Editor, _initialText: string): number {
	void _initialText;
	const { state, view } = editor;
	// Two paragraphs: empty separator + content. Position of content paragraph
	// = endPos + 2 (we count the inserted separator paragraph's open + close).
	const endPos = state.doc.content.size;
	const blank = state.schema.nodes.paragraph.create();
	const block = state.schema.nodes.paragraph.create(null, state.schema.text(_initialText));
	const tr = state.tr.insert(endPos, [blank, block]);
	view.dispatch(tr);
	scrollToBottom(editor);
	// `endPos` was the doc-level position right before the inserted nodes.
	// After insertion, the blank paragraph occupies endPos..endPos+2 and the
	// content paragraph starts at endPos+2.
	return endPos + 2;
}

/**
 * Replace the entire text content of the OCR placeholder paragraph with new
 * text, preserving the paragraph node itself (so positions of subsequent
 * insertions remain stable).
 */
function replaceOcrBlock(editor: Editor, paragraphPos: number, newText: string): void {
	const { state, view } = editor;
	const para = state.doc.nodeAt(paragraphPos);
	if (!para || para.type.name !== 'paragraph') return;
	const innerStart = paragraphPos + 1;
	const innerEnd = paragraphPos + 1 + para.content.size;
	const tr = state.tr.replaceWith(
		innerStart,
		innerEnd,
		newText === '' ? [] : state.schema.text(newText)
	);
	view.dispatch(tr);
	scrollToBottom(editor);
}

/**
 * Append text to the OCR paragraph. `prevAccumulatedLen` lets us insert at
 * a known absolute offset without re-querying the doc — necessary because the
 * accumulated string may contain newlines, which when inserted as plain text
 * via `insertText` get materialized into hard-break nodes by ProseMirror's
 * default text-input handling, shifting the document size in non-1:1 ways.
 *
 * Strategy: re-derive insertion position from the paragraph node's current
 * end on each call. This is O(treewalk) but the paragraph stays small enough
 * (a typical OCR result is a few hundred chars) that it doesn't matter.
 */
function appendToOcrBlock(
	editor: Editor,
	paragraphPos: number,
	_expectedLen: number,
	delta: string
): void {
	void _expectedLen;
	const { state, view } = editor;
	const para = state.doc.nodeAt(paragraphPos);
	if (!para || para.type.name !== 'paragraph') return;
	const innerEnd = paragraphPos + 1 + para.content.size;

	// Split delta on \n to insert as plain text + hard breaks. Empty lines
	// produce two consecutive hard breaks.
	const tr = state.tr;
	const lines = delta.split('\n');
	const hardBreak = state.schema.nodes.hardBreak;
	let insertPos = innerEnd;
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && hardBreak) {
			const node = hardBreak.create();
			tr.insert(insertPos, node);
			insertPos += 1;
		}
		const line = lines[i];
		if (line !== '') {
			tr.insertText(line, insertPos);
			insertPos += line.length;
		}
	}
	view.dispatch(tr);
	scrollToBottom(editor);
}

function scrollToBottom(editor: Editor): void {
	try {
		editor.view.dom.scrollTop = editor.view.dom.scrollHeight;
	} catch {
		/* ignore */
	}
}
