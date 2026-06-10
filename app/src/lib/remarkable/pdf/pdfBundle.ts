import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractLinkTargets } from '$lib/core/backlinkIndex.js';
import {
	tiptapToPdfmake,
	type PdfBlock,
	type PdfContent,
	type InternalLinkResolver
} from './tiptapToPdfmake.js';
import { extractImageUrlsFromDoc } from './extractImageUrls.js';
import { fetchImagesForBundle } from './fetchImagesForBundle.js';
import { findJsonChartRegions, type JsonChartRegion } from './findJsonChartRegions.js';
import { renderChartsToImages } from './renderChartsToImages.js';

/**
 * 루트 노트 + 내부 링크로 연결된 노트들(depth N까지)을 한 PDF docDefinition 으로
 * 묶는다. 동일 노트는 한 번만 포함하고(dedup), 번들 안의 내부 링크는 같은 PDF
 * 안 다른 섹션으로 점프하는 클릭형 링크가 된다.
 *
 * 본문 첫 paragraph 의 텍스트가 노트 제목과 같으면 (Tomboy 컨벤션 — title 은
 * <note-content> 첫 줄에서 derive 됨) 중복 출력 방지를 위해 본문에서 제거하고,
 * 별도의 큰 제목 블록을 섹션 헤더로 얹는다.
 *
 * `excludedGuids` 로 일부 노트를 번들에서 제외할 수 있다. 제외된 노트는 BFS
 * 자체에서 빠지므로 그 노트로만 도달 가능한 다른 노트들도 자동으로 사라지고,
 * 본문 안 그 노트로의 내부 링크는 plain text 로 떨어진다.
 *
 * 이미지/차트: 호출자가 PDF 생성을 트리거하면 비동기로 imageCache 에서 이미지
 * blob 을 모아 data URI 화하고, 체크된 차트 블록은 Chart.js 로 hidden canvas
 * 에 그려 PNG data URI 로 변환해 그 위치에 넣는다.
 */

export interface PdfBundleOptions {
	/**
	 * forward BFS 깊이 — 0 = 루트만, 1 = 루트가 직접 링크한 노트까지. 최대 5.
	 * 앞으로(forward) 트리에만 적용.
	 */
	forwardDepth: number;
	/**
	 * backward BFS 깊이 — 0 = 루트만, 1 = 루트를 직접 링크하는 노트까지. 최대 5.
	 * 뒤로(backward, 백링크) 트리에만 적용. forward 와 독립.
	 */
	backwardDepth: number;
	/** 번들에서 빼고 싶은 노트 guid 집합. 모달의 체크 해제로 채워진다. */
	excludedGuids?: Set<string>;
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
	/** BFS 결과 번들에 들어간 guid 순서 (루트가 [0]). */
	includedGuids: string[];
}

/**
 * 모달에 보여주는 미리보기 트리. 같은 guid 가 여러 부모 아래에 나타날 수
 * 있으므로 (depth N 범위 안에서 다중 부모를 모두 보여준다) 각 위치를
 * `positionKey` 로 고유 식별한다.
 */
export interface PdfBundleTreeNode {
	guid: string;
	title: string;
	/** 트리 안 유일한 식별자 — Svelte each 키. */
	positionKey: string;
	children: PdfBundleTreeNode[];
}

export interface PdfBundlePreview {
	/**
	 * 앞으로(forward) 트리 — 루트가 링크하는 노트들. 루트가 번들에 없으면 null.
	 */
	forwardTree: PdfBundleTreeNode | null;
	/**
	 * 뒤로(backward) 트리 — 루트를 링크하는 노트들 (백링크). 루트가 번들에 없으면 null.
	 */
	backwardTree: PdfBundleTreeNode | null;
	/** dedup 된 포함 guid 순서 — forward 먼저, 그 뒤 backward 신규분. */
	includedGuids: string[];
	/** guid → 표시용 제목. 본문에 노트가 없는 경우 '제목 없음'. */
	titles: Map<string, string>;
}

/**
 * 실제 PDF 빌드 없이 어떤 노트들이 포함될지(트리 구조 포함) 미리 계산. 모달에서
 * depth 또는 제외 셋이 바뀔 때마다 재계산되는 entry. 이미지 fetch 나 차트
 * 렌더 같은 부수효과는 일으키지 않는다.
 */
export function previewPdfBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): PdfBundlePreview {
	const ctx = traverseBundle(rootGuid, notes, options);
	const titles = new Map<string, string>();
	for (const guid of ctx.ordered) {
		titles.set(guid, ctx.byGuid.get(guid)?.title?.trim() || '제목 없음');
	}
	const hasRoot = ctx.byGuid.has(rootGuid);
	const forwardTree = hasRoot ? buildTree(rootGuid, ctx, 'forward') : null;
	const backwardTree = hasRoot ? buildTree(rootGuid, ctx, 'backward') : null;
	return { forwardTree, backwardTree, includedGuids: ctx.ordered, titles };
}

export async function buildPdfBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): Promise<PdfBundleResult> {
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

	// 이미지 / 차트 비동기 수집. 두 단계 다 실패해도 텍스트만으로 PDF 가
	// 만들어지도록 try/catch.
	const imageMap = await collectImageMap(ctx);
	const chartImagesByGuid = await collectChartImages(ctx);

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
		if (i > 0)
			content.push({
				canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#bbbbbb' }]
			});
		content.push(header);
		const doc = ctx.parseBody(guid);
		if (!doc) continue;
		const body = stripLeadingTitleParagraph(doc, titleText);
		const chartImages = chartImagesByGuid.get(guid) ?? [];
		const { dropTopLevelIndexes, replaceTopLevelIndex } = chartReplaceMaps(body, chartImages);
		for (const block of tiptapToPdfmake(body, {
			resolver,
			imageMap,
			dropTopLevelIndexes,
			replaceTopLevelIndex
		})) {
			content.push(block);
		}
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
	/** forward ∪ backward, dedup, forward 우선 순서. PDF 본문 출력 순서. */
	ordered: string[];
	/** forward ∪ backward — PDF 안 어떤 노트로의 링크가 살아남는지 결정. */
	visited: Set<string>;
	/** BFS 가 forward 방향으로 도달한 노트들. 앞으로(forward) 트리에 쓰인다. */
	forwardVisited: Set<string>;
	/** BFS 가 backward 방향으로 도달한 노트들. 뒤로(backward) 트리에 쓰인다. */
	backwardVisited: Set<string>;
	excluded: Set<string>;
	byGuid: Map<string, NoteData>;
	titleToGuid: Map<string, string>;
	/** guid → 그 노트가 링크하는 대상 guid 들 (중복 제거, 등장 순서 보존). */
	forwardAdj: Map<string, string[]>;
	/** guid → 그 노트를 링크하는 출발 guid 들 (notes 배열 순서로 dedup). */
	backwardAdj: Map<string, string[]>;
	chartRegionsByGuid: Map<string, JsonChartRegion[]>;
	forwardDepth: number;
	backwardDepth: number;
	parseBody(guid: string): JSONContent | null;
}

function traverseBundle(
	rootGuid: string,
	notes: NoteData[],
	options: PdfBundleOptions
): TraversalCtx {
	const forwardDepth = Math.max(0, Math.floor(options.forwardDepth));
	const backwardDepth = Math.max(0, Math.floor(options.backwardDepth));
	const excluded = options.excludedGuids ?? new Set<string>();

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

	// Forward + backward adjacency 를 XML regex 로 한 번에 빌드.
	// extractLinkTargets 는 link:internal + link:broken 모두 잡지만 broken 은
	// titleToGuid 에 해당 항목이 보통 없으므로 자연 필터링된다 (제목이 살아 있는
	// broken 마크는 의도된 edge 로 본다 — 정렬 안 된 note 의 stale 마크일 뿐
	// 사용자가 의도한 참조). JSON 디시리얼라이즈 비용을 안 들이고 모든 노트에
	// 대해 두 방향을 모두 채울 수 있다.
	const forwardAdj = new Map<string, string[]>();
	const backwardAdj = new Map<string, string[]>();
	for (const note of notes) {
		const targets: string[] = [];
		const seen = new Set<string>();
		for (const rawTitle of extractLinkTargets(note.xmlContent)) {
			const key = rawTitle.trim();
			if (!key) continue;
			const targetGuid = titleToGuid.get(key);
			if (!targetGuid || targetGuid === note.guid || seen.has(targetGuid)) continue;
			seen.add(targetGuid);
			targets.push(targetGuid);
			const back = backwardAdj.get(targetGuid);
			if (back) back.push(note.guid);
			else backwardAdj.set(targetGuid, [note.guid]);
		}
		forwardAdj.set(note.guid, targets);
	}

	const forwardVisited = new Set<string>();
	const backwardVisited = new Set<string>();
	const ordered: string[] = [];
	const visited = new Set<string>();
	const ctxBase: TraversalCtx = {
		ordered,
		visited,
		forwardVisited,
		backwardVisited,
		excluded,
		byGuid,
		titleToGuid,
		forwardAdj,
		backwardAdj,
		chartRegionsByGuid: new Map(),
		forwardDepth,
		backwardDepth,
		parseBody
	};

	if (!byGuid.has(rootGuid) || excluded.has(rootGuid)) return ctxBase;

	function bfs(
		adj: Map<string, string[]>,
		maxDepth: number
	): { visited: Set<string>; ordered: string[] } {
		const out: string[] = [];
		const seen = new Set<string>();
		const enqueued = new Set<string>([rootGuid]);
		type QItem = { guid: string; d: number };
		const queue: QItem[] = [{ guid: rootGuid, d: 0 }];
		while (queue.length > 0) {
			const { guid, d } = queue.shift()!;
			if (seen.has(guid)) continue;
			seen.add(guid);
			out.push(guid);
			if (d === maxDepth) continue;
			for (const nextGuid of adj.get(guid) ?? []) {
				if (excluded.has(nextGuid) || enqueued.has(nextGuid)) continue;
				enqueued.add(nextGuid);
				queue.push({ guid: nextGuid, d: d + 1 });
			}
		}
		return { visited: seen, ordered: out };
	}

	const fwd = bfs(forwardAdj, forwardDepth);
	const bwd = bfs(backwardAdj, backwardDepth);
	for (const g of fwd.visited) forwardVisited.add(g);
	for (const g of bwd.visited) backwardVisited.add(g);

	// PDF 본문 출력 순서: forward 그대로 + backward 의 신규분 추가. 루트는
	// forward 의 [0] 으로 한 번만 들어가고 backward 에서 중복 안 됨.
	for (const g of fwd.ordered) {
		if (visited.has(g)) continue;
		visited.add(g);
		ordered.push(g);
	}
	for (const g of bwd.ordered) {
		if (visited.has(g)) continue;
		visited.add(g);
		ordered.push(g);
	}

	// 차트 영역은 트리 빌드와 무관하게 노트별로 미리 캐시. PDF 빌드 시
	// 같은 데이터를 두 번 파싱하지 않도록.
	const chartRegionsByGuid = new Map<string, JsonChartRegion[]>();
	for (const guid of ordered) {
		const doc = parseBody(guid);
		if (!doc) continue;
		chartRegionsByGuid.set(guid, findJsonChartRegions(doc));
	}
	ctxBase.chartRegionsByGuid = chartRegionsByGuid;

	return ctxBase;
}

/**
 * 트리를 DFS 로 만든다. 같은 guid 가 여러 부모 아래 등장할 수 있다 — depth 만
 * 지키면 됨. 사이클은 ancestors set 으로 차단.
 *
 * direction:
 *   'forward'  — 루트가 링크하는 방향 (forward adjacency)
 *   'backward' — 루트를 링크하는 방향 (backward adjacency, 백링크 트리)
 *
 * positionKey 가 두 트리에서 충돌하지 않도록 root 경로에 방향 prefix 를 붙인다.
 */
function buildTree(
	rootGuid: string,
	ctx: TraversalCtx,
	direction: 'forward' | 'backward'
): PdfBundleTreeNode {
	const depth = direction === 'forward' ? ctx.forwardDepth : ctx.backwardDepth;
	const adj = direction === 'forward' ? ctx.forwardAdj : ctx.backwardAdj;
	const dirVisited = direction === 'forward' ? ctx.forwardVisited : ctx.backwardVisited;

	function titleOf(guid: string): string {
		return ctx.byGuid.get(guid)?.title?.trim() || '제목 없음';
	}

	function walk(guid: string, d: number, ancestors: Set<string>, path: string): PdfBundleTreeNode {
		const children: PdfBundleTreeNode[] = [];
		if (d < depth) {
			for (const next of adj.get(guid) ?? []) {
				if (ctx.excluded.has(next) || !dirVisited.has(next)) continue;
				if (ancestors.has(next)) continue;
				const childPath = `${path}>${next}`;
				const nextAncestors = new Set(ancestors);
				nextAncestors.add(next);
				children.push(walk(next, d + 1, nextAncestors, childPath));
			}
		}
		return { guid, title: titleOf(guid), positionKey: path, children };
	}

	return walk(rootGuid, 0, new Set([rootGuid]), `${direction}:${rootGuid}`);
}

async function collectImageMap(ctx: TraversalCtx): Promise<Map<string, string>> {
	const urls = new Set<string>();
	for (const guid of ctx.ordered) {
		const doc = ctx.parseBody(guid);
		if (!doc) continue;
		for (const url of extractImageUrlsFromDoc(doc)) urls.add(url);
	}
	if (urls.size === 0) return new Map();
	try {
		return await fetchImagesForBundle([...urls]);
	} catch {
		return new Map();
	}
}

async function collectChartImages(
	ctx: TraversalCtx
): Promise<Map<string, Array<{ dataUri: string; width: number; height: number } | null>>> {
	const notesByTitle = new Map<string, NoteData>();
	for (const note of ctx.byGuid.values()) {
		const key = note.title.trim();
		if (key) notesByTitle.set(key, note);
	}
	const regionsByGuid = new Map<string, JsonChartRegion[]>();
	let any = false;
	for (const [guid, regions] of ctx.chartRegionsByGuid) {
		if (regions.length === 0) continue;
		const checked = regions.filter((r) => r.checked);
		if (checked.length === 0) continue;
		regionsByGuid.set(guid, checked);
		any = true;
	}
	if (!any) return new Map();
	if (typeof document === 'undefined') return new Map();
	try {
		return await renderChartsToImages(regionsByGuid, notesByTitle);
	} catch {
		return new Map();
	}
}

/**
 * body (제목 paragraph 가 잘렸을 수도 있는 doc) 안에서 다시 차트 region 을 찾고,
 * 순서대로 미리 렌더한 chartImages 와 짝지어 치환/제거 인덱스를 만든다.
 * `stripLeadingTitleParagraph` 가 잘라낼 수 있는 첫 paragraph 는 노트 title 과
 * 동일한 텍스트뿐이고, 그 paragraph 은 "Chart:" 헤더가 될 수 없으므로
 * 체크된 차트 영역의 순서는 strip 전후 항상 같다 — i 번째 체크된 region 을
 * i 번째 ChartImage 로 짝지으면 안전하다.
 */
function chartReplaceMaps(
	body: JSONContent,
	chartImages: Array<{ dataUri: string; width: number; height: number } | null>
): {
	dropTopLevelIndexes?: Set<number>;
	replaceTopLevelIndex?: Map<number, PdfContent>;
} {
	if (chartImages.length === 0) return {};
	const drop = new Set<number>();
	const replace = new Map<number, PdfContent>();

	const bodyRegions = findJsonChartRegions(body).filter((r) => r.checked);
	for (let i = 0; i < bodyRegions.length && i < chartImages.length; i++) {
		const image = chartImages[i];
		const region = bodyRegions[i];
		if (!image) continue;
		replace.set(region.headerIndex, {
			image: image.dataUri,
			width: image.width,
			margin: [0, 10, 0, 10]
		});
		if (region.configListIndex !== undefined) drop.add(region.configListIndex);
	}

	return {
		dropTopLevelIndexes: drop.size > 0 ? drop : undefined,
		replaceTopLevelIndex: replace.size > 0 ? replace : undefined
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
