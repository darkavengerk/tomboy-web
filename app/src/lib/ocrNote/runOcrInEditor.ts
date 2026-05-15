import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import { sendChat, LlmChatError } from '../llmNote/sendChat.js';
import type { ChatRequestBody } from '../llmNote/buildChatRequest.js';
import { sendOcr, OcrSendError } from './sendOcr.js';
import { imageBlobToBase64 } from './imageToBase64.js';
import { downloadImageFromDropboxUrl } from '../sync/imageUpload.js';
import {
	OCR_DEFAULT_NUM_CTX,
	OCR_DEFAULT_TEMPERATURE,
	OCR_DEFAULT_TRANSLATE_MODEL,
	buildTranslatePrompt
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
 * Run OCR for one image URL and stream the result into the editor.
 *
 * Branches on `spec.legacy`:
 *   - `legacy=false` (note has a `translate:` header): two-stage flow.
 *     Stage 1 POSTs the image to the bridge's `/ocr` proxy (single
 *     round-trip; ocr-service does the extraction). Result is rendered
 *     as `[원문]\n<text>`. Stage 2 streams a separate `[번역]\n<text>`
 *     block via `sendChat` with the translation system prompt.
 *   - `legacy=true` (no `translate:` header): one-shot call to
 *     `sendChat` with the combined `[원문]/[번역]` system prompt that
 *     pre-split OCR notes have always used. The streamed output replaces
 *     a single placeholder block.
 *
 * Editor is set non-editable for the duration; restored in `finally`.
 */
export async function runOcrInEditor(opts: RunOcrOptions): Promise<RunOcrResult> {
	const { editor, spec, bridgeUrl } = opts;
	const httpBase = normalizeHttpBase(bridgeUrl);

	editor.setEditable(false);
	try {
		opts.onStatus?.('이미지 처리 중…');
		const imageB64 = await loadImageB64(opts);
		if (imageB64 === null) {
			return { reason: 'error', text: '' };
		}

		if (spec.legacy) {
			return await runLegacy(opts, httpBase, imageB64);
		}

		return await runTwoStage(opts, httpBase, imageB64);
	} finally {
		editor.setEditable(true);
	}
}

async function runTwoStage(
	opts: RunOcrOptions,
	httpBase: string,
	imageB64: string
): Promise<RunOcrResult> {
	const { editor, spec, bridgeToken } = opts;

	// Stage 1: OCR (single shot). Show placeholder while we wait.
	opts.onStatus?.('OCR 분석 중…');
	const ocrBlockPos = appendBlock(editor, '[원문]\nOCR 진행 중…');
	let extractedText: string;
	try {
		const out = await sendOcr({
			url: `${httpBase}/ocr`,
			token: bridgeToken,
			imageB64
		});
		extractedText = out.text;
		replaceBlockContent(editor, ocrBlockPos, `[원문]\n${extractedText}`);
	} catch (err) {
		const msg = formatOcrError(err);
		replaceBlockContent(editor, ocrBlockPos, `[OCR 오류: ${msg}]`);
		return { reason: 'error', text: '' };
	}

	if (!extractedText.trim()) {
		return { reason: 'done', text: '' };
	}

	// Stage 2: Translate. Stream tokens into [번역] block.
	opts.onStatus?.('번역 중…');
	const translateModel = spec.translateModel ?? OCR_DEFAULT_TRANSLATE_MODEL;
	const translateSystem =
		spec.system && spec.system.length > 0 ? spec.system : buildTranslatePrompt();
	const transBlockPos = appendBlock(editor, '[번역]\n');
	let translatedAccum = '';
	const body: ChatRequestBody = {
		model: translateModel,
		options: {
			temperature: spec.options.temperature ?? OCR_DEFAULT_TEMPERATURE,
			num_ctx: spec.options.num_ctx ?? OCR_DEFAULT_NUM_CTX
		},
		messages: [
			{ role: 'system', content: translateSystem },
			{ role: 'user', content: extractedText }
		]
	};
	try {
		const result = await sendChat({
			url: `${httpBase}/llm/chat`,
			token: bridgeToken,
			body,
			onToken: (delta) => {
				translatedAccum += delta;
				replaceBlockContent(editor, transBlockPos, `[번역]\n${translatedAccum}`);
			}
		});
		return { reason: result.reason, text: `${extractedText}\n\n${translatedAccum}` };
	} catch (err) {
		const msg = err instanceof LlmChatError ? formatLlmError(err) : (err as Error).message;
		replaceBlockContent(editor, transBlockPos, `[번역 오류: ${msg}]`);
		return { reason: 'error', text: extractedText };
	}
}

async function runLegacy(
	opts: RunOcrOptions,
	httpBase: string,
	imageB64: string
): Promise<RunOcrResult> {
	const { editor, spec, bridgeToken } = opts;
	opts.onStatus?.('OCR 분석 중…');
	const placeholderPos = appendBlock(editor, '[OCR 진행 중…]');
	let firstTokenSeen = false;
	let accumulated = '';

	const body: ChatRequestBody = {
		model: spec.model,
		options: {
			temperature: spec.options.temperature ?? OCR_DEFAULT_TEMPERATURE,
			num_ctx: spec.options.num_ctx ?? OCR_DEFAULT_NUM_CTX
		},
		messages: [
			{
				role: 'system',
				content:
					spec.system && spec.system.length > 0
						? spec.system
						: buildLegacyOcrSystemPrompt('한국어')
			},
			{
				role: 'user',
				content: LEGACY_OCR_USER_PROMPT,
				images: [imageB64]
			}
		]
	};

	try {
		const result = await sendChat({
			url: `${httpBase}/llm/chat`,
			token: bridgeToken,
			body,
			onToken: (delta) => {
				if (!firstTokenSeen) {
					replaceBlockContent(editor, placeholderPos, delta);
					accumulated = delta;
					firstTokenSeen = true;
				} else {
					accumulated += delta;
					replaceBlockContent(editor, placeholderPos, accumulated);
				}
			}
		});
		if (!firstTokenSeen) {
			replaceBlockContent(editor, placeholderPos, '[OCR 결과 없음]');
		}
		return { reason: result.reason, text: accumulated };
	} catch (err) {
		const msg = err instanceof LlmChatError ? formatLlmError(err) : (err as Error).message;
		replaceBlockContent(editor, placeholderPos, `[OCR 오류: ${msg}]`);
		return { reason: 'error', text: '' };
	}
}

const LEGACY_OCR_USER_PROMPT = '이 이미지의 텍스트를 추출해줘.';

function buildLegacyOcrSystemPrompt(targetLang: string): string {
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

// --- helpers ---

function normalizeHttpBase(bridgeUrl: string): string {
	return bridgeUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/(ws|llm\/chat|ocr)\/?$/, '')
		.replace(/\/$/, '');
}

async function loadImageB64(opts: RunOcrOptions): Promise<string | null> {
	try {
		const blob = opts.imageBlob ?? (await downloadImageFromDropboxUrl(opts.imageUrl));
		return await imageBlobToBase64(blob);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendBlock(opts.editor, `[OCR 오류: ${msg}]`);
		return null;
	}
}

/**
 * Append a separator paragraph + a content paragraph holding `initialText`.
 * Returns the doc-level position of the content paragraph node so subsequent
 * `replaceBlockContent` calls can re-target it without re-scanning.
 *
 * `initialText` may contain `\n` — each line becomes a text run with a
 * `hardBreak` node between them, matching how the editor renders typed-in
 * line breaks.
 */
function appendBlock(editor: Editor, initialText: string): number {
	const { state, view } = editor;
	const endPos = state.doc.content.size;
	const blank = state.schema.nodes.paragraph.create();
	const block = state.schema.nodes.paragraph.create(
		null,
		buildLineFragments(state.schema, initialText)
	);
	const tr = state.tr.insert(endPos, [blank, block]);
	view.dispatch(tr);
	scrollToBottom(editor);
	// `endPos` was the doc-level position right before the inserted nodes.
	// After insertion, the blank paragraph occupies endPos..endPos+2 and the
	// content paragraph starts at endPos+2.
	return endPos + 2;
}

/**
 * Replace the entire text content of a paragraph identified by its node
 * position. The paragraph node is preserved so its absolute position stays
 * stable across subsequent updates (its `content.size` will change, of
 * course — re-query via `state.doc.nodeAt(paragraphPos)` before next replace).
 */
function replaceBlockContent(editor: Editor, paragraphPos: number, newText: string): void {
	const { state, view } = editor;
	const para = state.doc.nodeAt(paragraphPos);
	if (!para || para.type.name !== 'paragraph') return;
	const fragments = buildLineFragments(state.schema, newText);
	const innerStart = paragraphPos + 1;
	const innerEnd = paragraphPos + 1 + para.content.size;
	const tr = state.tr.replaceWith(innerStart, innerEnd, fragments);
	view.dispatch(tr);
	scrollToBottom(editor);
}

function buildLineFragments(
	schema: Editor['schema'],
	text: string
): PMNode[] {
	const lines = text.split('\n');
	const fragments: PMNode[] = [];
	const hardBreak = schema.nodes.hardBreak;
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && hardBreak) fragments.push(hardBreak.create());
		if (lines[i].length > 0) fragments.push(schema.text(lines[i]));
	}
	return fragments;
}

function scrollToBottom(editor: Editor): void {
	try {
		editor.view.dom.scrollTop = editor.view.dom.scrollHeight;
	} catch {
		/* ignore */
	}
}

function formatOcrError(err: unknown): string {
	if (err instanceof OcrSendError) {
		switch (err.kind) {
			case 'unauthorized':
				return '인증 실패 — 설정에서 브릿지 재로그인';
			case 'ocr_service_unavailable':
				return '데스크탑 OCR 서비스 응답 없음';
			case 'bad_request':
				return `잘못된 요청: ${err.message}`;
			case 'network':
			default:
				return '연결 실패';
		}
	}
	return (err as Error).message;
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
