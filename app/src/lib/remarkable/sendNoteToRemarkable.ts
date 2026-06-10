import type { NoteData } from '$lib/core/note.js';
import {
	bridgeToHttpBase,
	getDefaultTerminalBridge,
	getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';
import { buildPdfBundle } from './pdf/pdfBundle.js';
import { loadKoreanFonts, registerKoreanFontFamily } from './pdf/koreanFont.js';

/**
 * 노트 → reMarkable PDF 송출 클라이언트.
 *
 * 흐름: pdfBundle (BFS + dedup) → pdfmake 로 PDF Blob 생성 → 브릿지에 multipart
 * POST → SSE 스트림으로 진행 보고. SSE 패턴은 uploadRemarkable.ts 와 동일.
 */

export type SendRemarkableErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'unknown_alias'
	| 'unknown_folder'
	| 'remote_failure'
	| 'network'
	| 'internal';

export class SendRemarkableError extends Error {
	constructor(public kind: SendRemarkableErrorKind, public detail?: string) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}

export interface SendRemarkableStatus {
	step:
		| 'building_pdf'
		| 'uploading'
		| 'folder_lookup'
		| 'ssh_write'
		| 'xochitl_reload';
	message?: string;
}

export interface SendRemarkableOpts {
	rootGuid: string;
	notes: NoteData[];
	alias: string;
	folderName: string;
	folderUuid: string;
	/** forward BFS 깊이 (이 노트가 링크하는 방향). */
	forwardDepth: number;
	/** backward BFS 깊이 (이 노트를 링크하는 방향, 백링크). */
	backwardDepth: number;
	/** 사용자가 모달 트리에서 체크 해제한 노트들. BFS 와 본문 링크에서 모두 빠진다. */
	excludedGuids?: Set<string>;
	onStatus?: (s: SendRemarkableStatus) => void;
	signal?: AbortSignal;
	/** 테스트용 PDF builder 주입. 누락 시 실제 pdfmake 동적 import. */
	buildPdf?: (docDefinition: unknown) => Promise<Blob>;
}

export interface SendRemarkableResult {
	visibleName: string;
	includedGuids: string[];
	pdfSizeBytes: number;
}

interface PdfMakeLike {
	vfs?: Record<string, string>;
	fonts?: Record<string, unknown>;
	createPdf(doc: unknown): { getBlob(cb: (blob: Blob) => void): void };
}

export async function sendNoteToRemarkable(
	opts: SendRemarkableOpts
): Promise<SendRemarkableResult> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) {
		throw new SendRemarkableError('not_configured', '브릿지 설정이 필요합니다');
	}
	if (!opts.alias || !opts.folderUuid || !opts.folderName) {
		throw new SendRemarkableError('not_configured', '리마커블 폴더가 지정되지 않았습니다');
	}

	opts.onStatus?.({ step: 'building_pdf' });
	const { docDefinition, includedGuids } = await buildPdfBundle(opts.rootGuid, opts.notes, {
		forwardDepth: opts.forwardDepth,
		backwardDepth: opts.backwardDepth,
		excludedGuids: opts.excludedGuids
	});
	const rootNote = opts.notes.find((n) => n.guid === opts.rootGuid);
	const visibleName = (rootNote?.title ?? '').trim() || '제목 없음';

	const builder = opts.buildPdf ?? defaultBuildPdf;
	const pdfBlob = await builder(docDefinition);
	opts.onStatus?.({
		step: 'uploading',
		message: `${(pdfBlob.size / 1024 / 1024).toFixed(1)}MB`
	});

	const pdfBase64 = await blobToBase64(pdfBlob);
	const body = JSON.stringify({
		alias: opts.alias,
		folderName: opts.folderName,
		folderUuid: opts.folderUuid,
		visibleName,
		pdfBase64
	});

	const url = `${bridgeToHttpBase(bridge)}/remarkable/send-pdf`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream'
			},
			body,
			signal: opts.signal
		});
	} catch (err) {
		throw new SendRemarkableError('network', (err as Error).message);
	}

	if (!res.ok) {
		if (res.status === 401) throw new SendRemarkableError('unauthorized');
		const payload = await safeJson(res);
		const kind = (payload as { error?: string } | null)?.error;
		if (kind === 'unknown_alias') throw new SendRemarkableError('unknown_alias');
		if (kind === 'unknown_folder') throw new SendRemarkableError('unknown_folder');
		if (res.status >= 500) {
			throw new SendRemarkableError('remote_failure', kind ?? `status ${res.status}`);
		}
		throw new SendRemarkableError('internal', kind ?? `status ${res.status}`);
	}
	if (!res.body) throw new SendRemarkableError('internal', 'no body');

	await consumeSse(res.body, opts.onStatus, opts.signal);
	return { visibleName, includedGuids, pdfSizeBytes: pdfBlob.size };
}

async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
	}
	return btoa(binary);
}

async function defaultBuildPdf(docDefinition: unknown): Promise<Blob> {
	const fonts = await loadKoreanFonts();
	// `pdfmake/build/pdfmake` 는 CJS — interop 보정.
	const mod = (await import('pdfmake/build/pdfmake')) as unknown as {
		default?: PdfMakeLike;
	} & PdfMakeLike;
	const pdfMake = (mod.default ?? (mod as unknown as PdfMakeLike)) as PdfMakeLike;
	registerKoreanFontFamily(pdfMake, fonts);
	return new Promise<Blob>((resolve, reject) => {
		try {
			pdfMake.createPdf(docDefinition).getBlob((blob: Blob) => resolve(blob));
		} catch (err) {
			reject(err);
		}
	});
}

async function safeJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function consumeSse(
	body: ReadableStream<Uint8Array>,
	onStatus: ((s: SendRemarkableStatus) => void) | undefined,
	signal: AbortSignal | undefined
): Promise<void> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let done = false;

	const onAbort = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		while (true) {
			const { value, done: streamDone } = await reader.read();
			if (value) {
				buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
			}
			while (true) {
				const sep = buf.indexOf('\n\n');
				if (sep === -1) break;
				const frame = buf.slice(0, sep);
				buf = buf.slice(sep + 2);
				const parsed = parseFrame(frame);
				if (!parsed) continue;
				if (parsed.event === 'status') {
					onStatus?.(parsed.data as SendRemarkableStatus);
				} else if (parsed.event === 'done') {
					done = true;
				} else if (parsed.event === 'error') {
					const e = parsed.data as { kind?: string; message?: string };
					const kind = (e.kind as SendRemarkableErrorKind) ?? 'remote_failure';
					reader.cancel().catch(() => {});
					throw new SendRemarkableError(kind, e.message);
				}
			}
			if (streamDone) break;
			if (signal?.aborted) break;
		}
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}

	if (signal?.aborted) throw new SendRemarkableError('network', 'aborted');
	if (!done) throw new SendRemarkableError('internal', 'stream ended without done');
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
	let event = 'message';
	const dataLines: string[] = [];
	for (const line of frame.split('\n')) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
	}
	if (dataLines.length === 0) return null;
	try {
		return { event, data: JSON.parse(dataLines.join('\n')) };
	} catch {
		return null;
	}
}
