import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractInternalLinkTargets } from '$lib/graph/extractInternalLinks.js';
import {
	tiptapToPdfmake,
	type PdfBlock,
	type PdfContent,
	type InternalLinkResolver
} from './tiptapToPdfmake.js';

/**
 * 루트 노트 + 내부 링크로 연결된 노트들(depth N까지)을 한 PDF docDefinition 으로
 * 묶는다. 동일 노트는 한 번만 포함하고(dedup), 번들 안의 내부 링크는 같은 PDF
 * 안 다른 섹션으로 점프하는 클릭형 링크가 된다.
 *
 * 본문 첫 paragraph 의 텍스트가 노트 제목과 같으면 (Tomboy 컨벤션 — title 은
 * <note-content> 첫 줄에서 derive 됨) 중복 출력 방지를 위해 본문에서 제거하고,
 * 별도의 큰 제목 블록을 섹션 헤더로 얹는다.
 */

export interface PdfBundleOptions {
	/** 0 = 루트만, 1 = 루트 + 직접 링크, 2 = ... 권장 상한 3. */
	depth: number;
}

/**
 * pdfmake docDefinition 의 우리가 채우는 부분만 타입화. pdfmake 는 알지 못하는
 * 키를 무시하므로 부분 셋만 들고 있어도 안전하다.
 */
export interface PdfDocDefinition {
	info?: { title?: string; creator?: string };
	content: PdfContent[];
	defaultStyle?: Record<string, unknown>;
	styles?: Record<string, Record<string, unknown>>;
	pageMargins?: [number, number, number, number];
}

export interface PdfBundleResult {
	docDefinition: PdfDocDefinition;
	/** BFS 결과 번들에 들어간 guid 순서 (루트가 [0]). 모달 "N개 노트 포함" 표시용. */
	includedGuids: string[];
}

export interface PdfBundlePreview {
	includedGuids: string[];
	/** 포함된 노트들의 표시용 제목, includedGuids 와 같은 순서. */
	titles: string[];
}

/**
 * 실제 PDF 빌드 없이 어떤 노트들이 포함될지만 미리 계산. 모달에서 depth 변경 시
 * 실시간 표시용. BFS 로직은 빌드와 100% 동일하므로 동작 차이는 없다.
 */
export function previewPdfBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): PdfBundlePreview {
	const ctx = traverseBundle(rootGuid, notes, options);
	const titles = ctx.ordered.map((g) => ctx.byGuid.get(g)?.title?.trim() || '제목 없음');
	return { includedGuids: ctx.ordered, titles };
}

export function buildPdfBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): PdfBundleResult {
	const ctx = traverseBundle(rootGuid, notes, options);
	if (ctx.ordered.length === 0) return { docDefinition: { content: [] }, includedGuids: [] };

	const root = ctx.byGuid.get(rootGuid)!;
	const resolver: InternalLinkResolver = {
		resolveInternalTarget: (target) => {
			const key = target.trim();
			if (!key) return null;
			const guid = ctx.titleToGuid.get(key);
			return guid && ctx.visited.has(guid) ? guid : null;
		}
	};

	const content: PdfContent[] = [];

	// 목차 — 두 개 이상일 때만. 제목 클릭 시 해당 섹션으로 점프.
	if (ctx.ordered.length > 1) {
		content.push({ text: '목차', style: 'tocHeader' });
		content.push({
			ul: ctx.ordered.map((g) => {
				const t = ctx.byGuid.get(g)?.title?.trim() || '제목 없음';
				return {
					text: t,
					linkToDestination: `note-${g}`,
					style: 'tocItem'
				} as PdfContent;
			}),
			margin: [0, 0, 0, 16]
		});
	}

	for (let i = 0; i < ctx.ordered.length; i++) {
		const guid = ctx.ordered[i];
		const note = ctx.byGuid.get(guid);
		if (!note) continue;
		const titleText = note.title.trim() || '제목 없음';
		// 노트 간 연결: pageBreak 를 강제하지 않는다. 짧은 노트는 같은 페이지에
		// 흘려 담기고, pdfmake 가 페이지 끝에 닿으면 자동으로 줄넘김.
		// 대신 헤더 위에 넉넉한 margin + 구분선 으로 시각적 경계.
		const header: PdfBlock = {
			text: titleText,
			style: 'noteTitle',
			id: `note-${guid}`,
			...(i > 0 ? { margin: [0, 40, 0, 12] } : {})
		};
		if (i > 0) content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#bbbbbb' }] });
		content.push(header);
		const doc = ctx.parseBody(guid);
		if (!doc) continue;
		const body = stripLeadingTitleParagraph(doc, titleText);
		for (const block of tiptapToPdfmake(body, resolver)) content.push(block);
	}

	return {
		docDefinition: {
			info: { title: root.title || '제목 없음', creator: 'Tomboy Web' },
			content,
			defaultStyle: { font: 'Korean', fontSize: 13, lineHeight: 1.5 },
			styles: {
				noteTitle: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] },
				tocHeader: { fontSize: 16, bold: true, margin: [0, 0, 0, 8] },
				tocItem: { color: '#1a6fc4', decoration: 'underline' }
			},
			pageMargins: [40, 50, 40, 50]
		},
		includedGuids: ctx.ordered
	};
}

interface TraversalCtx {
	ordered: string[];
	visited: Set<string>;
	byGuid: Map<string, NoteData>;
	titleToGuid: Map<string, string>;
	parseBody(guid: string): JSONContent | null;
}

function traverseBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): TraversalCtx {
	const depth = Math.max(0, Math.floor(options.depth));

	const byGuid = new Map<string, NoteData>();
	for (const n of notes) byGuid.set(n.guid, n);

	const titleToGuid = new Map<string, string>();
	const titleChangeDate = new Map<string, string>();
	for (const n of notes) {
		const key = n.title.trim();
		if (!key) continue;
		const existing = titleChangeDate.get(key);
		if (existing === undefined || (n.changeDate ?? '') > existing) {
			titleToGuid.set(key, n.guid);
			titleChangeDate.set(key, n.changeDate ?? '');
		}
	}

	const parsed = new Map<string, JSONContent>();
	function parseBody(guid: string): JSONContent | null {
		if (parsed.has(guid)) return parsed.get(guid)!;
		const note = byGuid.get(guid);
		if (!note) return null;
		try {
			const doc = deserializeContent(note.xmlContent);
			parsed.set(guid, doc);
			return doc;
		} catch {
			return null;
		}
	}

	const ordered: string[] = [];
	const visited = new Set<string>();
	if (!byGuid.has(rootGuid)) {
		return { ordered, visited, byGuid, titleToGuid, parseBody };
	}
	const enqueued = new Set<string>([rootGuid]);
	type QItem = { guid: string; d: number };
	const queue: QItem[] = [{ guid: rootGuid, d: 0 }];
	while (queue.length > 0) {
		const { guid, d } = queue.shift()!;
		if (visited.has(guid)) continue;
		visited.add(guid);
		ordered.push(guid);
		if (d === depth) continue;
		const doc = parseBody(guid);
		if (!doc) continue;
		for (const rawTarget of extractInternalLinkTargets(doc)) {
			const key = rawTarget.trim();
			if (!key) continue;
			const targetGuid = titleToGuid.get(key);
			if (!targetGuid || enqueued.has(targetGuid)) continue;
			enqueued.add(targetGuid);
			queue.push({ guid: targetGuid, d: d + 1 });
		}
	}

	return { ordered, visited, byGuid, titleToGuid, parseBody };
}

/**
 * 본문 첫 paragraph 가 title 과 같은 텍스트면 제거한 새 doc 을 반환. 일치 안 하면
 * 원본 그대로 반환. paragraph 안에 mark 가 섞여 있어도 plain 텍스트 비교만 한다
 * (헤더 표시에 mark 를 들고 가는 게 시각적으로 더 깔끔해서).
 */
function stripLeadingTitleParagraph(doc: JSONContent, title: string): JSONContent {
	const children = doc.content;
	if (!children || children.length === 0) return doc;
	const first = children[0];
	if (first.type !== 'paragraph') return doc;
	const flat = plainText(first).trim();
	if (flat !== title) return doc;
	return { ...doc, content: children.slice(1) };
}

function plainText(node: JSONContent): string {
	if (node.type === 'text') return node.text ?? '';
	if (!node.content) return '';
	return node.content.map(plainText).join('');
}
