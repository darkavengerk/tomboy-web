import type { JSONContent } from '@tiptap/core';
import { splitTextOnImageUrls } from './extractImageUrls.js';

/**
 * TipTap 노트 JSON → pdfmake content 노드 변환.
 *
 * pdfmake 의 런타임 타입을 끌어오지 않으려고 우리가 만들어 보내는 모양만
 * 좁게 선언한다. pdfmake 는 모르는 키를 조용히 무시하므로 부분 셋만 들고
 * 있어도 안전하다.
 *
 * 변환 정책:
 * - 텍스트 마크: bold/italic/strike/underline/highlight 는 pdfmake 인라인
 *   속성으로 매핑. tomboyMonospace 는 `style: 'mono'` (별도 폰트 등록 시).
 * - 외부 링크(`tomboyUrlLink`): pdfmake `link` 속성으로 → PDF 위 탭/클릭 시
 *   브라우저 열림.
 * - 내부 링크(`tomboyInternalLink`): 번들 안에 그 노트가 함께 들어 있을 때만
 *   `linkToDestination: 'note-{guid}'` 로 만들어 같은 PDF 안 다른 섹션으로
 *   점프. 번들 밖이면 링크 속성 없이 텍스트만 남긴다.
 * - 인라인 체크박스: `[x]` / `[ ]` 리터럴 (PDF 그래픽으로 그리는 건 후순위).
 * - 이미지: 본문 텍스트 안 이미지 URL 을 `splitTextOnImageUrls` 로 잘라
 *   `imageMap[url]` 의 data URI 가 있으면 별도 pdfmake `image` 블록으로 띄운다.
 *   매핑이 없으면 (fetch 실패 등) 그냥 URL 텍스트로 둔다. 단 최상위 paragraph
 *   에만 적용 — listItem 안 이미지 URL 은 plain text. (paragraph 분할이
 *   list 구조와 맞지 않아 v2 에서는 의도적으로 스킵.)
 * - 차트: 호출자가 미리 렌더한 PNG 를 `replaceTopLevelIndex` 로 넘기면 해당
 *   인덱스의 paragraph 가 image block 으로 대체되고, `dropTopLevelIndexes`
 *   에 포함된 config list 인덱스는 통째로 제거된다.
 */

export type PdfContent = string | PdfBlock;

export interface PdfBlock {
	text?: string | PdfInline[];
	ul?: PdfContent[];
	ol?: PdfContent[];
	stack?: PdfContent[];
	canvas?: PdfCanvasOp[];
	image?: string;
	width?: number;
	height?: number;
	style?: string | string[];
	id?: string;
	linkToDestination?: string;
	link?: string;
	bold?: boolean;
	italics?: boolean;
	decoration?: string | string[];
	background?: string;
	color?: string;
	margin?: [number, number, number, number];
	pageBreak?: 'before' | 'after';
}

export interface PdfCanvasOp {
	type: 'line';
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	lineWidth?: number;
	lineColor?: string;
}

export type PdfInline = string | PdfBlock;

export interface InternalLinkResolver {
	/** 번들에 포함된 노트의 제목 → guid. 번들 밖이면 null. */
	resolveInternalTarget(target: string): string | null;
}

export interface TiptapToPdfmakeOptions {
	resolver: InternalLinkResolver;
	/** url(노트 텍스트에 보이는 그대로) → `data:image/...;base64,...` data URI. */
	imageMap?: Map<string, string>;
	/** 최상위 `doc.content` 안 이 인덱스의 노드는 출력에서 제거. */
	dropTopLevelIndexes?: Set<number>;
	/** 최상위 `doc.content` 안 이 인덱스의 노드를 주어진 블록으로 치환. */
	replaceTopLevelIndex?: Map<number, PdfContent>;
}

function isResolver(x: InternalLinkResolver | TiptapToPdfmakeOptions): x is InternalLinkResolver {
	return typeof (x as InternalLinkResolver).resolveInternalTarget === 'function';
}

export function tiptapToPdfmake(
	json: JSONContent,
	resolverOrOptions: InternalLinkResolver | TiptapToPdfmakeOptions
): PdfContent[] {
	const opts: TiptapToPdfmakeOptions = isResolver(resolverOrOptions)
		? { resolver: resolverOrOptions }
		: resolverOrOptions;

	if (json.type !== 'doc') {
		const single = renderBlock(json, opts);
		return single;
	}
	const out: PdfContent[] = [];
	const children = json.content ?? [];
	for (let i = 0; i < children.length; i++) {
		if (opts.dropTopLevelIndexes?.has(i)) continue;
		const replacement = opts.replaceTopLevelIndex?.get(i);
		if (replacement !== undefined) {
			out.push(replacement);
			continue;
		}
		for (const block of renderBlock(children[i], opts)) out.push(block);
	}
	return out;
}

function renderBlock(node: JSONContent, opts: TiptapToPdfmakeOptions): PdfContent[] {
	switch (node.type) {
		case 'paragraph':
			return renderParagraph(node, opts);
		case 'bulletList':
			return [{ ul: (node.content ?? []).map((li) => renderListItem(li, opts)) }];
		case 'orderedList':
			return [{ ol: (node.content ?? []).map((li) => renderListItem(li, opts)) }];
		default:
			return [];
	}
}

type ParagraphPiece = { kind: 'inline'; inline: PdfInline } | { kind: 'image'; url: string };

function renderParagraph(node: JSONContent, opts: TiptapToPdfmakeOptions): PdfContent[] {
	const pieces: ParagraphPiece[] = [];
	for (const child of node.content ?? []) {
		if (child.type === 'text' && typeof child.text === 'string') {
			const marks = child.marks ?? [];
			for (const seg of splitTextOnImageUrls(child.text)) {
				if (seg.kind === 'image') {
					pieces.push({ kind: 'image', url: seg.value });
				} else if (seg.value) {
					pieces.push({
						kind: 'inline',
						inline: applyMarks({ text: seg.value }, marks, opts.resolver)
					});
				}
			}
			continue;
		}
		const inline = renderInline(child, opts.resolver);
		if (inline !== null) pieces.push({ kind: 'inline', inline });
	}

	const blocks: PdfContent[] = [];
	let buffer: PdfInline[] = [];
	const flush = (): void => {
		if (buffer.length > 0) {
			blocks.push({ text: buffer });
			buffer = [];
		}
	};
	for (const piece of pieces) {
		if (piece.kind === 'image') {
			const dataUri = opts.imageMap?.get(piece.url);
			if (dataUri) {
				flush();
				blocks.push({ image: dataUri, width: 480, margin: [0, 6, 0, 6] });
			} else {
				// 사전 fetch 실패 — URL 을 plain text 로라도 보여서 사용자가 알 수
				// 있게.
				buffer.push({ text: piece.url });
			}
		} else {
			buffer.push(piece.inline);
		}
	}
	flush();
	if (blocks.length === 0) blocks.push({ text: [] });
	return blocks;
}

function renderListItem(li: JSONContent, opts: TiptapToPdfmakeOptions): PdfContent {
	// listItem 은 paragraph + 중첩 list 의 시퀀스. pdfmake 는 item 자체에
	// stack 을 허용하므로 그대로 펼쳐 담는다. 단일 item 은 wrapper 를 벗긴다.
	// 이미지 분할은 list-item paragraph 에는 적용하지 않는다 — list 안에서
	// paragraph 를 쪼개면 item 경계가 흐트러져서.
	const items: PdfContent[] = [];
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph') {
			items.push({ text: renderInlines(child.content ?? [], opts.resolver) });
		} else {
			for (const block of renderBlock(child, opts)) items.push(block);
		}
	}
	if (items.length === 0) return { text: '' };
	if (items.length === 1) return items[0];
	return { stack: items };
}

function renderInlines(content: JSONContent[], resolver: InternalLinkResolver): PdfInline[] {
	const out: PdfInline[] = [];
	for (const node of content) {
		const inline = renderInline(node, resolver);
		if (inline !== null) out.push(inline);
	}
	return out;
}

function renderInline(node: JSONContent, resolver: InternalLinkResolver): PdfInline | null {
	if (node.type === 'text') {
		const text = node.text ?? '';
		if (!text) return null;
		const marks = node.marks ?? [];
		return applyMarks({ text }, marks, resolver);
	}
	if (node.type === 'hardBreak') return '\n';
	if (node.type === 'inlineCheckbox') return node.attrs?.checked ? '[x]' : '[ ]';
	if (node.type === 'footnoteMarker') {
		const label = (node.attrs?.label as string | undefined) ?? '';
		return { text: `[^${label}]` };
	}
	return null;
}

function applyMarks(
	base: PdfBlock,
	marks: Array<{ type: string; attrs?: Record<string, unknown> }>,
	resolver: InternalLinkResolver
): PdfBlock {
	let out: PdfBlock = base;
	for (const mark of marks) {
		switch (mark.type) {
			case 'bold':
				out = { ...out, bold: true };
				break;
			case 'italic':
				out = { ...out, italics: true };
				break;
			case 'strike':
				out = withDecoration(out, 'lineThrough');
				break;
			case 'underline':
				out = withDecoration(out, 'underline');
				break;
			case 'highlight':
				out = { ...out, background: 'yellow' };
				break;
			case 'tomboyMonospace':
				out = { ...out, style: 'mono' };
				break;
			case 'tomboyUrlLink': {
				const href = String(mark.attrs?.href ?? '').trim();
				if (href) {
					out = withDecoration({ ...out, link: href, color: '#1a6fc4' }, 'underline');
				}
				break;
			}
			case 'tomboyInternalLink': {
				const target = String(mark.attrs?.target ?? '').trim();
				if (target) {
					const guid = resolver.resolveInternalTarget(target);
					if (guid) {
						out = withDecoration(
							{ ...out, linkToDestination: `note-${guid}`, color: '#1a6fc4' },
							'underline'
						);
					}
				}
				break;
			}
		}
	}
	return out;
}

function withDecoration(block: PdfBlock, deco: string): PdfBlock {
	const existing = block.decoration;
	if (existing === undefined) return { ...block, decoration: deco };
	if (Array.isArray(existing)) return { ...block, decoration: [...existing, deco] };
	return { ...block, decoration: [existing, deco] };
}
