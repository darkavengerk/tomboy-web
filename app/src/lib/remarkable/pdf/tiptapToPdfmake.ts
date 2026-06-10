import type { JSONContent } from '@tiptap/core';

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
 * - 인라인 체크박스: `[x]` / `[ ]` 리터럴 (PDF 그래픽으로 그리는 건 v1 후순위).
 * - 이미지 노드는 일단 무시(v1) — pdfmake 이미지는 dataURI 필요해 별도
 *   fetch/캐시 단계가 들어가야 한다. v2 에서 imageCache 와 묶어 처리.
 */

export type PdfContent = string | PdfBlock;

export interface PdfBlock {
	text?: string | PdfInline[];
	ul?: PdfContent[];
	ol?: PdfContent[];
	stack?: PdfContent[];
	canvas?: PdfCanvasOp[];
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

export function tiptapToPdfmake(
	json: JSONContent,
	resolver: InternalLinkResolver
): PdfContent[] {
	if (json.type !== 'doc') {
		const single = renderBlock(json, resolver);
		return single === null ? [] : [single];
	}
	const out: PdfContent[] = [];
	for (const child of json.content ?? []) {
		const rendered = renderBlock(child, resolver);
		if (rendered !== null) out.push(rendered);
	}
	return out;
}

function renderBlock(node: JSONContent, resolver: InternalLinkResolver): PdfContent | null {
	switch (node.type) {
		case 'paragraph':
			return { text: renderInlines(node.content ?? [], resolver) };
		case 'bulletList':
			return { ul: (node.content ?? []).map((li) => renderListItem(li, resolver)) };
		case 'orderedList':
			return { ol: (node.content ?? []).map((li) => renderListItem(li, resolver)) };
		default:
			return null;
	}
}

function renderListItem(li: JSONContent, resolver: InternalLinkResolver): PdfContent {
	// listItem 은 paragraph + 중첩 list 의 시퀀스. pdfmake 는 item 자체에
	// stack 을 허용하므로 그대로 펼쳐 담는다. 단일 item 은 wrapper 를 벗긴다.
	const items: PdfContent[] = [];
	for (const child of li.content ?? []) {
		const block = renderBlock(child, resolver);
		if (block !== null) items.push(block);
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
