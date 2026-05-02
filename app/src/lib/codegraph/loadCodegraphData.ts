import type {
	CodegraphData,
	CodegraphLink,
	CodegraphMeta,
	CodegraphNode,
	LoadResult
} from './codegraphTypes.js';

const KNOWN_CONFIDENCE = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
const KNOWN_FILE_TYPE = new Set(['code', 'document', 'paper', 'image']);

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

function coerceConfidence(v: unknown): 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' {
	if (typeof v === 'string' && KNOWN_CONFIDENCE.has(v)) {
		return v as 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
	}
	return 'INFERRED';
}

function coerceFileType(v: unknown): CodegraphNode['fileType'] {
	if (typeof v === 'string' && KNOWN_FILE_TYPE.has(v)) {
		return v as CodegraphNode['fileType'];
	}
	return 'code';
}

function validateMeta(raw: unknown): CodegraphMeta | null {
	if (!isObject(raw)) return null;
	const { repoUrl, branch, syncedAt, nodeCount, linkCount } = raw;
	if (typeof repoUrl !== 'string') return null;
	if (typeof branch !== 'string') return null;
	if (typeof syncedAt !== 'string') return null;
	if (typeof nodeCount !== 'number') return null;
	if (typeof linkCount !== 'number') return null;
	return { repoUrl, branch, syncedAt, nodeCount, linkCount };
}

function validateCommunityLabels(raw: unknown): Record<string, string> {
	if (!isObject(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === 'string') out[k] = v;
	}
	return out;
}

export async function loadCodegraphData(): Promise<LoadResult> {
	let graphResp: Response;
	let metaResp: Response;
	let communitiesResp: Response;
	try {
		[graphResp, metaResp, communitiesResp] = await Promise.all([
			fetch('/codegraph.json'),
			fetch('/codegraph-meta.json'),
			fetch('/codegraph-communities.json')
		]);
	} catch (e) {
		return { ok: false, reason: 'network', detail: errorMessage(e) };
	}

	if (!graphResp.ok || !metaResp.ok) {
		return { ok: false, reason: 'missing' };
	}

	let graphRaw: unknown;
	let metaRaw: unknown;
	try {
		graphRaw = await graphResp.json();
	} catch (e) {
		return { ok: false, reason: 'malformed', detail: errorMessage(e) };
	}
	try {
		metaRaw = await metaResp.json();
	} catch (e) {
		return { ok: false, reason: 'malformed', detail: errorMessage(e) };
	}

	let communitiesRaw: unknown = {};
	if (communitiesResp.ok) {
		try {
			communitiesRaw = await communitiesResp.json();
		} catch (e) {
			console.warn('[codegraph] communities sidecar parse failed; falling back to empty map', e);
			communitiesRaw = {};
		}
	}

	if (!isObject(graphRaw)) {
		return { ok: false, reason: 'malformed', detail: 'codegraph.json is not an object' };
	}
	const rawNodes = graphRaw.nodes;
	const rawLinks = graphRaw.links;
	if (!Array.isArray(rawNodes) || !Array.isArray(rawLinks)) {
		return {
			ok: false,
			reason: 'malformed',
			detail: 'codegraph.json: nodes/links must be arrays'
		};
	}

	const meta = validateMeta(metaRaw);
	if (!meta) {
		return {
			ok: false,
			reason: 'malformed',
			detail: 'codegraph-meta.json: missing required fields'
		};
	}

	// Validate every node has id (string, non-empty) before any transformation.
	for (let i = 0; i < rawNodes.length; i++) {
		const n = rawNodes[i];
		if (!isObject(n) || !isNonEmptyString(n.id)) {
			return {
				ok: false,
				reason: 'malformed',
				detail: `node at index ${i} missing required id`
			};
		}
	}

	// First pass over links: filter invalid + transform, and collect degrees.
	const degreeMap = new Map<string, number>();
	const links: CodegraphLink[] = [];
	for (const raw of rawLinks) {
		if (!isObject(raw)) continue;
		const source = raw.source;
		const target = raw.target;
		if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
			// Skip invalid link, keep loading.
			continue;
		}
		const relation = typeof raw.relation === 'string' ? raw.relation : '';
		const confidence = coerceConfidence(raw.confidence);
		const confidenceScore =
			typeof raw.confidence_score === 'number'
				? raw.confidence_score
				: typeof raw.confidenceScore === 'number'
					? raw.confidenceScore
					: 0.5;
		links.push({ source, target, relation, confidence, confidenceScore });
		degreeMap.set(source, (degreeMap.get(source) ?? 0) + 1);
		degreeMap.set(target, (degreeMap.get(target) ?? 0) + 1);
	}

	let maxDegree = 0;
	for (const d of degreeMap.values()) {
		if (d > maxDegree) maxDegree = d;
	}
	const logMax = Math.log1p(maxDegree);

	const nodes: CodegraphNode[] = rawNodes.map((raw) => {
		const r = raw as Record<string, unknown>;
		const id = r.id as string;
		const degree = degreeMap.get(id) ?? 0;
		const sizeRaw = logMax === 0 ? 1.0 : 1 + Math.log1p(degree) / logMax;
		const size = Math.min(2, sizeRaw);
		const sourceLocation =
			typeof r.source_location === 'string' && r.source_location.length > 0
				? r.source_location
				: null;
		return {
			id,
			title: typeof r.label === 'string' ? r.label : id,
			community: typeof r.community === 'number' ? r.community : 0,
			fileType: coerceFileType(r.file_type),
			sourceFile: typeof r.source_file === 'string' ? r.source_file : '',
			sourceLocation,
			degree,
			size
		};
	});

	const communityLabels = validateCommunityLabels(communitiesRaw);

	const data: CodegraphData = { nodes, links, meta, communityLabels };
	return { ok: true, data };
}
