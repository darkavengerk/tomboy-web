import type { NoteData } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractInternalLinkTargets } from './extractInternalLinks.js';

export interface GraphNode {
	/** Note GUID — used as the d3-force / 3d-force-graph node id */
	id: string;
	title: string;
	/** Combined in+out degree */
	degree: number;
	/** Render scale: 1 (no links) to 2 (most-linked note), log-scaled */
	size: number;
	/** True iff this is the user-configured home note */
	isHome: boolean;
	/** True iff this is the fixed sleep note */
	isSleep: boolean;
}

export interface GraphLink {
	source: string;
	target: string;
}

export interface GraphData {
	nodes: GraphNode[];
	links: GraphLink[];
}

export interface BuildGraphOptions {
	homeGuid?: string | null;
	sleepGuid?: string | null;
	/** Optional progress callback (0..1) for long builds. */
	onProgress?: (done: number, total: number) => void;
}

/**
 * Build a directed graph of notes connected by `<link:internal>` marks.
 *
 * Resolution rules:
 * - Internal-link targets store the destination note's **title** (not GUID).
 *   We build a lowercase-trimmed title → GUID map. On collision, the most
 *   recently modified note wins (matches the behavior users see in the
 *   editor's auto-link picker).
 * - Unresolvable / self-referential targets are dropped silently — they
 *   produce no edge.
 * - Edges are deduplicated per ordered (source, target) pair.
 *
 * Node sizes are log-scaled on (in+out) degree, capped at 2× the base size:
 *   size = 1 + log1p(degree) / log1p(maxDegree)
 */
export function buildGraph(
	notes: NoteData[],
	options: BuildGraphOptions = {}
): GraphData {
	const { homeGuid, sleepGuid, onProgress } = options;

	// 1) Build title → guid map, resolving collisions to the most recent note.
	const titleToGuid = new Map<string, string>();
	const titleToChangeDate = new Map<string, string>();
	for (const note of notes) {
		const key = note.title.trim().toLowerCase();
		if (!key) continue;
		const existing = titleToChangeDate.get(key);
		if (existing === undefined || (note.changeDate ?? '') > existing) {
			titleToGuid.set(key, note.guid);
			titleToChangeDate.set(key, note.changeDate ?? '');
		}
	}

	// 2) Walk each note's content, resolve link targets.
	const edges = new Set<string>();
	const links: GraphLink[] = [];
	const inDegree = new Map<string, number>();
	const outDegree = new Map<string, number>();

	for (let i = 0; i < notes.length; i++) {
		const note = notes[i];
		let doc;
		try {
			doc = deserializeContent(note.xmlContent);
		} catch {
			// Corrupt note XML — skip its edges but keep the node.
			onProgress?.(i + 1, notes.length);
			continue;
		}
		const targets = extractInternalLinkTargets(doc);
		for (const rawTarget of targets) {
			const key = rawTarget.trim().toLowerCase();
			if (!key) continue;
			const targetGuid = titleToGuid.get(key);
			if (!targetGuid || targetGuid === note.guid) continue;
			const edgeKey = `${note.guid}\u0000${targetGuid}`;
			if (edges.has(edgeKey)) continue;
			edges.add(edgeKey);
			links.push({ source: note.guid, target: targetGuid });
			outDegree.set(note.guid, (outDegree.get(note.guid) ?? 0) + 1);
			inDegree.set(targetGuid, (inDegree.get(targetGuid) ?? 0) + 1);
		}
		onProgress?.(i + 1, notes.length);
	}

	// 3) Compute sizes.
	let maxDegree = 0;
	const degreeByGuid = new Map<string, number>();
	for (const note of notes) {
		const deg = (inDegree.get(note.guid) ?? 0) + (outDegree.get(note.guid) ?? 0);
		degreeByGuid.set(note.guid, deg);
		if (deg > maxDegree) maxDegree = deg;
	}

	const logMax = Math.log1p(maxDegree);
	const nodes: GraphNode[] = notes.map((note) => {
		const degree = degreeByGuid.get(note.guid) ?? 0;
		const size =
			logMax > 0 ? Math.min(2, 1 + Math.log1p(degree) / logMax) : 1;
		return {
			id: note.guid,
			title: note.title || '제목 없음',
			degree,
			size,
			isHome: homeGuid != null && note.guid === homeGuid,
			isSleep: sleepGuid != null && note.guid === sleepGuid
		};
	});

	return { nodes, links };
}
