export interface CodegraphNode {
	id: string;
	title: string; // graphify "label"
	community: number;
	fileType: 'code' | 'document' | 'paper' | 'image';
	sourceFile: string;
	sourceLocation: string | null;
	degree: number;
	size: number; // 1..2 log-scaled
}

export interface CodegraphLink {
	source: string;
	target: string;
	relation: string;
	confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
	confidenceScore: number;
}

export interface CodegraphMeta {
	repoUrl: string;
	branch: string;
	syncedAt: string;
	nodeCount: number;
	linkCount: number;
}

export interface CodegraphData {
	nodes: CodegraphNode[];
	links: CodegraphLink[];
	meta: CodegraphMeta;
	communityLabels: Record<string, string>;
}

export type LoadResult =
	| { ok: true; data: CodegraphData }
	| { ok: false; reason: 'missing' | 'malformed' | 'network'; detail?: string };
