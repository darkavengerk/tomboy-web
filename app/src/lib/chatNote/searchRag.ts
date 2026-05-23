export interface RagHit {
	guid: string;
	title: string;
	body: string;
	score: number;
}

export type RagSearchErrorKind =
	| 'unauthorized'
	| 'rag_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network';

export class RagSearchError extends Error {
	kind: RagSearchErrorKind;
	status?: number;

	constructor(kind: RagSearchErrorKind, opts: { status?: number; message?: string } = {}) {
		super(opts.message ?? kind);
		this.name = 'RagSearchError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface SearchRagOptions {
	url: string;
	token: string;
	query: string;
	k: number;
	signal?: AbortSignal;
}

export async function searchRag(opts: SearchRagOptions): Promise<RagHit[]> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ query: opts.query, k: opts.k }),
			signal: opts.signal
		});
	} catch (err) {
		const e = err as { name?: string; message?: string };
		throw new RagSearchError('network', { message: e.message ?? 'fetch failed' });
	}

	if (resp.status === 401) throw new RagSearchError('unauthorized', { status: 401 });
	if (resp.status === 400) throw new RagSearchError('bad_request', { status: 400 });
	if (resp.status === 503) throw new RagSearchError('rag_unavailable', { status: 503 });
	if (resp.status >= 500 || !resp.ok)
		throw new RagSearchError('upstream_error', { status: resp.status });

	try {
		const data = (await resp.json()) as RagHit[];
		return Array.isArray(data) ? data : [];
	} catch (err) {
		throw new RagSearchError('upstream_error', {
			status: resp.status,
			message: 'bad json'
		});
	}
}
