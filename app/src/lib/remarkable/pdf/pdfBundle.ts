import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractInternalLinkTargets } from '$lib/graph/extractInternalLinks.js';
import {
	tiptapToPdfmake,
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

export function buildPdfBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): PdfBundleResult {
	const depth = Math.max(0, Math.floor(options.depth));

	const byGuid = new Map<string, NoteData>();
	for (const n of notes) byGuid.set(n.guid, n);
	const root = byGuid.get(rootGuid);
	if (!root) return { docDefinition: { content: [] }, includedGuids: [] };

	// title → guid (제목 중복 시 가장 최근에 변경된 노트가 이긴다 — buildGraph 와 일관).
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

	// 본문 deserialize 결과를 한 번만 만들어 BFS 와 렌더 양쪽에 재사용.
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

	// BFS — 큐에 같은 guid 중복 enqueue 금지. visited 는 방문 확정만 표시.
	const ordered: string[] = [];
	const visited = new Set<string>();
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

	const resolver: InternalLinkResolver = {
		resolveInternalTarget: (target) => {
			const key = target.trim();
			if (!key) return null;
			const guid = titleToGuid.get(key);
			return guid && visited.has(guid) ? guid : null;
		}
	};

	const content: PdfContent[] = [];
	for (let i = 0; i < ordered.length; i++) {
		const guid = ordered[i];
		const note = byGuid.get(guid);
		if (!note) continue;
		const titleText = note.title.trim() || '제목 없음';
		const header = {
			text: titleText,
			style: 'noteTitle',
			id: `note-${guid}`,
			...(i > 0 ? { pageBreak: 'before' as const } : {})
		};
		content.push(header);
		const doc = parseBody(guid);
		if (!doc) continue;
		const body = stripLeadingTitleParagraph(doc, titleText);
		for (const block of tiptapToPdfmake(body, resolver)) content.push(block);
	}

	return {
		docDefinition: {
			info: { title: root.title || '제목 없음', creator: 'Tomboy Web' },
			content,
			defaultStyle: { font: 'Korean', fontSize: 11, lineHeight: 1.35 },
			styles: {
				noteTitle: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] }
			},
			pageMargins: [40, 50, 40, 50]
		},
		includedGuids: ordered
	};
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
